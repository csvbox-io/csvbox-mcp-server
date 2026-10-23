import { getSheet } from "../services/csvbox-api.js";
import type { ApiResult } from "../services/csvbox-api.js";
import { containsPlaceholder, restoreSecrets, REDACTED } from "../redact.js";

/**
 * Send a sheet write, first putting back the stored value of any masked webhook header.
 * With no placeholder in the body this is just `send(body)` (no extra GET); with one that cannot be
 * matched to a stored value nothing is sent.
 */
export async function guardedWrite(
  key: string,
  body: unknown,
  send: (body: any) => Promise<ApiResult>
): Promise<ApiResult> {
  if (!containsPlaceholder(body)) return send(body);

  const current = await getSheet(key);
  if (!current.ok) {
    return {
      ok: false,
      status: current.status,
      error: `The body holds the placeholder ${REDACTED}, but the sheet could not be read to restore the stored values: ${current.error}. Nothing was sent.`,
    };
  }

  const restored = restoreSecrets(body, current.data);
  if (!restored.ok) return { ok: false, status: null, error: restored.error };
  return send(restored.body);
}

/** A create has no stored sheet to restore from, so a placeholder can only be a mistake. */
export function refusePlaceholder(body: unknown): ApiResult | null {
  return containsPlaceholder(body)
    ? { ok: false, status: null, error: `The body holds the placeholder ${REDACTED}, which only marks a value hidden when reading a sheet. Send the real value or remove it. Nothing was sent.` }
    : null;
}
