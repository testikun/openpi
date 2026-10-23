import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { chromium, expect, test } from "@playwright/test";
import {
  registerWebBrowserBridge,
  type BrowserRequest,
} from "../../extensions/browser/web-bridge.ts";
import { WebBrowserBroker } from "../../web/host/browser-control.ts";
import { EmbeddedComputerUse } from "../../web/host/computer-use.ts";
import { toolExecutionContext } from "../support/extension-tool-context.ts";

test("Maka's real OpenCLI engine fills and clicks a background iframe, waits, extracts, and reports unsupported controls", async ({
  baseURL,
}, info) => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "openpi-maka-browser-"));
  const fixture = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("X-Frame-Options", "DENY");
    response.end(`<!doctype html><meta charset="utf-8"><title>Maka engine fixture</title>
      <h1>Maka engine fixture</h1><div role="textbox" aria-label="Rich editor" contenteditable>Original <b>text</b></div>
      <input aria-label="Mass" type="number"><input aria-label="Text field" onkeydown="if(event.key==='Enter')document.querySelector('#enter').textContent=this.value"><output id="enter">No Enter</output><textarea aria-label="Notes"></textarea>
      <button id="menu" onpointerdown="this.dataset.trusted=String(event.isTrusted)" onclick="document.querySelector('#choice').hidden=false">Choose application</button>
      <button id="choice" hidden onclick="document.querySelector('#selected').textContent='Impact selected'">Impact</button><output id="selected">No selection</output>
      <button id="prepare" onclick="setTimeout(()=>document.querySelector('#status').textContent='Ready to review',1200)">Prepare</button><output id="status">Waiting</output>
      <label>Native select<select aria-label="Native select"><option value="">Choose</option><option value="A356">A356</option></select></label>
      <label>STEP<input type="file" aria-label="STEP" accept=".stp"></label>`);
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const address = fixture.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture port");
  const target = `http://localhost:${address.port}/`;
  const preferences = join(getAgentDir(), "my-pi-setup.json");
  const previous = await readFile(preferences).catch(() => undefined);
  await writeFile(
    preferences,
    JSON.stringify({
      browser: { control: true, embedded: true, defaultBrowser: "embedded" },
    }),
  );
  const settingsManager = SettingsManager.inMemory({
    packages: [join(process.cwd(), "experiments/maka-browser")],
  });
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: getAgentDir(),
    settingsManager,
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  const manager = SessionManager.inMemory(directory);
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: getAgentDir(),
    settingsManager,
    resourceLoader: loader,
    sessionManager: manager,
  });
  await session.bindExtensions({ mode: "print" });
  for (const name of [
    "browser_navigate",
    "browser_snapshot",
    "browser_click",
    "browser_type",
    "browser_wait",
    "browser_extract",
  ])
    expect(session.getActiveToolNames()).toContain(name);
  expect(session.getToolDefinition("act_ui")).toBeUndefined();
  const context = await chromium.launchPersistentContext(
    join(directory, "chrome"),
    {
      baseURL,
      locale: "zh-CN",
      viewport: null,
      channel: "chromium",
      executablePath: process.env.OPENPI_WEB_BROWSER_EXECUTABLE,
      ignoreDefaultArgs: ["--disable-extensions"],
      args: ["--enable-unsafe-extension-debugging", "--window-size=1440,1000"],
    },
  );
  const page = context.pages()[0]!;
  const owner = {
    workspace: directory,
    sessionId: manager.getSessionId(),
    commandId: "maka-real-engine",
    controllerId: "a6b4877f-fb6b-43ec-bc88-e91090a71c43",
    epoch: 1,
  };
  const broker = new WebBrowserBroker(() => owner);
  const pages = () =>
    page.locator("iframe[data-openpi-browser-document]").evaluateAll((frames) =>
      frames.map((frame) => {
        const element = frame as HTMLIFrameElement;
        return {
          id: element.dataset.openpiBrowserPage!,
          document: element.dataset.openpiBrowserDocument!,
          url: element.dataset.openpiBrowserUrl!,
          title: element.dataset.openpiBrowserTitle || "",
        };
      }),
    );
  const transport = async (request: BrowserRequest, signal?: AbortSignal) => {
    broker.poll(owner.sessionId, owner.controllerId, await pages());
    const running = broker.execute(request, signal);
    const pending = broker.poll(
      owner.sessionId,
      owner.controllerId,
      await pages(),
    );
    if (pending && "request" in pending && pending.page) {
      const result = await page.evaluate(
        ({ pending }) =>
          new Promise<{ result?: unknown; error?: string }>(
            (resolve, reject) => {
              const timer = setTimeout(() => {
                window.removeEventListener("message", receive);
                reject(new Error("Extension timeout"));
              }, 15_000);
              const receive = (event: MessageEvent) => {
                if (
                  event.source !== window ||
                  event.origin !== location.origin ||
                  event.data?.source !== "openpi-browser-extension" ||
                  event.data.requestId !== pending.requestId
                )
                  return;
                clearTimeout(timer);
                window.removeEventListener("message", receive);
                resolve(event.data);
              };
              window.addEventListener("message", receive);
              window.postMessage(
                {
                  source: "openpi-browser-ui",
                  type: "control",
                  id: pending.page!.id,
                  document: pending.page!.document,
                  requestId: pending.requestId,
                  request: pending.request,
                },
                location.origin,
              );
            },
          ),
        { pending },
      );
      broker.poll(owner.sessionId, owner.controllerId, await pages());
      broker.result(
        owner.sessionId,
        owner.controllerId,
        pending.requestId,
        result.result,
        result.error,
      );
    }
    return running;
  };
  const backend = new EmbeddedComputerUse(transport, () => owner);
  const unregister = registerWebBrowserBridge(manager, (request, signal) =>
    backend.execute(request, signal),
  );
  const toolContext = toolExecutionContext(
    session.createReplacedSessionContext(),
  );
  const run = (name: string, args: Record<string, unknown>) => {
    const tool = session.getToolDefinition(name);
    if (!tool) throw new Error(`Missing ${name}`);
    return tool.execute(
      `maka-${name}`,
      args,
      undefined,
      undefined,
      toolContext,
    );
  };
  let typingDone = false;
  let typing: Promise<void> | undefined;
  try {
    await (await context.browser()!.newBrowserCDPSession()).send(
      "Extensions.loadUnpacked",
      {
        path:
          process.env.OPENPI_MAKA_EXTENSION_PATH ||
          join(process.cwd(), "web/browser-extension"),
      },
    );
    await page.goto("/");
    await page.getByRole("button", { name: "打开工具", exact: true }).click();
    await page.getByRole("menuitem", { name: /^浏览器/ }).click();
    const active = page.locator(".browser-page:not([hidden])");
    await active.getByRole("textbox", { name: "浏览器地址" }).fill(target);
    await active.locator("button[type=submit]").click();
    const frame = active.frameLocator("iframe");
    await expect(
      frame.getByRole("heading", { name: "Maka engine fixture" }),
    ).toBeVisible();
    const other = await context.newPage();
    await other.setContent('<input aria-label="Human input">');
    await other.bringToFront();
    await other.getByRole("textbox").focus();
    const worker = context.serviceWorkers()[0]!;
    const activeTabs = () =>
      worker.evaluate(
        "(async()=>{const tabs=await chrome.tabs.query({active:true});return tabs.map(t=>({id:t.id,windowId:t.windowId}));})()",
      );
    const before = await activeTabs();
    let human = "";
    typing = (async () => {
      let i = 0;
      do {
        const chunk = `human-${i++}|`;
        human += chunk;
        await other.keyboard.type(chunk, { delay: 2 });
      } while (!typingDone);
    })();
    await run("browser_navigate", { url: target });
    const snapshot = await run("browser_snapshot", {});
    expect(
      snapshot.content.some(
        (part) => part.type === "text" && part.text.includes("Rich editor"),
      ),
    ).toBe(true);
    await run("browser_type", {
      ref: '[aria-label="Rich editor"]',
      text: "冲击高度230 mm，质量575 kg。",
    });
    await expect(
      run("browser_type", { ref: '[aria-label="Mass"]', text: "575" }),
    ).rejects.toThrow(/not a fillable/);
    await run("browser_type", {
      ref: '[aria-label="Text field"]',
      text: "575",
      submit: true,
    });
    await expect(frame.locator("#enter")).toHaveText("575");
    await run("browser_type", {
      ref: '[aria-label="Notes"]',
      text: "Line 1\n第二行",
    });
    await run("browser_click", { ref: "#menu" });
    await run("browser_click", { ref: "#choice" });
    await expect(frame.locator("#selected")).toHaveText("Impact selected");
    await expect(frame.locator("#menu")).toHaveAttribute(
      "data-trusted",
      "true",
    );
    await run("browser_click", { ref: "#prepare" });
    await run("browser_wait", { text: "Ready to review", timeout: 3 });
    expect(await frame.locator("#status").textContent()).toBe(
      "Ready to review",
    );
    const extraction = await run("browser_extract", { selector: "body" });
    expect(
      extraction.content.some(
        (part) => part.type === "text" && part.text.includes("Ready to review"),
      ),
    ).toBe(true);
    await expect(
      frame.getByRole("textbox", { name: "Rich editor" }),
    ).toHaveText("冲击高度230 mm，质量575 kg。");
    await expect(frame.getByRole("spinbutton", { name: "Mass" })).toHaveValue(
      "",
    );
    await expect(frame.getByRole("textbox", { name: "Notes" })).toHaveValue(
      "Line 1\n第二行",
    );
    await expect(
      run("browser_type", { ref: "select", text: "A356" }),
    ).rejects.toThrow(/not a fillable/);
    await expect(
      run("browser_type", {
        ref: "input[type=file]",
        text: "/tmp/no-upload.stp",
      }),
    ).rejects.toThrow(/not a fillable/);
    typingDone = true;
    await run("browser_navigate", { url: target });
    await expect(run("browser_click", { ref: "[1]" })).rejects.toThrow(
      /require browser_snapshot/,
    );
    await typing;
    expect(await other.getByRole("textbox").inputValue()).toBe(human);
    await expect(other.getByRole("textbox")).toBeFocused();
    expect(await activeTabs()).toEqual(before);
    await writeFile(
      info.outputPath("maka-engine-receipt.json"),
      JSON.stringify(
        {
          target,
          humanExpected: human,
          humanActual: await other.getByRole("textbox").inputValue(),
          activeBefore: before,
          activeAfter: await activeTabs(),
          screenshotPointerTrusted: true,
          nativeSelectSupported: false,
          numericInputSupported: false,
          fileUploadSupported: false,
        },
        null,
        2,
      ),
    );
  } finally {
    typingDone = true;
    await typing?.catch(() => {});
    unregister();
    broker.dispose();
    session.dispose();
    await context.close();
    await new Promise<void>((resolve, reject) =>
      fixture.close((error) => (error ? reject(error) : resolve())),
    );
    if (previous) await writeFile(preferences, previous);
    else await rm(preferences, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
});
