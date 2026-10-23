import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { MakaBrowserPage } from "../../experiments/maka-browser/page.ts";
import { registerWebBrowserBridge } from "../../extensions/browser/web-bridge.ts";
import { CHILD_EXCLUDED_TOOL_NAMES } from "../../extensions/shared/child-session.ts";

test("the optional Maka package loads six Pi-native tools without loading the original plugin", async () => {
  const cwd = fileURLToPath(new URL("../../", import.meta.url));
  const agentDir = await mkdtemp(join(tmpdir(), "openpi-maka-package-"));
  const settingsManager = SettingsManager.inMemory({
    packages: [
      fileURLToPath(new URL("../../experiments/maka-browser", import.meta.url)),
    ],
  });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const manager = SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    resourceLoader: loader,
    sessionManager: manager,
  });
  try {
    const names = [
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_wait",
      "browser_extract",
    ];
    const registered = loader
      .getExtensions()
      .extensions.flatMap((extension) => [...extension.tools.keys()]);
    assert.deepEqual(registered.sort(), [...names].sort());
    for (const name of names) {
      assert.ok(session.getToolDefinition(name));
      assert.ok(
        CHILD_EXCLUDED_TOOL_NAMES.some((excluded) => excluded === name),
      );
    }
    assert.equal(session.getToolDefinition("act_ui"), undefined);
    assert.equal(session.getToolDefinition("openpi_browser"), undefined);
  } finally {
    session.dispose();
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("Maka operations forward cancellation and reject concurrent use of one page", async () => {
  const scope = {};
  const page = new MakaBrowserPage(scope);
  const abort = new AbortController();
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  let calls = 0;
  const unregister = registerWebBrowserBridge(
    scope,
    async (_request, signal) => {
      calls++;
      assert.strictEqual(signal, abort.signal);
      began();
      await new Promise<void>((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), {
          once: true,
        });
      });
      throw new Error("Unreachable after cancellation");
    },
  );
  try {
    const running = page.run(() => page.attach(), abort.signal);
    await started;
    await assert.rejects(
      page.run(() => page.attach()),
      /Another browser operation/,
    );
    const reason = new Error("Stopped by the user");
    abort.abort(reason);
    await assert.rejects(running, (error) => error === reason);
    await assert.rejects(
      page.run(() => page.attach(), abort.signal),
      (error) => error === reason,
    );
    assert.equal(calls, 1, "an aborted operation must not dispatch again");
  } finally {
    unregister();
  }
});

test("a fixed browser wait ends when its owning tool is cancelled", {
  timeout: 2000,
}, async () => {
  const page = new MakaBrowserPage({});
  const abort = new AbortController();
  const waiting = page.run(() => page.wait(120), abort.signal);
  abort.abort();
  await assert.rejects(waiting, { name: "AbortError" });
});
