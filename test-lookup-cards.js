/**
 * Probe the Metabase lookup cards used for dynamic company/branch resolution:
 *   card 41 -> companies (CompanyCode -> CompanyId)
 *   card 42 -> branches  (BranchCode  -> BranchId)
 *
 * Prints each card's column list and first rows so we can wire up the resolver.
 * Run:
 *   export METABASE_API_KEY='mb_...'
 *   node test-lookup-cards.js
 *   node test-lookup-cards.js 41        # just one card
 */

import { METABASE_BASE_URL, METABASE_API_KEY } from "./metabase-core.js";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const TIMEOUT_MS = Number(process.env.METABASE_TIMEOUT_MS || 120000);

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
        headers: { ...headers, "Content-Length": Buffer.byteLength(bodyStr) },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") })
        );
      }
    );
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`timed out after ${TIMEOUT_MS}ms`)));
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

async function probeCard(id) {
  const url = `${METABASE_BASE_URL}/api/card/${id}/query/json`;
  console.log(`\n================ CARD ${id} — ${url} ================`);
  // Lookup cards likely have no template-tag parameters; send an empty array.
  const res = await httpPostJson(
    url,
    { "Content-Type": "application/json", Accept: "application/json", "x-api-key": METABASE_API_KEY },
    JSON.stringify({ parameters: [] })
  );
  console.log("HTTP status:", res.status);

  let rows;
  try {
    rows = JSON.parse(res.text);
  } catch {
    console.log("Non-JSON response (first 800 chars):\n", res.text.slice(0, 800));
    return;
  }

  if (!Array.isArray(rows)) {
    console.log("Response is not an array:\n", JSON.stringify(rows, null, 2).slice(0, 1500));
    return;
  }

  console.log("rowCount:", rows.length);
  if (rows.length) {
    console.log("COLUMNS:", Object.keys(rows[0]).join(", "));
    console.log("FIRST ROWS (up to 5):");
    console.log(JSON.stringify(rows.slice(0, 5), null, 2));
  }
}

if (!METABASE_API_KEY) {
  console.error("METABASE_API_KEY is not set. Run: export METABASE_API_KEY='mb_...'");
  process.exit(1);
}

const ids = process.argv[2] ? [process.argv[2]] : [41, 42];
try {
  for (const id of ids) await probeCard(id);
} catch (e) {
  console.error("ERROR:", e?.message || e);
  process.exit(1);
}
