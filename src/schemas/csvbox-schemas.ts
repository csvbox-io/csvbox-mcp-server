import { z } from "zod";

/**
 * Authoritative CSVBox sheet model.
 *
 * Derived strictly from the documented top-level properties, the supported
 * column types, and the reference payloads under `docs/`. We never invent
 * properties. Every object uses `.passthrough()` so a valid-but-unmodeled
 * CSVBox field is forwarded rather than rejected (fail open, not closed).
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

/**
 * Top-level sheet schema covering the 6 documented properties. Only
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
  })
  .passthrough();
export type Sheet = z.infer<typeof SheetSchema>;
