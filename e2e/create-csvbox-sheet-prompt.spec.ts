import { test, expect } from './support/fixtures';
import { connectAndOpenTools } from './support/connect';
import { selectPrompt, fillField, getPrompt, readPromptText } from './support/tool-page';

test.describe('create_csvbox_sheet prompt', () => {
  test.beforeEach(async ({ page }) => {
    await connectAndOpenTools(page);
    await selectPrompt(page, 'Create CSVBox Sheet');
  });

  test('renders the assembled template with the request verbatim', async ({ page }) => {
    await fillField(page, 'request', 'Create a customer importer with name and email');
    await getPrompt(page);
    const text = await readPromptText(page);

    expect(text).toContain('User request');
    expect(text).toContain('Create a customer importer with name and email');
    expect(text).toContain('validate_schema');
    expect(text).toContain('create_sheet');
  });

  test('a request containing markup is rendered as literal text, not executed', async ({ page }) => {
    const payload = '<img src=x onerror=alert(1)>';
    await fillField(page, 'request', payload);
    await getPrompt(page);
    const text = await readPromptText(page);

    // Dialog-safety (nothing executed) is asserted automatically by the
    // shared fixture; this confirms the payload survives as literal text.
    expect(text).toContain(payload);
  });
});
