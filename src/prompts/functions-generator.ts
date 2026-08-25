/**
 * LLM-backed natural-language -> CSVBox function collections.
 *
 * Mirrors `generateSheetSmart` in schema-generator.ts: resolve a provider, one
 * completion, truncation check, lenient parse, validate, one repair retry. The
 * difference is what it produces — virtual_columns / validation_functions /
 * data_transforms rather than a whole sheet — and that it NEVER calls the
 * CSVBox API. The caller reviews the generated JavaScript and applies it with
 * `patch_sheet`.
 */

import type {
  Sheet,
  VirtualColumn,
  ValidationFunction,
  DataTransform,
} from "../schemas/csvbox-schemas.js";
import { resolveLlm, type LlmClient } from "../services/llm-client.js";
import { validateSheet, type ValidationResult } from "../tools/validate-schema.js";
import {
  FUNCTIONS_SYSTEM_PROMPT,
  functionsRepairNote,
} from "./functions-system-prompt.js";
import { parseJsonLenient } from "./schema-generator.js";
import type {
  NoProviderResult,
  ParseErrorResult,
  TruncatedResult,
} from "./schema-generator.js";

/** The three collections, each present only when the request implied it. */
export interface FunctionsPayload {
  virtual_columns?: VirtualColumn[];
  validation_functions?: ValidationFunction[];
  data_transforms?: DataTransform[];
}

export interface FunctionsSuccess {
  ok: true;
  functions: FunctionsPayload;
  source: string;
  validation: ValidationResult;
}

export type GenerateFunctionsResult =
  | FunctionsSuccess
  | NoProviderResult
  | ParseErrorResult
  | TruncatedResult;

const TRUNCATED_MESSAGE =
  "The model's response was cut off by the output token limit before it finished. " +
  "The generated functions are incomplete, so nothing was returned. Ask for fewer " +
  "functions at a time, or set a model with a larger output budget via LLM_MODEL and retry.";

const NO_PROVIDER_MESSAGE =
  "No LLM provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY to use server-side generation, " +
  "or use the 'csvbox_sheet_functions' MCP prompt so your host LLM authors the functions with no server key.";

const COLLECTION_KEYS = [
  "virtual_columns",
  "validation_functions",
  "data_transforms",
] as const;

/**
 * Keep only the three collections, and drop any that came back empty. An empty
 * array is destructive when sent as a full replace, so it never leaves here.
 */
function pickCollections(parsed: unknown): FunctionsPayload {
  const out: FunctionsPayload = {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  const p = parsed as Record<string, unknown>;

  COLLECTION_KEYS.forEach((key) => {
    const value = p[key];
    if (Array.isArray(value) && value.length > 0) {
      // Cast is safe enough: validateSheet is what actually vets the shape.
      (out as Record<string, unknown>)[key] = value;
    }
  });

  return out;
}

/**
 * Validate generated collections in the context of the sheet they will be
 * applied to. Uses "patch" mode because that is the verb the caller is told to
 * use: `_delete` is legal, and an absent title is not an error for a fragment.
 */
function validateFunctions(
  functions: FunctionsPayload,
  sheet?: Sheet | Record<string, unknown>
): ValidationResult {
  return validateSheet({ ...(sheet ?? {}), ...functions }, "patch");
}

/** Build the user turn: the request plus whatever sheet context we were given. */
function buildUserMessage(
  prompt: string,
  sheet?: Sheet | Record<string, unknown>
): string {
  if (!sheet) {
    return `${prompt}\n\n## Existing sheet\nNot supplied. Reference only column names the request names explicitly, and do not invent others.`;
  }
  return `${prompt}\n\n## Existing sheet\n${JSON.stringify(sheet)}`;
}

/**
 * Generate CSVBox function collections from a natural-language prompt via the
 * configured LLM, with one validate-and-repair retry. No regex fallback: if no
 * provider is configured, returns a NO_LLM_PROVIDER result.
 */
export async function generateFunctionsSmart(
  prompt: string,
  sheet?: Sheet | Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
  llmOverride?: LlmClient
): Promise<GenerateFunctionsResult> {
  const llm: LlmClient | null = llmOverride ?? resolveLlm(env);
  if (!llm) {
    return { ok: false, reason: "NO_LLM_PROVIDER", message: NO_PROVIDER_MESSAGE };
  }

  const source = `llm:${llm.provider}:${llm.model}`;
  const user = buildUserMessage(prompt, sheet);

  let result = await llm.complete({ system: FUNCTIONS_SYSTEM_PROMPT, user });
  let raw = result.text;

  // Truncated output is incomplete JSON; report it distinctly, never parse it.
  if (result.truncated) {
    return { ok: false, reason: "TRUNCATED", message: TRUNCATED_MESSAGE, raw };
  }

  let functions: FunctionsPayload;
  try {
    functions = pickCollections(parseJsonLenient(raw));
  } catch (err) {
    return {
      ok: false,
      reason: "PARSE_ERROR",
      message: `LLM did not return valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      raw,
    };
  }

  let validation = validateFunctions(functions, sheet);

  // One repair attempt feeding back the validation errors.
  if (!validation.valid) {
    result = await llm.complete({
      system: FUNCTIONS_SYSTEM_PROMPT,
      user: user + functionsRepairNote(validation),
    });
    raw = result.text;
    if (result.truncated) {
      return { ok: false, reason: "TRUNCATED", message: TRUNCATED_MESSAGE, raw };
    }
    try {
      functions = pickCollections(parseJsonLenient(raw));
      validation = validateFunctions(functions, sheet);
    } catch (err) {
      return {
        ok: false,
        reason: "PARSE_ERROR",
        message: `LLM repair attempt did not return valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        raw,
      };
    }
  }

  return { ok: true, functions, source, validation };
}
