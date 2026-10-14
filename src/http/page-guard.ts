import { setResponseHeader, setResponseStatus } from "@tanstack/react-start/server";
import type { ResponseHeaderName } from "@tanstack/start-server-core";
import { getRuntime } from "../app/runtime.js";
import { gateGetPage } from "./auth.js";
import { notFoundJson, UI_HEADERS, unauthorizedJson } from "./headers.js";

export function applyUiHeaders(status?: number): void {
  for (const [name, value] of Object.entries(UI_HEADERS)) {
    setResponseHeader(name as ResponseHeaderName, value);
  }
  if (status !== undefined) setResponseStatus(status);
}

const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** JSON challenges return immediately. Login and list fall through to the React page. */
export async function guardListGet(request: Request): Promise<Response | null> {
  const runtime = await getRuntime();
  const gate = gateGetPage(request, runtime.config.uiToken);
  if (gate === "disabled") return notFoundJson();
  if (gate === "challenge") return unauthorizedJson();
  applyUiHeaders(gate === "login" ? 401 : undefined);
  return null;
}

/**
 * Gate for `GET /ui/reviews/:taskId`. A missing review is a 404 only after the
 * cookie or bearer token checks out, so a logged-out request does not reveal it.
 */
export async function guardDetailGet(request: Request, taskId: string): Promise<Response | null> {
  if (!TASK_ID.test(taskId)) return notFoundJson();
  const runtime = await getRuntime();
  const gate = gateGetPage(request, runtime.config.uiToken);
  if (gate === "disabled") return notFoundJson();
  if (gate === "challenge") return unauthorizedJson();
  if (gate === "ok" && !(await runtime.service.reviewExists(taskId))) return notFoundJson();
  applyUiHeaders(gate === "login" ? 401 : undefined);
  return null;
}
