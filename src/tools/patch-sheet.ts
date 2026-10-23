import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { patchSheet } from "../services/csvbox-api.js";
import { respond } from "./respond.js";
import { guardedWrite } from "./guarded-write.js";

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
        "Partially update a CSVBox sheet via PATCH /1.1/sheet/{sheet_license_key}. Sends only the changes object. Input: { sheet_license_key, changes }. Returns the API response. PATCH MERGES: only the items you list are touched and nothing is deleted implicitly, so an empty array is a no-op. Items in virtual_columns, validation_functions and data_transforms are matched by column_name / function_name / transform_name respectively — an unmatched name creates a new item. To remove one, send it with `_delete: true`; every other field on a _delete item is ignored, including js_code. This is the safe verb for applying generated functions. COLUMNS ARE MERGED FIELD BY FIELD: a column named in sheet_columns needs only its column_name plus the fields to change; display_label, info_hint, default_value, required, read_only, matching_keywords and metadata.transforms change only when sent, and `validators` merge key by key (send a key as null to reset it to its default). Changing `type` resets validators to the new type's defaults, so send the validators you want with it. Everything not sent is kept, including settings the API cannot express. Columns you do not name are untouched, and a new column_name adds a column (send its full definition). This needs a CSVbox release that merges columns; on an older server a named column is replaced whole, so send its full object. Credential-like webhook header values come back from get_sheet as [redacted]; send them back unchanged and the stored values are kept. Call get_sheet first to read the current configuration, and run validate_schema with mode 'patch' before applying.",
      inputSchema: inputShape,
    },
    async ({ sheet_license_key, changes }) => {
      return respond(() => guardedWrite(sheet_license_key, changes, (body) => patchSheet(sheet_license_key, body)));
    }
  );
}
