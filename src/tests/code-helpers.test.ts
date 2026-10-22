/**
 * Local tools (generate_webhook_handler, generate_sample_csv), the two new prompts
 * and the resources. None of these execute js_code.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { connectHarness } from "./support/mcp-harness.js";
import { createHttpStub } from "./support/http-stub.js";
import { withCleanEnv } from "./support/env.js";
import { buildSampleCsv } from "../tools/generate-sample-csv.js";
import { redactSecrets } from "../resources/csvbox-resources.js";
import {
  buildWebhookHandler,
  WEBHOOK_FRAMEWORKS,
  WEBHOOK_KINDS,
} from "../tools/generate-webhook-handler.js";

const CREDS = { CSVBOX_API_KEY: "key-abc", CSVBOX_API_SECRET: "secret-xyz" };

const sheet = {
  sheet_columns: [
    { column_name: "name", display_label: "Name", type: "text", required: true },
    { column_name: "email", display_label: "Email", type: "email" },
    { column_name: "plan", display_label: "Plan", type: "list", validators: { values: ["free", "pro"] } },
    { column_name: "age", display_label: "Age", type: "number", validators: { min_value: 18, max_value: 99 } },
    { column_name: "code", display_label: "Code", type: "regex", validators: { expression: "^[A-Z]{3}$" } },
  ],
  virtual_columns: [{ column_name: "v", js_code: "throw new Error('must never run')" }],
};

// --- webhook handler -----------------------------------------------------

test("every framework and kind yields code, with and without signature checks", () => {
  for (const framework of WEBHOOK_FRAMEWORKS) {
    for (const kind of WEBHOOK_KINDS) {
      for (const verifySignature of [false, true]) {
        const { code, notes } = buildWebhookHandler(framework, { kind, verifySignature });
        assert.ok(code.length > 100, `${framework}/${kind} produced no code`);
        assert.equal(
          /x-csvbox-signature/.test(code),
          verifySignature,
          `${framework}/${kind} signature check mismatch`
        );
        assert.ok(notes.length > 0);
      }
    }
  }
});

test("handlers compare signatures in constant time", () => {
  const expectations: Record<string, RegExp> = {
    express: /timingSafeEqual/,
    nextjs: /timingSafeEqual/,
    django: /compare_digest/,
    laravel: /hash_equals/,
  };
  for (const framework of WEBHOOK_FRAMEWORKS) {
    const { code } = buildWebhookHandler(framework, { kind: "import_complete", verifySignature: true });
    assert.match(code, expectations[framework]);
  }
});

test("generate_webhook_handler rejects an unknown framework", async (t) => {
  const h = await connectHarness();
  t.after(() => h.close());
  const result = await h.callRaw("generate_webhook_handler", { framework: "rails" });
  assert.equal(result.isError, true);
});

// --- sample csv ------------------------------------------------------------

test("sample csv has the requested rows and one broken cell per invalid row", () => {
  const out = buildSampleCsv(sheet, 3, 4);
  const lines = out.csv.trimEnd().split("\n");
  assert.equal(lines.length, 1 + 3 + 4);
  assert.deepEqual(out.header, ["Name", "Email", "Plan", "Age", "Code"]);
  assert.equal(out.expected_failures.length, 4);
  assert.deepEqual(
    out.expected_failures.map((f) => f.row),
    [4, 5, 6, 7]
  );
  assert.deepEqual(
    out.expected_failures.map((f) => f.column),
    ["name", "email", "plan", "age"]
  );
  assert.ok(out.warnings.some((w) => w.includes('"code"')), "regex column is flagged");
});

test("valid rows satisfy list and number rules", () => {
  const out = buildSampleCsv(sheet, 4, 0);
  const rows = out.csv.trimEnd().split("\n").slice(1).map((l) => l.split(","));
  for (const r of rows) {
    assert.ok(["free", "pro"].includes(r[2]));
    assert.ok(Number(r[3]) >= 18 && Number(r[3]) <= 99);
    assert.match(r[1], /@example\.com$/);
  }
  assert.equal(out.expected_failures.length, 0);
});

test("cells containing commas or quotes are escaped", () => {
  const out = buildSampleCsv(
    { sheet_columns: [{ column_name: "n", display_label: 'Na"me, x', type: "text" }] },
    1,
    0
  );
  assert.ok(out.csv.startsWith('"Na""me, x"\n'));
});

test("a sheet with no rule to break yields no invalid rows and a warning", () => {
  const out = buildSampleCsv({ sheet_columns: [{ column_name: "n", type: "text" }] }, 2, 3);
  assert.equal(out.invalid_rows, 0);
  assert.equal(out.expected_failures.length, 0);
  assert.ok(out.warnings.some((w) => /invalid rows/.test(w)));
});

test("js_code is never evaluated while building a sample", () => {
  assert.doesNotThrow(() => buildSampleCsv(sheet, 2, 2));
});

test("generate_sample_csv needs a sheet or a key, and reads the key through get_sheet", async (t) => {
  const stub = createHttpStub();
  stub.install();
  const h = await connectHarness();
  t.after(async () => {
    await h.close();
    stub.restore();
  });

  const none = await h.callJson("generate_sample_csv", {});
  assert.equal(none.isError, true);

  stub.script({ kind: "response", status: 200, data: sheet });
  const viaKey = await withCleanEnv(CREDS, () =>
    h.callJson("generate_sample_csv", { sheet_license_key: "lic", valid_rows: 2, invalid_rows: 1 })
  );
  assert.equal(viaKey.isError, false);
  assert.equal(viaKey.json.expected_failures.length, 1);
  assert.equal(stub.requests[0].url, "/1.1/sheet/lic");

  stub.script({ kind: "httpError", status: 404, data: { errors: "Sheet does not exist." } });
  const missing = await withCleanEnv(CREDS, () =>
    h.callJson("generate_sample_csv", { sheet_license_key: "nope" })
  );
  assert.equal(missing.isError, true);
});

// --- prompts ---------------------------------------------------------------

test("debug_failed_import names the read tools and withholds writes until approval", async (t) => {
  const h = await connectHarness();
  t.after(() => h.close());

  const withId = await h.client.getPrompt({ name: "debug_failed_import", arguments: { import_id: "77" } });
  const text = (withId.messages[0].content as { text: string }).text;
  assert.match(text, /import id is 77/);
  for (const tool of ["get_import", "get_import_errors", "get_sheet", "validate_schema"]) {
    assert.match(text, new RegExp(tool));
  }
  assert.match(text, /summary\.likely_cause/);
  assert.match(text, /summary\.note/);
  assert.match(text, /"unknown" means the cause is not identified/);
  assert.match(text, /Do NOT call `patch_sheet`/);

  const without = await h.client.getPrompt({ name: "debug_failed_import", arguments: {} });
  assert.match((without.messages[0].content as { text: string }).text, /list_imports/);
});

test("migrate_from_flatfile embeds the pasted config and asks before creating", async (t) => {
  const h = await connectHarness();
  t.after(() => h.close());

  const res = await h.client.getPrompt({
    name: "migrate_from_flatfile",
    arguments: { config: "FLATFILE_BLUEPRINT_MARKER" },
  });
  const text = (res.messages[0].content as { text: string }).text;
  assert.match(text, /FLATFILE_BLUEPRINT_MARKER/);
  assert.match(text, /Could not map/);
  assert.match(text, /Do NOT call `create_sheet` until I confirm/);
});

// --- resources ---------------------------------------------------------------

test("redactSecrets removes credential-shaped keys at any depth", () => {
  const out = redactSecrets({
    title: "T",
    destinations: [{ type: "x", api_key: "k", nested: { password: "p", keep: 1 } }],
    signing_secret: "s",
  });
  assert.deepEqual(out, { title: "T", destinations: [{ type: "x", nested: { keep: 1 } }] });
});

test("csvbox://sheets/{key} returns the redacted sheet and errors for an unknown key", async (t) => {
  const stub = createHttpStub();
  stub.install();
  const h = await connectHarness();
  t.after(async () => {
    await h.close();
    stub.restore();
  });

  stub.script({ kind: "response", status: 200, data: { title: "T", webhooks: [{ signing_secret: "s", url: "u" }] } });
  const ok = await withCleanEnv(CREDS, () => h.client.readResource({ uri: "csvbox://sheets/lic" }));
  const body = JSON.parse((ok.contents[0] as { text: string }).text);
  assert.deepEqual(body, { title: "T", webhooks: [{ url: "u" }] });

  stub.script({ kind: "httpError", status: 404, data: { errors: "Sheet does not exist." } });
  await assert.rejects(
    withCleanEnv(CREDS, () => h.client.readResource({ uri: "csvbox://sheets/other" })),
    /Could not read sheet/
  );
});

test("docs resources are listed and readable without credentials", async (t) => {
  const h = await connectHarness();
  t.after(() => h.close());

  const { resources } = await h.client.listResources();
  const uris = resources.map((r) => r.uri).sort();
  assert.deepEqual(uris, ["csvbox://docs/column-types", "csvbox://docs/webhook-payload"]);

  const types = await h.client.readResource({ uri: "csvbox://docs/column-types" });
  assert.match((types.contents[0] as { text: string }).text, /`phone_number`/);
});

test("get_import_errors tells the model to answer from the explained cause", async (t) => {
  const h = await connectHarness();
  t.after(() => h.close());
  const tool = (await h.client.listTools()).tools.find((x) => x.name === "get_import_errors");
  assert.match(tool!.description!, /summary\.likely_cause/);
  assert.match(tool!.description!, /never paraphrase a cause/);
  assert.match(tool!.description!, /total_errors is 0/);
});

// --- list cells use what the importer accepts ---------------------------------

test("a list cell holds the display label when the entry has one, else the value", () => {
  const out = buildSampleCsv(
    {
      sheet_columns: [
        {
          column_name: "plan",
          display_label: "Plan",
          type: "list",
          validators: {
            values: [
              { value: "free", display_label: "Free plan" },
              { value: "pro", display_label: "" },
              { value: "team", display_label: null },
              { value: "extra" },
              { value: "pad", display_label: "   " },
            ],
          },
        },
      ],
    },
    5,
    0
  );
  const cells = out.csv.trimEnd().split("\n").slice(1);
  assert.deepEqual(cells, ["Free plan", "pro", "team", "extra", "pad"]);
});

test("plain-string list values (a multiselect column) are used as they are", () => {
  const out = buildSampleCsv(
    {
      sheet_columns: [
        { column_name: "tags", display_label: "Tags", type: "multiselect_list", validators: { values: ["red", "green"] } },
      ],
    },
    2,
    0
  );
  assert.deepEqual(out.csv.trimEnd().split("\n").slice(1), ["red", "green"]);
});
