/**
 * Probe the appointment card (43) to reveal its columns before writing a
 * summarizer. Resolves the tenant from the workspace slug (so company_id is
 * real), queries the card, and prints the column list + first rows.
 *
 *   export METABASE_API_KEY='mb_...'
 *   node test-appointment-raw.js                       # demo, month-to-date
 *   node test-appointment-raw.js demo 2026-06-11 2026-06-30
 *
 * Args: [workspace_slug] [start_date] [end_date]
 */

import { CARDS, fetchCard, resolveWorkspace, startOfMonth, today } from "./metabase-core.js";

const slug = process.argv[2] || "demo";
const start_date = process.argv[3] || startOfMonth();
const end_date = process.argv[4] || today();

const card = CARDS.appointment_summary;

function describeValue(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array[${v.length}]`;
  return typeof v;
}

try {
  const tenant = await resolveWorkspace(slug);
  console.log(`workspace='${slug}' tenant=`, tenant);
  console.log(`range=${start_date} .. ${end_date}\n`);

  // No summarize on this card yet, so fetchCard returns raw rows in `.rows`.
  const result = await fetchCard("appointment_summary", card, { start_date, end_date, tenant });
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
