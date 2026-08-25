/**
 * Axios interception for tests, with no production seam and no mocking library.
 *
 * `csvbox-api.ts` builds its client with `axios.create()` per request, and
 * `axios.create` merges `axios.defaults` into the instance config. Replacing
 * `axios.defaults.adapter` therefore intercepts every request the API client
 * makes, and the stub receives the fully merged config — verb, already-encoded
 * URL, merged headers, timeout, and body.
 *
 * A custom adapter bypasses axios's own `settle()`, so this stub raises HTTP
 * errors itself rather than returning a non-2xx response and expecting axios to
 * throw.
 *
 * IMPORTANT: `axios.defaults.adapter` is global mutable state. Always pair
 * `install()` with `restore()` in a `t.after()` hook so an assertion failure
 * cannot leak the stub into later tests. `restore()` is idempotent.
 */

import axios, { AxiosError } from "axios";
import type {
  AxiosAdapter,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from "axios";

/** What the stub should do for one request. */
export type Outcome =
  | { kind: "response"; status?: number; data?: unknown }
  /** An HTTP error: an AxiosError carrying a response, as a real 4xx/5xx does. */
  | { kind: "httpError"; status: number; data?: unknown; message?: string }
  /** A transport failure: an AxiosError with no response (timeout, DNS, reset). */
  | { kind: "networkError"; message?: string; code?: string }
  /** Anything that is not an AxiosError at all. */
  | { kind: "throw"; error: unknown };

export interface HttpStub {
  /** Every intercepted request, in order, as the merged config axios built. */
  requests: InternalAxiosRequestConfig[];
  /** The most recent intercepted request. Throws if there is none. */
  last(): InternalAxiosRequestConfig;
  /** Queue one outcome. Outcomes are consumed in order. */
  script(...outcomes: Outcome[]): void;
  /** Use this outcome for every request the queue does not cover. */
  setDefault(outcome: Outcome): void;
  /** Forget recorded requests and any queued outcomes. */
  reset(): void;
  install(): void;
  restore(): void;
  /** True while the stub is installed. */
  readonly installed: boolean;
}

const DEFAULT_OUTCOME: Outcome = { kind: "response", status: 200, data: {} };

function buildResponse(
  config: InternalAxiosRequestConfig,
  status: number,
  data: unknown
): AxiosResponse {
  return {
    data,
    status,
    statusText: String(status),
    headers: {},
    config,
    request: {},
  } as AxiosResponse;
}

function raise(outcome: Outcome, config: InternalAxiosRequestConfig): never {
  if (outcome.kind === "throw") throw outcome.error;

  if (outcome.kind === "networkError") {
    throw new AxiosError(
      outcome.message ?? "Network Error",
      outcome.code ?? AxiosError.ERR_NETWORK,
      config,
      {}
    );
  }

  if (outcome.kind === "httpError") {
    throw new AxiosError(
      outcome.message ?? `Request failed with status code ${outcome.status}`,
      AxiosError.ERR_BAD_RESPONSE,
      config,
      {},
      buildResponse(config, outcome.status, outcome.data ?? {})
    );
  }

  // Unreachable for kind "response"; keeps the function total.
  throw new Error(`raise() called with a non-error outcome: ${outcome.kind}`);
}

export function createHttpStub(): HttpStub {
  const requests: InternalAxiosRequestConfig[] = [];
  let queue: Outcome[] = [];
  let fallback: Outcome = DEFAULT_OUTCOME;
  let previousAdapter: typeof axios.defaults.adapter;
  let installed = false;

  const adapter: AxiosAdapter = async (config) => {
    requests.push(config);
    const outcome = queue.shift() ?? fallback;
    if (outcome.kind !== "response") raise(outcome, config);
    return buildResponse(config, outcome.status ?? 200, outcome.data ?? {});
  };

  const stub: HttpStub = {
    requests,
    last() {
      const req = requests[requests.length - 1];
      if (!req) throw new Error("http stub recorded no requests");
      return req;
    },
    script(...outcomes: Outcome[]) {
      queue.push(...outcomes);
    },
    setDefault(outcome: Outcome) {
      fallback = outcome;
    },
    reset() {
      requests.length = 0;
      queue = [];
      fallback = DEFAULT_OUTCOME;
    },
    install() {
      if (installed) return;
      previousAdapter = axios.defaults.adapter;
      axios.defaults.adapter = adapter;
      installed = true;
    },
    restore() {
      if (!installed) return;
      axios.defaults.adapter = previousAdapter;
      installed = false;
    },
    get installed() {
      return installed;
    },
  };

  return stub;
}

/** The adapter axios shipped with, captured before any stub touches it. */
export const ORIGINAL_ADAPTER = axios.defaults.adapter;

/**
 * Redirect every request to a loopback origin while keeping axios's REAL http
 * adapter, so request serialization (notably multipart encoding of a global
 * `FormData`) actually happens.
 *
 * `csvbox-api.ts` passes an explicit `baseURL` to `axios.create()`, which wins
 * over `axios.defaults.baseURL` — so overriding the default is not enough. The
 * rewrite has to happen after config merging, which means inside an adapter.
 * `buildFullPath` runs within the http adapter, so `config.baseURL` is still
 * honored at this point.
 *
 * Returns a `restore()`; it is idempotent and safe in a `t.after()` hook.
 */
export function redirectToLoopback(origin: string): () => void {
  const previous = axios.defaults.adapter;
  const httpAdapter = axios.getAdapter("http");
  let active = true;

  axios.defaults.adapter = async (config) => {
    config.baseURL = origin;
    return httpAdapter(config);
  };

  return () => {
    if (!active) return;
    axios.defaults.adapter = previous;
    active = false;
  };
}
