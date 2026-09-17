import { Dialog } from "@astryxdesign/core/Dialog";
import { LogIn, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebBackgroundTerminalDetail } from "../../../../../extensions/shared/web-observer-registry.ts";
import type { WebProjectTrustStatus } from "../../../../runtime/trust-status.ts";
import type { WebProviderAuthProjection } from "../../../../runtime/types.ts";
import type { ProviderLoginView } from "../../../../runtime/provider-login.ts";
import { WebClient } from "../../protocol/client.ts";

export interface InspectionTarget {
  sessionId: string;
  sessionPath: string;
  cwd: string;
  model: string;
  modelKey?: string;
  terminalId?: string;
}

interface InspectionData {
  thinking?: {
    level: string;
    available: readonly string[];
    supported?: boolean;
    revision?: number;
  };
  trust?: WebProjectTrustStatus;
  auth?: WebProviderAuthProjection;
  terminal?: WebBackgroundTerminalDetail;
  errors: string[];
}

export function InspectionPanel({
  target,
  onClose,
}: {
  target: InspectionTarget;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const client = useMemo(() => new WebClient(), []);
  const [revision, refresh] = useState(0);
  const [data, setData] = useState<InspectionData | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [login, setLogin] = useState<ProviderLoginView | null>(null);
  const [loginAnswer, setLoginAnswer] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const promptId = login?.prompt?.id;
  const loginId = login?.id;
  const loginStatus = login?.status;
  useEffect(() => {
    if (target.terminalId) return;
    const controller = new AbortController();
    setLogin(null);
    void client
      .providerLogins(target.sessionId, controller.signal)
      .then(({ logins }) => {
        if (!controller.signal.aborted)
          setLogin(
            logins.find(
              (item) =>
                item.workspace === target.cwd &&
                (item.status === "running" || item.status === "awaiting-input"),
            ) ?? null,
          );
      })
      .catch(() => {});
    return () => controller.abort();
  }, [client, target.sessionId, target.cwd, target.terminalId]);
  useEffect(() => {
    if (
      !loginId ||
      !loginStatus ||
      !["running", "awaiting-input"].includes(loginStatus)
    )
      return;
    const controller = new AbortController();
    const interval = window.setInterval(() => {
      void client
        .providerLogins(target.sessionId, controller.signal)
        .then(({ logins }) => {
          if (controller.signal.aborted) return;
          const next = logins.find(
            (item) => item.id === loginId && item.workspace === target.cwd,
          );
          if (next) {
            if (next.prompt?.id !== promptId) setLoginAnswer("");
            setLogin(next);
            if (next.status === "succeeded") refresh((value) => value + 1);
          } else setLogin(null);
        })
        .catch(() => {});
    }, 1000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [client, loginId, loginStatus, promptId, target.sessionId, target.cwd]);

  const startLogin = async (
    providerId: string,
    method: "oauth" | "api_key",
  ) => {
    setLoginBusy(true);
    setLoginError(null);
    setLoginAnswer("");
    try {
      const result = await client.startProviderLogin(
        target.sessionId,
        providerId,
        method,
        crypto.randomUUID(),
      );
      setLogin(result.view);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : t("loginFailed"));
      // A timed-out request may have been admitted. Recover the controller-owned operation.
      const owned = await client
        .providerLogins(target.sessionId)
        .catch(() => ({ logins: [] }));
      setLogin(
        owned.logins.find(
          (item) =>
            item.workspace === target.cwd &&
            (item.status === "running" || item.status === "awaiting-input"),
        ) ?? null,
      );
    } finally {
      setLoginBusy(false);
    }
  };
  const submitAnswer = async () => {
    if (!login?.prompt || !loginAnswer || loginBusy) return;
    setLoginBusy(true);
    setLoginError(null);
    try {
      await client.answerProviderLogin(login.id, login.prompt.id, loginAnswer);
      setLoginAnswer("");
      setLogin({ ...login, prompt: undefined, status: "running" });
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : t("loginFailed"));
    } finally {
      setLoginBusy(false);
    }
  };
  const cancelLogin = async () => {
    if (!login || loginBusy) return;
    setLoginBusy(true);
    try {
      await client.cancelProviderLogin(login.id);
      const owned = await client.providerLogins(target.sessionId);
      setLogin(owned.logins.find((item) => item.id === login.id) ?? null);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : t("loginFailed"));
    } finally {
      setLoginBusy(false);
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly triggers a manual refresh.
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setUpdatedAt(null);
    const read = async () => {
      const next: InspectionData = { errors: [] };
      if (target.terminalId) {
        try {
          const response = await client.terminalDetail(
            target.sessionId,
            target.terminalId,
            controller.signal,
          );
          if (
            response.sessionId !== target.sessionId ||
            response.detail.id !== target.terminalId
          ) {
            throw new Error(t("inspectionChanged"));
          }
          next.terminal = response.detail;
        } catch (error) {
          next.errors.push(
            error instanceof Error ? error.message : t("inspectionUnavailable"),
          );
        }
      } else {
        const [thinking, trust, auth] = await Promise.allSettled([
          client.thinking(target.sessionId, controller.signal),
          client.trust(target.sessionId, controller.signal),
          client.providerAuth(target.sessionId, controller.signal),
        ]);
        if (
          thinking.status === "fulfilled" &&
          thinking.value.sessionId === target.sessionId
        )
          next.thinking = thinking.value;
        else next.errors.push(t("thinkingUnavailable"));
        if (
          trust.status === "fulfilled" &&
          (trust.value.workspace === undefined ||
            trust.value.workspace === target.cwd)
        )
          next.trust = trust.value;
        else next.errors.push(t("trustUnavailable"));
        if (auth.status === "fulfilled") next.auth = auth.value;
        else next.errors.push(t("authUnavailable"));
      }
      if (controller.signal.aborted) return;
      setData(next);
      setUpdatedAt(new Date().toLocaleTimeString());
    };
    void read();
    return () => controller.abort();
  }, [client, target, revision, t]);

  const title = target.terminalId ? t("terminalDetails") : t("runtimeStatus");
  const terminal = data?.terminal;
  return (
    <Dialog
      isOpen
      onOpenChange={(open: boolean) => !open && onClose()}
      width={640}
      aria-label={title}
    >
      <section className="inspection-panel">
        <header className="inspection-heading">
          <div>
            <h2>{title}</h2>
            <p className="inspection-subtitle">{target.cwd}</p>
          </div>
          <div className="inspection-actions">
            <button
              type="button"
              className="icon-button"
              aria-label={t("refreshStatus")}
              disabled={!data}
              onClick={() => refresh((value) => value + 1)}
            >
              <RefreshCw />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={t("close")}
              onClick={onClose}
            >
              <X />
            </button>
          </div>
        </header>
        {!data ? (
          <p role="status">{t("inspectionLoading")}</p>
        ) : (
          <>
            {data.errors.map((error) => (
              <p className="inspection-warning" role="alert" key={error}>
                {error}
              </p>
            ))}
            {terminal ? (
              <>
                <div className="inspection-section">
                  <h3>{terminal.title || terminal.id}</h3>
                  <dl>
                    <dt>{t("executionState")}</dt>
                    <dd>
                      {t(`execution_${terminal.status}`, {
                        defaultValue: terminal.status,
                      })}
                    </dd>
                    <dt>{t("terminalCommand")}</dt>
                    <dd>
                      <code>{terminal.command}</code>
                    </dd>
                    <dt>{t("terminalDirectory")}</dt>
                    <dd>{terminal.cwd}</dd>
                    <dt>{t("startedAt")}</dt>
                    <dd>{new Date(terminal.createdAt).toLocaleString()}</dd>
                    {terminal.exitCode !== undefined && (
                      <>
                        <dt>{t("exitCode")}</dt>
                        <dd>{terminal.exitCode}</dd>
                      </>
                    )}
                  </dl>
                  {terminal.errorText && (
                    <p className="inspection-warning">{terminal.errorText}</p>
                  )}
                  {terminal.truncated && (
                    <p className="inspection-note">{t("detailTruncated")}</p>
                  )}
                </div>
                {(["stdout", "stderr"] as const).map((stream) => (
                  <section className="inspection-section" key={stream}>
                    <h3>
                      {stream === "stdout"
                        ? t("standardOutput")
                        : t("standardError")}
                    </h3>
                    <pre className="terminal-evidence">
                      {terminal[stream].text || t("noOutput")}
                    </pre>
                    {terminal[stream].truncated && (
                      <p className="inspection-note">
                        {t("outputTruncated", {
                          count: terminal[stream].omittedBytes,
                        })}
                      </p>
                    )}
                    {terminal[stream].recoveryAvailable && (
                      <p className="inspection-note">{t("outputRecovery")}</p>
                    )}
                  </section>
                ))}
              </>
            ) : (
              !target.terminalId && (
                <>
                  <section className="inspection-section">
                    <h3>{t("modelAndThinking")}</h3>
                    <dl>
                      <dt>{t("selectedModel")}</dt>
                      <dd>{target.model || t("noModels")}</dd>
                      <dt>{t("thinkingLevel")}</dt>
                      <dd>
                        {data.thinking?.supported === false
                          ? t("thinkingUnsupported")
                          : (data.thinking?.level ?? t("unknownState"))}
                      </dd>
                      {Boolean(data.thinking?.available.length) && (
                        <>
                          <dt>{t("availableThinking")}</dt>
                          <dd>{data.thinking?.available.join(" · ")}</dd>
                        </>
                      )}
                    </dl>
                    {data.thinking?.supported === false && (
                      <p className="inspection-note">
                        {t("thinkingUnsupportedHint")}
                      </p>
                    )}
                    {data.thinking &&
                      data.thinking.supported !== false &&
                      !data.thinking.available.includes(
                        data.thinking.level,
                      ) && (
                        <p className="inspection-warning" role="status">
                          {t("thinkingLevelMismatch")}
                        </p>
                      )}
                  </section>
                  <section className="inspection-section">
                    <h3>{t("projectTrust")}</h3>
                    <p>{t(`trust_${data.trust?.state ?? "unknown"}`)}</p>
                    {data.trust?.refreshRequired === true && (
                      <p className="inspection-warning">
                        {t("trustRefreshNeeded")}
                      </p>
                    )}
                  </section>
                  <section className="inspection-section">
                    <h3>{t("providerAvailability")}</h3>
                    {data.auth?.providers.map((provider) => (
                      <div className="provider-status" key={provider.id}>
                        <span>{provider.name || provider.id}</span>
                        <span>
                          {provider.configured
                            ? t("credentialConfigured")
                            : t("credentialMissing")}
                          {provider.loginMethods?.map((method) => (
                            <button
                              key={method}
                              type="button"
                              className="provider-login-button"
                              disabled={
                                loginBusy ||
                                Boolean(
                                  login &&
                                    ["running", "awaiting-input"].includes(
                                      login.status,
                                    ),
                                )
                              }
                              onClick={() =>
                                void startLogin(provider.id, method)
                              }
                            >
                              <LogIn size={14} />
                              {t(
                                method === "oauth"
                                  ? "loginOAuth"
                                  : "loginApiKey",
                              )}
                            </button>
                          ))}
                        </span>
                      </div>
                    ))}
                    {login && (
                      <div className="provider-login" role="status">
                        <strong>
                          {data.auth?.providers.find(
                            (item) => item.id === login.providerId,
                          )?.name ?? login.providerId}
                          : {t(`login_${login.status}`)}
                        </strong>
                        {login.event?.type === "auth_url" && (
                          <p>
                            <a
                              href={login.event.url}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {t("openProviderLogin")}
                            </a>
                            {login.event.instructions && (
                              <> {login.event.instructions}</>
                            )}
                          </p>
                        )}
                        {login.event?.type === "device_code" && (
                          <p>
                            <a
                              href={login.event.verificationUri}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {t("openProviderLogin")}
                            </a>{" "}
                            <code>{login.event.userCode}</code>
                          </p>
                        )}
                        {(login.event?.type === "info" ||
                          login.event?.type === "progress") && (
                          <p>{login.event.message}</p>
                        )}
                        {login.event?.type === "info" &&
                          login.event.links?.map((link) => (
                            <a
                              key={link.url}
                              href={link.url}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {link.label ?? t("openProviderLogin")}
                            </a>
                          ))}
                        {login.prompt && (
                          <form
                            onSubmit={(event) => {
                              event.preventDefault();
                              void submitAnswer();
                            }}
                          >
                            <label htmlFor="provider-login-answer">
                              {login.prompt.message}
                            </label>
                            {login.prompt.type === "select" ? (
                              <select
                                id="provider-login-answer"
                                value={loginAnswer}
                                onChange={(event) =>
                                  setLoginAnswer(event.target.value)
                                }
                              >
                                <option value="">
                                  {t("chooseLoginOption")}
                                </option>
                                {login.prompt.options?.map((option) => (
                                  <option key={option.id} value={option.id}>
                                    {option.label}
                                    {option.description
                                      ? ` (${option.description})`
                                      : ""}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <input
                                id="provider-login-answer"
                                autoComplete="off"
                                type={
                                  login.prompt.type === "secret"
                                    ? "password"
                                    : "text"
                                }
                                placeholder={login.prompt.placeholder}
                                value={loginAnswer}
                                onChange={(event) =>
                                  setLoginAnswer(event.target.value)
                                }
                              />
                            )}
                            <button
                              type="submit"
                              disabled={!loginAnswer || loginBusy}
                            >
                              {t("continueLogin")}
                            </button>
                          </form>
                        )}
                        {["running", "awaiting-input"].includes(
                          login.status,
                        ) ? (
                          <button
                            type="button"
                            onClick={() => void cancelLogin()}
                            disabled={loginBusy}
                          >
                            {t("cancelLogin")}
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setLogin(null);
                              setLoginAnswer("");
                            }}
                            className="provider-login-dismiss"
                          >
                            {t("close")}
                          </button>
                        )}
                      </div>
                    )}
                    {loginError && (
                      <p className="inspection-warning" role="alert">
                        {loginError}
                      </p>
                    )}
                    {data.auth && !data.auth.providers.length && (
                      <p>{t("noProviders")}</p>
                    )}
                    {data.auth?.providers.some(
                      (provider) =>
                        provider.authMethods?.length &&
                        !provider.loginMethods?.length,
                    ) && (
                      <p className="inspection-note">
                        {t("loginUnavailableViaPi")}
                      </p>
                    )}
                    {data.auth?.truncation.truncated && (
                      <p className="inspection-note">{t("providersBounded")}</p>
                    )}
                    <p className="inspection-note">{t("authNotVerified")}</p>
                  </section>
                  <p className="inspection-note">{t("configurationViaPi")}</p>
                </>
              )
            )}
            <p className="inspection-updated">
              {t("statusCaptured", { time: updatedAt })}
            </p>
          </>
        )}
      </section>
    </Dialog>
  );
}
