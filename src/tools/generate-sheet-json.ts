import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { generateSheetSmart } from "../prompts/schema-generator.js";

const inputShape = {
  prompt: z
    .string()
    .min(1)
    .describe(
      'Natural-language description of the importer, e.g. "Create employee importer with columns name, email, salary, joining date; destination as testapi; allow only xlsx files".'
    ),
};

export function registerGenerateSheetJson(server: McpServer): void {
  server.registerTool(
    "generate_sheet_json",
    {
      title: "Generate CSVBox Sheet JSON",
      description:
        "Generate a COMPLETE CSVBox sheet (title, sheet_columns, destinations, webhooks, security_settings, steps) from a natural-language prompt using a configured LLM. Does NOT call the CSVBox API. Returns { sheet, source, validation }. Requires ANTHROPIC_API_KEY or OPENAI_API_KEY; without one it returns an error pointing to the create_csvbox_sheet MCP prompt. Input: { prompt }.",
      inputSchema: inputShape,
    },
    async ({ prompt }) => {
      try {
        const result = await generateSheetSmart(prompt);

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
                  sheet: result.sheet,
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
