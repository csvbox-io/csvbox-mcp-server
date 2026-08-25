import { test, expect } from './support/fixtures';
import { connectAndOpenTools } from './support/connect';
import { selectTool, fillField, selectComboOption, executeTool, readResult, closeResults } from './support/tool-page';
import type { Page } from '@playwright/test';

/**
 * Exhaustive boundary/enum/adversarial matrix for validate_schema, covering
 * every rule enforced by src/tools/validate-schema.ts. See
 * openspec/changes/e2e-full-coverage-security-suite/tasks.md #3 for the
 * checklist this file implements.
 */

interface ValidateResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

async function runValidate(page: Page, sheet: unknown, mode?: 'create' | 'put' | 'patch'): Promise<ValidateResult> {
  await fillField(page, 'sheet', JSON.stringify(sheet));
  if (mode) {
    await selectComboOption(page, 'mode', mode);
  }
  await executeTool(page);
  const result = await readResult(page);
  await closeResults(page);
  return result.json as ValidateResult;
}

function col(overrides: Record<string, unknown> = {}) {
  return { column_name: 'c1', display_label: 'C1', type: 'text', position: 1, ...overrides };
}

function sheet(overrides: Record<string, unknown> = {}) {
  return { title: 'Test Sheet', ...overrides };
}

test.describe('validate_schema matrix', () => {
  test.beforeEach(async ({ page }) => {
    await connectAndOpenTools(page);
    await selectTool(page, 'Validate CSVBox Schema');
  });

  // --- 3.1 Required fields --------------------------------------------------

  test('title is required in create mode', async ({ page }) => {
    const r = await runValidate(page, { sheet_columns: [] });
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/title is required/);
  });

  test('empty title is rejected', async ({ page }) => {
    const r = await runValidate(page, sheet({ title: '' }));
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/title is required/);
  });

  test('patch mode allows an absent title', async ({ page }) => {
    const r = await runValidate(page, { data_transforms: [] }, 'patch');
    expect(r.errors.join()).not.toMatch(/title/);
  });

  test('patch mode rejects an empty title when present', async ({ page }) => {
    const r = await runValidate(page, { title: '' }, 'patch');
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/title must be a non-empty string when present/);
  });

  // --- 3.2 Column types ------------------------------------------------------

  const COLUMN_TYPES = [
    'text', 'number', 'email', 'date', 'time', 'boolean', 'regex', 'ip', 'url',
    'credit_card', 'phone_number', 'currency', 'list', 'dependent_list',
    'dynamic_list', 'dependent_dynamic_list', 'multiselect_list', 'multiselect_dynamic_list',
  ];
  const DEPENDENT_TYPES = new Set(['dependent_list', 'dependent_dynamic_list']);

  for (const type of COLUMN_TYPES) {
    test(`column type "${type}" is accepted`, async ({ page }) => {
      const target = DEPENDENT_TYPES.has(type)
        ? col({ column_name: 'child', display_label: 'Child', type, position: 2, validators: { primary_column: 'parent' } })
        : col({ type });
      const parent = col({ column_name: 'parent', display_label: 'Parent', type: 'text', position: 1 });
      const r = await runValidate(page, sheet({ sheet_columns: DEPENDENT_TYPES.has(type) ? [parent, target] : [target] }));
      expect(r.errors.filter((e) => e.includes('unsupported type'))).toEqual([]);
    });
  }

  test('an unsupported column type is rejected', async ({ page }) => {
    const r = await runValidate(page, sheet({ sheet_columns: [col({ type: 'not_a_real_type' })] }));
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/unsupported type "not_a_real_type"/);
  });

  // --- 3.3 Duplicate names/positions -----------------------------------------

  test('duplicate column_name is rejected', async ({ page }) => {
    const r = await runValidate(page, sheet({
      sheet_columns: [col({ column_name: 'dup', position: 1 }), col({ column_name: 'dup', position: 2 })],
    }));
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/Duplicate column_name "dup"/);
  });

  test('duplicate position is rejected', async ({ page }) => {
    const r = await runValidate(page, sheet({
      sheet_columns: [col({ column_name: 'a', position: 1 }), col({ column_name: 'b', position: 1 })],
    }));
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/Duplicate position 1/);
  });

  test('no column setting a position is a warning, not an error', async ({ page }) => {
    const r = await runValidate(page, sheet({
      sheet_columns: [{ column_name: 'a', display_label: 'A', type: 'text' }],
    }));
    expect(r.valid).toBe(true);
    expect(r.warnings.join()).toMatch(/No column positions set/);
  });

  // --- 3.4 Dependent column primary_column -----------------------------------

  for (const type of ['dependent_list', 'dependent_dynamic_list']) {
    test(`${type} requires validators.primary_column`, async ({ page }) => {
      const r = await runValidate(page, sheet({ sheet_columns: [col({ type })] }));
      expect(r.valid).toBe(false);
      expect(r.errors.join()).toMatch(/requires validators\.primary_column/);
    });

    test(`${type} primary_column must reference an existing column`, async ({ page }) => {
      const r = await runValidate(page, sheet({
        sheet_columns: [col({ type, validators: { primary_column: 'ghost' } })],
      }));
      expect(r.valid).toBe(false);
      expect(r.errors.join()).toMatch(/references a non-existent column/);
    });
  }

  // --- 3.5 Function collection caps ------------------------------------------

  const COLLECTIONS = [
    { key: 'virtual_columns', idField: 'column_name', cap: 20 },
    { key: 'validation_functions', idField: 'function_name', cap: 10 },
    { key: 'data_transforms', idField: 'transform_name', cap: 10 },
  ] as const;

  function items(idField: string, count: number, extra: Record<string, unknown> = {}) {
    return Array.from({ length: count }, (_, i) => ({ [idField]: `item${i}`, js_code: 'return 1;', ...extra }));
  }

  for (const { key, idField, cap } of COLLECTIONS) {
    test(`${key} accepts exactly ${cap} items`, async ({ page }) => {
      const r = await runValidate(page, sheet({ [key]: items(idField, cap) }));
      expect(r.errors.filter((e) => e.includes('allows at most'))).toEqual([]);
    });

    test(`${key} rejects ${cap + 1} items`, async ({ page }) => {
      const r = await runValidate(page, sheet({ [key]: items(idField, cap + 1) }));
      expect(r.valid).toBe(false);
      expect(r.errors.join()).toMatch(new RegExp(`allows at most ${cap}`));
    });
  }

  // --- 3.6 Mode-dependent empty array / _delete semantics --------------------

  for (const { key, idField } of COLLECTIONS) {
    test(`${key}: empty array is an error under put mode`, async ({ page }) => {
      const r = await runValidate(page, sheet({ [key]: [] }), 'put');
      expect(r.valid).toBe(false);
      expect(r.errors.join()).toMatch(/delete every item/);
    });

    test(`${key}: empty array is a warning-only no-op under patch mode`, async ({ page }) => {
      const r = await runValidate(page, sheet({ [key]: [] }), 'patch');
      expect(r.errors.filter((e) => e.includes(key))).toEqual([]);
      expect(r.warnings.join()).toMatch(/ignores it/);
    });

    test(`${key}: empty array is a warning-only under default create mode`, async ({ page }) => {
      const r = await runValidate(page, sheet({ [key]: [] }));
      expect(r.errors.filter((e) => e.includes(key))).toEqual([]);
      expect(r.warnings.join()).toMatch(/Omit the key instead/);
    });

    test(`${key}: _delete is valid under patch`, async ({ page }) => {
      const r = await runValidate(page, sheet({ [key]: [{ [idField]: 'gone', _delete: true }] }), 'patch');
      expect(r.errors.filter((e) => e.includes('_delete'))).toEqual([]);
    });

    test(`${key}: _delete is rejected under create (default)`, async ({ page }) => {
      const r = await runValidate(page, sheet({ [key]: [{ [idField]: 'gone', _delete: true, js_code: 'x' }] }));
      expect(r.valid).toBe(false);
      expect(r.errors.join()).toMatch(/_delete is only valid on a partial update/);
    });

    test(`${key}: _delete is redundant (warning, not error) under put`, async ({ page }) => {
      const r = await runValidate(page, sheet({ [key]: [{ [idField]: 'gone', _delete: true, js_code: 'x' }] }), 'put');
      expect(r.valid).toBe(true);
      expect(r.errors.filter((e) => e.includes('_delete'))).toEqual([]);
      expect(r.warnings.join()).toMatch(/_delete is redundant on a full replace/);
    });
  }

  // --- 3.7 Identifier length + duplicates -------------------------------------

  test('identifier at 190 characters is accepted', async ({ page }) => {
    const name = 'n'.repeat(190);
    const r = await runValidate(page, sheet({ virtual_columns: [{ column_name: name, js_code: 'x' }] }));
    expect(r.errors.filter((e) => e.includes('exceeds'))).toEqual([]);
  });

  test('identifier at 191 characters is rejected', async ({ page }) => {
    const name = 'n'.repeat(191);
    const r = await runValidate(page, sheet({ virtual_columns: [{ column_name: name, js_code: 'x' }] }));
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/exceeds 190 characters/);
  });

  test('duplicate identifiers within a collection are rejected', async ({ page }) => {
    const r = await runValidate(page, sheet({
      virtual_columns: [{ column_name: 'dup', js_code: 'x' }, { column_name: 'dup', js_code: 'y' }],
    }));
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/duplicate column_name "dup"/);
  });

  // --- 3.8 js_code required + length boundary ---------------------------------

  test('js_code is required unless _delete is true', async ({ page }) => {
    const r = await runValidate(page, sheet({ virtual_columns: [{ column_name: 'v' }] }));
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/missing js_code/);
  });

  test('js_code at 32768 characters is accepted', async ({ page }) => {
    const r = await runValidate(page, sheet({ virtual_columns: [{ column_name: 'v', js_code: 'x'.repeat(32768) }] }));
    expect(r.errors.filter((e) => e.includes('js_code is'))).toEqual([]);
  });

  test('js_code at 32769 characters is rejected', async ({ page }) => {
    const r = await runValidate(page, sheet({ virtual_columns: [{ column_name: 'v', js_code: 'x'.repeat(32769) }] }));
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/js_code is 32769 characters/);
  });

  // --- 3.9 scope enum ----------------------------------------------------------

  for (const scope of ['column', 'row']) {
    test(`scope "${scope}" is accepted on validation_functions`, async ({ page }) => {
      const r = await runValidate(page, sheet({ validation_functions: [{ function_name: 'f', js_code: 'x', scope }] }));
      expect(r.errors.filter((e) => e.includes('scope'))).toEqual([]);
    });
  }

  test('an invalid scope is rejected', async ({ page }) => {
    const r = await runValidate(page, sheet({ validation_functions: [{ function_name: 'f', js_code: 'x', scope: 'bogus' }] }));
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/scope "bogus" is not allowed/);
  });

  // --- 3.10 run_at enum (data_transforms only) ---------------------------------

  for (const runAt of ['before_validation', 'after_validation']) {
    test(`run_at "${runAt}" is accepted on data_transforms`, async ({ page }) => {
      const r = await runValidate(page, sheet({ data_transforms: [{ transform_name: 't', js_code: 'x', run_at: runAt }] }));
      expect(r.errors.filter((e) => e.includes('run_at'))).toEqual([]);
    });
  }

  test('an invalid run_at is rejected', async ({ page }) => {
    const r = await runValidate(page, sheet({ data_transforms: [{ transform_name: 't', js_code: 'x', run_at: 'never' }] }));
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/run_at "never" is not allowed/);
  });

  // --- 3.11 columns cross-reference --------------------------------------------

  test('columns referencing a real sheet_columns entry is accepted', async ({ page }) => {
    const r = await runValidate(page, sheet({
      sheet_columns: [col({ column_name: 'email' })],
      validation_functions: [{ function_name: 'f', js_code: 'x', columns: ['email'] }],
    }));
    expect(r.errors.filter((e) => e.includes('columns references'))).toEqual([]);
  });

  test('columns referencing a non-existent column is rejected', async ({ page }) => {
    const r = await runValidate(page, sheet({
      sheet_columns: [col({ column_name: 'email' })],
      validation_functions: [{ function_name: 'f', js_code: 'x', columns: ['ghost'] }],
    }));
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/references "ghost", which is not a column/);
  });

  test('columns without any sheet_columns present warns once instead of erroring', async ({ page }) => {
    const r = await runValidate(page, sheet({
      validation_functions: [{ function_name: 'f', js_code: 'x', columns: ['a'] }],
    }));
    expect(r.errors.filter((e) => e.includes('columns'))).toEqual([]);
    expect(r.warnings.join()).toMatch(/could not be checked because the payload has no sheet_columns/);
  });

  test('a name in both columns and dynamic_columns warns about the overlap', async ({ page }) => {
    const r = await runValidate(page, sheet({
      sheet_columns: [col({ column_name: 'email' })],
      validation_functions: [{ function_name: 'f', js_code: 'x', columns: ['email'], dynamic_columns: ['email'] }],
    }));
    expect(r.warnings.join()).toMatch(/appears in both columns and dynamic_columns/);
  });

  // --- 3.12 virtual_columns collision -------------------------------------------

  test('a virtual_columns name colliding with a real column is rejected', async ({ page }) => {
    const r = await runValidate(page, sheet({
      sheet_columns: [col({ column_name: 'email' })],
      virtual_columns: [{ column_name: 'email', js_code: 'x' }],
    }));
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/collides with a sheet_columns column_name/);
  });

  // --- 3.13 dependencies cap -----------------------------------------------------

  function dep(overrides: Record<string, unknown> = {}) {
    return { url: 'https://cdn.jsdelivr.net/npm/lib@1/index.js', integrity: 'sha256-abc=', ...overrides };
  }

  test('5 dependencies on one item is accepted', async ({ page }) => {
    const r = await runValidate(page, sheet({
      virtual_columns: [{ column_name: 'v', js_code: 'x', dependencies: Array.from({ length: 5 }, () => dep()) }],
    }));
    expect(r.errors.filter((e) => e.includes('the limit is 5'))).toEqual([]);
  });

  test('6 dependencies on one item is rejected', async ({ page }) => {
    const r = await runValidate(page, sheet({
      virtual_columns: [{ column_name: 'v', js_code: 'x', dependencies: Array.from({ length: 6 }, () => dep()) }],
    }));
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/the limit is 5/);
  });

  // --- 3.14 dependency URL rules ---------------------------------------------------

  test('an allowed CDN host with a .js path is accepted', async ({ page }) => {
    const r = await runValidate(page, sheet({
      virtual_columns: [{ column_name: 'v', js_code: 'x', dependencies: [dep()] }],
    }));
    expect(r.errors.filter((e) => e.includes('dependency'))).toEqual([]);
  });

  const URL_REJECTIONS: Array<[string, string, string]> = [
    ['non-https protocol', 'http://cdn.jsdelivr.net/a.js', 'must use https'],
    ['disallowed host', 'https://evil.example.com/a.js', 'is not allowed'],
    ['subdomain bypass attempt', 'https://cdn.jsdelivr.net.evil.com/a.js', 'is not allowed'],
    ['near-miss subdomain', 'https://evil.cdn.jsdelivr.net/a.js', 'is not allowed'],
    ['wrong path suffix', 'https://cdn.jsdelivr.net/a.txt', 'must end in .js or .mjs'],
    ['query string present', 'https://cdn.jsdelivr.net/a.js?x=1', 'must not contain a query string'],
    ['fragment present', 'https://cdn.jsdelivr.net/a.js#frag', 'must not contain a fragment'],
    ['userinfo present', 'https://user:pass@cdn.jsdelivr.net/a.js', 'must not contain userinfo'],
    // :443 is deliberately NOT used here: the WHATWG URL parser silently
    // strips a port that matches the scheme's default (443 for https), so
    // `new URL('https://host:443/x').port === ''` and the rule can never
    // fire for it. A non-default port is required to actually exercise it.
    ['explicit port present', 'https://cdn.jsdelivr.net:8443/a.js', 'must not specify a port'],
  ];

  for (const [label, url, expectedMessage] of URL_REJECTIONS) {
    test(`dependency url rejection: ${label}`, async ({ page }) => {
      const r = await runValidate(page, sheet({
        virtual_columns: [{ column_name: 'v', js_code: 'x', dependencies: [dep({ url })] }],
      }));
      expect(r.valid).toBe(false);
      expect(r.errors.join()).toMatch(new RegExp(expectedMessage));
    });
  }

  // --- 3.15 globals -----------------------------------------------------------------

  test('5 globals is accepted', async ({ page }) => {
    const globals = Array.from({ length: 5 }, (_, i) => `g${i}`);
    const r = await runValidate(page, sheet({
      virtual_columns: [{ column_name: 'v', js_code: 'x', dependencies: [dep({ globals })] }],
    }));
    expect(r.errors.filter((e) => e.includes('globals'))).toEqual([]);
  });

  test('6 globals is rejected', async ({ page }) => {
    const globals = Array.from({ length: 6 }, (_, i) => `g${i}`);
    const r = await runValidate(page, sheet({
      virtual_columns: [{ column_name: 'v', js_code: 'x', dependencies: [dep({ globals })] }],
    }));
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/the limit is 5/);
  });

  test('an invalid global identifier is rejected', async ({ page }) => {
    const r = await runValidate(page, sheet({
      virtual_columns: [{ column_name: 'v', js_code: 'x', dependencies: [dep({ globals: ['not a valid id!'] })] }],
    }));
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/is not a valid JavaScript identifier/);
  });

  // --- 3.16 integrity ------------------------------------------------------------

  test('a missing integrity digest is a warning only', async ({ page }) => {
    const r = await runValidate(page, sheet({
      virtual_columns: [{ column_name: 'v', js_code: 'x', dependencies: [dep({ integrity: undefined })] }],
    }));
    expect(r.valid).toBe(true);
    expect(r.warnings.join()).toMatch(/no integrity digest/);
  });

  for (const algo of ['sha256', 'sha384', 'sha512']) {
    test(`a valid ${algo} integrity digest is accepted`, async ({ page }) => {
      const r = await runValidate(page, sheet({
        virtual_columns: [{ column_name: 'v', js_code: 'x', dependencies: [dep({ integrity: `${algo}-abc123=` })] }],
      }));
      expect(r.errors.filter((e) => e.includes('integrity'))).toEqual([]);
    });
  }

  test('an invalid integrity value is rejected', async ({ page }) => {
    const r = await runValidate(page, sheet({
      virtual_columns: [{ column_name: 'v', js_code: 'x', dependencies: [dep({ integrity: 'not-a-digest' })] }],
    }));
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/integrity must be "sha256-", "sha384-", or "sha512-"/);
  });

  // --- 3.17 documented current behavior: unvalidated fields pass through -----------

  test('webhooks, destinations, steps, security_settings, and untracked validators fields are never runtime-checked (documents current behavior, not a guarantee)', async ({ page }) => {
    const r = await runValidate(page, sheet({
      webhooks: [{ this: 'is not even shaped like a webhook' }],
      destinations: ['not-an-object'],
      steps: { anything: 12345 },
      security_settings: { anything: true },
      sheet_columns: [col({ validators: { min_length: 'not-a-number', source_url: 12345 } })],
    }));
    expect(r.valid).toBe(true);
  });

  // --- 3.18 adversarial payloads ----------------------------------------------------

  test('an XSS payload in column_name is echoed as inert text, not executed', async ({ page }) => {
    const payload = '<img src=x onerror=alert(1)>';
    const r = await runValidate(page, sheet({
      sheet_columns: [col({ column_name: 'dup', position: 1 }), col({ column_name: payload, position: 1 })],
    }));
    expect(r.valid).toBe(false);
    // The dialog-safety assertion is implicit: the shared fixture fails the
    // test automatically if any dialog fires while this page is open.
    expect(r.errors.some((e) => e.includes(payload)) || r.errors.some((e) => e.includes('Duplicate position'))).toBe(true);
  });

  test('a __proto__-keyed entry is handled as an ordinary key, no crash', async ({ page }) => {
    const r = await runValidate(page, sheet({
      sheet_columns: [col({ column_name: '__proto__', position: 1 })],
    }));
    expect(r.valid).toBe(true);
  });

  test('a constructor/prototype-keyed function collection item is handled as an ordinary key, no crash', async ({ page }) => {
    const r = await runValidate(page, sheet({
      virtual_columns: [{ column_name: '__proto__', js_code: 'x' }, { column_name: 'constructor', js_code: 'y' }],
    }));
    expect(r.valid).toBe(true);
  });

  test('an extremely long column_name does not hang or crash the tool', async ({ page }) => {
    const huge = 'n'.repeat(50_000);
    const r = await runValidate(page, sheet({ sheet_columns: [col({ column_name: huge })] }));
    expect(typeof r.valid).toBe('boolean');
  });
});
