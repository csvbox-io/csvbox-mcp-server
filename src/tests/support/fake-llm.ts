/**
 * Scripted LlmClient stand-in.
 *
 * Replaces the `fakeLlm` helper that expansion.test.ts and sheet-functions.test.ts
 * each defined verbatim. Beyond the single-canned-response case those needed, it
 * records every `complete()` argument so tests can assert what the repair retry
 * actually sent.
 */

import type {
  LlmClient,
  CompleteArgs,
  CompleteResult,
} from "../../services/llm-client.js";

export interface FakeLlm extends LlmClient {
  /** How many times `complete()` was called. */
  calls: number;
  /** Every call's arguments, in order. */
  log: CompleteArgs[];
}

/** The same response for every call — the shape both existing test files use. */
export function fakeLlm(response: CompleteResult): FakeLlm {
  return scriptedLlm([response], { repeatLast: true });
}

/**
 * A different response per call, in order. Once the script is exhausted the
 * client throws unless `repeatLast` is set — an unexpected extra model call is
 * exactly the bug several tests exist to catch, so it must not pass silently.
 */
export function scriptedLlm(
  responses: CompleteResult[],
  opts: { repeatLast?: boolean } = {}
): FakeLlm {
  if (responses.length === 0) {
    throw new Error("scriptedLlm needs at least one response");
  }

  const client: FakeLlm = {
    provider: "anthropic",
    model: "mock",
    calls: 0,
    log: [],
    async complete(args: CompleteArgs): Promise<CompleteResult> {
      const index = client.calls;
      client.calls++;
      client.log.push(args);

      if (index < responses.length) return responses[index];
      if (opts.repeatLast) return responses[responses.length - 1];
      throw new Error(
        `scriptedLlm: unexpected call ${index + 1}; only ${responses.length} response(s) scripted`
      );
    },
  };

  return client;
}

/** Convenience: a well-formed, untruncated response carrying `value` as JSON. */
export function jsonResponse(value: unknown): CompleteResult {
  return { truncated: false, text: JSON.stringify(value) };
}
