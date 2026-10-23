import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import {
  COMPUTER_USE_TOOL_NAMES,
  controlWebBrowser,
  EMBEDDED_ROOT_PREFIX,
  EMBEDDED_STATE_PREFIX,
  EMBEDDED_OUTPUT_PREFIX,
} from "../../extensions/browser/web-bridge.ts";
import { loadSetupConfig } from "../../extensions/shared/setup-config.ts";
import { COMPUTER_USE_PACKAGE } from "../../extensions/shared/computer-use.ts";

export function computerUsePackage(file: string) {
  for (let directory = dirname(file); ; directory = dirname(directory)) {
    try {
      const value: unknown = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      return value && typeof value === "object" && "name" in value && "version" in value && value.name === COMPUTER_USE_PACKAGE.name && typeof value.version === "string"
        ? { name: value.name, version: value.version } : undefined;
    } catch {
      if (dirname(directory) === directory) return undefined;
    }
  }
}

const embeddedSelected = () => loadSetupConfig().browser.defaultBrowser === "embedded";

// Upstream 0.5.1 stores native state in its module. Pi caches extension factories
// across Web parents, so only one parent may own that native runtime at a time.
let nativeOwner: object | undefined;

/** Pi owns the original definitions. Embedded calls never initialize native state. */
export function adaptComputerUseExtensions(base: LoadExtensionsResult) {
  return { ...base, extensions: base.extensions.map((extension) => {
    const identity = computerUsePackage(extension.resolvedPath);
    if (!identity) return extension;
    const tools = new Map(extension.tools);
    const handlers = new Map(extension.handlers);
    const commands = new Map(extension.commands);
    const lease = {};
    let initialized: Promise<void> | undefined;
    let startEvent: unknown = { type: "session_start" };
    const start = extension.handlers.get("session_start") ?? [];
    const stop = extension.handlers.get("session_shutdown") ?? [];
    const checkNativeOwner = () => {
      const owner = nativeOwner;
      if (owner && owner !== lease) throw new Error("Native computer use is owned by another Pi Session. Finish or close that Session before using the same desktop runtime.");
    };
    const initialize = async (ctx: import("@earendil-works/pi-coding-agent").ExtensionContext) => {
      checkNativeOwner();
      if (!initialized) {
        nativeOwner = lease;
        initialized = (async () => { for (const handler of start) await handler(startEvent, ctx); })();
      }
      await initialized;
    };
    const shutdown = async (event: unknown, ctx: unknown) => {
      if (nativeOwner !== lease) return;
      await initialized?.catch(() => undefined);
      for (const handler of stop) await handler(event, ctx);
      nativeOwner = undefined;
      initialized = undefined;
    };
    for (const [name, registered] of extension.tools) {
      const tool = COMPUTER_USE_TOOL_NAMES.find((tool) => tool === name);
      const native = registered.definition;
      tools.set(name, { ...registered, definition: {
        ...native,
        async execute(id, params, signal, update, ctx) {
          if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("Computer-use arguments must be an object.");
          const input = params as Record<string, unknown>;
          const embeddedIdentity =
            (typeof input.root === "string" && input.root.startsWith(EMBEDDED_ROOT_PREFIX)) ||
            (typeof input.stateId === "string" && input.stateId.startsWith(EMBEDDED_STATE_PREFIX)) ||
            (typeof input.ref === "string" && input.ref.startsWith(EMBEDDED_OUTPUT_PREFIX));
          if (!embeddedIdentity && !embeddedSelected()) {
            await initialize(ctx);
            return native.execute(id, params, signal, update, ctx);
          }
          if (identity.version !== COMPUTER_USE_PACKAGE.version || !tool)
            throw new Error(`Embedded computer use requires ${COMPUTER_USE_PACKAGE.source}; native execution was not attempted.`);
          return controlWebBrowser(ctx.sessionManager, { tool, params: input }, signal);
        },
      } });
    }
    handlers.set("session_start", [async (event, ctx) => { await shutdown({ type: "session_shutdown" }, ctx); startEvent = event; }]);
    handlers.set("session_shutdown", [shutdown]);
    for (const [name, command] of commands) commands.set(name, { ...command, handler: async (args, ctx) => {
      checkNativeOwner();
      return command.handler(args, ctx);
    } });
    return { ...extension, tools, handlers, commands };
  }) };
}

export function loadedComputerUseStatus(base: LoadExtensionsResult) {
  const identity = base.extensions.map((extension) => computerUsePackage(extension.resolvedPath)).find(Boolean);
  return { loaded: Boolean(identity), ...(identity ? { version: identity.version } : {}) };
}
