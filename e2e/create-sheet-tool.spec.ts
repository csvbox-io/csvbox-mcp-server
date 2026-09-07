import { test, expect } from './support/fixtures';
import { connectAndOpenTools } from './support/connect';
import { selectTool, fillField, executeTool, readResult } from './support/tool-page';
import { queueCsvboxResponse, getCsvboxRequests } from './support/queue-mock';
import { expectMcpIdentification } from './support/identification';
import { NO_CREDS_URL } from '../playwright.config';

test.describe('create_sheet tool', () => {
  test.beforeEach(async ({ page }) => {
    await connectAndOpenTools(page);
    await selectTool(page, 'Create CSVBox Sheet');
  });

  test('a mocked successful CSVBox response renders as non-error', async ({ page }) => {
    await queueCsvboxResponse(page, { status: 201, body: { sheet_license_key: 'lic-123' } });

    await fillField(page, 'sheet', JSON.stringify({ title: 'Test Sheet' }));
    await executeTool(page);
    const result = await readResult(page);

    expect(result.isError).toBe(false);
    const json = result.json as { ok: boolean; data: { sheet_license_key: string } };
    expect(json.ok).toBe(true);
    expect(json.data.sheet_license_key).toBe('lic-123');
  });

  test('a mocked CSVBox failure renders as a Tool Error', async ({ page }) => {
    await queueCsvboxResponse(page, { status: 422, body: { message: 'title is required' } });

    await fillField(page, 'sheet', JSON.stringify({}));
    await executeTool(page);
    const result = await readResult(page);

    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean };
    expect(json.ok).toBe(false);
  });

  test('the request identifies itself to CSVBox as the MCP client', async ({ page }) => {
    await queueCsvboxResponse(page, { status: 201, body: { sheet_license_key: 'lic-123' } });

    await fillField(page, 'sheet', JSON.stringify({ title: 'Test Sheet' }));
    await executeTool(page);
    await readResult(page);

    const requests = await getCsvboxRequests(page);
    expect(requests.length).toBe(1);
    expectMcpIdentification(requests[0]);
  });
});

test.describe('create_sheet tool — missing credentials', () => {
  test('fails fast with a clean error and never reaches the mock', async ({ page }) => {
    await connectAndOpenTools(page, NO_CREDS_URL);
    await selectTool(page, 'Create CSVBox Sheet');
    await fillField(page, 'sheet', JSON.stringify({ title: 'Test Sheet' }));
    await executeTool(page);
    const result = await readResult(page);

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Missing CSVBOX_API_KEY/);

    // The mock server the primary instance would have used never sees a
    // request at all — getCredentials() throws before any network call.
    const requests = await getCsvboxRequests(page);
    expect(requests).toEqual([]);
  });
});
