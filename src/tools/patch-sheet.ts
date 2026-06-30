import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { patchSheet } from "../services/csvbox-api.js";

const inputShape = {
  sheet_license_key: z
    .string()
    .min(1)
    .describe("The license key of the sheet to patch."),
  changes: z
    .record(z.string(), z.unknown())
    .describe("Only the partial changes to apply to the sheet."),
};

export function registerPatchSheet(server: McpServer): void {
  server.registerTool(
    "patch_sheet",
    {
      title: "Patch CSVBox Sheet",
      description:
        "Partially update a CSVBox sheet via PATCH /1.1/sheet/{sheet_license_key}. Sends only the changes object. Input: { sheet_license_key, changes }. Returns the API response.",
      inputSchema: inputShape,
    },
    async ({ sheet_license_key, changes }) => {
      try {
        const result = await patchSheet(sheet_license_key, changes);
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
