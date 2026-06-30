import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { generateSheetSmart } from "../prompts/schema-generator.js";
import { createSheet } from "../services/csvbox-api.js";

const inputShape = {
  prompt: z
    .string()
    .min(1)
    .describe(
      'Natural-language description of the importer, e.g. "Create customer importer with columns name, email, phone; allow for example.com".'
    ),
};

export function registerCreateImporterFromPrompt(server: McpServer): void {
  server.registerTool(
    "create_importer_from_prompt",
    {
      title: "Create Importer From Prompt",
      description:
        "Generate a COMPLETE CSVBox sheet from a natural-language prompt via a configured LLM, validate it locally, then create it via POST /1.1/sheet. Returns { generated_schema, source, validation, api_response }. Aborts (no API call) if no LLM provider is configured or if validation fails. Requires ANTHROPIC_API_KEY or OPENAI_API_KEY plus CSVBox credentials.",
      inputSchema: inputShape,
    },
    async ({ prompt }) => {
      try {
        const result = await generateSheetSmart(prompt);

        // No provider / unparseable output -> never touch the API.
        if (!result.ok) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { ...result, api_response: null },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }

        // Generated but invalid -> never touch the API.
        if (!result.validation.valid) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    generated_schema: result.sheet,
                    source: result.source,
                    validation: result.validation,
                    api_response: null,
                    error: "Generated schema failed validation; API was not called.",
                  },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }

        const api_response = await createSheet(result.sheet);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  generated_schema: result.sheet,
                  source: result.source,
                  validation: result.validation,
                  api_response,
                },
                null,
                2
              ),
            },
          ],
          isError: !api_response.ok,
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
