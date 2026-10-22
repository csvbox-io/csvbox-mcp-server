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

/** A valid value for row `i` (0-based), or null when none can be derived. */
function validValue(col: Column, i: number): string | null {
  const type = col.type ?? "text";
  const v = col.validators ?? {};
  const n = i + 1;
  switch (type) {
    case "text": {
      let s = `${col.display_label ?? col.column_name} ${n}`;
      if (typeof v.max_length === "number" && s.length > v.max_length) s = s.slice(0, v.max_length);
      if (typeof v.min_length === "number" && s.length < v.min_length) s = s.padEnd(v.min_length, "x");
      return s;
    }
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
      const fmt = typeof v.format === "string" ? v.format : "YYYY-MM-DD";
      return fmt
        .replace("YYYY", "2024")
        .replace("YY", "24")
        .replace("MM", pad(((i % 12) + 1)))
        .replace("DD", pad(((i % 28) + 1)));
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
      return "4111111111111111";
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
  for (const c of columns)
    if (!UNSUPPORTED.has(c.type ?? "") && validValue(c, 0) === null)
      warnings.push(`Column "${c.column_name}" has no allowed values to sample; its cells are left blank.`);

  const rows: string[][] = [];
  for (let i = 0; i < validRows; i++) rows.push(columns.map((c) => validValue(c, i) ?? ""));

  const breakable = columns
    .map((c, idx) => ({ c, idx, bad: invalidValue(c) }))
    .filter((x) => x.bad !== null);
  if (invalidRows > 0 && breakable.length === 0)
    warnings.push("No column declares a rule that can be violated, so no invalid rows were generated.");

  const failures: ExpectedFailure[] = [];
  const invalidCount = breakable.length === 0 ? 0 : invalidRows;
  for (let k = 0; k < invalidCount; k++) {
    const target = breakable[k % breakable.length];
    const row = columns.map((c) => validValue(c, validRows + k) ?? "");
    row[target.idx] = target.bad!.value;
    rows.push(row);
    failures.push({
      row: rows.length,
      column: target.c.column_name,
      value: target.bad!.value,
      reason: target.bad!.reason,
    });
  }

  const csv = [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
  return { csv, header, valid_rows: validRows, invalid_rows: invalidCount, expected_failures: failures, warnings };
}

export function registerGenerateSampleCsv(server: McpServer): void {
  server.registerTool(
    "generate_sample_csv",
    {
      title: "Generate Sample CSV",
      description:
        "Build a test CSV from a CSVBox sheet schema so validations can be exercised right away. Input: { sheet_license_key | sheet, valid_rows?, invalid_rows? }. Pass sheet_license_key to read the schema with get_sheet, or pass the sheet JSON inline. Returns { csv, expected_failures: [{ row, column, value, reason }], warnings }; row numbers count data rows after the header, and each invalid row breaks exactly one cell. Values come only from declared types and validators; a list cell holds the entry's display label when it has one and its value otherwise, which is what the importer accepts. js_code (virtual columns, validation functions, data transforms) is never executed, and regex and dependent/dynamic list columns are left blank with a warning. Save the csv to a file and upload it with submit_file (check get_usage first: uploads consume imports).",
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
