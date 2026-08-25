import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FUNCTIONS_SYSTEM_PROMPT } from "./functions-system-prompt.js";

/**
 * MCP prompt `csvbox_sheet_functions`.
 *
 * Host-LLM counterpart to the `generate_sheet_functions` tool: serves the same
 * shared authoring guide so a client with no server-side API key can produce
 * virtual_columns / validation_functions / data_transforms itself. The host
 * model does the work; this server only supplies the prompt.
 */
export function registerCsvboxFunctionsPrompt(server: McpServer): void {
  server.registerPrompt(
    "csvbox_sheet_functions",
    {
      title: "Author CSVBox Sheet Functions",
      description:
        "Convert a natural-language request into CSVBox virtual_columns, validation_functions, and data_transforms. Returns guidance for the host LLM; no server-side API key required.",
      argsSchema: {
        request: z
          .string()
          .describe("Natural-language description of the functions to author."),
        sheet: z
          .string()
          .optional()
          .describe(
            "Optional JSON of the existing sheet, so generated functions reference real column names."
          ),
      },
    },
    ({ request, sheet }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `${FUNCTIONS_SYSTEM_PROMPT}\n\n## Existing sheet\n${
              sheet && sheet.length > 0
                ? sheet
                : "Not supplied. Reference only column names the request names explicitly, and do not invent others."
            }\n\n## User request\n${request}\n\nAfter producing the JSON, call the \`validate_schema\` tool with it and \`mode\` set to \`"patch"\`. Show the generated js_code to the user for review, then apply it with \`patch_sheet\` — never with \`update_sheet\`, which would replace the whole sheet.`,
          },
        },
      ],
    })
  );
}
