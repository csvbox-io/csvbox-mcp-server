/**
 * Scoped environment overrides.
 *
 * The suite must pass identically on a machine with real credentials configured
 * and one without, so any test whose subject reads `process.env` sets what it
 * needs here and gets the prior values back afterwards — including on a failed
 * assertion.
 */

/** The variables the server reads. Listed so tests can blank them wholesale. */
export const SERVER_ENV_VARS = [
  "CSVBOX_API_KEY",
  "CSVBOX_API_SECRET",
  "CSVBOX_API_BASE_URL",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "LLM_PROVIDER",
  "LLM_MODEL",
] as const;

export type EnvOverrides = Record<string, string | undefined>;

function apply(overrides: EnvOverrides): EnvOverrides {
  const previous: EnvOverrides = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return previous;
}

/**
 * Run `fn` with `overrides` applied to `process.env`; a value of `undefined`
 * deletes the variable. Prior values — including "was not set" — are restored
 * in a `finally`. Works for sync and async callbacks.
 */
export async function withEnv<T>(
  overrides: EnvOverrides,
  fn: () => T | Promise<T>
): Promise<T> {
  const previous = apply(overrides);
  try {
    return await fn();
  } finally {
    apply(previous);
  }
}

/** `withEnv` with every server variable cleared, then `overrides` applied. */
export async function withCleanEnv<T>(
  overrides: EnvOverrides,
  fn: () => T | Promise<T>
): Promise<T> {
  const cleared: EnvOverrides = {};
  SERVER_ENV_VARS.forEach((key) => {
    cleared[key] = undefined;
  });
  return withEnv({ ...cleared, ...overrides }, fn);
}

/** A plain object usable as an `env` argument, with none of the ambient values. */
export function emptyEnv(overrides: EnvOverrides = {}): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv;
}
