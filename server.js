/**
 * QMSCloud Reporting MCP Server — queries Metabase card JSON.
 *
 *   AnythingLLM (host)  ->  Ollama / Qwen  ->  this MCP server  ->  Metabase card JSON
 *
 * The workspace_slug (injected by AnythingLLM) selects the tenant's company_id /
 * branch_id; the model supplies the date range from the user's intent. The
 * server POSTs to the matching Metabase card and returns parsed rows for the
 * model to analyze.
 *
 * Transport: stdio.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  CARDS,
  fetchCard,
  resolveWorkspace,
  inputFor,
  isIsoDate,
  today,
  startOfMonth,
} from "./metabase-core.js";

const server = new McpServer({ name: "qmscloud-report", version: "1.0.0" });

function jsonContent(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

server.tool(
  "get_report",
  "Fetch a QMSCloud report from Metabase and analyze it to answer the user's " +
    "question. Returns a compact `summary` (counts, breakdowns, and a codes list) " +
    "plus a few `sampleRows`. For questions that require LISTING individual records " +
    "(with their times / details), pass detail=true to also get a per-record table. " +
    "Pass the exact `report` key (call list_reports if unsure). Supply " +
    "`start_date`/`end_date` as YYYY-MM-DD from the user's intent (defaults to current " +
    "month-to-date). The tenant (company/branch) is resolved automatically from the " +
    "workspace — do not ask the user for it. Available reports: 'ticket_summary' " +
    "(queue tickets: status, service, branch, counter, waiting/serving time), " +
    "'appointment_summary' (booked appointments: status, attendance/check-in rate, " +
    "service, branch, appointment date), and 'rating_feedback' (customer ratings: " +
    "average score, rating distribution, per-branch averages, and written feedback).",
  {
    report: z
      .string()
      .describe("Exact report key, e.g. 'ticket_summary'. See list_reports."),
    start_date: z
      .string()
      .optional()
      .describe("Start date YYYY-MM-DD. Defaults to the first of the current month."),
    end_date: z
      .string()
      .optional()
      .describe("End date YYYY-MM-DD. Defaults to today."),
    detail: z
      .boolean()
      .optional()
      .describe("Set true when the user wants to LIST individual records with their details (ticket times, or appointment schedule/customer). Adds a compact per-record table (`summary.tickets` or `summary.appointments_detail`). Default false (aggregates only)."),
    include_rows: z
      .boolean()
      .optional()
      .describe("Rarely needed. If true, also returns every raw row with all columns (large, GUID-heavy). Prefer `detail` for per-ticket listing. Default false."),
    workspace_slug: z
      .string()
      .describe(
        "Internal: identifies which QMSCloud tenant to query. Injected " +
          "automatically by the AnythingLLM host on every call — do not ask the " +
          "user for it and do not set it yourself."
      ),
  },
  async ({ report, start_date = "", end_date = "", detail = false, include_rows = false, workspace_slug }) => {
    const card = CARDS[report];
    if (!card) {
      return jsonContent({
        error: "invalid_report",
        message: `'${report}' is not a valid report key.`,
        available: Object.keys(CARDS),
      });
    }

    // Resolve tenant (company_id / branch_id) from the workspace slug — looked
    // up dynamically against Metabase (cards 41/42), cached with a short TTL.
    let tenant;
    try {
      tenant = await resolveWorkspace(workspace_slug);
    } catch (e) {
      return jsonContent({ error: "invalid_workspace", message: String(e?.message || e) });
    }

    // Default to month-to-date if the model didn't supply a range.
    const from = start_date || startOfMonth();
    const to = end_date || today();
    if (!isIsoDate(from)) {
      return jsonContent({ error: "invalid_date", message: `start_date must be YYYY-MM-DD, got '${from}'.` });
    }
    if (!isIsoDate(to)) {
      return jsonContent({ error: "invalid_date", message: `end_date must be YYYY-MM-DD, got '${to}'.` });
    }

    try {
      const result = await fetchCard(report, card, { start_date: from, end_date: to, tenant, detail, include_rows });
      return jsonContent({ ...result, start_date: from, end_date: to });
    } catch (e) {
      return jsonContent({ error: "request_failed", message: String(e?.message || e) });
    }
  }
);

server.tool(
  "list_reports",
  "List the QMSCloud report keys this server can fetch from Metabase.",
  {},
  async () =>
    jsonContent({
      reports: Object.entries(CARDS).map(([key, c]) => ({
        key,
        label: c.label,
        description: c.description || "",
        input: inputFor(c),
        cardId: c.id,
      })),
      today: today(),
    })
);

const transport = new StdioServerTransport();
await server.connect(transport);
