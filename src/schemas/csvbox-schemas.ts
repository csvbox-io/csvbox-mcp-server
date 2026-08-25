import { z } from "zod";

/**
 * Authoritative CSVBox sheet model.
 *
 * Derived strictly from the nine documented top-level properties, the supported
 * column types, and the reference payloads under `docs/`. We never invent
 * properties. Every object uses `.passthrough()` so a valid-but-unmodeled
 * CSVBox field is forwarded rather than rejected (fail open, not closed).
 *
 * Source: https://help.csvbox.io/advanced-installation/sheet-api
 */

/** The 18 documented column types. */
export const COLUMN_TYPES = [
  "text",
  "number",
  "email",
  "date",
  "time",
  "boolean",
  "regex",
  "ip",
  "url",
  "credit_card",
  "phone_number",
  "currency",
  "list",
  "dependent_list",
  "dynamic_list",
  "dependent_dynamic_list",
  "multiselect_list",
  "multiselect_dynamic_list",
] as const;

export const ColumnTypeSchema = z.enum(COLUMN_TYPES);
export type ColumnType = z.infer<typeof ColumnTypeSchema>;

/** Column types whose `validators.primary_column` references a parent column. */
export const DEPENDENT_COLUMN_TYPES = [
  "dependent_list",
  "dependent_dynamic_list",
] as const;

/**
 * Recursive value entry used by `list` columns (supports nested `dependents`).
 */
export type ListValue = {
  value: string;
  display_label?: string;
  dependents?: ListValue[];
};

export const ListValueSchema: z.ZodType<ListValue> = z.lazy(() =>
  z
    .object({
      value: z.string(),
      display_label: z.string().optional(),
      dependents: z.array(ListValueSchema).optional(),
    })
    .passthrough()
);

/**
 * Type-specific validator shapes. Modeled per the reference payloads, kept
 * permissive (`.passthrough()`, all optional) so partial/extended validator
 * objects still parse.
 */
export const ValidatorsSchema = z
  .object({
    // text
    min_length: z.number().optional(),
    max_length: z.number().optional(),
    // number
    min_value: z.number().optional(),
    max_value: z.number().optional(),
    // date / time
    format: z.string().optional(),
    // regex
    expression: z.string().optional(),
    error_message: z.string().optional(),
    // ip
    version: z.string().optional(),
    // phone_number
    country_code: z.string().optional(),
    // currency
    symbol: z.string().optional(),
    require_symbol: z.boolean().optional(),
    // list / multiselect_list
    values: z.union([z.array(ListValueSchema), z.array(z.string())]).optional(),
    case_sensitive: z.boolean().optional(),
    delimiter: z.string().optional(),
    other_values: z.boolean().optional(),
    // dependent_list / dependent_dynamic_list
    primary_column: z.string().optional(),
    // dynamic_list / multiselect_dynamic_list
    source_url: z.string().optional(),
    request_method: z.string().optional(),
    request_headers: z.array(z.unknown()).optional(),
    custom_user_attributes: z.boolean().optional(),
  })
  .passthrough();
export type Validators = z.infer<typeof ValidatorsSchema>;

/** A single sheet column. */
export const SheetColumnSchema = z
  .object({
    column_name: z.string(),
    display_label: z.string(),
    type: ColumnTypeSchema,
    info_hint: z.string().optional(),
    matching_keywords: z.string().optional(),
    validators: ValidatorsSchema.optional(),
    default_value: z.unknown().optional(),
    required: z.boolean().optional(),
    position: z.number().optional(),
  })
  .passthrough();
export type SheetColumn = z.infer<typeof SheetColumnSchema>;

/* ------------------------------------------------------------------------ *
 * Function collections: virtual_columns, validation_functions, data_transforms
 *
 * Three top-level arrays whose items carry a `js_code` string that CSVBox runs
 * during an import. The server NEVER executes or parses that code — it is an
 * opaque string here, capped only by the documented length limit.
 * ------------------------------------------------------------------------ */

/** Documented per-sheet caps for each function collection. */
export const MAX_VIRTUAL_COLUMNS = 20;
export const MAX_VALIDATION_FUNCTIONS = 10;
export const MAX_DATA_TRANSFORMS = 10;

/** Documented per-item limits shared by all three collections. */
export const MAX_DEPENDENCIES_PER_ITEM = 5;
export const MAX_GLOBALS_PER_DEPENDENCY = 5;
export const MAX_JS_CODE_LENGTH = 32768;
export const MAX_NAME_LENGTH = 190;
export const MAX_DEPENDENCY_URL_LENGTH = 512;

/** `scope` applies to validation functions and data transforms. */
export const FUNCTION_SCOPES = ["column", "row"] as const;
export const FunctionScopeSchema = z.enum(FUNCTION_SCOPES);
export type FunctionScope = z.infer<typeof FunctionScopeSchema>;

/** `run_at` applies to data transforms only. */
export const TRANSFORM_RUN_AT = ["before_validation", "after_validation"] as const;
export const TransformRunAtSchema = z.enum(TRANSFORM_RUN_AT);
export type TransformRunAt = z.infer<typeof TransformRunAtSchema>;

/** Only these CDN hosts may serve a dependency script. */
export const ALLOWED_DEPENDENCY_HOSTS = [
  "cdn.jsdelivr.net",
  "unpkg.com",
  "cdnjs.cloudflare.com",
] as const;

/** A dependency's exported global names must be plain JS identifiers. */
export const GLOBAL_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

/**
 * A third-party script loaded once per import, shared by all three
 * collections. `integrity` is optional per the API but strongly advised —
 * without it the remote file can change under the customer.
 */
export const JsDependencySchema = z
  .object({
    url: z.string().max(MAX_DEPENDENCY_URL_LENGTH),
    globals: z.array(z.string()).optional(),
    integrity: z.string().optional(),
  })
  .passthrough();
export type JsDependency = z.infer<typeof JsDependencySchema>;

/**
 * `js_code` is optional at the schema level because a PATCH `_delete` item
 * legitimately omits it. `validateSheet` enforces the real rule: required
 * unless `_delete` is true.
 */
const jsCode = z.string().max(MAX_JS_CODE_LENGTH).optional();
const functionCommon = {
  js_code: jsCode,
  active: z.boolean().optional(),
  dependencies: z.array(JsDependencySchema).optional(),
  /** PATCH only — removes the item. Every other field on it is ignored. */
  _delete: z.boolean().optional(),
};

/** Identified by `column_name`; must not collide with a real sheet column. */
export const VirtualColumnSchema = z
  .object({
    column_name: z.string().max(MAX_NAME_LENGTH),
    ...functionCommon,
  })
  .passthrough();
export type VirtualColumn = z.infer<typeof VirtualColumnSchema>;

/** Identified by `function_name`. Returns an array of errors ([] = valid). */
export const ValidationFunctionSchema = z
  .object({
    function_name: z.string().max(MAX_NAME_LENGTH),
    scope: FunctionScopeSchema.optional(),
    columns: z.array(z.string()).optional(),
    /** Columns that exist only at import time — never reference-checked. */
    dynamic_columns: z.array(z.string()).optional(),
    ...functionCommon,
  })
  .passthrough();
export type ValidationFunction = z.infer<typeof ValidationFunctionSchema>;

/** Identified by `transform_name`. Mutates the `csvbox` object and returns it. */
export const DataTransformSchema = z
  .object({
    transform_name: z.string().max(MAX_NAME_LENGTH),
    scope: FunctionScopeSchema.optional(),
    run_at: TransformRunAtSchema.optional(),
    columns: z.array(z.string()).optional(),
    dynamic_columns: z.array(z.string()).optional(),
    ...functionCommon,
  })
  .passthrough();
export type DataTransform = z.infer<typeof DataTransformSchema>;

/**
 * Top-level sheet schema covering the 9 documented properties. Only
 * `sheet_columns` is meaningfully required for generation flows; everything
 * else is optional, and unknown keys (e.g. `steps`, `security_settings`
 * sub-fields) pass through untouched.
 */
export const SheetSchema = z
  .object({
    title: z.string().optional(),
    webhooks: z.array(z.unknown()).optional(),
    destinations: z.array(z.unknown()).optional(),
    sheet_columns: z.array(SheetColumnSchema).optional(),
    steps: z.record(z.string(), z.unknown()).optional(),
    security_settings: z.record(z.string(), z.unknown()).optional(),
    virtual_columns: z.array(VirtualColumnSchema).optional(),
    validation_functions: z.array(ValidationFunctionSchema).optional(),
    data_transforms: z.array(DataTransformSchema).optional(),
  })
  .passthrough();
export type Sheet = z.infer<typeof SheetSchema>;
