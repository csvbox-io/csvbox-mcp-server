/**
 * Regression tests for the findings of the second review of feat/t-3555/mcp-new-tools
 * (openspec change fix-mcp-server-review-findings): secret masking, the migration prompt,
 * sample CSV values, patch-mode validation and the generated webhook handlers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { connectHarness } from "./support/mcp-harness.js";
import { createHttpStub } from "./support/http-stub.js";
import { withCleanEnv } from "./support/env.js";
import { buildSampleCsv } from "../tools/generate-sample-csv.js";
import { buildWebhookHandler } from "../tools/generate-webhook-handler.js";
import { validateSheet } from "../tools/validate-schema.js";
import { SHEET_SYSTEM_PROMPT } from "../prompts/sheet-system-prompt.js";
import { maskSecrets, restoreSecrets, REDACTED } from "../redact.js";

const CREDS = { CSVBOX_API_KEY: "key-abc", CSVBOX_API_SECRET: "secret-xyz" };

// --- secret masking (findings 1, 2) -------------------------------------------------

const sheetWithSecrets = () => ({
  title: "T",
  destination: "webhook",
  webhooks: [
    {
      import_complete: {
        url: "https://example.com/hook",
        send_copy: false,
        custom_headers: [
          { key: "Authorization", value: "Bearer S3CRET" },
          { key: "x-api-key", value: "K-123" },
          { key: "X-Tenant", value: "acme" },
        ],
      },
    },
  ],
  security_settings: { region: "us", signing_enabled: true },
  display: { token_label: "" },
});

test("maskSecrets masks credential-like header values and keeps harmless ones", () => {
  const out: any = maskSecrets(sheetWithSecrets());
  const headers = out.webhooks[0].import_complete.custom_headers;
  assert.deepEqual(headers, [
    { key: "Authorization", value: REDACTED },
    { key: "x-api-key", value: REDACTED },
    { key: "X-Tenant", value: "acme" },
  ]);
});

test("maskSecrets keeps keys and non-string values, so a flag is never lost", () => {
  const out: any = maskSecrets(sheetWithSecrets());
  assert.equal(out.security_settings.signing_enabled, true);
  assert.equal(out.display.token_label, "");
  assert.equal(out.webhooks[0].import_complete.send_copy, false);
});

test("maskSecrets masks a credential-named string at any depth without dropping the key", () => {
  const out: any = maskSecrets({ a: { api_key: "k", password: "p", keep: 1, nested: [{ secret: "s" }] } });
  assert.deepEqual(out, { a: { api_key: REDACTED, password: REDACTED, keep: 1, nested: [{ secret: REDACTED }] } });
});

test("maskSecrets does not modify its input", () => {
  const input = sheetWithSecrets();
  maskSecrets(input);
  assert.equal(input.webhooks[0].import_complete.custom_headers[0].value, "Bearer S3CRET");
});

test("restoreSecrets puts the stored header value back, by header name", () => {
  const stored = sheetWithSecrets();
  const body: any = maskSecrets(stored);
  body.title = "Renamed";
  const restored = restoreSecrets(body, stored);
  assert.equal(restored.ok, true);
  const headers = (restored as any).body.webhooks[0].import_complete.custom_headers;
  assert.equal(headers[0].value, "Bearer S3CRET");
  assert.equal(headers[1].value, "K-123");
  assert.equal((restored as any).body.title, "Renamed");
});

test("restoreSecrets matches the header name case-insensitively and keeps a new real value", () => {
  const stored = sheetWithSecrets();
  const body: any = maskSecrets(stored);
  body.webhooks[0].import_complete.custom_headers[0] = { key: "authorization", value: REDACTED };
  body.webhooks[0].import_complete.custom_headers[1] = { key: "x-api-key", value: "NEW-VALUE" };
  const restored: any = restoreSecrets(body, stored);
  assert.equal(restored.ok, true);
  assert.equal(restored.body.webhooks[0].import_complete.custom_headers[0].value, "Bearer S3CRET");
  assert.equal(restored.body.webhooks[0].import_complete.custom_headers[1].value, "NEW-VALUE");
});

test("restoreSecrets refuses a placeholder it cannot match and names the path", () => {
  const stored = sheetWithSecrets();
  const body: any = maskSecrets(stored);
  body.webhooks[0].import_complete.custom_headers.push({ key: "X-Other", value: REDACTED });
  const restored: any = restoreSecrets(body, stored);
  assert.equal(restored.ok, false);
  assert.match(restored.error, /webhooks\[0\]\.import_complete\.custom_headers\[3\]/);
  const elsewhere: any = restoreSecrets({ title: REDACTED }, stored);
  assert.equal(elsewhere.ok, false);
  assert.match(elsewhere.error, /title/);
});

test("get_sheet and the sheet resource return the same masked body", async (t) => {
  const stub = createHttpStub();
  stub.install();
  const h = await connectHarness();
  t.after(async () => {
    await h.close();
    stub.restore();
  });

  stub.script({ kind: "response", status: 200, data: sheetWithSecrets() });
  const tool = await withCleanEnv(CREDS, () => h.callJson("get_sheet", { sheet_license_key: "lic" }));
  stub.script({ kind: "response", status: 200, data: sheetWithSecrets() });
  const res = await withCleanEnv(CREDS, () => h.client.readResource({ uri: "csvbox://sheets/lic" }));
  const fromResource = JSON.parse((res.contents[0] as { text: string }).text);

  assert.deepEqual(tool.json.data, fromResource);
  assert.equal(tool.json.data.webhooks[0].import_complete.custom_headers[0].value, REDACTED);
  assert.doesNotMatch(JSON.stringify(tool.json), /S3CRET|K-123/);
});

test("update_sheet writes the real header values back for a masked body, with one extra GET", async (t) => {
  const stub = createHttpStub();
  stub.install();
  const h = await connectHarness();
  t.after(async () => {
    await h.close();
    stub.restore();
  });

  const masked: any = maskSecrets(sheetWithSecrets());
  masked.title = "Renamed";
  stub.script(
    { kind: "response", status: 200, data: sheetWithSecrets() },
    { kind: "response", status: 200, data: { status: "Sheet Updated Successfully" } }
  );
  const res = await withCleanEnv(CREDS, () => h.callJson("update_sheet", { sheet_license_key: "lic", sheet: masked }));

  assert.equal(res.isError, false);
  assert.equal(stub.requests.length, 2);
  assert.equal(stub.requests[0].method, "get");
  assert.equal(stub.requests[1].method, "put");
  const sent = JSON.parse(String(stub.requests[1].data));
  assert.equal(sent.webhooks[0].import_complete.custom_headers[0].value, "Bearer S3CRET");
  assert.equal(sent.title, "Renamed");
});

test("patch_sheet restores masked headers too", async (t) => {
  const stub = createHttpStub();
  stub.install();
  const h = await connectHarness();
  t.after(async () => {
    await h.close();
    stub.restore();
  });

  const masked: any = maskSecrets(sheetWithSecrets());
  stub.script(
    { kind: "response", status: 200, data: sheetWithSecrets() },
    { kind: "response", status: 200, data: { status: "Sheet Updated Successfully" } }
  );
  await withCleanEnv(CREDS, () =>
    h.callJson("patch_sheet", { sheet_license_key: "lic", changes: { webhooks: masked.webhooks } })
  );
  const sent = JSON.parse(String(stub.requests[1].data));
  assert.equal(sent.webhooks[0].import_complete.custom_headers[0].value, "Bearer S3CRET");
});

test("a write with an unmatched placeholder sends nothing", async (t) => {
  const stub = createHttpStub();
  stub.install();
  const h = await connectHarness();
  t.after(async () => {
    await h.close();
    stub.restore();
  });

  const body: any = maskSecrets(sheetWithSecrets());
  body.webhooks[0].import_complete.custom_headers.push({ key: "X-Other", value: REDACTED });
  stub.script({ kind: "response", status: 200, data: sheetWithSecrets() });
  const res = await withCleanEnv(CREDS, () => h.callJson("update_sheet", { sheet_license_key: "lic", sheet: body }));

  assert.equal(res.isError, true);
  assert.match(JSON.stringify(res.json), /custom_headers\[3\]/);
  assert.deepEqual(stub.requests.map((r) => r.method), ["get"]);
});

test("a write with no placeholder makes no extra GET", async (t) => {
  const stub = createHttpStub();
  stub.install();
  const h = await connectHarness();
  t.after(async () => {
    await h.close();
    stub.restore();
  });

  stub.script({ kind: "response", status: 200, data: { status: "ok" } });
  await withCleanEnv(CREDS, () =>
    h.callJson("update_sheet", { sheet_license_key: "lic", sheet: { title: "T", sheet_columns: [] } })
  );
  assert.deepEqual(stub.requests.map((r) => r.method), ["put"]);
});

// --- migration prompt (finding 3) -----------------------------------------------------

test("SHEET_SYSTEM_PROMPT text is unchanged by the prompt split", () => {
  const hash = crypto.createHash("sha256").update(SHEET_SYSTEM_PROMPT).digest("hex");
  assert.equal(hash, "0842f30cd60e95357ec26c15b97cdefaba1cf09110b70b88b75f27abc15bc50d");
});

test("migrate_from_flatfile carries no JSON-only instruction and keeps its report and confirmation", async (t) => {
  const h = await connectHarness();
  t.after(() => h.close());
  const res = await h.client.getPrompt({ name: "migrate_from_flatfile", arguments: { config: "MARKER" } });
  const text = (res.messages[0].content as { text: string }).text;

  assert.doesNotMatch(text, /Return ONLY valid JSON/i);
  assert.doesNotMatch(text, /no prose/i);
  assert.doesNotMatch(text, /Return only JSON\./);
  assert.match(text, /Mapped/);
  assert.match(text, /Could not map/);
  assert.match(text, /validate_schema/);
  assert.match(text, /Do NOT call `create_sheet` until I confirm/);
  assert.match(text, /MARKER/);
  assert.match(text, /display_label/);
});

test("create_csvbox_sheet still embeds the whole system prompt", async (t) => {
  const h = await connectHarness();
  t.after(() => h.close());
  const res = await h.client.getPrompt({ name: "create_csvbox_sheet", arguments: { request: "x" } });
  assert.ok(String((res.messages[0].content as { text: string }).text).includes(SHEET_SYSTEM_PROMPT));
});

// --- sample CSV (findings 4, 6, 7) ----------------------------------------------------

test("a required column that cannot be derived is listed as a failure on every row", () => {
  const out = buildSampleCsv(
    {
      sheet_columns: [
        { column_name: "gstin", type: "regex", required: true, validators: { expression: "^[0-9]{2}$" } },
        { column_name: "name", type: "text" },
      ],
    },
    3,
    2
  );
  const rows = out.expected_failures.filter((f) => f.column === "gstin").map((f) => f.row);
  assert.deepEqual(rows, [1, 2, 3, 4, 5]);
  assert.match(out.expected_failures[0].reason, /cannot be derived/);
  assert.ok(out.warnings.some((w) => /gstin/.test(w)));
});

test("an optional underivable column is not listed as a failure", () => {
  const out = buildSampleCsv(
    { sheet_columns: [{ column_name: "code", type: "regex", validators: { expression: "^a$" } }, { column_name: "n", type: "text" }] },
    2,
    0
  );
  assert.deepEqual(out.expected_failures, []);
});

test("a required empty list is listed and an invalid row targeting the same cell is not double-listed", () => {
  const out = buildSampleCsv({ sheet_columns: [{ column_name: "l", type: "list", required: true, validators: { values: [] } }] }, 2, 1);
  assert.deepEqual(out.expected_failures.map((f) => f.row), [1, 2, 3]);
});

const dateCol = (validators: Record<string, unknown>) => ({
  sheet_columns: [{ column_name: "d", display_label: "D", type: "date", validators }],
});
const dateCells = (validators: Record<string, unknown>, rows = 2) =>
  buildSampleCsv(dateCol(validators), rows, 0).csv.trim().split("\n").slice(1);

test("the four standard date formats are unchanged", () => {
  assert.deepEqual(dateCells({ format: "YYYY-MM-DD" }), ["2024-01-01", "2024-02-02"]);
  assert.deepEqual(dateCells({ format: "MM/DD/YYYY" }), ["01/01/2024", "02/02/2024"]);
  assert.deepEqual(dateCells({ format: "DD/MM/YYYY" }), ["01/01/2024", "02/02/2024"]);
  assert.deepEqual(dateCells({ format: "YYYY/MM/DD" }), ["2024/01/01", "2024/02/02"]);
  assert.deepEqual(dateCells({}), ["2024-01-01", "2024-02-02"]);
});

test("month names, unpadded and two-digit year tokens render", () => {
  assert.deepEqual(dateCells({ format: "DD-MMM-YYYY" }), ["01-Jan-2024", "02-Feb-2024"]);
  assert.deepEqual(dateCells({ format: "D MMMM YY" }), ["1 January 24", "2 February 24"]);
  assert.deepEqual(dateCells({ format: "D/M/YYYY" }, 3), ["1/1/2024", "2/2/2024", "3/3/2024"]);
});

test("custom and multiple formats use their own pattern, never the word custom or multiple", () => {
  assert.deepEqual(dateCells({ format: "custom", custom: "DD-MMM-YYYY" }), ["01-Jan-2024", "02-Feb-2024"]);
  assert.deepEqual(dateCells({ format: "multiple", multiple: ["DD/MM/YYYY", "YYYY-MM-DD"] }), ["01/01/2024", "02/02/2024"]);
});

test("a date format with a token the renderer cannot produce gives a blank cell and a warning", () => {
  const out = buildSampleCsv(dateCol({ format: "dddd, DD MMM" }), 2, 0);
  assert.deepEqual(out.csv.split("\n").slice(1, 3), ["", ""]);
  assert.ok(out.warnings.some((w) => /"d"/.test(w) && /dddd/.test(w)));
});

test("text under max_length stays distinct, and a warning appears when it cannot", () => {
  const ok = buildSampleCsv({ sheet_columns: [{ column_name: "n", display_label: "Name", type: "text", validators: { max_length: 3 } }] }, 4, 0);
  const cells = ok.csv.trim().split("\n").slice(1);
  assert.equal(new Set(cells).size, 4);
  assert.ok(cells.every((c) => c.length <= 3));
  assert.deepEqual(ok.warnings, []);

  const tooShort = buildSampleCsv({ sheet_columns: [{ column_name: "n", type: "text", validators: { max_length: 1 } }] }, 12, 0);
  assert.ok(tooShort.warnings.some((w) => /distinct/.test(w) && /"n"/.test(w)));
});

test("credit card samples are valid and not all the same", () => {
  const out = buildSampleCsv({ sheet_columns: [{ column_name: "cc", type: "credit_card" }] }, 5, 0);
  const cells = out.csv.trim().split("\n").slice(1);
  assert.ok(new Set(cells).size > 1);
  const luhn = (s: string) => {
    let sum = 0;
    [...s].reverse().forEach((ch, i) => {
      let d = Number(ch);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    });
    return sum % 10 === 0;
  };
  assert.ok(cells.every(luhn));
});

// --- patch-mode validation (finding 5) ------------------------------------------------

const patchBody = (extra: Record<string, unknown> = {}) => ({
  title: "t",
  sheet_columns: [{ column_name: "email" }],
  validation_functions: [{ function_name: "v", js_code: "return [];", columns: ["phone"] }],
  ...extra,
});

test("patch mode warns, not errors, on a function that references an existing column", () => {
  const r = validateSheet(patchBody(), "patch");
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => /phone/.test(w) && /already exist/i.test(w)));
});

test("create and put still reject the unknown reference", () => {
  for (const mode of ["create", "put"] as const) {
    const r = validateSheet(patchBody({ sheet_columns: [{ column_name: "email", display_label: "E", type: "email" }] }), mode);
    assert.ok(r.errors.some((e) => /phone/.test(e)), mode);
  }
});

test("patch mode with empty or absent sheet_columns does not error on references", () => {
  assert.equal(validateSheet(patchBody({ sheet_columns: [] }), "patch").valid, true);
  const { sheet_columns: _omit, ...without } = patchBody();
  assert.equal(validateSheet(without, "patch").valid, true);
});

test("patch mode does not warn for a column that is in the request", () => {
  const r = validateSheet(patchBody({ sheet_columns: [{ column_name: "phone" }] }), "patch");
  assert.deepEqual(r.warnings.filter((w) => /phone/.test(w)), []);
});

test("patch mode keeps an unknown reference an error when the columns are known to be complete", () => {
  const r = validateSheet(patchBody(), "patch", { columnsAreComplete: true });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /phone/.test(e)));
});

test("a virtual column that collides with a request column is an error in patch mode", () => {
  const r = validateSheet(
    { title: "t", sheet_columns: [{ column_name: "full" }], virtual_columns: [{ column_name: "full", js_code: "return 1;" }] },
    "patch"
  );
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /collides/.test(e)));
});

// --- generated webhook handlers (findings 8, 9) ---------------------------------------

const SECRET = "whsec_test";
const sign = (timestamp: string, body: string) =>
  crypto.createHmac("sha256", SECRET).update(`${timestamp}.`).update(body).digest("hex");
const nowSec = () => String(Math.floor(Date.now() / 1000));

const timestamps: Array<[string, () => string, boolean]> = [
  ["fresh seconds", nowSec, true],
  ["stale", () => String(Math.floor(Date.now() / 1000) - 1000), false],
  ["non-numeric", () => "abc", false],
  ["ISO date", () => new Date().toISOString(), false],
  ["NaN", () => "NaN", false],
  ["milliseconds", () => String(Date.now()), false],
];

function expressVerifier() {
  const code = buildWebhookHandler("express", { kind: "import_complete", verifySignature: true }).code;
  const start = code.indexOf("const SECRET");
  const end = code.indexOf("const app = express()");
  const sandbox: any = { crypto, process: { env: { CSVBOX_WEBHOOK_SECRET: SECRET } }, Buffer, Math, Number, Date };
  vm.createContext(sandbox);
  vm.runInContext(`${code.slice(start, end)}\nthis.verifySignature = verifySignature;`, sandbox);
  return sandbox.verifySignature as (req: any) => boolean;
}

const expressReq = (timestamp: string, body: Buffer | undefined, signature?: string) => ({
  rawBody: body,
  get: (name: string) => ({ "x-csvbox-timestamp": timestamp, "x-csvbox-signature": signature ?? (body ? sign(timestamp, body.toString()) : "00") }[name]),
});

test("Express handler: replay check needs a finite number of seconds", () => {
  const verify = expressVerifier();
  for (const [label, ts, expected] of timestamps) {
    const t = ts();
    const body = Buffer.from('{"a":1}');
    assert.equal(verify(expressReq(t, body)), expected, label);
  }
});

test("Express handler: a missing raw body is a failed verification, not an exception", () => {
  const verify = expressVerifier();
  assert.doesNotThrow(() => verify(expressReq(nowSec(), undefined)));
  assert.equal(verify(expressReq(nowSec(), undefined)), false);
});

test("Express handler: a wrong signature is rejected", () => {
  const verify = expressVerifier();
  assert.equal(verify(expressReq(nowSec(), Buffer.from("{}"), "deadbeef")), false);
});

function nextRoute() {
  let code = buildWebhookHandler("nextjs", { kind: "import_complete", verifySignature: true }).code;
  code = code
    .replace(/^import .*$/gm, "")
    .replace("export async function POST", "async function POST")
    .replace(/: (Request|string|boolean|any)\b/g, "");
  const sandbox: any = {
    crypto,
    Buffer,
    Math,
    Number,
    Date,
    JSON,
    console: { log() {} },
    process: { env: { CSVBOX_WEBHOOK_SECRET: SECRET } },
    NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }) },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${code}\nthis.POST = POST;`, sandbox);
  return sandbox.POST as (req: any) => Promise<{ status: number }>;
}

const nextReq = (timestamp: string, raw: string, signature?: string) => ({
  text: async () => raw,
  headers: { get: (n: string) => ({ "x-csvbox-timestamp": timestamp, "x-csvbox-signature": signature ?? sign(timestamp, raw) }[n] ?? null) },
});

test("Next.js handler: replay check needs a finite number of seconds", async () => {
  const post = nextRoute();
  for (const [label, ts, expected] of timestamps) {
    const t = ts();
    const res = await post(nextReq(t, '{"import_id":1}'));
    assert.equal(res.status, expected ? 200 : 401, label);
  }
});

test("Next.js handler: a signed body that is not JSON answers 400, not an exception", async () => {
  const post = nextRoute();
  const t = nowSec();
  const res = await post(nextReq(t, "not json"));
  assert.equal(res.status, 400);
});

test("Django handler: rejects non-numeric, NaN, inf, ms and stale timestamps, accepts a fresh one", () => {
  const code = buildWebhookHandler("django", { kind: "import_complete", verifySignature: true }).code;
  const start = code.indexOf('SECRET = os.environ');
  const end = code.indexOf("\n\n\n", code.indexOf("def verify_signature"));
  const py = `
import os, time, hmac, hashlib, math, json
os.environ["CSVBOX_WEBHOOK_SECRET"] = "${SECRET}"
${code.slice(start, end)}
class Req:
    def __init__(self, ts, body):
        self.headers = {"x-csvbox-timestamp": ts, "x-csvbox-signature": hmac.new(SECRET.encode(), ts.encode() + b"." + body, hashlib.sha256).hexdigest()}
        self.body = body
now = time.time()
cases = {"fresh": str(int(now)), "stale": str(int(now) - 1000), "abc": "abc", "nan": "nan", "inf": "inf", "ms": str(int(now * 1000)), "iso": "2026-10-22T00:00:00Z"}
print(json.dumps({k: verify_signature(Req(v, b"{}")) for k, v in cases.items()}))
`;
  const run = spawnSync("python3", ["-I", "-c", py], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { fresh: true, stale: false, abc: false, nan: false, inf: false, ms: false, iso: false });
});

test("Laravel handler requires a digits-only timestamp before the age check", () => {
  const code = buildWebhookHandler("laravel", { kind: "import_complete", verifySignature: true }).code;
  assert.match(code, /ctype_digit\(\(string\) \$timestamp\)/);
  assert.match(code, /abs\(time\(\) - \(int\) \$timestamp\) > 300/);
});

// --- gaps found when auditing every spec scenario -----------------------------------------

test("create_sheet refuses a body that holds the placeholder", async (t) => {
  const stub = createHttpStub();
  stub.install();
  const h = await connectHarness();
  t.after(async () => {
    await h.close();
    stub.restore();
  });
  const res = await withCleanEnv(CREDS, () =>
    h.callJson("create_sheet", { sheet: { title: "T", webhooks: [{ import_complete: { custom_headers: [{ key: "Authorization", value: REDACTED }] } }] } })
  );
  assert.equal(res.isError, true);
  assert.match(JSON.stringify(res.json), /placeholder/);
  assert.equal(stub.requests.length, 0);
});

test("a write with a placeholder is refused, and nothing is sent, when the stored sheet cannot be read", async (t) => {
  const stub = createHttpStub();
  stub.install();
  const h = await connectHarness();
  t.after(async () => {
    await h.close();
    stub.restore();
  });
  const body: any = maskSecrets(sheetWithSecrets());
  stub.script({ kind: "httpError", status: 404, data: { errors: "Sheet does not exist." } });
  const res = await withCleanEnv(CREDS, () => h.callJson("patch_sheet", { sheet_license_key: "gone", changes: { webhooks: body.webhooks } }));
  assert.equal(res.isError, true);
  assert.match(JSON.stringify(res.json), /could not be read/);
  assert.deepEqual(stub.requests.map((r) => r.method), ["get"]);
});

test("Next.js handler: a wrong signature is 401 and a good one is 200", async () => {
  const post = nextRoute();
  const t = nowSec();
  assert.equal((await post(nextReq(t, '{"import_id":1}', "deadbeef"))).status, 401);
  assert.equal((await post(nextReq(t, '{"import_id":1}'))).status, 200);
});

test("Express handler: a missing header or secret is rejected", () => {
  const verify = expressVerifier();
  assert.equal(verify({ rawBody: Buffer.from("{}"), get: () => undefined }), false);
});

test("Django handler: wrong signature and missing headers are rejected, and a bad body is 400", () => {
  const code = buildWebhookHandler("django", { kind: "import_complete", verifySignature: true }).code;
  const start = code.indexOf("SECRET = os.environ");
  const end = code.indexOf("\n\n\n", code.indexOf("def verify_signature"));
  const py = `
import os, time, hmac, hashlib, json, math
os.environ["CSVBOX_WEBHOOK_SECRET"] = "${SECRET}"
${code.slice(start, end)}
class Req:
    def __init__(self, headers, body): self.headers = headers; self.body = body
now = str(int(time.time()))
good = hmac.new(SECRET.encode(), now.encode() + b"." + b"{}", hashlib.sha256).hexdigest()
print(json.dumps({
  "good": verify_signature(Req({"x-csvbox-timestamp": now, "x-csvbox-signature": good}, b"{}")),
  "wrong": verify_signature(Req({"x-csvbox-timestamp": now, "x-csvbox-signature": "00"}, b"{}")),
  "no_headers": verify_signature(Req({}, b"{}")),
  "tampered_body": verify_signature(Req({"x-csvbox-timestamp": now, "x-csvbox-signature": good}, b"{ }")),
}))`;
  const run = spawnSync("python3", ["-I", "-c", py], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { good: true, wrong: false, no_headers: false, tampered_body: false });
  assert.match(code, /json\.JSONDecodeError/);
});

test("Laravel handler, executed under PHP: only a fresh, correctly signed, digits-only timestamp passes", (t) => {
  if (spawnSync("php", ["-v"]).status !== 0) return t.skip("php is not installed");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csvbox-laravel-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const code = buildWebhookHandler("laravel", { kind: "import_complete", verifySignature: true }).code;
  fs.writeFileSync(path.join(dir, "stubs.php"), `<?php
namespace Illuminate\\Http { class Request {
  public function __construct(public array $h, public string $body) {}
  public function header($k) { return $this->h[$k] ?? null; }
  public function getContent() { return $this->body; }
  public function json() { $d = json_decode($this->body, true); return new class($d ?? []) { public function __construct(public array $d) {} public function all() { return $this->d; } }; }
} }
namespace Illuminate\\Support\\Facades { class Log { public static function info(...$a) {} } }
namespace App\\Http\\Controllers { class Controller {} }
namespace { function config($k) { return "${SECRET}"; } function response() { return new class { public function json($b, $s = 200) { return [$s, $b]; } }; } }
`);
  fs.writeFileSync(path.join(dir, "handler.php"), code.split("\n\n// routes/api.php")[0]);
  fs.writeFileSync(path.join(dir, "run.php"), `<?php
require __DIR__ . '/stubs.php'; require __DIR__ . '/handler.php';
$c = new App\\Http\\Controllers\\CsvboxWebhookController();
$body = '{"import_id":1}'; $now = (string) time();
$sig = fn($ts) => hash_hmac('sha256', $ts . '.' . $body, "${SECRET}");
$try = fn($ts, $signature = null) => $c->handle(new Illuminate\\Http\\Request(['x-csvbox-timestamp' => $ts, 'x-csvbox-signature' => $signature ?? $sig($ts)], $body))[0];
echo json_encode([
  'fresh' => $try($now), 'stale' => $try((string) (time() - 1000)), 'abc' => $try('abc'), 'iso' => $try('2026-10-22T00:00:00Z'),
  'nan' => $try('NaN'), 'ms' => $try((string) (time() * 1000)), 'float' => $try($now . '.5'), 'wrong' => $try($now, 'deadbeef'),
]);
`);
  const run = spawnSync("php", [path.join(dir, "run.php")], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.deepEqual(JSON.parse(run.stdout.trim().split("\n").pop()!), { fresh: 200, stale: 401, abc: 401, iso: 401, nan: 401, ms: 401, float: 401, wrong: 401 });
});
