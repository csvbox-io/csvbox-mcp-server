import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSheet } from "../services/csvbox-api.js";
import { respond } from "./respond.js";
import { refusePlaceholder } from "./guarded-write.js";

const inputShape = {
  sheet: z
    .record(z.string(), z.unknown())
    .describe("The full CSVBox sheet object to create."),
};

export function registerCreateSheet(server: McpServer): void {
  server.registerTool(
    "create_sheet",
    {
      title: "Create CSVBox Sheet",
      description:
        "Create a new CSVBox sheet via POST /1.1/sheet. Input: { sheet }. Returns the API response.",
      inputSchema: inputShape,
    },
    async ({ sheet }) => {
      return respond(async () => refusePlaceholder(sheet) ?? createSheet(sheet));
    }
  );
}
