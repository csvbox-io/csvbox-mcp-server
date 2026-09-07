/**
 * The MCP surface a host actually sees: the tool and prompt inventory, the
 * input schemas advertised for each tool, and the properties of `createServer()`
 * itself (no credentials, no I/O, independent instances, no transport on import).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createServer } from "../index.js";
import { VERSION } from "../version.js";
import { connectHarness } from "./support/mcp-harness.js";
import { createHttpStub } from "./support/http-stub.js";
import { withCleanEnv } from "./support/env.js";
import { SHEET_SYSTEM_PROMPT } from "../prompts/sheet-system-prompt.js";
import { FUNCTIONS_SYSTEM_PROMPT } from "../prompts/functions-system-prompt.js";

const TOOL_NAMES = [
  "create_importer_from_prompt",
  "create_sheet",
  "generate_import_code",
  "generate_sheet_functions",
  "generate_sheet_json",
  "patch_sheet",
  "submit_file",
  "update_sheet",
  "validate_schema",
];

const PROMPT_NAMES = ["create_csvbox_sheet", "csvbox_sheet_functions"];

/** Documented arguments per tool, and which of them are required. */
const TOOL_ARGS: Record<string, { all: string[]; required: string[] }> = {
  create_sheet: { all: ["sheet"], required: ["sheet"] },
  update_sheet: {
    all: ["sheet_license_key", "sheet"],
    required: ["sheet_license_key", "sheet"],
  },
  patch_sheet: {
    all: ["sheet_license_key", "changes"],
    required: ["sheet_license_key", "changes"],
  },
  generate_sheet_json: { all: ["prompt"], required: ["prompt"] },
  create_importer_from_prompt: { all: ["prompt"], required: ["prompt"] },
  generate_import_code: { all: ["framework"], required: ["framework"] },
  generate_sheet_functions: { all: ["prompt", "sheet"], required: ["prompt"] },
  validate_schema: { all: ["sheet", "mode"], required: ["sheet"] },
  submit_file: {
    all: [
      "sheet_license_key",
      "public_file_url",
      "file_base64",
      "file_name",
      "file_sheet_name",
      "user",
      "options",
      "dynamic_columns",
    ],
    required: ["sheet_license_key"],
  },
};

// --- 4.1 / 4.2 Inventory --------------------------------------------------

test("the server advertises exactly the nine documented tools", async (t) => {
  const h = await connectHarness();
  t.after(() => h.close());

  const names = (await h.client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, TOOL_NAMES);
  assert.equal(new Set(names).size, names.length, "duplicate tool name");
});

test("the server advertises exactly the two documented prompts", async (t) => {
  const h = await connectHarness();
  t.after(() => h.close());

  const names = (await h.client.listPrompts()).prompts.map((p) => p.name).sort();
  assert.deepEqual(names, PROMPT_NAMES);
  assert.equal(new Set(names).size, names.length, "duplicate prompt name");
});

// --- 4.3 Self-description -------------------------------------------------

test("every tool carries a description and a usable input schema", async (t) => {
  const h = await connectHarness();
  t.after(() => h.close());

  const { tools } = await h.client.listTools();

  for (const tool of tools) {
    assert.ok(
      typeof tool.description === "string" && tool.description.length > 0,
      `${tool.name} has no description`
    );

    const schema = tool.inputSchema as {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };
    assert.equal(schema.type, "object", `${tool.name} schema is not an object`);

    const expected = TOOL_ARGS[tool.name];
    assert.ok(expected, `${tool.name} is not covered by TOOL_ARGS`);

    const advertised = Object.keys(schema.properties ?? {}).sort();
    assert.deepEqual(
      advertised,
      [...expected.all].sort(),
      `${tool.name} advertises unexpected arguments`
    );
    assert.deepEqual(
      [...(schema.required ?? [])].sort(),
      [...expected.required].sort(),
      `${tool.name} marks the wrong arguments required`
    );
  }
});

// --- 4.4 No credentials, no I/O -------------------------------------------

test("constructing a server needs no credentials and issues no request", async (t) => {
  const stub = createHttpStub();
  stub.install();
  t.after(() => stub.restore());

  const writes: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: any, ...rest: any[]) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  t.after(() => {
    process.stdout.write = realWrite;
  });

  await withCleanEnv({}, async () => {
    const server = createServer();
    assert.ok(server, "createServer returned nothing");
    await server.close();
  });

  assert.deepEqual(stub.requests, [], "construction issued a request");
  assert.deepEqual(writes, [], "construction wrote to stdout");
});

// --- 4.5 Independent instances --------------------------------------------

test("two servers are independent and closing one leaves the other usable", async (t) => {
  const a = await connectHarness();
  const b = await connectHarness();
  t.after(() => b.close());

  assert.notEqual(a.server, b.server);
  await a.close();

  // b must still answer after a is gone.
  const names = (await b.client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, TOOL_NAMES);
});

// --- 4.6 Import does not start a server -----------------------------------

test("a freshly constructed server is not connected to anything", async () => {
  const server = createServer();
  assert.equal(server.isConnected(), false);
  await server.close();
});

test("importing the entry module starts no server", async () => {
  // Run in a child process: importing must not emit the startup notice, must
  // not hold the event loop open on stdin, and must expose createServer.
  const entry = pathToFileURL(
    fileURLToPath(new URL("../index.js", import.meta.url))
  ).href;

  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(entry)}); process.stdout.write(typeof m.createServer);`,
    ],
    { encoding: "utf8", timeout: 20_000 }
  );

  assert.equal(child.status, 0, `child exited ${child.status}: ${child.stderr}`);
  assert.equal(child.signal, null, "child had to be killed — it did not exit");
  assert.equal(child.stdout, "function");
  assert.doesNotMatch(
    child.stderr,
    /running on stdio/,
    "importing the module started a stdio server"
  );
});

test("executing the entry module does start a stdio server", async () => {
  // The other half of the guard: the binary path must still work.
  const entry = fileURLToPath(new URL("../index.js", import.meta.url));
  const child = spawnSync(process.execPath, [entry], {
    encoding: "utf8",
    input: "",
    timeout: 20_000,
  });

  assert.equal(child.status, 0, `binary exited ${child.status}`);
  assert.match(child.stderr, /csvbox-mcp-server running on stdio/);
  assert.equal(child.stdout, "", "the binary wrote non-protocol data to stdout");
});

// --- 4.7 Prompt round-trip ------------------------------------------------

test("the sheet prompt returns its system prompt plus the request", async (t) => {
  const h = await connectHarness();
  t.after(() => h.close());

  const result = await h.client.getPrompt({
    name: "create_csvbox_sheet",
    arguments: { request: "employee importer with name and email" },
  });

  assert.equal(result.messages.length, 1);
  const text = String((result.messages[0].content as { text: string }).text);
  assert.ok(text.includes(SHEET_SYSTEM_PROMPT), "system prompt missing");
  assert.match(text, /employee importer with name and email/);
  assert.match(text, /validate_schema/);
  assert.match(text, /create_sheet/);
});

test("the functions prompt returns its system prompt, request and sheet", async (t) => {
  const h = await connectHarness();
  t.after(() => h.close());

  const withSheet = await h.client.getPrompt({
    name: "csvbox_sheet_functions",
    arguments: { request: "trim whitespace", sheet: '{"title":"Customers"}' },
  });
  const withSheetText = String(
    (withSheet.messages[0].content as { text: string }).text
  );
  assert.ok(withSheetText.includes(FUNCTIONS_SYSTEM_PROMPT), "system prompt missing");
  assert.match(withSheetText, /trim whitespace/);
  assert.match(withSheetText, /\{"title":"Customers"\}/);
  assert.match(withSheetText, /patch_sheet/);
  assert.match(withSheetText, /never with `update_sheet`/);

  const withoutSheet = await h.client.getPrompt({
    name: "csvbox_sheet_functions",
    arguments: { request: "trim whitespace" },
  });
  const withoutSheetText = String(
    (withoutSheet.messages[0].content as { text: string }).text
  );
  assert.match(withoutSheetText, /Not supplied/);
  assert.match(withoutSheetText, /do not invent others/);
});

// --- 4.9 Version identity -------------------------------------------------

test("the advertised server version is the one sent to CSVBox", async (t) => {
  const h = await connectHarness();
  t.after(() => h.close());

  // One source, two consumers. A client's advertised version and the version
  // CSVBox observes in x-csvbox-client-version must never disagree — otherwise
  // a support ticket quoting one cannot be matched against the other.
  assert.equal(h.client.getServerVersion()?.version, VERSION);
  assert.equal(h.client.getServerVersion()?.name, "csvbox-mcp-server");
});
