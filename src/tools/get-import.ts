import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getImport } from "../services/csvbox-api.js";
import { respond } from "./respond.js";

export function registerGetImport(server: McpServer): void {
  server.registerTool(
    "get_import",
    {
      title: "Get CSVBox Import",
      description:
        "Fetch one import via GET /1.1/import/{import_id}: status, total / imported / failed row counts, file name, source and timestamps; a child chunk of a split upload carries parent_import_id (the master import), otherwise null. Input: { import_id } (from list_imports). Read-only.",
      inputSchema: {
        import_id: z.number().int().min(1).describe("The import id, from list_imports."),
      },
    },
    async ({ import_id }) => respond(() => getImport(import_id))
  );
}
