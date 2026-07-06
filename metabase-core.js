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

// --- Workspace -> tenant routing --------------------------------------------
// AnythingLLM injects `workspace_slug` on every call. Each slug maps to a
// QMSCloud tenant: a required company_id and an optional branch_id. When a slug
// has no branch_id, we simply omit that parameter from the Metabase request.
//
// Add new workspaces here as they are created. Any slug not listed is rejected
// with an "invalid workspace slug" response.
export const WORKSPACE_MAP = {
  demo: {
    company_id: "4f1589c0-5f9e-4f52-aee2-2b864204c14c",
    // branch_id intentionally omitted (whole-company view)
  },
};

/**
 * Resolve a workspace_slug to { company_id, branch_id? }, or throw if unknown.
 * @param {string} workspaceSlug
 * @returns {{ company_id: string, branch_id?: string }}
 */
export function resolveWorkspace(workspaceSlug) {
  const tenant = WORKSPACE_MAP[workspaceSlug];
  if (!tenant) {
    const known = Object.keys(WORKSPACE_MAP).join(", ") || "(none configured)";
    throw new Error(
      `invalid workspace slug '${workspaceSlug}'. Known workspaces: ${known}.`
    );
  }
  return tenant;
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
};

// --- Summarizers -------------------------------------------------------------
// Turn raw Metabase rows into a small digest the model can reason over.

function tally(rows, key) {
  const out = {};
  for (const r of rows) {
    const k = r?.[key] ?? "(null)";
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

/** minutes between two ISO timestamps, or null if either missing/invalid. */
function minutesBetween(a, b) {
  if (!a || !b) return null;
  const t1 = Date.parse(a);
  const t2 = Date.parse(b);
  if (Number.isNaN(t1) || Number.isNaN(t2)) return null;
  const m = (t2 - t1) / 60000;
  return m >= 0 ? m : null; // ignore negative (clock/order anomalies)
}

function round1(n) {
  return n == null ? null : Math.round(n * 10) / 10;
}

function durationStats(values) {
  const v = values.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return { count: 0 };
  const sum = v.reduce((a, b) => a + b, 0);
  return {
    count: v.length,
    avg_min: round1(sum / v.length),
    median_min: round1(v[Math.floor(v.length / 2)]),
    min_min: round1(v[0]),
    max_min: round1(v[v.length - 1]),
  };
}

/**
 * Build a compact per-ticket-service detail table (human fields + computed
 * waiting/serving minutes) — used to answer "list all tickets with their times".
 * One entry per service row, so multi-service tickets appear more than once.
 */
function ticketDetail(rows, cap) {
  const list = rows.slice(0, cap).map((r) => ({
    ticket: r.TicketText,
    service: r.ServiceName ?? null,
    counter: r.CounterName ?? null,
    status: r.Status,
    business_date: r.BusinessDate ?? null,
    issued: r.IssuedAtUtc ?? null,
    checked_in: r.CheckedInAtUtc ?? null,
    called: r.CalledAtUtc ?? null,
    completed: r.CompletedAtUtc ?? null,
    waiting_min: round1(minutesBetween(r.CheckedInAtUtc, r.CalledAtUtc)),
    serving_min: round1(minutesBetween(r.CalledAtUtc, r.CompletedAtUtc)),
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
 *  - Waiting = CalledAtUtc - CheckedInAtUtc; Serving = CompletedAtUtc - CalledAtUtc.
 *    Median is the reliable figure; avg/max are skewed by tickets left open for
 *    days in the data, so both are reported for transparency.
 */
function summarizeTicketRows(rows, opts = {}) {
  if (!Array.isArray(rows)) return { note: "unexpected (non-array) response", raw: rows };
  if (!rows.length) return { service_rows: 0, note: "no rows for this range" };

  const waiting = rows.map((r) => minutesBetween(r.CheckedInAtUtc, r.CalledAtUtc));
  const serving = rows.map((r) => minutesBetween(r.CalledAtUtc, r.CompletedAtUtc));

  const first = rows[0] || {};

  // Distinct ticket labels (e.g. "G0001", "V0002") so the model can answer
  // "list the ticket numbers" without pulling every raw row. Capped to keep the
  // payload small; if truncated, the model can narrow the range or use include_rows.
  const TICKET_CAP = 300;
  const ticketTexts = [...new Set(rows.map((r) => r.TicketText).filter(Boolean))].sort();

  const out = {
    // Human-readable context (names now come back in the query).
    context: {
      company: first.CompanyName || first.CompanyCode || null,
      branches: [...new Set(rows.map((r) => r.BranchName).filter(Boolean))],
    },
    service_rows: rows.length,
    distinct_tickets: distinctCount(rows, "TicketId"),
    distinct_queue_sessions: distinctCount(rows, "QueueSessionId"),
    distinct_services: distinctCount(rows, "ServiceId"),
    distinct_branches: distinctCount(rows, "BranchId"),
    distinct_counters: distinctCount(rows, "CounterId"),
    by_status: tally(rows, "Status"),
    by_service: tally(rows, "ServiceName"),
    by_branch: tally(rows, "BranchName"),
    // Counter is null until a ticket is called, so "(null)" = not-yet-served.
    by_counter: tally(rows, "CounterName"),
    by_attendance_mode: tally(rows, "AttendanceMode"),
    // BusinessDate is the operational queue day (differs from CheckedInAtUtc and
    // stays within the requested range), so it's the correct date grouping.
    by_business_date: tally(rows, "BusinessDate"),
    ticket_numbers: {
      count: ticketTexts.length,
      list: ticketTexts.slice(0, TICKET_CAP),
      truncated: ticketTexts.length > TICKET_CAP,
    },
    waiting_minutes: durationStats(waiting),
    serving_minutes: durationStats(serving),
  };

  // Per-ticket detail (issued/called/completed/waiting/serving per row) is only
  // included when explicitly requested, to keep the default summary compact.
  if (opts.detail) out.tickets = ticketDetail(rows, opts.detailCap || 200);

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

export async function fetchCard(cardKey, card, opts = {}) {
  if (!METABASE_API_KEY) {
    throw new Error(
      "METABASE_API_KEY is not set. Add it to the AnythingLLM MCP `env` block " +
        "(or export it in your shell for local testing)."
    );
  }
  const url = `${METABASE_BASE_URL}/api/card/${card.id}/query/json`;
  const bodyStr = JSON.stringify(buildRequestBody(card, opts));

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
      `Metabase card ${card.id} request failed: ${e?.code ? e.code + " " : ""}${e?.message || e}`
    );
  }

  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `Metabase card ${card.id} returned HTTP ${res.status}: ${res.text.slice(0, 500)}`
    );
  }

  let rows;
  try {
    rows = JSON.parse(res.text);
  } catch {
    throw new Error(
      `Metabase card ${card.id} did not return JSON: ${res.text.slice(0, 300)}`
    );
  }

  const rowCount = Array.isArray(rows) ? rows.length : undefined;
  const out = { card: cardKey, cardId: card.id, rowCount };

  // Card 40 (and future high-volume cards) return raw rows — aggregate them into
  // a compact digest so the small LLM isn't flooded. Include a few sample rows
  // for context, and the full rows only when explicitly requested.
  if (card.summarize) {
    out.summary = card.summarize(rows, opts);
    out.sampleRows = Array.isArray(rows) ? rows.slice(0, 3) : rows;
    if (opts.include_rows) out.rows = rows;
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
