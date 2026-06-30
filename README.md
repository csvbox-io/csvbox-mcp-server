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
| `validate_schema` | Local schema validation | none |

> CSVBox currently has **no GET or LIST endpoints**, so there are intentionally no `get_sheet` / `list_sheet` tools.

It also exposes one **MCP prompt**:

| Prompt | Purpose |
| --- | --- |
| `create_csvbox_sheet` | Make the host client's own LLM build a complete CSVBox sheet (no server-side LLM key needed). |

### Prompt → sheet generation

`generate_sheet_json` and `create_importer_from_prompt` use an LLM to convert a free-form request into a **complete** CSVBox sheet — `title`, `sheet_columns`, `destinations`, `webhooks`, `security_settings`, and `steps`. Only actual data fields become columns; destinations, webhooks, domains, regions, file-upload and step settings are placed in their proper configuration sections, never turned into columns. There are three tiers:

1. **Server LLM** — when `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set, the server calls the LLM directly. Works in MCP Inspector and headless.
2. **MCP prompt** (`create_csvbox_sheet`) — when you have no server key, host clients (Cursor, Claude Desktop, Cline) run the generation with their own model, then call `validate_schema` and `create_sheet`. Free.
3. **None configured** — `generate_sheet_json` returns a structured "no LLM provider configured" error pointing to the MCP prompt, and `create_importer_from_prompt` does not call the CSVBox API. There is **no** regex fallback.

## Installation

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

`LLM_PROVIDER` disambiguates when both keys are present; `LLM_MODEL` overrides the model for whichever provider is chosen.

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

In every client below, set `CSVBOX_API_KEY` / `CSVBOX_API_SECRET` in the `env` block and point the command at the built `dist/index.js` (use an absolute path).

### Claude Desktop

Edit `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "csvbox": {
      "command": "node",
      "args": ["/absolute/path/to/csvbox-mcp-server/dist/index.js"],
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
      "command": "node",
      "args": ["/absolute/path/to/csvbox-mcp-server/dist/index.js"],
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
      "command": "node",
      "args": ["/absolute/path/to/csvbox-mcp-server/dist/index.js"],
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
      "command": "node",
      "args": ["/absolute/path/to/csvbox-mcp-server/dist/index.js"],
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
      "command": "node",
      "args": ["/absolute/path/to/csvbox-mcp-server/dist/index.js"],
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
      "command": "node",
      "args": ["/absolute/path/to/csvbox-mcp-server/dist/index.js"],
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

**Patch a sheet:**

```json
// patch_sheet
{ "sheet_license_key": "abc123", "changes": { "title": "New Title" } }
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
```

## License

MIT
