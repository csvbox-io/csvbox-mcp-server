/**
 * Tests for category/module expansion + truncation handling.
 *
 * No external test framework: uses Node's built-in `node:test` + `node:assert`.
 * Run via:  node --loader ts-node/esm --test src/tests/*.test.ts
 *
 * The LLM is mocked (a fake LlmClient) so tests are deterministic and never
 * hit a real provider. Two layers are covered:
 *  1. The shared system prompt actually carries the expansion rules/mappings.
 *  2. generateSheetSmart routes canned model output correctly (valid vs truncated).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { generateSheetSmart } from "../prompts/schema-generator.js";
import { SHEET_SYSTEM_PROMPT } from "../prompts/sheet-system-prompt.js";
import type { CompleteResult } from "../services/llm-client.js";
import { fakeLlm } from "./support/fake-llm.js";

// --- System prompt wiring -------------------------------------------------

test("system prompt defines expansion vs extraction modes", () => {
  assert.match(SHEET_SYSTEM_PROMPT, /EXPANSION mode/);
  assert.match(SHEET_SYSTEM_PROMPT, /EXTRACTION mode/);
  assert.match(SHEET_SYSTEM_PROMPT, /Never expand an extraction prompt/);
});

test("system prompt carries the type + validator mappings", () => {
  // Dropdown -> list, Percentage -> number 0..100, ID -> text, positive numeric.
  assert.match(SHEET_SYSTEM_PROMPT, /dropdown[\s\S]*?-> list/i);
  assert.match(SHEET_SYSTEM_PROMPT, /percentage[\s\S]*?max_value 100/i);
  assert.match(SHEET_SYSTEM_PROMPT, /positive numeric[\s\S]*?min_value 0/i);
  // Exact GST + PIN regex strings so the model cannot invent broken ones.
  assert.ok(
    SHEET_SYSTEM_PROMPT.includes(
      "^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$"
    ),
    "GSTIN regex present"
  );
  assert.ok(
    SHEET_SYSTEM_PROMPT.includes("^[1-9][0-9]{5}$"),
    "PIN code regex present"
  );
});

test("system prompt includes the module playbook and dedup directive", () => {
  assert.match(SHEET_SYSTEM_PROMPT, /playbook/i);
  assert.match(SHEET_SYSTEM_PROMPT, /supplier_gstin/);
  assert.match(SHEET_SYSTEM_PROMPT, /globally UNIQUE/);
});

// --- Pipeline behavior with mocked model ----------------------------------

test("valid expansion output passes validation with prefixed, typed columns", async () => {
  const canned: CompleteResult = {
    truncated: false,
    text: JSON.stringify({
      title: "Procurement Importer",
      sheet_columns: [
        { column_name: "supplier_id", display_label: "Supplier Id", type: "text" },
        {
          column_name: "supplier_gstin",
          display_label: "Supplier GSTIN",
          type: "regex",
          validators: { expression: "^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$" },
        },
        {
          column_name: "po_status",
          display_label: "Po Status",
          type: "list",
          validators: { values: ["draft", "approved"] },
        },
        {
          column_name: "po_quantity",
          display_label: "Po Quantity",
          type: "number",
          validators: { min_value: 0 },
        },
      ],
    }),
  };
  const llm = fakeLlm(canned);
  const result = await generateSheetSmart("modules for Suppliers, Purchase Orders", {}, llm);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.validation.valid, true);
  const names = result.sheet.sheet_columns!.map((c) => c.column_name);
  // prefixed + globally unique
  assert.deepEqual(names, [...new Set(names)]);
  assert.ok(names.every((n) => /^(supplier|po)_/.test(n)));
  // right types survived
  const byName = Object.fromEntries(
    result.sheet.sheet_columns!.map((c) => [c.column_name, c])
  );
  assert.equal(byName.supplier_gstin.type, "regex");
  assert.equal(byName.po_status.type, "list");
  assert.equal(byName.po_quantity.type, "number");
});

test("truncated model response yields TRUNCATED and never a parsed sheet", async () => {
  // A cut-off body: opening brace only, no valid JSON.
  const llm = fakeLlm({ truncated: true, text: '{"title":"ERP","sheet_columns":[{"column' });
  const result = await generateSheetSmart("comprehensive ERP with at least 100 columns", {}, llm);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "TRUNCATED");
  // Only one model call; no repair loop on truncation.
  assert.equal(llm.calls, 1);
});

test("explicit-column prompt with valid output is not altered by the pipeline", async () => {
  const llm = fakeLlm({
    truncated: false,
    text: JSON.stringify({
      title: "Customers",
      sheet_columns: [
        { column_name: "name", display_label: "Name", type: "text" },
        { column_name: "email", display_label: "Email", type: "email" },
        { column_name: "phone", display_label: "Phone", type: "phone_number" },
      ],
    }),
  });
  const result = await generateSheetSmart("columns name, email, phone", {}, llm);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.sheet.sheet_columns!.length, 3);
});
