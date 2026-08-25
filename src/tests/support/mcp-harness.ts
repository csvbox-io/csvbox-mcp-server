/**
 * Drives the server the way a real host does: a real `Client` talking to a real
 * `McpServer` over a linked in-memory transport pair.
 *
 * Going through the client rather than calling a handler directly is deliberate
 * — the handler signature is not the contract, the MCP envelope is, and only
 * this path exercises the Zod input-schema enforcement a host relies on.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createServer } from "../../index.js";

/** One tool response, unwrapped just far enough to assert on. */
export interface ToolCallResult {
  isError: boolean;
  /** Concatenated text of every text block in the response. */
  text: string;
  /** The raw result, for assertions about content structure. */
  raw: Record<string, unknown>;
}

export interface Harness {
  client: Client;
  server: McpServer;
  callRaw(name: string, args?: Record<string, unknown>): Promise<ToolCallResult>;
  /** `callRaw` plus `JSON.parse` of the text body — what most tools return. */
  callJson(name: string, args?: Record<string, unknown>): Promise<{ json: any; isError: boolean }>;
  close(): Promise<void>;
}

function textOf(result: Record<string, unknown>): string {
  const content = result.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && (block as any).type === "text"
        ? String((block as any).text)
        : ""
    )
    .join("");
}

/** Build a server, connect a client to it, and return both plus helpers. */
export async function connectHarness(): Promise<Harness> {
  const server = createServer();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  async function callRaw(
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<ToolCallResult> {
    const raw = (await client.callTool({
      name,
      arguments: args,
    })) as Record<string, unknown>;
    return { isError: raw.isError === true, text: textOf(raw), raw };
  }

  return {
    client,
    server,
    callRaw,
    async callJson(name, args) {
      const result = await callRaw(name, args);
      return { json: JSON.parse(result.text), isError: result.isError };
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
