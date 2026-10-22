import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listSheets } from "../services/csvbox-api.js";
import { respond } from "./respond.js";

const inputShape = {
  q: z
    .string()
    .optional()
    .describe("Optional title search (substring match), e.g. \"contacts\"."),
  page: z.number().int().min(1).optional().describe("Page number, starting at 1."),
  per_page: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Sheets per page. Defaults to 20; the API clamps it to 100."),
};

export function registerListSheets(server: McpServer): void {
  server.registerTool(
    "list_sheets",
    {
      title: "List CSVBox Sheets",
      description:
        "List the CSVBox sheets (importers) owned by the API key via GET /1.1/sheet. Input: { q?, page?, per_page? }. Use q to find a sheet by title, then pass its license key (slug) to get_sheet, patch_sheet or update_sheet. Returns { data, links, meta } with a summary per sheet; follow meta.last_page / links.next for more pages. Read-only.",
      inputSchema: inputShape,
    },
    async ({ q, page, per_page }) => {
      return respond(() => listSheets({ q, page, per_page }));
    }
  );
}
