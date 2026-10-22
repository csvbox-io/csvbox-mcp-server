import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * MCP prompt `debug_failed_import`: walks the host LLM from an import's recorded
 * errors to a concrete `patch_sheet` fix, using only read tools until the user agrees.
 */
export function registerDebugFailedImportPrompt(server: McpServer): void {
  server.registerPrompt(
    "debug_failed_import",
    {
      title: "Debug Failed Import",
      description:
        "Diagnose why a CSVBox import failed or partly failed and propose a sheet fix. Uses list_imports, get_import, get_import_errors and get_sheet; changes nothing until you approve a patch_sheet.",
      argsSchema: {
        import_id: z
          .string()
          .optional()
          .describe("The import id. Omit to start from the most recent failed import."),
      },
    },
    ({ import_id }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Help me understand why a CSVBox import failed, and how to fix it.

${
  import_id
    ? `The import id is ${import_id}.`
    : "I do not have an import id: call `list_imports` with status \"failed\" (then \"partial\" if there are none) and take the most recent."
}

Steps:
1. Call \`get_import\` for the import and report its status and how many rows were imported versus failed.
2. Call \`get_import_errors\` and read every page you need. Start from \`summary.likely_cause\` and \`summary.causes\`, and report \`summary.note\` when it is set (it explains cases such as a partial import with zero failed rows). If \`total_errors\` is 0, say plainly that no cause was recorded instead of guessing.
3. Give the cause in plain words, then list the specific rows and columns from \`errors\`. Use each error's \`category\` and \`hint\` as stated; a category of "unknown" means the cause is not identified, so quote the message and say so. Do not invent causes the errors do not support.
4. Call \`get_sheet\` for the import's sheet and compare the configuration with the errors.
5. If the fix is a change to the sheet (a validator that is too strict, a missing column, a wrong type), show the exact \`patch_sheet\` \`changes\` object and run \`validate_schema\` with mode "patch" on it. If the cause is in the user's file or destination, say what to change there instead.
6. Do NOT call \`patch_sheet\` or \`update_sheet\` until I approve the change.`,
          },
        },
      ],
    })
  );
}
