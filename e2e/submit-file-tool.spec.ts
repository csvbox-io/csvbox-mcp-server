import { test, expect } from './support/fixtures';
import { connectAndOpenTools } from './support/connect';
import { selectTool, fillField, executeTool, readResult } from './support/tool-page';
import { queueCsvboxResponse, getCsvboxRequests } from './support/queue-mock';
import { expectMcpIdentification } from './support/identification';

test.describe('submit_file tool — local precondition checks', () => {
  test.beforeEach(async ({ page }) => {
    await connectAndOpenTools(page);
    await selectTool(page, 'Submit File via CSVBox REST File API');
  });

  test('providing both public_file_url and file_base64 is rejected locally', async ({ page }) => {
    await fillField(page, 'sheet_license_key', 'lic-1');
    await fillField(page, 'public_file_url', 'https://example.com/a.csv');
    await fillField(page, 'file_base64', 'aGVsbG8=');
    await fillField(page, 'file_name', 'a.csv');
    await executeTool(page);
    const result = await readResult(page);

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Provide exactly one of public_file_url or file_base64, not both/);
    expect(await getCsvboxRequests(page)).toEqual([]);
  });

  test('providing neither public_file_url nor file_base64 is rejected locally', async ({ page }) => {
    await fillField(page, 'sheet_license_key', 'lic-1');
    await executeTool(page);
    const result = await readResult(page);

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Provide exactly one of public_file_url or file_base64/);
    expect(await getCsvboxRequests(page)).toEqual([]);
  });

  test('file_base64 without file_name is rejected locally', async ({ page }) => {
    await fillField(page, 'sheet_license_key', 'lic-1');
    await fillField(page, 'file_base64', 'aGVsbG8=');
    await executeTool(page);
    const result = await readResult(page);

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/file_name is required when using file_base64/);
    expect(await getCsvboxRequests(page)).toEqual([]);
  });
});

test.describe('submit_file tool — mock-backed submission', () => {
  test.beforeEach(async ({ page }) => {
    await connectAndOpenTools(page);
    await selectTool(page, 'Submit File via CSVBox REST File API');
  });

  test('a public_file_url submission sends a JSON body and renders success', async ({ page }) => {
    await queueCsvboxResponse(page, { status: 200, body: { ok: true } });

    await fillField(page, 'sheet_license_key', 'lic-1');
    await fillField(page, 'public_file_url', 'https://example.com/a.csv');
    await executeTool(page);
    const result = await readResult(page);

    expect(result.isError).toBe(false);
    const requests = await getCsvboxRequests(page);
    expect(requests[0].headers['content-type']).toMatch(/^application\/json/);
    expect(requests[0].bodyText).toContain('https://example.com/a.csv');
    expectMcpIdentification(requests[0]);
  });

  test('a file_base64 submission sends true multipart with decoded bytes, not a base64 string', async ({ page }) => {
    await queueCsvboxResponse(page, { status: 200, body: { ok: true } });

    const content = 'hello world';
    const base64 = Buffer.from(content).toString('base64');

    await fillField(page, 'sheet_license_key', 'lic-1');
    await fillField(page, 'file_base64', base64);
    await fillField(page, 'file_name', 'data.csv');
    await executeTool(page);
    const result = await readResult(page);

    expect(result.isError).toBe(false);
    const requests = await getCsvboxRequests(page);
    expect(requests[0].headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(requests[0].bodyText).toContain('name="file"');
    expect(requests[0].bodyText).toContain('filename="data.csv"');
    expect(requests[0].bodyText).toContain(content);
    expect(requests[0].bodyText).not.toContain(base64);
    // The multipart path clears Content-Type per-request; identification must
    // still survive that override on the real wire.
    expectMcpIdentification(requests[0]);
  });

  test('malformed base64 does not crash the tool locally; it still reaches the mock', async ({ page }) => {
    await queueCsvboxResponse(page, { status: 200, body: { ok: true } });

    await fillField(page, 'sheet_license_key', 'lic-1');
    await fillField(page, 'file_base64', 'not-!!valid-base64-@@@');
    await fillField(page, 'file_name', 'data.csv');
    await executeTool(page);
    await readResult(page);

    const requests = await getCsvboxRequests(page);
    expect(requests.length).toBe(1);
  });
});
