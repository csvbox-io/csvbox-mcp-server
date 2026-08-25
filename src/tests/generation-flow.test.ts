/**
 * Control flow of both generation pipelines, with a scripted model.
 *
 * The retry is the part worth pinning: exactly one repair attempt, carrying the
 * validation errors, and never a third call. `scriptedLlm` throws on an
 * unscripted call, so an extra request fails the test rather than passing
 * silently.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { generateSheetSmart } from "../prompts/schema-generator.js";
import { generateFunctionsSmart } from "../prompts/functions-generator.js";
import { fakeLlm, scriptedLlm, jsonResponse } from "./support/fake-llm.js";
import { emptyEnv, withCleanEnv } from "./support/env.js";
import { createHttpStub } from "./support/http-stub.js";
import { connectHarness } from "./support/mcp-harness.js";
import { baseSheet } from "./support/fixtures.js";

const ENV = emptyEnv();

const VALID_SHEET = {
  title: "Customers",
  sheet_columns: [
    { column_name: "email", display_label: "Email", type: "email", position: 1 },
  ],
};

/** Fails validation: no title. */
const INVALID_SHEET = {
  sheet_columns: [
    { column_name: "email", display_label: "Email", type: "email", position: 1 },
  ],
};

const VALID_FUNCTIONS = {
  virtual_columns: [{ column_name: "vc", js_code: "return 1;" }],
};

/** Fails validation: references a column that is not on `baseSheet`. */
const INVALID_FUNCTIONS = {
  validation_functions: [
    { function_name: "vf", js_code: "return [];", columns: ["ghost_column"] },
  ],
};

// --- 10.1 Truncation ------------------------------------------------------

test("a truncated first response is reported without parsing, in both pipelines", async () => {
  const sheetLlm = scriptedLlm([
    { truncated: true, text: '{"title":"ERP","sheet_columns":[{"column' },
  ]);
  const sheet = await generateSheetSmart("big erp", ENV, sheetLlm);
  assert.equal(sheet.ok, false);
  if (sheet.ok) return;
  assert.equal(sheet.reason, "TRUNCATED");
  assert.match(sheet.raw, /^\{"title":"ERP"/);
  assert.match(sheet.message, /cut off by the output token limit/);
  assert.equal(sheetLlm.calls, 1, "truncation must not trigger a retry");

  const fnLlm = scriptedLlm([{ truncated: true, text: '{"virtual_columns":[{' }]);
  const functions = await generateFunctionsSmart("add a column", baseSheet, ENV, fnLlm);
  assert.equal(functions.ok, false);
  if (functions.ok) return;
  assert.equal(functions.reason, "TRUNCATED");
  assert.equal(fnLlm.calls, 1);
});

// --- 10.2 Parse failure ---------------------------------------------------

test("an unparseable first response is a parse error with no retry", async () => {
  const sheetLlm = scriptedLlm([{ truncated: false, text: "I cannot help with that." }]);
  const sheet = await generateSheetSmart("customers", ENV, sheetLlm);
  assert.equal(sheet.ok, false);
  if (sheet.ok) return;
  assert.equal(sheet.reason, "PARSE_ERROR");
  assert.equal(sheet.raw, "I cannot help with that.");
  assert.match(sheet.message, /did not return valid JSON/);
  assert.equal(sheetLlm.calls, 1, "a parse error must not trigger a retry");

  const fnLlm = scriptedLlm([{ truncated: false, text: "nope" }]);
  const functions = await generateFunctionsSmart("add a column", baseSheet, ENV, fnLlm);
  assert.equal(functions.ok, false);
  if (functions.ok) return;
  assert.equal(functions.reason, "PARSE_ERROR");
  assert.equal(fnLlm.calls, 1);
});

// --- 10.3 Exactly one repair attempt --------------------------------------

test("invalid output triggers one repair carrying the validation errors", async () => {
  const llm = scriptedLlm([
    jsonResponse(INVALID_SHEET),
    jsonResponse(VALID_SHEET),
  ]);

  const result = await generateSheetSmart("customer importer", ENV, llm);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.validation.valid, true);
  assert.equal(result.sheet.title, "Customers");
  assert.equal(llm.calls, 2, "expected exactly one repair attempt");

  // The first call is the plain prompt; the second appends the errors.
  assert.equal(llm.log[0].user, "customer importer");
  assert.match(llm.log[1].user, /^customer importer/);
  assert.match(llm.log[1].user, /title is required/);
  assert.equal(llm.log[0].system, llm.log[1].system, "the system prompt must not change");
});

test("the functions pipeline repairs the same way", async () => {
  const llm = scriptedLlm([
    jsonResponse(INVALID_FUNCTIONS),
    jsonResponse(VALID_FUNCTIONS),
  ]);

  const result = await generateFunctionsSmart("add a column", baseSheet, ENV, llm);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.validation.valid, true);
  assert.equal(llm.calls, 2);
  assert.match(llm.log[1].user, /ghost_column/);
});

test("valid first output means no repair at all", async () => {
  const llm = scriptedLlm([jsonResponse(VALID_SHEET)]);
  const result = await generateSheetSmart("customers", ENV, llm);
  assert.equal(result.ok, true);
  assert.equal(llm.calls, 1);
});

// --- 10.4 / 10.5 Repair attempt fails -------------------------------------

test("an unparseable repair is reported as such, with no third call", async () => {
  const llm = scriptedLlm([
    jsonResponse(INVALID_SHEET),
    { truncated: false, text: "still not JSON" },
  ]);

  const result = await generateSheetSmart("customers", ENV, llm);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "PARSE_ERROR");
  assert.match(result.message, /repair attempt did not return valid JSON/);
  assert.equal(result.raw, "still not JSON");
  assert.equal(llm.calls, 2, "there must be no third call");
});

test("a truncated repair is reported as truncated, with no third call", async () => {
  const llm = scriptedLlm([
    jsonResponse(INVALID_SHEET),
    { truncated: true, text: '{"title":"Cus' },
  ]);

  const result = await generateSheetSmart("customers", ENV, llm);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "TRUNCATED");
  assert.equal(llm.calls, 2);
});

// --- 10.6 Repair still invalid --------------------------------------------

test("a repair that is still invalid returns the report rather than an opaque failure", async () => {
  const llm = scriptedLlm([
    jsonResponse(INVALID_SHEET),
    jsonResponse(INVALID_SHEET),
  ]);

  const result = await generateSheetSmart("customers", ENV, llm);

  assert.equal(result.ok, true, "the caller must still receive the sheet and the report");
  if (!result.ok) return;
  assert.equal(result.validation.valid, false);
  assert.ok(result.validation.errors.some((e) => e.includes("title is required")));
  assert.equal(llm.calls, 2, "only one repair attempt is allowed");
});

// --- 10.7 No provider -----------------------------------------------------

test("no provider yields NO_LLM_PROVIDER with zero model calls", async () => {
  const sheet = await generateSheetSmart("customers", ENV);
  assert.equal(sheet.ok, false);
  if (sheet.ok) return;
  assert.equal(sheet.reason, "NO_LLM_PROVIDER");
  assert.match(sheet.message, /create_csvbox_sheet/);
  assert.match(sheet.message, /ANTHROPIC_API_KEY or OPENAI_API_KEY/);

  const functions = await generateFunctionsSmart("add a column", baseSheet, ENV);
  assert.equal(functions.ok, false);
  if (functions.ok) return;
  assert.equal(functions.reason, "NO_LLM_PROVIDER");
  assert.match(functions.message, /csvbox_sheet_functions/);
});

// --- 10.8 Source string ---------------------------------------------------

test("source names the provider and model for both pipelines", async () => {
  const sheet = await generateSheetSmart(
    "customers",
    ENV,
    fakeLlm(jsonResponse(VALID_SHEET))
  );
  assert.equal(sheet.ok, true);
  if (!sheet.ok) return;
  assert.equal(sheet.source, "llm:anthropic:mock");

  const functions = await generateFunctionsSmart(
    "add a column",
    baseSheet,
    ENV,
    fakeLlm(jsonResponse(VALID_FUNCTIONS))
  );
  assert.equal(functions.ok, true);
  if (!functions.ok) return;
  assert.equal(functions.source, "llm:anthropic:mock");
});

// --- 10.9 Functions without a sheet ---------------------------------------

test("without a sheet the user turn says so and references go unchecked", async () => {
  const llm = fakeLlm(
    jsonResponse({
      validation_functions: [
        { function_name: "vf", js_code: "return [];", columns: ["anything"] },
      ],
    })
  );

  const result = await generateFunctionsSmart("validate emails", undefined, ENV, llm);

  assert.match(llm.log[0].user, /Not supplied/);
  assert.match(llm.log[0].user, /do not invent others/);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.validation.valid, true, "a dangling reference must not error here");
  assert.ok(
    result.validation.warnings.some((w) => w.includes("could not be checked")),
    `expected the unchecked-references warning, got: ${result.validation.warnings.join(" | ")}`
  );
  assert.equal(llm.calls, 1);
});

test("with a sheet, the sheet JSON is embedded in the user turn", async () => {
  const llm = fakeLlm(jsonResponse(VALID_FUNCTIONS));
  await generateFunctionsSmart("add a column", baseSheet, ENV, llm);
  assert.match(llm.log[0].user, /## Existing sheet/);
  assert.ok(llm.log[0].user.includes(JSON.stringify(baseSheet)));
});

// --- 10.10 Generation never writes ----------------------------------------

test("no generation path issues a CSVBox request", async (t) => {
  const stub = createHttpStub();
  stub.install();
  t.after(() => stub.restore());

  await generateSheetSmart("customers", ENV, fakeLlm(jsonResponse(VALID_SHEET)));
  await generateSheetSmart("customers", ENV, fakeLlm(jsonResponse(INVALID_SHEET)));
  await generateSheetSmart("customers", ENV, fakeLlm({ truncated: true, text: "{" }));
  await generateFunctionsSmart(
    "add a column",
    baseSheet,
    ENV,
    fakeLlm(jsonResponse(VALID_FUNCTIONS))
  );

  assert.deepEqual(stub.requests, [], "a generation call reached the API");
});

test("create_importer_from_prompt aborts before the API when output is invalid", async (t) => {
  const stub = createHttpStub();
  stub.install();
  const h = await connectHarness();
  t.after(async () => {
    await h.close();
    stub.restore();
  });

  // The tool resolves its own LLM from the environment, so drive it through the
  // no-provider path — the abort-before-API guard is the same code path, and it
  // is the only one reachable without a real key.
  const { json, isError } = await withCleanEnv({}, () =>
    h.callJson("create_importer_from_prompt", { prompt: "customer importer" })
  );

  assert.equal(isError, true);
  assert.equal(json.api_response, null);
  assert.deepEqual(stub.requests, [], "the API was called despite an abort");
});

test("the generated schema is what the pipeline returns, unmodified", async () => {
  const sheet = {
    title: "Procurement",
    sheet_columns: [
      {
        column_name: "supplier_gstin",
        display_label: "Supplier GSTIN",
        type: "regex",
        position: 1,
        validators: { expression: "^[0-9]{2}$" },
      },
    ],
    steps: { upload: { enabled: true } },
    security_settings: { allowed_domains: ["example.com"] },
  };

  const result = await generateSheetSmart(
    "procurement importer",
    ENV,
    fakeLlm(jsonResponse(sheet))
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.sheet,
    sheet,
    "the pipeline must not add, drop or reorder anything"
  );
});
