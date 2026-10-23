import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import { configureComputerUsePackage } from "../../../extensions/setup/computer-use-package.ts";
import { COMPUTER_USE_PACKAGE } from "../../../extensions/shared/computer-use.ts";

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "openpi-original-package-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const agentDir = join(directory, "agent");
  await mkdir(agentDir);
  const path = join(agentDir, "settings.json");
  const before = `${JSON.stringify({ packages: ["npm:unrelated-fixed@1.0.0"], defaultThinkingLevel: "high" }, null, 2)}\n`;
  await writeFile(path, before);
  const preferences = join(agentDir, "extensions", "pi-computer-use.json");
  return { cwd: directory, agentDir, path, before, preferences };
}

test("declining the native review preserves settings and creates no preferences or installation", async (t) => {
  const f = await fixture(t);
  let installed = false;
  t.mock.method(DefaultPackageManager.prototype, "install", async () => {
    installed = true;
  });
  await assert.rejects(
    configureComputerUsePackage({
      ...f,
      action: "install",
      confirm: async (_title, detail) => {
        assert.ok(detail.includes(COMPUTER_USE_PACKAGE.source));
        assert.match(detail, /system mouse and keyboard/u);
        assert.match(detail, /No credentials are copied/u);
        return false;
      },
    }),
    /cancelled/u,
  );
  assert.equal(installed, false);
  assert.equal(await readFile(f.path, "utf8"), f.before);
  await assert.rejects(readFile(f.preferences), { code: "ENOENT" });
});

test("reviewed installation uses native Pi persistence, preserves existing preferences, and disabling never reloads", async (t) => {
  const f = await fixture(t);
  const sources: string[] = [];
  const installedPath = join(f.cwd, "reported-package");
  const originalPath = DefaultPackageManager.prototype.getInstalledPath;
  t.mock.method(
    DefaultPackageManager.prototype,
    "getInstalledPath",
    function (
      this: DefaultPackageManager,
      source: string,
      scope: "user" | "project",
    ) {
      return source === COMPUTER_USE_PACKAGE.source
        ? installedPath
        : originalPath.call(this, source, scope);
    },
  );
  t.mock.method(
    DefaultPackageManager.prototype,
    "install",
    async function (this: DefaultPackageManager, source: string) {
      sources.push(source);
      const directory = this.getInstalledPath(source, "user");
      assert.ok(directory);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({
          name: COMPUTER_USE_PACKAGE.name,
          version: COMPUTER_USE_PACKAGE.version,
        }),
      );
    },
  );
  const result = await configureComputerUsePackage({
    ...f,
    action: "install",
    confirm: async () => true,
  });
  assert.match(result, /Current Session loading is unchanged/u);
  assert.deepEqual(sources, [COMPUTER_USE_PACKAGE.source]);
  assert.deepEqual(JSON.parse(await readFile(f.preferences, "utf8")), {
    browser_use: true,
    headless: false,
    cursor_overlay: true,
    managed_browser: "chrome",
  });
  if (process.platform !== "win32")
    assert.equal((await stat(f.preferences)).mode & 0o777, 0o600);
  const preferences =
    '{\n  "computer_use": {"headless": true}, "custom": "preserved"\n}\n';
  await writeFile(f.preferences, preferences);
  await configureComputerUsePackage({
    ...f,
    action: "install",
    confirm: async () => true,
  });
  assert.equal(await readFile(f.preferences, "utf8"), preferences);
  const enabled = JSON.parse(await readFile(f.path, "utf8"));
  assert.equal(enabled.defaultThinkingLevel, "high");
  assert.deepEqual(enabled.packages, [
    "npm:unrelated-fixed@1.0.0",
    {
      source: COMPUTER_USE_PACKAGE.source,
      extensions: ["**/*"],
      skills: [],
      prompts: [],
      themes: [],
    },
  ]);
  const count = sources.length;
  await configureComputerUsePackage({
    ...f,
    action: "disable",
    confirm: async () => true,
  });
  assert.equal(sources.length, count);
  assert.equal(await readFile(f.preferences, "utf8"), preferences);
  const disabled = JSON.parse(await readFile(f.path, "utf8"));
  assert.deepEqual(disabled.packages[1].extensions, []);
});

test("mismatched installed identity cannot activate and preserves prior preferences and settings", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.agentDir, "extensions"));
  const preferences = '{"headless":true}\n';
  await writeFile(f.preferences, preferences);
  const installedPath = join(f.cwd, "reported-package");
  const originalPath = DefaultPackageManager.prototype.getInstalledPath;
  t.mock.method(
    DefaultPackageManager.prototype,
    "getInstalledPath",
    function (
      this: DefaultPackageManager,
      source: string,
      scope: "user" | "project",
    ) {
      return source === COMPUTER_USE_PACKAGE.source
        ? installedPath
        : originalPath.call(this, source, scope);
    },
  );
  t.mock.method(
    DefaultPackageManager.prototype,
    "install",
    async function (this: DefaultPackageManager, source: string) {
      const directory = this.getInstalledPath(source, "user");
      assert.ok(directory);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({ name: COMPUTER_USE_PACKAGE.name, version: "99.0.0" }),
      );
    },
  );
  await assert.rejects(
    configureComputerUsePackage({
      ...f,
      action: "install",
      confirm: async () => true,
    }),
    /identity did not match/u,
  );
  assert.equal(await readFile(f.path, "utf8"), f.before);
  assert.equal(await readFile(f.preferences, "utf8"), preferences);
});

test("a different configured package version requires review instead of being silently replaced", async (t) => {
  const f = await fixture(t);
  const before = JSON.stringify({
    packages: ["npm:@injaneity/pi-computer-use@0.4.0"],
  });
  await writeFile(f.path, before);
  let reviewed = false;
  await assert.rejects(
    configureComputerUsePackage({
      ...f,
      action: "install",
      confirm: async () => {
        reviewed = true;
        return true;
      },
    }),
    /Another pi-computer-use source/u,
  );
  assert.equal(reviewed, false);
  assert.equal(await readFile(f.path, "utf8"), before);
});
