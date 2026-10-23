import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, afterEach } from "node:test";
import type {
  AgentToolResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ComputerUseRequest } from "../../extensions/browser/web-bridge.ts";
import type { QuestionOwner } from "../../web/host/questions.ts";
import { toolExecutionContext } from "../support/extension-tool-context.ts";

const directory = mkdtempSync(join(tmpdir(), "openpi-computer-use-"));
process.env.PI_CODING_AGENT_DIR = directory;
const {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} = await import("@earendil-works/pi-coding-agent");
const { adaptComputerUseExtensions } = await import(
  "../../web/runtime/computer-use.ts"
);
const { COMPUTER_USE_TOOL_NAMES, registerWebBrowserBridge } = await import(
  "../../extensions/browser/web-bridge.ts"
);
const { WebBrowserBroker } = await import("../../web/host/browser-control.ts");
const { EmbeddedComputerUse } = await import("../../web/host/computer-use.ts");
const configure = (browser: Record<string, unknown>) =>
  writeFileSync(
    join(directory, "my-pi-setup.json"),
    JSON.stringify({ browser }),
  );
after(() => rmSync(directory, { force: true, recursive: true }));
afterEach(() => configure({ control: true }));

test("Pi loads the original eleven schemas once; embedded execution is adapted and native execution is preserved", async () => {
  configure({ control: true });
  const parameters = new Map<string, ToolDefinition["parameters"]>();
  const nativeCalls: string[] = [];
  const embeddedCalls: ComputerUseRequest[] = [];
  const plugin = dirname(
    fileURLToPath(
      import.meta.resolve("@injaneity/pi-computer-use/package.json"),
    ),
  );
  const settingsManager = SettingsManager.inMemory({ packages: [plugin] });
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    extensionsOverride(base) {
      for (const extension of base.extensions)
        for (const [name, registered] of extension.tools) {
          parameters.set(name, registered.definition.parameters);
          registered.definition = {
            ...registered.definition,
            async execute() {
              nativeCalls.push(name);
              return {
                content: [{ type: "text", text: "native receipt" }],
                details: { native: true },
              };
            },
          };
        }
      return adaptComputerUseExtensions(base);
    },
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const manager = SessionManager.inMemory(directory);
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    resourceLoader: loader,
    sessionManager: manager,
  });
  const unregister = registerWebBrowserBridge(manager, async (request) => {
    embeddedCalls.push(request);
    return {
      content: [{ type: "text", text: "embedded receipt" }],
      details: { embedded: true },
    };
  });
  try {
    await session.bindExtensions({ mode: "print" });
    const context = toolExecutionContext(
      session.createReplacedSessionContext(),
    );
    for (const name of COMPUTER_USE_TOOL_NAMES) {
      const definition = session.getToolDefinition(name);
      assert.ok(definition);
      assert.strictEqual(
        definition.parameters,
        parameters.get(name),
        `${name} schema must be the original object`,
      );
      await definition.execute("embedded", {}, undefined, undefined, context);
    }
    assert.deepEqual(
      embeddedCalls.map((request) => request.tool),
      [...COMPUTER_USE_TOOL_NAMES],
    );
    assert.deepEqual(nativeCalls, []);
    assert.equal(session.getToolDefinition("openpi_browser"), undefined);
    configure({ defaultBrowser: "chrome" });
    for (const name of COMPUTER_USE_TOOL_NAMES)
      await session
        .getToolDefinition(name)!
        .execute("native", {}, undefined, undefined, context);
    assert.deepEqual(nativeCalls, [...COMPUTER_USE_TOOL_NAMES]);
    await session
      .getToolDefinition("observe_ui")!
      .execute(
        "pinned",
        { root: "@r:embedded:prior" },
        undefined,
        undefined,
        context,
      );
    assert.equal(embeddedCalls.at(-1)?.tool, "observe_ui");
    assert.equal(nativeCalls.length, COMPUTER_USE_TOOL_NAMES.length);
  } finally {
    for (const extension of loader.getExtensions().extensions)
      for (const handler of extension.handlers.get("session_shutdown") ?? [])
        await handler(
          { type: "session_shutdown" },
          toolExecutionContext(session.createReplacedSessionContext()),
        );
    unregister();
    session.dispose();
  }
});

test("a native runtime has one Session owner; embedded lifecycle and another Session cannot reset or release it", async () => {
  configure({ defaultBrowser: "chrome" });
  const plugin = dirname(
    fileURLToPath(
      import.meta.resolve("@injaneity/pi-computer-use/package.json"),
    ),
  );
  const settingsManager = SettingsManager.inMemory({ packages: [plugin] });
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
  });
  await loader.reload();
  const base = loader.getExtensions();
  const extension = base.extensions.find((extension) =>
    extension.tools.has("find_roots"),
  )!;
  let starts = 0;
  let stops = 0;
  let calls = 0;
  extension.handlers.set("session_start", [
    async () => {
      starts++;
    },
  ]);
  extension.handlers.set("session_shutdown", [
    async () => {
      stops++;
    },
  ]);
  const registered = extension.tools.get("find_roots")!;
  const execute = async () => {
    calls++;
    return {
      content: [{ type: "text" as const, text: "native" }],
      details: {},
    };
  };
  registered.definition = { ...registered.definition, execute };
  const a = adaptComputerUseExtensions(base).extensions.find((extension) =>
    extension.tools.has("find_roots"),
  )!;
  const b = adaptComputerUseExtensions(base).extensions.find((extension) =>
    extension.tools.has("find_roots"),
  )!;
  assert.strictEqual(
    base.extensions
      .find((extension) => extension.tools.has("find_roots"))!
      .tools.get("find_roots")!.definition.execute,
    execute,
    "adapting a Session must not modify cached Pi definitions",
  );
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory(),
    sessionManager: SessionManager.inMemory(directory),
  });
  const ctx = toolExecutionContext(session.createReplacedSessionContext());
  const invoke = (target: typeof a) =>
    target.tools
      .get("find_roots")!
      .definition.execute("native", {}, undefined, undefined, ctx);
  const stop = async (target: typeof a) => {
    for (const handler of target.handlers.get("session_shutdown") ?? [])
      await handler({ type: "session_shutdown" }, ctx);
  };
  try {
    for (const handler of b.handlers.get("session_start") ?? [])
      await handler({ type: "session_start" }, ctx);
    assert.equal(
      starts,
      0,
      "loading an embedded-capable Session does not initialize desktop state",
    );
    await invoke(a);
    await assert.rejects(invoke(b), /owned by another Pi Session/u);
    assert.equal(calls, 1);
    await stop(b);
    assert.equal(
      stops,
      0,
      "a non-owner cannot clean up the owner's native resources",
    );
    await assert.rejects(invoke(b), /owned by another Pi Session/u);
    await stop(a);
    await invoke(b);
    assert.equal(starts, 2);
    assert.equal(calls, 2);
  } finally {
    await stop(a);
    await stop(b);
    session.dispose();
  }
});

const initialOwner: QuestionOwner = {
  sessionId: "session",
  workspace: directory,
  commandId: "turn",
  controllerId: "e64819ef-a6b7-49f6-81c6-fb466f320bd9",
  epoch: 1,
};
const page = {
  id: "frame",
  document: "884819ef-a6b7-49f6-81c6-fb466f320bd9",
  title: "Fixture",
  url: "https://fixture.invalid/",
};
const observation = {
  text: "Fixture form",
  truncated: false,
  nodes: [
    { ref: "@e1", role: "RootWebArea", name: "Fixture form" },
    {
      ref: "@e2",
      parent: "@e1",
      role: "textbox",
      name: "Editor",
      value: "original",
    },
    { ref: "@e3", parent: "@e1", role: "button", name: "Save" },
    {
      ref: "@e4",
      parent: "@e1",
      role: "file_input",
      name: "STEP attachment",
      value: "[]",
    },
  ],
};

function fixture() {
  let owner = initialOwner;
  let next = structuredClone(observation);
  const requests: import("../../extensions/browser/web-bridge.ts").BrowserRequest[] =
    [];
  const broker = new WebBrowserBroker(() => owner);
  broker.poll(owner.sessionId, owner.controllerId, [page]);
  const backend = new EmbeddedComputerUse(
    async (request, signal) => {
      requests.push(request);
      const result = broker.execute(request, signal);
      const pending = broker.poll(owner.sessionId, owner.controllerId, [page]);
      if (pending && "request" in pending)
        broker.result(
          owner.sessionId,
          owner.controllerId,
          pending.requestId,
          structuredClone(next),
        );
      return result;
    },
    () => owner,
  );
  const execute = async <T>(
    tool: ComputerUseRequest["tool"],
    params: Record<string, unknown> = {},
  ) => (await backend.execute({ tool, params })) as AgentToolResult<T>;
  return {
    execute,
    broker,
    requests,
    backend,
    setOwner(value: QuestionOwner) {
      owner = value;
      broker.poll(owner.sessionId, owner.controllerId, [page]);
    },
    setObservation(value: typeof observation) {
      next = value;
    },
  };
}

test("embedded states support cached queries, scoped text, single file intake and consume writes without replay", async () => {
  configure({ control: true });
  const f = fixture();
  try {
    const roots = await f.execute<{ windows: { windowRef: string }[] }>(
      "find_roots",
    );
    const root = roots.details.windows[0]!.windowRef;
    const observed = await f.execute<{ stateId: string }>("observe_ui", {
      root,
      mode: "semantic",
    });
    const stateId = observed.details.stateId;
    const search = await f.execute<{ matches: { ref: string }[] }>(
      "search_ui",
      { stateId, role: "file_input" },
    );
    assert.equal(search.details.matches[0]?.ref, "@e4");
    const expanded = await f.execute<{ nodes: unknown[] }>("expand_ui", {
      stateId,
      ref: "@e1",
    });
    assert.equal(expanded.details.nodes.length, 4);
    const read = await f.execute<{ text: string }>("read_text", {
      stateId,
      ref: "@e2",
    });
    assert.equal(read.details.text, "original");
    const file = join(directory, "模型.stp");
    writeFileSync(file, "STEP bytes");
    await f.execute("act_ui", {
      stateId,
      actions: [{ action: "setText", ref: "@e4", text: file }],
    });
    const action = f.requests.find((request) => request.operation === "act")!
      .actions![0];
    assert.deepEqual(action, {
      action: "setFiles",
      ref: "@e4",
      files: [file],
      expectedFiles: [{ name: "模型.stp", size: 10 }],
    });
    await assert.rejects(
      f.execute("act_ui", {
        stateId,
        actions: [{ action: "press", ref: "@e3" }],
      }),
      /stale/u,
    );
    const inspection = await f.execute<{ target: { name: string } }>(
      "inspect_ui",
      { stateId, ref: "@e3" },
    );
    assert.equal(
      inspection.details.target.name,
      "Save",
      "immutable cached reads survive a consumed write state",
    );
    configure({ control: false });
    await assert.rejects(
      f.execute("search_ui", { stateId, text: "Editor" }),
      /control is off/u,
    );
  } finally {
    f.broker.dispose();
  }
});

test("embedded identities cannot cross controllers or turns, and missing files never dispatch an upload", async () => {
  configure({ control: true });
  const f = fixture();
  try {
    const roots = await f.execute<{ windows: { windowRef: string }[] }>(
      "find_roots",
    );
    const root = roots.details.windows[0]!.windowRef;
    const observed = await f.execute<{ stateId: string }>("observe_ui", {
      root,
      mode: "semantic",
    });
    await assert.rejects(
      f.execute("act_ui", {
        stateId: observed.details.stateId,
        actions: [
          {
            action: "setText",
            ref: "@e4",
            text: join(directory, "missing.stp"),
          },
        ],
      }),
      /ENOENT/u,
    );
    assert.equal(
      f.requests.some((request) => request.operation === "act"),
      false,
    );
    f.setOwner({ ...initialOwner, controllerId: "other-controller" });
    await assert.rejects(
      f.execute("observe_ui", { root }),
      /root is unavailable/u,
    );
    await assert.rejects(
      f.execute("read_text", { stateId: observed.details.stateId, ref: "@e2" }),
      /another turn/u,
    );
    f.setOwner({ ...initialOwner, epoch: 2 });
    await assert.rejects(
      f.execute("act_ui", {
        stateId: observed.details.stateId,
        actions: [{ action: "press", ref: "@e3" }],
      }),
      /another turn/u,
    );
  } finally {
    f.broker.dispose();
  }
});

test("large original-tool output is bounded, recoverable with read_text, and never crosses turn ownership", async () => {
  configure({ control: true });
  const f = fixture();
  try {
    const large = structuredClone(observation);
    large.nodes[1]!.value = "中".repeat(15_980) + "END-OF-VALUE";
    for (let id = 5; id <= 16; id++)
      large.nodes.push({
        ref: `@e${id}`,
        parent: id === 5 ? "@e1" : `@e${id - 1}`,
        role: "group",
        name: "",
      });
    large.nodes[1]!.parent = "@e16";
    f.setObservation(large);
    const observed = await f.execute<{ stateId: string }>("observe_ui", {
      mode: "semantic",
    });
    const stateId = observed.details.stateId;
    const tail = await f.execute<{ text: string }>("read_text", {
      stateId,
      ref: "@e1",
      offset: 14_000,
    });
    assert.ok(
      tail.details.text.includes("END-OF-VALUE"),
      "reading a subtree must retain text beyond shallow layout wrappers",
    );
    const result = await f.execute("inspect_ui", { stateId, ref: "@e2" });
    const first = result.content[0];
    assert.equal(first?.type, "text");
    if (first?.type !== "text") throw new Error("Expected bounded text");
    assert.ok(first.text.length < 12_000);
    const ref = first.text.match(/@o:embedded:[\da-f-]+/u)?.[0];
    assert.ok(
      ref,
      "the original read_text interface must expose a continuation",
    );
    let restored = first.text.slice(0, 10_000);
    for (let offset = 10_000; ; ) {
      const page = await f.execute<{ text: string; nextOffset?: number }>(
        "read_text",
        { ref, offset },
      );
      restored += page.details.text;
      if (page.details.nextOffset === undefined) break;
      offset = page.details.nextOffset;
    }
    assert.equal(JSON.parse(restored).target.value, large.nodes[1]!.value);
    f.setOwner({ ...initialOwner, epoch: 2 });
    await assert.rejects(
      f.execute("read_text", { ref, offset: 0 }),
      /another turn/u,
    );
  } finally {
    f.broker.dispose();
  }
});

test("a suspended launch cannot continue into a different owning turn", async () => {
  let owner = initialOwner;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  const backend = new EmbeddedComputerUse(
    async (request) => {
      calls.push(request.operation);
      await pending;
      const details =
        request.operation === "open"
          ? { root: "frame" }
          : request.operation === "tabs"
            ? { pages: [{ ...page, root: "frame" }] }
            : { ...observation, root: "frame", stateId: "replacement-state" };
      return { content: [], details };
    },
    () => owner,
  );
  const launching = backend.execute({
    tool: "launch_browser",
    params: { url: page.url },
  });
  owner = { ...initialOwner, epoch: 2 };
  release();
  await assert.rejects(launching, /owning computer-use turn changed/u);
  assert.deepEqual(
    calls,
    ["open"],
    "no follow-up lookup or observation may target the new owner",
  );
});
