import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, afterEach } from "node:test";
import type { QuestionOwner } from "../../web/host/questions.ts";
import type {
  WebActiveTurn,
  WebRuntimeController,
  WebRuntimeEvent,
} from "../../web/runtime/types.ts";

const directory = mkdtempSync(join(tmpdir(), "openpi-browser-broker-"));
process.env.PI_CODING_AGENT_DIR = directory;
writeFileSync(
  join(directory, "my-pi-setup.json"),
  JSON.stringify({ browser: { control: true } }),
);
const { WebBrowserBroker, validBrowserPages } = await import(
  "../../web/host/browser-control.ts"
);
after(() => rmSync(directory, { force: true, recursive: true }));
afterEach(() =>
  writeFileSync(
    join(directory, "my-pi-setup.json"),
    JSON.stringify({ browser: { control: true } }),
  ),
);
const owner: QuestionOwner = {
  workspace: "/workspace",
  sessionId: "session",
  commandId: "turn",
  epoch: 1,
  controllerId: "795239cc-8ff9-49cb-9894-e16b3ba86af7",
};
const page = {
  id: "frame-1",
  document: "795239cc-8ff9-49cb-9894-e16b3ba86af8",
  url: "https://example.com/",
  title: "Example",
};
const observed = {
  nodes: [{ ref: "@e1", role: "textbox", name: "Editor" }],
  text: "Example page",
  truncated: false,
};

const configure = (browser: Record<string, unknown>) =>
  writeFileSync(
    join(directory, "my-pi-setup.json"),
    JSON.stringify({ browser: { control: true, ...browser } }),
  );
test("Host browser control follows an exact native continuation, never an unrelated run or another Session", async (t) => {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const { WebHost } = await import("../../web/host/web-host.ts");
  const { controlWebBrowser } = await import(
    "../../extensions/browser/web-bridge.ts"
  );
  const { projectWebModelSearch } = await import(
    "../../web/runtime/model-discovery.ts"
  );
  const manager = SessionManager.inMemory(directory);
  const sessionId = manager.getSessionId();
  let active: WebActiveTurn | undefined;
  const listeners = new Set<(event: WebRuntimeEvent) => void>();
  const runtime: WebRuntimeController = {
    workspaceSelected: true,
    cwd: directory,
    sessionDirectory: directory,
    sessionManager: manager,
    isIdle: () => !active,
    getActiveTurn: () => active,
    sendPrompt: async (_content, options) => {
      active = { sessionId, commandId: options!.commandId!, epoch: 1 };
      for (const listener of listeners) listener({ type: "agent_start" });
      return { pendingFollowUps: 0 };
    },
    cancelTurn: async (options) => ({ ...options, state: "stale-turn" }),
    newSession: async () => ({ cancelled: false, sessionId }),
    switchSession: async () => ({ cancelled: false }),
    listModels: () => [],
    searchModels: (query, limit) => projectWebModelSearch([], query, limit),
    setModel: async () => {
      throw new Error("unused");
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: async () => {},
  };
  const token = "a".repeat(64);
  const host = new WebHost({ runtime, token });
  t.after(() => host.stop());
  await host.start();
  const sessionPath = `current:${sessionId}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-OpenPI-Web-Controller": owner.controllerId,
  };
  const response = await fetch(`${host.origin}/api/prompt`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      sessionId,
      sessionPath,
      content: "Use the browser",
      commandId: "web-origin",
      controllerId: owner.controllerId,
    }),
  });
  assert.equal(response.status, 202);
  const connected = await fetch(`${host.origin}/api/browser/control`, {
    method: "POST",
    headers,
    body: JSON.stringify({ sessionId, sessionPath, pages: [page] }),
  });
  assert.equal(connected.status, 200);
  const discover = () =>
    controlWebBrowser(manager, { tool: "find_roots", params: {} });
  assert.ok((await discover()).details);
  active = { sessionId, commandId: "native-continuation", epoch: 2 };
  await assert.rejects(discover(), /no originating Web tab/u);
  active.originCommandId = "web-origin";
  assert.ok((await discover()).details);
  active.originCommandId = "not-admitted";
  await assert.rejects(discover(), /no originating Web tab/u);
  active.originCommandId = "web-origin";
  active.sessionId = "another-session";
  await assert.rejects(discover(), /no originating Web tab/u);
  active.sessionId = sessionId;
  const originalPath = manager.getSessionFile;
  manager.getSessionFile = () => "/different-session.jsonl";
  await assert.rejects(discover(), /no originating Web tab/u);
  manager.getSessionFile = originalPath;
  configure({ control: false });
  await assert.rejects(discover(), /Browser control is off/u);
  configure({ control: true });
  active = undefined;
  await assert.rejects(discover(), /no originating Web tab/u);
});

test("embedded page advertisements are bounded and reject credentials and duplicate identities", () => {
  assert.ok(validBrowserPages([page]));
  assert.ok(
    validBrowserPages(
      [{ ...page, document: "C172E720FA2F839B12DE8D2D9E5709F0" }],
      64,
    ),
  );
  for (const pages of [
    [{ ...page, url: "https://user:secret@example.com/" }],
    [{ ...page, document: "" }],
    [page, page],
    Array(9).fill(page),
  ])
    assert.equal(validBrowserPages(pages), false);
});

test("the initiating controller owns discovery, result delivery and one dispatch without replay", async () => {
  const broker = new WebBrowserBroker(() => owner);
  broker.poll(owner.sessionId, owner.controllerId, [page]);
  broker.poll(owner.sessionId, "sibling", [{ ...page, id: "sibling" }]);
  const tabs = await broker.execute({ operation: "tabs" });
  assert.match(JSON.stringify(tabs.details), /frame-1/);
  assert.doesNotMatch(JSON.stringify(tabs.details), /sibling/);
  const waiting = broker.execute({ operation: "observe", root: page.id });
  assert.equal(broker.poll(owner.sessionId, "sibling", [page]), null);
  const pending = broker.poll(owner.sessionId, owner.controllerId, [page])!;
  assert.ok("page" in pending);
  assert.deepEqual(broker.poll(owner.sessionId, owner.controllerId, [page]), {
    requestId: pending.requestId,
    running: true,
  });
  assert.equal(
    broker.result(owner.sessionId, "sibling", pending.requestId, observed),
    false,
  );
  assert.equal(
    broker.result(
      owner.sessionId,
      owner.controllerId,
      pending.requestId,
      observed,
    ),
    true,
  );
  assert.equal(
    broker.result(
      owner.sessionId,
      owner.controllerId,
      pending.requestId,
      observed,
    ),
    false,
  );
  assert.match(JSON.stringify((await waiting).details), /stateId/);
  broker.close();
});

test("a dispatched write consumes its state even when its result is uncertain", async () => {
  const broker = new WebBrowserBroker(() => owner);
  broker.poll(owner.sessionId, owner.controllerId, [page]);
  const read = broker.execute({ operation: "observe", root: page.id });
  const pending = broker.poll(owner.sessionId, owner.controllerId, [page])!;
  broker.result(
    owner.sessionId,
    owner.controllerId,
    pending.requestId,
    observed,
  );
  const result = await read;
  const stateId = (result.details as { stateId: string }).stateId;
  await assert.rejects(
    broker.execute({
      operation: "act",
      root: page.id,
      stateId,
      actions: [{ action: "setText", text: "must not write" }],
    }),
    /require an observed ref/,
  );
  await assert.rejects(
    broker.execute({
      operation: "act",
      root: page.id,
      stateId,
      actions: [{ action: "press", ref: "@e2" }],
    }),
    /does not belong/,
  );
  const aborted = new AbortController();
  const write = broker.execute(
    {
      operation: "act",
      root: page.id,
      stateId,
      actions: [{ action: "setText", ref: "@e1", text: "中文" }],
    },
    aborted.signal,
  );
  broker.poll(owner.sessionId, owner.controllerId, [page]);
  aborted.abort();
  await assert.rejects(write, /uncertain/);
  await assert.rejects(
    broker.execute({
      operation: "act",
      root: page.id,
      stateId,
      actions: [{ action: "press", ref: "@e1" }],
    }),
    /stale/,
  );
  broker.close();
});

test("opening an internal page requires a newly bound advertised root", async () => {
  const broker = new WebBrowserBroker(() => owner);
  broker.poll(owner.sessionId, owner.controllerId, [page]);
  const invalid = broker.execute({ operation: "open", url: page.url });
  const missing = broker.poll(owner.sessionId, owner.controllerId, [page])!;
  broker.result(owner.sessionId, owner.controllerId, missing.requestId, {
    root: "unbound",
  });
  await assert.rejects(invalid, /did not bind/);
  const waiting = broker.execute({ operation: "open", url: page.url });
  const pending = broker.poll(owner.sessionId, owner.controllerId, [page])!;
  broker.poll(owner.sessionId, owner.controllerId, [
    page,
    {
      ...page,
      id: "new-frame",
      document: "795239cc-8ff9-49cb-9894-e16b3ba86af9",
    },
  ]);
  broker.result(owner.sessionId, owner.controllerId, pending.requestId, {
    root: "new-frame",
  });
  assert.deepEqual((await waiting).details, { root: "new-frame" });
  broker.close();
});

test("document replacement, turn replacement, timeout and shutdown revoke pending control", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let active = owner;
  const broker = new WebBrowserBroker(() => active, 100);
  broker.poll(owner.sessionId, owner.controllerId, [page]);
  const documentWait = broker.execute({ operation: "observe", root: page.id });
  broker.poll(owner.sessionId, owner.controllerId, [
    { ...page, document: "795239cc-8ff9-49cb-9894-e16b3ba86af9" },
  ]);
  await assert.rejects(documentWait, /closed or navigated/);
  broker.poll(owner.sessionId, owner.controllerId, [page]);
  const turnWait = broker.execute({ operation: "observe", root: page.id });
  const pending = broker.poll(owner.sessionId, owner.controllerId, [page])!;
  active = { ...owner, epoch: 2 };
  broker.reconcile();
  await assert.rejects(turnWait, /turn or Session changed/);
  assert.equal(
    broker.result(
      owner.sessionId,
      owner.controllerId,
      pending.requestId,
      observed,
    ),
    false,
  );
  const timeout = broker.execute({ operation: "observe", root: page.id });
  t.mock.timers.tick(101);
  await assert.rejects(timeout, /timed out.*uncertain/);
  const shutdown = broker.execute({ operation: "observe", root: page.id });
  broker.close();
  await assert.rejects(shutdown, /closed/);
});
