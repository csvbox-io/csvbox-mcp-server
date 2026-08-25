import { test, expect } from './support/fixtures';
import { connectAndOpenTools } from './support/connect';

test.describe('validate_schema tool', () => {
  test.beforeEach(async ({ page }) => {
    await connectAndOpenTools(page);
    await page.getByRole('button', { name: 'Validate CSVBox Schema' }).click();
  });

  test('renders a success result for a valid sheet', async ({ page }) => {
    await page.getByRole('textbox', { name: 'sheet' }).fill('{"title": "Test Sheet"}');
    await page.getByRole('button', { name: 'Execute Tool' }).click();

    await expect(page.getByRole('heading', { name: 'Results' })).toBeVisible();
    await expect(page.getByText('"valid": true')).toBeVisible();
  });

  test('renders a Tool Error result for an invalid sheet', async ({ page }) => {
    await page.getByRole('textbox', { name: 'sheet' }).fill('{"title": ""}');
    await page.getByRole('button', { name: 'Execute Tool' }).click();

    const errorAlert = page.getByRole('alert', { name: 'Tool Error' });
    await expect(errorAlert).toBeVisible();
    await expect(errorAlert).toContainText('title is required');
  });
});
