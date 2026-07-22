/**
 * QMSCloud Reporting MCP — core logic.
 *
 *   AnythingLLM (host)  ->  Ollama / Qwen  ->  this MCP server  ->  Metabase card JSON
 *
 * Unlike the QMS700i servlet server (../mcpreport), QMSCloud data is exposed
 * through pre-built Metabase "cards". Each card is a saved question with
 * template-tag parameters (start_date, end_date, company_id, branch_id). We POST
 * to the card's `/query/json` endpoint with those parameters and get back an
 * array of row objects that the model then analyzes to answer the user.
 *
 * There is no login flow here — Metabase authenticates via a static API key
 * (x-api-key header). The key is read from METABASE_API_KEY (env) with a
 * fallback default so the server works out of the box for testing.
 */

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

// --- Connection --------------------------------------------------------------

export const METABASE_BASE_URL =
  process.env.METABASE_BASE_URL || "http://54.251.164.99:7777";

// Static Metabase API key — REQUIRED. Set it via the AnythingLLM `env` block
// (METABASE_API_KEY). It is intentionally NOT hardcoded here so the secret stays
// out of source control. For local testing, export it in your shell first:
//   export METABASE_API_KEY='mb_...'
export const METABASE_API_KEY = process.env.METABASE_API_KEY || "";

// --- Workspace -> tenant routing (dynamic via Metabase) ---------------------
// AnythingLLM injects `workspace_slug` on every call. The slug encodes the
// tenant as "<companyCode>" or "<companyCode>___<branchCode>" — company and
// branch are separated by a TRIPLE underscore ("___"), and the codes
// themselves are hyphen-slugs. Rather than hardcoding a map, we resolve
// CompanyId / BranchId dynamically from Metabase lookup cards, so new companies
// or branches need no code change here:
//   card 41 -> companies (CompanyCode -> CompanyId)
//   card 42 -> branches  (BranchCode + CompanyId -> BranchId)
// Card IDs are overridable via env in case they differ per install.
export const COMPANY_CARD_ID = Number(process.env.METABASE_COMPANY_CARD_ID || 41);
export const BRANCH_CARD_ID = Number(process.env.METABASE_BRANCH_CARD_ID || 42);

// Lookup lists are cached in memory with a short TTL so we don't hit Metabase
// on every request; a newly-added company/branch appears within the TTL.
const LOOKUP_TTL_MS = Number(process.env.METABASE_LOOKUP_TTL_MS || 300000);

/**
 * Lowercase, collapse any run of non-alphanumeric chars to a single hyphen, and
 * trim hyphens. "DEMO"->"demo", "KL001"->"kl001", "BRANCH 001"->"branch-001".
 */
export function slugify(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Split a workspace slug into { companyCode, branchCode } on the FIRST "___". */
export function splitWorkspaceSlug(slug) {
  const SEP = "___";
  const s = String(slug ?? "").trim();
  const i = s.indexOf(SEP);
  if (i === -1) return { companyCode: s, branchCode: null };
  return { companyCode: s.slice(0, i), branchCode: s.slice(i + SEP.length) || null };
}

/** Find the company row whose slugified CompanyCode equals companySlug. */
export function matchCompany(companies, companySlug) {
  return companies.find((c) => slugify(c.CompanyCode) === companySlug) || null;
}

/** Convenience: the matched CompanyId (or null). */
export function matchCompanyId(companies, companySlug) {
  return matchCompany(companies, companySlug)?.CompanyId ?? null;
}

/**
 * Find the branch row whose slugified BranchCode equals branchSlug AND that
 * belongs to companyId (branch codes can repeat across companies, so scope by
 * company).
 */
export function matchBranch(branches, branchSlug, companyId) {
  return (
    branches.find(
      (b) => slugify(b.BranchCode) === branchSlug && b.CompanyId === companyId
    ) || null
  );
}

/** Convenience: the matched BranchId (or null). */
export function matchBranchId(branches, branchSlug, companyId) {
  return matchBranch(branches, branchSlug, companyId)?.BranchId ?? null;
}

// TTL cache per lookup card id.
const lookupCache = new Map(); // cardId -> { at, rows }
async function getLookupRows(cardId) {
  const now = Date.now();
  const hit = lookupCache.get(cardId);
  if (hit && now - hit.at < LOOKUP_TTL_MS) return hit.rows;
  const rows = await postCardJson(cardId, { parameters: [] });
  if (!Array.isArray(rows)) throw new Error(`Lookup card ${cardId} did not return a list.`);
  lookupCache.set(cardId, { at: now, rows });
  return rows;
}

/** Clear the lookup cache (e.g. to force a fresh fetch). */
export function clearLookupCache() {
  lookupCache.clear();
}

/**
 * Resolve a workspace_slug to { company_id, branch_id? } by matching its
 * CompanyCode/BranchCode against Metabase lookup cards. Throws a descriptive
 * error for an unknown company or branch code.
 * @param {string} workspaceSlug
 * @returns {Promise<{ company_id: string, branch_id?: string }>}
 */
export async function resolveWorkspace(workspaceSlug) {
  const { companyCode, branchCode } = splitWorkspaceSlug(workspaceSlug);
  const companySlug = slugify(companyCode);
  if (!companySlug) {
    throw new Error(`invalid workspace slug '${workspaceSlug}': no company code found.`);
  }

  const companies = await getLookupRows(COMPANY_CARD_ID);
  const company = matchCompany(companies, companySlug);
  if (!company) throw new Error(`invalid company code '${companyCode}'.`);

  // Timezone for display: use the company's, overridden by the branch's if set.
  let time_zone = company.TimeZoneId || "UTC";

  // No branch part -> whole-company view (branch_id omitted downstream).
  if (!branchCode) return { company_id: company.CompanyId, time_zone };

  const branchSlug = slugify(branchCode);
  const branches = await getLookupRows(BRANCH_CARD_ID);
  const branch = matchBranch(branches, branchSlug, company.CompanyId);
  if (!branch) throw new Error(`invalid branch code '${branchCode}'.`);
  if (branch.TimeZoneId) time_zone = branch.TimeZoneId;

  return { company_id: company.CompanyId, branch_id: branch.BranchId, time_zone };
}

// --- Card catalog ------------------------------------------------------------
// One entry per Metabase card. `id` is the Metabase card ID. `params` lists the
// template-tag names the card expects with their Metabase parameter `type`.
// Add appointment / rating / etc. cards here as they are built.
export const CARDS = {
  ticket_summary: {
    id: 40,
    label: "Ticket Summary",
    description:
      "Summary of tickets issued/served over a date range for the tenant — " +
      "use for questions about ticket volume, served/no-show counts, and overall " +
      "queue throughput.",
    // Ordered list of Metabase template-tag parameters this card accepts.
    params: [
      { name: "start_date", type: "date", source: "range" },
      { name: "end_date", type: "date", source: "range" },
      { name: "company_id", type: "text", source: "tenant" },
      { name: "branch_id", type: "text", source: "tenant", optional: true },
    ],
    // Card 40 returns raw ticket-service rows (one per service on a ticket).
    // That's far too much to hand to a small LLM, so we aggregate server-side
    // into a compact digest. (Function is hoisted, defined below.)
    summarize: summarizeTicketRows,
  },

  appointment_summary: {
    id: 43,
    label: "Appointment Summary",
    description:
      "Summary of appointments booked/scheduled over a date range for the tenant — " +
      "use for questions about appointment volume, statuses, no-shows, and scheduling.",
    // Same template-tag parameters as the ticket card.
    params: [
      { name: "start_date", type: "date", source: "range" },
      { name: "end_date", type: "date", source: "range" },
      { name: "company_id", type: "text", source: "tenant" },
      { name: "branch_id", type: "text", source: "tenant", optional: true },
    ],
    // Card 43 returns one row per appointment; aggregate server-side.
    summarize: summarizeAppointmentRows,
  },

  rating_feedback: {
    id: 44,
    label: "Rating & Feedback",
    description:
      "Customer ratings and feedback over a date range for the tenant — use for " +
      "questions about satisfaction scores, average rating, rating distribution, " +
      "and written feedback/comments.",
    params: [
      { name: "start_date", type: "date", source: "range" },
      { name: "end_date", type: "date", source: "range" },
      { name: "company_id", type: "text", source: "tenant" },
      { name: "branch_id", type: "text", source: "tenant", optional: true },
    ],
    // Card 44 returns one row per rating response; aggregate server-side.
    summarize: summarizeRatingRows,
  },
};

// --- Summarizers -------------------------------------------------------------
// Turn raw Metabase rows into a small digest the model can reason over.

function tally(rows, key, nullLabel = "(null)") {
  const out = {};
  for (const r of rows) {
    const k = r?.[key] ?? nullLabel;
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

function distinctCount(rows, key) {
  const s = new Set();
  for (const r of rows) if (r?.[key] != null) s.add(r[key]);
  return s.size;
}

/** Tally by the date part (YYYY-MM-DD) of a timestamp column. */
function tallyDate(rows, key) {
  const out = {};
  for (const r of rows) {
    const v = r?.[key];
    const d = typeof v === "string" && v.length >= 10 ? v.slice(0, 10) : "(none)";
    out[d] = (out[d] || 0) + 1;
  }
  return out;
}

/**
 * Real completion timestamp — only tickets whose Status is "Completed" have a
 * genuine CompletedAtUtc. Every other status carries a placeholder/sentinel
 * value (observed: 2026-06-17T15:34:46.743), so treating it as a completion
 * inflates serving time by thousands of minutes. Gate on Status.
 */
function completedAt(r) {
  return r?.Status === "Completed" ? r.CompletedAtUtc ?? null : null;
}

/** minutes between two ISO timestamps, or null if either missing/invalid. */
function minutesBetween(a, b) {
  if (!a || !b) return null;
  const t1 = Date.parse(a);
  const t2 = Date.parse(b);
  if (Number.isNaN(t1) || Number.isNaN(t2)) return null;
  const m = (t2 - t1) / 60000;
  return m >= 0 ? m : null; // ignore negative (clock/order anomalies)
}

/**
 * Format a UTC timestamp string in a given IANA timezone as "YYYY-MM-DD HH:mm:ss".
 * The DB timestamps have no "Z" suffix but ARE UTC, so we append "Z" to parse
 * them as UTC before converting. Falls back to the raw string on any problem.
 */
function formatInTz(utcIso, timeZone) {
  if (!utcIso) return null;
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(utcIso) ? utcIso : utcIso + "Z");
  if (Number.isNaN(d.getTime())) return utcIso;
  try {
    // "sv-SE" renders as ISO-like "2026-06-11 17:06:33".
    return d.toLocaleString("sv-SE", { timeZone: timeZone || "UTC" });
  } catch {
    return utcIso; // unknown timezone -> leave as UTC
  }
}

/**
 * Return a shallow copy of a raw row with every "...AtUtc" timestamp converted
 * to local time and renamed "...AtLocal". This is applied to sampleRows / raw
 * rows so the model never sees an unconverted UTC value (which it would present
 * as-is, i.e. as if it were local time).
 */
export function localizeRowTimestamps(row, timeZone) {
  if (!row || typeof row !== "object") return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (/AtUtc$/.test(k) && typeof v === "string") {
      out[k.replace(/Utc$/, "Local")] = formatInTz(v, timeZone);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** seconds between two ISO timestamps, or null. Queue times are short, so we
 * report in whole seconds — reporting in 1-decimal minutes lost precision (e.g.
 * a true 55.8s average displayed as 0.9 min, which reads back as 54s). */
function secondsBetween(a, b) {
  const m = minutesBetween(a, b);
  return m == null ? null : m * 60;
}

function roundOrNull(n) {
  return n == null ? null : Math.round(n);
}

function durationStats(values) {
  // values are in SECONDS
  const v = values.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return { count: 0 };
  const sum = v.reduce((a, b) => a + b, 0);
  const r = (n) => Math.round(n);
  return {
    count: v.length,
    avg_sec: r(sum / v.length),
    median_sec: r(v[Math.floor(v.length / 2)]),
    min_sec: r(v[0]),
    max_sec: r(v[v.length - 1]),
  };
}

/**
 * Core metrics for a set of rows (counts, completion rate, waiting/serving
 * seconds). Reused for per-group breakdowns (e.g. by service).
 */
function groupMetrics(rows) {
  const completedRows = rows.filter((r) => r.Status === "Completed");
  const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
  const waiting = rows.map((r) => secondsBetween(r.CheckedInAtUtc, r.CalledAtUtc));
  const serving = rows.map((r) => secondsBetween(r.CalledAtUtc, completedAt(r)));
  return {
    service_rows: rows.length,
    by_status: tally(rows, "Status"),
    completion: {
      completed_rows: completedRows.length,
      total_rows: rows.length,
      rate_by_row_pct: pct(completedRows.length, rows.length),
    },
    waiting_time: durationStats(waiting),
    serving_time: durationStats(serving),
  };
}

/** Group rows by a column and compute groupMetrics for each value. */
function metricsByColumn(rows, key) {
  const values = [...new Set(rows.map((r) => r?.[key]).filter(Boolean))];
  const out = {};
  for (const v of values) out[v] = groupMetrics(rows.filter((r) => r?.[key] === v));
  return out;
}

/**
 * Build a compact per-ticket-service detail table (human fields + computed
 * waiting/serving seconds) — used to answer "list all tickets with their times".
 * Timestamps are converted from UTC to `timeZone` for display.
 * One entry per service row, so multi-service tickets appear more than once.
 */
function ticketDetail(rows, cap, timeZone) {
  const list = rows.slice(0, cap).map((r) => ({
    ticket: r.TicketText,
    service: r.ServiceName ?? null,
    counter: r.CounterName ?? null,
    status: r.Status,
    business_date: r.BusinessDate ?? null,
    issued: formatInTz(r.IssuedAtUtc, timeZone),
    checked_in: formatInTz(r.CheckedInAtUtc, timeZone),
    called: formatInTz(r.CalledAtUtc, timeZone),
    // Only show a completion time (and serving time) when actually Completed;
    // other statuses carry a placeholder CompletedAtUtc.
    completed: formatInTz(completedAt(r), timeZone),
    waiting_sec: roundOrNull(secondsBetween(r.CheckedInAtUtc, r.CalledAtUtc)),
    serving_sec: roundOrNull(secondsBetween(r.CalledAtUtc, completedAt(r))),
  }));
  return { count: rows.length, rows: list, truncated: rows.length > cap };
}

/**
 * Aggregate raw ticket-service rows from card 40 into a compact summary.
 *
 * Row columns (current query): TicketServiceId, CompanyId/Code/Name,
 * BranchId/Code/Name, QueueSessionId, TicketId, ServiceId/Code/Name,
 * CounterId/Code/Name, Status, SequenceNo, AttendanceMode, AttendanceRequired,
 * IssuedAtUtc, CheckedInAtUtc, CalledAtUtc, CompletedAtUtc, BusinessDate,
 * TicketNo, TicketText. (CounterId/Code/Name are null until a ticket is called.)
 *
 * NOTE on definitions (tune with the user):
 *  - A "ticket" = distinct TicketId. Multi-service tickets have several rows.
 *  - Status breakdown is at the service-row level.
 *  - Waiting = CalledAtUtc - CheckedInAtUtc (any called ticket).
 *  - Serving = CompletedAtUtc - CalledAtUtc, but ONLY for Status="Completed"
 *    tickets — other statuses carry a placeholder CompletedAtUtc, so counting
 *    them inflated serving time massively. See completedAt().
 */
function summarizeTicketRows(rows, opts = {}) {
  if (!Array.isArray(rows)) return { note: "unexpected (non-array) response", raw: rows };
  if (!rows.length) return { service_rows: 0, note: "no rows for this range" };

  // Durations in SECONDS (queue times are short; see secondsBetween()).
  const waiting = rows.map((r) => secondsBetween(r.CheckedInAtUtc, r.CalledAtUtc));
  // Serving time only for genuinely Completed tickets (see completedAt()).
  const serving = rows.map((r) => secondsBetween(r.CalledAtUtc, completedAt(r)));

  const first = rows[0] || {};
  const timeZone = opts.tenant?.time_zone || "UTC";

  // Distinct ticket labels (e.g. "G0001", "V0002") so the model can answer
  // "list the ticket numbers" without pulling every raw row. Capped to keep the
  // payload small; if truncated, the model can narrow the range or use include_rows.
  const TICKET_CAP = 300;
  const ticketTexts = [...new Set(rows.map((r) => r.TicketText).filter(Boolean))].sort();

  // Completion rate at the service-row level: completed rows / all rows.
  const pct = (num, den) => (den ? Math.round((num / den) * 1000) / 10 : 0);
  const distinctTickets = distinctCount(rows, "TicketId");
  const completedRows = rows.filter((r) => r.Status === "Completed");

  const out = {
    // Human-readable context (names now come back in the query).
    context: {
      company: first.CompanyName || first.CompanyCode || null,
      branches: [...new Set(rows.map((r) => r.BranchName).filter(Boolean))],
    },
    // Timezone that the detail table's timestamps are shown in.
    time_zone: timeZone,
    service_rows: rows.length,
    distinct_tickets: distinctTickets,
    distinct_queue_sessions: distinctCount(rows, "QueueSessionId"),
    distinct_services: distinctCount(rows, "ServiceId"),
    distinct_branches: distinctCount(rows, "BranchId"),
    distinct_counters: distinctCount(rows, "CounterId"),
    by_status: tally(rows, "Status"),
    by_service: tally(rows, "ServiceName"),
    by_branch: tally(rows, "BranchName"),
    // Counter is null until a ticket is called — bucket those as not-called-yet.
    by_counter: tally(rows, "CounterName", "(not called yet)"),
    by_attendance_mode: tally(rows, "AttendanceMode"),
    // BusinessDate is the operational queue day (differs from CheckedInAtUtc and
    // stays within the requested range), so it's the correct date grouping.
    by_business_date: tally(rows, "BusinessDate"),
    completion: {
      completed_rows: completedRows.length,
      total_rows: rows.length,
      rate_by_row_pct: pct(completedRows.length, rows.length),
    },
    ticket_numbers: {
      count: ticketTexts.length,
      list: ticketTexts.slice(0, TICKET_CAP),
      truncated: ticketTexts.length > TICKET_CAP,
    },
    waiting_time: durationStats(waiting),
    serving_time: durationStats(serving),
    // Same metrics broken down per service.
    by_service_metrics: metricsByColumn(rows, "ServiceName"),
  };

  // Per-ticket detail (issued/called/completed/waiting/serving per row) is only
  // included when explicitly requested, to keep the default summary compact.
  if (opts.detail) out.tickets = ticketDetail(rows, opts.detailCap || 200, timeZone);

  return out;
}

// --- Appointment summarizer --------------------------------------------------

/**
 * Build a compact per-appointment detail table. Timestamps are converted from
 * UTC to `timeZone`; StartTime/EndTime/AppointmentDate are already local values.
 */
function appointmentDetail(rows, cap, timeZone) {
  const list = rows.slice(0, cap).map((r) => ({
    code: r.AppointmentCode ?? null,
    date: r.AppointmentDate ?? null,
    start: r.StartTime ?? null,
    end: r.EndTime ?? null,
    status: r.Status ?? null,
    service: r.ServiceName ?? null,
    branch: r.BranchName ?? null,
    customer: r.CustomerName ?? null,
    phone: r.MobilePhoneNumber ?? null,
    email: r.EmailAddress ?? null,
    booked_at: formatInTz(r.CreatedAtUtc, timeZone),
    checked_in_at: formatInTz(r.CheckedInAtUtc, timeZone),
    linked_ticket: r.TicketId != null,
  }));
  return { count: rows.length, rows: list, truncated: rows.length > cap };
}

/**
 * Aggregate raw appointment rows from card 43 into a compact summary.
 *
 * Row columns: AppointmentId, CompanyId, BranchId/Code/Name, ServiceId/Code/Name,
 * TicketId (null unless the appointment converted to a ticket), AppointmentCode,
 * AppointmentDate (local date), StartTime/EndTime (local time-of-day), Status,
 * CustomerName/MobilePhoneNumber/EmailAddress/CustomerReference/Notes,
 * CreatedAtUtc (booked), CheckedInAtUtc (attended), ReminderEmail* fields.
 *
 * One row = one appointment (AppointmentId is unique).
 */
function summarizeAppointmentRows(rows, opts = {}) {
  if (!Array.isArray(rows)) return { note: "unexpected (non-array) response", raw: rows };
  if (!rows.length) return { appointments: 0, note: "no appointments for this range" };

  const first = rows[0] || {};
  const timeZone = opts.tenant?.time_zone || "UTC";
  const pct = (num, den) => (den ? Math.round((num / den) * 1000) / 10 : 0);

  const checkedIn = rows.filter((r) => r.CheckedInAtUtc != null).length;
  const remindersSent = rows.filter((r) => r.ReminderEmailSentAtUtc != null).length;
  const linkedToTicket = rows.filter((r) => r.TicketId != null).length;

  const codes = [...new Set(rows.map((r) => r.AppointmentCode).filter(Boolean))].sort();
  const CODE_CAP = 300;

  const out = {
    context: {
      company: first.CompanyName || first.CompanyCode || null,
      branches: [...new Set(rows.map((r) => r.BranchName).filter(Boolean))],
    },
    time_zone: timeZone,
    appointments: rows.length,
    distinct_appointments: distinctCount(rows, "AppointmentId"),
    distinct_services: distinctCount(rows, "ServiceId"),
    distinct_branches: distinctCount(rows, "BranchId"),
    by_status: tally(rows, "Status"),
    by_service: tally(rows, "ServiceName"),
    by_branch: tally(rows, "BranchName"),
    by_appointment_date: tally(rows, "AppointmentDate"),
    // Attendance = an appointment that was checked in (CheckedInAtUtc set).
    attendance: {
      checked_in: checkedIn,
      total: rows.length,
      rate_pct: pct(checkedIn, rows.length),
    },
    reminders_sent: remindersSent,
    linked_to_ticket: linkedToTicket,
    appointment_codes: {
      count: codes.length,
      list: codes.slice(0, CODE_CAP),
      truncated: codes.length > CODE_CAP,
    },
  };

  // Per-appointment detail (includes customer contact) only when requested.
  if (opts.detail) out.appointments_detail = appointmentDetail(rows, opts.detailCap || 200, timeZone);

  return out;
}

// --- Rating & feedback summarizer -------------------------------------------

function hasText(v) {
  return typeof v === "string" && v.trim() !== "";
}

/** Local date (YYYY-MM-DD) tally of a UTC timestamp column. */
function tallyLocalDate(rows, tsKey, timeZone) {
  const out = {};
  for (const r of rows) {
    const local = formatInTz(r?.[tsKey], timeZone); // "YYYY-MM-DD HH:mm:ss"
    const d = typeof local === "string" && local.length >= 10 ? local.slice(0, 10) : "(none)";
    out[d] = (out[d] || 0) + 1;
  }
  return out;
}

// Rating scale is fixed 1-5.
const RATING_MIN = 1;
const RATING_MAX = 5;

/** Distribution over the fixed 1-5 scale (zero-filled); out-of-range values kept as-is. */
function ratingDistribution(rows) {
  const out = {};
  for (let i = RATING_MIN; i <= RATING_MAX; i++) out[i] = 0;
  for (const r of rows) {
    const v = r.OverallRating;
    if (typeof v === "number") out[v] = (out[v] || 0) + 1;
  }
  return out;
}

/** Safely parse a JSON-array string; returns [] on anything unexpected. */
function parseJsonArray(s) {
  if (Array.isArray(s)) return s;
  if (typeof s !== "string") return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * Per-question averages across responses, using QuestionJson (id -> text/type)
 * and AnswersJson ([{questionId, value}]). Numeric values are averaged; the
 * question text comes from the linked rating template.
 */
function perQuestionStats(rows) {
  const text = {}; // id -> question text
  const type = {}; // id -> question type
  const agg = {}; // id -> { n, vals[] }
  for (const r of rows) {
    for (const q of parseJsonArray(r.QuestionJson)) {
      if (q && q.id != null && !(q.id in text)) {
        text[q.id] = q.text || String(q.id);
        type[q.id] = q.type || null;
      }
    }
    for (const a of parseJsonArray(r.AnswersJson)) {
      if (a && a.questionId != null) {
        const g = (agg[a.questionId] = agg[a.questionId] || { n: 0, vals: [] });
        g.n++;
        if (typeof a.value === "number") g.vals.push(a.value);
      }
    }
  }
  return Object.entries(agg).map(([id, g]) => ({
    question_id: id,
    text: text[id] || id,
    type: type[id] || null,
    responses: g.n,
    average: g.vals.length
      ? Math.round((g.vals.reduce((a, b) => a + b, 0) / g.vals.length) * 100) / 100
      : null,
  }));
}

/** Core rating stats for a set of rows: response count, average (out of 5), distribution. */
function ratingStats(rows) {
  const vals = rows.map((r) => r.OverallRating).filter((v) => typeof v === "number");
  const average_rating = vals.length
    ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100
    : null;
  return {
    responses: rows.length,
    rated: vals.length,
    average_rating, // out of RATING_MAX (5)
    by_rating: ratingDistribution(rows),
  };
}

/** Rating stats grouped by a column (e.g. branch). */
function ratingByColumn(rows, key) {
  const values = [...new Set(rows.map((r) => r?.[key]).filter(Boolean))];
  const out = {};
  for (const v of values) out[v] = ratingStats(rows.filter((r) => r?.[key] === v));
  return out;
}

/** Per-response detail table (rating + feedback text + local submit time). */
function ratingDetail(rows, cap, timeZone) {
  const list = rows.slice(0, cap).map((r) => ({
    rating: r.OverallRating ?? null,
    feedback: hasText(r.FeedbackText) ? r.FeedbackText : null,
    source: r.Source ?? null,
    template: r.TemplateName ?? null,
    branch: r.BranchName ?? null,
    service: r.ServiceName ?? null,
    ticket: r.TicketText ?? null,
    submitted: formatInTz(r.SubmittedAtUtc, timeZone),
  }));
  return { count: rows.length, rows: list, truncated: rows.length > cap };
}

/**
 * Aggregate raw rating responses from card 44 into a compact summary.
 *
 * Row columns: TicketRatingResponseId, CompanyId, BranchId/Code/Name,
 * RatingTemplateId, TicketId, ServiceId/Code/Name, CounterId, OverallRating
 * (numeric score), FeedbackText (free-text, may be null), AnswersJson (per-
 * question answers), Source (e.g. PublicLink), SubmittedAtUtc, TicketText.
 *
 * One row = one rating response. The rating scale isn't hardcoded — we report
 * the actual average and the distribution of whatever score values appear.
 */
function summarizeRatingRows(rows, opts = {}) {
  if (!Array.isArray(rows)) return { note: "unexpected (non-array) response", raw: rows };
  if (!rows.length) return { responses: 0, note: "no rating responses for this range" };

  const first = rows[0] || {};
  const timeZone = opts.tenant?.time_zone || "UTC";

  const overall = ratingStats(rows);
  const withFeedback = rows.filter((r) => hasText(r.FeedbackText));

  // Compact feedback list (the qualitative point of this report), capped.
  const FEEDBACK_CAP = 50;
  const feedback = withFeedback.slice(0, FEEDBACK_CAP).map((r) => ({
    rating: r.OverallRating ?? null,
    branch: r.BranchName ?? null,
    text: r.FeedbackText,
  }));

  const out = {
    context: {
      company: first.CompanyName || first.CompanyCode || null,
      branches: [...new Set(rows.map((r) => r.BranchName).filter(Boolean))],
    },
    time_zone: timeZone,
    rating_scale: { min: RATING_MIN, max: RATING_MAX },
    responses: rows.length,
    distinct_responses: distinctCount(rows, "TicketRatingResponseId"),
    average_rating: overall.average_rating, // out of 5
    rated_count: overall.rated,
    by_rating: overall.by_rating, // distribution over 1-5 (zero-filled)
    by_branch: tally(rows, "BranchName"),
    by_service: tally(rows, "ServiceName", "(none)"),
    by_source: tally(rows, "Source"),
    by_date: tallyLocalDate(rows, "SubmittedAtUtc", timeZone),
    // Average + distribution per branch.
    by_branch_ratings: ratingByColumn(rows, "BranchName"),
    // Which rating template(s) the responses came from.
    by_template: tally(rows, "TemplateName"),
    // Named per-question averages (from the template's QuestionJson + AnswersJson).
    per_question: perQuestionStats(rows),
    feedback_count: withFeedback.length,
    feedback: {
      count: withFeedback.length,
      list: feedback,
      truncated: withFeedback.length > FEEDBACK_CAP,
    },
  };

  // Full per-response detail (rating + comment + submit time) when requested.
  if (opts.detail) out.responses_detail = ratingDetail(rows, opts.detailCap || 200, timeZone);

  return out;
}

// --- Metabase parameter builder ---------------------------------------------

/**
 * Build one Metabase parameter object for a template-tag variable.
 * Shape: { type, target: ["variable", ["template-tag", name]], value }
 */
function metabaseParam(name, type, value) {
  return {
    type,
    target: ["variable", ["template-tag", name]],
    value,
  };
}

/**
 * Assemble the Metabase request body (the `parameters` array) for a card,
 * given the resolved tenant and the date range.
 * @param {object} card         entry from CARDS
 * @param {object} opts
 * @param {string} opts.start_date  YYYY-MM-DD
 * @param {string} opts.end_date    YYYY-MM-DD
 * @param {object} opts.tenant      { company_id, branch_id? }
 * @returns {{ parameters: object[] }}
 */
export function buildRequestBody(card, { start_date, end_date, tenant }) {
  const values = {
    start_date,
    end_date,
    company_id: tenant.company_id,
    branch_id: tenant.branch_id,
  };

  const parameters = [];
  for (const p of card.params) {
    const value = values[p.name];
    // Skip optional params (e.g. branch_id) when the tenant has no value.
    if (value === undefined || value === null || value === "") {
      if (p.optional) continue;
      throw new Error(`missing required parameter '${p.name}'.`);
    }
    parameters.push(metabaseParam(p.name, p.type, value));
  }
  return { parameters };
}

// --- Fetch -------------------------------------------------------------------

/**
 * POST to a Metabase card's JSON query endpoint and return the parsed rows.
 * @param {object} card   entry from CARDS
 * @param {object} opts   { start_date, end_date, tenant }
 * @returns {Promise<{ card: string, cardId: number, rowCount: number, rows: any[] }>}
 */
// How long to wait for Metabase before aborting (ms). Card exports can be slow;
// override with METABASE_TIMEOUT_MS if needed.
const TIMEOUT_MS = Number(process.env.METABASE_TIMEOUT_MS || 120000);

/**
 * POST JSON using Node's built-in http/https module (not fetch/undici, which
 * threw "terminated" against this Metabase server). Returns { status, text }.
 * @returns {Promise<{ status: number, text: string }>}
 */
function httpPostJson(urlStr, headers, bodyStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          ...headers,
          "Content-Length": Buffer.byteLength(bodyStr),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") })
        );
      }
    );
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy(new Error(`request timed out after ${TIMEOUT_MS}ms`));
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

/**
 * POST a Metabase card query and return the parsed JSON rows. Shared by both the
 * report cards and the company/branch lookup cards. Throws on missing key,
 * transport error, non-2xx status, or non-JSON body.
 * @param {number} cardId
 * @param {object} bodyObj  request body, e.g. { parameters: [...] }
 * @returns {Promise<any>}  parsed JSON (usually an array of row objects)
 */
async function postCardJson(cardId, bodyObj) {
  if (!METABASE_API_KEY) {
    throw new Error(
      "METABASE_API_KEY is not set. Add it to the AnythingLLM MCP `env` block " +
        "(or export it in your shell for local testing)."
    );
  }
  const url = `${METABASE_BASE_URL}/api/card/${cardId}/query/json`;
  const bodyStr = JSON.stringify(bodyObj);

  let res;
  try {
    res = await httpPostJson(
      url,
      {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-api-key": METABASE_API_KEY,
      },
      bodyStr
    );
  } catch (e) {
    throw new Error(
      `Metabase card ${cardId} request failed: ${e?.code ? e.code + " " : ""}${e?.message || e}`
    );
  }

  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `Metabase card ${cardId} returned HTTP ${res.status}: ${res.text.slice(0, 500)}`
    );
  }

  try {
    return JSON.parse(res.text);
  } catch {
    throw new Error(
      `Metabase card ${cardId} did not return JSON: ${res.text.slice(0, 300)}`
    );
  }
}

export async function fetchCard(cardKey, card, opts = {}) {
  const rows = await postCardJson(card.id, buildRequestBody(card, opts));

  const rowCount = Array.isArray(rows) ? rows.length : undefined;
  const out = { card: cardKey, cardId: card.id, rowCount };

  // Card 40 (and future high-volume cards) return raw rows — aggregate them into
  // a compact digest so the small LLM isn't flooded. Include a few sample rows
  // for context, and the full rows only when explicitly requested.
  if (card.summarize) {
    out.summary = card.summarize(rows, opts);
    // Convert UTC timestamps to the tenant's timezone (renamed *AtLocal) so the
    // model never presents raw UTC as if it were local time.
    const tz = opts.tenant?.time_zone || "UTC";
    out.timeZone = tz;
    out.sampleRows = Array.isArray(rows) ? rows.slice(0, 3).map((r) => localizeRowTimestamps(r, tz)) : rows;
    if (opts.include_rows) out.rows = rows.map((r) => localizeRowTimestamps(r, tz));
  } else {
    out.rows = rows;
  }
  return out;
}

// --- Small date helpers ------------------------------------------------------

export function isIsoDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
}

/** Today as YYYY-MM-DD (local time). */
export function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** First day of the current month as YYYY-MM-DD. */
export function startOfMonth() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-01`;
}

/** Human-readable list of the params a card needs (for list_reports). */
export function inputFor(card) {
  return card.params
    .map((p) => (p.optional ? `${p.name}?` : p.name))
    .join(", ");
}
