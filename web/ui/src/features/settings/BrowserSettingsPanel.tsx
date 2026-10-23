import { Switch } from "@astryxdesign/core/Switch";
import {
  CheckCircle2,
  ExternalLink,
  FolderOpen,
  Globe2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { BrowserConfig } from "../../../../../extensions/shared/browser-config.ts";
import {
  BROWSER_BRIDGE_VERSION,
  type BrowserSettingsStatus,
} from "../../../../protocol/browser.ts";
import { copyText } from "../../lib/clipboard.ts";
import { WebClient } from "../../protocol/client.ts";
import { useBrowserGuideWindow } from "./use-browser-guide-window.ts";

const installers = {
  chrome: "Chrome",
  edge: "Microsoft Edge",
  brave: "Brave",
  chromium: "Chromium",
} as const;

export function BrowserSettingsPanel({
  onConfigure,
  setupPending = false,
}: {
  onConfigure: (request: string) => Promise<boolean>;
  setupPending?: boolean;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<BrowserSettingsStatus>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [pending, setPending] = useState(false);
  const [guide, setGuide] = useState(false);
  const [step, setStep] = useState(1);
  const [installer, setInstaller] = useState<keyof typeof installers>("chrome");
  const [bridgeVersion, setBridgeVersion] = useState(
    document.documentElement.dataset.openpiBrowserBridgeVersion,
  );
  const guideWindow = useBrowserGuideWindow();
  const heading = useRef<HTMLHeadingElement>(null);
  const serial = useRef(0);
  const mounted = useRef(true);
  const blocked = pending || setupPending;
  const connected = bridgeVersion === BROWSER_BRIDGE_VERSION;
  const refresh = useCallback(async () => {
    const request = ++serial.current;
    try {
      const value = await new WebClient().request<BrowserSettingsStatus>(
        "/api/settings/browser",
      );
      if (mounted.current && request === serial.current) {
        setStatus(value);
        setError(undefined);
      }
    } catch (reason) {
      if (mounted.current && request === serial.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 3000);
    const observer = new MutationObserver(() =>
      setBridgeVersion(
        document.documentElement.dataset.openpiBrowserBridgeVersion,
      ),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-openpi-browser-bridge-version"],
    });
    return () => {
      mounted.current = false;
      clearInterval(timer);
      observer.disconnect();
    };
  }, [refresh]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A changed step replaces its action and moves focus to its heading.
  useEffect(() => {
    if (guide) heading.current?.focus({ preventScroll: true });
  }, [guide, step, guideWindow.container]);
  const configure = async (request: string) => {
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    ++serial.current;
    try {
      if (!(await onConfigure(request)))
        throw new Error(t("setupRequestFailed"));
      if (mounted.current) setNotice(t("setupRequestAccepted"));
    } catch (reason) {
      if (mounted.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  const save = (patch: Partial<BrowserConfig>) =>
    configure(
      `Configure browser adaptation: ${JSON.stringify(patch)}. Use /openpi-setup, preserve other settings, and do not install or reload packages automatically.`,
    );
  const action = async (action: "folder" | "manage") => {
    setPending(true);
    setError(undefined);
    try {
      await new WebClient().request("/api/settings/browser/action", {
        method: "POST",
        body: JSON.stringify({ browser: installer, action }),
      });
      return true;
    } catch (reason) {
      if (mounted.current)
        setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  if (!status)
    return (
      <div className="browser-settings-load" role={error ? "alert" : "status"}>
        <Globe2 aria-hidden="true" />
        <p>{error || t("browserLoading")}</p>
        {error && (
          <button type="button" onClick={() => void refresh()}>
            {t("browserCheck")}
          </button>
        )}
      </div>
    );
  const config = status.config;
  const native = config.defaultBrowser !== "embedded";
  const loaded = status.computerUse?.loaded === true;
  const extensionPage = `${installer === "edge" ? "edge" : installer === "brave" ? "brave" : "chrome"}://extensions/`;
  const steps = [
    t("browserStepOpen"),
    t("browserDeveloperMode"),
    t("browserStepAdd"),
    t("browserStepConnect"),
  ];
  const content = (
    <section
      className="browser-settings-guide"
      aria-label={t("browserGuideTitle", { browser: t("browserEmbedded") })}
    >
      <div className="browser-settings-guide-heading">
        <h3>{t("browserGuideTitle", { browser: t("browserEmbedded") })}</h3>
        <button
          type="button"
          className="icon-button"
          aria-label={t("browserCloseGuide")}
          onClick={() => {
            guideWindow.close();
            setGuide(false);
          }}
        >
          <X aria-hidden="true" />
        </button>
      </div>
      {!guideWindow.container && (
        <button
          type="button"
          className="browser-settings-text-button"
          onClick={async () => {
            if (!(await guideWindow.open()))
              setNotice(t("browserGuideBlocked"));
          }}
        >
          <ExternalLink aria-hidden="true" />
          {t("browserGuidePopout")}
        </button>
      )}
      {connected ? (
        <p className="browser-settings-ready">
          <CheckCircle2 aria-hidden="true" />
          {t("computerUseBridgeReady")}
        </p>
      ) : (
        <>
          <label className="browser-settings-install-browser">
            {t("browserInstallIn")}
            <select
              value={installer}
              onChange={(event) => {
                setInstaller(event.target.value as keyof typeof installers);
                setStep(1);
              }}
            >
              {Object.entries(installers).map(([id, name]) => (
                <option value={id} key={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <ol
            className="browser-settings-progress"
            aria-label={t("browserSetupSteps")}
          >
            {steps.map((label, index) => (
              <li key={label}>
                <button
                  type="button"
                  aria-current={step === index + 1 ? "step" : undefined}
                  aria-label={t("browserStepLabel", { step: index + 1, label })}
                  disabled={pending}
                  onClick={() => setStep(index + 1)}
                >
                  <span>{index + 1}</span>
                  {label}
                </button>
              </li>
            ))}
          </ol>
          <div className="browser-settings-wizard" aria-live="polite">
            <h4 ref={heading} tabIndex={-1}>
              {t(
                step === 1
                  ? "browserOpenManagerTitle"
                  : step === 2
                    ? "browserDeveloperTitle"
                    : step === 3
                      ? "browserInstallTitle"
                      : "browserConnectTitle",
                { browser: installers[installer] },
              )}
            </h4>
            <p>
              {t(
                step === 1
                  ? "browserOpenManagerHint"
                  : step === 2
                    ? "browserDeveloperHint"
                    : step === 3
                      ? "browserLoadHint"
                      : "computerUseBridgeConnectHint",
                {
                  browser: installers[installer],
                  loadLabel: t("browserLoadUnpacked"),
                },
              )}
            </p>
            {step === 1 && (
              <div className="browser-settings-address">
                <Globe2 aria-hidden="true" />
                <code>{extensionPage}</code>
              </div>
            )}
            {step === 2 && (
              <figure className="browser-settings-illustration">
                <figcaption>
                  {t("browserIllustration", { browser: installers[installer] })}
                </figcaption>
                <div className="browser-settings-demo" aria-hidden="true">
                  <div className="browser-settings-demo-bar">
                    <code>{extensionPage}</code>
                  </div>
                  <div className="browser-settings-demo-heading">
                    <span>{t("browserExtensions")}</span>
                    <span className="browser-settings-demo-toggle highlight">
                      {t("browserDeveloperMode")}
                      <i />
                    </span>
                  </div>
                  <div className="browser-settings-demo-toolbar">
                    <span>{t("browserLoadUnpacked")}</span>
                  </div>
                </div>
              </figure>
            )}
            {step === 3 && (
              <>
                <div className="browser-settings-selection">
                  <FolderOpen aria-hidden="true" />
                  <div>
                    <strong>browser-extension</strong>
                    <p>{t("browserSelectFolderHint")}</p>
                  </div>
                </div>
                <div className="browser-settings-guide-actions">
                  <button
                    type="button"
                    className="browser-settings-button"
                    disabled={pending}
                    onClick={() => void action("folder")}
                  >
                    {t("browserRevealTarget")}
                  </button>
                  <button
                    type="button"
                    className="browser-settings-button"
                    onClick={async (event) => {
                      const copied = await copyText(
                        status.extensionPath,
                        event.currentTarget.ownerDocument,
                      );
                      setNotice(
                        t(copied ? "browserPathCopied" : "browserCopyFailed"),
                      );
                    }}
                  >
                    {t("browserCopyPath")}
                  </button>
                </div>
                <code className="browser-settings-install-path">
                  {status.extensionPath}
                </code>
                <p>
                  {t(
                    navigator.userAgent.includes("Mac")
                      ? "browserChooseFolderMac"
                      : "browserChooseFolderOther",
                    { confirm: t("browserConfirmFolder") },
                  )}
                </p>
              </>
            )}
            {step === 4 && (
              <p role="status">
                {t(bridgeVersion ? "browserUpdateNeeded" : "browserWaiting")}
              </p>
            )}
            <div className="browser-settings-wizard-actions">
              {step > 1 && (
                <button
                  type="button"
                  className="browser-settings-button"
                  onClick={() => setStep(step - 1)}
                >
                  {t("browserPreviousStep")}
                </button>
              )}
              {step < 4 ? (
                <button
                  type="button"
                  className="browser-settings-primary"
                  disabled={pending}
                  onClick={async () => {
                    if (step > 1 || (await action("manage"))) setStep(step + 1);
                  }}
                >
                  {t(
                    step === 1
                      ? "browserOpenManager"
                      : step === 2
                        ? "browserDeveloperDone"
                        : "browserInstalledConnect",
                    { browser: installers[installer] },
                  )}
                </button>
              ) : (
                <button
                  type="button"
                  className="browser-settings-primary"
                  onClick={() => location.reload()}
                >
                  {t("browserReload")}
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
  return (
    <div className="settings-content-page browser-settings">
      <header className="browser-settings-heading">
        <h1>{t("browserSettings")}</h1>
        <p>{t("computerUseIntro")}</p>
      </header>
      <section className="browser-settings-card">
        <div className="browser-settings-control">
          <div>
            <strong>pi-computer-use</strong>
            <p role="status">
              {t(loaded ? "computerUseLoaded" : "computerUseNotLoaded")}
              {loaded && status.computerUse?.version
                ? ` · ${status.computerUse.version}`
                : ""}
            </p>
          </div>
          <button
            type="button"
            className="browser-settings-button"
            disabled={blocked}
            onClick={() =>
              void configure(
                t(
                  loaded
                    ? "computerUseDisableRequest"
                    : "computerUseInstallRequest",
                ),
              )
            }
          >
            {t(loaded ? "computerUseDisable" : "computerUseInstall")}
          </button>
        </div>
        <p className="browser-settings-package-hint">
          {t("computerUseReloadHint")}
        </p>
        <div className="browser-settings-default">
          <div>
            <label htmlFor="browser-default">{t("computerUseMode")}</label>
            <p>
              {t(native ? "computerUseNativeHint" : "computerUseEmbeddedHint")}
            </p>
          </div>
          <select
            id="browser-default"
            disabled={blocked}
            value={native ? "native" : "embedded"}
            onChange={(event) =>
              void save({
                defaultBrowser:
                  event.target.value === "embedded" ? "embedded" : "chrome",
              })
            }
          >
            <option value="embedded">{t("browserEmbedded")}</option>
            <option value="native">{t("computerUseNative")}</option>
          </select>
        </div>
        {!native && (
          <div className="browser-settings-control">
            <div>
              <strong>{t("computerUseEmbeddedPermission")}</strong>
              <p>{t("computerUseEmbeddedPermissionHint")}</p>
            </div>
            <Switch
              label={t("computerUseEmbeddedPermission")}
              isLabelHidden
              size="sm"
              value={config.control && config.embedded}
              isDisabled={blocked}
              onChange={(control: boolean) =>
                void save({ control, ...(control ? { embedded: true } : {}) })
              }
            />
          </div>
        )}
      </section>
      {!native && (
        <div className="browser-settings-row">
          <Globe2 aria-hidden="true" />
          <div className="browser-settings-description">
            <strong>OpenPI Browser Bridge</strong>
            <span role="status">
              {t(
                connected
                  ? "computerUseBridgeReady"
                  : bridgeVersion
                    ? "browserUpdateNeeded"
                    : "browserNeedsSetup",
              )}
            </span>
          </div>
          <button
            type="button"
            className="browser-settings-button"
            aria-label={t("browserSetupNamed", {
              browser: t("browserEmbedded"),
            })}
            onClick={() => setGuide(true)}
          >
            {t("browserSetUp")}
          </button>
        </div>
      )}
      {guide &&
        (guideWindow.container
          ? createPortal(content, guideWindow.container)
          : content)}
      {guideWindow.container && (
        <div className="browser-settings-guide-placeholder">
          <p>{t("browserGuideDetached")}</p>
          <button
            type="button"
            className="browser-settings-button"
            onClick={() => void guideWindow.open()}
          >
            {t("browserShowGuide")}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="browser-settings-warning">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="browser-settings-notice">
          {notice}
        </p>
      )}
    </div>
  );
}
