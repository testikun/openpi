import { execFile, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ExternalBrowser } from "../../extensions/shared/browser-config.ts";
import { BROWSER_BRIDGE_VERSION } from "../protocol/browser.ts";

const exec = promisify(execFile);
export const BROWSER_EXTENSION_VERSION = BROWSER_BRIDGE_VERSION;
export const browserExtensionPath = fileURLToPath(new URL("../browser-extension/", import.meta.url));
const applications = {
  chrome: { mac: "Google Chrome", win: "Google/Chrome/Application/chrome.exe", linux: "google-chrome" },
  edge: { mac: "Microsoft Edge", win: "Microsoft/Edge/Application/msedge.exe", linux: "microsoft-edge" },
  brave: { mac: "Brave Browser", win: "BraveSoftware/Brave-Browser/Application/brave.exe", linux: "brave-browser" },
  chromium: { mac: "Chromium", win: "Chromium/Application/chrome.exe", linux: "chromium" },
} as const;

async function application(browser: keyof typeof applications) {
  const info = applications[browser];
  if (process.platform === "linux") {
    try { return (await exec("which", [info.linux], { timeout: 1000 })).stdout.trim() || undefined; }
    catch { return undefined; }
  }
  const candidates = process.platform === "darwin"
    ? [`/Applications/${info.mac}.app`, join(process.env.HOME || "", "Applications", `${info.mac}.app`)]
    : [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter((base): base is string => Boolean(base)).map((base) => join(base, info.win));
  for (const path of candidates) {
    try { await access(path); return path; } catch { /* Try the next standard installation. */ }
  }
  return undefined;
}

/** Explicit UI actions only. A launch receipt is never installation or permission evidence. */
export async function browserSetupAction(browser: ExternalBrowser, action: "folder" | "manage") {
  if (browser === "safari" || browser === "firefox") throw new Error("Embedded Browser Bridge requires Chromium. Other browsers use the original Pi package directly.");
  if (action === "folder") {
    // Reveal the install target itself, rather than opening its JavaScript files.
    const folder = browserExtensionPath;
    const target = resolve(folder);
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
    const args = process.platform === "darwin" ? ["-R", target] : process.platform === "win32" ? [`/select,${target}`] : [dirname(target)];
    await exec(command, args, { timeout: 5000 });
    return { opened: true };
  }
  const app = await application(browser);
  if (!app) throw new Error("Browser not found in a standard installation location. Open OpenPI in that browser to connect it.");
  const target = `${browser === "edge" ? "edge" : browser === "brave" ? "brave" : "chrome"}://extensions/`;
  if (process.platform === "darwin") await exec("open", ["-a", app, ...(target ? [target] : [])], { timeout: 5000 });
  else {
    // Existing browser processes handle this launch. Avoid killing a newly started browser on timeout.
    const child = spawn(app, target ? [target] : [], { detached: true, stdio: "ignore" });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
  }
  return { opened: true };
}
