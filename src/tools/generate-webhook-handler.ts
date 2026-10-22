import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { json } from "./respond.js";

export const WEBHOOK_FRAMEWORKS = ["laravel", "express", "django", "nextjs"] as const;
export type WebhookFramework = (typeof WEBHOOK_FRAMEWORKS)[number];

export const WEBHOOK_KINDS = ["import_complete", "rows"] as const;
export type WebhookKind = (typeof WEBHOOK_KINDS)[number];

export interface HandlerOptions {
  kind: WebhookKind;
  verifySignature: boolean;
}

export const SIGNATURE_NOTES = [
  "Signature: header x-csvbox-signature is the hex HMAC-SHA256 of `${x-csvbox-timestamp}.${raw request body}` keyed with your signing secret.",
  "Verify against the RAW body (before JSON parsing) with a constant-time comparison, and reject timestamps older than ~5 minutes to stop replays.",
  "Keep the secret in an environment variable (CSVBOX_WEBHOOK_SECRET), never in source.",
];

export const KIND_NOTES: Record<WebhookKind, string[]> = {
  import_complete: [
    "Payload: JSON object sent when an import finishes. Fields include import_id, sheet_id, sheet_name, import_status (success | partial | failed), row_count, row_success, row_fail, original_filename, env_name, custom_fields, raw_columns, column_mappings, import_starttime and import_endtime.",
  ],
  rows: [
    "Payload: the imported rows sent to your API-webhook destination, as JSON (a list of row objects keyed by column_name). Large imports arrive as several chunked requests, so make the handler idempotent.",
  ],
};

const COMMON_NOTES = [
  "Respond with 2xx quickly (within a few seconds) and do heavy work in a queue or background job; slow or non-2xx responses can be treated as failed deliveries.",
  "Treat the payload as untrusted input and validate fields before using them.",
];

function express({ kind, verifySignature }: HandlerOptions): string {
  const verify = verifySignature
    ? `
const SECRET = process.env.CSVBOX_WEBHOOK_SECRET;

function verifySignature(req) {
  const timestamp = req.get("x-csvbox-timestamp");
  const signature = req.get("x-csvbox-signature");
  if (!SECRET || !timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = crypto
    .createHmac("sha256", SECRET)
    .update(\`\${timestamp}.\`)
    .update(req.rawBody)
    .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
`
    : "";
  const check = verifySignature
    ? `  if (!verifySignature(req)) return res.status(401).json({ error: "invalid signature" });\n`
    : "";
  const body =
    kind === "import_complete"
      ? `  const { import_id, sheet_name, import_status, row_count, row_success, row_fail } = req.body;
  console.log(\`Import \${import_id} on \${sheet_name}: \${import_status} (\${row_success}/\${row_count} rows, \${row_fail} failed)\`);
  // TODO: enqueue follow-up work here (notify, reconcile, etc.)`
      : `  const rows = Array.isArray(req.body) ? req.body : [];
  console.log(\`Received \${rows.length} rows\`);
  // TODO: enqueue \`rows\` for processing; make this idempotent (chunks may be retried)`;
  return `// Express handler for CSVBox webhooks
// npm install express
const express = require("express");${verifySignature ? '\nconst crypto = require("crypto");' : ""}
${verify}
const app = express();

// Keep the raw bytes: the signature is computed over them, not over parsed JSON.
app.use(
  express.json({
    limit: "10mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.post("/webhooks/csvbox", (req, res) => {
${check}${body}
  res.sendStatus(200);
});

app.listen(3000, () => console.log("Listening on :3000"));
`;
}

function nextjs({ kind, verifySignature }: HandlerOptions): string {
  const verify = verifySignature
    ? `
function verifySignature(req: Request, raw: string): boolean {
  const secret = process.env.CSVBOX_WEBHOOK_SECRET;
  const timestamp = req.headers.get("x-csvbox-timestamp");
  const signature = req.headers.get("x-csvbox-signature");
  if (!secret || !timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(\`\${timestamp}.\${raw}\`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
`
    : "";
  const check = verifySignature
    ? `  if (!verifySignature(req, raw)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }
`
    : "";
  const body =
    kind === "import_complete"
      ? `  const { import_id, sheet_name, import_status, row_count, row_success, row_fail } = payload;
  console.log(\`Import \${import_id} on \${sheet_name}: \${import_status} (\${row_success}/\${row_count} rows, \${row_fail} failed)\`);
  // TODO: enqueue follow-up work here`
      : `  const rows: Record<string, unknown>[] = Array.isArray(payload) ? payload : [];
  console.log(\`Received \${rows.length} rows\`);
  // TODO: enqueue rows for processing; make this idempotent (chunks may be retried)`;
  return `// app/api/webhooks/csvbox/route.ts  (Next.js App Router)
import { NextResponse } from "next/server";${verifySignature ? '\nimport crypto from "crypto";' : ""}
${verify}
export async function POST(req: Request) {
  const raw = await req.text(); // raw body, needed for signature checks
${check}  const payload = JSON.parse(raw);
${body}
  return NextResponse.json({ ok: true });
}
`;
}

function django({ kind, verifySignature }: HandlerOptions): string {
  const verify = verifySignature
    ? `
SECRET = os.environ.get("CSVBOX_WEBHOOK_SECRET", "")


def verify_signature(request) -> bool:
    timestamp = request.headers.get("x-csvbox-timestamp", "")
    signature = request.headers.get("x-csvbox-signature", "")
    if not SECRET or not timestamp or not signature:
        return False
    try:
        if abs(time.time() - float(timestamp)) > 300:
            return False
    except ValueError:
        return False
    expected = hmac.new(
        SECRET.encode(), timestamp.encode() + b"." + request.body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature)

`
    : "";
  const check = verifySignature
    ? `    if not verify_signature(request):
        return JsonResponse({"error": "invalid signature"}, status=401)
`
    : "";
  const body =
    kind === "import_complete"
      ? `    logger.info(
        "Import %s on %s: %s (%s/%s rows, %s failed)",
        payload.get("import_id"), payload.get("sheet_name"), payload.get("import_status"),
        payload.get("row_success"), payload.get("row_count"), payload.get("row_fail"),
    )
    # TODO: enqueue follow-up work here (Celery, django-q, ...)`
      : `    rows = payload if isinstance(payload, list) else []
    logger.info("Received %d rows", len(rows))
    # TODO: enqueue rows for processing; make this idempotent (chunks may be retried)`;
  return `# views.py  (Django)
import json
import logging${verifySignature ? "\nimport hashlib\nimport hmac\nimport os\nimport time" : ""}

from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

logger = logging.getLogger(__name__)
${verify}

@csrf_exempt  # webhooks carry no CSRF token
@require_POST
def csvbox_webhook(request):
${check}    try:
        payload = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"error": "invalid json"}, status=400)

${body}
    return JsonResponse({"ok": True})


# urls.py
#   path("webhooks/csvbox/", views.csvbox_webhook),
`;
}

function laravel({ kind, verifySignature }: HandlerOptions): string {
  const verify = verifySignature
    ? `        $timestamp = $request->header('x-csvbox-timestamp');
        $signature = $request->header('x-csvbox-signature');
        $secret = config('services.csvbox.webhook_secret'); // env('CSVBOX_WEBHOOK_SECRET')

        if (!$secret || !$timestamp || !$signature || abs(time() - (int) $timestamp) > 300) {
            return response()->json(['error' => 'invalid signature'], 401);
        }

        $expected = hash_hmac('sha256', $timestamp . '.' . $request->getContent(), $secret);

        if (!hash_equals($expected, $signature)) {
            return response()->json(['error' => 'invalid signature'], 401);
        }

`
    : "";
  const body =
    kind === "import_complete"
      ? `        $payload = $request->json()->all();

        Log::info('CSVBox import finished', [
            'import_id' => $payload['import_id'] ?? null,
            'sheet' => $payload['sheet_name'] ?? null,
            'status' => $payload['import_status'] ?? null,
            'rows' => $payload['row_count'] ?? null,
            'failed' => $payload['row_fail'] ?? null,
        ]);

        // TODO: dispatch a queued job for follow-up work`
      : `        $rows = $request->json()->all(); // list of row objects

        Log::info('CSVBox rows received', ['count' => count($rows)]);

        // TODO: dispatch a queued job; make it idempotent (chunks may be retried)`;
  return `<?php
// app/Http/Controllers/CsvboxWebhookController.php  (Laravel)

namespace App\\Http\\Controllers;

use Illuminate\\Http\\Request;
use Illuminate\\Support\\Facades\\Log;

class CsvboxWebhookController extends Controller
{
    public function handle(Request $request)
    {
${verify}${body}

        return response()->json(['ok' => true]);
    }
}

// routes/api.php
//   Route::post('/webhooks/csvbox', [CsvboxWebhookController::class, 'handle']);
// Webhooks send no CSRF token: keep this route in api.php, or add it to
// VerifyCsrfToken::$except if you register it in web.php.
`;
}

const BUILDERS: Record<WebhookFramework, (o: HandlerOptions) => string> = {
  express,
  nextjs,
  django,
  laravel,
};

export function buildWebhookHandler(framework: WebhookFramework, options: HandlerOptions) {
  return {
    framework,
    kind: options.kind,
    code: BUILDERS[framework](options),
    notes: [
      ...KIND_NOTES[options.kind],
      ...(options.verifySignature ? SIGNATURE_NOTES : []),
      ...COMMON_NOTES,
    ],
  };
}

export function registerGenerateWebhookHandler(server: McpServer): void {
  server.registerTool(
    "generate_webhook_handler",
    {
      title: "Generate Webhook Handler",
      description:
        "Generate receiving-side code for a CSVBox webhook in Laravel, Express, Django or Next.js. Input: { framework, kind?, verify_signature? }. kind 'import_complete' (default) parses the per-import summary payload; 'rows' parses the row data sent to an API-webhook destination. verify_signature (default false) adds HMAC-SHA256 verification of the x-csvbox-signature / x-csvbox-timestamp headers, which CSVBox sends only when signing is enabled on the API-webhook destination. generate_import_code covers the frontend embed; this covers the backend half. Returns { code, notes }. Local, no API call.",
      inputSchema: {
        framework: z.enum(WEBHOOK_FRAMEWORKS).describe("Backend framework to generate for."),
        kind: z
          .enum(WEBHOOK_KINDS)
          .optional()
          .describe("Which webhook to handle. Defaults to import_complete."),
        verify_signature: z
          .boolean()
          .optional()
          .describe("Include HMAC signature verification. Defaults to false."),
      },
    },
    async ({ framework, kind, verify_signature }) =>
      json(
        buildWebhookHandler(framework, {
          kind: kind ?? "import_complete",
          verifySignature: verify_signature ?? false,
        })
      )
  );
}
