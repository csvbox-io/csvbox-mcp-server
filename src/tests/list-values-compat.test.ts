/**
 * The stricter list-value validation must not break flows that used to work:
 * LLM output with the wrong list shape is repaired deterministically (not aborted),
 * a sheet read back with get_sheet is still usable as context for function
 * generation, and caller-supplied sheets are never silently rewritten.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeListValues } from "../schemas/normalize-list-values.js";
import { generateSheetSmart } from "../prompts/schema-generator.js";
import { generateFunctionsSmart } from "../prompts/functions-generator.js";
import { validateSheet } from "../tools/validate-schema.js";
import { fakeLlm, jsonResponse } from "./support/fake-llm.js";
import { emptyEnv } from "./support/env.js";

const ENV = emptyEnv();

const col = (type: string, values: unknown, name = "c") => ({
  column_name: name,
  display_label: name,
  type,
  position: 1,
  validators: { values },
});

test("string list values become { value } objects, at every nesting level", () => {
  const out = normalizeListValues({
    title: "T",
    sheet_columns: [
      col("list", ["free", { value: "in", dependents: ["mh", { value: "gj" }] }]),
    ],
  }) as any;
  assert.deepEqual(out.sheet_columns[0].validators.values, [
    { value: "free" },
    { value: "in", dependents: [{ value: "mh" }, { value: "gj" }] },
  ]);
});

test("multiselect_list objects become plain strings", () => {
  const out = normalizeListValues({
    sheet_columns: [col("multiselect_list", [{ value: "Red" }, "Green"])],
  }) as any;
  assert.deepEqual(out.sheet_columns[0].validators.values, ["Red", "Green"]);
});

test("correct shapes, other types and non-sheets pass through untouched", () => {
  const good = {
    sheet_columns: [
      col("list", [{ value: "a", display_label: "A" }], "l"),
      col("multiselect_list", ["x"], "m"),
      { column_name: "t", display_label: "T", type: "text", position: 3 },
    ],
  };
  assert.deepEqual(normalizeListValues(good), good);
  assert.equal(normalizeListValues(null), null);
  assert.equal(normalizeListValues("x"), "x");
  assert.deepEqual(normalizeListValues({ title: "no columns" }), { title: "no columns" });
});

test("the input object is not mutated", () => {
  const input = { sheet_columns: [col("list", ["a"])] };
  const snapshot = JSON.stringify(input);
  normalizeListValues(input);
  assert.equal(JSON.stringify(input), snapshot);
});

test("a very deep nest cannot overflow the stack", () => {
  let node: unknown = "leaf";
  for (let i = 0; i < 5000; i++) node = { value: `v${i}`, dependents: [node] };
  assert.doesNotThrow(() =>
    normalizeListValues({ sheet_columns: [col("list", [node])] })
  );
});

test("generation with string list values succeeds without a repair call", async () => {
  const llm = fakeLlm(
    jsonResponse({
      title: "Orders",
      sheet_columns: [
        col("list", ["draft", "approved"], "status"),
        { ...col("multiselect_list", [{ value: "a" }], "tags"), position: 2 },
      ],
    })
  );

  const result = await generateSheetSmart("orders importer", ENV, llm);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.validation.valid, true, result.validation.errors.join(" | "));
  assert.equal(llm.calls, 1, "a shape slip must not cost a repair round-trip");
  const cols = (result.sheet as any).sheet_columns;
  assert.deepEqual(cols[0].validators.values, [{ value: "draft" }, { value: "approved" }]);
  assert.deepEqual(cols[1].validators.values, ["a"]);
});

test("function generation accepts a get_sheet-shaped context sheet", async () => {
  // The API reads multiselect_list values back as objects.
  const context = {
    title: "S",
    sheet_columns: [
      col("text", undefined, "name"),
      { ...col("multiselect_list", [{ value: "a" }, { value: "b" }], "tags"), position: 2 },
    ],
  };
  const llm = fakeLlm(
    jsonResponse({ virtual_columns: [{ column_name: "upper", js_code: "return 1;" }] })
  );

  const result = await generateFunctionsSmart("add a virtual column", context, ENV, llm);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.validation.valid, true, result.validation.errors.join(" | "));
  assert.equal(llm.calls, 1);
});

test("validate_schema still reports a caller's wrong shape instead of rewriting it", () => {
  const sheet = { title: "T", sheet_columns: [col("list", ["a", "b"])] };
  const before = JSON.stringify(sheet);
  const result = validateSheet(sheet);
  assert.equal(result.valid, false);
  assert.equal(JSON.stringify(sheet), before);
});
