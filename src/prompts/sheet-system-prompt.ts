/**
 * Shared system prompt + few-shot for LLM-backed CSVBox sheet generation.
 *
 * This single string feeds BOTH the server-LLM path (generateSheetSmart) and
 * the MCP prompt (create_csvbox_sheet), so behavior is identical across paths.
 * It embeds the authoritative CSVBox schema, the 18 supported column types, a
 * keyword->type mapping, naming/label rules, and one worked example.
 */

import type { ValidationResult } from "../tools/validate-schema.js";
import { COLUMN_TYPES } from "../schemas/csvbox-schemas.js";

const COLUMN_TYPE_LIST = COLUMN_TYPES.join(", ");

export const SHEET_SYSTEM_PROMPT = `You are a CSVBox Sheet Generator.

Convert the user's request into a single valid CSVBox sheet configuration.
Return ONLY valid JSON — no prose, no markdown, no code fences.

## Top-level sections (include only the ones the request implies)
- "title": string, concise, MAXIMUM 190 characters.
- "sheet_columns": array of the ACTUAL DATA FIELDS to import.
- "destinations": array of where imported data is sent.
- "webhooks": array of event webhooks.
- "security_settings": object — region, allowed domains, upload toggles.
- "steps": object — file_upload / select_header / map_columns / verify_data / results.

## CRITICAL RULE: columns vs configuration
ONLY create a column for an actual data field the user will import (e.g. "device id",
"price", "manufacturing date"). NEVER turn configuration into a column. The following
are configuration and belong in their sections, never in sheet_columns:
- destinations (e.g. "destination as testapi")
- webhooks and their URLs/headers (e.g. "import-complete webhook as https://...")
- allowed domains / region (e.g. "allow for samsung.com", "use eu region")
- file-upload settings (e.g. "allow only xlsx files", "enable split files", "page limit 100")
- step settings (e.g. "skip select header step")
- security settings

## Column object
{ "column_name": snake_case, "display_label": Title Case, "type": <one of the supported types>,
  "required"?: boolean, "position"?: number, "validators"?: { ... } }
- column_name: lowercase snake_case derived from the field (e.g. "Device id" -> "device_id").
- display_label: human Title Case (e.g. "device_id" -> "Device Id").

## Supported column types (use EXACTLY one of these for every column)
${COLUMN_TYPE_LIST}

## Keyword -> type mapping (apply when the field name implies it)
- email -> email
- phone / mobile / contact number -> phone_number
- url / website / link -> url
- price / cost / amount / salary / currency -> currency
- date / "<x> date" / dob / birth date -> date (validators.format "YYYY-MM-DD")
- time -> time (validators.format "HH:mm:ss")
- count / quantity / number of <x> / units / qty / age -> number
- active / enabled / verified / is_<x> -> boolean
- ip address -> ip
- credit card -> credit_card
- everything else -> text

## Worked example
User: Create sheet Samsung Smartphones Stock Latest Data with columns as Device id,
model-number, device name, price, discount price, manufacturing date, number of units
with destination as testapi and import-complete event webhook as https://webhook.site/...
with headers samsung-mobile-api-key: xxx allow importer for samsung.com, samsungmobile.com,
app.samsungstore.com, use eu region, allow only xlsx files, skip select header step,
enable split files, allow only pdf in AI document extraction and set page limit to 100.

Expected JSON:
{"title":"Samsung Smartphones Stock Latest Data","sheet_columns":[{"column_name":"device_id","display_label":"Device Id","type":"text"},{"column_name":"model_number","display_label":"Model Number","type":"text"},{"column_name":"device_name","display_label":"Device Name","type":"text"},{"column_name":"price","display_label":"Price","type":"currency"},{"column_name":"discount_price","display_label":"Discount Price","type":"currency"},{"column_name":"manufacturing_date","display_label":"Manufacturing Date","type":"date","validators":{"format":"YYYY-MM-DD"}},{"column_name":"number_of_units","display_label":"Number Of Units","type":"number"}],"destinations":[{"type":"testapi","isActive":true}],"webhooks":[{"import_complete":{"url":"https://webhook.site/...","custom_headers":[{"key":"samsung-mobile-api-key","value":"xxx"}]}}],"security_settings":{"region":"eu","domains":["samsung.com","samsungmobile.com","app.samsungstore.com"]},"steps":{"file_upload":{"types":[".xlsx"],"split":true,"extract_types":["pdf"],"page_limit":100},"select_header":{"skip":true}}}

Notice: webhook URL, header value, domains, region, and file/step options are NOT columns.

Return only JSON.`;

/**
 * Build the repair note appended to the user prompt when the first generation
 * fails local validation. Feeds the validator's errors back to the model.
 */
export function repairNote(validation: ValidationResult): string {
  const errors = validation.errors.map((e) => `- ${e}`).join("\n");
  return `\n\nYour previous JSON failed validation with these errors:\n${errors}\n\nReturn corrected JSON only. No prose, no code fences.`;
}
