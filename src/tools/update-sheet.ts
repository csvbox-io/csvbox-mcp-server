import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { updateSheet } from "../services/csvbox-api.js";
import { respond } from "./respond.js";
import { guardedWrite } from "./guarded-write.js";

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
        "Replace an existing CSVBox sheet via PUT /1.1/sheet/{sheet_license_key}. Input: { sheet_license_key, sheet }. Returns the API response. DESTRUCTIVE: PUT is authoritative for every collection it sends — items listed are created or updated in place, and any existing item the array does not name is DELETED. This applies to virtual_columns, validation_functions and data_transforms: sending an empty array DELETES ALL of that collection's items, while OMITTING the key leaves them untouched. `_delete` is not valid here; use patch_sheet to remove a single item. Call get_sheet first so you do not drop existing items, and run validate_schema with mode 'put' to catch a destructive body. Credential-like webhook header values come back from get_sheet as [redacted]; send them back unchanged and the stored values are kept. Do not send a get_sheet response back unchanged: it can carry duplicate column positions and empty collections that a PUT would apply as deletions.",
      inputSchema: inputShape,
    },
    async ({ sheet_license_key, sheet }) => {
      return respond(() => guardedWrite(sheet_license_key, sheet, (body) => updateSheet(sheet_license_key, body)));
    }
  );
}
