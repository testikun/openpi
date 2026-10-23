import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { BrowserRequest } from "../../extensions/browser/web-bridge.ts";
import { loadSetupConfig } from "../../extensions/shared/setup-config.ts";
import type { BrowserNode } from "./computer-use.ts";
import type { QuestionOwner } from "./questions.ts";

export interface EmbeddedBrowserPage {
  id: string;
  document: string;
  url: string;
  title: string;
}

interface BrowserObservation {
  nodes: BrowserNode[];
  text: string;
  truncated: boolean;
  image?: string;
  evaluation?: unknown;
}

export function browserUrl(input: unknown) {
  if (typeof input !== "string" || input.length > 8192) return false;
  try {
    const url = new URL(input);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

export function validBrowserPages(input: unknown, limit = 8): input is EmbeddedBrowserPage[] {
  return Array.isArray(input) && input.length <= limit && input.every((item: unknown) => {
    if (!item || typeof item !== "object") return false;
    const page = item as Partial<EmbeddedBrowserPage>;
    return typeof page.id === "string" && page.id.length > 0 && page.id.length <= 150 &&
      typeof page.document === "string" && /^(?:[\da-f]{32}|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/iu.test(page.document) &&
      typeof page.title === "string" && page.title.length <= 256 && browserUrl(page.url);
  }) && new Set(input.map((page: EmbeddedBrowserPage) => page.id)).size === input.length;
}

function sameOwner(a: QuestionOwner, b: QuestionOwner | undefined) {
  return Boolean(b && a.sessionId === b.sessionId && a.workspace === b.workspace && a.commandId === b.commandId &&
    a.epoch === b.epoch && a.controllerId === b.controllerId);
}

/** Ephemeral iframe transport. Pi owns the tools; the initiating Web turn owns delivery. */
export class WebBrowserBroker {
  private readonly connections = new Map<string, { sessionId: string; pages: EmbeddedBrowserPage[]; seen: number }>();
  private readonly states = new Map<string, { owner: QuestionOwner; page: EmbeddedBrowserPage; refs: Set<string>; image: boolean }>();
  private pending?: {
    id: string;
    owner: QuestionOwner;
    page?: EmbeddedBrowserPage;
    request: BrowserRequest;
    settle: (result?: unknown, error?: string) => void;
    taken: boolean;
  };
  private readonly owner: () => QuestionOwner | undefined;
  private readonly timeoutMs: number;
  constructor(owner: () => QuestionOwner | undefined, timeoutMs = 15000) {
    this.owner = owner;
    this.timeoutMs = timeoutMs;
  }

  poll(sessionId: string, controllerId: string, pages: EmbeddedBrowserPage[]) {
    this.reconcile();
    if (!loadSetupConfig().browser.control || !loadSetupConfig().browser.embedded) return null;
    if (this.connections.size >= 8 && !this.connections.has(controllerId)) this.connections.delete(this.connections.keys().next().value!);
    this.connections.set(controllerId, { sessionId, pages: structuredClone(pages), seen: Date.now() });
    const owner = this.owner();
    if (!owner || owner.sessionId !== sessionId || owner.controllerId !== controllerId) return null;
    const pending = this.pending;
    if (!pending) return null;
    if (pending.page && pending.request.operation !== "navigate" && !pages.some((page) => page.id === pending.page!.id && page.document === pending.page!.document)) {
      pending.settle(undefined, "The browser page closed or navigated. Observe again.");
      return null;
    }
    if (pending.taken) return { requestId: pending.id, running: true as const };
    pending.taken = true;
    return { requestId: pending.id, page: pending.page, request: pending.request };
  }

  result(sessionId: string, controllerId: string, requestId: string, result: unknown, error?: string) {
    this.reconcile();
    const pending = this.pending;
    if (!pending?.taken || pending.id !== requestId || pending.owner.sessionId !== sessionId || pending.owner.controllerId !== controllerId) return false;
    pending.settle(result, error);
    return true;
  }

  reconcile() {
    const config = loadSetupConfig().browser;
    if (!config.control || !config.embedded) { this.close(); return; }
    if (this.pending && !sameOwner(this.pending.owner, this.owner()))
      this.pending.settle(undefined, "Browser request cancelled because its turn or Session changed.");
  }

  close() {
    this.pending?.settle(undefined, "Browser bridge closed; execution may have been interrupted.");
    this.connections.clear();
    this.states.clear();
  }

  dispose() { this.close(); }

  async execute(request: BrowserRequest, signal?: AbortSignal): Promise<AgentToolResult<unknown>> {
    signal?.throwIfAborted();
    this.reconcile();
    const config = loadSetupConfig().browser;
    if (!config.control) throw new Error("Browser control is off. Enable embedded control through /openpi-setup.");
    if (!config.embedded) throw new Error("The embedded browser is not allowed.");
    if (request.browser && request.browser !== "embedded") throw new Error("External browsers use the original pi-computer-use plugin directly.");
    const owner = this.owner();
    if (!owner) throw new Error("This run has no originating Web tab for browser control. Send a new message in the OpenPI chat to continue.");
    const connection = this.connections.get(owner.controllerId);
    if (!connection || connection.sessionId !== owner.sessionId || Date.now() - connection.seen > 5000)
      throw new Error("The initiating OpenPI tab is not connected. Finish Settings → Browser setup.");
    if (request.operation === "tabs") {
      const pages = connection.pages.map(({ id, title, url }) => ({ root: id, title, url }));
      return { content: [{ type: "text", text: JSON.stringify(pages) }], details: { pages } };
    }
    const page = connection.pages.find((page) => page.id === request.root);
    if (!page && request.operation !== "open") throw new Error("An exact connected browser root is required. Call find_roots again.");
    if (request.operation === "open" && (!browserUrl(request.url) || connection.pages.length >= 8))
      throw new Error("Open requires an HTTP(S) URL and room for another browser page.");
    if (this.pending) throw new Error("Another browser request is in progress.");
    if (page && ["act", "navigate", "evaluate"].includes(request.operation)) {
      const state = request.stateId && this.states.get(request.stateId);
      if (!state || !sameOwner(state.owner, owner) || state.page.id !== page.id || state.page.document !== page.document)
        throw new Error("Browser state is stale. Observe this page again before acting.");
      if (request.operation === "navigate" && !browserUrl(request.url)) throw new Error("Navigation requires an HTTP(S) URL without credentials.");
      if (request.operation === "evaluate" && (typeof request.expression !== "string" || request.expression.length > 65_536))
        throw new Error("Evaluation requires a bounded expression.");
      if (request.operation === "act") {
        if (!request.actions?.length || request.actions.length > 20) throw new Error("Act requires 1–20 actions.");
        for (const action of request.actions) {
          if (!["press", "click", "setText", "typeText", "keypress", "scroll", "drag", "moveMouse", "setFiles"].includes(action.action))
            throw new Error("Unsupported embedded action.");
          if (["press", "setText", "setFiles"].includes(action.action) && !action.ref) throw new Error("Press and text input require an observed ref.");
          if (action.ref && !state.refs.has(action.ref)) throw new Error("The element ref does not belong to this observation.");
          if ((action.action === "setText" || action.action === "typeText") && (typeof action.text !== "string" || action.text.length > 16000))
            throw new Error("Text input requires bounded text.");
          if (action.action === "scroll" && [action.scrollX ?? 0, action.scrollY ?? 0].some((value) => !Number.isFinite(value) || Math.abs(value) > 10_000))
            throw new Error("Scroll requires a bounded distance.");
          if ((action.action === "click" && !action.ref) || action.action === "moveMouse" || action.action === "drag") {
            if (!state.image) throw new Error("Coordinates require an image-bearing observation of this embedded page.");
            const points = action.action === "drag" ? action.path : [{ x: action.x, y: action.y }];
            if (!points?.length || points.length > 1000 || points.some((point) => (Array.isArray(point) ? point : [point.x, point.y]).some((value) => value === undefined || !Number.isFinite(value) || value < 0)))
              throw new Error("Coordinates require a bounded finite path.");
          }
          if (action.action === "keypress" && (!action.keys?.length || action.keys.length > 16 || action.keys.some((key) => typeof key !== "string" || key.length > 64)))
            throw new Error("Keypress requires bounded key names.");
          if (action.action === "setFiles" && (action.files.length > 1 || action.files.some((path) => typeof path !== "string" || path.length > 8192)))
            throw new Error("File input requires one bounded local file path.");
        }
      }
    }
    for (const [id, state] of this.states) if (state.page.id === page?.id) this.states.delete(id);
    const previousPageIds = new Set(connection.pages.map((page) => page.id));
    const result = await new Promise<unknown>((resolve, reject) => {
      const id = randomUUID();
      const cancel = () => settle(undefined, "Browser request cancelled; effects already dispatched may be uncertain. Observe again.");
      const timer = setTimeout(() => settle(undefined, "Browser request timed out; delivery is uncertain. Observe again."), this.timeoutMs);
      const settle = (result?: unknown, error?: string) => {
        if (this.pending?.id !== id) return;
        this.pending = undefined;
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        if (error) reject(new Error(error.slice(0, 1000)));
        else resolve(result);
      };
      this.pending = { id, owner, page, request: structuredClone(request), settle, taken: false };
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });
    if (!sameOwner(owner, this.owner())) throw new Error("The owning browser turn changed.");
    if (request.operation === "open") {
      const opened = result as { root?: unknown } | null;
      if (!opened || typeof opened.root !== "string" || previousPageIds.has(opened.root) || !this.connections.get(owner.controllerId)?.pages.some((page) => page.id === opened.root))
        throw new Error("The browser page did not bind successfully.");
      return { content: [{ type: "text", text: `Opened embedded root ${opened.root}. Observe it to inspect the loaded page.` }], details: { root: opened.root } };
    }
    if (request.operation === "navigate") {
      if (!result || typeof result !== "object" || (result as { navigated?: unknown }).navigated !== true)
        throw new Error("Navigation delivery was not confirmed; observe again.");
      return { content: [{ type: "text", text: "Navigation was dispatched. Observe the new document to verify loading." }], details: { status: "dispatched" } };
    }
    const observation = result as Partial<BrowserObservation> | null;
    if (!observation || !Array.isArray(observation.nodes) || observation.nodes.length > 5000 ||
      typeof observation.text !== "string" || observation.text.length > 16000 ||
      observation.nodes.some((node) => !node || typeof node.ref !== "string" || !/^@e\d+$/u.test(node.ref) ||
        typeof node.role !== "string" || node.role.length > 100 || typeof node.name !== "string" || node.name.length > 500 ||
        (node.value !== undefined && (typeof node.value !== "string" || node.value.length > 16000)) ||
        (node.parent !== undefined && (typeof node.parent !== "string" || !/^@e\d+$/u.test(node.parent))) ||
        (node.actions !== undefined && (!Array.isArray(node.actions) || node.actions.length > 10 || node.actions.some((action) => typeof action !== "string" || action.length > 32)))) ||
      (observation.image !== undefined && (typeof observation.image !== "string" || observation.image.length > 4_000_000 || !/^[\w+/=]+$/u.test(observation.image))))
      throw new Error("The browser returned an invalid or oversized observation.");
    if (JSON.stringify(observation).length > 4_200_000) throw new Error("The browser observation exceeds the transport limit. Observe semantically or inspect a smaller region.");
    let capture;
    if (observation.image) {
      const bytes = Buffer.from(observation.image, "base64");
      if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("The browser screenshot is not a valid PNG.");
      const width = bytes.readUInt32BE(16);
      const height = bytes.readUInt32BE(20);
      if (!width || !height || width > 30000 || height > 30000) throw new Error("The browser screenshot dimensions are invalid.");
      capture = { width, height, coordinateSpace: "frame-relative-screenshot-pixels" };
    }
    if (!page) throw new Error("The browser page disappeared.");
    const stateId = randomUUID();
    if (this.states.size >= 32) this.states.delete(this.states.keys().next().value!);
    this.states.set(stateId, { owner, page, refs: new Set(observation.nodes.map((node) => node.ref)), image: Boolean(observation.image) });
    const details = { root: page.id, stateId, nodes: observation.nodes, text: observation.text,
      truncated: observation.truncated === true, ...(observation.evaluation !== undefined ? { evaluation: observation.evaluation } : {}), ...(capture ? { capture } : {}) };
    return { content: [{ type: "text", text: JSON.stringify(details) }, ...(observation.image ? [{ type: "image" as const, data: observation.image, mimeType: "image/png" }] : [])], details };
  }
}
