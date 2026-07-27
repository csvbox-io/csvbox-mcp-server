/**
 * Live smoke test for category/module expansion. Requires a real LLM key
 * (ANTHROPIC_API_KEY or OPENAI_API_KEY) — it calls the provider for real but
 * does NOT touch the CSVBox API (it only runs generateSheetSmart).
 *
 * Usage (from repo root, after `npm run build`):
 *   ANTHROPIC_API_KEY=sk-... LLM_MODEL=claude-sonnet-4-6 node scripts/smoke-expansion.mjs
 *
 * Passes when the ERP prompt yields a valid sheet with >= 100 unique columns.
 */
import { generateSheetSmart } from "../dist/prompts/schema-generator.js";

const PROMPT = `Create a comprehensive ERP manufacturing management spreadsheet with at least 100 columns.
Include modules for: Company Information, Plant Information, Production Orders, Work Orders,
Bill of Materials, Raw Materials, Finished Goods, Inventory, Warehouse Management, Procurement,
Suppliers, Purchase Orders, Goods Receipt, Quality Inspection, Machine Details, Maintenance Schedule,
Employees, Shift Management, Attendance, Payroll, Customers, Sales Orders, Dispatch, Shipping,
Invoice, Payment, Tax (GST), Assets, Audit Logs, Approval Workflow, Remarks.
Use appropriate data types (Text, Number, Email, Date, Boolean, Currency, Percentage, Dropdown,
Phone Number, URL, ID) and add validation such as email format, phone number, GST number,
PIN code, dates, and positive numeric values.`;

const result = await generateSheetSmart(PROMPT);

if (!result.ok) {
  console.error(`FAIL: generation not ok -> ${result.reason}: ${result.message}`);
  process.exit(1);
}
if (!result.validation.valid) {
  console.error("FAIL: schema invalid:", result.validation.errors);
  process.exit(1);
}

const cols = result.sheet.sheet_columns ?? [];
const names = cols.map((c) => c.column_name);
const unique = new Set(names);
const typeCounts = cols.reduce((m, c) => ((m[c.type] = (m[c.type] ?? 0) + 1), m), {});

console.log(`source: ${result.source}`);
console.log(`columns: ${cols.length}  unique: ${unique.size}`);
console.log(`types:`, typeCounts);

const problems = [];
if (cols.length < 100) problems.push(`only ${cols.length} columns (< 100)`);
if (unique.size !== names.length) problems.push("duplicate column_name values");

if (problems.length) {
  console.error("FAIL:", problems.join("; "));
  process.exit(1);
}
console.log("PASS: >= 100 unique, valid columns generated.");
