import axios, { AxiosInstance, isAxiosError } from "axios";

import { VERSION } from "../version.js";

/**
 * CSVBox REST API client.
 *
 * Base URL and auth header names are centralized here. The header spelling
 * (`x-csvbox-secret-api-key`) follows the captured reference payloads under
 * `docs/`; the task brief's `x-csvbox-api-secret` is the only documented
 * alternative. If CSVBox confirms otherwise, change the constant below.
 */
const DEFAULT_BASE_URL = "https://api.csvbox.io";
const API_KEY_HEADER = "x-csvbox-api-key";
const API_SECRET_HEADER = "x-csvbox-secret-api-key";

/**
 * Client identification. CSVBox records how each sheet was created; without
 * these headers MCP traffic is indistinguishable from any other REST caller.
 * Attached to the shared instance rather than per call site, so every current
 * and future API-backed tool is attributed without doing anything.
 *
 * Advisory only. Anyone holding the API key can send the same values, so this
 * is adequate for adoption analytics and support triage but must never gate
 * billing, quota, or entitlement decisions.
 */
const CLIENT_HEADER = "x-csvbox-client";
const CLIENT_VERSION_HEADER = "x-csvbox-client-version";
const CLIENT_ID = "mcp";

/** Normalized result shapes returned to every API-backed tool. */
export type ApiSuccess = { ok: true; status: number; data: unknown };
export type ApiFailure = {
  ok: false;
  status: number | null;
  error: string;
  details?: unknown;
};
export type ApiResult = ApiSuccess | ApiFailure;

/** Read credentials lazily so local-only tools work without them. */
function getCredentials(): { key: string; secret: string } {
  const key = process.env.CSVBOX_API_KEY;
  const secret = process.env.CSVBOX_API_SECRET;
  if (!key) {
    throw new Error(
      "Missing CSVBOX_API_KEY environment variable. Set it in your environment or .env file."
    );
  }
  if (!secret) {
    throw new Error(
      "Missing CSVBOX_API_SECRET environment variable. Set it in your environment or .env file."
    );
  }
  return { key, secret };
}

/** Build an Axios instance with auth headers attached from current env. */
function buildClient(): AxiosInstance {
  const { key, secret } = getCredentials();
  return axios.create({
    baseURL: process.env.CSVBOX_API_BASE_URL || DEFAULT_BASE_URL,
    timeout: 30_000,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      [API_KEY_HEADER]: key,
      [API_SECRET_HEADER]: secret,
      [CLIENT_HEADER]: CLIENT_ID,
      [CLIENT_VERSION_HEADER]: VERSION,
    },
  });
}

/** Wrap a request, normalizing both transport and credential errors. */
async function request(
  fn: (client: AxiosInstance) => Promise<{ status: number; data: unknown }>
): Promise<ApiResult> {
  let client: AxiosInstance;
  try {
    client = buildClient();
  } catch (err) {
    // Missing-credential error — surface before any network call.
    return {
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : "Failed to build API client",
    };
  }

  try {
    const res = await fn(client);
    return { ok: true, status: res.status, data: res.data };
  } catch (err) {
    if (isAxiosError(err)) {
      return {
        ok: false,
        status: err.response?.status ?? null,
        error: err.message,
        details: err.response?.data,
      };
    }
    return {
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : "Unknown API error",
    };
  }
}

/** POST /1.1/sheet — create a new sheet. */
export function createSheet(sheet: unknown): Promise<ApiResult> {
  return request((client) => client.post("/1.1/sheet", sheet));
}

/** PUT /1.1/sheet/{key} — full replace of an existing sheet. */
export function updateSheet(
  sheetLicenseKey: string,
  sheet: unknown
): Promise<ApiResult> {
  return request((client) =>
    client.put(`/1.1/sheet/${encodeURIComponent(sheetLicenseKey)}`, sheet)
  );
}

/** PATCH /1.1/sheet/{key} — partial update, sending only the changes object. */
export function patchSheet(
  sheetLicenseKey: string,
  changes: unknown
): Promise<ApiResult> {
  return request((client) =>
    client.patch(`/1.1/sheet/${encodeURIComponent(sheetLicenseKey)}`, changes)
  );
}

/** Query parameters without the unset ones (and, by default, without empty strings), ready for axios. */
function compactParams(query: Record<string, unknown>, dropEmptyStrings = true): Record<string, string | number> {
  return Object.fromEntries(
    Object.entries(query).filter(([, v]) => v !== undefined && (!dropEmptyStrings || v !== ""))
  ) as Record<string, string | number>;
}

/** Query for GET /1.1/sheet. All fields optional; the API clamps per_page to 100. */
export type ListSheetsQuery = { q?: string; page?: number; per_page?: number };

/** GET /1.1/sheet — paginated list of the key owner's sheets. */
export function listSheets(query: ListSheetsQuery = {}): Promise<ApiResult> {
  const params = compactParams({ q: query.q?.trim(), page: query.page, per_page: query.per_page });
  return request((client) => client.get("/1.1/sheet", { params }));
}

/** GET /1.1/sheet/{key} — full configuration of one sheet (license key or sheet id). */
export function getSheet(sheetLicenseKey: string): Promise<ApiResult> {
  return request((client) =>
    client.get(`/1.1/sheet/${encodeURIComponent(sheetLicenseKey)}`)
  );
}

/** Query for GET /1.1/import. `from` / `to` are YYYY-MM-DD; `sheet` is a license key or sheet id. */
export type ListImportsQuery = {
  sheet?: string;
  status?: "success" | "partial" | "failed" | "ongoing";
  from?: string;
  to?: string;
  page?: number;
  per_page?: number;
};

/** GET /1.1/import — paginated import history for the key owner's sheets. */
export function listImports(query: ListImportsQuery = {}): Promise<ApiResult> {
  const params = compactParams(query);
  return request((client) => client.get("/1.1/import", { params }));
}

/** GET /1.1/import/{id} — one import's status and row counts. */
export function getImport(importId: number): Promise<ApiResult> {
  return request((client) => client.get(`/1.1/import/${importId}`));
}

/** GET /1.1/import/{id}/errors — the recorded failures for one import. */
export function getImportErrors(
  importId: number,
  query: { page?: number; per_page?: number } = {}
): Promise<ApiResult> {
  const params = compactParams(query, false);
  return request((client) =>
    client.get(`/1.1/import/${importId}/errors`, { params })
  );
}

/** GET /1.1/account/usage — imports used / remaining in the current billing cycle. */
export function getUsage(): Promise<ApiResult> {
  return request((client) => client.get("/1.1/account/usage"));
}

/** Discriminated payload for the two `submit_file` submission methods. */
export type SubmitFilePayload =
  | { kind: "url"; import: Record<string, unknown> }
  | {
      kind: "upload";
      import: Record<string, unknown>;
      fileName: string;
      fileContent: Buffer;
    };

/**
 * POST /1.1/file — submit a file for import, either by public URL (JSON) or
 * direct upload (multipart/form-data). For uploads, `Content-Type` is set to
 * `undefined` so axios's native FormData handling supplies its own
 * multipart boundary instead of the client's default `application/json`.
 */
export function submitFile(payload: SubmitFilePayload): Promise<ApiResult> {
  if (payload.kind === "url") {
    return request((client) =>
      client.post("/1.1/file", { import: payload.import })
    );
  }

  return request((client) => {
    const form = new FormData();
    form.append("import", JSON.stringify(payload.import));
    form.append(
      "file",
      new Blob([payload.fileContent]),
      payload.fileName
    );
    return client.post("/1.1/file", form, {
      // Clears the client's default "application/json" header — otherwise it
      // overrides the multipart boundary axios's FormData handling would set.
      // Axios merges per-request headers over instance defaults key by key, so
      // only Content-Type is dropped; auth and client identification survive.
      headers: { "Content-Type": undefined },
    });
  });
}
