import type { Page } from '@playwright/test';
import { MOCK_CSVBOX_URL, MOCK_LLM_URL } from '../../playwright.config';

export interface CsvboxResponse {
  status?: number;
  body?: unknown;
}

export interface LlmResponse {
  text?: string;
  stopReason?: string;
  raw?: unknown;
  status?: number;
}

export interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  bodyText: string;
}

async function post(page: Page, url: string, data: unknown): Promise<void> {
  const res = await page.request.post(url, { data });
  if (!res.ok()) {
    throw new Error(`mock admin call to ${url} failed: ${res.status()}`);
  }
}

export function queueCsvboxResponse(page: Page, response: CsvboxResponse): Promise<void> {
  return post(page, `${MOCK_CSVBOX_URL}/__mock__/queue`, response);
}

export function queueLlmResponse(page: Page, response: LlmResponse): Promise<void> {
  return post(page, `${MOCK_LLM_URL}/__mock__/queue`, response);
}

export async function resetMocks(page: Page): Promise<void> {
  await post(page, `${MOCK_CSVBOX_URL}/__mock__/reset`, {});
  await post(page, `${MOCK_LLM_URL}/__mock__/reset`, {});
}

async function getRequests(page: Page, base: string): Promise<CapturedRequest[]> {
  const res = await page.request.get(`${base}/__mock__/requests`);
  return res.json();
}

export function getCsvboxRequests(page: Page): Promise<CapturedRequest[]> {
  return getRequests(page, MOCK_CSVBOX_URL);
}

export function getLlmRequests(page: Page): Promise<CapturedRequest[]> {
  return getRequests(page, MOCK_LLM_URL);
}
