import { test, expect } from './support/fixtures';
import { connectAndOpenTools } from './support/connect';
import { selectTool, fillField, executeTool, readResult } from './support/tool-page';
import { queueCsvboxResponse, getCsvboxRequests } from './support/queue-mock';

test.describe('patch_sheet tool', () => {
  test.beforeEach(async ({ page }) => {
    await connectAndOpenTools(page);
    await selectTool(page, 'Patch CSVBox Sheet');
  });

  test('a mocked successful CSVBox response renders as non-error', async ({ page }) => {
    await queueCsvboxResponse(page, { status: 200, body: { sheet_license_key: 'lic-1' } });

    await fillField(page, 'sheet_license_key', 'lic-1');
    await fillField(page, 'changes', JSON.stringify({ data_transforms: [{ transform_name: 't', _delete: true }] }));
    await executeTool(page);
    const result = await readResult(page);

    expect(result.isError).toBe(false);
  });

  test('a mocked CSVBox failure renders as a Tool Error', async ({ page }) => {
    await queueCsvboxResponse(page, { status: 500, body: 'upstream exploded' });

    await fillField(page, 'sheet_license_key', 'lic-1');
    await fillField(page, 'changes', JSON.stringify({ title: 'X' }));
    await executeTool(page);
    const result = await readResult(page);

    expect(result.isError).toBe(true);
  });

  test('a license key with path-meta characters reaches the mock as one encoded segment', async ({ page }) => {
    await queueCsvboxResponse(page, { status: 200, body: {} });

    const hostile = '../../etc#passwd?x=1';
    await fillField(page, 'sheet_license_key', hostile);
    await fillField(page, 'changes', JSON.stringify({ title: 'X' }));
    await executeTool(page);
    await readResult(page);

    const requests = await getCsvboxRequests(page);
    expect(requests.length).toBe(1);
    expect(requests[0].path).toBe(`/1.1/sheet/${encodeURIComponent(hostile)}`);
    expect(requests[0].path.slice('/1.1/sheet/'.length)).not.toContain('/');
  });
});
