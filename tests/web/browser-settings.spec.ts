// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BrowserSettingsStatus } from "../../web/protocol/browser.ts";
import { BrowserSettingsPanel } from "../../web/ui/src/features/settings/BrowserSettingsPanel.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";

beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.spyOn(window, "open").mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.openpiBrowserBridgeVersion;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function backend(
  options: {
    native?: boolean;
    loaded?: boolean;
    failSetup?: boolean;
    failActions?: boolean;
  } = {},
) {
  const writes: { path: string; body: unknown }[] = [];
  const requests: string[] = [];
  const state: BrowserSettingsStatus = {
    config: {
      control: false,
      embedded: true,
      defaultBrowser: options.native ? "chrome" : "embedded",
      externalBrowsers: [],
    },
    extensionPath: "/bundled/browser-extension",
    extensionVersion: "0.5.0",
    computerUse: {
      loaded: Boolean(options.loaded),
      ...(options.loaded ? { version: "0.5.1" } : {}),
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        writes.push({ path, body: JSON.parse(String(init.body)) });
        if (options.failActions)
          return new Response(
            JSON.stringify({ error: "Could not open browser" }),
            { status: 422 },
          );
      }
      return new Response(JSON.stringify(state));
    }),
  );
  render(
    createElement(BrowserSettingsPanel, {
      onConfigure: async (request: string) => {
        requests.push(request);
        return !options.failSetup;
      },
    }),
  );
  return { state, writes, requests };
}

it("reviews original package installation without claiming that it is already loaded", async () => {
  const server = backend();
  fireEvent.click(
    await screen.findByRole("button", { name: "Install or enable plugin…" }),
  );
  await waitFor(() => expect(server.requests).toHaveLength(1));
  expect(server.requests[0]).toContain("npm:@injaneity/pi-computer-use@0.5.1");
  expect(server.requests[0]).toContain("do not reload automatically");
  expect(server.writes).toEqual([]);
  expect(
    screen.getByText("Original plugin not loaded in this Session"),
  ).toBeTruthy();
});

it("saves embedded permission through setup and leaves the switch unchanged until persistence", async () => {
  const server = backend();
  const control = await screen.findByRole("switch", {
    name: "Allow embedded page control",
  });
  fireEvent.click(control);
  await waitFor(() => expect(server.requests).toHaveLength(1));
  expect(server.requests[0]).toContain('"control":true');
  expect(server.requests[0]).toContain('"embedded":true');
  expect((control as HTMLInputElement).checked).toBe(false);
  expect(server.writes).toEqual([]);
});

it("native mode uses the original plugin and exposes no external Browser Bridge pairing", async () => {
  const server = backend({ native: true, loaded: true });
  await screen.findByText(/Original plugin loaded in this Session/u);
  expect(screen.getByText(/system mouse and keyboard/)).toBeTruthy();
  expect(screen.queryByRole("switch")).toBeNull();
  expect(screen.queryByText("OpenPI Browser Bridge")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Disable plugin…" }));
  await waitFor(() =>
    expect(server.requests[0]).toContain("computer_use_action=disable"),
  );
  expect(server.writes).toEqual([]);
});

it("choosing native mode requests setup without granting desktop permissions or mutating browser settings directly", async () => {
  const server = backend();
  fireEvent.change(
    await screen.findByRole("combobox", { name: "Operate in" }),
    { target: { value: "native" } },
  );
  await waitFor(() =>
    expect(server.requests[0]).toContain('"defaultBrowser":"chrome"'),
  );
  expect(server.requests[0]).toContain(
    "do not install or reload packages automatically",
  );
  expect(server.state.config.defaultBrowser).toBe("embedded");
  expect(server.writes).toEqual([]);
});

it("the embedded extension guide opens only requested native helpers and never opens a new OpenPI tab to connect", async () => {
  const server = backend();
  fireEvent.click(
    await screen.findByRole("button", { name: "Set up OpenPI browser" }),
  );
  const guide = screen.getByRole("region", { name: "Connect OpenPI browser" });
  fireEvent.click(
    within(guide).getByRole("button", { name: "Open Chrome extensions" }),
  );
  await waitFor(() =>
    expect(server.writes).toEqual([
      {
        path: "/api/settings/browser/action",
        body: { browser: "chrome", action: "manage" },
      },
    ]),
  );
  fireEvent.click(
    await within(guide).findByRole("button", { name: "It’s on. Next" }),
  );
  fireEvent.click(
    await within(guide).findByRole("button", { name: "Locate extension" }),
  );
  await waitFor(() =>
    expect(server.writes.at(-1)?.body).toEqual({
      browser: "chrome",
      action: "folder",
    }),
  );
  fireEvent.click(
    within(guide).getByRole("button", { name: "Added. Connect to OpenPI" }),
  );
  expect(
    await within(guide).findByRole("button", { name: "Reload" }),
  ).toBeTruthy();
  expect(server.writes).toHaveLength(2);
  expect(server.requests).toEqual([]);
});

it("bridge readiness requires the current extension and does not imply plugin loading or permission", async () => {
  document.documentElement.dataset.openpiBrowserBridgeVersion = "0.4.0";
  backend();
  await screen.findByText("Extension update needed");
  document.documentElement.dataset.openpiBrowserBridgeVersion = "0.5.0";
  await screen.findByText("Embedded bridge ready");
  expect(
    screen.getByText("Original plugin not loaded in this Session"),
  ).toBeTruthy();
  expect((screen.getByRole("switch") as HTMLInputElement).checked).toBe(false);
});

it("failed setup preserves configuration and blocked guide popups keep the inline guide usable", async () => {
  const server = backend({ failSetup: true });
  fireEvent.click(
    await screen.findByRole("switch", { name: "Allow embedded page control" }),
  );
  await screen.findByRole("alert");
  expect(server.state.config.control).toBe(false);
  fireEvent.click(
    screen.getByRole("button", { name: "Set up OpenPI browser" }),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "Keep this guide in a separate window",
    }),
  );
  expect(
    screen.getByRole("region", { name: "Connect OpenPI browser" }),
  ).toBeTruthy();
  expect(server.writes).toEqual([]);
});
