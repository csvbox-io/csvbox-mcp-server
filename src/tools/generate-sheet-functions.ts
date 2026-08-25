import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { generateFunctionsSmart } from "../prompts/functions-generator.js";

const inputShape = {
  prompt: z
    .string()
    .min(1)
    .describe(
      'Natural-language description of the functions to author, e.g. "add a virtual column joining first and last name, and validate that every email contains an @".'
    ),
  sheet: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "The existing sheet the functions will be applied to. Supplying it lets the model reference real column names and lets validation check those references. CSVBox exposes no read endpoint, so this must be passed inline."
    ),
};

export function registerGenerateSheetFunctions(server: McpServer): void {
  server.registerTool(
    "generate_sheet_functions",
    {
      title: "Generate CSVBox Sheet Functions",
      description:
        "Author CSVBox virtual_columns, validation_functions, and data_transforms from a natural-language prompt using a configured LLM. Does NOT call the CSVBox API — it returns JSON so you can REVIEW the generated JavaScript before applying it with patch_sheet. Collections the request does not imply are omitted, never returned as empty arrays. Returns { virtual_columns?, validation_functions?, data_transforms?, source, validation }. Requires ANTHROPIC_API_KEY or OPENAI_API_KEY; without one it returns an error pointing to the csvbox_sheet_functions MCP prompt. Input: { prompt, sheet? }.",
      inputSchema: inputShape,
    },
    async ({ prompt, sheet }) => {
      try {
        const result = await generateFunctionsSmart(prompt, sheet);

        if (!result.ok) {
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ...result.functions,
                  source: result.source,
                  validation: result.validation,
                },
                null,
                2
              ),
            },
          ],
          isError: !result.validation.valid,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { error: err instanceof Error ? err.message : String(err) },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
