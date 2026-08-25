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
        "Partially update a CSVBox sheet via PATCH /1.1/sheet/{sheet_license_key}. Sends only the changes object. Input: { sheet_license_key, changes }. Returns the API response. PATCH MERGES: only the items you list are touched and nothing is deleted implicitly, so an empty array is a no-op. Items in virtual_columns, validation_functions and data_transforms are matched by column_name / function_name / transform_name respectively — an unmatched name creates a new item. To remove one, send it with `_delete: true`; every other field on a _delete item is ignored, including js_code. This is the safe verb for applying generated functions. Run validate_schema with mode 'patch' first.",
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
