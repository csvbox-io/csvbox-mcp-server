import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSheet } from "../services/csvbox-api.js";
import { COLUMN_TYPES } from "../schemas/csvbox-schemas.js";
import { KIND_NOTES, SIGNATURE_NOTES } from "../tools/generate-webhook-handler.js";

const SECRET_KEY = /secret|password|passwd|token|credential|api[_-]?key|signing/i;

/** Drop anything credential-shaped before a sheet configuration becomes model context. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !SECRET_KEY.test(k))
        .map(([k, v]) => [k, redactSecrets(v)])
    );
  }
  return value;
}

export function registerResources(server: McpServer): void {
  server.registerResource(
    "sheet",
    new ResourceTemplate("csvbox://sheets/{key}", { list: undefined }),
    {
      title: "CSVBox sheet configuration",
      description:
        "The configuration of one sheet the API key owns, addressed by license key or sheet id. Credential-like fields are removed.",
      mimeType: "application/json",
    },
    async (uri, { key }) => {
      const result = await getSheet(String(key));
      if (!result.ok) {
        throw new Error(
          `Could not read sheet "${key}": ${result.error}${result.status ? ` (HTTP ${result.status})` : ""}`
        );
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(redactSecrets(result.data), null, 2),
          },
        ],
      };
    }
  );

  server.registerResource(
    "column-types",
    "csvbox://docs/column-types",
    {
      title: "CSVBox column types",
      description: "The column types a sheet accepts.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: `# CSVBox column types\n\n${COLUMN_TYPES.map((t) => `- \`${t}\``).join("\n")}\n\nValidate a sheet with the \`validate_schema\` tool before creating or updating it.`,
        },
      ],
    })
  );

  server.registerResource(
    "webhook-payload",
    "csvbox://docs/webhook-payload",
    {
      title: "CSVBox webhook payloads",
      description: "What CSVBox sends to your webhook and how to verify it.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: `# CSVBox webhooks\n\n## Import complete\n${KIND_NOTES.import_complete.join("\n")}\n\n## Row data\n${KIND_NOTES.rows.join("\n")}\n\n## Signing\n${SIGNATURE_NOTES.map((n) => `- ${n}`).join("\n")}\n\nUse \`generate_webhook_handler\` for ready-made handler code.`,
        },
      ],
    })
  );
}
