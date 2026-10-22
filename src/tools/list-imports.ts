import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listImports } from "../services/csvbox-api.js";
import { respond } from "./respond.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const inputShape = {
  sheet: z
    .string()
    .optional()
    .describe("Only imports for this sheet (license key or sheet id)."),
  status: z
    .enum(["success", "partial", "failed", "ongoing"])
    .optional()
    .describe("Only imports with this status."),
  from: z.string().regex(DATE).optional().describe("Earliest import date, YYYY-MM-DD."),
  to: z.string().regex(DATE).optional().describe("Latest import date, YYYY-MM-DD."),
  page: z.number().int().min(1).optional().describe("Page number, starting at 1."),
  per_page: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Imports per page. Defaults to 25; the API clamps it to 100."),
};

export function registerListImports(server: McpServer): void {
  server.registerTool(
    "list_imports",
    {
      title: "List CSVBox Imports",
      description:
        "List recent imports (file submissions) across the API key owner's sheets via GET /1.1/import, newest first. Input: { sheet?, status?, from?, to?, page?, per_page? }. Each item has import_id, sheet, status (success | partial | failed | ongoing), row_count, imported_row_count, failed_row_count, file_name, source, environment and created_at. Use it to answer \"did my imports work?\", then call get_import_errors for the reason a specific import failed. Read-only.",
      inputSchema: inputShape,
    },
    async (query) => respond(() => listImports(query))
  );
}
