import { verifyGithubSignature } from "../github/signature.js";
import type { DureviewService } from "../service.js";
import { readRawBody } from "./body.js";

export const WEBHOOK_BODY_LIMIT = 5_000_000;

/**
 * Verify `X-Hub-Signature-256` against the raw body, then start or dedupe the
 * pi-durable review task. A bad signature never reaches the task runtime.
 */
export async function handleWebhookRequest(
  service: DureviewService,
  secret: string | undefined,
  request: Request,
): Promise<Response> {
  const raw = await readRawBody(request, WEBHOOK_BODY_LIMIT);
  const signature = request.headers.get("x-hub-signature-256") ?? undefined;
  const event = request.headers.get("x-github-event") ?? undefined;
  if (!secret) {
    return Response.json({ error: "webhook secret is not configured" }, { status: 500 });
  }
  if (!verifyGithubSignature(raw, signature, secret)) {
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }
  const result = await service.handleWebhook(raw, signature, event);
  return Response.json(result.body, { status: result.status });
}
