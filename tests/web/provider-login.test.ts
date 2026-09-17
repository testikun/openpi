import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
} from "@earendil-works/pi-ai";
import { ProviderLogins } from "../../web/runtime/provider-login.ts";

const target = () => ({
  id: randomUUID(),
  sessionId: "session-a",
  workspace: "/workspace",
  epoch: 3,
  providerId: "provider-a",
  method: "oauth" as const,
});

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("Pi owns credentials while URL and secret prompt remain private and ephemeral", async () => {
  let changes = 0;
  const logins = new ProviderLogins(() => {
    changes++;
  });
  const loginTarget = target();
  let resolveLogin: (() => void) | undefined;
  let interaction: AuthInteraction | undefined;
  const login = (value: AuthInteraction) => {
    interaction = value;
    return new Promise<void>((resolve) => {
      resolveLogin = resolve;
    });
  };
  assert.equal(logins.start(loginTarget, login).state, "accepted");
  assert.equal(logins.start(loginTarget, login).state, "replayed");
  assert.equal(
    logins.start({ ...loginTarget, providerId: "other" }, login).state,
    "conflict",
  );
  assert.equal(logins.start(target(), login).state, "busy");
  await tick();
  assert.ok(interaction);
  interaction.notify({
    type: "auth_url",
    url: "https://provider.example/authorize?state=private-state",
  });
  assert.equal(logins.get(loginTarget.id)?.event?.type, "auth_url");
  let received: string | undefined;
  const entered = interaction
    .prompt({ type: "secret", message: "API key" })
    .then((value) => {
      received = value;
    });
  const prompt = logins.get(loginTarget.id)?.prompt;
  assert.ok(prompt);
  assert.equal(prompt.type, "secret");
  assert.equal(
    logins.answer(loginTarget.id, "other-prompt", "sk-private"),
    "stale",
  );
  assert.equal(
    logins.answer(loginTarget.id, prompt.id, "sk-private"),
    "accepted",
  );
  await entered;
  assert.equal(received, "sk-private");
  assert.doesNotMatch(JSON.stringify(logins.list()), /sk-private/u);
  assert.equal(logins.get(loginTarget.id)?.prompt, undefined);
  resolveLogin?.();
  await tick();
  assert.equal(logins.get(loginTarget.id)?.status, "succeeded");
  assert.equal(logins.answer(loginTarget.id, prompt.id, "again"), "stale");
  assert.equal(changes >= 4, true);
  await logins.close();
});

test("provider prompt validation, per-prompt abort and unknown external content fail closed", async () => {
  const logins = new ProviderLogins(() => {});
  const loginTarget = target();
  let interaction: AuthInteraction | undefined;
  let release: (() => void) | undefined;
  logins.start(loginTarget, async (value) => {
    interaction = value;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await tick();
  assert.ok(interaction);
  interaction.notify({
    type: "device_code",
    userCode: "A1B2",
    verificationUri: "https://auth.example/device",
  });
  assert.equal(logins.get(loginTarget.id)?.event?.type, "device_code");
  const abort = new AbortController();
  const first = interaction.prompt({
    type: "select",
    message: "Choose account",
    options: [{ id: "a", label: "Account A" }],
    signal: abort.signal,
  });
  const prompt = logins.get(loginTarget.id)?.prompt;
  assert.ok(prompt);
  assert.equal(logins.answer(loginTarget.id, prompt.id, "invalid"), "invalid");
  abort.abort();
  await assert.rejects(first, /cancelled/u);
  assert.equal(logins.get(loginTarget.id)?.prompt, undefined);
  assert.equal(logins.get(loginTarget.id)?.status, "running");
  interaction.notify({ type: "auth_url", url: "javascript:alert(1)" });
  assert.equal(logins.get(loginTarget.id)?.status, "uncertain");
  release?.();
  await logins.close();
});

test("abort and timeout do not claim that Pi rolled back a credential write", async () => {
  const logins = new ProviderLogins(() => {});
  const cancelledTarget = target();
  const started = logins.start(
    cancelledTarget,
    ({ signal }) =>
      new Promise<void>((_, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      }),
  );
  assert.equal(started.state, "accepted");
  await tick();
  assert.equal(logins.cancel(cancelledTarget.id), "accepted");
  assert.equal(logins.get(cancelledTarget.id)?.status, "uncertain");
  assert.equal(logins.cancel(cancelledTarget.id), "already-settled");
  assert.equal(logins.start(target(), async () => {}).state, "busy");
  await tick();

  const expiredTarget = target();
  logins.start(
    expiredTarget,
    ({ signal }) =>
      new Promise<void>((_, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      }),
    15,
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(logins.get(expiredTarget.id)?.status, "expired");
  assert.equal(logins.cancel(expiredTarget.id), "already-settled");
  await logins.close();
});

test("an uncooperative provider keeps the native operation busy through cancellation and shutdown", async () => {
  const logins = new ProviderLogins(() => {});
  const loginTarget = target();
  let release: (() => void) | undefined;
  logins.start(
    loginTarget,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await tick();
  assert.equal(logins.cancel(loginTarget.id), "accepted");
  assert.equal(logins.get(loginTarget.id)?.status, "uncertain");
  assert.equal(logins.start(target(), async () => {}).state, "busy");
  let closed = false;
  const closing = logins.close().then(() => {
    closed = true;
  });
  await tick();
  assert.equal(closed, false);
  release?.();
  await closing;
  assert.equal(logins.list().length, 0);
});

test("unknown provider events and prompt types fail closed", async () => {
  const logins = new ProviderLogins(() => {});
  let interaction: AuthInteraction | undefined;
  let release: (() => void) | undefined;
  const first = target();
  logins.start(first, async (value) => {
    interaction = value;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await tick();
  assert.ok(interaction);
  interaction.notify({
    type: "future",
    message: "private",
  } as unknown as AuthEvent);
  assert.equal(logins.get(first.id)?.status, "uncertain");
  release?.();
  await tick();

  const second = target();
  logins.start(second, async (value) => {
    await value.prompt({
      type: "future",
      message: "private",
    } as unknown as AuthPrompt);
  });
  await tick();
  assert.equal(logins.get(second.id)?.status, "uncertain");
  assert.doesNotMatch(JSON.stringify(logins.list()), /private/u);
  await logins.close();
});
