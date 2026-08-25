/**
 * Standalone mock LLM endpoint emulating just enough of the Anthropic
 * Messages API (POST /v1/messages) for `src/services/llm-client.ts`'s
 * AnthropicClient to parse a response. Launched as a Playwright `webServer`
 * entry (see playwright.config.ts); the app subprocess is pointed at it via
 * ANTHROPIC_BASE_URL.
 *
 * Each test queues its next completion via POST /__mock__/queue with either
 * `{ text, stopReason? }` (wrapped into a full Anthropic envelope) or
 * `{ raw, status? }` (sent verbatim, for constructing malformed envelopes).
 * No response queued → 599 with a body that says so.
 */
import { createMockServer, sendJson, parseListenArg } from "./mock-http.js";

const UNMOCKED = { error: "no mock response queued for this request" };

const server = createMockServer((req, _bodyText, queued, res) => {
  const url = req.url ?? "";
  const method = (req.method ?? "GET").toUpperCase();

  if (!(method === "POST" && url === "/v1/messages")) {
    sendJson(res, 404, { error: `no mock route for ${method} ${url}` });
    return;
  }

  if (!queued) {
    sendJson(res, 599, UNMOCKED);
    return;
  }

  if (queued.raw !== undefined) {
    const status = typeof queued.status === "number" ? queued.status : 200;
    sendJson(res, status, queued.raw);
    return;
  }

  const text = typeof queued.text === "string" ? queued.text : "";
  const stopReason = typeof queued.stopReason === "string" ? queued.stopReason : "end_turn";

  sendJson(res, 200, {
    id: "msg_mock",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: [{ type: "text", text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  });
});

const arg = process.argv[2];
if (!arg) {
  throw new Error("usage: mock-llm-server.ts <http://host:port>");
}
const { host, port } = parseListenArg(arg);
server.listen(port, host).then(() => {
  // eslint-disable-next-line no-console
  console.log(`mock LLM API listening on ${arg}`);
});
