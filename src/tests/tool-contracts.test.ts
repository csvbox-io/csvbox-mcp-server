/**
 * Per-tool response envelopes, driven through a real MCP client.
 *
 * The contract under test is `{ content, isError }` — that `isError` is set
 * when and only when the operation failed, that the body is the documented
 * shape, and that the argument guards that need no network refuse before any
 * request is attempted.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { connectHarness, type Harness } from "./support/mcp-harness.js";
import { createHttpStub, type HttpStub } from "./support/http-stub.js";
import { withCleanEnv } from "./support/env.js";
import { baseSheet } from "./support/fixtures.js";

const CREDS = { CSVBOX_API_KEY: "key-abc", CSVBOX_API_SECRET: "secret-xyz" };

/** A connected harness plus an installed axios stub, both torn down after. */
async function setup(t: { after(fn: () => unknown): void }): Promise<{
  h: Harness;
  stub: HttpStub;
}> {
  const stub = createHttpStub();
  stub.install();
  const h = await connectHarness();
  t.after(async () => {
    await h.close();
    stub.restore();
  });
  return { h, stub };
}

/**
 * Assert a call was refused by the declared input schema.
 *
 * The SDK does not throw for this — it answers with an error result carrying
 * JSON-RPC code -32602 and the Zod issue, so the handler never runs. Asserting
 * on that shape is what pins "refused at the boundary".
 */
async function assertInvalidArgs(
  h: Harness,
  name: string,
  args: Record<string, unknown>,
  detail: RegExp
): Promise<void> {
  const result = await h.callRaw(name, args);
  assert.equal(result.isError, true, `${name} accepted invalid arguments`);
  assert.match(result.text, /-32602/, `${name} failed for the wrong reason`);
  assert.match(result.text, /Input validation error/);
  assert.match(result.text, detail);
}

const WRITE_TOOLS: { name: string; args: Record<string, unknown> }[] = [
  { name: "create_sheet", args: { sheet: baseSheet } },
  { name: "update_sheet", args: { sheet_license_key: "lic", sheet: baseSheet } },
  { name: "patch_sheet", args: { sheet_license_key: "lic", changes: { title: "X" } } },
];

// --- 5.1 Success and failure envelopes ------------------------------------

test("write tools report success without the error flag", async (t) => {
  const { h, stub } = await setup(t);

  for (const tool of WRITE_TOOLS) {
    stub.script({ kind: "response", status: 200, data: { id: tool.name } });
    const { json, isError } = await withCleanEnv(CREDS, () =>
      h.callJson(tool.name, tool.args)
    );
    assert.equal(isError, false, `${tool.name} flagged a success as an error`);
    assert.equal(json.ok, true);
    assert.equal(json.status, 200);
    assert.deepEqual(json.data, { id: tool.name });
  }
});

test("write tools set the error flag and preserve status and details on failure", async (t) => {
  const { h, stub } = await setup(t);

  for (const tool of WRITE_TOOLS) {
    stub.script({ kind: "httpError", status: 422, data: { errors: "bad payload" } });
    const { json, isError } = await withCleanEnv(CREDS, () =>
      h.callJson(tool.name, tool.args)
    );
    assert.equal(isError, true, `${tool.name} did not flag a 422 as an error`);
    assert.equal(json.ok, false);
    assert.equal(json.status, 422);
    assert.deepEqual(json.details, { errors: "bad payload" });
  }
});

test("a 5xx is reported as an error too", async (t) => {
  const { h, stub } = await setup(t);
  stub.script({ kind: "httpError", status: 503, data: "unavailable" });

  const { json, isError } = await withCleanEnv(CREDS, () =>
    h.callJson("create_sheet", { sheet: baseSheet })
  );
  assert.equal(isError, true);
  assert.equal(json.status, 503);
});

// --- 5.2 Missing credentials ----------------------------------------------

test("write tools fail with the missing-variable message and issue no request", async (t) => {
  const { h, stub } = await setup(t);

  for (const tool of WRITE_TOOLS) {
    const { json, isError } = await withCleanEnv({}, () =>
      h.callJson(tool.name, tool.args)
    );
    assert.equal(isError, true, `${tool.name} did not flag missing credentials`);
    assert.equal(json.status, null);
    assert.match(json.error, /CSVBOX_API_KEY/);
  }

  assert.deepEqual(stub.requests, [], "a request was attempted without credentials");
});

// --- 5.3 submit_file argument guards --------------------------------------

test("submit_file refuses both, neither, and an unnamed upload", async (t) => {
  const { h, stub } = await setup(t);

  const both = await withCleanEnv(CREDS, () =>
    h.callJson("submit_file", {
      sheet_license_key: "lic",
      public_file_url: "https://x.test/a.csv",
      file_base64: Buffer.from("a,b").toString("base64"),
      file_name: "a.csv",
    })
  );
  assert.equal(both.isError, true);
  assert.match(both.json.error, /exactly one/);

  const neither = await withCleanEnv(CREDS, () =>
    h.callJson("submit_file", { sheet_license_key: "lic" })
  );
  assert.equal(neither.isError, true);
  assert.match(neither.json.error, /exactly one/);

  const unnamed = await withCleanEnv(CREDS, () =>
    h.callJson("submit_file", {
      sheet_license_key: "lic",
      file_base64: Buffer.from("a,b").toString("base64"),
    })
  );
  assert.equal(unnamed.isError, true);
  assert.match(unnamed.json.error, /file_name is required/);

  assert.deepEqual(stub.requests, [], "a guard failure still issued a request");
});

// --- 5.4 submit_file payload assembly -------------------------------------

test("a URL submission sends only the fields that were supplied", async (t) => {
  const { h, stub } = await setup(t);

  await withCleanEnv(CREDS, () =>
    h.callJson("submit_file", {
      sheet_license_key: "lic",
      public_file_url: "https://x.test/a.csv",
    })
  );

  assert.deepEqual(JSON.parse(stub.last().data), {
    import: { sheet_license_key: "lic", public_file_url: "https://x.test/a.csv" },
  });
});

test("optional submission fields appear only when supplied", async (t) => {
  const { h, stub } = await setup(t);

  await withCleanEnv(CREDS, () =>
    h.callJson("submit_file", {
      sheet_license_key: "lic",
      public_file_url: "https://x.test/a.csv",
      file_sheet_name: "Sheet2",
      user: { user_id: "u1" },
      options: { has_header: 1, max_rows: 500 },
      dynamic_columns: [{ column_name: "extra" }],
    })
  );

  const sent = JSON.parse(stub.last().data).import;
  assert.deepEqual(sent, {
    sheet_license_key: "lic",
    file_sheet_name: "Sheet2",
    user: { user_id: "u1" },
    options: { has_header: 1, max_rows: 500 },
    dynamic_columns: [{ column_name: "extra" }],
    public_file_url: "https://x.test/a.csv",
  });
});

test("a base64 submission reaches the client as multipart form data", async (t) => {
  const { h, stub } = await setup(t);
  const content = "id,name\n1,Ada\n";

  await withCleanEnv(CREDS, () =>
    h.callJson("submit_file", {
      sheet_license_key: "lic",
      file_base64: Buffer.from(content).toString("base64"),
      file_name: "people.csv",
    })
  );

  const body = stub.last().data;
  assert.ok(body instanceof FormData, "upload body is not FormData");
  assert.equal(
    body.get("import"),
    JSON.stringify({ sheet_license_key: "lic" })
  );

  const file = body.get("file");
  assert.ok(file instanceof Blob, "file part is not a Blob");
  assert.equal(await (file as File).text(), content);
  assert.equal((file as File).name, "people.csv");
});

// --- 5.5 generate_import_code ---------------------------------------------

test("every framework template is emitted and an unknown one is rejected", async (t) => {
  const { h } = await setup(t);

  for (const framework of [
    "vanilla-js",
    "react",
    "vuejs2",
    "vuejs3",
    "angular",
    "angular2",
  ]) {
    const result = await h.callRaw("generate_import_code", { framework });
    assert.equal(result.isError, false, `${framework} was flagged an error`);
    assert.ok(result.text.length > 0, `${framework} returned nothing`);
    assert.match(result.text, /YOUR_SHEET_LICENSE_KEY/);
    assert.match(result.text, new RegExp(`Framework: ${framework}`));
  }

  // The enum is enforced at the schema boundary, so the handler never runs.
  await assertInvalidArgs(
    h,
    "generate_import_code",
    { framework: "svelte" },
    /invalid_enum_value/
  );
});

// --- 5.6 validate_schema --------------------------------------------------

test("validate_schema flags invalid sheets and passes valid ones", async (t) => {
  const { h } = await setup(t);

  const ok = await h.callJson("validate_schema", { sheet: baseSheet });
  assert.equal(ok.isError, false);
  assert.equal(ok.json.valid, true);
  assert.deepEqual(ok.json.errors, []);

  const bad = await h.callJson("validate_schema", {
    sheet: { sheet_columns: [{ column_name: "a" }] },
  });
  assert.equal(bad.isError, true);
  assert.equal(bad.json.valid, false);
  assert.ok(bad.json.errors.length > 0);
});

test("the mode argument changes the verdict for an empty collection", async (t) => {
  const { h } = await setup(t);
  const sheet = { ...baseSheet, virtual_columns: [] };

  const put = await h.callJson("validate_schema", { sheet, mode: "put" });
  assert.equal(put.json.valid, false);
  assert.ok(put.json.errors.some((e: string) => e.includes("virtual_columns")));

  const patch = await h.callJson("validate_schema", { sheet, mode: "patch" });
  assert.equal(patch.json.valid, true);
  assert.ok(patch.json.warnings.some((w: string) => w.includes("virtual_columns")));

  const create = await h.callJson("validate_schema", { sheet });
  assert.equal(create.json.valid, true);
});

test("an unknown mode is rejected at the schema boundary", async (t) => {
  const { h } = await setup(t);
  await assertInvalidArgs(
    h,
    "validate_schema",
    { sheet: baseSheet, mode: "delete" },
    /invalid_enum_value/
  );
});

// --- 5.7 Generation tools without a provider ------------------------------

test("generation tools without a provider name their MCP prompt and issue no request", async (t) => {
  const { h, stub } = await setup(t);

  const sheetJson = await withCleanEnv({}, () =>
    h.callJson("generate_sheet_json", { prompt: "customer importer" })
  );
  assert.equal(sheetJson.isError, true);
  assert.equal(sheetJson.json.reason, "NO_LLM_PROVIDER");
  assert.match(sheetJson.json.message, /create_csvbox_sheet/);

  const functions = await withCleanEnv({}, () =>
    h.callJson("generate_sheet_functions", { prompt: "trim whitespace" })
  );
  assert.equal(functions.isError, true);
  assert.equal(functions.json.reason, "NO_LLM_PROVIDER");
  assert.match(functions.json.message, /csvbox_sheet_functions/);

  const importer = await withCleanEnv({}, () =>
    h.callJson("create_importer_from_prompt", { prompt: "customer importer" })
  );
  assert.equal(importer.isError, true);
  assert.equal(importer.json.reason, "NO_LLM_PROVIDER");
  assert.equal(importer.json.api_response, null);

  assert.deepEqual(stub.requests, [], "a generation tool called the API");
});

// --- 5.8 Schema enforcement at the boundary -------------------------------

test("missing and wrong-typed arguments are refused before any handler runs", async (t) => {
  const { h, stub } = await setup(t);

  // Missing required argument.
  await assertInvalidArgs(h, "create_sheet", {}, /invalid_type/);
  await assertInvalidArgs(
    h,
    "update_sheet",
    { sheet: baseSheet },
    /sheet_license_key/
  );

  // Wrong type where the schema is specific.
  await assertInvalidArgs(
    h,
    "create_sheet",
    { sheet: "not an object" },
    /"expected": "object"/
  );
  await assertInvalidArgs(
    h,
    "generate_sheet_json",
    { prompt: 42 },
    /"expected": "string"/
  );

  // Empty string violates the documented min length.
  await assertInvalidArgs(h, "generate_sheet_json", { prompt: "" }, /too_small/);

  assert.deepEqual(stub.requests, [], "a refused call still reached the API");
});
