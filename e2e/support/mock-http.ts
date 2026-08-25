import http from "node:http";

/** One captured inbound request, exposed via GET /__mock__/requests for assertions. */
export interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  bodyText: string;
}

/** A queued response an admin call scripts for the next matching business-route request. */
export type QueuedResponse = Record<string, unknown>;

export interface MockServerHandle {
  requests: CapturedRequest[];
  /** FIFO queue of admin-scripted responses; business routes shift() from this. */
  queue: QueuedResponse[];
  listen(port: number, host: string): Promise<void>;
  close(): Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(text);
}

/**
 * A minimal admin-capable mock HTTP server. Business routes are handled by
 * `onRequest`, which receives the shifted-off next queued response (or
 * undefined if nothing was queued) and decides how to turn it into an HTTP
 * response. Admin routes (/__mock__/health, /queue, /reset, /requests) are
 * handled here so every mock gets identical, predictable admin behavior.
 */
export function createMockServer(
  onRequest: (
    req: http.IncomingMessage,
    bodyText: string,
    queued: QueuedResponse | undefined,
    res: http.ServerResponse
  ) => void
): MockServerHandle {
  const requests: CapturedRequest[] = [];
  const queue: QueuedResponse[] = [];
  let server: http.Server;

  server = http.createServer(async (req, res) => {
    const url = req.url ?? "/";
    const method = (req.method ?? "GET").toUpperCase();

    if (method === "GET" && url === "/__mock__/health") {
      send(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && url === "/__mock__/queue") {
      const bodyText = (await readBody(req)).toString("utf8");
      const parsed = bodyText ? JSON.parse(bodyText) : {};
      queue.push(parsed);
      send(res, 200, { queued: true, depth: queue.length });
      return;
    }

    if (method === "POST" && url === "/__mock__/reset") {
      queue.length = 0;
      requests.length = 0;
      send(res, 200, { reset: true });
      return;
    }

    if (method === "GET" && url === "/__mock__/requests") {
      send(res, 200, requests);
      return;
    }

    const bodyBuf = await readBody(req);
    const bodyText = bodyBuf.toString("latin1");
    requests.push({
      method,
      path: url,
      headers: req.headers,
      bodyText,
    });

    const queued = queue.shift();
    onRequest(req, bodyText, queued, res);
  });

  return {
    requests,
    queue,
    listen(port: number, host: string) {
      return new Promise((resolve) => server.listen(port, host, resolve));
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** Shared JSON-response helper for business route handlers. */
export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  send(res, status, body);
}

/** Parse a CLI arg of the form "http://127.0.0.1:PORT" into { host, port }. */
export function parseListenArg(arg: string): { host: string; port: number } {
  const url = new URL(arg);
  return { host: url.hostname, port: Number(url.port) };
}
