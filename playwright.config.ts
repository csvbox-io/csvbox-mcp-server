import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const INSPECTOR_URL = 'http://127.0.0.1:6274';
const NO_CREDS_INSPECTOR_URL = 'http://127.0.0.1:6277';
export const MOCK_CSVBOX_URL = 'http://127.0.0.1:4101';
export const MOCK_LLM_URL = 'http://127.0.0.1:4102';
export const NO_CREDS_URL = NO_CREDS_INSPECTOR_URL;

const REPO_ROOT = process.cwd();
const DIST_INDEX = path.join(REPO_ROOT, 'dist', 'index.js');
const NO_ENV_CWD = path.join(REPO_ROOT, 'e2e', 'support', 'no-env-cwd');

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'html',
  use: {
    baseURL: INSPECTOR_URL,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      command: `node --loader ts-node/esm e2e/support/mock-csvbox-server.ts ${MOCK_CSVBOX_URL}`,
      url: `${MOCK_CSVBOX_URL}/__mock__/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: `node --loader ts-node/esm e2e/support/mock-llm-server.ts ${MOCK_LLM_URL}`,
      url: `${MOCK_LLM_URL}/__mock__/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      // Inspector spawns the target stdio command with a small curated OS
      // env allowlist (PATH/APPDATA/etc.) PLUS only whatever `-e KEY=VALUE`
      // flags are passed here — it deliberately does NOT forward its own
      // process.env to an ad-hoc target. That means a plain `env:` block on
      // this webServer entry (which only sets Inspector's own env) never
      // reaches `dist/index.js` at all: everything the spawned server needs
      // must go through `-e`, or `dotenv/config` in src/index.ts will fill
      // it in from the repo's real .env — which is exactly the leak this
      // suite exists to close. Verified empirically: without `-e`, a
      // generate_sheet_json call silently used the real OPENAI_API_KEY/
      // ANTHROPIC_API_KEY from .env and made a real, billed LLM call.
      command: [
        'npm run build &&',
        'npx @modelcontextprotocol/inspector',
        `-e CSVBOX_API_KEY=e2e-mock-csvbox-key`,
        `-e CSVBOX_API_SECRET=e2e-mock-csvbox-secret`,
        `-e ANTHROPIC_API_KEY=e2e-mock-anthropic-key`,
        `-e LLM_PROVIDER=anthropic`,
        `-e CSVBOX_API_BASE_URL=${MOCK_CSVBOX_URL}`,
        `-e ANTHROPIC_BASE_URL=${MOCK_LLM_URL}`,
        'node dist/index.js',
      ].join(' '),
      url: INSPECTOR_URL,
      // Never reused, even locally: an already-running Inspector instance
      // (e.g. left over from manual investigation) would have been spawned
      // with different (or no) `-e` flags, defeating the pinning above.
      // Always starting fresh is the only way to guarantee this.
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        // This one IS read by Inspector's own process (not the spawned
        // child), so a plain env var here is correct for it specifically.
        // Loopback-only and test-only: never set on the real dist/index.js
        // stdio path that production MCP clients connect to.
        DANGEROUSLY_OMIT_AUTH: 'true',
      },
    },
    {
      // A second, zero-credential Inspector instance dedicated to every
      // "credentials missing" error path (NO_LLM_PROVIDER, and CSVBox's
      // fail-fast getCredentials() check). Deliberately passes NO `-e`
      // flags at all — but that alone isn't enough, because `dotenv/config`
      // in src/index.ts would then fall back to the repo's real .env and
      // use real keys (see the note on the primary entry above). `--cwd`
      // points the spawned process at an empty directory with no .env
      // file, so dotenv finds nothing and every credential genuinely stays
      // unset. `node dist/index.js` must be an absolute path here since
      // --cwd changes what a relative path would resolve against.
      command: [
        'npm run build &&',
        'npx @modelcontextprotocol/inspector',
        `--cwd ${NO_ENV_CWD}`,
        `node ${DIST_INDEX}`,
      ].join(' '),
      url: NO_CREDS_INSPECTOR_URL,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        DANGEROUSLY_OMIT_AUTH: 'true',
        CLIENT_PORT: '6277',
      },
    },
  ],
});
