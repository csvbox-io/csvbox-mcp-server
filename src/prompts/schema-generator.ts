/**
 * LLM-backed natural-language -> CSVBox sheet generation.
 *
 * The previous regex/keyword generator is gone: it could not tell a column
 * from a webhook/destination/security/step clause, so rich prompts produced
 * garbage columns. The LLM is now the only generation path. When no provider
 * is configured, generation returns a NO_LLM_PROVIDER result — there is no
 * regex fallback.
 */

import type { Sheet } from "../schemas/csvbox-schemas.js";
import { resolveLlm, type LlmClient } from "../services/llm-client.js";
import { validateSheet, type ValidationResult } from "../tools/validate-schema.js";
import { SHEET_SYSTEM_PROMPT, repairNote } from "./sheet-system-prompt.js";

export interface NoProviderResult {
  ok: false;
  reason: "NO_LLM_PROVIDER";
  message: string;
}

export interface ParseErrorResult {
  ok: false;
  reason: "PARSE_ERROR";
  message: string;
  raw: string;
}

export interface TruncatedResult {
  ok: false;
  reason: "TRUNCATED";
  message: string;
  raw: string;
}

export interface SheetResult {
  ok: true;
  sheet: Sheet;
  source: string;
  validation: ValidationResult;
}

export type GenerateResult =
  | SheetResult
  | NoProviderResult
  | ParseErrorResult
  | TruncatedResult;

const TRUNCATED_MESSAGE =
  "The model's response was cut off by the output token limit before it finished. " +
  "The generated sheet is incomplete, so the CSVBox API was not called. Reduce the " +
  "requested column count, split the request into fewer modules, or set a model with a " +
  "larger output budget via LLM_MODEL and retry.";

const NO_PROVIDER_MESSAGE =
  "No LLM provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY to use server-side generation, " +
  "or use the 'create_csvbox_sheet' MCP prompt so your host LLM builds the sheet with no server key.";

/**
 * Parse model output that may be wrapped in ```json fences or surrounding
 * prose. Strips a leading/trailing fence and trims, then JSON.parse. Returns
 * the parsed value or throws (caller converts to a structured error).
 */
export function parseJsonLenient(raw: string): unknown {
  let text = raw.trim();

  // Strip a fenced block if present: ```json ... ``` or ``` ... ```
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) {
    text = fence[1].trim();
  } else {
    // Otherwise extract the outermost {...} span if there's surrounding prose.
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first > 0 && last > first) {
      text = text.slice(first, last + 1);
    }
  }

  return JSON.parse(text);
}

/**
 * Generate a complete CSVBox sheet from a natural-language prompt via the
 * configured LLM, with one validate-and-repair retry. No regex fallback: if no
 * provider is configured, returns a NO_LLM_PROVIDER result.
 */
export async function generateSheetSmart(
  prompt: string,
  env: NodeJS.ProcessEnv = process.env,
  llmOverride?: LlmClient
): Promise<GenerateResult> {
  const llm: LlmClient | null = llmOverride ?? resolveLlm(env);
  if (!llm) {
    return { ok: false, reason: "NO_LLM_PROVIDER", message: NO_PROVIDER_MESSAGE };
  }

  const source = `llm:${llm.provider}:${llm.model}`;

  // First attempt.
  let result = await llm.complete({ system: SHEET_SYSTEM_PROMPT, user: prompt });
  let raw = result.text;

  // Truncated output is incomplete JSON; report it distinctly, never parse it.
  if (result.truncated) {
    return { ok: false, reason: "TRUNCATED", message: TRUNCATED_MESSAGE, raw };
  }

  let sheet: Sheet;
  try {
    sheet = parseJsonLenient(raw) as Sheet;
  } catch (err) {
    return {
      ok: false,
      reason: "PARSE_ERROR",
      message: `LLM did not return valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      raw,
    };
  }

  let validation = validateSheet(sheet);

  // One repair attempt feeding back the validation errors.
  if (!validation.valid) {
    result = await llm.complete({
      system: SHEET_SYSTEM_PROMPT,
      user: prompt + repairNote(validation),
    });
    raw = result.text;
    if (result.truncated) {
      return { ok: false, reason: "TRUNCATED", message: TRUNCATED_MESSAGE, raw };
    }
    try {
      sheet = parseJsonLenient(raw) as Sheet;
      validation = validateSheet(sheet);
    } catch (err) {
      return {
        ok: false,
        reason: "PARSE_ERROR",
        message: `LLM repair attempt did not return valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        raw,
      };
    }
  }

  return { ok: true, sheet, source, validation };
}
