import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { submitFile } from "../services/csvbox-api.js";

const optionsShape = z
  .object({
    has_header: z.number().optional(),
    max_rows: z.number().optional(),
    auto_map: z.boolean().optional(),
  })
  .passthrough()
  .optional();

const inputShape = {
  sheet_license_key: z
    .string()
    .min(1)
    .describe("The license key of the sheet to import into."),
  public_file_url: z
    .string()
    .optional()
    .describe(
      "Public URL of the file to import. Mutually exclusive with file_base64."
    ),
  file_base64: z
    .string()
    .optional()
    .describe(
      "Base64-encoded file content for direct upload. This is an MCP-transport-only encoding: the server decodes it into raw bytes and sends CSVBox a true multipart/form-data 'file' part, never a base64 string. Mutually exclusive with public_file_url. Requires file_name. Prefer public_file_url for large files."
    ),
  file_name: z
    .string()
    .optional()
    .describe("File name for the direct upload. Required with file_base64."),
  file_sheet_name: z
    .string()
    .optional()
    .describe("Worksheet name to import, for multi-tab files."),
  user: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Custom user reference object attached to the import."),
  options: optionsShape.describe(
    "Import options: has_header (0/1), max_rows, auto_map."
  ),
  dynamic_columns: z
    .array(z.unknown())
    .optional()
    .describe("Dynamic column definitions with validators."),
};

function errorResult(message: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ok: false, error: message }, null, 2),
      },
    ],
    isError: true,
  };
}

export function registerSubmitFile(server: McpServer): void {
  server.registerTool(
    "submit_file",
    {
      title: "Submit File via CSVBox REST File API",
      description:
        "Submit a file for import via POST /1.1/file. Provide exactly one of public_file_url (JSON submission) or file_base64 + file_name (multipart direct upload — file_base64 is decoded server-side and sent to CSVBox as true binary multipart content, never as a base64 string). Input: { sheet_license_key, public_file_url? | (file_base64?, file_name?), file_sheet_name?, user?, options?, dynamic_columns? }. Returns the API response.",
      inputSchema: inputShape,
    },
    async ({
      sheet_license_key,
      public_file_url,
      file_base64,
      file_name,
      file_sheet_name,
      user,
      options,
      dynamic_columns,
    }) => {
      const hasUrl = public_file_url !== undefined;
      const hasUpload = file_base64 !== undefined;

      if (hasUrl && hasUpload) {
        return errorResult(
          "Provide exactly one of public_file_url or file_base64, not both."
        );
      }
      if (!hasUrl && !hasUpload) {
        return errorResult(
          "Provide exactly one of public_file_url or file_base64."
        );
      }
      if (hasUpload && !file_name) {
        return errorResult("file_name is required when using file_base64.");
      }

      const importFields: Record<string, unknown> = {
        sheet_license_key,
        ...(file_sheet_name !== undefined && { file_sheet_name }),
        ...(user !== undefined && { user }),
        ...(options !== undefined && { options }),
        ...(dynamic_columns !== undefined && { dynamic_columns }),
      };

      try {
        const result = hasUrl
          ? await submitFile({
              kind: "url",
              import: { ...importFields, public_file_url },
            })
          : await submitFile({
              kind: "upload",
              import: importFields,
              fileName: file_name!,
              fileContent: Buffer.from(file_base64!, "base64"),
            });

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: !result.ok,
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
