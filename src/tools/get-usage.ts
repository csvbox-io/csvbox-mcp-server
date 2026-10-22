import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getUsage } from "../services/csvbox-api.js";
import { respond } from "./respond.js";

export function registerGetUsage(server: McpServer): void {
  server.registerTool(
    "get_usage",
    {
      title: "Get CSVBox Usage",
      description:
        "Report the account's plan and import usage for the current billing cycle via GET /1.1/account/usage. Input: none. Returns { plan, billing_cycle: { start, end }, imports: { used, limit, remaining }, plans_url }. limit and remaining are null on unlimited plans (never read null as zero). submit_file consumes imports, so check this before a batch of test uploads. Read-only; plan changes happen at plans_url.",
      inputSchema: {},
    },
    async () => respond(() => getUsage())
  );
}
