import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { UiAction } from "@injaneity/pi-computer-use/src/contract.ts";

export type BrowserAction =
  | UiAction
  | {
      action: "setFiles";
      ref: string;
      files: string[];
      expectedFiles: { name: string; size: number }[];
    };

/** The tool definitions and schemas are owned by the installed Pi package. */
export const COMPUTER_USE_TOOL_NAMES = [
  "find_roots",
  "observe_ui",
  "search_ui",
  "expand_ui",
  "inspect_ui",
  "act_ui",
  "read_text",
  "wait_for",
  "launch_browser",
  "navigate_browser",
  "evaluate_browser",
] as const;
export type ComputerUseToolName = (typeof COMPUTER_USE_TOOL_NAMES)[number];
export interface ComputerUseRequest {
  tool: ComputerUseToolName;
  params: Record<string, unknown>;
}

export const EMBEDDED_ROOT_PREFIX = "@r:embedded:";
export const EMBEDDED_STATE_PREFIX = "embedded:";
export const EMBEDDED_OUTPUT_PREFIX = "@o:embedded:";

export interface BrowserRequest {
  operation: "tabs" | "open" | "observe" | "act" | "navigate" | "evaluate";
  browser?: string;
  root?: string;
  stateId?: string;
  url?: string;
  image?: boolean;
  expression?: string;
  actions?: BrowserAction[];
}

type BrowserBridge = (
  request: ComputerUseRequest,
  signal?: AbortSignal,
) => Promise<AgentToolResult<unknown>>;
const key = Symbol.for("@tt-a1i/openpi/web-browser/v2");
const existing: unknown = Reflect.get(globalThis, key);
if (existing !== undefined && !(existing instanceof WeakMap))
  throw new Error("Incompatible OpenPI browser bridge");
const bridges: WeakMap<object, BrowserBridge> = existing ?? new WeakMap();
if (existing === undefined)
  Object.defineProperty(globalThis, key, { value: bridges });

export function registerWebBrowserBridge(scope: object, bridge: BrowserBridge) {
  if (bridges.has(scope))
    throw new Error("Session already has a browser bridge");
  bridges.set(scope, bridge);
  return () => {
    if (bridges.get(scope) === bridge) bridges.delete(scope);
  };
}

export function controlWebBrowser(
  scope: object,
  request: ComputerUseRequest,
  signal?: AbortSignal,
) {
  const bridge = bridges.get(scope);
  if (!bridge)
    throw new Error(
      "The OpenPI embedded browser is unavailable in this Session.",
    );
  return bridge(request, signal);
}
