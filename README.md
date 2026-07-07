# QMSCloud Reporting MCP Server — Node.js (Metabase)

Queries pre-built **Metabase cards** for QMSCloud and exposes them to AnythingLLM:

```
AnythingLLM (host)  ->  Ollama / Qwen  ->  this MCP server  ->  Metabase card JSON
```

Sibling of `../mcpreport` (which talks to the QMS700i servlet). The difference:
this server has **no login flow** — Metabase authenticates with a static
`x-api-key` header, and each report is a saved Metabase card queried via
`POST /api/card/<id>/query/json`.

## Tools

- `get_report(report, start_date?, end_date?)` — fetch and return card rows.
  `workspace_slug` is injected by AnythingLLM (do not pass it manually).
- `list_reports()` — list available report keys.

Currently available reports: `ticket_summary` (card 40). Appointment, rating,
etc. will be added to the `CARDS` catalog in `metabase-core.js`.

## How it works

1. AnythingLLM injects `workspace_slug` on every call. The slug encodes the
   tenant as `<companyCode>` or `<companyCode>_<branchCode>` — split on the
   **first** underscore (codes themselves are hyphen-slugs, e.g. `branch-001`).
2. The server resolves the tenant **dynamically from Metabase** (no hardcoded
   map), caching the lookups for 5 minutes:
   - Company: POST card **41**, slugify each `CompanyCode`, match the company
     part → `CompanyId`. No match → `invalid company code`.
   - Branch (only if present): POST card **42**, slugify each `BranchCode`,
     match the branch part **and** `CompanyId` (branch codes repeat across
     companies) → `BranchId`. No match → `invalid branch code`.
   - So `demo` → DEMO company, whole-company view; `demo_kl001` → DEMO + KL001
     branch; `qc_branch-001` → QC + Branch 1. New companies/branches work with
     no code change.
3. The model supplies `start_date` / `end_date` from the user's intent.
4. The server POSTs the Metabase `parameters` array (start_date, end_date,
   company_id, and branch_id when present) to the ticket card and returns rows.

## 1. Install

Requires Node.js 18+ (built-in `fetch`).

```bash
cd /Users/koo/Desktop/Claude/Projects/QMS/metabase-mcpreport
npm install
```

## 2. Quick local test (no AnythingLLM)

The API key is not hardcoded — export it first:

```bash
export METABASE_API_KEY='mb_...your key...'
node test-ticket-summary.js                       # demo, month-to-date
node test-ticket-summary.js demo 2026-06-11 2026-06-30
```

## 3. Register in AnythingLLM

Add to `anythingllm_mcp_servers.json` (absolute paths):

```json
{
  "mcpServers": {
    "qmscloud-report": {
      "command": "node",
      "args": ["/Users/koo/Desktop/Claude/Projects/QMS/metabase-mcpreport/server.js"],
      "env": {
        "METABASE_BASE_URL": "http://54.251.164.99:7777",
        "METABASE_API_KEY": "mb_...PASTE_KEY..."
      }
    }
  }
}
```

Windows note (same gotcha as `../mcpreport`): if `C:\Program Files\nodejs\node.exe`
fails with `ENOENT`, use the 8.3 short path `C:\\PROGRA~1\\nodejs\\node.exe`.

## 4. Set the workspace system prompt

Paste the contents of `system_prompt.txt` into the AnythingLLM workspace **system
prompt**. It tells the model when/how to call `get_report`. Tools only fire in
`@agent` mode.

`METABASE_API_KEY` is **required** and is not hardcoded (kept out of source
control). Set it in the `env` block above. `METABASE_BASE_URL` defaults to
`http://54.251.164.99:7777` if omitted.

## Configuration reference

- Tenant resolution is dynamic (cards 41/42) — no slug map to maintain. Env
  overrides: `METABASE_COMPANY_CARD_ID` (41), `METABASE_BRANCH_CARD_ID` (42),
  `METABASE_LOOKUP_TTL_MS` (300000). Test with `node test-lookup-cards.js`.
- `CARDS` (metabase-core.js) — report key → Metabase card id + params.

## Notes

- Tools fire only in AnythingLLM `@agent` mode.
- Treat the Metabase API key as a secret; keep this config out of git.
