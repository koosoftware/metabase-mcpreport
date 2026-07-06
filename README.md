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

1. AnythingLLM injects `workspace_slug` on every call.
2. The slug maps to a tenant `{ company_id, branch_id? }` via `WORKSPACE_MAP`.
   - `demo` → `company_id = 4f1589c0-5f9e-4f52-aee2-2b864204c14c` (no branch_id).
   - Unknown slug → returns `invalid workspace slug`.
3. The model supplies `start_date` / `end_date` from the user's intent.
4. The server POSTs the Metabase `parameters` array (start_date, end_date,
   company_id, and branch_id when present) to the card and returns the rows.

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

- `WORKSPACE_MAP` (metabase-core.js) — slug → `{ company_id, branch_id? }`.
- `CARDS` (metabase-core.js) — report key → Metabase card id + params.

## Notes

- Tools fire only in AnythingLLM `@agent` mode.
- Treat the Metabase API key as a secret; keep this config out of git.
