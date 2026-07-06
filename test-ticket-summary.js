/**
 * Standalone test for the ticket_summary card — bypasses MCP/AnythingLLM and
 * hits Metabase directly through metabase-core.js. Run:
 *
 *   export METABASE_API_KEY='mb_...'
 *   node test-ticket-summary.js
 *   node test-ticket-summary.js demo 2026-06-11 2026-06-30
 *
 * Args: [workspace_slug] [start_date] [end_date]
 *
 * This prints DIAGNOSTICS about the raw Metabase response (column list, shape,
 * one full sample row) so the summarizer can be aligned to the current query,
 * followed by the current summary for comparison.
 */

import { CARDS, fetchCard, resolveWorkspace, startOfMonth, today } from "./metabase-core.js";

const slug = process.argv[2] || "demo";
const start_date = process.argv[3] || startOfMonth();
const end_date = process.argv[4] || today();

const card = CARDS.ticket_summary;

function describeValue(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array[${v.length}]`;
  return typeof v; // string | number | boolean | object
}

try {
  const tenant = resolveWorkspace(slug);
  console.log(`workspace='${slug}' tenant=`, tenant);
  console.log(`range=${start_date} .. ${end_date}\n`);

  // include_rows so we can inspect the raw response shape below.
  const result = await fetchCard("ticket_summary", card, {
    start_date,
    end_date,
    tenant,
    include_rows: true,
  });

  const rows = result.rows;
  console.log("rowCount:", result.rowCount);
  console.log("responseIsArray:", Array.isArray(rows));

  if (Array.isArray(rows) && rows.length) {
    const first = rows[0];
    console.log("\n=== COLUMNS (key: type) — first row ===");
    for (const k of Object.keys(first)) {
      console.log(`  ${k}: ${describeValue(first[k])}`);
    }

    // Flag columns whose presence/absence varies across rows (schema drift).
    const allKeys = new Set();
    for (const r of rows) if (r && typeof r === "object") Object.keys(r).forEach((k) => allKeys.add(k));
    const firstKeys = new Set(Object.keys(first));
    const extra = [...allKeys].filter((k) => !firstKeys.has(k));
    if (extra.length) console.log("\n  NOTE: keys present in later rows but not the first:", extra.join(", "));

    console.log("\n=== FULL SAMPLE ROW (1 of " + result.rowCount + ") ===");
    console.log(JSON.stringify(first, null, 2));
  } else {
    console.log("\n=== RAW RESPONSE (not an array of rows) ===");
    console.log(JSON.stringify(rows, null, 2).slice(0, 3000));
  }

  console.log("\n=== CURRENT SUMMARY (what the model receives now) ===");
  console.log(JSON.stringify(result.summary, null, 2));
} catch (e) {
  console.error("ERROR:", e?.message || e);
  if (e?.cause) console.error("CAUSE:", e.cause.code || e.cause.name, e.cause.message);
  process.exit(1);
}
