import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { UiAction, UiCondition } from "@injaneity/pi-computer-use/src/contract.ts";
import {
  EMBEDDED_ROOT_PREFIX,
  EMBEDDED_STATE_PREFIX,
  EMBEDDED_OUTPUT_PREFIX,
  type BrowserAction,
  type BrowserRequest,
  type ComputerUseRequest,
} from "../../extensions/browser/web-bridge.ts";
import type { QuestionOwner } from "./questions.ts";

export interface BrowserNode {
  ref: string;
  role: string;
  name: string;
  value?: string;
  parent?: string;
  actions?: string[];
}

interface Observation {
  root: string;
  stateId: string;
  nodes: BrowserNode[];
  text: string;
  truncated: boolean;
  evaluation?: unknown;
  capture?: { width: number; height: number; coordinateSpace: string };
}

type Transport = (request: BrowserRequest, signal?: AbortSignal) => Promise<AgentToolResult<unknown>>;
interface StoredObservation extends Observation {
  owner: QuestionOwner;
  publicRoot: string;
  characters: number;
}

const textResult = (details: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(details) }],
  details,
});
const normalized = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
const sameOwner = (a: QuestionOwner, b: QuestionOwner | undefined) => Boolean(b &&
  a.sessionId === b.sessionId && a.workspace === b.workspace && a.commandId === b.commandId &&
  a.epoch === b.epoch && a.controllerId === b.controllerId);
const capabilities = (node: BrowserNode) => node.actions ?? (
  node.role === "file_input" ? ["setText"] :
  ["textbox", "searchbox", "combobox"].includes(node.role) ? ["press", "setText", "typeText"] :
  ["button", "link", "checkbox", "radio", "menuitem", "tab"].includes(node.role) ? ["press"] : []
);

/** State-scoped iframe backend for the original package's tool contract. */
export class EmbeddedComputerUse {
  private readonly roots = new Map<string, { root: string; sessionId: string; controllerId: string }>();
  private readonly states = new Map<string, StoredObservation>();
  private readonly outputs = new Map<string, { owner: QuestionOwner; text: string }>();
  private readonly operations = new AsyncLocalStorage<QuestionOwner>();
  private readonly transport: Transport;
  private readonly owner: () => QuestionOwner | undefined;

  constructor(transport: Transport, owner: () => QuestionOwner | undefined) {
    this.transport = transport;
    this.owner = owner;
  }

  clear() {
    this.roots.clear();
    this.states.clear();
    this.outputs.clear();
  }

  private currentOwner() {
    const owner = this.owner();
    if (!owner) throw new Error("This computer-use call has no originating Web tab or active turn.");
    const expected = this.operations.getStore();
    if (expected && !sameOwner(expected, owner)) throw new Error("The owning computer-use turn changed.");
    return owner;
  }

  private async pages(signal?: AbortSignal) {
    const owner = this.currentOwner();
    const result = await this.deliver({ operation: "tabs", browser: "embedded" }, signal);
    if (!sameOwner(owner, this.owner())) throw new Error("The owning computer-use turn changed.");
    return (result.details as { pages: { root: string; title: string; url: string }[] }).pages.map((page) => {
      let ref = [...this.roots].find(([, record]) => record.root === page.root && record.sessionId === owner.sessionId && record.controllerId === owner.controllerId)?.[0];
      if (!ref) {
        ref = `${EMBEDDED_ROOT_PREFIX}${randomUUID()}`;
        this.roots.set(ref, { root: page.root, sessionId: owner.sessionId, controllerId: owner.controllerId });
        if (this.roots.size > 128) this.roots.delete(this.roots.keys().next().value!);
      }
      return { ...page, windowRef: ref, app: "Browser", pid: 0, kind: "browser_page" };
    });
  }

  private state(value: unknown) {
    const state = typeof value === "string" && this.states.get(value);
    if (!state || !sameOwner(state.owner, this.owner()))
      throw new Error("Embedded state is unavailable or belongs to another turn. Observe the root again.");
    return state;
  }

  private async root(value: unknown, signal?: AbortSignal) {
    const pages = await this.pages(signal);
    if (typeof value === "string" && value) {
      const page = pages.find((page) => page.windowRef === value);
      if (!page) throw new Error("Embedded root is unavailable. Call find_roots again.");
      return page;
    }
    if (pages.length !== 1) throw new Error("Call find_roots and observe one exact embedded root.");
    return pages[0]!;
  }

  private remember(result: AgentToolResult<unknown>, publicRoot: string) {
    const owner = this.currentOwner();
    const observation = result.details as Observation;
    const stateId = `${EMBEDDED_STATE_PREFIX}${observation.stateId}`;
    const stored = { ...observation, owner, publicRoot, characters: JSON.stringify(observation).length };
    this.states.set(stateId, stored);
    while (this.states.size > 32 || [...this.states.values()].reduce((total, state) => total + state.characters, 0) > 8_000_000)
      this.states.delete(this.states.keys().next().value!);
    return { stored, stateId };
  }

  private present(result: AgentToolResult<unknown>, publicRoot: string, tool: string, execution?: unknown) {
    const { stored, stateId } = this.remember(result, publicRoot);
    const details = {
      tool, backend: "embedded", kind: "browser_page", stateId, root: { ref: publicRoot, kind: "browser_page" },
      nodes: stored.nodes.slice(0, 80).map((node) => ({ ...node, ...(node.value ? { value: node.value.slice(0, 300) } : {}), actions: capabilities(node) })),
      text: stored.text.slice(0, 8000),
      truncated: stored.truncated || stored.nodes.length > 80 || stored.text.length > 8000,
      ...(execution ? { execution } : {}),
      ...(stored.evaluation !== undefined ? { evaluation: stored.evaluation } : {}),
      ...(stored.capture ? { capture: stored.capture } : {}),
    };
    return {
      ...textResult(details),
      content: [
        ...textResult(details).content,
        ...result.content.filter((content) => content.type === "image"),
      ],
    };
  }

  private async observe(state: StoredObservation, signal?: AbortSignal) {
    if (!sameOwner(state.owner, this.owner())) throw new Error("The owning computer-use turn changed.");
    return this.deliver({ operation: "observe", browser: "embedded", root: state.root }, signal);
  }

  private node(state: StoredObservation, ref: unknown) {
    const node = state.nodes.find((node) => node.ref === ref);
    if (!node) throw new Error("Element ref does not belong to this state.");
    return node;
  }

  private subtree(state: StoredObservation, ref: string, depth = state.nodes.length) {
    this.node(state, ref);
    const selected = new Set([ref]);
    let frontier = new Set([ref]);
    for (let level = 0; level < depth && frontier.size; level++) {
      const next = state.nodes.filter((node) => node.parent && frontier.has(node.parent) && !selected.has(node.ref));
      frontier = new Set(next.map((node) => node.ref));
      for (const node of next) selected.add(node.ref);
    }
    return state.nodes.filter((node) => selected.has(node.ref));
  }

  private condition(state: StoredObservation, condition: UiCondition) {
    if (condition.ref && condition.scopeRef) throw new Error("Use either ref or scopeRef for a condition.");
    const nodes = condition.ref ? state.nodes.filter((node) => node.ref === condition.ref) :
      condition.scopeRef ? (state.nodes.some((node) => node.ref === condition.scopeRef) ? this.subtree(state, condition.scopeRef) : []) : state.nodes;
    const hasPredicate = Boolean(condition.ref || condition.scopeRef || condition.text || condition.role || condition.value !== undefined);
    if (!hasPredicate) throw new Error("A UI condition requires at least one predicate.");
    const matches = nodes.some((node) =>
      (!condition.text || normalized(`${node.name} ${node.value ?? ""}`).includes(normalized(condition.text))) &&
      (!condition.role || normalized(node.role) === normalized(condition.role)) &&
      (condition.value === undefined || normalized(node.value ?? "") === normalized(condition.value)),
    );
    return condition.until === "absent" ? !matches : matches;
  }

  private async wait(state: StoredObservation, condition: UiCondition, signal?: AbortSignal) {
    this.condition(state, condition);
    const until = Date.now() + Math.min(60_000, Math.max(100, condition.timeoutMs ?? 10_000));
    while (true) {
      signal?.throwIfAborted();
      const result = await this.observe(state, signal);
      const fresh = { ...(result.details as Observation), owner: state.owner, publicRoot: state.publicRoot, characters: 0 };
      if (this.condition(fresh, condition)) return { result, matched: true };
      if (Date.now() >= until) return { result, matched: false };
      await delay(100, undefined, { signal });
    }
  }

  async execute(request: ComputerUseRequest, signal?: AbortSignal) {
    const owner = this.currentOwner();
    return this.operations.run(owner, async () => {
      const result = await this.perform(request, signal);
      this.currentOwner();
      const content = result.content.map((content) => {
        if (content.type !== "text" || content.text.length <= 12000) return content;
        const ref = `${EMBEDDED_OUTPUT_PREFIX}${randomUUID()}`;
        this.outputs.set(ref, { owner, text: content.text });
        while (this.outputs.size > 32 || [...this.outputs.values()].reduce((total, output) => total + output.text.length, 0) > 8_000_000)
          this.outputs.delete(this.outputs.keys().next().value!);
        return { type: "text" as const, text: `${content.text.slice(0, 10000)}\n\nOutput truncated. read_text({ref:${JSON.stringify(ref)},offset:10000}) reads the immutable remainder in pages.` };
      });
      return { ...result, content };
    });
  }

  private async deliver(request: BrowserRequest, signal?: AbortSignal) {
    this.currentOwner();
    const result = await this.transport(request, signal);
    this.currentOwner();
    return result;
  }

  private async perform(request: ComputerUseRequest, signal?: AbortSignal) {
    signal?.throwIfAborted();
    this.currentOwner();
    const { tool, params } = request;
    if (tool === "read_text" && typeof params.ref === "string" && params.ref.startsWith(EMBEDDED_OUTPUT_PREFIX)) {
      await this.pages(signal);
      const output = this.outputs.get(params.ref);
      if (!output || !sameOwner(output.owner, this.owner())) throw new Error("The immutable output is unavailable or belongs to another turn.");
      const offset = Math.max(0, Math.trunc(Number(params.offset ?? 0)));
      return textResult({ tool, ref: params.ref, text: output.text.slice(offset, offset + 4000), nextOffset: offset + 4000 < output.text.length ? offset + 4000 : undefined });
    }
    if (tool === "find_roots") {
      const pages = await this.pages(signal);
      const matches = pages.filter((page) =>
        (!params.kind || params.kind === "browser_page") &&
        (!params.app || ["browser", "embedded"].includes(normalized(String(params.app)))) &&
        (!params.bundleId) && (params.pid === undefined || params.pid === 0) &&
        (!params.text || normalized(`${page.title} ${page.url}`).includes(normalized(String(params.text)))),
      );
      return textResult({ tool, backend: "embedded", windows: matches.slice(0, 12), totalMatches: matches.length, returned: Math.min(12, matches.length), hasMore: matches.length > 12, note: "Only pages in the initiating OpenPI tab are exposed. Native applications use the user's native backend selection; there is no silent fallback." });
    }
    if (tool === "launch_browser") {
      if (typeof params.url !== "string" || !params.url)
        throw new Error("Opening an embedded browser requires an HTTP(S) URL. Use find_roots for an existing page.");
      const opened = await this.deliver({ operation: "open", browser: "embedded", url: params.url }, signal);
      const root = (opened.details as { root: string }).root;
      const page = (await this.pages(signal)).find((page) => page.root === root);
      if (!page) throw new Error("The new embedded page did not bind.");
      return this.present(await this.deliver({ operation: "observe", root, browser: "embedded" }, signal), page.windowRef, tool);
    }
    if (tool === "observe_ui") {
      const page = await this.root(params.root, signal);
      return this.present(await this.deliver({ operation: "observe", root: page.root, browser: "embedded", image: params.mode === "visual" }, signal), page.windowRef, tool);
    }
    const state = this.state(params.stateId);
    // Cached queries still check live grants and the exact initiating controller.
    await this.pages(signal);
    if (tool === "search_ui") {
      if (!params.text && !params.role && !params.capability) throw new Error("Search requires at least one predicate.");
      const matches = state.nodes.filter((node) =>
        (!params.text || normalized(`${node.name} ${node.value ?? ""}`).includes(normalized(String(params.text)))) &&
        (!params.role || normalized(node.role) === normalized(String(params.role))) &&
        (!params.capability || capabilities(node).some((value) => normalized(value) === normalized(String(params.capability)))),
      );
      return textResult({ tool, stateId: params.stateId, matches: matches.slice(0, 30), totalMatches: matches.length, hasMore: matches.length > 30 });
    }
    if (tool === "inspect_ui") return textResult({ tool, stateId: params.stateId, target: this.node(state, params.ref) });
    if (tool === "expand_ui") return textResult({ tool, stateId: params.stateId, nodes: this.subtree(state, String(params.ref), Number(params.depth ?? 3)).slice(0, 100) });
    if (tool === "read_text") {
      const nodes = this.subtree(state, String(params.ref));
      const text = nodes.map((node) => node.value ?? node.name).filter(Boolean).join("\n");
      const offset = Math.max(0, Math.trunc(Number(params.offset ?? 0)));
      return textResult({ tool, stateId: params.stateId, text: text.slice(offset, offset + 4000), offset, nextOffset: offset + 4000 < text.length ? offset + 4000 : undefined });
    }
    if (tool === "wait_for") {
      const condition = params as UiCondition;
      if (condition.ref) this.node(state, condition.ref);
      if (condition.scopeRef) this.node(state, condition.scopeRef);
      const waited = await this.wait(state, condition, signal);
      return this.present(waited.result, state.publicRoot, tool, { outcome: waited.matched ? "worked" : "didnt", verification: { status: waited.matched ? "verified" : "failed" } });
    }
    if (tool === "act_ui") {
      const actions = params.actions as UiAction[];
      if (!Array.isArray(actions) || !actions.length || actions.length > 20) throw new Error("Act requires 1–20 actions.");
      const prepared: BrowserAction[] = [];
      for (const action of actions) {
        const node = action.ref ? this.node(state, action.ref) : undefined;
        if (node?.role === "file_input" && action.action === "setText") {
          const path = action.text ?? "";
          if (path && !isAbsolute(path)) throw new Error("File input setText requires an absolute local file path, or empty text to clear.");
          const info = path ? await stat(path) : undefined;
          if (info && !info.isFile()) throw new Error("File input requires a regular local file.");
          prepared.push({ action: "setFiles", ref: node.ref, files: path ? [path] : [], expectedFiles: path && info ? [{ name: basename(path), size: info.size }] : [] });
        } else prepared.push(action);
      }
      const preexisting = params.expect ? this.condition(state, params.expect as UiCondition) : false;
      const result = await this.deliver({ operation: "act", browser: "embedded", root: state.root, stateId: state.stateId, actions: prepared }, signal);
      if (params.expect) {
        const next = { ...(result.details as Observation), owner: state.owner, publicRoot: state.publicRoot, characters: 0 };
        const waited = await this.wait(next, params.expect as UiCondition, signal);
        return this.present(waited.result, state.publicRoot, tool, { actionCount: actions.length, outcome: waited.matched ? preexisting ? "unknown" : "worked" : "didnt", verification: { status: waited.matched ? preexisting ? "preexisting" : "verified" : "failed" } });
      }
      return this.present(result, state.publicRoot, tool, { actionCount: actions.length, outcome: "unknown", evidence: "Actions delivered; verify their application result in this successor state." });
    }
    if (tool === "navigate_browser") {
      await this.deliver({ operation: "navigate", browser: "embedded", root: state.root, stateId: state.stateId, url: String(params.url) }, signal);
      return textResult({ tool, status: "dispatched", root: { ref: state.publicRoot }, message: "Navigation was dispatched. Call find_roots and observe_ui after the new document binds." });
    }
    if (tool === "evaluate_browser") {
      const result = await this.deliver({ operation: "evaluate", browser: "embedded", root: state.root, stateId: state.stateId, expression: String(params.expression) }, signal);
      return this.present(result, state.publicRoot, tool);
    }
    throw new Error(`Unsupported computer-use tool: ${tool}`);
  }
}
