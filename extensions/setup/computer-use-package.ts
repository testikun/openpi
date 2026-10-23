import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DefaultPackageManager,
  SettingsManager,
  type PackageSource,
} from "@earendil-works/pi-coding-agent";
import {
  COMPUTER_USE_PACKAGE,
  isComputerUseSource,
  type ComputerUseAction,
} from "../shared/computer-use.ts";

const sourceOf = (entry: PackageSource) =>
  typeof entry === "string" ? entry : entry.source;

/** Reviewed native Pi package operation; never reloads a running Session. */
export async function configureComputerUsePackage(options: {
  action: ComputerUseAction;
  cwd: string;
  agentDir: string;
  confirm: (title: string, detail: string) => Promise<boolean>;
  signal?: AbortSignal;
}) {
  const { action, cwd, agentDir, signal } = options;
  const settings = SettingsManager.create(cwd, agentDir, {
    projectTrusted: false,
  });
  if (settings.drainErrors().length)
    throw new Error("Cannot read Pi settings; no package changes were made.");
  const manager = new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager: settings,
  });
  const matches = async (entries: PackageSource[]) => {
    const result: PackageSource[] = [];
    for (const entry of entries) {
      if (isComputerUseSource(sourceOf(entry))) {
        result.push(entry);
        continue;
      }
      const installed = manager.getInstalledPath(sourceOf(entry), "user");
      if (!installed) continue;
      try {
        const manifest: unknown = JSON.parse(
          await readFile(join(installed, "package.json"), "utf8"),
        );
        if (
          manifest &&
          typeof manifest === "object" &&
          "name" in manifest &&
          manifest.name === COMPUTER_USE_PACKAGE.name
        )
          result.push(entry);
      } catch {
        /* Unrelated native Pi sources remain untouched. */
      }
    }
    return result;
  };
  const existing = await matches(settings.getGlobalSettings().packages ?? []);
  if (existing.some((entry) => sourceOf(entry) !== COMPUTER_USE_PACKAGE.source))
    throw new Error(
      "Another pi-computer-use source or version is configured. Review it in Plugins first.",
    );
  if (action === "disable" && !existing.length)
    throw new Error("pi-computer-use is not configured in this Pi profile.");
  const path = join(agentDir, "extensions", "pi-computer-use.json");
  let preferencesExist = false;
  if (action === "install") {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.size > 128 * 1024)
        throw new Error("Invalid preferences file");
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid preferences object");
      preferencesExist = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(
          "Cannot safely read pi-computer-use preferences; existing files were preserved.",
        );
    }
  }
  signal?.throwIfAborted();
  const confirmed = await options.confirm(
    action === "install" ? "Enable computer use" : "Disable computer use",
    action === "install"
      ? `${COMPUTER_USE_PACKAGE.source}\n${COMPUTER_USE_PACKAGE.repository}\nThis third-party Pi package runs local code and installs native helpers. Native mode can observe desktop applications, operate browsers, upload selected local files, activate windows and use the system mouse and keyboard, subject to OS permissions. Embedded mode uses only the originating OpenPI tab's authorized iframe through Browser Bridge. ${preferencesExist ? "Existing plugin preferences are preserved byte for byte." : "Create plugin preferences with browser_use=true, headless=false, cursor_overlay=true and managed_browser=chrome after this review."} Pi saves the package in this service's own profile. No credentials are copied and no Session is automatically reloaded.`
      : "Disable the original package's resources in Pi user settings. Keep its installed files and preferences. Already loaded Sessions keep their tools until explicitly reloaded or replaced.",
  );
  if (!confirmed)
    throw new Error(
      "Computer-use setup was cancelled; no package changes were made.",
    );
  signal?.throwIfAborted();
  if (action === "install") {
    if (!preferencesExist) {
      await mkdir(join(agentDir, "extensions"), { recursive: true });
      await writeFile(
        path,
        `${JSON.stringify({ browser_use: true, headless: false, cursor_overlay: true, managed_browser: "chrome" }, null, 2)}\n`,
        { flag: "wx", mode: 0o600 },
      );
    }
    await manager.install(COMPUTER_USE_PACKAGE.source);
    signal?.throwIfAborted();
    const installed = manager.getInstalledPath(
      COMPUTER_USE_PACKAGE.source,
      "user",
    );
    if (!installed)
      throw new Error("Pi did not report the installed computer-use package.");
    const manifest: unknown = JSON.parse(
      await readFile(join(installed, "package.json"), "utf8"),
    );
    if (
      !manifest ||
      typeof manifest !== "object" ||
      !("name" in manifest) ||
      !("version" in manifest) ||
      manifest.name !== COMPUTER_USE_PACKAGE.name ||
      manifest.version !== COMPUTER_USE_PACKAGE.version
    )
      throw new Error(
        "Computer-use package identity did not match; it was not enabled.",
      );
  }
  await settings.reload();
  if (settings.drainErrors().length)
    throw new Error("Pi settings changed unreadably; loading was not changed.");
  const packages = settings.getGlobalSettings().packages ?? [];
  const current = await matches(packages);
  if (current.some((entry) => sourceOf(entry) !== COMPUTER_USE_PACKAGE.source))
    throw new Error(
      "Computer-use source changed during setup; review it before retrying.",
    );
  signal?.throwIfAborted();
  const next = {
    ...(typeof current[0] === "object" ? current[0] : {}),
    source: COMPUTER_USE_PACKAGE.source,
    extensions: action === "disable" ? [] : ["**/*"],
    skills: [],
    prompts: [],
    themes: [],
  };
  const selected = new Set(current);
  settings.setPackages([
    ...packages.filter((entry) => !selected.has(entry)),
    next,
  ]);
  await settings.flush();
  if (settings.drainErrors().length)
    throw new Error(
      "Pi could not persist computer-use configuration; loading was not changed.",
    );
  const persisted = SettingsManager.create(cwd, agentDir, {
    projectTrusted: false,
  });
  if (
    persisted.drainErrors().length ||
    !persisted
      .getGlobalSettings()
      .packages?.some(
        (entry) =>
          typeof entry !== "string" &&
          entry.source === next.source &&
          JSON.stringify(entry.extensions) === JSON.stringify(next.extensions),
      )
  )
    throw new Error(
      "Could not verify saved computer-use configuration; loading was not changed.",
    );
  return `Pi computer use ${action === "install" ? "installed and enabled" : "disabled"} in native configuration. Current Session loading is unchanged. Explicitly reload resources while idle or start a new Session.`;
}
