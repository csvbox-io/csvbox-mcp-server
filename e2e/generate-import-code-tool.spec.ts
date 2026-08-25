import { test, expect } from './support/fixtures';
import { connectAndOpenTools } from './support/connect';
import { selectTool, selectComboOption, executeTool, readResult } from './support/tool-page';

test.describe('generate_import_code tool', () => {
  test.beforeEach(async ({ page }) => {
    await connectAndOpenTools(page);
    await selectTool(page, 'Generate CSVBox Integration Code');
  });

  for (const framework of ['vanilla-js', 'react', 'vuejs2', 'vuejs3', 'angular', 'angular2']) {
    test(`renders framework-specific code for ${framework}`, async ({ page }) => {
      await selectComboOption(page, 'framework', framework);
      await executeTool(page);
      const result = await readResult(page);

      expect(result.isError).toBe(false);
      expect(result.text).toContain(`Framework: ${framework}`);
      expect(result.text).toContain('YOUR_SHEET_LICENSE_KEY');
    });
  }

  test('a successful result carries no isError key at all', async ({ page }) => {
    await selectComboOption(page, 'framework', 'react');
    await executeTool(page);

    // generate_import_code's success envelope omits `isError` entirely rather
    // than setting it false — the only tool in the repo that does this.
    // There is no Tool Error alert, which is what readResult uses to decide
    // isError; assert that directly plus the absence of any error indicator.
    await expect(page.getByRole('alert', { name: 'Tool Error' })).not.toBeVisible();
    await expect(page.getByRole('heading', { name: 'Results' })).toBeVisible();
  });
});
