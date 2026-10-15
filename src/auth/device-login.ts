import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import type { LoginView } from "../settings/page.js";
import { isSubscriptionProvider, type SubscriptionProvider } from "./providers.js";
import { publicAuthError } from "./reveal.js";

export type LoginPhase =
  | { kind: "starting" }
  | { kind: "code"; verificationUri: string; userCode: string; expiresAt: string | null }
  | { kind: "done" }
  | { kind: "error"; message: string };

export type DeviceLogin = (providerId: SubscriptionProvider, interaction: AuthInteraction) => Promise<unknown>;

const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

type Session = {
  provider: SubscriptionProvider;
  generation: number;
  phase: LoginPhase;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  onLeaveStarting: (() => void) | undefined;
};

/**
 * pi-ai writes the credential; this session does not keep it.
 * Localhost browser callbacks are not used: this process is reached at its public host.
 */
export class LoginSessions {
  #sessions = new Map<SubscriptionProvider, Session>();
  #generation = new Map<SubscriptionProvider, number>();

  constructor(private readonly login: DeviceLogin) {}

  start(provider: string, enterprise: string | undefined): { ok: true } | { ok: false; error: string } {
    if (!isSubscriptionProvider(provider)) return { ok: false, error: "That provider has no device-code login." };
    const generation = (this.#generation.get(provider) ?? 0) + 1;
    this.#generation.set(provider, generation);
    const previous = this.#sessions.get(provider);
    if (previous) {
      previous.controller.abort();
      this.#clearTimer(previous);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Login timed out.")), LOGIN_TIMEOUT_MS);
    timer.unref?.();
    const session: Session = {
      provider,
      generation,
      phase: { kind: "starting" },
      controller,
      timer,
      onLeaveStarting: undefined,
    };
    this.#sessions.set(provider, session);
    const interaction = this.#interaction(session, enterprise ?? "");
    void this.login(provider, interaction).then(
      () => this.#finish(session, { kind: "done" }),
      (error: unknown) => {
        if (this.#generation.get(provider) !== session.generation) return;
        if (session.phase.kind === "error") return;
        this.#finish(session, { kind: "error", message: publicAuthError(error) });
      },
    );
    return { ok: true };
  }

  abort(provider: string): void {
    if (!isSubscriptionProvider(provider)) return;
    const session = this.#sessions.get(provider);
    if (!session) return;
    this.#generation.set(provider, session.generation + 1);
    session.controller.abort();
    this.#clearTimer(session);
    this.#sessions.delete(provider);
  }

  snapshot(): LoginView[] {
    return [...this.#sessions.values()].map((session) => publicLogin(session));
  }

  acknowledgeDone(): void {
    for (const [provider, session] of this.#sessions) {
      if (session.phase.kind === "done") {
        this.#clearTimer(session);
        this.#sessions.delete(provider);
      }
    }
  }

  waitForCode(provider: string, timeoutMs: number): Promise<void> {
    if (!isSubscriptionProvider(provider)) return Promise.resolve();
    const session = this.#sessions.get(provider);
    if (!session || session.phase.kind !== "starting") return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        session.onLeaveStarting = undefined;
        resolve();
      }, timeoutMs);
      session.onLeaveStarting = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  #interaction(session: Session, enterprise: string): AuthInteraction {
    return {
      signal: session.controller.signal,
      prompt: async (prompt: AuthPrompt) => answerDevicePrompt(prompt, enterprise),
      notify: (event) => {
        if (this.#generation.get(session.provider) !== session.generation) return;
        if (event.type === "device_code") {
          const verificationUri = safeHttpUrl(event.verificationUri);
          const userCode = safeUserCode(event.userCode);
          if (!verificationUri || !userCode) {
            this.#finish(session, { kind: "error", message: "The provider returned a login code this page cannot show." });
            session.controller.abort();
            return;
          }
          const expiresAt =
            typeof event.expiresInSeconds === "number" && Number.isFinite(event.expiresInSeconds)
              ? new Date(Date.now() + event.expiresInSeconds * 1000).toISOString()
              : null;
          this.#setPhase(session, { kind: "code", verificationUri, userCode, expiresAt });
          return;
        }
        if (event.type === "auth_url") {
          this.#finish(session, {
            kind: "error",
            message: "This server only completes device-code login.",
          });
          session.controller.abort();
        }
      },
    };
  }

  #setPhase(session: Session, phase: LoginPhase): void {
    const leftStarting = session.phase.kind === "starting" && phase.kind !== "starting";
    session.phase = phase;
    if (leftStarting) {
      session.onLeaveStarting?.();
      session.onLeaveStarting = undefined;
    }
  }

  #finish(session: Session, phase: LoginPhase): void {
    if (this.#generation.get(session.provider) !== session.generation) return;
    this.#setPhase(session, phase);
    this.#clearTimer(session);
  }

  #clearTimer(session: Session): void {
    clearTimeout(session.timer);
  }
}

export function answerDevicePrompt(prompt: AuthPrompt, enterprise: string): string {
  if (prompt.type === "select") {
    const device = prompt.options.find((option) => option.id === "device_code");
    if (!device) throw new Error("This provider has no device-code login.");
    return device.id;
  }
  if (prompt.type === "text") return enterprise.trim();
  throw new Error("This server only completes device-code login.");
}

function publicLogin(session: Session): LoginView {
  const phase = session.phase;
  if (phase.kind === "code") {
    return {
      provider: session.provider,
      phase: "code",
      verificationUri: phase.verificationUri,
      userCode: phase.userCode,
      expiresAt: phase.expiresAt,
      message: null,
    };
  }
  if (phase.kind === "error") {
    return {
      provider: session.provider,
      phase: "error",
      verificationUri: null,
      userCode: null,
      expiresAt: null,
      message: phase.message,
    };
  }
  return {
    provider: session.provider,
    phase: phase.kind,
    verificationUri: null,
    userCode: null,
    expiresAt: null,
    message: null,
  };
}

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function safeUserCode(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length < 4 || trimmed.length > 80) return null;
  if (/[\s<>"'`]/.test(trimmed) || trimmed.includes("://")) return null;
  return trimmed;
}
