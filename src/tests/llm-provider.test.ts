/**
 * Provider and model resolution.
 *
 * `resolveProvider`/`resolveModel`/`resolveLlm` take an env argument, so every
 * case here runs against an explicit object. The last test additionally sets
 * real-looking values in `process.env` to prove the ambient environment is
 * never consulted when one is passed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveProvider,
  resolveModel,
  resolveLlm,
} from "../services/llm-client.js";
import { emptyEnv, withEnv } from "./support/env.js";
import { createHttpStub } from "./support/http-stub.js";

const ANTHROPIC_DEFAULT = "claude-haiku-4-5";
const OPENAI_DEFAULT = "gpt-4o-mini";

// --- 8.1 Key precedence ---------------------------------------------------

test("provider is chosen by key precedence when none is forced", () => {
  assert.equal(resolveProvider(emptyEnv()), null);
  assert.equal(resolveProvider(emptyEnv({ ANTHROPIC_API_KEY: "a" })), "anthropic");
  assert.equal(resolveProvider(emptyEnv({ OPENAI_API_KEY: "o" })), "openai");
  assert.equal(
    resolveProvider(emptyEnv({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" })),
    "anthropic",
    "Anthropic must win when both keys are present"
  );
});

test("an empty-string key counts as absent", () => {
  assert.equal(resolveProvider(emptyEnv({ ANTHROPIC_API_KEY: "" })), null);
  assert.equal(
    resolveProvider(emptyEnv({ ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "o" })),
    "openai"
  );
});

// --- 8.2 Forced provider --------------------------------------------------

test("a forced provider is honored only when its own key is present", () => {
  assert.equal(
    resolveProvider(emptyEnv({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "o" })),
    "openai"
  );
  assert.equal(
    resolveProvider(emptyEnv({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "a" })),
    "anthropic"
  );

  // Forced openai, but only the Anthropic key exists: no provider, and it must
  // NOT silently fall back to Anthropic.
  assert.equal(
    resolveProvider(emptyEnv({ LLM_PROVIDER: "openai", ANTHROPIC_API_KEY: "a" })),
    null
  );
  assert.equal(
    resolveProvider(emptyEnv({ LLM_PROVIDER: "anthropic", OPENAI_API_KEY: "o" })),
    null
  );
});

test("the forced provider is matched case-insensitively and trimmed", () => {
  for (const value of ["OpenAI", " openai ", "OPENAI", "\topenai\n"]) {
    assert.equal(
      resolveProvider(emptyEnv({ LLM_PROVIDER: value, OPENAI_API_KEY: "o" })),
      "openai",
      `"${value}" was not matched`
    );
  }
});

test("an unrecognized forced provider falls through to key precedence", () => {
  assert.equal(
    resolveProvider(
      emptyEnv({ LLM_PROVIDER: "gemini", ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" })
    ),
    "anthropic"
  );
  assert.equal(
    resolveProvider(emptyEnv({ LLM_PROVIDER: "gemini", OPENAI_API_KEY: "o" })),
    "openai"
  );
  assert.equal(resolveProvider(emptyEnv({ LLM_PROVIDER: "gemini" })), null);
  assert.equal(
    resolveProvider(emptyEnv({ LLM_PROVIDER: "", ANTHROPIC_API_KEY: "a" })),
    "anthropic"
  );
});

// --- 8.3 Model resolution -------------------------------------------------

test("the model override applies only when it holds a non-empty value", () => {
  assert.equal(resolveModel("anthropic", emptyEnv()), ANTHROPIC_DEFAULT);
  assert.equal(resolveModel("openai", emptyEnv()), OPENAI_DEFAULT);

  for (const blank of ["", "   ", "\t\n"]) {
    assert.equal(
      resolveModel("anthropic", emptyEnv({ LLM_MODEL: blank })),
      ANTHROPIC_DEFAULT,
      `"${blank}" should not override the default`
    );
  }

  assert.equal(
    resolveModel("anthropic", emptyEnv({ LLM_MODEL: "claude-opus-5" })),
    "claude-opus-5"
  );
  assert.equal(
    resolveModel("openai", emptyEnv({ LLM_MODEL: "  gpt-4o  " })),
    "gpt-4o",
    "the override should be trimmed"
  );

  // The override is provider-agnostic — it applies to whichever one wins.
  assert.equal(
    resolveModel("openai", emptyEnv({ LLM_MODEL: "claude-opus-5" })),
    "claude-opus-5"
  );
});

// --- 8.4 Client construction ----------------------------------------------

test("resolveLlm returns null with no keys and a matching client otherwise", async (t) => {
  const stub = createHttpStub();
  stub.install();
  t.after(() => stub.restore());

  assert.equal(resolveLlm(emptyEnv()), null);
  assert.equal(resolveLlm(emptyEnv({ LLM_PROVIDER: "openai" })), null);

  const anthropic = resolveLlm(emptyEnv({ ANTHROPIC_API_KEY: "a" }));
  assert.ok(anthropic);
  assert.equal(anthropic.provider, "anthropic");
  assert.equal(anthropic.model, ANTHROPIC_DEFAULT);

  const openai = resolveLlm(emptyEnv({ OPENAI_API_KEY: "o", LLM_MODEL: "gpt-4o" }));
  assert.ok(openai);
  assert.equal(openai.provider, "openai");
  assert.equal(openai.model, "gpt-4o");

  // Constructing a client must not talk to anyone — the SDKs are imported
  // lazily inside `complete()`, not at construction.
  assert.deepEqual(stub.requests, []);
});

// --- 8.5 Ambient environment is ignored -----------------------------------

test("resolution reads only the passed env, never the ambient one", async () => {
  // Captured, not assumed to be unset — this suite must pass identically on a
  // machine that already exports these variables.
  const before = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    LLM_PROVIDER: process.env.LLM_PROVIDER,
    LLM_MODEL: process.env.LLM_MODEL,
  };

  await withEnv(
    {
      ANTHROPIC_API_KEY: "ambient-anthropic",
      OPENAI_API_KEY: "ambient-openai",
      LLM_PROVIDER: "openai",
      LLM_MODEL: "ambient-model",
    },
    () => {
      assert.equal(resolveProvider(emptyEnv()), null);
      assert.equal(resolveLlm(emptyEnv()), null);
      assert.equal(resolveModel("anthropic", emptyEnv()), ANTHROPIC_DEFAULT);

      const client = resolveLlm(emptyEnv({ ANTHROPIC_API_KEY: "scoped" }));
      assert.equal(client?.provider, "anthropic");
      assert.equal(client?.model, ANTHROPIC_DEFAULT, "ambient LLM_MODEL leaked in");
    }
  );

  // And every variable is back to whatever it was, set or unset.
  assert.equal(process.env.ANTHROPIC_API_KEY, before.ANTHROPIC_API_KEY);
  assert.equal(process.env.OPENAI_API_KEY, before.OPENAI_API_KEY);
  assert.equal(process.env.LLM_PROVIDER, before.LLM_PROVIDER);
  assert.equal(process.env.LLM_MODEL, before.LLM_MODEL);
});

test("with no env argument the ambient environment is used", async () => {
  await withEnv(
    {
      ANTHROPIC_API_KEY: undefined,
      OPENAI_API_KEY: "ambient-openai",
      LLM_PROVIDER: undefined,
      LLM_MODEL: undefined,
    },
    () => {
      assert.equal(resolveProvider(), "openai");
      assert.equal(resolveModel("openai"), OPENAI_DEFAULT);
    }
  );
});
