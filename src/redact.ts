/**
 * Masking of credential-like values in sheet configurations before they become model context, and
 * the reverse on write, so a masked body sent back never overwrites a stored secret.
 *
 * The sheet GET returns no destination credentials; the secret-bearing field is
 * `webhooks[].import_complete.custom_headers`, a list of `{ key, value }` pairs. The value of such a
 * pair is masked by the header's name. Any other string under a credential-named key is masked as well.
 * Keys are never removed, and booleans, numbers, nulls and empty strings are never touched, so a flag
 * such as `signing_enabled` survives.
 */

export const REDACTED = "[redacted]";

const CREDENTIAL_KEY = /secret|password|passwd|credential|api[_-]?key|token|signing[_-]?(key|secret)/i;
const HEADER_NAME = new RegExp(`${CREDENTIAL_KEY.source}|authori[sz]ation|cookie|signature|\\bkey\\b|auth`, "i");

type Json = unknown;

function isObject(value: Json): value is Record<string, Json> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isHeaderPair(value: Json): value is { key: string; value: Json } {
  return isObject(value) && typeof value.key === "string" && "value" in value;
}

function isMaskable(value: Json): value is string {
  return typeof value === "string" && value !== "" && value !== REDACTED;
}

/** A copy of `value` with credential-like strings replaced by the placeholder. */
export function maskSecrets(value: Json): Json {
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (!isObject(value)) return value;

  if (isHeaderPair(value) && HEADER_NAME.test(value.key) && isMaskable(value.value)) {
    return { ...value, value: REDACTED };
  }

  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, CREDENTIAL_KEY.test(k) && isMaskable(v) ? REDACTED : maskSecrets(v)])
  );
}

function storedHeaders(stored: Json, into: Map<string, string>): Map<string, string> {
  if (Array.isArray(stored)) {
    stored.forEach((item) => storedHeaders(item, into));
  } else if (isObject(stored)) {
    if (isHeaderPair(stored) && typeof stored.value === "string" && !into.has(stored.key.toLowerCase())) {
      into.set(stored.key.toLowerCase(), stored.value);
    }
    Object.values(stored).forEach((v) => storedHeaders(v, into));
  }
  return into;
}

export function containsPlaceholder(body: Json): boolean {
  return JSON.stringify(body ?? null).includes(JSON.stringify(REDACTED));
}

export type RestoreResult = { ok: true; body: any } | { ok: false; error: string };

/**
 * A copy of `body` with every masked webhook header value replaced by the stored value of the header
 * of the same name (case-insensitive). A placeholder that cannot be matched fails the call, naming the
 * path, so nothing is sent with a placeholder in it.
 */
export function restoreSecrets(body: any, stored: Json): RestoreResult {
  const headers = storedHeaders(stored, new Map());
  const problems: string[] = [];

  const walk = (value: Json, path: string): Json => {
    if (Array.isArray(value)) return value.map((v, i) => walk(v, `${path}[${i}]`));
    if (!isObject(value)) {
      if (value === REDACTED) problems.push(path || "(body)");
      return value;
    }
    if (isHeaderPair(value) && value.value === REDACTED) {
      const original = headers.get(value.key.toLowerCase());
      if (original === undefined) {
        problems.push(path);
        return value;
      }
      return { ...value, value: original };
    }
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, walk(v, path ? `${path}.${k}` : k)])
    );
  };

  const restored = walk(body, "");
  if (problems.length > 0) {
    return {
      ok: false,
      error: `The body holds the placeholder ${REDACTED} where no stored value can replace it: ${problems.join(", ")}. Nothing was sent. Remove those values, or send the real ones.`,
    };
  }
  return { ok: true, body: restored };
}
