/**
 * Generic raw probe for any report card — reveals its columns before a
 * summarizer is written. Resolves the tenant from the workspace slug, queries
 * the card, and prints the column list + first rows.
 *
 *   export METABASE_API_KEY='mb_...'
 *   node test-report-raw.js rating_feedback demo 2026-06-01 2026-07-30
 *   node test-report-raw.js appointment_summary demo
 *
 * Args: <report_key> [workspace_slug] [start_date] [end_date]
 */

import { CARDS, fetchCard, resolveWorkspace, startOfMonth, today } from "./metabase-core.js";

const reportKey = process.argv[2];
const slug = process.argv[3] || "demo";
const start_date = process.argv[4] || startOfMonth();
const end_date = process.argv[5] || today();

if (!reportKey || !CARDS[reportKey]) {
  console.error(
    `Usage: node test-report-raw.js <report_key> [slug] [start] [end]\n` +
      `Known reports: ${Object.keys(CARDS).join(", ")}`
  );
  process.exit(1);
}

const card = CARDS[reportKey];

function describeValue(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array[${v.length}]`;
  return typeof v;
}

try {
  const tenant = await resolveWorkspace(slug);
  console.log(`report='${reportKey}' (card ${card.id})  workspace='${slug}'  tenant=`, tenant);
  console.log(`range=${start_date} .. ${end_date}\n`);

  // Pass a no-op summarize bypass: fetchCard runs card.summarize if present, but
  // we want the RAW rows. Temporarily strip summarize for the probe.
  const probeCard = { ...card, summarize: undefined };
  const result = await fetchCard(reportKey, probeCard, { start_date, end_date, tenant });
  const rows = result.rows;

  console.log("rowCount:", result.rowCount);
  console.log("responseIsArray:", Array.isArray(rows));

  if (Array.isArray(rows) && rows.length) {
    const first = rows[0];
    console.log("\n=== COLUMNS (key: type) — first row ===");
    for (const k of Object.keys(first)) console.log(`  ${k}: ${describeValue(first[k])}`);

    const allKeys = new Set();
    for (const r of rows) if (r && typeof r === "object") Object.keys(r).forEach((k) => allKeys.add(k));
    const extra = [...allKeys].filter((k) => !(k in first));
    if (extra.length) console.log("\n  NOTE: keys in later rows but not the first:", extra.join(", "));

    console.log("\n=== FIRST ROWS (up to 3) ===");
    console.log(JSON.stringify(rows.slice(0, 3), null, 2));
  } else {
    console.log("\n=== RAW RESPONSE ===");
    console.log(JSON.stringify(rows, null, 2).slice(0, 2000));
  }
} catch (e) {
  console.error("ERROR:", e?.message || e);
  if (e?.cause) console.error("CAUSE:", e.cause.code || e.cause.name, e.cause.message);
  process.exit(1);
}
