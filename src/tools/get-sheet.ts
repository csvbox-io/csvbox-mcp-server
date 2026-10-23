import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSheet } from "../services/csvbox-api.js";
import { respond } from "./respond.js";
import { maskSecrets } from "../redact.js";

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
        "Fetch the full configuration of one CSVBox sheet via GET /1.1/sheet/{sheet_license_key}. Input: { sheet_license_key } (license key or sheet id; find it with list_sheets). Returns the sheet's columns, settings and destinations. Call this BEFORE patch_sheet or update_sheet so edits are based on the current configuration: update_sheet (PUT) deletes anything not sent. Credential-like values (webhook header values such as Authorization or x-api-key) are shown as [redacted]; send them back unchanged in patch_sheet or update_sheet and the stored values are kept. Read-only.",
      inputSchema: inputShape,
    },
    async ({ sheet_license_key }) => {
      return respond(async () => {
        const result = await getSheet(sheet_license_key);
        return result.ok ? { ...result, data: maskSecrets(result.data) } : result;
      });
    }
  );
}
