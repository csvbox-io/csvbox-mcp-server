/**
 * CSVBox REST client (src/services/csvbox-api.ts).
 *
 * Everything here runs against a stubbed axios adapter — verb, path, encoding,
 * headers, bodies, and the three error-normalization branches — except the last
 * test, which starts a loopback HTTP server because a stub adapter bypasses
 * axios's request serialization and so cannot prove the multipart wire format.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import axios from "axios";

import {
  createSheet,
  updateSheet,
  patchSheet,
  submitFile,
} from "../services/csvbox-api.js";
import { VERSION } from "../version.js";
import {
  createHttpStub,
  redirectToLoopback,
  ORIGINAL_ADAPTER,
} from "./support/http-stub.js";
import { withCleanEnv } from "./support/env.js";

const CREDS = { CSVBOX_API_KEY: "key-abc", CSVBOX_API_SECRET: "secret-xyz" };

/** Install a fresh stub for one test and guarantee it is torn down. */
function stubFor(t: { after(fn: () => void): void }) {
  const stub = createHttpStub();
  stub.install();
  t.after(() => stub.restore());
  return stub;
}

function headerOf(config: { headers: unknown }, name: string): unknown {
  const headers = config.headers as { get?: (n: string) => unknown } & Record<string, unknown>;
  return typeof headers.get === "function" ? headers.get(name) : headers[name];
}

// --- 3.1 Verb and path ----------------------------------------------------

test("each operation uses the documented verb and path", async (t) => {
  const stub = stubFor(t);

  await withCleanEnv(CREDS, async () => {
    await createSheet({ title: "S" });
    await updateSheet("lic", { title: "S" });
    await patchSheet("lic", { title: "S" });
    await submitFile({ kind: "url", import: { sheet_license_key: "lic" } });
  });

  const seen = stub.requests.map((r) => `${r.method?.toUpperCase()} ${r.url}`);
  assert.deepEqual(seen, [
    "POST /1.1/sheet",
    "PUT /1.1/sheet/lic",
    "PATCH /1.1/sheet/lic",
    "POST /1.1/file",
  ]);
  assert.equal(stub.requests[0].baseURL, "https://api.csvbox.io");
});

// --- 3.2 License key encoding ---------------------------------------------

test("the sheet license key is percent-encoded into the path", async (t) => {
  const stub = stubFor(t);
  const hostile = "a/b#c?d e";

  await withCleanEnv(CREDS, async () => {
    await updateSheet(hostile, {});
    await patchSheet(hostile, {});
  });

  const expected = `/1.1/sheet/${encodeURIComponent(hostile)}`;
  assert.equal(stub.requests[0].url, expected);
  assert.equal(stub.requests[1].url, expected);

  // The slash must not survive as a path separator, nor `#`/`?` as delimiters.
  const tail = stub.requests[0].url!.slice("/1.1/sheet/".length);
  assert.equal(tail.includes("/"), false, "slash was not encoded");
  assert.equal(tail.includes("#"), false, "fragment marker was not encoded");
  assert.equal(tail.includes("?"), false, "query marker was not encoded");
  assert.equal(tail.includes(" "), false, "space was not encoded");
  assert.equal(decodeURIComponent(tail), hostile);
});

// --- 3.2b Base URL override -------------------------------------------------

test("CSVBOX_API_BASE_URL overrides the request target", async (t) => {
  const stub = stubFor(t);

  await withCleanEnv(
    { ...CREDS, CSVBOX_API_BASE_URL: "http://127.0.0.1:9999" },
    () => createSheet({ title: "S" })
  );

  assert.equal(stub.requests[0].baseURL, "http://127.0.0.1:9999");
});

test("an unset CSVBOX_API_BASE_URL falls back to the production host", async (t) => {
  const stub = stubFor(t);

  await withCleanEnv(CREDS, () => createSheet({ title: "S" }));

  assert.equal(stub.requests[0].baseURL, "https://api.csvbox.io");
});

// --- 3.3 Headers and timeout ----------------------------------------------

test("credential headers, content negotiation and timeout are set", async (t) => {
  const stub = stubFor(t);

  await withCleanEnv(CREDS, async () => {
    await createSheet({ title: "S" });
  });

  const req = stub.last();
  assert.equal(headerOf(req, "x-csvbox-api-key"), CREDS.CSVBOX_API_KEY);
  assert.equal(headerOf(req, "x-csvbox-secret-api-key"), CREDS.CSVBOX_API_SECRET);
  assert.equal(headerOf(req, "Accept"), "application/json");
  assert.equal(headerOf(req, "Content-Type"), "application/json");
  assert.equal(req.timeout, 30_000);
});

// --- 3.4 Credentials read per call ----------------------------------------

test("credentials are read at call time, not at module load", async (t) => {
  const stub = stubFor(t);

  await withCleanEnv(CREDS, async () => {
    await createSheet({});
  });
  await withCleanEnv(
    { CSVBOX_API_KEY: "rotated-key", CSVBOX_API_SECRET: "rotated-secret" },
    async () => {
      await createSheet({});
    }
  );

  assert.equal(headerOf(stub.requests[0], "x-csvbox-api-key"), "key-abc");
  assert.equal(headerOf(stub.requests[1], "x-csvbox-api-key"), "rotated-key");
  assert.equal(headerOf(stub.requests[1], "x-csvbox-secret-api-key"), "rotated-secret");
});

// --- 3.5 Missing credentials short-circuit --------------------------------

test("a missing key or secret fails before any request is attempted", async (t) => {
  const stub = stubFor(t);

  const noKey = await withCleanEnv({ CSVBOX_API_SECRET: "s" }, () =>
    createSheet({})
  );
  assert.equal(noKey.ok, false);
  if (noKey.ok) return;
  assert.equal(noKey.status, null);
  assert.match(noKey.error, /CSVBOX_API_KEY/);

  const noSecret = await withCleanEnv({ CSVBOX_API_KEY: "k" }, () =>
    createSheet({})
  );
  assert.equal(noSecret.ok, false);
  if (noSecret.ok) return;
  assert.equal(noSecret.status, null);
  assert.match(noSecret.error, /CSVBOX_API_SECRET/);

  const neither = await withCleanEnv({}, () => updateSheet("lic", {}));
  assert.equal(neither.ok, false);

  assert.deepEqual(stub.requests, [], "no request may be attempted");
});

// --- 3.6 Body shapes ------------------------------------------------------

test("bodies carry exactly what each operation documents", async (t) => {
  const stub = stubFor(t);
  const sheet = { title: "Customers", sheet_columns: [] };
  const changes = { data_transforms: [{ transform_name: "t", _delete: true }] };

  await withCleanEnv(CREDS, async () => {
    await createSheet(sheet);
    await patchSheet("lic", changes);
    await submitFile({
      kind: "url",
      import: { sheet_license_key: "lic", public_file_url: "https://x.test/a.csv" },
    });
  });

  assert.deepEqual(JSON.parse(stub.requests[0].data), sheet);
  assert.deepEqual(JSON.parse(stub.requests[1].data), changes);
  assert.deepEqual(JSON.parse(stub.requests[2].data), {
    import: { sheet_license_key: "lic", public_file_url: "https://x.test/a.csv" },
  });
});

// --- 3.7 Error normalization ----------------------------------------------

test("an HTTP error preserves its status and response body", async (t) => {
  const stub = stubFor(t);
  stub.script({
    kind: "httpError",
    status: 422,
    data: { message: "title is required" },
  });

  const result = await withCleanEnv(CREDS, () => createSheet({}));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 422);
  assert.deepEqual(result.details, { message: "title is required" });
  assert.match(result.error, /422/);
});

test("a 500 is normalized the same way as a 4xx", async (t) => {
  const stub = stubFor(t);
  stub.script({ kind: "httpError", status: 500, data: "upstream exploded" });

  const result = await withCleanEnv(CREDS, () => patchSheet("lic", {}));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 500);
  assert.equal(result.details, "upstream exploded");
});

test("a transport failure yields a null status and keeps its message", async (t) => {
  const stub = stubFor(t);
  stub.script({ kind: "networkError", message: "timeout of 30000ms exceeded" });

  const result = await withCleanEnv(CREDS, () => createSheet({}));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, null);
  assert.match(result.error, /timeout of 30000ms exceeded/);
  assert.equal(result.details, undefined);
});

test("a non-Axios throw is still normalized, not propagated", async (t) => {
  const stub = stubFor(t);
  stub.script({ kind: "throw", error: new Error("adapter blew up") });

  const result = await withCleanEnv(CREDS, () => createSheet({}));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, null);
  assert.equal(result.error, "adapter blew up");
});

test("a thrown non-Error value falls back to the unknown-error message", async (t) => {
  const stub = stubFor(t);
  stub.script({ kind: "throw", error: "just a string" });

  const result = await withCleanEnv(CREDS, () => createSheet({}));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "Unknown API error");
});

test("a missing credential is distinguishable from a status-less transport failure", async (t) => {
  const stub = stubFor(t);
  stub.script({ kind: "networkError", message: "socket hang up" });

  const transport = await withCleanEnv(CREDS, () => createSheet({}));
  const credential = await withCleanEnv({}, () => createSheet({}));

  assert.equal(transport.ok, false);
  assert.equal(credential.ok, false);
  if (transport.ok || credential.ok) return;

  // Both carry status null, so only the message can tell them apart.
  assert.equal(transport.status, null);
  assert.equal(credential.status, null);
  assert.notEqual(transport.error, credential.error);
  assert.match(credential.error, /environment variable/);
  assert.doesNotMatch(transport.error, /environment variable/);
});

// --- 3.8 Success passthrough ----------------------------------------------

test("a 2xx returns ok with the status and the body unchanged", async (t) => {
  const stub = stubFor(t);
  const body = { sheet_license_key: "abc123", nested: { list: [1, 2, 3] } };
  stub.script({ kind: "response", status: 201, data: body });

  const result = await withCleanEnv(CREDS, () => createSheet({ title: "S" }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.status, 201);
  assert.deepEqual(result.data, body);
});

// --- 3.9 Adapter hygiene --------------------------------------------------

test("installing and restoring the stub leaves axios as it was", () => {
  const before = axios.defaults.adapter;
  const stub = createHttpStub();
  stub.install();
  assert.notEqual(axios.defaults.adapter, before, "stub did not take effect");
  stub.restore();
  assert.equal(axios.defaults.adapter, before);
  // Idempotent: a second restore must not clobber anything.
  stub.restore();
  assert.equal(axios.defaults.adapter, before);
  assert.equal(axios.defaults.adapter, ORIGINAL_ADAPTER);
});

// --- 3.10 Multipart on the wire -------------------------------------------

test("a direct upload sends real multipart with decoded bytes", async (t) => {
  const received: {
    contentType?: string;
    headers: http.IncomingHttpHeaders;
    body: Buffer;
  }[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      received.push({
        contentType: req.headers["content-type"],
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  // `csvbox-api.ts` passes its own baseURL to axios.create(), which beats
  // axios.defaults.baseURL — the rewrite has to happen inside an adapter.
  const restore = redirectToLoopback(`http://127.0.0.1:${port}`);

  t.after(async () => {
    restore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // Bytes that are not valid UTF-8 text, so a base64-vs-binary mix-up shows up.
  const fileContent = Buffer.from([0x49, 0x44, 0x2c, 0x4e, 0x0a, 0x00, 0xff, 0xfe]);

  const result = await withCleanEnv(CREDS, () =>
    submitFile({
      kind: "upload",
      import: { sheet_license_key: "lic", options: { has_header: 1 } },
      fileName: "data.csv",
      fileContent,
    })
  );

  assert.equal(result.ok, true, `upload failed: ${JSON.stringify(result)}`);

  assert.equal(received.length, 1);
  const { contentType, headers, body } = received[0];

  assert.match(
    String(contentType),
    /^multipart\/form-data; boundary=.+/,
    `expected multipart, got "${contentType}"`
  );

  // The per-request `Content-Type: undefined` override must clear only that
  // key. Axios merges per-request headers over instance defaults key by key,
  // so identification survives — asserted on the real wire, because this is
  // merge behavior we depend on but do not own. An axios upgrade that changed
  // it would silently strip attribution from every upload without this.
  assert.equal(headers["x-csvbox-client"], "mcp");
  assert.equal(headers["x-csvbox-client-version"], VERSION);
  assert.equal(headers["x-csvbox-api-key"], CREDS.CSVBOX_API_KEY);

  const text = body.toString("latin1");
  assert.match(text, /name="import"/);
  assert.match(text, /name="file"/);
  assert.match(text, /filename="data\.csv"/);
  assert.ok(
    text.includes(JSON.stringify({ sheet_license_key: "lic", options: { has_header: 1 } })),
    "import part did not carry the import JSON"
  );

  // The raw bytes must appear verbatim — not their base64 text.
  assert.ok(
    body.includes(fileContent),
    "file part did not carry the decoded bytes"
  );
  assert.equal(
    text.includes(fileContent.toString("base64")),
    false,
    "file part carried base64 text instead of binary"
  );
});

// --- 3.11 Client identification -------------------------------------------

test("every operation identifies itself as the MCP client", async (t) => {
  const stub = stubFor(t);

  await withCleanEnv(CREDS, async () => {
    await createSheet({ title: "S" });
    await updateSheet("lic", { title: "S" });
    await patchSheet("lic", { title: "S" });
    await submitFile({ kind: "url", import: { sheet_license_key: "lic" } });
  });

  assert.equal(stub.requests.length, 4);
  for (const req of stub.requests) {
    assert.equal(headerOf(req, "x-csvbox-client"), "mcp");
    assert.equal(headerOf(req, "x-csvbox-client-version"), VERSION);
  }
});

test("the identification version matches the package manifest", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8")
  ) as { version: string };

  assert.equal(VERSION, manifest.version);
});

test("identification headers carry no credential material", async (t) => {
  const stub = stubFor(t);

  await withCleanEnv(CREDS, () => createSheet({ title: "S" }));

  const client = String(headerOf(stub.last(), "x-csvbox-client"));
  const version = String(headerOf(stub.last(), "x-csvbox-client-version"));

  for (const value of [client, version]) {
    assert.equal(value.includes(CREDS.CSVBOX_API_KEY), false);
    assert.equal(value.includes(CREDS.CSVBOX_API_SECRET), false);
  }
});

test("identification is unconditional — no environment variable disables it", async (t) => {
  const stub = stubFor(t);

  // Every variable the server reads, plus plausible opt-out spellings someone
  // might expect to work. None of them may suppress attribution.
  await withCleanEnv(
    {
      ...CREDS,
      CSVBOX_API_BASE_URL: "http://127.0.0.1:9999",
      LLM_PROVIDER: "anthropic",
      CSVBOX_MCP_CLIENT_HEADER: "off",
      CSVBOX_CLIENT: "",
      NODE_ENV: "production",
    },
    () => createSheet({ title: "S" })
  );

  assert.equal(headerOf(stub.last(), "x-csvbox-client"), "mcp");
  assert.equal(headerOf(stub.last(), "x-csvbox-client-version"), VERSION);
});
