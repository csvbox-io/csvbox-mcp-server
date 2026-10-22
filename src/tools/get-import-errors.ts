import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getImportErrors } from "../services/csvbox-api.js";
import { respond } from "./respond.js";

export function registerGetImportErrors(server: McpServer): void {
  server.registerTool(
    "get_import_errors",
    {
      title: "Get CSVBox Import Errors",
      description:
        "Fetch the recorded failures for one import via GET /1.1/import/{import_id}/errors. Input: { import_id, page?, per_page? }. Returns { summary: { status, total_errors, likely_cause, causes: [{ category, hint, count, example }], note, external_validation }, errors: [{ row, column, type, category, hint, message, source }], meta }. When asked why an import failed, answer from summary.likely_cause first, then give the specific rows and columns from errors; never paraphrase a cause that the response does not state. A destination's per-cell errors are already expanded into one error per row and column. summary.external_validation (null unless the sheet's external validation failed) gives rejected_rows and table_error: those rows still count as sent, so failed_row_count does not include them. summary.note flags cases a count alone would mislead (for example a partial import whose failed_row_count is 0 because every row was sent). If total_errors is 0 the import has no recorded cause: say so instead of guessing. Then suggest a fix with get_sheet + patch_sheet (or the debug_failed_import prompt). Read-only.",
      inputSchema: {
        import_id: z.number().int().min(1).describe("The import id, from list_imports."),
        page: z.number().int().min(1).optional().describe("Page number, starting at 1."),
        per_page: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Errors per page. Defaults to 50; the API clamps it to 200."),
      },
    },
    async ({ import_id, page, per_page }) =>
      respond(() => getImportErrors(import_id, { page, per_page }))
  );
}
