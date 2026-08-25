import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  COLUMN_TYPES,
  DEPENDENT_COLUMN_TYPES,
  FUNCTION_SCOPES,
  TRANSFORM_RUN_AT,
  ALLOWED_DEPENDENCY_HOSTS,
  GLOBAL_NAME_PATTERN,
  MAX_VIRTUAL_COLUMNS,
  MAX_VALIDATION_FUNCTIONS,
  MAX_DATA_TRANSFORMS,
  MAX_DEPENDENCIES_PER_ITEM,
  MAX_GLOBALS_PER_DEPENDENCY,
  MAX_JS_CODE_LENGTH,
  MAX_NAME_LENGTH,
  MAX_DEPENDENCY_URL_LENGTH,
  type ColumnType,
} from "../schemas/csvbox-schemas.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Which write verb the payload is headed for. The verb changes what is legal:
 * PUT is authoritative per collection (an empty array deletes everything,
 * and `_delete` on an item is redundant but only a warning), PATCH merges
 * (an empty array is a no-op, and `_delete` is fully valid here).
 * Defaults to "create" so existing single-argument callers are unaffected.
 */
export type ValidationMode = "create" | "put" | "patch";

const SUPPORTED = new Set<string>(COLUMN_TYPES);
const DEPENDENT = new Set<string>(DEPENDENT_COLUMN_TYPES);
const SCOPES = new Set<string>(FUNCTION_SCOPES);
const RUN_AT = new Set<string>(TRANSFORM_RUN_AT);
const DEPENDENCY_HOSTS = new Set<string>(ALLOWED_DEPENDENCY_HOSTS);

/** Subresource Integrity digest: sha256/384/512 plus base64. */
const INTEGRITY_PATTERN = /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/;

/** Describes one of the three function collections so they share one walker. */
interface CollectionSpec {
  key: "virtual_columns" | "validation_functions" | "data_transforms";
  /** The field that identifies an item within the collection. */
  idField: "column_name" | "function_name" | "transform_name";
  cap: number;
  /** True for collections carrying `scope`, `columns`, `dynamic_columns`. */
  scoped: boolean;
  /** True only for data_transforms, which also carry `run_at`. */
  staged: boolean;
}

const COLLECTIONS: CollectionSpec[] = [
  {
    key: "virtual_columns",
    idField: "column_name",
    cap: MAX_VIRTUAL_COLUMNS,
    scoped: false,
    staged: false,
  },
  {
    key: "validation_functions",
    idField: "function_name",
    cap: MAX_VALIDATION_FUNCTIONS,
    scoped: true,
    staged: false,
  },
  {
    key: "data_transforms",
    idField: "transform_name",
    cap: MAX_DATA_TRANSFORMS,
    scoped: true,
    staged: true,
  },
];

/** Accumulator threaded through every check so messages stay in one order. */
interface Ctx {
  errors: string[];
  warnings: string[];
  mode: ValidationMode;
  /** Column names from `sheet_columns`, or null when there is no usable list. */
  knownNames: Set<string> | null;
  /** Set once so the "cannot check references" warning is not repeated. */
  warnedMissingColumns: boolean;
}

/**
 * Validate `sheet_columns`. Returns the set of column names for later
 * reference checks, or null when the list is absent or not an array.
 * Behavior here is unchanged from before function collections existed.
 */
function validateColumns(
  s: Record<string, unknown>,
  errors: string[],
  warnings: string[]
): Set<string> | null {
  const columns = s.sheet_columns;

  if (columns === undefined) return null;

  if (!Array.isArray(columns)) {
    errors.push("sheet_columns must be an array when present.");
    return null;
  }

  if (columns.length === 0) {
    warnings.push("sheet_columns is empty; no columns to validate yet.");
    return new Set<string>();
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

  return knownNames;
}

/**
 * Check one `dependencies` entry. The URL rules are the API's: https only,
 * one of three CDN hosts, a .js/.mjs path, and nothing else in the URL.
 */
function validateDependency(dep: unknown, ref: string, ctx: Ctx): void {
  if (!dep || typeof dep !== "object" || Array.isArray(dep)) {
    ctx.errors.push(`${ref}: each dependency must be an object.`);
    return;
  }
  const d = dep as Record<string, unknown>;

  const url = d.url;
  if (typeof url !== "string" || url.length === 0) {
    ctx.errors.push(`${ref}: dependency requires a url.`);
  } else if (url.length > MAX_DEPENDENCY_URL_LENGTH) {
    ctx.errors.push(
      `${ref}: dependency url exceeds ${MAX_DEPENDENCY_URL_LENGTH} characters.`
    );
  } else {
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      ctx.errors.push(`${ref}: dependency url "${url}" is not a valid URL.`);
    }
    if (parsed) {
      if (parsed.protocol !== "https:") {
        ctx.errors.push(`${ref}: dependency url must use https.`);
      }
      if (!DEPENDENCY_HOSTS.has(parsed.hostname)) {
        ctx.errors.push(
          `${ref}: dependency host "${parsed.hostname}" is not allowed. Allowed hosts: ${ALLOWED_DEPENDENCY_HOSTS.join(", ")}.`
        );
      }
      if (!/\.(?:js|mjs)$/.test(parsed.pathname)) {
        ctx.errors.push(`${ref}: dependency url path must end in .js or .mjs.`);
      }
      if (parsed.search) {
        ctx.errors.push(`${ref}: dependency url must not contain a query string.`);
      }
      if (parsed.hash) {
        ctx.errors.push(`${ref}: dependency url must not contain a fragment.`);
      }
      if (parsed.username || parsed.password) {
        ctx.errors.push(`${ref}: dependency url must not contain userinfo.`);
      }
      if (parsed.port) {
        ctx.errors.push(`${ref}: dependency url must not specify a port.`);
      }
    }
  }

  const globals = d.globals;
  if (globals !== undefined) {
    if (!Array.isArray(globals)) {
      ctx.errors.push(`${ref}: dependency globals must be an array of strings.`);
    } else {
      if (globals.length > MAX_GLOBALS_PER_DEPENDENCY) {
        ctx.errors.push(
          `${ref}: dependency declares ${globals.length} globals; the limit is ${MAX_GLOBALS_PER_DEPENDENCY}.`
        );
      }
      globals.forEach((g) => {
        if (typeof g !== "string" || !GLOBAL_NAME_PATTERN.test(g)) {
          ctx.errors.push(
            `${ref}: dependency global "${String(g)}" is not a valid JavaScript identifier.`
          );
        }
      });
    }
  }

  const integrity = d.integrity;
  if (integrity === undefined) {
    ctx.warnings.push(
      `${ref}: dependency has no integrity digest; the remote script can change without notice. Add a sha256-/sha384-/sha512- digest.`
    );
  } else if (typeof integrity !== "string" || !INTEGRITY_PATTERN.test(integrity)) {
    ctx.errors.push(
      `${ref}: dependency integrity must be "sha256-", "sha384-", or "sha512-" followed by base64.`
    );
  }
}

/** Validate every item in one function collection. */
function validateCollection(
  s: Record<string, unknown>,
  spec: CollectionSpec,
  ctx: Ctx
): void {
  const raw = s[spec.key];
  if (raw === undefined) return;

  if (!Array.isArray(raw)) {
    ctx.errors.push(`${spec.key} must be an array when present.`);
    return;
  }

  if (raw.length === 0) {
    if (ctx.mode === "put") {
      ctx.errors.push(
        `${spec.key} is an empty array. A full replace treats this as "delete every item in this collection". Omit the key to leave the existing items untouched.`
      );
    } else if (ctx.mode === "patch") {
      ctx.warnings.push(`${spec.key} is an empty array; a partial update ignores it.`);
    } else {
      ctx.warnings.push(
        `${spec.key} is an empty array. Omit the key instead — an empty array deletes every item when sent as a full replace.`
      );
    }
    return;
  }

  if (raw.length > spec.cap) {
    ctx.errors.push(
      `${spec.key} has ${raw.length} items; CSVBox allows at most ${spec.cap} per sheet.`
    );
  }

  const idCounts = new Map<string, number>();

  raw.forEach((item, i) => {
    const ref = `${spec.key}[${i}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      ctx.errors.push(`${ref}: must be an object.`);
      return;
    }
    const it = item as Record<string, unknown>;
    const id = it[spec.idField];
    const named = `${ref}${typeof id === "string" && id.length > 0 ? ` (${id})` : ""}`;

    // Identifier.
    if (typeof id !== "string" || id.length === 0) {
      ctx.errors.push(`${ref}: missing ${spec.idField}.`);
    } else {
      if (id.length > MAX_NAME_LENGTH) {
        ctx.errors.push(
          `${named}: ${spec.idField} exceeds ${MAX_NAME_LENGTH} characters.`
        );
      }
      idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    }

    // `_delete` is only meaningful on a partial update. On a full replace
    // (PUT) the backend already drops any item omitted from the array, so
    // the flag is a harmless no-op there — warn instead of erroring.
    const isDelete = ctx.mode === "patch" && it._delete === true;
    if (it._delete !== undefined) {
      if (ctx.mode === "put") {
        ctx.warnings.push(
          `${named}: _delete is redundant on a full replace (PUT) and will be ignored — omit the item from the array to delete it.`
        );
      } else if (ctx.mode !== "patch") {
        ctx.errors.push(
          `${named}: _delete is only valid on a partial update (PATCH) or full replace (PUT), not on create.`
        );
      }
    }

    // js_code — required unless the item is a delete instruction.
    const js = it.js_code;
    if (js === undefined) {
      if (!isDelete) ctx.errors.push(`${named}: missing js_code.`);
    } else if (typeof js !== "string") {
      ctx.errors.push(`${named}: js_code must be a string.`);
    } else if (js.length > MAX_JS_CODE_LENGTH) {
      ctx.errors.push(
        `${named}: js_code is ${js.length} characters; the limit is ${MAX_JS_CODE_LENGTH}.`
      );
    }

    // Enums.
    if (spec.scoped && it.scope !== undefined) {
      if (typeof it.scope !== "string" || !SCOPES.has(it.scope)) {
        ctx.errors.push(
          `${named}: scope "${String(it.scope)}" is not allowed. Allowed values: ${FUNCTION_SCOPES.join(", ")}.`
        );
      }
    }
    if (spec.staged && it.run_at !== undefined) {
      if (typeof it.run_at !== "string" || !RUN_AT.has(it.run_at)) {
        ctx.errors.push(
          `${named}: run_at "${String(it.run_at)}" is not allowed. Allowed values: ${TRANSFORM_RUN_AT.join(", ")}.`
        );
      }
    }

    // Column references. `dynamic_columns` exist only at import time, so they
    // are deliberately not checked against sheet_columns.
    if (spec.scoped) {
      const cols = it.columns;
      const dyn = it.dynamic_columns;

      if (dyn !== undefined && !Array.isArray(dyn)) {
        ctx.errors.push(`${named}: dynamic_columns must be an array of strings.`);
      }

      if (cols !== undefined) {
        if (!Array.isArray(cols)) {
          ctx.errors.push(`${named}: columns must be an array of strings.`);
        } else if (cols.length > 0) {
          if (ctx.knownNames === null) {
            if (!ctx.warnedMissingColumns) {
              ctx.warnings.push(
                "Column references in validation_functions/data_transforms could not be checked because the payload has no sheet_columns."
              );
              ctx.warnedMissingColumns = true;
            }
          } else {
            cols.forEach((name) => {
              if (typeof name !== "string") {
                ctx.errors.push(`${named}: columns entries must be strings.`);
              } else if (!ctx.knownNames!.has(name)) {
                ctx.errors.push(
                  `${named}: columns references "${name}", which is not a column in sheet_columns.`
                );
              }
            });
          }

          if (Array.isArray(dyn)) {
            const overlap = cols.filter(
              (name) => typeof name === "string" && dyn.includes(name)
            );
            overlap.forEach((name) => {
              ctx.warnings.push(
                `${named}: "${name}" appears in both columns and dynamic_columns.`
              );
            });
          }
        }
      }
    }

    // Dependencies.
    const deps = it.dependencies;
    if (deps !== undefined) {
      if (!Array.isArray(deps)) {
        ctx.errors.push(`${named}: dependencies must be an array.`);
      } else {
        if (deps.length > MAX_DEPENDENCIES_PER_ITEM) {
          ctx.errors.push(
            `${named}: ${deps.length} dependencies declared; the limit is ${MAX_DEPENDENCIES_PER_ITEM}.`
          );
        }
        deps.forEach((dep, di) => validateDependency(dep, `${named} dependency[${di}]`, ctx));
      }
    }
  });

  // Duplicate identifiers within the collection.
  for (const [id, count] of idCounts) {
    if (count > 1) {
      ctx.errors.push(
        `${spec.key}: duplicate ${spec.idField} "${id}" (${count} times).`
      );
    }
  }

  // A virtual column shares the row's name space with real columns.
  if (spec.key === "virtual_columns" && ctx.knownNames) {
    for (const id of idCounts.keys()) {
      if (ctx.knownNames.has(id)) {
        ctx.errors.push(
          `virtual_columns: "${id}" collides with a sheet_columns column_name. Virtual column names must be unique across the whole sheet.`
        );
      }
    }
  }
}

/**
 * Pure local validation of a CSVBox sheet. No API call.
 * Hard problems -> `errors`; advisory issues -> `warnings`.
 *
 * `mode` describes the write verb the payload is headed for. It only affects
 * the function collections (empty arrays and `_delete`); column checks are
 * identical in every mode.
 */
export function validateSheet(
  sheet: unknown,
  mode: ValidationMode = "create"
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (sheet === null || typeof sheet !== "object" || Array.isArray(sheet)) {
    return { valid: false, errors: ["Sheet must be an object."], warnings };
  }

  const s = sheet as Record<string, unknown>;

  // title is required — except on a partial update, where a fragment that only
  // changes (say) data_transforms legitimately carries no title. When a patch
  // does include one, it still has to be a non-empty string.
  const title = s.title;
  if (mode === "patch") {
    if (title !== undefined && (typeof title !== "string" || title.length === 0)) {
      errors.push("title must be a non-empty string when present.");
    }
  } else if (typeof title !== "string" || title.length === 0) {
    errors.push("title is required and must be a non-empty string.");
  }

  // sheet_columns is optional. Absent -> skip column checks. Empty -> warn.
  const knownNames = validateColumns(s, errors, warnings);

  const ctx: Ctx = { errors, warnings, mode, knownNames, warnedMissingColumns: false };
  COLLECTIONS.forEach((spec) => validateCollection(s, spec, ctx));

  return { valid: errors.length === 0, errors, warnings };
}

const inputShape = {
  sheet: z
    .record(z.string(), z.unknown())
    .describe("The CSVBox sheet object to validate."),
  mode: z
    .enum(["create", "put", "patch"])
    .optional()
    .describe(
      'Which write verb this payload is headed for. "create" (default) for POST, "put" for a full replace, "patch" for a partial update. Affects only the function collections: an empty array is an error under "put" (it deletes every item); `_delete` is fully valid under "patch", redundant (warning only) under "put", and an error under "create".'
    ),
};

export function registerValidateSchema(server: McpServer): void {
  server.registerTool(
    "validate_schema",
    {
      title: "Validate CSVBox Schema",
      description:
        "Validate a CSVBox sheet schema locally (no API call). Requires a non-empty title; sheet_columns is optional (absent passes, empty yields a warning). When columns are present, checks for missing column_name/display_label/type, unsupported types, duplicate names, duplicate positions, and invalid dependent column references. Also checks virtual_columns, validation_functions, and data_transforms: per-sheet caps, duplicate and colliding names, missing or oversized js_code, scope/run_at enums, column references against sheet_columns, and dependency URLs (https, allowed CDN hosts, .js/.mjs, integrity digest). Pass mode ('create' | 'put' | 'patch', default 'create') so empty-array and _delete rules match the verb you are about to use. Returns { valid, errors, warnings }.",
      inputSchema: inputShape,
    },
    async ({ sheet, mode }) => {
      try {
        const result = validateSheet(sheet, mode ?? "create");
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
