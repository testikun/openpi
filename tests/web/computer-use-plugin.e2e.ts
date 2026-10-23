import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test } from "@playwright/test";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  registerWebBrowserBridge,
  type BrowserRequest,
  type ComputerUseRequest,
} from "../../extensions/browser/web-bridge.ts";
import { adaptComputerUseExtensions } from "../../web/runtime/computer-use.ts";
import { WebBrowserBroker } from "../../web/host/browser-control.ts";
import { EmbeddedComputerUse } from "../../web/host/computer-use.ts";
import { toolExecutionContext } from "../support/extension-tool-context.ts";

test("original Pi tools operate rich text, files and keyboard in exact embedded documents while another tab stays active", async ({
  baseURL,
}) => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), "openpi-original-browser-"));
  const bytes = Buffer.from(
    "ISO-10303-21;\n中文 STEP fixture\nEND-ISO-10303-21;\n",
  );
  const digest = createHash("sha256").update(bytes).digest("hex");
  const path = join(directory, "模型 1.stp");
  await writeFile(path, bytes);
  const uploads: Buffer[] = [];
  const fixture = createServer(async (request, response) => {
    if (request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      uploads.push(body);
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          size: body.length,
          sha256: createHash("sha256").update(body).digest("hex"),
        }),
      );
      return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("X-Frame-Options", "DENY");
    response.end(`<!doctype html><title>Original tool fixture</title>
      <h1>Embedded integration fixture</h1>
      <div contenteditable role="textbox" aria-label="Rich editor"><p>Original <b>formatted</b> text</p></div>
      <input aria-label="Keyboard editor"><output id="keys">No key</output>
      <input hidden type="file" aria-label="STEP attachment" accept=".stp">
      <button id="upload">Upload selected file</button><output id="receipt">No upload</output>
      <button id="pointer" onpointerdown="this.dataset.pressed='yes'">Pointer target</button>
      <script>
        document.querySelector('[contenteditable]').addEventListener('input',e=>e.currentTarget.dataset.edited='yes');
        document.querySelector('input[aria-label="Keyboard editor"]').addEventListener('keydown',e=>{if(e.key==='Enter')document.querySelector('#keys').textContent=e.currentTarget.value});
        document.querySelector('#upload').onclick=async()=>{const file=document.querySelector('input[type=file]').files[0];if(!file)return;const response=await fetch('/upload',{method:'POST',body:file});const receipt=await response.json();document.querySelector('#receipt').textContent='Received '+receipt.size+' '+receipt.sha256};
      </script>`);
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const address = fixture.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture port");
  const settingsPath = join(getAgentDir(), "my-pi-setup.json");
  const previous = await readFile(settingsPath).catch(() => undefined);
  await writeFile(
    settingsPath,
    JSON.stringify({
      browser: { control: true, embedded: true, defaultBrowser: "embedded" },
    }),
  );
  const plugin = dirname(
    fileURLToPath(
      import.meta.resolve("@injaneity/pi-computer-use/package.json"),
    ),
  );
  const settingsManager = SettingsManager.inMemory({ packages: [plugin] });
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: getAgentDir(),
    settingsManager,
    extensionsOverride: adaptComputerUseExtensions,
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
  const context = await chromium.launchPersistentContext(
    join(directory, "chrome"),
    {
      baseURL,
      locale: "zh-CN",
      viewport: null,
      channel: "chromium",
      executablePath: process.env.OPENPI_WEB_BROWSER_EXECUTABLE,
      ignoreDefaultArgs: ["--disable-extensions"],
      args: ["--enable-unsafe-extension-debugging", "--window-size=1440,900"],
    },
  );
  const owner = {
    workspace: directory,
    sessionId: manager.getSessionId(),
    commandId: "original-plugin-fixture",
    controllerId: "a6b4877f-fb6b-43ec-bc88-e91090a71c43",
    epoch: 1,
  };
  const broker = new WebBrowserBroker(() => owner);
  const page = context.pages()[0]!;
  const livePages = async () =>
    page.locator("iframe[data-openpi-browser-document]").evaluateAll((frames) =>
      frames.map((frame) => {
        const value = frame as HTMLIFrameElement;
        return {
          id: value.dataset.openpiBrowserPage!,
          document: value.dataset.openpiBrowserDocument!,
          url: value.dataset.openpiBrowserUrl!,
          title: value.dataset.openpiBrowserTitle || "",
        };
      }),
    );
  const transport = async (request: BrowserRequest, signal?: AbortSignal) => {
    let pages = await livePages();
    broker.poll(owner.sessionId, owner.controllerId, pages);
    const result = broker.execute(request, signal);
    const pending = broker.poll(owner.sessionId, owner.controllerId, pages);
    if (pending && "request" in pending && pending.page) {
      const response = await page.evaluate(
        ({ pending }) =>
          new Promise<{ result?: unknown; error?: string }>(
            (resolve, reject) => {
              const timer = setTimeout(() => {
                window.removeEventListener("message", receive);
                reject(new Error("Extension timed out"));
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
      pages = await livePages();
      broker.poll(owner.sessionId, owner.controllerId, pages);
      broker.result(
        owner.sessionId,
        owner.controllerId,
        pending.requestId,
        response.result,
        response.error,
      );
    }
    return result;
  };
  const backend = new EmbeddedComputerUse(transport, () => owner);
  const unregister = registerWebBrowserBridge(manager, (request, signal) =>
    backend.execute(request, signal),
  );
  const toolContext = toolExecutionContext(
    session.createReplacedSessionContext(),
  );
  const run = async (
    tool: ComputerUseRequest["tool"],
    params: Record<string, unknown>,
  ) => {
    const definition = session.getToolDefinition(tool);
    if (!definition) throw new Error(`Original tool ${tool} was not loaded`);
    return definition.execute(
      `fixture-${tool}`,
      params,
      undefined,
      undefined,
      toolContext,
    );
  };
  const stateOf = (result: Awaited<ReturnType<typeof run>>) => {
    const details = result.details as {
      stateId: string;
      nodes: { ref: string; role: string; name: string }[];
    };
    return details;
  };
  try {
    const cdp = await context.browser()!.newBrowserCDPSession();
    await cdp.send("Extensions.loadUnpacked", {
      path: join(process.cwd(), "web/browser-extension"),
    });
    await page.goto("/");
    await page.getByRole("button", { name: "打开工具", exact: true }).click();
    await page.getByRole("menuitem", { name: /^浏览器/ }).click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-openpi-browser-extension",
      "ready",
    );
    const active = page.locator(".browser-page:not([hidden])");
    for (const host of ["127.0.0.1", "localhost"]) {
      await active
        .getByRole("textbox", { name: "浏览器地址" })
        .fill(`http://${host}:${address.port}/`);
      await active.locator("button[type=submit]").click();
      await expect(
        active
          .frameLocator("iframe")
          .getByRole("textbox", { name: "Rich editor" }),
      ).toBeVisible();
      await expect(
        active.locator("iframe[data-openpi-browser-document]"),
      ).toHaveCount(1);
      const found = await run("find_roots", { kind: "browser_page" });
      const root = (found.details as { windows: { windowRef: string }[] })
        .windows[0]!.windowRef;
      let state = stateOf(await run("observe_ui", { root, mode: "semantic" }));
      const rich = state.nodes.find((node) => node.name === "Rich editor")!;
      expect(rich).toBeTruthy();
      const other = await context.newPage();
      await other.setContent(
        '<input aria-label="Human editor" value="Human input stays here">',
      );
      await other.bringToFront();
      await other.getByRole("textbox").focus();
      const worker = context.serviceWorkers()[0]!;
      const activeTabs = () =>
        worker.evaluate(
          "(async()=>{const tabs=await chrome.tabs.query({active:true});return tabs.map(tab=>({id:tab.id,windowId:tab.windowId}));})()",
        ) as Promise<{ id: number; windowId: number }[]>;
      const beforeActive = await activeTabs();
      expect(beforeActive).toHaveLength(1);
      const mixed = "冲击高度230 mm，质量575 kg，材料A356。";
      state = stateOf(
        await run("act_ui", {
          stateId: state.stateId,
          actions: [{ action: "setText", ref: rich.ref, text: mixed }],
        }),
      );
      await expect(
        active
          .frameLocator("iframe")
          .getByRole("textbox", { name: "Rich editor" }),
      ).toHaveText(mixed);
      await expect(
        active
          .frameLocator("iframe")
          .getByRole("textbox", { name: "Rich editor" }),
      ).toHaveAttribute("data-edited", "yes");
      await expect(other.getByRole("textbox")).toHaveValue(
        "Human input stays here",
      );
      expect(await activeTabs()).toEqual(beforeActive);
      const search = await run("search_ui", {
        stateId: state.stateId,
        role: "file_input",
      });
      const file = (search.details as { matches: { ref: string }[] })
        .matches[0]!;
      expect(file).toBeTruthy();
      state = stateOf(
        await run("act_ui", {
          stateId: state.stateId,
          actions: [{ action: "setText", ref: file.ref, text: path }],
        }),
      );
      const selected = await active
        .frameLocator("iframe")
        .locator("input[type=file]")
        .evaluate((input) =>
          [...(input as HTMLInputElement).files!].map((file) => ({
            name: file.name,
            size: file.size,
          })),
        );
      expect(selected).toEqual([{ name: "模型 1.stp", size: bytes.length }]);
      const upload = state.nodes.find(
        (node) => node.name === "Upload selected file",
      )!;
      state = stateOf(
        await run("act_ui", {
          stateId: state.stateId,
          actions: [{ action: "press", ref: upload.ref }],
          expect: {
            text: `Received ${bytes.length} ${digest}`,
            timeoutMs: 5000,
          },
        }),
      );
      await expect(
        active.frameLocator("iframe").locator("#receipt"),
      ).toHaveText(`Received ${bytes.length} ${digest}`);
      expect(uploads.at(-1)).toEqual(bytes);
      const keyboard = state.nodes.find(
        (node) => node.name === "Keyboard editor",
      )!;
      state = stateOf(
        await run("act_ui", {
          stateId: state.stateId,
          actions: [
            { action: "press", ref: keyboard.ref },
            { action: "typeText", text: "OpenPI-中文-230mm" },
            { action: "keypress", keys: ["Enter"] },
          ],
          expect: { text: "OpenPI-中文-230mm", timeoutMs: 1000 },
        }),
      );
      await expect(active.frameLocator("iframe").locator("#keys")).toHaveText(
        "OpenPI-中文-230mm",
      );
      const visual = await run("observe_ui", { root, mode: "visual" });
      const capture = (
        visual.details as {
          capture: { width: number; height: number; coordinateSpace: string };
        }
      ).capture;
      expect(capture.coordinateSpace).toBe("frame-relative-screenshot-pixels");
      expect(visual.content.some((content) => content.type === "image")).toBe(
        true,
      );
      const frameBox = await active.locator("iframe").boundingBox();
      const pointer = active.frameLocator("iframe").locator("#pointer");
      const targetBox = await pointer.boundingBox();
      if (!frameBox || !targetBox)
        throw new Error("Missing visible pointer geometry");
      const x =
        ((targetBox.x - frameBox.x + targetBox.width / 2) * capture.width) /
        frameBox.width;
      const y =
        ((targetBox.y - frameBox.y + targetBox.height / 2) * capture.height) /
        frameBox.height;
      state = stateOf(
        await run("act_ui", {
          stateId: stateOf(visual).stateId,
          actions: [
            { action: "moveMouse", x, y },
            { action: "click", x, y },
          ],
        }),
      );
      await expect(pointer).toHaveAttribute("data-pressed", "yes");
      const evaluated = await run("evaluate_browser", {
        stateId: state.stateId,
        expression: "document.querySelector('#pointer').dataset.pressed",
      });
      expect((evaluated.details as { evaluation: unknown }).evaluation).toBe(
        "yes",
      );
      await expect(other.getByRole("textbox")).toHaveValue(
        "Human input stays here",
      );
      expect(await activeTabs()).toEqual(beforeActive);
      await other.close();
      await page.bringToFront();
    }
    expect(uploads).toHaveLength(2);
  } finally {
    unregister();
    broker.dispose();
    session.dispose();
    await context.close();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    if (previous) await writeFile(settingsPath, previous);
    else await rm(settingsPath, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
});
