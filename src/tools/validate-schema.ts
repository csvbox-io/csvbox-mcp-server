import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  COLUMN_TYPES,
  DEPENDENT_COLUMN_TYPES,
  type ColumnType,
} from "../schemas/csvbox-schemas.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const SUPPORTED = new Set<string>(COLUMN_TYPES);
const DEPENDENT = new Set<string>(DEPENDENT_COLUMN_TYPES);

/**
 * Pure local validation of a CSVBox sheet. No API call.
 * Hard problems -> `errors`; advisory issues -> `warnings`.
 */
export function validateSheet(sheet: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (sheet === null || typeof sheet !== "object" || Array.isArray(sheet)) {
    return { valid: false, errors: ["Sheet must be an object."], warnings };
  }

  const s = sheet as Record<string, unknown>;

  // title is required.
  const title = s.title;
  if (typeof title !== "string" || title.length === 0) {
    errors.push("title is required and must be a non-empty string.");
  }

  // sheet_columns is optional. Absent -> skip column checks. Empty -> warn.
  const columns = s.sheet_columns;

  if (columns === undefined) {
    return { valid: errors.length === 0, errors, warnings };
  }

  if (!Array.isArray(columns)) {
    errors.push("sheet_columns must be an array when present.");
    return { valid: false, errors, warnings };
  }

  if (columns.length === 0) {
    warnings.push("sheet_columns is empty; no columns to validate yet.");
    return { valid: errors.length === 0, errors, warnings };
  }

  const nameCounts = new Map<string, number>();
  const positionCounts = new Map<number, number>();
  const knownNames = new Set<string>();

  // First pass: collect names for dependent-reference checks.
  columns.forEach((col) => {
    if (col && typeof col === "object") {
      const name = (col as Record<string, unknown>).column_name;
      if (typeof name === "string" && name.length > 0) knownNames.add(name);
    }
  });

  columns.forEach((col, i) => {
    const label = `Column ${i + 1}`;
    if (!col || typeof col !== "object" || Array.isArray(col)) {
      errors.push(`${label}: must be an object.`);
      return;
    }
    const c = col as Record<string, unknown>;
    const name = c.column_name;
    const display = c.display_label;
    const type = c.type;
    const ref = `${label}${typeof name === "string" ? ` (${name})` : ""}`;

    // Required fields.
    if (typeof name !== "string" || name.length === 0) {
      errors.push(`${label}: missing column_name.`);
    } else {
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }

    if (typeof display !== "string" || display.length === 0) {
      errors.push(`${ref}: missing display_label.`);
    }

    if (typeof type !== "string" || type.length === 0) {
      errors.push(`${ref}: missing type.`);
    } else if (!SUPPORTED.has(type)) {
      errors.push(`${ref}: unsupported type "${type}".`);
    }

    // Position duplicates.
    const position = c.position;
    if (typeof position === "number") {
      positionCounts.set(position, (positionCounts.get(position) ?? 0) + 1);
    }

    // Dependent column reference must point to an existing column.
    if (typeof type === "string" && DEPENDENT.has(type)) {
      const validators = c.validators;
      const primary =
        validators && typeof validators === "object"
          ? (validators as Record<string, unknown>).primary_column
          : undefined;
      if (typeof primary !== "string" || primary.length === 0) {
        errors.push(
          `${ref}: dependent type "${type}" requires validators.primary_column.`
        );
      } else if (!knownNames.has(primary)) {
        errors.push(
          `${ref}: validators.primary_column "${primary}" references a non-existent column.`
        );
      }
    }
  });

  // Duplicate column names.
  for (const [name, count] of nameCounts) {
    if (count > 1) errors.push(`Duplicate column_name "${name}" (${count} times).`);
  }

  // Duplicate positions.
  for (const [pos, count] of positionCounts) {
    if (count > 1) errors.push(`Duplicate position ${pos} (${count} columns).`);
  }

  // Advisory: no positions set at all.
  if (positionCounts.size === 0) {
    warnings.push("No column positions set; CSVBox will order columns as given.");
  }

  return { valid: errors.length === 0, errors, warnings };
}

const inputShape = {
  sheet: z
    .record(z.string(), z.unknown())
    .describe("The CSVBox sheet object to validate."),
};

export function registerValidateSchema(server: McpServer): void {
  server.registerTool(
    "validate_schema",
    {
      title: "Validate CSVBox Schema",
      description:
        "Validate a CSVBox sheet schema locally (no API call). Requires a non-empty title; sheet_columns is optional (absent passes, empty yields a warning). When columns are present, checks for missing column_name/display_label/type, unsupported types, duplicate names, duplicate positions, and invalid dependent column references. Returns { valid, errors, warnings }.",
      inputSchema: inputShape,
    },
    async ({ sheet }) => {
      try {
        const result = validateSheet(sheet);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: !result.valid,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { error: err instanceof Error ? err.message : String(err) },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }
    }
  );
}

// Re-exported for typing convenience.
export type { ColumnType };
