/**
 * `validateSheet`'s column rules — the checks that predate the function
 * collections and are covered by neither existing test file.
 *
 * Assertions target specific error text, not just `valid === false`, so a
 * failure says which rule broke.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { validateSheet } from "../tools/validate-schema.js";
import { COLUMN_TYPES, DEPENDENT_COLUMN_TYPES } from "../schemas/csvbox-schemas.js";
import { baseSheet, everyColumnTypeSheet } from "./support/fixtures.js";

/** Errors mentioning a given substring, for readable assertions. */
function matching(list: string[], needle: string): string[] {
  return list.filter((m) => m.includes(needle));
}

function column(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { column_name: "a", display_label: "A", type: "text", ...over };
}

function sheetWith(columns: unknown[]): Record<string, unknown> {
  return { title: "T", sheet_columns: columns };
}

// --- 6.1 Non-object payloads ----------------------------------------------

test("a non-object payload is rejected with exactly one error", () => {
  for (const value of [null, [], "a sheet", 42, true, undefined]) {
    const result = validateSheet(value);
    assert.equal(result.valid, false, `${String(value)} was accepted`);
    assert.deepEqual(result.errors, ["Sheet must be an object."]);
    assert.deepEqual(result.warnings, []);
  }
});

// --- 6.2 Title rules ------------------------------------------------------

test("title is required under create and put, optional under patch", () => {
  const noTitle = { sheet_columns: baseSheet.sheet_columns };

  for (const mode of ["create", "put"] as const) {
    const missing = validateSheet(noTitle, mode);
    assert.equal(missing.valid, false, `${mode} accepted a missing title`);
    assert.equal(matching(missing.errors, "title is required").length, 1);

    const empty = validateSheet({ ...noTitle, title: "" }, mode);
    assert.equal(empty.valid, false, `${mode} accepted an empty title`);

    const wrongType = validateSheet({ ...noTitle, title: 42 }, mode);
    assert.equal(wrongType.valid, false, `${mode} accepted a numeric title`);
  }

  const patchMissing = validateSheet(noTitle, "patch");
  assert.equal(patchMissing.valid, true);
  assert.deepEqual(matching(patchMissing.errors, "title"), []);
});

test("a present-but-empty title is still an error under patch", () => {
  const result = validateSheet({ title: "", sheet_columns: [] }, "patch");
  assert.equal(result.valid, false);
  assert.equal(
    matching(result.errors, "title must be a non-empty string when present").length,
    1
  );

  const numeric = validateSheet({ title: 7 }, "patch");
  assert.equal(numeric.valid, false);
});

// --- 6.3 sheet_columns shape ----------------------------------------------

test("sheet_columns absent, empty, or not an array", () => {
  const absent = validateSheet({ title: "T" });
  assert.equal(absent.valid, true);
  assert.deepEqual(absent.errors, []);
  assert.deepEqual(absent.warnings, []);

  const empty = validateSheet({ title: "T", sheet_columns: [] });
  assert.equal(empty.valid, true);
  assert.equal(matching(empty.warnings, "no columns to validate yet").length, 1);

  for (const bad of [{}, "columns", 5, null]) {
    const result = validateSheet({ title: "T", sheet_columns: bad });
    assert.equal(result.valid, false, `${JSON.stringify(bad)} was accepted`);
    assert.equal(
      matching(result.errors, "sheet_columns must be an array when present").length,
      1
    );
  }
});

// --- 6.4 Non-object entries -----------------------------------------------

test("a non-object entry errors with its 1-based index", () => {
  const result = validateSheet(sheetWith([column(), null, "x", [], 3]));
  assert.equal(result.valid, false);
  assert.equal(matching(result.errors, "Column 2: must be an object.").length, 1);
  assert.equal(matching(result.errors, "Column 3: must be an object.").length, 1);
  assert.equal(matching(result.errors, "Column 4: must be an object.").length, 1);
  assert.equal(matching(result.errors, "Column 5: must be an object.").length, 1);
  assert.deepEqual(matching(result.errors, "Column 1"), []);
});

// --- 6.5 Required fields --------------------------------------------------

test("missing column_name, display_label and type each error", () => {
  const noName = validateSheet(
    sheetWith([{ display_label: "A", type: "text" }])
  );
  assert.equal(matching(noName.errors, "Column 1: missing column_name.").length, 1);

  const noLabel = validateSheet(sheetWith([{ column_name: "a", type: "text" }]));
  assert.equal(
    matching(noLabel.errors, "Column 1 (a): missing display_label.").length,
    1,
    "the column name should appear in the message"
  );

  const noType = validateSheet(
    sheetWith([{ column_name: "a", display_label: "A" }])
  );
  assert.equal(matching(noType.errors, "Column 1 (a): missing type.").length, 1);

  // Empty strings count as missing, not as present-but-blank.
  const blanks = validateSheet(
    sheetWith([{ column_name: "", display_label: "", type: "" }])
  );
  assert.equal(matching(blanks.errors, "missing column_name").length, 1);
  assert.equal(matching(blanks.errors, "missing display_label").length, 1);
  assert.equal(matching(blanks.errors, "missing type").length, 1);

  // Wrong types count as missing too.
  const wrongTypes = validateSheet(
    sheetWith([{ column_name: 1, display_label: true, type: {} }])
  );
  assert.equal(wrongTypes.valid, false);
  assert.equal(matching(wrongTypes.errors, "missing column_name").length, 1);
  assert.equal(matching(wrongTypes.errors, "missing display_label").length, 1);
  assert.equal(matching(wrongTypes.errors, "missing type").length, 1);
});

// --- 6.6 Column types -----------------------------------------------------

test("an unsupported type errors and names the offending value", () => {
  const result = validateSheet(sheetWith([column({ type: "datetime" })]));
  assert.equal(result.valid, false);
  assert.equal(
    matching(result.errors, 'Column 1 (a): unsupported type "datetime".').length,
    1
  );
});

test("every documented column type is accepted", () => {
  const result = validateSheet(everyColumnTypeSheet());
  assert.deepEqual(
    matching(result.errors, "unsupported type"),
    [],
    "a documented type was rejected"
  );
  assert.equal(result.valid, true, result.errors.join(" | "));
  assert.equal(COLUMN_TYPES.length, 18, "the documented type count changed");
});

test("type matching is case-sensitive and exact", () => {
  for (const bad of ["Text", "TEXT", " text", "text "]) {
    const result = validateSheet(sheetWith([column({ type: bad })]));
    assert.equal(result.valid, false, `"${bad}" was accepted as a type`);
    assert.equal(matching(result.errors, "unsupported type").length, 1);
  }
});

// --- 6.7 Duplicates -------------------------------------------------------

test("duplicate column names and positions report their counts", () => {
  const dupNames = validateSheet(
    sheetWith([
      column({ column_name: "a", position: 1 }),
      column({ column_name: "a", position: 2 }),
      column({ column_name: "a", position: 3 }),
    ])
  );
  assert.equal(dupNames.valid, false);
  assert.equal(
    matching(dupNames.errors, 'Duplicate column_name "a" (3 times).').length,
    1
  );

  const dupPositions = validateSheet(
    sheetWith([
      column({ column_name: "a", position: 1 }),
      column({ column_name: "b", position: 1 }),
    ])
  );
  assert.equal(dupPositions.valid, false);
  assert.equal(
    matching(dupPositions.errors, "Duplicate position 1 (2 columns).").length,
    1
  );

  // Distinct names and positions produce neither error.
  const clean = validateSheet(baseSheet);
  assert.deepEqual(matching(clean.errors, "Duplicate"), []);
});

// --- 6.8 Position advisory ------------------------------------------------

test("the ordering advisory fires only when no position is set anywhere", () => {
  const none = validateSheet(
    sheetWith([column({ column_name: "a" }), column({ column_name: "b" })])
  );
  assert.equal(matching(none.warnings, "No column positions set").length, 1);

  const some = validateSheet(
    sheetWith([column({ column_name: "a", position: 1 }), column({ column_name: "b" })])
  );
  assert.deepEqual(matching(some.warnings, "No column positions set"), []);

  assert.deepEqual(matching(validateSheet(baseSheet).warnings, "No column positions set"), []);
});

// --- 6.9 Dependent column references --------------------------------------

test("dependent types require an existing primary_column", () => {
  for (const type of DEPENDENT_COLUMN_TYPES) {
    const parent = column({ column_name: "parent", position: 1 });

    const missing = validateSheet(
      sheetWith([parent, column({ column_name: "child", type, position: 2 })])
    );
    assert.equal(missing.valid, false, `${type} accepted a missing primary_column`);
    assert.equal(
      matching(
        missing.errors,
        `dependent type "${type}" requires validators.primary_column`
      ).length,
      1
    );

    const notAString = validateSheet(
      sheetWith([
        parent,
        column({
          column_name: "child",
          type,
          position: 2,
          validators: { primary_column: 42 },
        }),
      ])
    );
    assert.equal(notAString.valid, false, `${type} accepted a numeric primary_column`);
    assert.equal(matching(notAString.errors, "requires validators.primary_column").length, 1);

    const dangling = validateSheet(
      sheetWith([
        parent,
        column({
          column_name: "child",
          type,
          position: 2,
          validators: { primary_column: "ghost" },
        }),
      ])
    );
    assert.equal(dangling.valid, false, `${type} accepted a dangling reference`);
    assert.equal(
      matching(
        dangling.errors,
        'validators.primary_column "ghost" references a non-existent column.'
      ).length,
      1,
      "a dangling reference must be distinguishable from a missing one"
    );

    const good = validateSheet(
      sheetWith([
        parent,
        column({
          column_name: "child",
          type,
          position: 2,
          validators: { primary_column: "parent" },
        }),
      ])
    );
    assert.equal(good.valid, true, `${type}: ${good.errors.join(" | ")}`);
  }
});

test("a dependent column may reference a column declared after it", () => {
  const result = validateSheet(
    sheetWith([
      column({
        column_name: "child",
        type: "dependent_list",
        position: 1,
        validators: { primary_column: "parent" },
      }),
      column({ column_name: "parent", position: 2 }),
    ])
  );
  assert.equal(result.valid, true, result.errors.join(" | "));
});

test("a non-dependent column with a primary_column is not reference-checked", () => {
  const result = validateSheet(
    sheetWith([column({ type: "text", validators: { primary_column: "ghost" } })])
  );
  assert.deepEqual(matching(result.errors, "primary_column"), []);
});

// --- 6.10 Happy path ------------------------------------------------------

test("a well-formed sheet validates clean", () => {
  const result = validateSheet(baseSheet);
  assert.deepEqual(result, { valid: true, errors: [], warnings: [] });
});

test("a sheet triggering several column rules reports all of them", () => {
  const result = validateSheet({
    sheet_columns: [
      { column_name: "a", type: "bogus" },
      { column_name: "a", display_label: "A", type: "text" },
    ],
  });
  assert.equal(result.valid, false);
  assert.equal(matching(result.errors, "title is required").length, 1);
  assert.equal(matching(result.errors, "missing display_label").length, 1);
  assert.equal(matching(result.errors, "unsupported type").length, 1);
  assert.equal(matching(result.errors, "Duplicate column_name").length, 1);
});

// --- List value shapes ------------------------------------------------------

function listSheet(type: string, values: unknown) {
  return {
    title: "T",
    sheet_columns: [
      { column_name: "c", display_label: "C", type, position: 1, validators: { values } },
    ],
  };
}

test("list values must be objects with a string value; display_label is optional", () => {
  const strings = validateSheet(listSheet("list", ["a", "b"]));
  assert.equal(strings.valid, false);
  assert.match(strings.errors.join("|"), /validators\.values\[0\] must be an object/);
  assert.match(strings.errors.join("|"), /silently drops/);

  const noValue = validateSheet(listSheet("list", [{ display_label: "A" }]));
  assert.equal(noValue.valid, false);
  assert.match(noValue.errors.join("|"), /needs a string value/);

  const valueOnly = validateSheet(listSheet("list", [{ value: "a" }, { value: "b", display_label: "B" }]));
  assert.equal(valueOnly.valid, true, valueOnly.errors.join(" | "));

  const badLabel = validateSheet(listSheet("list", [{ value: "a", display_label: 7 }]));
  assert.equal(badLabel.valid, false);
  assert.match(badLabel.errors.join("|"), /display_label that is not a string/);

  const extra = validateSheet(listSheet("list", [{ value: "a", display_label: "A", color: "red" }]));
  assert.equal(extra.valid, false);
  assert.match(extra.errors.join("|"), /unsupported key\(s\): color/);

  const ok = validateSheet(listSheet("list", [{ value: "a", display_label: "A" }]));
  assert.equal(ok.valid, true, ok.errors.join(" | "));
});

test("a bad nested dependent is located and reported once", () => {
  const result = validateSheet(
    listSheet("list", [
      { value: "in", dependents: [{ display_label: "Maharashtra" }] },
      "stray",
    ])
  );
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /validators\.values\[0\]\.dependents\[0\] needs a string value/);
});

test("multiselect_list takes plain strings and rejects objects", () => {
  assert.equal(validateSheet(listSheet("multiselect_list", ["Red", "Green"])).valid, true);

  const objects = validateSheet(listSheet("multiselect_list", [{ value: "Red" }]));
  assert.equal(objects.valid, false);
  assert.match(objects.errors.join("|"), /plain strings/);

  assert.equal(validateSheet(listSheet("multiselect_list", ["Red", " "])).valid, false);
});

test("non-array list values are reported, absent values are not", () => {
  const bad = validateSheet(listSheet("list", "a,b"));
  assert.equal(bad.valid, false);
  assert.match(bad.errors.join("|"), /validators\.values must be an array/);

  const none = validateSheet({
    title: "T",
    sheet_columns: [{ column_name: "c", display_label: "C", type: "list", position: 1 }],
  });
  assert.equal(none.valid, true, none.errors.join(" | "));
});

test("the generator prompt teaches the accepted list shape", async () => {
  const { SHEET_SYSTEM_PROMPT } = await import("../prompts/sheet-system-prompt.js");
  assert.match(SHEET_SYSTEM_PROMPT, /"values":\[\{"value":"draft"\}/);
  assert.match(SHEET_SYSTEM_PROMPT, /display_label" is optional/);
  assert.doesNotMatch(SHEET_SYSTEM_PROMPT, /"values":\["draft"/);
});

// --- PATCH: a column needs only its name -------------------------------------

test("under patch a column may carry only its name and the field being changed", () => {
  const onlyLabel = validateSheet({ sheet_columns: [{ column_name: "plan", display_label: "Plan B" }] }, "patch");
  assert.equal(onlyLabel.valid, true, onlyLabel.errors.join(" | "));

  const onlyValidators = validateSheet(
    { sheet_columns: [{ column_name: "age", validators: { max_value: 9 } }] },
    "patch"
  );
  assert.equal(onlyValidators.valid, true, onlyValidators.errors.join(" | "));
  assert.deepEqual(onlyValidators.warnings, [], "no 'no positions set' advisory on a partial update");
});

test("the same partial column is still an error under create and put", () => {
  for (const mode of ["create", "put"] as const) {
    const result = validateSheet(
      { title: "T", sheet_columns: [{ column_name: "plan", display_label: "Plan B" }] },
      mode
    );
    assert.equal(result.valid, false, mode);
    assert.match(result.errors.join("|"), /missing type/);
  }
});

test("under patch a column still needs a name, and any field it does send is checked", () => {
  assert.match(
    validateSheet({ sheet_columns: [{ display_label: "x" }] }, "patch").errors.join("|"),
    /missing column_name/
  );
  assert.match(
    validateSheet({ sheet_columns: [{ column_name: "a", type: "bogus" }] }, "patch").errors.join("|"),
    /unsupported type "bogus"/
  );
  assert.match(
    validateSheet({ sheet_columns: [{ column_name: "a", display_label: "" }] }, "patch").errors.join("|"),
    /display_label must be a non-empty string when present/
  );
  assert.match(
    validateSheet({ sheet_columns: [{ column_name: "a", type: "" }] }, "patch").errors.join("|"),
    /type must be a non-empty string when present/
  );
});

test("list values are checked under patch only when the type is sent", () => {
  const typed = validateSheet(
    { sheet_columns: [{ column_name: "plan", type: "list", validators: { values: ["a", "b"] } }] },
    "patch"
  );
  assert.equal(typed.valid, false);
  assert.match(typed.errors.join("|"), /silently drops/);

  const untyped = validateSheet(
    { sheet_columns: [{ column_name: "plan", validators: { values: ["a", "b"] } }] },
    "patch"
  );
  assert.equal(untyped.valid, true, "the stored type decides, and it is not known here");
});

test("a dependent list's parent outside the request is a warning under patch, an error otherwise", () => {
  const col = { column_name: "city", type: "dependent_list", validators: { primary_column: "country" } };

  const patch = validateSheet({ sheet_columns: [col] }, "patch");
  assert.equal(patch.valid, true, patch.errors.join(" | "));
  assert.match(patch.warnings.join("|"), /not in this request/);

  const create = validateSheet(
    { title: "T", sheet_columns: [{ ...col, display_label: "City", position: 1 }] },
    "create"
  );
  assert.match(create.errors.join("|"), /non-existent column/);
});

test("a null display_label on a list entry is accepted: the dashboard saves a blank label that way", () => {
  const sheet = listSheet("list", [
    { value: "free", display_label: "Free plan" },
    { value: "team", display_label: "", dependents: [{ value: "seat-5", display_label: null }] },
    { value: "extra", display_label: null },
  ]);
  const result = validateSheet(sheet);
  assert.equal(result.valid, true, result.errors.join(" | "));

  const wrong = validateSheet(listSheet("list", [{ value: "a", display_label: 5 }]));
  assert.equal(wrong.valid, false, "a non-string, non-null label is still wrong");
});
