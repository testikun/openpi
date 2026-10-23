import type { BrowserConfig } from "../../extensions/shared/browser-config.ts";

export const BROWSER_BRIDGE_VERSION = "0.5.0";

export interface BrowserSettingsStatus {
  config: BrowserConfig;
  extensionPath: string;
  extensionVersion: string;
  computerUse?: { loaded: boolean; version?: string };
}
