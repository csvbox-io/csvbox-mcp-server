/**
 * Standalone mock CSVBox REST API, launched as a Playwright `webServer`
 * entry (see playwright.config.ts). Started once for the whole e2e run;
 * each test scripts its next response via POST /__mock__/queue and reads
 * back what actually arrived via GET /__mock__/requests.
 *
 * No response queued for a business route → responds 599 with a body that
 * says so, instead of silently succeeding, so a test that forgot to queue
 * fails loudly rather than passing by accident.
 */
import { createMockServer, sendJson, parseListenArg } from "./mock-http.js";

const UNMOCKED = { error: "no mock response queued for this request" };

const server = createMockServer((req, _bodyText, queued, res) => {
  const url = req.url ?? "";
  const method = (req.method ?? "GET").toUpperCase();

  const isSheetRoute =
    (method === "POST" && url === "/1.1/sheet") ||
    ((method === "PUT" || method === "PATCH") && url.startsWith("/1.1/sheet/"));
  const isFileRoute = method === "POST" && url === "/1.1/file";

  if (!isSheetRoute && !isFileRoute) {
    sendJson(res, 404, { error: `no mock route for ${method} ${url}` });
    return;
  }

  if (!queued) {
    sendJson(res, 599, UNMOCKED);
    return;
  }

  const status = typeof queued.status === "number" ? queued.status : 200;
  sendJson(res, status, queued.body ?? {});
});

const arg = process.argv[2];
if (!arg) {
  throw new Error("usage: mock-csvbox-server.ts <http://host:port>");
}
const { host, port } = parseListenArg(arg);
server.listen(port, host).then(() => {
  // eslint-disable-next-line no-console
  console.log(`mock CSVBox API listening on ${arg}`);
});
