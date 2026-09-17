import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  AuthType,
} from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const MAX_TERMINAL_LOGINS = 16;

type LoginStatus =
  | "running"
  | "awaiting-input"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired"
  | "uncertain";

type LoginPrompt = {
  id: string;
  type: AuthPrompt["type"];
  message: string;
  placeholder?: string;
  options?: readonly { id: string; label: string; description?: string }[];
};

type LoginEvent =
  | { type: "info" | "progress"; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; expiresInSeconds?: number };

export interface ProviderLoginView {
  id: string;
  sessionId: string;
  workspace: string;
  epoch: number;
  providerId: string;
  method: AuthType;
  status: LoginStatus;
  expiresAt: number;
  event?: LoginEvent;
  prompt?: LoginPrompt;
}

type PendingPrompt = {
  id: string;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  dispose: () => void;
};

type LoginRecord = {
  view: ProviderLoginView;
  controller: AbortController;
  pending?: PendingPrompt;
  timer: ReturnType<typeof setTimeout>;
  operation?: Promise<void>;
  started: boolean;
  abortReason?: "cancelled" | "expired" | "stale";
};

function text(value: string, max = 500) {
  const normalized = value.replace(/[\r\n\t]/gu, " ");
  return normalized.length <= max && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(normalized)
    ? normalized
    : undefined;
}

function link(value: string) {
  if (value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password) return undefined;
    if (url.protocol === "https:") return value;
    if (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return value;
  } catch {}
  return undefined;
}

function projectEvent(event: AuthEvent): LoginEvent | undefined {
  if (event.type === "auth_url") {
    const url = link(event.url);
    if (!url) return undefined;
    const instructions = event.instructions && text(event.instructions);
    return { type: "auth_url", url, ...(instructions ? { instructions } : {}) };
  }
  if (event.type === "device_code") {
    const userCode = text(event.userCode, 128);
    const verificationUri = link(event.verificationUri);
    if (!userCode || !verificationUri) return undefined;
    return {
      type: "device_code", userCode, verificationUri,
      ...(Number.isSafeInteger(event.expiresInSeconds) && event.expiresInSeconds! > 0
        ? { expiresInSeconds: event.expiresInSeconds } : {}),
    };
  }
  if (event.type !== "info" && event.type !== "progress") return undefined;
  const message = text(event.message);
  if (!message) return undefined;
  if (event.type === "progress") return { type: "progress", message };
  const links = event.links?.slice(0, 4).flatMap((item) => {
    const url = link(item.url);
    const label = item.label && text(item.label, 160);
    return url ? [{ url, ...(label ? { label } : {}) }] : [];
  });
  return { type: "info", message, ...(links?.length ? { links } : {}) };
}

function projectPrompt(prompt: AuthPrompt): LoginPrompt | undefined {
  if (!["text", "secret", "manual_code", "select"].includes(prompt.type)) return undefined;
  const message = text(prompt.message);
  if (!message) return undefined;
  if (prompt.type !== "select") {
    const placeholder = prompt.placeholder && text(prompt.placeholder, 160);
    return {
      id: randomUUID(), type: prompt.type, message,
      ...(placeholder ? { placeholder } : {}),
    };
  }
  if (prompt.options.length === 0 || prompt.options.length > 16) return undefined;
  const options = prompt.options.map((option) => ({
    id: text(option.id, 160),
    label: text(option.label, 160),
    description: option.description && text(option.description, 240),
  }));
  if (options.some((option) => !option.id || !option.label)) return undefined;
  return {
    id: randomUUID(), type: "select", message,
    options: options.map((option) => ({
      id: option.id!, label: option.label!,
      ...(option.description ? { description: option.description } : {}),
    })),
  };
}

export class ProviderLogins {
  private readonly records = new Map<string, LoginRecord>();
  private readonly inFlight = new Set<Promise<void>>();
  private active?: LoginRecord;
  private readonly changed: () => void;

  constructor(changed: () => void) {
    this.changed = changed;
  }

  get(id: string) {
    const record = this.records.get(id);
    return record && { ...record.view };
  }

  list() {
    return [...this.records.values()].map((record) => ({ ...record.view }));
  }

  start(
    target: Omit<ProviderLoginView, "status" | "expiresAt" | "event" | "prompt">,
    login: (interaction: AuthInteraction) => Promise<unknown>,
    timeoutMs = LOGIN_TIMEOUT_MS,
  ) {
    const existing = this.records.get(target.id);
    if (existing) {
      const view = existing.view;
      if (
        view.sessionId !== target.sessionId || view.workspace !== target.workspace ||
        view.epoch !== target.epoch || view.providerId !== target.providerId ||
        view.method !== target.method
      ) return { state: "conflict" as const };
      return { state: "replayed" as const, view: { ...view } };
    }
    if (this.active || this.inFlight.size || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      return { state: "busy" as const };
    }
    const controller = new AbortController();
    const view: ProviderLoginView = {
      ...target, status: "running", expiresAt: Date.now() + timeoutMs,
    };
    const record: LoginRecord = {
      view, controller, started: false,
      timer: setTimeout(() => this.abort(record, "expired"), timeoutMs),
    };
    this.active = record;
    this.records.set(target.id, record);
    this.changed();
    record.operation = Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      record.started = true;
      try {
        await login({
          signal: controller.signal,
          notify: (event) => {
            if (controller.signal.aborted || record.view.status === "uncertain") return;
            const projected = projectEvent(event);
            if (!projected) {
              this.abort(record, "stale");
              return;
            }
            if (record.view.event?.type === "auth_url" || record.view.event?.type === "device_code") {
              if (projected.type !== "info" && projected.type !== "progress") record.view.event = projected;
            } else record.view.event = projected;
            this.changed();
          },
          prompt: (prompt) => this.prompt(record, prompt),
        });
        this.finish(record, controller.signal.aborted ? "uncertain" : "succeeded");
      } catch {
        this.finish(record,
          record.abortReason === "expired" ? "expired" :
          record.abortReason ? (record.started ? "uncertain" : "cancelled") : "failed");
      }
    });
    const operation = record.operation;
    this.inFlight.add(operation);
    void operation.then(
      () => this.inFlight.delete(operation),
      () => this.inFlight.delete(operation),
    );
    return { state: "accepted" as const, view: { ...view } };
  }

  answer(id: string, promptId: string, value: string) {
    const record = this.records.get(id);
    if (!record || record !== this.active || !record.pending || record.pending.id !== promptId) {
      return "stale" as const;
    }
    const prompt = record.view.prompt;
    if (!prompt || value.length === 0 || value.length > 4_096 ||
        (prompt.type === "select" && !prompt.options?.some((option) => option.id === value))) {
      return "invalid" as const;
    }
    const pending = record.pending;
    pending.dispose();
    record.pending = undefined;
    record.view.prompt = undefined;
    record.view.status = "running";
    this.changed();
    pending.resolve(value);
    return "accepted" as const;
  }

  cancel(id: string) {
    const record = this.records.get(id);
    if (!record) return "stale" as const;
    if (record !== this.active) return "already-settled" as const;
    this.abort(record, "cancelled");
    return "accepted" as const;
  }

  invalidate() {
    if (this.active) this.abort(this.active, "stale");
  }

  async close() {
    this.invalidate();
    await Promise.allSettled([...this.inFlight]);
    this.records.clear();
  }

  private prompt(record: LoginRecord, prompt: AuthPrompt) {
    if (record.controller.signal.aborted || record !== this.active || record.pending) {
      return Promise.reject(new Error("Login interaction unavailable"));
    }
    const projected = projectPrompt(prompt);
    if (!projected) {
      this.abort(record, "stale");
      return Promise.reject(new Error("Unsupported login prompt"));
    }
    return new Promise<string>((resolve, reject) => {
      const aborted = () => {
        if (record.pending?.id !== projected.id) return;
        record.pending?.dispose();
        record.pending = undefined;
        record.view.prompt = undefined;
        record.view.status = "running";
        this.changed();
        reject(new Error("Login interaction cancelled"));
      };
      const dispose = () => {
        record.controller.signal.removeEventListener("abort", aborted);
        prompt.signal?.removeEventListener("abort", aborted);
      };
      record.pending = { id: projected.id, resolve, reject, dispose };
      record.view.prompt = projected;
      record.view.status = "awaiting-input";
      record.controller.signal.addEventListener("abort", aborted, { once: true });
      prompt.signal?.addEventListener("abort", aborted, { once: true });
      if (record.controller.signal.aborted || prompt.signal?.aborted) aborted();
      else this.changed();
    });
  }

  private abort(record: LoginRecord, reason: LoginRecord["abortReason"]) {
    if (record !== this.active || record.controller.signal.aborted) return;
    record.abortReason = reason;
    record.controller.abort();
    // Pi may already be persisting a credential. Do not claim cancellation is a rollback.
    this.finish(record,
      reason === "expired" ? "expired" : record.started ? "uncertain" : "cancelled");
  }

  private finish(record: LoginRecord, status: LoginStatus) {
    if (record !== this.active) return;
    clearTimeout(record.timer);
    record.pending?.dispose();
    record.pending?.reject(new Error("Login settled"));
    record.pending = undefined;
    record.view.prompt = undefined;
    record.view.event = undefined;
    record.view.status = status;
    this.active = undefined;
    this.changed();
    while (this.records.size > MAX_TERMINAL_LOGINS) {
      const oldest = this.records.keys().next().value;
      if (oldest) this.records.delete(oldest);
    }
  }
}
