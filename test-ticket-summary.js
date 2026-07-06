/**
 * Standalone test for the ticket_summary card — bypasses MCP/AnythingLLM and
 * hits Metabase directly through metabase-core.js. Run:
 *
 *   node test-ticket-summary.js
 *   node test-ticket-summary.js demo 2026-06-11 2026-06-30
 *
 * Args: [workspace_slug] [start_date] [end_date]
 */

import { CARDS, fetchCard, resolveWorkspace, startOfMonth, today } from "./metabase-core.js";

const slug = process.argv[2] || "demo";
const start_date = process.argv[3] || startOfMonth();
const end_date = process.argv[4] || today();

const card = CARDS.ticket_summary;

try {
  const tenant = resolveWorkspace(slug);
  console.log(`workspace='${slug}' tenant=`, tenant);
  console.log(`range=${start_date} .. ${end_date}\n`);

  const result = await fetchCard("ticket_summary", card, { start_date, end_date, tenant });
  console.log("rowCount:", result.rowCount, "\n");
  console.log("=== SUMMARY (what the model receives) ===");
  console.log(JSON.stringify(result.summary, null, 2));
  console.log("\n=== SAMPLE ROW (1 of", result.rowCount, ") ===");
  console.log(JSON.stringify(result.sampleRows?.[0], null, 2));
} catch (e) {
  console.error("ERROR:", e?.message || e);
  if (e?.cause) console.error("CAUSE:", e.cause.code || e.cause.name, e.cause.message);
  process.exit(1);
}
