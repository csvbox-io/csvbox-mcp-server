import { test, expect } from './support/fixtures';
import { connectAndOpenTools } from './support/connect';
import { selectTool, fillField, executeTool, readResult } from './support/tool-page';
import { queueLlmResponse, getLlmRequests } from './support/queue-mock';
import { NO_CREDS_URL } from '../playwright.config';

test.describe('generate_sheet_functions tool', () => {
  test.beforeEach(async ({ page }) => {
    await connectAndOpenTools(page);
    await selectTool(page, 'Generate CSVBox Sheet Functions');
  });

  test('a mocked successful generation with all three collections renders', async ({ page }) => {
    await queueLlmResponse(page, {
      text: JSON.stringify({
        virtual_columns: [{ column_name: 'full_name', js_code: 'return 1;' }],
        validation_functions: [{ function_name: 'has_at', js_code: 'return true;' }],
        data_transforms: [{ transform_name: 'trim', js_code: 'return v;' }],
      }),
    });

    await fillField(page, 'prompt', 'add a virtual column and a validator and a transform');
    await executeTool(page);
    const result = await readResult(page);

    expect(result.isError).toBe(false);
    const json = result.json as Record<string, unknown>;
    expect(json.virtual_columns).toBeTruthy();
    expect(json.validation_functions).toBeTruthy();
    expect(json.data_transforms).toBeTruthy();
  });

  test('an empty collection returned by the LLM is omitted, not returned as []', async ({ page }) => {
    await queueLlmResponse(page, {
      text: JSON.stringify({
        virtual_columns: [{ column_name: 'full_name', js_code: 'return 1;' }],
        validation_functions: [],
      }),
    });

    await fillField(page, 'prompt', 'add a virtual column joining name');
    await executeTool(page);
    const result = await readResult(page);

    expect(result.isError).toBe(false);
    const json = result.json as Record<string, unknown>;
    expect('validation_functions' in json).toBe(false);
    expect('data_transforms' in json).toBe(false);
  });

  test('a non-JSON mocked response is reported as a parse error', async ({ page }) => {
    await queueLlmResponse(page, { text: 'not json {{{' });

    await fillField(page, 'prompt', 'add something');
    await executeTool(page);
    const result = await readResult(page);

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/did not return valid JSON/);
  });

  test('a truncated mocked response is reported as truncated', async ({ page }) => {
    await queueLlmResponse(page, { text: '{"virtual_columns": [', stopReason: 'max_tokens' });

    await fillField(page, 'prompt', 'add something');
    await executeTool(page);
    const result = await readResult(page);

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/cut off by the output token limit/);
  });

  test('an XSS payload in the optional sheet field is forwarded to the LLM and rendered safely', async ({ page }) => {
    await queueLlmResponse(page, {
      text: JSON.stringify({
        virtual_columns: [{ column_name: 'copy', js_code: 'return 1;' }],
      }),
    });

    await fillField(page, 'prompt', 'add a virtual column');
    await fillField(
      page,
      'sheet',
      JSON.stringify({
        title: 'S',
        sheet_columns: [{ column_name: '<script>alert(1)</script>', display_label: 'X', type: 'text', position: 1 }],
      })
    );
    await executeTool(page);
    await readResult(page);

    const requests = await getLlmRequests(page);
    expect(requests.length).toBe(1);
    expect(requests[0].bodyText).toContain('<script>alert(1)</script>');
    // Dialog-safety (nothing executed) is asserted automatically by the fixture.
  });
});

test.describe('generate_sheet_functions tool — no LLM provider configured', () => {
  test('renders a clean NO_LLM_PROVIDER error and never calls the LLM', async ({ page }) => {
    await connectAndOpenTools(page, NO_CREDS_URL);
    await selectTool(page, 'Generate CSVBox Sheet Functions');

    await fillField(page, 'prompt', 'add a virtual column');
    await executeTool(page);
    const result = await readResult(page);

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/No LLM provider configured/);

    const requests = await getLlmRequests(page);
    expect(requests).toEqual([]);
  });
});
