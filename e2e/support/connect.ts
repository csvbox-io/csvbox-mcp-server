import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

export async function connectAndOpenTools(page: Page, url = '/'): Promise<void> {
  await page.goto(url);

  const connectSwitch = page.getByRole('switch', { name: /connect or disconnect/i });
  const connected = page.getByText('Connected', { exact: false });

  await connectSwitch.click({ force: true });
  const appeared = await connected
    .waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    // Same click-after-page-load flakiness observed elsewhere in this UI
    // (see tool-page.ts) — retry once before failing for real.
    await connectSwitch.click({ force: true });
  }
  await expect(connected).toBeVisible();

  const tabs = page.getByRole('radiogroup').first();
  await tabs.getByText('Tools', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tools' })).toBeVisible();
}
