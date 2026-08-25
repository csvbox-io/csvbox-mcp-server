import { test, expect } from './support/fixtures';
import { connectAndOpenTools } from './support/connect';
import { selectPrompt, fillField, getPrompt, readPromptText } from './support/tool-page';

test.describe('csvbox_sheet_functions prompt', () => {
  test.beforeEach(async ({ page }) => {
    await connectAndOpenTools(page);
    await selectPrompt(page, 'Author CSVBox Sheet Functions');
  });

  test('renders with the request verbatim and no sheet supplied uses the fallback text', async ({ page }) => {
    await fillField(page, 'request', 'add a virtual column joining first and last name');
    await getPrompt(page);
    const text = await readPromptText(page);

    expect(text).toContain('add a virtual column joining first and last name');
    expect(text).toMatch(/Not supplied\. Reference only column names the request names explicitly/);
    expect(text).toContain('patch_sheet');
  });

  test('renders with both request and sheet supplied', async ({ page }) => {
    await fillField(page, 'request', 'validate every email contains an @');
    await fillField(page, 'sheet', JSON.stringify({ title: 'S', sheet_columns: [{ column_name: 'email' }] }));
    await getPrompt(page);
    const text = await readPromptText(page);

    expect(text).toContain('validate every email contains an @');
    expect(text).toContain('"email"');
    expect(text).not.toMatch(/Not supplied/);
  });

  test('markup in both request and sheet is rendered as literal text, not executed', async ({ page }) => {
    const requestPayload = '<img src=x onerror=alert(1)>';
    const sheetPayload = '{"title": "<script>alert(2)</script>"}';
    await fillField(page, 'request', requestPayload);
    await fillField(page, 'sheet', sheetPayload);
    await getPrompt(page);
    const text = await readPromptText(page);

    // Dialog-safety (nothing executed) is asserted automatically by the
    // shared fixture; this confirms both payloads survive as literal text.
    expect(text).toContain(requestPayload);
    expect(text).toContain('<script>alert(2)</script>');
  });
});
