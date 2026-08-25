import { test as base, expect } from '@playwright/test';
import { resetMocks } from './queue-mock';

/**
 * Every spec should import `test`/`expect` from here, not `@playwright/test`
 * directly. This wraps the `page` fixture so every test automatically:
 *  - fails if any `dialog` (alert/confirm/prompt) fires — the concrete
 *    signal for "a payload actually executed" in the XSS-safety cases,
 *  - has both mock servers' queue and request log reset afterward, so a
 *    test that forgets to consume a queued response can't leak into the
 *    next one (the suite runs single-worker/serial, so the mocks' state is
 *    a whole-run-shared resource).
 */
export const test = base.extend<{ page: import('@playwright/test').Page }>({
  page: async ({ page }, use) => {
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => {
      dialogs.push(`[${dialog.type()}] ${dialog.message()}`);
      void dialog.dismiss();
    });

    await use(page);

    expect(dialogs, 'unexpected dialog(s) fired during this test').toEqual([]);
    await resetMocks(page);
  },
});

export { expect };
