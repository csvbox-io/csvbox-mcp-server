/**
 * Shared payloads and boundary builders.
 *
 * Limits are imported from the schema module, never restated. A test that
 * hard-codes 32768 agrees with itself; one that imports MAX_JS_CODE_LENGTH
 * agrees with the schema.
 */

import { COLUMN_TYPES } from "../../schemas/csvbox-schemas.js";

/** Positions are set so the "no positions" advisory never fires. */
export const baseSheet = {
  title: "Customers",
  sheet_columns: [
    { column_name: "first_name", display_label: "First Name", type: "text", position: 1 },
    { column_name: "last_name", display_label: "Last Name", type: "text", position: 2 },
    { column_name: "email", display_label: "Email", type: "email", position: 3 },
  ],
};

/** A dependency that satisfies every URL, globals, and integrity rule. */
export const goodDependency = {
  url: "https://cdn.jsdelivr.net/npm/dayjs@1.11.10/dayjs.min.js",
  globals: ["dayjs"],
  integrity: "sha384-abc123+/=",
};

/**
 * One column of every documented type. Dependent types need a parent, so a
 * plain `parent_list` column is declared first and referenced by each of them.
 */
export function everyColumnTypeSheet(): Record<string, unknown> {
  const columns: Record<string, unknown>[] = [
    {
      column_name: "parent_list",
      display_label: "Parent List",
      type: "list",
      position: 1,
      validators: { values: ["a", "b"] },
    },
  ];

  COLUMN_TYPES.forEach((type, i) => {
    const column: Record<string, unknown> = {
      column_name: `col_${type}`,
      display_label: `Col ${type}`,
      type,
      position: i + 2,
    };
    if (type === "dependent_list" || type === "dependent_dynamic_list") {
      column.validators = { primary_column: "parent_list" };
    }
    columns.push(column);
  });

  return { title: "Every Type", sheet_columns: columns };
}

/** A string of exactly `length` characters. */
export function stringOfLength(length: number, fill = "a"): string {
  return fill.repeat(length);
}

/** `[atLimit, overLimit]` string lengths for a documented character cap. */
export function stringBoundary(limit: number): [string, string] {
  return [stringOfLength(limit), stringOfLength(limit + 1)];
}

/** `count` virtual columns named `vc_0`… — used to overflow the per-sheet cap. */
export function virtualColumns(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    column_name: `vc_${i}`,
    js_code: "return 1;",
  }));
}

export function validationFunctions(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    function_name: `vf_${i}`,
    js_code: "return [];",
  }));
}

export function dataTransforms(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    transform_name: `dt_${i}`,
    js_code: "return csvbox;",
  }));
}

/** `count` copies of a valid dependency — used to overflow the per-item cap. */
export function dependencies(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, () => ({ ...goodDependency }));
}

/** `count` valid JavaScript identifiers, for the globals-per-dependency cap. */
export function globals(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `g${i}`);
}
