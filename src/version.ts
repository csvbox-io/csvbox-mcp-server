import { readFileSync } from "node:fs";

/**
 * Single source of truth for the server version.
 *
 * Read once at module load from the package manifest rather than hardcoded,
 * so the version advertised over MCP and the version sent to CSVBox in
 * `x-csvbox-client-version` can never drift from `package.json`.
 *
 * `rootDir: "src"` -> `outDir: "dist"` keeps this module one level below the
 * package root in both source and built form, so the same relative path
 * resolves under ts-node (`src/version.ts`) and from the compiled output
 * (`dist/version.js`). npm always publishes `package.json` regardless of the
 * `files` allowlist, so it is present in installed packages too.
 *
 * A read failure degrades to a stale string rather than crashing startup: a
 * wrong version is far cheaper than a server that will not boot.
 */
const FALLBACK_VERSION = "1.0.1";

function readVersion(): string {
  try {
    const manifestUrl = new URL("../package.json", import.meta.url);
    const parsed = JSON.parse(readFileSync(manifestUrl, "utf8")) as {
      version?: unknown;
    };
    return typeof parsed.version === "string" && parsed.version.length > 0
      ? parsed.version
      : FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

export const VERSION: string = readVersion();
