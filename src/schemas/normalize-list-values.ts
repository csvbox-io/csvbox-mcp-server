/**
 * Deterministic repair of `validators.values` in LLM-generated sheets.
 *
 * The API keeps `list` values only as `{ value, display_label? }` objects and
 * `multiselect_list` values only as plain strings, silently dropping anything
 * else. Models routinely emit the other shape, so rather than failing the whole
 * generation on a shape slip that has one correct fix, convert it:
 *
 *   - list:            "a"        -> { value: "a" }
 *   - multiselect_list: { value }  -> "value"
 *
 * Applied to generated output only. Caller-supplied sheets are never rewritten;
 * `validate_schema` reports those instead.
 */

const MAX_DEPTH = 32;

function fixListNode(node: unknown, depth: number): unknown {
  if (typeof node === "string") return { value: node };
  if (!node || typeof node !== "object" || Array.isArray(node) || depth >= MAX_DEPTH) {
    return node;
  }
  const n = node as Record<string, unknown>;
  if (!Array.isArray(n.dependents)) return node;
  return { ...n, dependents: n.dependents.map((d) => fixListNode(d, depth + 1)) };
}

export function normalizeListValues<T>(sheet: T): T {
  if (!sheet || typeof sheet !== "object") return sheet;
  const s = sheet as Record<string, unknown>;
  if (!Array.isArray(s.sheet_columns)) return sheet;

  const columns = s.sheet_columns.map((col) => {
    if (!col || typeof col !== "object" || Array.isArray(col)) return col;
    const c = col as Record<string, unknown>;
    const v = c.validators;
    if (!v || typeof v !== "object" || !Array.isArray((v as Record<string, unknown>).values)) {
      return col;
    }
    const values = (v as { values: unknown[] }).values;

    if (c.type === "list") {
      return { ...c, validators: { ...v, values: values.map((x) => fixListNode(x, 0)) } };
    }
    if (c.type === "multiselect_list") {
      const strings = values.map((x) =>
        x && typeof x === "object" && !Array.isArray(x) && typeof (x as any).value === "string"
          ? (x as { value: string }).value
          : x
      );
      return { ...c, validators: { ...v, values: strings } };
    }
    return col;
  });

  return { ...s, sheet_columns: columns } as T;
}
