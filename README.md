# csvbox-mcp-server

A universal [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for [CSVBox](https://csvbox.io). It exposes CSVBox importer-sheet management as MCP tools so you can create, replace, patch, generate, validate, and scaffold importers from any MCP-compatible client — Claude Desktop, Cursor, Windsurf, Roo Code, Cline, VS Code, ChatGPT MCP, and more.

Runs over **stdio**, so it works the same way in every client.

## Tools

| Tool | Purpose | API call |
| --- | --- | --- |
| `list_sheets` | List/search your sheets by title (paginated) | `GET /1.1/sheet` |
| `get_sheet` | Read one sheet's full configuration (read before patching) | `GET /1.1/sheet/{key}` |
| `list_imports` | Import history: filter by sheet, status, date | `GET /1.1/import` |
| `get_import` | One import's status and row counts | `GET /1.1/import/{id}` |
| `get_import_errors` | Why an import failed: a plain-language `likely_cause`, causes grouped by category, and the rows and columns involved | `GET /1.1/import/{id}/errors` |
| `get_usage` | Plan, imports used and remaining this billing cycle | `GET /1.1/account/usage` |
| `generate_webhook_handler` | Backend webhook handler for Laravel / Express / Django / Next.js | none |
| `generate_sample_csv` | Test CSV from a sheet schema, with deliberately invalid rows | `GET /1.1/sheet/{key}` (only if a key is given) |
| `submit_file` | Submit a file (public URL or base64) to import into a sheet; consumes one import | `POST /1.1/file` |
| `create_sheet` | Create a CSVBox sheet | `POST /1.1/sheet` |
| `update_sheet` | Replace an existing sheet | `PUT /1.1/sheet/{key}` |
| `patch_sheet` | Partially update a sheet | `PATCH /1.1/sheet/{key}` |
| `generate_sheet_json` | NL prompt → complete sheet JSON (via LLM) | none (calls LLM) |
| `create_importer_from_prompt` | NL prompt → validate → create | `POST /1.1/sheet` (+ LLM) |
| `generate_import_code` | Integration code (vanilla-js/react/vue/angular) | none |
| `generate_sheet_functions` | NL prompt → virtual columns / validation functions / data transforms (via LLM) | none (calls LLM) |
| `validate_schema` | Local schema validation: column types, list-value shapes, function collections; `mode` is `create`, `put` or `patch` | none |

> The CSVBox API allows 60 requests per minute per key. A `429` comes back as a tool error with `status: 429`; wait and retry.

> Edit an existing importer by name: `list_sheets` (search by title) → `get_sheet` (read the current configuration) → `patch_sheet`. Prefer `patch_sheet` over `update_sheet`, which deletes anything not sent.

It also exposes four **MCP prompts**:

| Prompt | Purpose |
| --- | --- |
| `create_csvbox_sheet` | Make the host client's own LLM build a complete CSVBox sheet (no server-side LLM key needed). |
| `csvbox_sheet_functions` | Make the host client's own LLM author virtual columns, validation functions, and data transforms (no server-side LLM key needed). |
| `debug_failed_import` | Walk from an import's recorded errors to a proposed `patch_sheet` fix; changes nothing until you approve. |
| `migrate_from_flatfile` | Convert a pasted Flatfile / OneSchema config into a CSVBox sheet, report what could not be mapped, and ask before creating it. |

And three **MCP resources**: `csvbox://sheets/{key}` (a sheet's configuration with credential-like fields removed), `csvbox://docs/column-types` and `csvbox://docs/webhook-payload`.

`get_usage` returns `null` for `limit` and `remaining` on unlimited plans. `generate_sample_csv` and the generators never execute `js_code`.

### Prompt → sheet generation

`generate_sheet_json` and `create_importer_from_prompt` use an LLM to convert a free-form request into a **complete** CSVBox sheet — `title`, `sheet_columns`, `destinations`, `webhooks`, `security_settings`, and `steps`. Only actual data fields become columns; destinations, webhooks, domains, regions, file-upload and step settings are placed in their proper configuration sections, never turned into columns. There are three tiers:

1. **Server LLM** — when `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set, the server calls the LLM directly. Works in MCP Inspector and headless.
2. **MCP prompt** (`create_csvbox_sheet`) — when you have no server key, host clients (Cursor, Claude Desktop, Cline) run the generation with their own model, then call `validate_schema` and `create_sheet`. Free.
3. **None configured** — `generate_sheet_json` returns a structured "no LLM provider configured" error pointing to the MCP prompt, and `create_importer_from_prompt` does not call the CSVBox API. There is **no** regex fallback.

#### Category / module expansion

The generator runs in one of two modes, chosen automatically from the prompt:

- **Extraction** (default) — the prompt names concrete fields (e.g. *"columns name, email, phone"*). Only those become columns; nothing is invented.
- **Expansion** — the prompt names business **modules / categories** as a list (e.g. *"modules for: Company Information, Suppliers, Payroll, Invoice"*), asks for a *comprehensive*/*detailed* schema, or asks for a column count (*"at least 100 columns"*). Each named module is expanded into several realistic, prefixed, correctly-typed columns (e.g. Suppliers → `supplier_id`, `supplier_name`, `supplier_gstin`, `supplier_email`, …). An explicit minimum count is honored and every `column_name` is globally unique.

Data types and validations are inferred from the field names and any requested types:

| Requested / implied | Column `type` | Validators |
| --- | --- | --- |
| Dropdown / status / category with fixed options | `list` | `values: [{ "value": "x" }, ...]` candidate options (optional `display_label` per entry) |
| Multi-select with fixed options | `multiselect_list` | `values: ["a", "b"]` (plain strings) |
| Percentage / percent | `number` | `min_value: 0`, `max_value: 100` |
| Positive numeric (quantity, count, stock, cost, age) | `number` | `min_value: 0` |
| ID / code / reference number | `text` | — |
| Email | `email` | — |
| Phone / mobile | `phone_number` | — |
| URL / website | `url` | — |
| Price / cost / amount / salary | `currency` | — |
| Date fields | `date` | `format: "YYYY-MM-DD"` |
| Boolean / is_* / active | `boolean` | — |
| GST / GSTIN / tax id | `regex` | GSTIN pattern |
| PIN code / postal code (India) | `regex` | `^[1-9][0-9]{5}$` |

> **Large schemas:** the default models (`claude-haiku-4-5`, `gpt-4o-mini`) are cheap but produce noticeably better 100+ column schemas when you override with a stronger model via `LLM_MODEL` (e.g. `claude-sonnet-4-6`). The output cap is raised to fit big sheets; if a request is still too large the response is flagged **`TRUNCATED`** (a distinct result, not a parse error) and the CSVBox API is **not** called — reduce the column count / modules or use a model with a larger output budget and retry.

## Function collections (virtual columns, validation functions, data transforms)

Beyond the six sheet properties, the CSVBox Sheet API accepts three collections whose items carry a `js_code` string that **CSVBox executes during an import**:

| Collection | Identified by | Max | `js_code` must… |
| --- | --- | --- | --- |
| `virtual_columns` | `column_name` | 20 | return the computed cell value |
| `validation_functions` | `function_name` | 10 | return an array of error strings (`[]` = valid) |
| `data_transforms` | `transform_name` | 10 | mutate the `csvbox` object and **return it** |

Inside `js_code` the `csvbox` object exposes `row`, `column`, `virtual`, `user`, `import`, and `environment`. The two accessors are **not** interchangeable — a virtual column is per-row and uses `csvbox.row.<name>` (a scalar), while a `"column"`-scoped function sees the whole column via `csvbox.column.<name>` (an array).

Shared optional fields: `scope` (`column` | `row`; not on virtual columns), `run_at` (`before_validation` | `after_validation`; data transforms only), `columns` / `dynamic_columns`, `active`, `dependencies`, and `_delete` (PATCH only).

### Authoring them

```json
// generate_sheet_functions  (requires ANTHROPIC_API_KEY or OPENAI_API_KEY)
{
  "prompt": "add a virtual column joining first and last name, and check every email contains an @",
  "sheet": { "title": "Customers", "sheet_columns": [ ... ] }
}
```

Returns `{ "virtual_columns": [...], "validation_functions": [...], "source": ..., "validation": {...} }`. Collections the request does not imply are **omitted**, never returned as empty arrays.

This tool **does not call the CSVBox API**. Read the generated `js_code`, then apply it yourself with `patch_sheet`. Pass `sheet` so the model references real column names and the validator can check those references — Pass the sheet from `get_sheet` so it can be supplied inline. Without an LLM key, use the `csvbox_sheet_functions` MCP prompt instead.

### PUT vs PATCH — read this before applying

| | `update_sheet` (PUT) | `patch_sheet` (PATCH) |
| --- | --- | --- |
| Collection you send | **authoritative** — any existing item not named is **deleted** | **merged** — unnamed items are left alone |
| `"virtual_columns": []` | **deletes all 20** | no-op |
| A column in `sheet_columns` | the sheet's columns become exactly what you send | only the fields you send change |
| Key omitted | untouched | untouched |
| `_delete: true` | not valid | removes that item (all its other fields ignored) |

**PATCH merges columns field by field.** A column named in `sheet_columns` needs only its `column_name` plus the fields you want to change. `display_label`, `info_hint`, `default_value`, `required`, `read_only`, `matching_keywords` and `metadata.transforms` change only when sent; `validators` merge key by key (send a key as `null` to reset it to its default); everything not sent is kept, including settings the API cannot express, such as a column's auto-mapping keywords and its unique flag. Changing `type` resets `validators` to the new type's defaults, so send the validators you want with it. Columns you do not name are left alone, and a new `column_name` adds a column (send its full definition). `update_sheet` (PUT) is different: it replaces everything. This merge needs a CSVbox release that supports it; against an older server a named column is replaced whole, so send its full object.

**List values have two shapes.** A `list` column needs objects with a required `value` and an optional `display_label` that is stored as an empty string when omitted (nested `dependents` the same way); a `multiselect_list` column takes plain strings (a multiselect column with no values is stored with an empty list, which the importer needs to render). The API returns 200 and silently stores an empty list for anything else, so run `validate_schema`, which now rejects both mistakes.

Use `patch_sheet` to apply generated functions. Validate first with the matching verb:

```json
// validate_schema
{ "sheet": { "data_transforms": [ ... ] }, "mode": "patch" }
```

`mode` is `create` (default), `put`, or `patch`. For the function collections, under `put` an empty array is a hard error rather than a warning, and `_delete` is rejected outside `patch`. For columns, `patch` is the lenient mode: a column needs only its `column_name` (the server changes just the fields you send), `display_label` and `type` are checked only when present, and the list-value shape is checked only when `type` is sent. `create` and `put` still require `display_label` and `type` on every column.

### Dependencies

An item may load up to 5 third-party scripts:

```json
{ "url": "https://cdn.jsdelivr.net/npm/dayjs@1.11.10/dayjs.min.js",
  "globals": ["dayjs"],
  "integrity": "sha384-..." }
```

Only `cdn.jsdelivr.net`, `unpkg.com`, and `cdnjs.cloudflare.com` are allowed; https only, `.js`/`.mjs` path, no query string, fragment, userinfo, or port.

> **Security.** This server never executes `js_code` — it is an opaque string here. Generated JavaScript is unreviewed model output, so read it before you PATCH it into a live importer. A dependency without an `integrity` digest can change under your customers at any time; `validate_schema` warns when one is missing.

See `docs/sheet-functions-example.json` for a full payload.

## Installation

```bash
npm install @csvbox/mcp-server
```

Or build from source:

```bash
git clone <this-repo> csvbox-mcp-server
cd csvbox-mcp-server
npm install
npm run build
```

This produces `dist/index.js` — the entrypoint MCP clients launch.

## Environment variables

Copy `.env.example` to `.env` and fill in your CSVBox credentials:

```bash
CSVBOX_API_KEY=your_api_key
CSVBOX_API_SECRET=your_api_secret
```

CSVBox credentials are **only** required for the tools that call the CSVBox API: `list_sheets`, `get_sheet`, `list_imports`, `get_import`, `get_import_errors`, `get_usage`, `create_sheet`, `update_sheet`, `patch_sheet`, `submit_file`, `create_importer_from_prompt`, and `generate_sample_csv` when you give it a `sheet_license_key`. `validate_schema`, `generate_import_code`, `generate_webhook_handler` and `generate_sample_csv` with an inline `sheet` work without any credentials. The LLM-backed tools (`generate_sheet_json`, `create_importer_from_prompt`, `generate_sheet_functions`) also need an LLM key, below.

> **Auth header note:** the client sends `x-csvbox-api-key` and `x-csvbox-secret-api-key` (matching the CSVBox reference payloads). These are defined as constants in `src/services/csvbox-api.ts` if your account uses different header names.

### Client identification

Every request this server sends to the CSVBox API carries two extra headers:

```
x-csvbox-client: mcp
x-csvbox-client-version: <the version in package.json>
```

CSVBox records how each sheet was created; without these, sheets and imports made through MCP are indistinguishable from any other REST caller. The version is read from `package.json` and is the same one the server advertises to your MCP client, so the two can never disagree.

These are **always sent** — there is no environment variable or tool input that disables or changes them. They carry no credentials and nothing derived from your tool inputs. Tools that make no API call (`generate_sheet_json`, `generate_sheet_functions`, `generate_import_code`, `validate_schema`) send no request and therefore no headers.

### LLM provider (for prompt → sheet generation)

`generate_sheet_json` and `create_importer_from_prompt` need an LLM. Set **one** of:

```bash
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
```

The provider is auto-detected:

| Condition | Provider | Default model |
| --- | --- | --- |
| `LLM_PROVIDER=anthropic` (and its key set) | Anthropic | `claude-haiku-4-5` |
| `LLM_PROVIDER=openai` (and its key set) | OpenAI | `gpt-4o-mini` |
| `ANTHROPIC_API_KEY` set (no `LLM_PROVIDER`) | Anthropic | `claude-haiku-4-5` |
| `OPENAI_API_KEY` set (no `LLM_PROVIDER`) | OpenAI | `gpt-4o-mini` |
| neither key set | none — tools return an error pointing to the `create_csvbox_sheet` MCP prompt | — |

`LLM_PROVIDER` disambiguates when both keys are present; `LLM_MODEL` overrides the model for whichever provider is chosen. For large category/module schemas (100+ columns) set `LLM_MODEL` to a stronger model (e.g. `claude-sonnet-4-6`) — see [Category / module expansion](#category--module-expansion).

> **MCP Inspector:** set the LLM key in the Inspector's environment-variables panel to use the server-LLM path. Inspector has no host LLM of its own, so it can *render* the `create_csvbox_sheet` prompt but cannot *execute* it — for the keyless path use a client with a model (Cursor, Claude Desktop, Cline).

## Running locally

```bash
# After building:
npm start

# Or run the built file directly:
node dist/index.js
```

The server speaks MCP over stdio and logs `csvbox-mcp-server running on stdio` to **stderr** (stdout is reserved for the protocol).

## Client configuration

For a published installation, use the npm package with `npx`. Set `CSVBOX_API_KEY` / `CSVBOX_API_SECRET` in the `env` block.

> **Note:** The npm package is `@csvbox/mcp-server` and the executable is `csvbox-mcp-server`.

### Claude Desktop

Add the following to your Claude Desktop MCP configuration:

```json
{
  "mcpServers": {
    "csvbox": {
      "command": "npx",
      "args": [
        "-y",
        "--package=@csvbox/mcp-server",
        "csvbox-mcp-server"
      ],
      "env": {
        "CSVBOX_API_KEY": "your_api_key",
        "CSVBOX_API_SECRET": "your_api_secret"
      }
    }
  }
}
```

### Cursor

Edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per-project):

```json
{
  "mcpServers": {
    "csvbox": {
      "command": "npx",
      "args": [
        "-y",
        "--package=@csvbox/mcp-server",
        "csvbox-mcp-server"
      ],
      "env": {
        "CSVBOX_API_KEY": "your_api_key",
        "CSVBOX_API_SECRET": "your_api_secret"
      }
    }
  }
}
```

### Windsurf

Edit `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "csvbox": {
      "command": "npx",
      "args": [
        "-y",
        "--package=@csvbox/mcp-server",
        "csvbox-mcp-server"
      ],
      "env": {
        "CSVBOX_API_KEY": "your_api_key",
        "CSVBOX_API_SECRET": "your_api_secret"
      }
    }
  }
}
```

### Roo Code

In the Roo Code MCP settings (`mcp_settings.json`):

```json
{
  "mcpServers": {
    "csvbox": {
      "command": "npx",
      "args": [
        "-y",
        "--package=@csvbox/mcp-server",
        "csvbox-mcp-server"
      ],
      "env": {
        "CSVBOX_API_KEY": "your_api_key",
        "CSVBOX_API_SECRET": "your_api_secret"
      }
    }
  }
}
```

### Cline

In the Cline MCP settings (`cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "csvbox": {
      "command": "npx",
      "args": [
        "-y",
        "--package=@csvbox/mcp-server",
        "csvbox-mcp-server"
      ],
      "env": {
        "CSVBOX_API_KEY": "your_api_key",
        "CSVBOX_API_SECRET": "your_api_secret"
      }
    }
  }
}
```

### VS Code MCP

Add to `.vscode/mcp.json` (or the global `mcp.json`):

```json
{
  "servers": {
    "csvbox": {
      "command": "npx",
      "args": [
        "-y",
        "--package=@csvbox/mcp-server",
        "csvbox-mcp-server"
      ],
      "env": {
        "CSVBOX_API_KEY": "your_api_key",
        "CSVBOX_API_SECRET": "your_api_secret"
      }
    }
  }
}
```

## Example tool calls

**Generate a complete sheet from a prompt (LLM, no CSVBox API call):**

```json
// generate_sheet_json  (requires ANTHROPIC_API_KEY or OPENAI_API_KEY)
{ "prompt": "Create employee importer with name, email, salary, joining date; destination as testapi; allow only xlsx files" }
```

Returns `{ "sheet": { "title": ..., "sheet_columns": [...], "destinations": [...], "steps": {...} }, "source": "llm:anthropic:claude-haiku-4-5", "validation": { "valid": true, ... } }`. Data fields become columns (`salary → currency`, `joining date → date`); the destination and xlsx setting go to `destinations` / `steps`, not columns. With no LLM key, returns an error pointing to the `create_csvbox_sheet` prompt.

**Validate a schema before sending it:**

```json
// validate_schema
{ "sheet": { "title": "Customers", "sheet_columns": [
  { "column_name": "email", "display_label": "Email", "type": "email" }
] } }
```

Returns `{ "valid": true, "errors": [], "warnings": [ ... ] }`.

**Create a sheet:**

```json
// create_sheet
{ "sheet": { "title": "Customer Import", "sheet_columns": [
  { "column_name": "name", "display_label": "Name", "type": "text" },
  { "column_name": "email", "display_label": "Email", "type": "email" }
] } }
```

**Generate + create in one step:**

```json
// create_importer_from_prompt  (requires an LLM key + CSVBox credentials)
{ "prompt": "Create customer importer with name, email, phone; allow for example.com" }
```

Returns `{ "generated_schema": { ... }, "source": ..., "validation": { ... }, "api_response": { ... } }`. Aborts without calling the API if no LLM provider is configured or the generated schema fails validation.

**Replace a sheet:**

```json
// update_sheet
{ "sheet_license_key": "abc123", "sheet": { "title": "Updated", "sheet_columns": [ ... ] } }
```

> Destructive for any collection you send — see [PUT vs PATCH](#put-vs-patch--read-this-before-applying).

**Patch a sheet:**

```json
// patch_sheet
{ "sheet_license_key": "abc123", "changes": { "title": "New Title" } }
```

**Remove one function without touching the rest:**

```json
// patch_sheet
{ "sheet_license_key": "abc123",
  "changes": { "virtual_columns": [ { "column_name": "full_name", "_delete": true } ] } }
```

**Generate integration code:**

```json
// generate_import_code
{ "framework": "react" }
```

**Find and read an importer (no license key needed):**

```json
// list_sheets
{ "q": "contacts", "per_page": 5 }
```

Returns `{ "data": [{ "sheet_license_key": "...", "title": "Contacts", "columns_count": 8, ... }], "links": {...}, "meta": {...} }`. Pass the `sheet_license_key` (or numeric id) to `get_sheet` to read the full configuration before changing it.

**Find out why an import failed:**

```json
// list_imports
{ "status": "failed", "from": "2026-10-01", "per_page": 10 }
```

```json
// get_import_errors
{ "import_id": 9688 }
```

```json
{
  "import_id": 9688,
  "summary": {
    "status": "failed",
    "total_errors": 1,
    "likely_cause": "The destination did not accept the saved credentials or token. Reconnect or update the destination in the sheet settings. Recorded: Token \"54347db2-…\" not found",
    "causes": [{ "category": "destination_credentials", "hint": "…", "count": 1, "example": "…" }],
    "note": null,
    "external_validation": null
  },
  "errors": [{ "row": null, "column": null, "type": null, "category": "destination_credentials", "hint": "…", "message": "Token \"54347db2-…\" not found", "source": null }],
  "meta": { "current_page": 1, "last_page": 1, "per_page": 50, "total": 1 }
}
```

Read `summary.likely_cause` first, then the specific `errors[].row` / `column`. Categories include `destination_credentials`, `destination_url`, `destination_timeout`, `destination_rate_limited`, `destination_server_error`, `destination_database`, `file_worksheet`, `row_validation`, `external_validation_row`, `external_validation_table`, `destination_row`, `destination_table`, `internal_error` and `unknown`. An `unknown` category means the cause is not identified: the original message is returned as-is and no cause is guessed. If `total_errors` is 0, nothing was recorded for that import.

When the sheet's external validation rejects rows, the import can be `partial` with `failed_row_count: 0`: rejected rows still count as sent. `summary.external_validation` gives `rejected_rows` and `table_error`, and `summary.note` explains the count. The `debug_failed_import` prompt walks through this and proposes a `patch_sheet` fix without applying it.

**Check how many imports are left:**

```json
// get_usage
{}
```

Returns `{ "plan": "Plus", "billing_cycle": { "start": "...", "end": "..." }, "imports": { "used": 116, "limit": 10000, "remaining": 9884 }, "plans_url": "..." }`. On unlimited plans `limit` and `remaining` are `null`, not 0. `submit_file` consumes imports, so check this before a batch of test uploads.

**Build a test file from a sheet (valid rows plus deliberately invalid ones):**

```json
// generate_sample_csv
{ "sheet_license_key": "YOUR_SHEET_KEY", "valid_rows": 4, "invalid_rows": 3 }
```

Returns `{ "csv": "Name,Email,Plan\n...", "expected_failures": [{ "row": 5, "column": "name", "value": "", "reason": "required value is empty" }], "warnings": [...] }`. Rows count data rows after the header. List cells hold each entry's display label when it has one (otherwise its value), because that is what the importer accepts; a file carrying the raw value of a labelled entry is flagged invalid. Regex and dependent/dynamic list columns are left blank with a warning; `js_code` is never executed.

**Generate the backend half of a webhook integration:**

```json
// generate_webhook_handler
{ "framework": "express", "kind": "import_complete", "verify_signature": true }
```

Returns `{ "code": "...", "notes": [...] }`. Frameworks: `laravel`, `express`, `django`, `nextjs`. `kind` is `import_complete` (per-import summary) or `rows` (row data sent to an API-webhook destination). Signature verification applies only when signing is enabled on the destination.

## Supported column types

`text`, `number`, `email`, `date`, `time`, `boolean`, `regex`, `ip`, `url`, `credit_card`, `phone_number`, `currency`, `list`, `dependent_list`, `dynamic_list`, `dependent_dynamic_list`, `multiselect_list`, `multiselect_dynamic_list`.

## Development

```bash
npm run build   # compile TypeScript → dist/
npm start       # run the built server
npm run lint    # type-check without emitting
npm test        # compile and run the unit suite (alias: npm run test:unit)
```

### Tests

`npm test` compiles `src/tests/` and runs it with Node's built-in test runner — no
test framework, no mocking library.

The suite is **hermetic**. It never contacts an external host, never reads your
ambient `CSVBOX_API_*` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, and never touches
a real CSVBox account, so it passes identically whether or not you have
credentials configured. HTTP is intercepted at the axios adapter; the LLM is a
scripted fake; the one test that needs real request encoding starts an ephemeral
listener on `127.0.0.1` and closes it afterwards. Tests that read environment
variables set what they need explicitly and restore the previous values.

#### E2E tests

```bash
npm run test:e2e         # run the Playwright suite
npm run test:e2e:report  # open the HTML report from the last run
```

Specs live in `e2e/`, configured by `playwright.config.ts`. Like the unit suite,
this suite is **hermetic**: it starts mock CSVBox and LLM servers on loopback
(`e2e/support/mock-csvbox-server.ts`, `e2e/support/mock-llm-server.ts`) and
drives the real built server (`dist/index.js`) through MCP Inspector with
fake credentials pointed at those mocks — it never contacts a real CSVBox
account or LLM provider, and never reads your `.env`. A separate,
zero-credential Inspector instance covers the "missing credentials" error
paths. Requires `npm run build` first (the `test:e2e` webServer entries build
automatically).

### Embedding the server

`createServer()` is exported from the entry module. It registers every tool and
prompt and returns the `McpServer` **without** attaching a transport, so you can
connect it to one of your own:

```ts
import { createServer } from "@csvbox/mcp-server";

const server = createServer();
await server.connect(myTransport);
```

Importing the module does not start anything; the stdio server runs only when
`dist/index.js` is executed directly.

## License

MIT
