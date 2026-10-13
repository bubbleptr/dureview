import { verifyGithubSignature } from "../../src/github/signature.js";
import { parseWebhook } from "../../src/github/webhook.js";
import { ReviewSession } from "./session.js";

export { ReviewSession };

const BODY_LIMIT = 5_000_000;

type ReviewCaller = {
  dispatch(event: string, payload: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/health/")) {
      return Response.json({ ok: true });
    }
    if (request.method === "POST" && (url.pathname === "/webhook" || url.pathname === "/webhook/")) {
      return webhook(request, env);
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
};

async function webhook(request: Request, env: Env): Promise<Response> {
  const secret = env.DUREVIEW_WEBHOOK_SECRET;
  if (!secret) return Response.json({ error: "webhook secret is not configured" }, { status: 500 });
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > BODY_LIMIT) {
    return Response.json({ error: "request body is too large" }, { status: 413 });
  }
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > BODY_LIMIT) return Response.json({ error: "request body is too large" }, { status: 413 });
  const signature = request.headers.get("x-hub-signature-256") ?? undefined;
  if (!verifyGithubSignature(raw, signature, secret)) {
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw)) as unknown;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const event = request.headers.get("x-github-event") ?? "";
  const parsed = parseWebhook(event.length > 0 ? event : undefined, payload);
  if (parsed.kind === "ping") return Response.json({ ok: true });
  if (parsed.kind === "ignore") return Response.json({ ignored: true, reason: parsed.reason });
  const route = parsed.kind === "review"
    ? `${parsed.request.owner}/${parsed.request.repo}#${parsed.request.number}`
    : `${parsed.command.owner}/${parsed.command.repo}#${parsed.command.number}`;
  const stub = env.REVIEW.get(env.REVIEW.idFromName(route)) as unknown as ReviewCaller;
  const result = await stub.dispatch(event, payload);
  return Response.json(result.body, { status: result.status });
}
