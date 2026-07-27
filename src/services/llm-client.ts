/**
 * Provider-agnostic LLM client.
 *
 * Exposes a single `complete({ system, user, model? })` interface backed by
 * either Anthropic or OpenAI, chosen from the environment. The SDKs are
 * imported lazily inside each adapter so a user with only one key never pays
 * the other's import cost (or needs it installed at runtime).
 *
 * `resolveLlm()` returns `null` — a first-class result, not an error — when no
 * provider is configured. Callers branch on it.
 */

export type LlmProvider = "anthropic" | "openai";

export interface CompleteArgs {
  system: string;
  user: string;
  /** Override the resolved default model for this call. */
  model?: string;
}

/**
 * Result of a completion. `truncated` is true when the provider stopped
 * because it hit the output token cap (Anthropic stop_reason "max_tokens",
 * OpenAI finish_reason "length") — the JSON is almost certainly incomplete.
 */
export interface CompleteResult {
  text: string;
  truncated: boolean;
}

export interface LlmClient {
  readonly provider: LlmProvider;
  readonly model: string;
  /** Run a single JSON-returning completion. */
  complete(args: CompleteArgs): Promise<CompleteResult>;
}

const DEFAULT_MODELS: Record<LlmProvider, string> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4o-mini",
};

/**
 * Cap output size. Raised from 8192 to fit large category-expansion sheets
 * (100+ columns with types/validators). If the model still hits this cap the
 * response is flagged `truncated` so callers never parse a cut-off body.
 */
const MAX_TOKENS = 16384;

/**
 * Decide which provider to use from the environment.
 *
 * Order: explicit LLM_PROVIDER (key for it must be present) -> ANTHROPIC_API_KEY
 * -> OPENAI_API_KEY -> null. Pure function of the passed env for testability.
 */
export function resolveProvider(
  env: NodeJS.ProcessEnv = process.env
): LlmProvider | null {
  const forced = env.LLM_PROVIDER?.trim().toLowerCase();
  if (forced === "anthropic" || forced === "openai") {
    const keyVar = forced === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    return env[keyVar] ? forced : null;
  }
  if (env.ANTHROPIC_API_KEY) return "anthropic";
  if (env.OPENAI_API_KEY) return "openai";
  return null;
}

/** Resolve the model for a provider, honoring LLM_MODEL override. */
export function resolveModel(
  provider: LlmProvider,
  env: NodeJS.ProcessEnv = process.env
): string {
  const override = env.LLM_MODEL?.trim();
  return override && override.length > 0 ? override : DEFAULT_MODELS[provider];
}

class AnthropicClient implements LlmClient {
  readonly provider = "anthropic" as const;
  constructor(private readonly apiKey: string, readonly model: string) {}

  async complete({ system, user, model }: CompleteArgs): Promise<CompleteResult> {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: this.apiKey });
    const response = await client.messages.create({
      model: model ?? this.model,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: "user", content: user }],
    });
    const text = response.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    return { text, truncated: response.stop_reason === "max_tokens" };
  }
}

class OpenAiClient implements LlmClient {
  readonly provider = "openai" as const;
  constructor(private readonly apiKey: string, readonly model: string) {}

  async complete({ system, user, model }: CompleteArgs): Promise<CompleteResult> {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: this.apiKey });
    const response = await client.chat.completions.create({
      model: model ?? this.model,
      max_tokens: MAX_TOKENS,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    const choice = response.choices[0];
    return {
      text: choice?.message?.content ?? "",
      truncated: choice?.finish_reason === "length",
    };
  }
}

/**
 * Build an LlmClient from the environment, or `null` if no provider is
 * configured. Never throws for the no-key case — callers branch on null.
 */
export function resolveLlm(
  env: NodeJS.ProcessEnv = process.env
): LlmClient | null {
  const provider = resolveProvider(env);
  if (!provider) return null;
  const model = resolveModel(provider, env);

  if (provider === "anthropic") {
    return new AnthropicClient(env.ANTHROPIC_API_KEY as string, model);
  }
  return new OpenAiClient(env.OPENAI_API_KEY as string, model);
}
