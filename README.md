# csvbox-mcp-server

A universal [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for [CSVBox](https://csvbox.io). It exposes CSVBox importer-sheet management as MCP tools so you can create, replace, patch, generate, validate, and scaffold importers from any MCP-compatible client — Claude Desktop, Cursor, Windsurf, Roo Code, Cline, VS Code, ChatGPT MCP, and more.

Runs over **stdio**, so it works the same way in every client.

## Tools

| Tool | Purpose | API call |
| --- | --- | --- |
| `create_sheet` | Create a CSVBox sheet | `POST /1.1/sheet` |
| `update_sheet` | Replace an existing sheet | `PUT /1.1/sheet/{key}` |
| `patch_sheet` | Partially update a sheet | `PATCH /1.1/sheet/{key}` |
| `generate_sheet_json` | NL prompt → complete sheet JSON (via LLM) | none (calls LLM) |
| `create_importer_from_prompt` | NL prompt → validate → create | `POST /1.1/sheet` (+ LLM) |
| `generate_import_code` | Integration code (vanilla-js/react/vue/angular) | none |
| `generate_sheet_functions` | NL prompt → virtual columns / validation functions / data transforms (via LLM) | none (calls LLM) |
| `validate_schema` | Local schema validation | none |

> CSVBox currently has **no GET or LIST endpoints**, so there are intentionally no `get_sheet` / `list_sheet` tools.

It also exposes two **MCP prompts**:

| Prompt | Purpose |
| --- | --- |
| `create_csvbox_sheet` | Make the host client's own LLM build a complete CSVBox sheet (no server-side LLM key needed). |
| `csvbox_sheet_functions` | Make the host client's own LLM author virtual columns, validation functions, and data transforms (no server-side LLM key needed). |

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
| Dropdown / status / category with fixed options | `list` | `values: [...]` candidate options |
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

This tool **does not call the CSVBox API**. Read the generated `js_code`, then apply it yourself with `patch_sheet`. Pass `sheet` so the model references real column names and the validator can check those references — CSVBox has no read endpoint, so it must be supplied inline. Without an LLM key, use the `csvbox_sheet_functions` MCP prompt instead.

### PUT vs PATCH — read this before applying

| | `update_sheet` (PUT) | `patch_sheet` (PATCH) |
| --- | --- | --- |
| Collection you send | **authoritative** — any existing item not named is **deleted** | **merged** — unnamed items are left alone |
| `"virtual_columns": []` | **deletes all 20** | no-op |
| Key omitted | untouched | untouched |
| `_delete: true` | not valid | removes that item (all its other fields ignored) |

Use `patch_sheet` to apply generated functions. Validate first with the matching verb:

```json
// validate_schema
{ "sheet": { "data_transforms": [ ... ] }, "mode": "patch" }
```

`mode` is `create` (default), `put`, or `patch`. It only affects the function collections — under `put` an empty array is a hard error rather than a warning, and `_delete` is rejected outside `patch`.

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

CSVBox credentials are **only** required for the API-backed tools (`create_sheet`, `update_sheet`, `patch_sheet`, `create_importer_from_prompt`). `validate_schema` and `generate_import_code` work without any credentials.

> **Auth header note:** the client sends `x-csvbox-api-key` and `x-csvbox-secret-api-key` (matching the CSVBox reference payloads). These are defined as constants in `src/services/csvbox-api.ts` if your account uses different header names.

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
