/**
 * The examples shipped under `docs/` are what users copy. If one drifts out of
 * conformance with the schema, that must fail the build rather than be
 * discovered by a customer.
 *
 * The files are HTTP request transcripts, not bare JSON: a request line, headers,
 * a blank line, then the JSON body — sometimes preceded by a prose note, and
 * sometimes several transcripts in one file. Every body is extracted and checked,
 * and each is validated under the verb of its own request line rather than one
 * guessed from the filename.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SheetSchema } from "../schemas/csvbox-schemas.js";
import { validateSheet, type ValidationMode } from "../tools/validate-schema.js";

/** Tests run from `dist/tests/`, so walk up two levels to the repo root, not cwd. */
const DOCS_DIR = fileURLToPath(new URL("../../docs/", import.meta.url));

const REQUEST_LINE = /^\s*(POST|PUT|PATCH)\s+\/1\.1\//;

interface Transcript {
  mode: ValidationMode;
  body: string;
  /** 1-based line where the body starts, for a diagnosable failure message. */
  line: number;
}

function modeOf(verb: string): ValidationMode {
  if (verb === "PUT") return "put";
  if (verb === "PATCH") return "patch";
  return "create";
}

/**
 * Find the line index closing the JSON object that opens at `start`.
 *
 * Braces inside string literals do not count, so the scanner tracks string and
 * escape state — several examples embed `js_code` containing `{` and `}`.
 */
function findObjectEnd(lines: string[], start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < lines.length; i++) {
    for (const char of lines[i]) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (inString) {
        if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth++;
      else if (char === "}") {
        depth--;
        if (depth === 0) return i;
      }
    }
    escaped = false;
  }
  return -1;
}

/**
 * Every JSON body in a docs file, each paired with the verb of the request line
 * above it. A file can hold more than one transcript — `patch-sheet-example.json`
 * documents a full patch and a `_delete` patch — and all of them are examples a
 * user may copy, so all of them are checked.
 *
 * Anchoring a body on a line that is exactly `{` keeps a header such as
 * `PATCH /1.1/sheet/{sheet_license_key}` from being mistaken for its start.
 */
function transcriptsOf(text: string): Transcript[] {
  const lines = text.split(/\r?\n/);
  const found: Transcript[] = [];
  let mode: ValidationMode | null = null;

  for (let i = 0; i < lines.length; i++) {
    const request = lines[i].match(REQUEST_LINE);
    if (request) {
      mode = modeOf(request[1]);
      continue;
    }

    if (lines[i].trim() !== "{") continue;

    const end = findObjectEnd(lines, i);
    assert.notEqual(end, -1, `unterminated JSON object starting at line ${i + 1}`);
    assert.ok(mode, `a JSON body at line ${i + 1} has no request line above it`);

    found.push({
      mode: mode!,
      body: lines.slice(i, end + 1).join("\n"),
      line: i + 1,
    });
    i = end;
  }

  return found;
}

const FIXTURES = readdirSync(DOCS_DIR).filter((name) => name.endsWith(".json"));

// --- 11.1 The set is non-empty --------------------------------------------

test("the docs directory ships example payloads", () => {
  assert.ok(FIXTURES.length > 0, `no .json examples found in ${DOCS_DIR}`);
  // Guard against a rename silently shrinking coverage.
  assert.ok(
    FIXTURES.includes("create-sheet-example.json"),
    `expected the create example; found ${FIXTURES.join(", ")}`
  );
});

for (const name of FIXTURES) {
  const raw = readFileSync(join(DOCS_DIR, name), "utf8");

  test(`${name}: contains at least one documented request body`, () => {
    assert.ok(transcriptsOf(raw).length > 0, `${name} documents no JSON body`);
  });

  // --- 11.2 Parses and matches the schema ---------------------------------

  test(`${name}: every body parses and matches SheetSchema`, () => {
    for (const { body, line } of transcriptsOf(raw)) {
      let parsed: unknown;
      assert.doesNotThrow(() => {
        parsed = JSON.parse(body);
      }, `${name}:${line} is not a parseable JSON body`);

      const result = SheetSchema.safeParse(parsed);
      assert.equal(
        result.success,
        true,
        `${name}:${line} failed SheetSchema: ${
          result.success ? "" : JSON.stringify(result.error.issues, null, 2)
        }`
      );
    }
  });

  // --- 11.3 Validates under the verb it demonstrates ----------------------

  test(`${name}: every body validates clean under its own verb`, () => {
    for (const { body, mode, line } of transcriptsOf(raw)) {
      const result = validateSheet(JSON.parse(body), mode);
      assert.equal(
        result.valid,
        true,
        `${name}:${line} (mode "${mode}") reported errors:\n  ${result.errors.join("\n  ")}`
      );
    }
  });
}

// --- 11.4 The verb-awareness the examples demonstrate ---------------------

test("the patch example's _delete item is legal under patch and illegal under create", () => {
  const raw = readFileSync(join(DOCS_DIR, "patch-sheet-example.json"), "utf8");
  const bodies = transcriptsOf(raw);

  const collections = ["virtual_columns", "validation_functions", "data_transforms"];
  const withDelete = bodies
    .map(({ body, mode }) => ({ parsed: JSON.parse(body) as Record<string, unknown>, mode }))
    .filter(({ parsed }) =>
      collections.some((key) => {
        const list = parsed[key];
        return (
          Array.isArray(list) &&
          list.some(
            (item) => item && typeof item === "object" && (item as any)._delete === true
          )
        );
      })
    );

  // The example must actually demonstrate _delete, or this test proves nothing.
  assert.ok(withDelete.length > 0, "the patch example no longer demonstrates _delete");

  for (const { parsed, mode } of withDelete) {
    assert.equal(mode, "patch", "_delete is documented under the wrong verb");
    assert.equal(validateSheet(parsed, "patch").valid, true);

    const asCreate = validateSheet(parsed, "create");
    assert.equal(asCreate.valid, false, "_delete was accepted under create");
    assert.ok(
      asCreate.errors.some((e) => e.includes("_delete is only valid on a partial update")),
      `expected the _delete verb error, got:\n  ${asCreate.errors.join("\n  ")}`
    );
  }
});

test("a fixture that drifts out of conformance is caught", () => {
  // Guards the guard: prove the check actually rejects a bad example rather
  // than passing everything.
  const raw = readFileSync(join(DOCS_DIR, "create-sheet-example.json"), "utf8");
  const parsed = JSON.parse(transcriptsOf(raw)[0].body) as Record<string, unknown>;

  const drifted = {
    ...parsed,
    sheet_columns: [
      { column_name: "x", display_label: "X", type: "datetime" },
      ...(Array.isArray(parsed.sheet_columns) ? parsed.sheet_columns : []),
    ],
  };

  assert.equal(SheetSchema.safeParse(drifted).success, false);
  const result = validateSheet(drifted, "create");
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('unsupported type "datetime"')));
});
