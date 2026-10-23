import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { BrowserSettingsStatus } from "../../web/protocol/browser.ts";
import { installThinkingFixture } from "./thinking-e2e-support.ts";

const fixture = (): BrowserSettingsStatus => ({
  config: {
    control: false,
    embedded: true,
    defaultBrowser: "embedded",
    externalBrowsers: [],
  },
  extensionPath: "/Applications/OpenPI/browser-extension/",
  extensionVersion: "0.5.0",
  computerUse: { loaded: false },
});

test("original plugin and embedded guide remain usable on desktop and narrow settings", async ({
  page,
}, info) => {
  await installThinkingFixture(page);
  await page.route("**/api/settings/browser", (route) =>
    route.fulfill({ json: fixture() }),
  );
  for (const width of [1147, 390]) {
    await page.setViewportSize({ width, height: 640 });
    await page.goto("/?settings=browser");
    const dialog = page.getByRole("dialog", { name: "设置", exact: true });
    const panel = dialog.locator("#settings-panel-browser");
    await expect(
      panel.getByText("本会话尚未加载原版插件", { exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "安装或启用插件…", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: info.outputPath(`single-plugin-overview-${width}.png`),
    });
    await panel
      .getByRole("button", { name: "设置 OpenPI 内置浏览器", exact: true })
      .click();
    const guide = panel.getByRole("region", {
      name: "连接 OpenPI 内置浏览器",
      exact: true,
    });
    await guide
      .getByRole("button", { name: "第 3 步：添加扩展", exact: true })
      .click();
    await guide
      .getByRole("button", { name: "已添加，连接 OpenPI", exact: true })
      .scrollIntoViewIfNeeded();
    await expect(
      guide.getByRole("button", { name: "已添加，连接 OpenPI", exact: true }),
    ).toBeInViewport();
    expect(
      await panel.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true);
    const audit = await new AxeBuilder({ page })
      .include("#settings-panel-browser")
      .analyze();
    expect(
      audit.violations.filter((violation) =>
        ["critical", "serious"].includes(violation.impact || ""),
      ),
    ).toEqual([]);
    await page.screenshot({
      path: info.outputPath(`single-plugin-settings-${width}.png`),
    });
  }
});

test("separate guide shares bridge readiness and closes with its owning settings", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, "documentPictureInPicture", {
      value: undefined,
    }),
  );
  await installThinkingFixture(page);
  await page.route("**/api/settings/browser", (route) =>
    route.fulfill({ json: fixture() }),
  );
  await page.goto("/?settings=browser");
  await page
    .getByRole("button", { name: "设置 OpenPI 内置浏览器", exact: true })
    .click();
  const opened = page.waitForEvent("popup");
  await page
    .getByRole("button", { name: "在独立窗口中跟随操作", exact: true })
    .click();
  const guide = await opened;
  await expect(
    guide.getByRole("region", { name: "连接 OpenPI 内置浏览器", exact: true }),
  ).toBeVisible();
  // This is a labelled presentation fixture, not native installation evidence.
  await page.evaluate(() => {
    document.documentElement.dataset.openpiBrowserBridgeVersion = "0.5.0";
  });
  await expect(
    guide.getByText("内置页面桥接已就绪", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("本会话尚未加载原版插件", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog", { name: "设置", exact: true })
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await expect.poll(() => guide.isClosed()).toBe(true);
});
