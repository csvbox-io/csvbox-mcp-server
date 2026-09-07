import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import type { CapturedRequest } from './queue-mock';

/**
 * Client identification, asserted end-to-end.
 *
 * The unit suite proves `buildClient()` sets these headers; this proves they
 * survive the whole path — a real MCP client, the built server, and a real
 * socket — for both JSON and multipart submissions.
 */
const manifest = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
) as { version: string };

export const EXPECTED_CLIENT = 'mcp';
export const EXPECTED_CLIENT_VERSION = manifest.version;

/** Assert one captured request carries both identification headers. */
export function expectMcpIdentification(request: CapturedRequest): void {
  expect(request.headers['x-csvbox-client']).toBe(EXPECTED_CLIENT);
  expect(request.headers['x-csvbox-client-version']).toBe(EXPECTED_CLIENT_VERSION);
}
