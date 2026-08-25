/**
 * Boundaries and hostile input.
 *
 * Every limit is asserted on both sides — at the cap passes, one past it fails
 * — and every limit is imported from the schema module. A test that hard-codes
 * 32768 agrees with itself; one that imports MAX_JS_CODE_LENGTH agrees with the
 * schema.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { validateSheet } from "../tools/validate-schema.js";
import {
  ListValueSchema,
  MAX_JS_CODE_LENGTH,
  MAX_NAME_LENGTH,
  MAX_DEPENDENCY_URL_LENGTH,
  MAX_VIRTUAL_COLUMNS,
  MAX_VALIDATION_FUNCTIONS,
  MAX_DATA_TRANSFORMS,
  MAX_DEPENDENCIES_PER_ITEM,
  MAX_GLOBALS_PER_DEPENDENCY,
} from "../schemas/csvbox-schemas.js";
import {
  baseSheet,
  goodDependency,
  stringOfLength,
  virtualColumns,
  validationFunctions,
  dataTransforms,
  dependencies,
  globals,
} from "./support/fixtures.js";

function matching(list: string[], needle: string): string[] {
  return list.filter((m) => m.includes(needle));
}

function sheetPlus(extra: Record<string, unknown>): Record<string, unknown> {
  return { ...baseSheet, ...extra };
}

/** One virtual column carrying `over`, on an otherwise valid sheet. */
function withVirtual(over: Record<string, unknown>): Record<string, unknown> {
  return sheetPlus({
    virtual_columns: [{ column_name: "vc", js_code: "return 1;", ...over }],
  });
}

// --- 7.1 Every limit, both sides ------------------------------------------

interface LimitCase {
  label: string;
  limit: number;
  /** Build a payload whose measured quantity equals `n`. */
  build(n: number): Record<string, unknown>;
  /** Substring the over-limit error must contain. */
  errorNeedle: string;
}

const LIMIT_CASES: LimitCase[] = [
  {
    label: "js_code length",
    limit: MAX_JS_CODE_LENGTH,
    build: (n) => withVirtual({ js_code: stringOfLength(n, "x") }),
    errorNeedle: `the limit is ${MAX_JS_CODE_LENGTH}`,
  },
  {
    label: "virtual column name length",
    limit: MAX_NAME_LENGTH,
    build: (n) => withVirtual({ column_name: stringOfLength(n, "v") }),
    errorNeedle: `column_name exceeds ${MAX_NAME_LENGTH} characters`,
  },
  {
    label: "validation function name length",
    limit: MAX_NAME_LENGTH,
    build: (n) =>
      sheetPlus({
        validation_functions: [
          { function_name: stringOfLength(n, "f"), js_code: "return [];" },
        ],
      }),
    errorNeedle: `function_name exceeds ${MAX_NAME_LENGTH} characters`,
  },
  {
    label: "transform name length",
    limit: MAX_NAME_LENGTH,
    build: (n) =>
      sheetPlus({
        data_transforms: [
          { transform_name: stringOfLength(n, "t"), js_code: "return csvbox;" },
        ],
      }),
    errorNeedle: `transform_name exceeds ${MAX_NAME_LENGTH} characters`,
  },
  {
    label: "dependency url length",
    limit: MAX_DEPENDENCY_URL_LENGTH,
    build: (n) => {
      // Pad the path so the whole URL measures exactly n characters.
      const prefix = "https://cdn.jsdelivr.net/npm/";
      const suffix = ".js";
      const pad = n - prefix.length - suffix.length;
      return withVirtual({
        dependencies: [
          {
            url: `${prefix}${stringOfLength(pad, "p")}${suffix}`,
            integrity: goodDependency.integrity,
          },
        ],
      });
    },
    errorNeedle: `dependency url exceeds ${MAX_DEPENDENCY_URL_LENGTH} characters`,
  },
  {
    label: "virtual_columns cap",
    limit: MAX_VIRTUAL_COLUMNS,
    build: (n) => sheetPlus({ virtual_columns: virtualColumns(n) }),
    errorNeedle: `CSVBox allows at most ${MAX_VIRTUAL_COLUMNS} per sheet`,
  },
  {
    label: "validation_functions cap",
    limit: MAX_VALIDATION_FUNCTIONS,
    build: (n) => sheetPlus({ validation_functions: validationFunctions(n) }),
    errorNeedle: `CSVBox allows at most ${MAX_VALIDATION_FUNCTIONS} per sheet`,
  },
  {
    label: "data_transforms cap",
    limit: MAX_DATA_TRANSFORMS,
    build: (n) => sheetPlus({ data_transforms: dataTransforms(n) }),
    errorNeedle: `CSVBox allows at most ${MAX_DATA_TRANSFORMS} per sheet`,
  },
  {
    label: "dependencies per item",
    limit: MAX_DEPENDENCIES_PER_ITEM,
    build: (n) => withVirtual({ dependencies: dependencies(n) }),
    errorNeedle: `the limit is ${MAX_DEPENDENCIES_PER_ITEM}`,
  },
  {
    label: "globals per dependency",
    limit: MAX_GLOBALS_PER_DEPENDENCY,
    build: (n) =>
      withVirtual({ dependencies: [{ ...goodDependency, globals: globals(n) }] }),
    errorNeedle: `the limit is ${MAX_GLOBALS_PER_DEPENDENCY}`,
  },
];

for (const testCase of LIMIT_CASES) {
  test(`${testCase.label}: exactly at the limit is accepted`, () => {
    const result = validateSheet(testCase.build(testCase.limit));
    assert.deepEqual(
      matching(result.errors, testCase.errorNeedle),
      [],
      `at-limit value was rejected: ${result.errors.join(" | ")}`
    );
  });

  test(`${testCase.label}: one past the limit is rejected`, () => {
    const result = validateSheet(testCase.build(testCase.limit + 1));
    assert.equal(result.valid, false, "over-limit value was accepted");
    assert.equal(
      matching(result.errors, testCase.errorNeedle).length,
      1,
      `expected an error containing "${testCase.errorNeedle}", got: ${result.errors.join(" | ")}`
    );
  });
}

test("a zero-length js_code is accepted — the schema caps length, it does not require content", () => {
  const result = validateSheet(withVirtual({ js_code: "" }));
  assert.deepEqual(matching(result.errors, "js_code"), []);
});

// --- 7.2 Prototype pollution ----------------------------------------------

test("keys colliding with object internals are treated as ordinary data", () => {
  const polluted = {
    title: "T",
    __proto__: { polluted: true },
    constructor: "not a constructor",
    prototype: [1, 2],
    sheet_columns: [
      { column_name: "__proto__", display_label: "A", type: "text", position: 1 },
      { column_name: "constructor", display_label: "B", type: "text", position: 2 },
      { column_name: "toString", display_label: "C", type: "text", position: 3 },
    ],
    virtual_columns: [
      { column_name: "hasOwnProperty", js_code: "return 1;" },
      { column_name: "__proto__", js_code: "return 2;" },
    ],
  };

  const result = validateSheet(polluted);

  // Nothing global was touched.
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted"), false);

  // `__proto__` appears as both a real and a virtual column: that is a collision,
  // and it must be reported like any other name, not silently swallowed.
  assert.equal(result.valid, false);
  assert.equal(
    matching(result.errors, "collides with a sheet_columns column_name").length,
    1
  );
  assert.deepEqual(matching(result.errors, "hasOwnProperty"), []);
});

test("a duplicate check on internal-sounding names still counts correctly", () => {
  const result = validateSheet({
    title: "T",
    sheet_columns: [
      { column_name: "toString", display_label: "A", type: "text", position: 1 },
      { column_name: "toString", display_label: "B", type: "text", position: 2 },
    ],
  });
  assert.equal(
    matching(result.errors, 'Duplicate column_name "toString" (2 times).').length,
    1
  );
});

// --- 7.3 Degenerate strings -----------------------------------------------

test("whitespace-only and unicode identifiers do not crash and are not silently trimmed", () => {
  const result = validateSheet({
    title: "   ",
    sheet_columns: [
      { column_name: "   ", display_label: " ", type: "text", position: 1 },
      { column_name: "名前", display_label: "名前", type: "text", position: 2 },
      { column_name: "émail", display_label: "Email", type: "email", position: 3 },
      { column_name: "🚀", display_label: "Rocket", type: "text", position: 4 },
    ],
  });

  // Whitespace is content, not absence: the validator checks length, not blankness.
  assert.deepEqual(matching(result.errors, "title is required"), []);
  assert.deepEqual(matching(result.errors, "missing column_name"), []);
  assert.equal(result.valid, true, result.errors.join(" | "));
});

test("a very long identifier is measured in UTF-16 code units, consistently", () => {
  const overBy = stringOfLength(MAX_NAME_LENGTH + 1, "n");
  const overResult = validateSheet(withVirtual({ column_name: overBy }));
  assert.equal(overResult.valid, false);

  // A 10k-character column name is not capped by any documented rule, so it must
  // pass rather than throw.
  const huge = validateSheet({
    title: "T",
    sheet_columns: [
      { column_name: stringOfLength(10_000), display_label: "A", type: "text", position: 1 },
    ],
  });
  assert.equal(huge.valid, true, huge.errors.join(" | "));

  // Surrogate pairs count as two units, matching `String.prototype.length`.
  const emoji = "🚀".repeat(Math.ceil((MAX_NAME_LENGTH + 1) / 2));
  assert.ok(emoji.length > MAX_NAME_LENGTH);
  assert.equal(validateSheet(withVirtual({ column_name: emoji })).valid, false);
});

// --- 7.4 Deep nesting -----------------------------------------------------

test("deeply nested list values parse without blowing the stack", () => {
  let node: Record<string, unknown> = { value: "leaf" };
  for (let i = 0; i < 50; i++) {
    node = { value: `level_${i}`, dependents: [node] };
  }

  const parsed = ListValueSchema.safeParse(node);
  assert.equal(parsed.success, true);

  const result = validateSheet({
    title: "T",
    sheet_columns: [
      {
        column_name: "nested",
        display_label: "Nested",
        type: "list",
        position: 1,
        validators: { values: [node] },
      },
    ],
  });
  assert.equal(result.valid, true, result.errors.join(" | "));
});

// --- 7.5 Unexpected argument types ----------------------------------------

test("wrong-typed fields are reported, never thrown", () => {
  const cases: { payload: Record<string, unknown>; needle: string }[] = [
    {
      payload: sheetPlus({ virtual_columns: "not an array" }),
      needle: "virtual_columns must be an array when present",
    },
    {
      payload: sheetPlus({ validation_functions: [null] }),
      needle: "must be an object",
    },
    {
      payload: sheetPlus({
        validation_functions: [
          { function_name: "f", js_code: "return [];", columns: "email" },
        ],
      }),
      needle: "columns must be an array of strings",
    },
    {
      payload: sheetPlus({
        validation_functions: [
          { function_name: "f", js_code: "return [];", columns: [42] },
        ],
      }),
      needle: "columns entries must be strings",
    },
    {
      payload: sheetPlus({
        validation_functions: [
          { function_name: "f", js_code: "return [];", dynamic_columns: "x" },
        ],
      }),
      needle: "dynamic_columns must be an array of strings",
    },
    {
      payload: withVirtual({ dependencies: { url: "x" } }),
      needle: "dependencies must be an array",
    },
    {
      payload: withVirtual({ dependencies: ["https://cdn.jsdelivr.net/a.js"] }),
      needle: "each dependency must be an object",
    },
    {
      payload: withVirtual({ dependencies: [{ ...goodDependency, globals: "dayjs" }] }),
      needle: "dependency globals must be an array of strings",
    },
    {
      payload: withVirtual({ js_code: 42 }),
      needle: "js_code must be a string",
    },
  ];

  for (const { payload, needle } of cases) {
    const result = validateSheet(payload);
    assert.equal(result.valid, false, `accepted: ${needle}`);
    assert.ok(
      matching(result.errors, needle).length >= 1,
      `expected "${needle}", got: ${result.errors.join(" | ")}`
    );
  }
});

test("a validators field of the wrong type does not throw", () => {
  for (const validators of ["nope", 42, [], null]) {
    const result = validateSheet({
      title: "T",
      sheet_columns: [
        {
          column_name: "c",
          display_label: "C",
          type: "dependent_list",
          position: 1,
          validators,
        },
      ],
    });
    // No parent reference can be found in a non-object, so the documented
    // "requires validators.primary_column" error is the right answer.
    assert.equal(result.valid, false);
    assert.equal(matching(result.errors, "requires validators.primary_column").length, 1);
  }
});

// --- 7.6 Dependency URL edges ---------------------------------------------

test("dependency URL edge cases", () => {
  const cases: { url: string; ok: boolean; needle?: string }[] = [
    // Hosts are lowercased by the URL parser, so uppercase is accepted.
    { url: "https://CDN.JSDELIVR.NET/npm/a.js", ok: true },
    // A trailing dot is a different hostname and is not on the allowlist.
    {
      url: "https://cdn.jsdelivr.net./npm/a.js",
      ok: false,
      needle: "is not allowed",
    },
    // The extension check is case-sensitive by design.
    {
      url: "https://cdn.jsdelivr.net/npm/a.JS",
      ok: false,
      needle: "must end in .js or .mjs",
    },
    { url: "https://cdn.jsdelivr.net/npm/a.mjs", ok: true },
    { url: "https://unpkg.com/a.js", ok: true },
    { url: "https://cdnjs.cloudflare.com/a.js", ok: true },
    // The URL parser strips the scheme's default port, so `:443` on https is
    // indistinguishable from no port at all and reaches the same origin. The
    // port rule exists to catch a NON-default port, and it still does.
    { url: "https://cdn.jsdelivr.net:443/npm/a.js", ok: true },
    {
      url: "https://cdn.jsdelivr.net:8443/npm/a.js",
      ok: false,
      needle: "must not specify a port",
    },
    {
      url: "https://user:pw@cdn.jsdelivr.net/npm/a.js",
      ok: false,
      needle: "must not contain userinfo",
    },
    { url: "not a url at all", ok: false, needle: "is not a valid URL" },
    {
      url: "https://cdn.jsdelivr.net/npm/a.js/../../evil.js",
      ok: true,
      // The URL parser normalizes the traversal away before the path check.
    },
  ];

  for (const { url, ok, needle } of cases) {
    const result = validateSheet(
      withVirtual({ dependencies: [{ url, integrity: goodDependency.integrity }] })
    );
    if (ok) {
      assert.equal(result.valid, true, `${url} was rejected: ${result.errors.join(" | ")}`);
    } else {
      assert.equal(result.valid, false, `${url} was accepted`);
      if (needle) {
        assert.ok(
          matching(result.errors, needle).length >= 1,
          `expected "${needle}" for ${url}, got: ${result.errors.join(" | ")}`
        );
      }
    }
  }
});

test("integrity must name a supported algorithm", () => {
  const bad = ["sha1-abc", "md5-abc", "sha384", "sha384-", "abc123", "SHA384-abc"];
  for (const integrity of bad) {
    const result = validateSheet(
      withVirtual({ dependencies: [{ ...goodDependency, integrity }] })
    );
    assert.equal(result.valid, false, `"${integrity}" was accepted`);
    assert.ok(matching(result.errors, "dependency integrity must be").length >= 1);
  }

  for (const integrity of ["sha256-abc+/=", "sha384-abc", "sha512-a=="]) {
    const result = validateSheet(
      withVirtual({ dependencies: [{ ...goodDependency, integrity }] })
    );
    assert.equal(result.valid, true, `"${integrity}" was rejected`);
  }
});

test("a dependency url at exactly the length limit passes the length rule", () => {
  const prefix = "https://cdn.jsdelivr.net/npm/";
  const suffix = ".js";
  const url = `${prefix}${stringOfLength(
    MAX_DEPENDENCY_URL_LENGTH - prefix.length - suffix.length,
    "p"
  )}${suffix}`;
  assert.equal(url.length, MAX_DEPENDENCY_URL_LENGTH);

  const result = validateSheet(
    withVirtual({ dependencies: [{ url, integrity: goodDependency.integrity }] })
  );
  assert.equal(result.valid, true, result.errors.join(" | "));
});

// --- 7.7 Several rules at once --------------------------------------------

test("a payload breaking many rules reports every one of them", () => {
  const result = validateSheet(
    {
      sheet_columns: [
        { column_name: "dup", display_label: "A", type: "text", position: 1 },
        { column_name: "dup", display_label: "B", type: "nope", position: 1 },
      ],
      virtual_columns: [
        {
          column_name: "dup",
          js_code: stringOfLength(MAX_JS_CODE_LENGTH + 1, "x"),
          _delete: true,
          dependencies: [{ url: "http://evil.test/a.txt" }],
        },
      ],
      data_transforms: [
        { transform_name: "t", js_code: "return csvbox;", run_at: "later", scope: "sheet" },
      ],
    },
    "create"
  );

  assert.equal(result.valid, false);
  const expected = [
    "title is required",
    'Duplicate column_name "dup"',
    "Duplicate position 1",
    'unsupported type "nope"',
    "collides with a sheet_columns column_name",
    `the limit is ${MAX_JS_CODE_LENGTH}`,
    "_delete is only valid on a partial update",
    "dependency url must use https",
    "is not allowed",
    "must end in .js or .mjs",
    'run_at "later" is not allowed',
    'scope "sheet" is not allowed',
  ];
  for (const needle of expected) {
    assert.ok(
      matching(result.errors, needle).length >= 1,
      `missing "${needle}" in: ${result.errors.join(" | ")}`
    );
  }

  // Advisory issues still surface alongside the errors.
  assert.ok(matching(result.warnings, "no integrity digest").length >= 1);
});
