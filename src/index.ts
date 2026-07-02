#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerCreateSheet } from "./tools/create-sheet.js";
import { registerUpdateSheet } from "./tools/update-sheet.js";
import { registerPatchSheet } from "./tools/patch-sheet.js";
import { registerGenerateSheetJson } from "./tools/generate-sheet-json.js";
import { registerCreateImporterFromPrompt } from "./tools/create-importer-from-prompt.js";
import { registerGenerateImportCode } from "./tools/generate-import-code.js";
import { registerValidateSchema } from "./tools/validate-schema.js";
import { registerSubmitFile } from "./tools/submit-file.js";
import { registerCsvboxSheetPrompt } from "./prompts/csvbox-sheet-prompt.js";

async function main(): Promise<void> {
  const server = new McpServer({
    name: "csvbox-mcp-server",
    version: "1.0.0",
  });

  // Register all 8 tools. No GET/LIST/read tools — CSVBox exposes none.
  registerCreateSheet(server);
  registerUpdateSheet(server);
  registerPatchSheet(server);
  registerGenerateSheetJson(server);
  registerCreateImporterFromPrompt(server);
  registerGenerateImportCode(server);
  registerValidateSchema(server);
  registerSubmitFile(server);

  // MCP prompt — lets host LLMs build sheet JSON with no server-side LLM key.
  registerCsvboxSheetPrompt(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stderr only — stdout is reserved for the MCP protocol stream.
  console.error("csvbox-mcp-server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error starting csvbox-mcp-server:", err);
  process.exit(1);
});
