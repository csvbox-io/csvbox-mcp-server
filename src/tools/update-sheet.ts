import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { updateSheet } from "../services/csvbox-api.js";

const inputShape = {
  sheet_license_key: z
    .string()
    .min(1)
    .describe("The license key of the sheet to replace."),
  sheet: z
    .record(z.string(), z.unknown())
    .describe("The full replacement CSVBox sheet object."),
};

export function registerUpdateSheet(server: McpServer): void {
  server.registerTool(
    "update_sheet",
    {
      title: "Update (Replace) CSVBox Sheet",
      description:
        "Replace an existing CSVBox sheet via PUT /1.1/sheet/{sheet_license_key}. Input: { sheet_license_key, sheet }. Returns the API response.",
      inputSchema: inputShape,
    },
    async ({ sheet_license_key, sheet }) => {
      try {
        const result = await updateSheet(sheet_license_key, sheet);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: !result.ok,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ok: false, error: err instanceof Error ? err.message : String(err) },
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
