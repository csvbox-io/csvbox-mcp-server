#!/usr/bin/env node
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { VERSION } from "./version.js";

import { registerCreateSheet } from "./tools/create-sheet.js";
import { registerUpdateSheet } from "./tools/update-sheet.js";
import { registerPatchSheet } from "./tools/patch-sheet.js";
import { registerGenerateSheetJson } from "./tools/generate-sheet-json.js";
import { registerCreateImporterFromPrompt } from "./tools/create-importer-from-prompt.js";
import { registerGenerateImportCode } from "./tools/generate-import-code.js";
import { registerGenerateSheetFunctions } from "./tools/generate-sheet-functions.js";
import { registerValidateSchema } from "./tools/validate-schema.js";
import { registerSubmitFile } from "./tools/submit-file.js";
import { registerCsvboxSheetPrompt } from "./prompts/csvbox-sheet-prompt.js";
import { registerCsvboxFunctionsPrompt } from "./prompts/csvbox-functions-prompt.js";

/**
 * Build a fully registered server without attaching a transport.
 *
 * Registration reads no credentials and performs no I/O, so this is safe to
 * call in-process — tests drive it over an in-memory transport, and an
 * embedding host can connect it to a transport of its own. Each call returns
 * an independent instance.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "csvbox-mcp-server",
    version: VERSION,
  });

  // Register all 9 tools. No GET/LIST/read tools — CSVBox exposes none.
  registerCreateSheet(server);
  registerUpdateSheet(server);
  registerPatchSheet(server);
  registerGenerateSheetJson(server);
  registerCreateImporterFromPrompt(server);
  registerGenerateImportCode(server);
  registerGenerateSheetFunctions(server);
  registerValidateSchema(server);
  registerSubmitFile(server);

  // MCP prompts — let host LLMs do the generation with no server-side LLM key.
  registerCsvboxSheetPrompt(server);
  registerCsvboxFunctionsPrompt(server);

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stderr only — stdout is reserved for the MCP protocol stream.
  console.error("csvbox-mcp-server running on stdio");
}

/**
 * Only start a server when this file is the process entry point. Importing it
 * as a library (tests, embedders) must not connect a transport.
 */
const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((err) => {
    console.error("Fatal error starting csvbox-mcp-server:", err);
    process.exit(1);
  });
}
