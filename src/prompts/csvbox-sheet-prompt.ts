import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SHEET_SYSTEM_PROMPT } from "./sheet-system-prompt.js";

/**
 * MCP prompt `create_csvbox_sheet`.
 *
 * Tier 2 of the generation strategy: exposes the shared schema guide so a HOST
 * LLM (Cursor, Claude Desktop, Cline) builds the sheet JSON with no server-side
 * API key. The host model does the work; this server only supplies the prompt.
 * MCP Inspector can render the prompt but has no model to execute it.
 */
export function registerCsvboxSheetPrompt(server: McpServer): void {
  server.registerPrompt(
    "create_csvbox_sheet",
    {
      title: "Create CSVBox Sheet",
      description:
        "Convert a natural-language request into a complete CSVBox sheet (title, sheet_columns, destinations, webhooks, security_settings, steps). Returns guidance for the host LLM; no server-side API key required.",
      argsSchema: {
        request: z
          .string()
          .describe("Natural-language description of the importer to build."),
      },
    },
    ({ request }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `${SHEET_SYSTEM_PROMPT}\n\n## User request\n${request}\n\nAfter producing the JSON, call the \`validate_schema\` tool with it, then \`create_sheet\` to create the importer in CSVBox.`,
          },
        },
      ],
    })
  );
}
