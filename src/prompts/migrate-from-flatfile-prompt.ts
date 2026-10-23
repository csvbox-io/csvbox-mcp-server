import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SHEET_PROMPT_INTRO, SHEET_SCHEMA_RULES } from "./sheet-system-prompt.js";

/**
 * MCP prompt `migrate_from_flatfile`: the host LLM converts a pasted Flatfile or
 * OneSchema config into a CSVBox sheet, reports what could not be mapped, and
 * asks before creating anything.
 */
export function registerMigrateFromFlatfilePrompt(server: McpServer): void {
  server.registerPrompt(
    "migrate_from_flatfile",
    {
      title: "Migrate From Flatfile or OneSchema",
      description:
        "Convert a pasted Flatfile blueprint or OneSchema template into a CSVBox sheet definition, validate it, and create it only after you confirm.",
      argsSchema: {
        config: z
          .string()
          .describe("The Flatfile blueprint / sheet config or OneSchema template, pasted as-is."),
      },
    },
    ({ config }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `${SHEET_PROMPT_INTRO}

${SHEET_SCHEMA_RULES}

## Task
Convert the importer configuration below (Flatfile or OneSchema) into a CSVBox sheet.

Rules:
- Map each field to the closest CSVBox column type and validators. Keep field keys as \`column_name\` and labels as \`display_label\`.
- Map required, unique, enum / select options, regex, min / max and length constraints to the matching CSVBox validators where one exists.
- Do not translate custom code, hooks or computed fields into \`js_code\`. List them as "not migrated".

## Output
Reply in this order:
1. Build the sheet JSON, call \`validate_schema\` on it, and fix any errors.
2. Show me a short report with two lists: "Mapped" and "Could not map" (with the reason for each).
3. Show me the validated JSON, then ask for confirmation.
Do NOT call \`create_sheet\` until I confirm.

## Source configuration
${config}`,
          },
        },
      ],
    })
  );
}
