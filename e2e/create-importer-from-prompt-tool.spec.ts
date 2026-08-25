import { test, expect } from './support/fixtures';
import { connectAndOpenTools } from './support/connect';
import { selectTool, fillField, executeTool, readResult } from './support/tool-page';
import { queueLlmResponse, queueCsvboxResponse, getCsvboxRequests, getLlmRequests } from './support/queue-mock';
import { NO_CREDS_URL } from '../playwright.config';

test.describe('create_importer_from_prompt tool', () => {
  test.beforeEach(async ({ page }) => {
    await connectAndOpenTools(page);
    await selectTool(page, 'Create Importer From Prompt');
  });

  test('a generation that fails local validation never calls the CSVBox API', async ({ page }) => {
    // generateSheetSmart always retries once on invalid validation, so an
    // invalid first attempt needs a second queued response for the repair
    // call too — otherwise it hits the mock's unqueued-response path
    // instead of exercising the "still invalid after repair" branch below.
    await queueLlmResponse(page, { text: JSON.stringify({ sheet_columns: [] }) });
    await queueLlmResponse(page, { text: JSON.stringify({ sheet_columns: [] }) });

    await fillField(page, 'prompt', 'Create a customer importer');
    await executeTool(page);
    const result = await readResult(page);

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/API was not called/);

    const requests = await getCsvboxRequests(page);
    expect(requests).toEqual([]);
  });

  test('a valid generation followed by a successful CSVBox create renders both', async ({ page }) => {
    await queueLlmResponse(page, {
      text: JSON.stringify({ title: 'Customers', sheet_columns: [] }),
    });
    await queueCsvboxResponse(page, { status: 201, body: { sheet_license_key: 'lic-abc' } });

    await fillField(page, 'prompt', 'Create a customer importer');
    await executeTool(page);
    const result = await readResult(page);

    expect(result.isError).toBe(false);
    const json = result.json as { generated_schema: { title: string }; api_response: { ok: boolean } };
    expect(json.generated_schema.title).toBe('Customers');
    expect(json.api_response.ok).toBe(true);
  });

  test('a valid generation followed by a CSVBox failure is reported as a Tool Error', async ({ page }) => {
    await queueLlmResponse(page, {
      text: JSON.stringify({ title: 'Customers', sheet_columns: [] }),
    });
    await queueCsvboxResponse(page, { status: 422, body: { message: 'duplicate title' } });

    await fillField(page, 'prompt', 'Create a customer importer');
    await executeTool(page);
    const result = await readResult(page);

    expect(result.isError).toBe(true);
    const json = result.json as { api_response: { ok: boolean } };
    expect(json.api_response.ok).toBe(false);
  });
});

test.describe('create_importer_from_prompt tool — no LLM provider configured', () => {
  test('short-circuits before any network call at all', async ({ page }) => {
    await connectAndOpenTools(page, NO_CREDS_URL);
    await selectTool(page, 'Create Importer From Prompt');

    await fillField(page, 'prompt', 'Create a customer importer');
    await executeTool(page);
    const result = await readResult(page);

    expect(result.isError).toBe(true);
    const json = result.json as { api_response: unknown };
    expect(json.api_response).toBeNull();

    expect(await getLlmRequests(page)).toEqual([]);
    expect(await getCsvboxRequests(page)).toEqual([]);
  });
});
