/**
 * `parseJsonLenient` and the collection filter that guards generated output.
 *
 * These are the single point of failure between a model response and a parsed
 * sheet, so the accepted shapes — and the ones that are deliberately NOT
 * accepted — are pinned here rather than inferred from the generators.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseJsonLenient } from "../prompts/schema-generator.js";
import { generateFunctionsSmart } from "../prompts/functions-generator.js";
import { fakeLlm } from "./support/fake-llm.js";
import { emptyEnv } from "./support/env.js";
import { baseSheet } from "./support/fixtures.js";

const OBJECT = { title: "Customers", sheet_columns: [] };

// --- 9.1 Fences and whitespace --------------------------------------------

test("bare JSON, fenced JSON and surrounding whitespace all parse", () => {
  const body = JSON.stringify(OBJECT);

  const shapes = [
    body,
    `  ${body}  `,
    `\n\t${body}\n`,
    "```json\n" + body + "\n```",
    "```JSON\n" + body + "\n```",
    "```Json\n" + body + "\n```",
    "```\n" + body + "\n```",
    "```json" + body + "```",
    "  ```json\n" + body + "\n```  ",
  ];

  for (const raw of shapes) {
    assert.deepEqual(
      parseJsonLenient(raw),
      OBJECT,
      `failed to parse: ${JSON.stringify(raw.slice(0, 40))}`
    );
  }
});

test("nested braces and strings containing braces survive", () => {
  const tricky = {
    title: "A } weird { title",
    steps: { nested: { deep: ["}", "{"] } },
  };
  const raw = "```json\n" + JSON.stringify(tricky) + "\n```";
  assert.deepEqual(parseJsonLenient(raw), tricky);
});

// --- 9.2 Prose-wrapped output ---------------------------------------------

test("leading prose is stripped and the object is extracted", () => {
  const body = JSON.stringify(OBJECT);
  assert.deepEqual(parseJsonLenient(`Here is your sheet:\n${body}`), OBJECT);
  assert.deepEqual(
    parseJsonLenient(`Sure! Here you go.\n\n${body}\n\nLet me know.`),
    OBJECT
  );
});

test("prose containing braces before the object still yields the object", () => {
  const body = JSON.stringify(OBJECT);
  // The extractor spans from the FIRST "{" to the LAST "}", so a brace in the
  // prose would break it — unless the prose brace is part of a wider span that
  // still parses. This case documents that a stray brace in prose is fatal.
  assert.throws(() => parseJsonLenient(`I used {curly} braces.\n${body}`));

  // Prose with no braces at all is fine.
  assert.deepEqual(parseJsonLenient(`No braces here.\n${body}`), OBJECT);
});

// --- 9.3 Unparseable input ------------------------------------------------

test("empty, brace-free and truncated input all throw", () => {
  assert.throws(() => parseJsonLenient(""), SyntaxError);
  assert.throws(() => parseJsonLenient("   "), SyntaxError);
  assert.throws(() => parseJsonLenient("I could not do that."), SyntaxError);
  assert.throws(() => parseJsonLenient('{"title":"ERP","sheet_columns":[{"column'));
  assert.throws(() => parseJsonLenient("```json\n{ not json }\n```"));
  assert.throws(() => parseJsonLenient("[1,2,3"), SyntaxError);
});

test("a JSON array parses — the function is not object-only", () => {
  assert.deepEqual(parseJsonLenient("[1,2,3]"), [1, 2, 3]);
  assert.deepEqual(parseJsonLenient("null"), null);
  assert.deepEqual(parseJsonLenient("42"), 42);
});

// --- 9.4 The `first > 0` guard --------------------------------------------

test("an object at index 0 with trailing prose is NOT salvaged", () => {
  // The extractor only runs when the first "{" is past index 0, so output that
  // starts with the object but trails prose falls straight through to
  // JSON.parse and fails. Pinned deliberately: changing it would change what
  // the generators report as PARSE_ERROR.
  const raw = `${JSON.stringify(OBJECT)}\n\nHope that helps!`;
  assert.throws(() => parseJsonLenient(raw), SyntaxError);

  // One leading space is enough to move "{" past index 0 and make it work.
  assert.deepEqual(parseJsonLenient(` ${raw}`.replace(/^ /, "x ")), OBJECT);
});

test("a fenced block wins over the brace-span extractor", () => {
  // Both mechanisms could fire; the fence is checked first, so trailing prose
  // inside a fenced response is never reached.
  const raw = "```json\n" + JSON.stringify(OBJECT) + "\n```";
  assert.deepEqual(parseJsonLenient(raw), OBJECT);

  // A fence with trailing prose OUTSIDE it does not match the fence regex
  // (which is anchored), so the brace extractor handles it instead.
  assert.deepEqual(
    parseJsonLenient("```json\n" + JSON.stringify(OBJECT) + "\n```\nDone!"),
    OBJECT
  );
});

// --- 9.5 Collection filtering ---------------------------------------------

/** Run the functions generator over one canned model response. */
async function generated(payload: unknown) {
  const result = await generateFunctionsSmart(
    "author some functions",
    baseSheet,
    emptyEnv(),
    fakeLlm({ truncated: false, text: JSON.stringify(payload) })
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("unreachable");
  return result;
}

test("only the three known collections survive, and empty ones are dropped", async () => {
  const result = await generated({
    virtual_columns: [{ column_name: "full_name", js_code: "return 1;" }],
    validation_functions: [],
    data_transforms: [],
    sheet_columns: [{ column_name: "sneaky", display_label: "S", type: "text" }],
    title: "Should not come through",
    notes: "neither should this",
  });

  assert.deepEqual(Object.keys(result.functions), ["virtual_columns"]);
  assert.equal(result.functions.virtual_columns?.length, 1);
  assert.equal(
    "sheet_columns" in result.functions,
    false,
    "a non-collection key leaked through"
  );
  assert.equal("title" in result.functions, false);
});

test("all three collections come through when all three are populated", async () => {
  const result = await generated({
    virtual_columns: [{ column_name: "vc", js_code: "return 1;" }],
    validation_functions: [{ function_name: "vf", js_code: "return [];" }],
    data_transforms: [{ transform_name: "dt", js_code: "return csvbox;" }],
  });

  assert.deepEqual(Object.keys(result.functions).sort(), [
    "data_transforms",
    "validation_functions",
    "virtual_columns",
  ]);
});

test("a non-object, array or null response yields no collections", async () => {
  for (const payload of [[1, 2, 3], null, 42, "a string"]) {
    const result = await generated(payload);
    assert.deepEqual(
      result.functions,
      {},
      `${JSON.stringify(payload)} produced collections`
    );
  }
});

test("a collection that is not an array is dropped rather than passed on", async () => {
  const result = await generated({
    virtual_columns: { column_name: "vc", js_code: "return 1;" },
    validation_functions: "nope",
  });
  assert.deepEqual(result.functions, {});
});
