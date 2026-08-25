import { test, expect } from './support/fixtures';
import { connectAndOpenTools } from './support/connect';

const EXPECTED_TOOLS = [
  'Create CSVBox Sheet',
  'Update (Replace) CSVBox Sheet',
  'Patch CSVBox Sheet',
  'Generate CSVBox Sheet JSON',
  'Create Importer From Prompt',
  'Generate CSVBox Integration Code',
  'Generate CSVBox Sheet Functions',
  'Validate CSVBox Schema',
  'Submit File via CSVBox REST File API',
];

const EXPECTED_PROMPTS = ['Create CSVBox Sheet', 'Author CSVBox Sheet Functions'];

test('lists every registered tool and prompt through the Inspector UI', async ({ page }) => {
  await connectAndOpenTools(page);

  for (const name of EXPECTED_TOOLS) {
    await expect(page.getByRole('button', { name })).toBeVisible();
  }

  const tabs = page.getByRole('radiogroup').first();
  await tabs.getByText('Prompts', { exact: true }).click();
  // The Tools panel unmounts asynchronously after the tab switch; wait for it
  // to be gone so its tool buttons can't ambiguously match a prompt lookup.
  await expect(page.getByRole('heading', { name: 'Tools', level: 3 })).toHaveCount(0);

  for (const name of EXPECTED_PROMPTS) {
    await expect(page.getByRole('button', { name })).toBeVisible();
  }
});
