import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSheet } from "../services/csvbox-api.js";
import { json } from "./respond.js";

/**
 * Builds a test CSV from a sheet schema. Values come only from declared types
 * and validators; `js_code` in virtual columns, validation functions and data
 * transforms is never read or evaluated.
 */

type Column = {
  column_name: string;
  display_label?: string;
  type?: string;
  required?: boolean;
  validators?: Record<string, any>;
};

export interface ExpectedFailure {
  row: number;
  column: string;
  value: string;
  reason: string;
}

export interface SampleCsv {
  csv: string;
  header: string[];
  valid_rows: number;
  invalid_rows: number;
  expected_failures: ExpectedFailure[];
  warnings: string[];
}

const LIST_TYPES = new Set(["list", "multiselect_list"]);
const UNSUPPORTED = new Set([
  "regex",
  "dependent_list",
  "dynamic_list",
  "dependent_dynamic_list",
  "multiselect_dynamic_list",
]);

/**
 * What a cell must contain to be a valid choice. The importer accepts a list
 * entry's display_label when it has one and its value otherwise (both, when the
 * sheet sets accept_list_values), so the label is what a file should carry; a
 * file holding the raw value of a labelled entry is flagged invalid.
 */
function listValues(col: Column): string[] {
  const values = col.validators?.values;
  if (!Array.isArray(values)) return [];
  return values
    .map((v: any) => {
      if (typeof v === "string") return v;
      const label = typeof v?.display_label === "string" ? v.display_label.trim() : "";
      return label !== "" ? v.display_label : v?.value;
    })
    .filter((v: unknown): v is string => typeof v === "string" && v !== "");
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DATE_TOKENS = ["YYYY", "YY", "MMMM", "MMM", "MM", "M", "DD", "D"];

/** The pattern a date column really uses: `custom` and `multiple` carry it in their own validator. */
function dateFormatOf(v: Record<string, any>): string | null {
  const format = typeof v.format === "string" && v.format !== "" ? v.format : "YYYY-MM-DD";
  if (format === "custom") return typeof v.custom === "string" && v.custom !== "" ? v.custom : null;
  if (format === "multiple") {
    const first = Array.isArray(v.multiple) ? v.multiple[0] : v.multiple;
    return typeof first === "string" && first !== "" ? first : null;
  }
  return format;
}

/**
 * Render row `i` through a moment-style pattern (the importer parses with moment, case-sensitively):
 * YYYY YY MMMM MMM MM M DD D, `[literal]` text, and any non-letter copied as it is. A letter that is not
 * one of those tokens (dddd, Do, HH, lower-case dd/mm/yyyy ...) means the pattern cannot be rendered: null.
 */
export function renderDate(format: string, i: number): string | null {
  const month = i % 12;
  const day = (i % 28) + 1;
  const values: Record<string, string> = {
    YYYY: "2024",
    YY: "24",
    MMMM: MONTHS[month],
    MMM: MONTHS[month].slice(0, 3),
    MM: pad(month + 1),
    M: String(month + 1),
    DD: pad(day),
    D: String(day),
  };
  let out = "";
  for (let pos = 0; pos < format.length; ) {
    if (format[pos] === "[") {
      const end = format.indexOf("]", pos);
      if (end === -1) return null;
      out += format.slice(pos + 1, end);
      pos = end + 1;
      continue;
    }
    const token = DATE_TOKENS.find((t) => format.startsWith(t, pos));
    if (token) {
      out += values[token];
      pos += token.length;
    } else if (/[A-Za-z]/.test(format[pos])) {
      return null;
    } else {
      out += format[pos];
      pos += 1;
    }
  }
  return out;
}

/** Published test card numbers that pass the Luhn check, cycled so rows differ. */
const TEST_CARDS = ["4111111111111111", "5555555555554444", "378282246310005", "6011111111111117", "3530111333300000"];

/** Text for row `i`; under max_length the prefix is cut and the row number kept, so rows stay distinct. */
function textValue(col: Column, i: number): string {
  const v = col.validators ?? {};
  const label = String(col.display_label ?? col.column_name);
  const n = i + 1;
  let s = `${label} ${n}`;
  if (typeof v.max_length === "number" && s.length > v.max_length) {
    const suffix = ` ${n}`.length <= v.max_length ? ` ${n}` : String(n).slice(-v.max_length);
    s = label.slice(0, Math.max(0, v.max_length - suffix.length)) + suffix;
  }
  if (typeof v.min_length === "number" && s.length < v.min_length) s = s.padEnd(v.min_length, "x");
  return s;
}

/** A valid value for row `i` (0-based), or null when none can be derived. */
function validValue(col: Column, i: number): string | null {
  const type = col.type ?? "text";
  const v = col.validators ?? {};
  const n = i + 1;
  switch (type) {
    case "text":
      return textValue(col, i);
    case "number": {
      const min = typeof v.min_value === "number" ? v.min_value : 0;
      const max = typeof v.max_value === "number" ? v.max_value : min + 1000;
      return String(Math.min(max, min + n));
    }
    case "currency":
      return (10 + n + 0.5).toFixed(2);
    case "email":
      return `user${n}@example.com`;
    case "date": {
      const fmt = dateFormatOf(v);
      return fmt === null ? null : renderDate(fmt, i);
    }
    case "time":
      return `${pad(9 + (i % 8))}:${pad((i * 7) % 60)}`;
    case "boolean":
      return i % 2 === 0 ? "true" : "false";
    case "ip":
      return `192.168.0.${(n % 250) + 1}`;
    case "url":
      return `https://example.com/item-${n}`;
    case "credit_card":
      return TEST_CARDS[i % TEST_CARDS.length];
    case "phone_number":
      return `+1415555${pad(n % 100, 4)}`;
    default:
      if (LIST_TYPES.has(type)) {
        const values = listValues(col);
        return values.length ? values[i % values.length] : null;
      }
      return null;
  }
}

/** A value that breaks one declared rule, with the reason, or null if none applies. */
function invalidValue(col: Column): { value: string; reason: string } | null {
  const type = col.type ?? "text";
  const v = col.validators ?? {};
  if (col.required) return { value: "", reason: "required value is empty" };
  switch (type) {
    case "text":
      if (typeof v.max_length === "number")
        return { value: "x".repeat(v.max_length + 1), reason: `longer than max_length ${v.max_length}` };
      if (typeof v.min_length === "number" && v.min_length > 1)
        return { value: "x", reason: `shorter than min_length ${v.min_length}` };
      return null;
    case "number":
      if (typeof v.max_value === "number")
        return { value: String(v.max_value + 1), reason: `above max_value ${v.max_value}` };
      if (typeof v.min_value === "number")
        return { value: String(v.min_value - 1), reason: `below min_value ${v.min_value}` };
      return { value: "not-a-number", reason: "not a number" };
    case "currency":
      return { value: "not-a-price", reason: "not a currency amount" };
    case "email":
      return { value: "not-an-email", reason: "not a valid email" };
    case "date":
      return { value: "not-a-date", reason: "not a valid date" };
    case "time":
      return { value: "99:99", reason: "not a valid time" };
    case "boolean":
      return { value: "maybe", reason: "not a boolean" };
    case "ip":
      return { value: "999.1.1.1", reason: "not a valid IP address" };
    case "url":
      return { value: "not a url", reason: "not a valid URL" };
    case "credit_card":
      return { value: "1234", reason: "not a valid card number" };
    case "phone_number":
      return { value: "abc", reason: "not a valid phone number" };
    default:
      if (LIST_TYPES.has(type) && listValues(col).length)
        return { value: "__not_in_list__", reason: "value is not one of the allowed list values" };
      return null;
  }
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function buildSampleCsv(
  sheet: { sheet_columns?: Column[] },
  validRows: number,
  invalidRows: number
): SampleCsv {
  const columns = (sheet.sheet_columns ?? []).filter((c) => c && typeof c.column_name === "string");
  const warnings: string[] = [];
  if (columns.length === 0) {
    return { csv: "", header: [], valid_rows: 0, invalid_rows: 0, expected_failures: [], warnings: ["The sheet has no sheet_columns."] };
  }

  const header = columns.map((c) => c.display_label || c.column_name);
  const unsupported = columns.filter((c) => UNSUPPORTED.has(c.type ?? ""));
  for (const c of unsupported)
    warnings.push(`Column "${c.column_name}" (${c.type}) cannot be derived from its schema; its cells are left blank. Fill them in by hand.`);
  for (const c of columns) {
    if (UNSUPPORTED.has(c.type ?? "") || validValue(c, 0) !== null) continue;
    if (c.type === "date") {
      warnings.push(`Column "${c.column_name}" (date) has a format (${JSON.stringify(dateFormatOf(c.validators ?? {}) ?? c.validators?.format)}) the sample generator cannot render; its cells are left blank. Fill them in by hand.`);
    } else {
      warnings.push(`Column "${c.column_name}" has no allowed values to sample; its cells are left blank.`);
    }
  }

  const invalidCount = columns.some((c) => invalidValue(c) !== null) ? invalidRows : 0;
  const totalRows = validRows + invalidCount;
  for (const c of columns) {
    const max = c.type === "text" ? c.validators?.max_length : undefined;
    if (typeof max === "number" && String(totalRows).length > max)
      warnings.push(`Column "${c.column_name}" has max_length ${max}, too short for ${totalRows} distinct values; some sample values repeat.`);
  }

  // A cell the tool cannot fill is blank, and a blank required cell is rejected: list it, so that every
  // row not named in expected_failures is one the importer accepts.
  const blankRequired = columns
    .map((c, idx) => ({ c, idx }))
    .filter(({ c }) => c.required && (UNSUPPORTED.has(c.type ?? "") || validValue(c, 0) === null));
  const BLANK_REASON = "required value cannot be derived and is left empty";

  const rows: string[][] = [];
  for (let i = 0; i < validRows; i++) rows.push(columns.map((c) => validValue(c, i) ?? ""));

  const breakable = columns
    .map((c, idx) => ({ c, idx, bad: invalidValue(c) }))
    .filter((x) => x.bad !== null);
  if (invalidRows > 0 && breakable.length === 0)
    warnings.push("No column declares a rule that can be violated, so no invalid rows were generated.");

  const failures: ExpectedFailure[] = [];
  for (let r = 1; r <= validRows; r++)
    for (const { c } of blankRequired) failures.push({ row: r, column: c.column_name, value: "", reason: BLANK_REASON });

  for (let k = 0; k < invalidCount; k++) {
    const target = breakable[k % breakable.length];
    const row = columns.map((c, idx) => (idx === target.idx ? "" : validValue(c, validRows + k) ?? ""));
    row[target.idx] = target.bad!.value;
    rows.push(row);
    for (const { c, idx } of blankRequired)
      if (idx !== target.idx) failures.push({ row: rows.length, column: c.column_name, value: "", reason: BLANK_REASON });
    failures.push({
      row: rows.length,
      column: target.c.column_name,
      value: target.bad!.value,
      reason: target.bad!.reason,
    });
  }
  failures.sort((x, y) => x.row - y.row || columns.findIndex((c) => c.column_name === x.column) - columns.findIndex((c) => c.column_name === y.column));

  const csv = [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
  return { csv, header, valid_rows: validRows, invalid_rows: invalidCount, expected_failures: failures, warnings };
}

export function registerGenerateSampleCsv(server: McpServer): void {
  server.registerTool(
    "generate_sample_csv",
    {
      title: "Generate Sample CSV",
      description:
        "Build a test CSV from a CSVBox sheet schema so validations can be exercised right away. Input: { sheet_license_key | sheet, valid_rows?, invalid_rows? }. Pass sheet_license_key to read the schema with get_sheet, or pass the sheet JSON inline. Returns { csv, expected_failures: [{ row, column, value, reason }], warnings }; row numbers count data rows after the header, and each invalid row breaks exactly one cell. Values come only from declared types and validators; a list cell holds the entry's display label when it has one and its value otherwise, which is what the importer accepts. js_code (virtual columns, validation functions, data transforms) is never executed, and regex and dependent/dynamic list columns are left blank with a warning; when such a column is required, each blank cell is listed in expected_failures, so every row not listed is one the importer accepts. Date cells follow the column's own format (custom and multiple included). Save the csv to a file and upload it with submit_file (check get_usage first: uploads consume imports).",
      inputSchema: {
        sheet_license_key: z
          .string()
          .min(1)
          .optional()
          .describe("License key or id of an existing sheet; its schema is fetched with GET /1.1/sheet/{key}."),
        sheet: z
          .object({ sheet_columns: z.array(z.record(z.string(), z.unknown())) })
          .passthrough()
          .optional()
          .describe("Sheet JSON with sheet_columns, instead of sheet_license_key."),
        valid_rows: z.number().int().min(1).max(100).optional().describe("Valid rows to include. Default 5."),
        invalid_rows: z.number().int().min(0).max(50).optional().describe("Deliberately invalid rows to include. Default 3."),
      },
    },
    async ({ sheet_license_key, sheet, valid_rows, invalid_rows }) => {
      if (!sheet && !sheet_license_key) {
        return json({ ok: false, error: "Provide sheet_license_key or sheet." }, true);
      }
      try {
        let schema = sheet as { sheet_columns?: Column[] } | undefined;
        if (!schema) {
          const result = await getSheet(sheet_license_key!);
          if (!result.ok) return json(result, true);
          schema = result.data as { sheet_columns?: Column[] };
        }
        return json({ ok: true, ...buildSampleCsv(schema, valid_rows ?? 5, invalid_rows ?? 3) });
      } catch (err) {
        return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, true);
      }
    }
  );
}
