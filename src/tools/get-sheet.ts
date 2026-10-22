import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSheet } from "../services/csvbox-api.js";
import { respond } from "./respond.js";

const inputShape = {
  sheet_license_key: z
    .string()
    .min(1)
    .describe("The sheet's license key (slug) or numeric sheet id."),
};

export function registerGetSheet(server: McpServer): void {
  server.registerTool(
    "get_sheet",
    {
      title: "Get CSVBox Sheet",
      description:
        "Fetch the full configuration of one CSVBox sheet via GET /1.1/sheet/{sheet_license_key}. Input: { sheet_license_key } (license key or sheet id; find it with list_sheets). Returns the sheet's columns, settings and destinations. Call this BEFORE patch_sheet or update_sheet so edits are based on the current configuration: update_sheet (PUT) deletes anything not sent. Read-only.",
      inputSchema: inputShape,
    },
    async ({ sheet_license_key }) => {
      return respond(() => getSheet(sheet_license_key));
    }
  );
}
