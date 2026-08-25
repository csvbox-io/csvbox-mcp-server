import type { Page, Locator } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Click a tool by its title in the already-open Tools tab. Same
 * first-click-after-a-transition flakiness observed elsewhere in this UI
 * (see `executeTool`) — probe and retry once defensively.
 */
export async function selectTool(page: Page, title: string): Promise<void> {
  const button = page.getByRole('button', { name: title }).first();
  const executeButton = page.getByRole('button', { name: 'Execute Tool' });

  await button.click();
  const appeared = await executeButton
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    await button.click();
  }
  await expect(executeButton).toBeVisible();
}

/** Switch to the Prompts tab and click a prompt by its title. */
export async function selectPrompt(page: Page, title: string): Promise<void> {
  const tabs = page.getByRole('radiogroup').first();
  await tabs.getByText('Prompts', { exact: true }).click();

  const button = page.getByRole('button', { name: title }).first();
  const argsHeading = page.getByRole('heading', { name: 'Arguments' });

  await button.click();
  const appeared = await argsHeading
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    await button.click();
  }
  await argsHeading.waitFor({ state: 'visible' });
}

/**
 * Fill a free-text/JSON field rendered as a textbox, by its field name.
 * Uses exact name matching — Inspector's default substring matching means
 * e.g. `getByRole('textbox', { name: 'sheet' })` also matches a sibling
 * `sheet_license_key` field, since its accessible name contains "sheet".
 */
export async function fillField(page: Page, name: string, value: string): Promise<void> {
  await page.getByRole('textbox', { name, exact: true }).fill(value);
}

/**
 * Select a value for an enum field (e.g. `mode`, `framework`). These render
 * as a combobox: click the field to open a listbox, then click the option.
 * If focus is moving here from a different field (e.g. right after filling
 * `sheet`), the first click only focuses the trigger without opening the
 * popup — confirmed live: the listbox only appears on a second click in
 * that case. Click, and if the listbox hasn't appeared shortly after,
 * click again.
 */
export async function selectComboOption(page: Page, fieldName: string, option: string): Promise<void> {
  const trigger = page.getByRole('textbox', { name: fieldName, exact: true });
  const listbox = page.getByRole('listbox', { name: fieldName, exact: true });

  await trigger.click();
  if (!(await listbox.isVisible().catch(() => false))) {
    await trigger.click();
  }
  await listbox.waitFor({ state: 'visible' });
  await page.getByRole('option', { name: option, exact: true }).click();
}

async function resultAppeared(page: Page, timeout: number): Promise<boolean> {
  return Promise.race([
    page.getByRole('heading', { name: 'Results' }).waitFor({ state: 'visible', timeout }),
    page.getByRole('alert', { name: 'Tool Error' }).waitFor({ state: 'visible', timeout }),
  ])
    .then(() => true)
    .catch(() => false);
}

export interface ExecuteToolOptions {
  /** How long to wait before deciding the first click didn't register. Default 3s (fine for mocked/hermetic calls). */
  probeTimeout?: number;
  /** How long to wait for the final result once a call is known to be in flight. Default 30s. */
  resultTimeout?: number;
}

/**
 * Click Execute Tool and wait for either a Results panel or a Tool Error
 * alert. A click immediately following focus on a different field (e.g.
 * right after `fillField`) sometimes only re-focuses the button without
 * triggering its handler — confirmed live: no MCP request is sent at all,
 * and a second click is what actually fires it. Probe briefly after the
 * first click and only retry-click if nothing happened AND the button
 * isn't already disabled/loading — a disabled button proves the first
 * click *did* register and a real request is genuinely in flight (just
 * slow, e.g. a real LLM call), so retry-clicking it would only throw
 * "element is not enabled" and waste the probe window. Confirmed live
 * against a real create_importer_from_prompt call whose request was still
 * "Pending" server-side well past a 3s/30s window.
 */
export async function executeTool(page: Page, options: ExecuteToolOptions = {}): Promise<void> {
  const { probeTimeout = 3_000, resultTimeout = 30_000 } = options;
  const button = page.getByRole('button', { name: 'Execute Tool' });
  await button.click();
  if (!(await resultAppeared(page, probeTimeout))) {
    const stillClickable = await button.isEnabled().catch(() => false);
    if (stillClickable) {
      await button.click();
    }
  }
  await resultAppeared(page, resultTimeout);
}

export interface ToolResult {
  isError: boolean;
  /** Raw text content of the result/error panel. */
  text: string;
  /** Parsed JSON if the text content is valid JSON, else undefined. */
  json?: unknown;
}

/** Read back whatever Execute Tool produced, after `executeTool` resolves. */
export async function readResult(page: Page): Promise<ToolResult> {
  const errorAlert = page.getByRole('alert', { name: 'Tool Error' });
  if (await errorAlert.isVisible()) {
    const text = (await errorAlert.textContent()) ?? '';
    return { isError: true, text, json: tryParseJson(text) };
  }

  // The Results heading and its JSON/text content live under a shared
  // Mantine Stack container three DOM levels above the heading itself
  // (heading -> Group[button,heading] -> Group[wrapping that] -> Stack
  // with 2 children: the header Group and the content). Verified directly
  // against the real DOM (not the accessibility tree, whose depth doesn't
  // reliably match) via page.evaluate before relying on this.
  const container = page.getByRole('heading', { name: 'Results' }).locator('..').locator('..').locator('..');
  const text = (await container.textContent()) ?? '';
  return { isError: false, text, json: tryParseJson(text) };
}

function tryParseJson(text: string): unknown {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return undefined;
  try {
    return JSON.parse(text.slice(first, last + 1));
  } catch {
    return undefined;
  }
}

/** Close the results/error panel so the field form is reusable for a second case. */
export async function closeResults(page: Page): Promise<void> {
  const closeButton = page.getByRole('button', { name: 'Close results' });
  if (await closeButton.isVisible()) {
    await closeButton.click();
  }
}

export function toolButton(page: Page, title: string): Locator {
  return page.getByRole('button', { name: title });
}

/**
 * Click Get Prompt and wait for the rendered Messages panel. Same
 * first-click-after-a-different-field flakiness as `executeTool` — probe
 * and retry once if nothing happened.
 */
export async function getPrompt(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: 'Get Prompt' });
  const closeMessages = page.getByRole('button', { name: 'Close messages' });

  await button.click();
  const appeared = await closeMessages
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    await button.click();
  }
  await closeMessages.waitFor({ state: 'visible' });
}

/** Read the rendered prompt message text, after `getPrompt` resolves. */
export async function readPromptText(page: Page): Promise<string> {
  // The monitoring sidebar has its OWN unrelated "Messages" heading (the
  // protocol log), so `getByRole('heading', {name:'Messages'})` is
  // ambiguous once a prompt result is showing — anchor on the "Close
  // messages" button instead, which only exists in the prompt result panel.
  // Same 3-parent-hop container structure as readResult(), verified against
  // the real DOM the same way.
  const container = page.getByRole('button', { name: 'Close messages' }).locator('..').locator('..').locator('..');
  return (await container.textContent()) ?? '';
}

/** Close the rendered Messages panel so the args form is reusable. */
export async function closePromptMessages(page: Page): Promise<void> {
  const closeButton = page.getByRole('button', { name: 'Close messages' });
  if (await closeButton.isVisible()) {
    await closeButton.click();
  }
}
