import type { ApiResult } from "../services/csvbox-api.js";

/** Standard MCP result for an API-backed tool: the normalized result as JSON text. */
export async function respond(call: () => Promise<ApiResult>) {
  try {
    const result = await call();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      isError: !result.ok,
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
}

/** Standard MCP result for a local (no API call) tool. */
export function json(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    isError,
  };
}
