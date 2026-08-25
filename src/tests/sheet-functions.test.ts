/**
 * Tests for virtual_columns / validation_functions / data_transforms:
 * the schema model, the validator (references, names, caps, dependencies,
 * verb modes), and LLM-backed function authoring.
 *
 * Same conventions as expansion.test.ts: node:test + node:assert, LLM mocked.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SheetSchema,
  VirtualColumnSchema,
  ValidationFunctionSchema,
  DataTransformSchema,
  JsDependencySchema,
  MAX_JS_CODE_LENGTH,
  MAX_NAME_LENGTH,
} from "../schemas/csvbox-schemas.js";
import { validateSheet } from "../tools/validate-schema.js";
import { generateFunctionsSmart } from "../prompts/functions-generator.js";
import { FUNCTIONS_SYSTEM_PROMPT } from "../prompts/functions-system-prompt.js";
import { SHEET_SYSTEM_PROMPT } from "../prompts/sheet-system-prompt.js";
import type { CompleteResult } from "../services/llm-client.js";
import { fakeLlm } from "./support/fake-llm.js";
import { baseSheet, goodDependency } from "./support/fixtures.js";

/** Errors mentioning a given substring, for readable assertions. */
function matching(list: string[], needle: string): string[] {
  return list.filter((m) => m.includes(needle));
}

// --- 8.1 Schema model -----------------------------------------------------

test("each collection parses minimal and full items", () => {
  assert.equal(
    VirtualColumnSchema.safeParse({ column_name: "full_name", js_code: "return 1;" })
      .success,
    true
  );
  assert.equal(
    ValidationFunctionSchema.safeParse({
      function_name: "check_email",
      scope: "column",
      columns: ["email"],
      dynamic_columns: [],
      js_code: "return [];",
      active: true,
      dependencies: [goodDependency],
    }).success,
    true
  );
  assert.equal(
    DataTransformSchema.safeParse({
      transform_name: "trim",
      scope: "row",
      run_at: "after_validation",
      js_code: "return csvbox;",
    }).success,
    true
  );
  assert.equal(JsDependencySchema.safeParse({ url: goodDependency.url }).success, true);
});

test("bad scope and run_at are rejected by the schema", () => {
  assert.equal(
    ValidationFunctionSchema.safeParse({ function_name: "f", scope: "sheet" }).success,
    false
  );
  assert.equal(
    DataTransformSchema.safeParse({ transform_name: "t", run_at: "after_import" })
      .success,
    false
  );
});

test("unknown keys pass through and a functions-free sheet is unaffected", () => {
  const parsed = VirtualColumnSchema.safeParse({
    column_name: "vc",
    js_code: "return 1;",
    some_future_field: 42,
  });
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal((parsed.data as Record<string, unknown>).some_future_field, 42);
  }
  assert.equal(SheetSchema.safeParse(baseSheet).success, true);
});

test("sheet schema accepts all three collections together", () => {
  const result = SheetSchema.safeParse({
    ...baseSheet,
    virtual_columns: [{ column_name: "full_name", js_code: "return 1;" }],
    validation_functions: [{ function_name: "f", js_code: "return [];" }],
    data_transforms: [{ transform_name: "t", js_code: "return csvbox;" }],
  });
  assert.equal(result.success, true);
});

// --- 8.2 Validator: references and names ----------------------------------

test("dangling columns reference errors, dynamic_columns does not", () => {
  const dangling = validateSheet({
    ...baseSheet,
    validation_functions: [
      { function_name: "f", columns: ["nope"], js_code: "return [];" },
    ],
  });
  assert.equal(dangling.valid, false);
  assert.equal(matching(dangling.errors, 'references "nope"').length, 1);

  const dynamic = validateSheet({
    ...baseSheet,
    data_transforms: [
      { transform_name: "t", dynamic_columns: ["runtime_only"], js_code: "return csvbox;" },
    ],
  });
  assert.equal(dynamic.valid, true);
});

test("missing sheet_columns warns instead of erroring on references", () => {
  const result = validateSheet(
    {
      validation_functions: [
        { function_name: "f", columns: ["email"], js_code: "return [];" },
      ],
    },
    "patch"
  );
  assert.equal(result.valid, true);
  assert.equal(matching(result.warnings, "could not be checked").length, 1);
});

test("overlap between columns and dynamic_columns warns", () => {
  const result = validateSheet({
    ...baseSheet,
    data_transforms: [
      {
        transform_name: "t",
        columns: ["email"],
        dynamic_columns: ["email"],
        js_code: "return csvbox;",
      },
    ],
  });
  assert.equal(result.valid, true);
  assert.equal(matching(result.warnings, "both columns and dynamic_columns").length, 1);
});

test("duplicate identifiers and virtual/real collisions error", () => {
  const dupes = validateSheet({
    ...baseSheet,
    validation_functions: [
      { function_name: "same", js_code: "return [];" },
      { function_name: "same", js_code: "return [];" },
    ],
  });
  assert.equal(dupes.valid, false);
  assert.equal(matching(dupes.errors, 'duplicate function_name "same"').length, 1);

  const collision = validateSheet({
    ...baseSheet,
    virtual_columns: [{ column_name: "email", js_code: "return 1;" }],
  });
  assert.equal(collision.valid, false);
  assert.equal(matching(collision.errors, "collides with a sheet_columns").length, 1);
});

// --- 8.3 Validator: caps and size limits ----------------------------------

test("per-sheet caps are enforced for each collection", () => {
  const many = (n: number, id: string, prefix: string) =>
    Array.from({ length: n }, (_, i) => ({ [id]: `${prefix}${i}`, js_code: "return 1;" }));

  const vc = validateSheet({ ...baseSheet, virtual_columns: many(21, "column_name", "v") });
  assert.equal(matching(vc.errors, "at most 20 per sheet").length, 1);

  const vf = validateSheet({
    ...baseSheet,
    validation_functions: many(11, "function_name", "f"),
  });
  assert.equal(matching(vf.errors, "at most 10 per sheet").length, 1);

  const dt = validateSheet({
    ...baseSheet,
    data_transforms: many(11, "transform_name", "t"),
  });
  assert.equal(matching(dt.errors, "at most 10 per sheet").length, 1);
});

test("oversized js_code, identifiers, dependencies and globals error", () => {
  const result = validateSheet({
    ...baseSheet,
    virtual_columns: [
      { column_name: "a".repeat(MAX_NAME_LENGTH + 1), js_code: "return 1;" },
      { column_name: "big", js_code: "x".repeat(MAX_JS_CODE_LENGTH + 1) },
      {
        column_name: "deps",
        js_code: "return 1;",
        dependencies: Array.from({ length: 6 }, () => goodDependency),
      },
      {
        column_name: "globs",
        js_code: "return 1;",
        dependencies: [{ ...goodDependency, globals: ["a", "b", "c", "d", "e", "f"] }],
      },
    ],
  });
  assert.equal(result.valid, false);
  assert.equal(matching(result.errors, `exceeds ${MAX_NAME_LENGTH} characters`).length, 1);
  assert.equal(matching(result.errors, `the limit is ${MAX_JS_CODE_LENGTH}`).length, 1);
  assert.equal(matching(result.errors, "dependencies declared; the limit is 5").length, 1);
  assert.equal(matching(result.errors, "globals; the limit is 5").length, 1);
});

test("missing js_code errors unless the item is a delete", () => {
  const missing = validateSheet({
    ...baseSheet,
    virtual_columns: [{ column_name: "vc" }],
  });
  assert.equal(matching(missing.errors, "missing js_code").length, 1);

  const deleting = validateSheet(
    { virtual_columns: [{ column_name: "vc", _delete: true }] },
    "patch"
  );
  assert.equal(matching(deleting.errors, "missing js_code").length, 0);
});

test("unknown enum values are rejected with the allowed list", () => {
  const result = validateSheet({
    ...baseSheet,
    data_transforms: [
      { transform_name: "t", run_at: "after_import", js_code: "return csvbox;" },
    ],
  });
  assert.equal(result.valid, false);
  assert.equal(
    matching(result.errors, "before_validation, after_validation").length,
    1
  );
});

// --- 8.4 Validator: dependencies ------------------------------------------

test("dependency URL rules are enforced", () => {
  const bad = [
    { url: "https://evil.example.com/x.js", integrity: goodDependency.integrity },
    { url: "http://cdn.jsdelivr.net/x.js", integrity: goodDependency.integrity },
    { url: "https://cdn.jsdelivr.net/x.js?v=1", integrity: goodDependency.integrity },
    { url: "https://cdn.jsdelivr.net/x.txt", integrity: goodDependency.integrity },
    { ...goodDependency, globals: ["9bad"] },
    { url: goodDependency.url, integrity: "md5-abc" },
  ];
  const result = validateSheet({
    ...baseSheet,
    virtual_columns: bad.map((dep, i) => ({
      column_name: `vc${i}`,
      js_code: "return 1;",
      dependencies: [dep],
    })),
  });
  assert.equal(result.valid, false);
  assert.equal(matching(result.errors, "is not allowed. Allowed hosts").length, 1);
  assert.equal(matching(result.errors, "must use https").length, 1);
  assert.equal(matching(result.errors, "must not contain a query string").length, 1);
  assert.equal(matching(result.errors, "must end in .js or .mjs").length, 1);
  assert.equal(matching(result.errors, "not a valid JavaScript identifier").length, 1);
  assert.equal(matching(result.errors, "followed by base64").length, 1);
});

test("a dependency without integrity warns but stays valid", () => {
  const result = validateSheet({
    ...baseSheet,
    virtual_columns: [
      {
        column_name: "vc",
        js_code: "return 1;",
        dependencies: [{ url: goodDependency.url, globals: ["dayjs"] }],
      },
    ],
  });
  assert.equal(result.valid, true);
  assert.equal(matching(result.warnings, "no integrity digest").length, 1);
});

// --- 8.5 Validator: verb modes --------------------------------------------

test("empty array errors under put and warns otherwise", () => {
  const put = validateSheet({ ...baseSheet, virtual_columns: [] }, "put");
  assert.equal(put.valid, false);
  assert.equal(matching(put.errors, "delete every item").length, 1);

  const patch = validateSheet({ ...baseSheet, virtual_columns: [] }, "patch");
  assert.equal(patch.valid, true);
  assert.equal(matching(patch.warnings, "a partial update ignores it").length, 1);

  const create = validateSheet({ ...baseSheet, virtual_columns: [] });
  assert.equal(create.valid, true);
  assert.equal(matching(create.warnings, "Omit the key instead").length, 1);
});

test("_delete is an error on create, a warning on put, and fully valid on patch", () => {
  const item = { column_name: "vc", js_code: "return 1;", _delete: true };

  const created = validateSheet({ ...baseSheet, virtual_columns: [item] });
  assert.equal(matching(created.errors, "_delete is only valid").length, 1);
  assert.equal(matching(created.warnings, "_delete is redundant").length, 0);

  const put = validateSheet({ ...baseSheet, virtual_columns: [item] }, "put");
  assert.equal(matching(put.errors, "_delete is only valid").length, 0);
  assert.equal(matching(put.warnings, "_delete is redundant").length, 1);
  assert.equal(put.valid, true);

  const patched = validateSheet({ ...baseSheet, virtual_columns: [item] }, "patch");
  assert.equal(matching(patched.errors, "_delete is only valid").length, 0);
  assert.equal(matching(patched.warnings, "_delete is redundant").length, 0);
});

test("_delete on put still requires js_code", () => {
  const result = validateSheet(
    { ...baseSheet, virtual_columns: [{ column_name: "vc", _delete: true }] },
    "put"
  );
  assert.equal(result.valid, false);
  assert.equal(matching(result.errors, "missing js_code").length, 1);
  assert.equal(matching(result.warnings, "_delete is redundant").length, 1);
});

test("omitted collections are never flagged in any mode", () => {
  (["create", "put", "patch"] as const).forEach((mode) => {
    const result = validateSheet(baseSheet, mode);
    assert.equal(result.valid, true, mode);
    assert.deepEqual(result.warnings, [], mode);
  });
});

test("default mode on a functions-free sheet matches the pre-change result", () => {
  assert.deepEqual(validateSheet(baseSheet), {
    valid: true,
    errors: [],
    warnings: [],
  });
  // The pre-existing advisory still fires when no positions are set.
  assert.deepEqual(validateSheet({ title: "T", sheet_columns: [] }), {
    valid: true,
    errors: [],
    warnings: ["sheet_columns is empty; no columns to validate yet."],
  });
  assert.deepEqual(validateSheet({ sheet_columns: [] }), {
    valid: false,
    errors: ["title is required and must be a non-empty string."],
    warnings: ["sheet_columns is empty; no columns to validate yet."],
  });
});

test("title is not required on a patch fragment but must be non-empty when present", () => {
  assert.equal(validateSheet({ data_transforms: [] }, "patch").valid, true);
  assert.equal(validateSheet({ title: "" }, "patch").valid, false);
});

// --- Prompt wiring --------------------------------------------------------

test("functions prompt carries all three js_code contracts", () => {
  assert.match(FUNCTIONS_SYSTEM_PROMPT, /RETURNS THE COMPUTED CELL VALUE/);
  assert.match(FUNCTIONS_SYSTEM_PROMPT, /RETURNS AN ARRAY OF ERROR STRINGS/);
  assert.match(FUNCTIONS_SYSTEM_PROMPT, /MUTATES the csvbox object and MUST RETURN IT/);
  // The row-vs-column accessor distinction is the easiest thing to get wrong.
  assert.match(FUNCTIONS_SYSTEM_PROMPT, /csvbox\.row\.<name>, which is a SCALAR/);
  assert.match(FUNCTIONS_SYSTEM_PROMPT, /csvbox\.column\.<name>, which is an ARRAY/);
  assert.match(FUNCTIONS_SYSTEM_PROMPT, /cdn\.jsdelivr\.net/);
});

test("sheet prompt gains the empty-array guard but no function authoring", () => {
  assert.match(SHEET_SYSTEM_PROMPT, /NEVER emit any of them as an empty array/);
  assert.doesNotMatch(SHEET_SYSTEM_PROMPT, /RETURNS AN ARRAY OF ERROR STRINGS/);
});

// --- 8.6 Generation with a mocked model -----------------------------------

test("a virtual-column request yields virtual_columns and calls no API", async () => {
  const llm = fakeLlm({
    truncated: false,
    text: JSON.stringify({
      virtual_columns: [
        {
          column_name: "full_name",
          js_code: "return (csvbox.row.first_name + ' ' + csvbox.row.last_name).trim();",
          active: true,
        },
      ],
    }),
  });
  const result = await generateFunctionsSmart(
    "join first and last name",
    baseSheet,
    {},
    llm
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.validation.valid, true);
  assert.equal(result.functions.virtual_columns?.[0].column_name, "full_name");
  assert.equal(llm.calls, 1);
});

test("unrequested collections are omitted, not returned empty", async () => {
  const llm = fakeLlm({
    truncated: false,
    text: JSON.stringify({
      virtual_columns: [],
      validation_functions: [],
      data_transforms: [
        {
          transform_name: "trim_email",
          scope: "column",
          run_at: "before_validation",
          columns: ["email"],
          js_code: "csvbox.column.email = csvbox.column.email.map(function (v) { return String(v).trim(); }); return csvbox;",
        },
      ],
    }),
  });
  const result = await generateFunctionsSmart("trim the email column", baseSheet, {}, llm);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(!("virtual_columns" in result.functions));
  assert.ok(!("validation_functions" in result.functions));
  assert.equal(result.functions.data_transforms?.length, 1);
});

test("generated output is validated against the supplied sheet", async () => {
  const llm = fakeLlm({
    truncated: false,
    text: JSON.stringify({
      validation_functions: [
        { function_name: "f", columns: ["not_a_column"], js_code: "return [];" },
      ],
    }),
  });
  const result = await generateFunctionsSmart("validate something", baseSheet, {}, llm);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.validation.valid, false);
  assert.equal(matching(result.validation.errors, 'references "not_a_column"').length, 1);
  // One repair attempt was made before giving up.
  assert.equal(llm.calls, 2);
});

test("without a sheet, references are unchecked and a warning says so", async () => {
  const llm = fakeLlm({
    truncated: false,
    text: JSON.stringify({
      validation_functions: [
        { function_name: "f", columns: ["email"], js_code: "return [];" },
      ],
    }),
  });
  const result = await generateFunctionsSmart("validate email", undefined, {}, llm);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.validation.valid, true);
  assert.equal(matching(result.validation.warnings, "could not be checked").length, 1);
});

test("truncated response yields TRUNCATED with no partial functions", async () => {
  const llm = fakeLlm({ truncated: true, text: '{"virtual_columns":[{"column' });
  const result = await generateFunctionsSmart("many functions", baseSheet, {}, llm);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "TRUNCATED");
  assert.equal(llm.calls, 1);
});

test("no configured provider points at the MCP prompt", async () => {
  const result = await generateFunctionsSmart("anything", baseSheet, {});
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "NO_LLM_PROVIDER");
  assert.match(result.message, /csvbox_sheet_functions/);
});
