// Apache-2.0. This adapter uses OpenCLI 1.8.6's public Page API; it never
// connects to OpenCLI's daemon or to a desktop-wide CDP endpoint.

import { setTimeout as delay } from "node:timers/promises";
import { Page } from "@jackwener/opencli/browser/page";
import { buildEvaluateExpression } from "@jackwener/opencli/browser/utils";
import type {
  BrowserEvaluateFunction,
  WaitOptions,
} from "@jackwener/opencli/types";
import {
  type ComputerUseToolName,
  controlWebBrowser,
} from "../../extensions/browser/web-bridge.ts";

const object = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("The embedded browser returned an invalid result.");
  return value as Record<string, unknown>;
};

/** OpenCLI's real DOM engine over the existing exact-document Web transport. */
export class MakaBrowserPage extends Page {
  private readonly scope: object;
  private root?: string;
  private stateId?: string;
  private document?: string;
  private snapshotDocument?: string;
  private busy = false;
  private signal?: AbortSignal;

  constructor(scope: object) {
    super("openpi-embedded-experiment");
    this.scope = scope;
  }

  async run<T>(action: () => Promise<T>, signal?: AbortSignal) {
    if (this.busy)
      throw new Error("Another browser operation is running in this Session.");
    this.busy = true;
    this.signal = signal;
    try {
      signal?.throwIfAborted();
      return await action();
    } finally {
      this.busy = false;
      this.stateId = undefined;
      this.signal = undefined;
    }
  }

  private async call(
    tool: ComputerUseToolName,
    params: Record<string, unknown>,
  ) {
    this.signal?.throwIfAborted();
    const result = await controlWebBrowser(
      this.scope,
      { tool, params },
      this.signal,
    );
    if (result.isError)
      throw new Error(
        result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
      );
    const details = object(result.details);
    if (typeof details.stateId === "string") this.stateId = details.stateId;
    return details;
  }

  async attach() {
    const details = await this.call("find_roots", { kind: "browser_page" });
    if (!Array.isArray(details.windows))
      throw new Error("The browser returned no page inventory.");
    const roots = details.windows.map(object);
    if (this.root) {
      if (!roots.some((root) => root.windowRef === this.root))
        throw new Error(
          "This Session's embedded page closed or changed controller.",
        );
    } else {
      if (roots.length !== 1)
        throw new Error(
          "This experiment needs one embedded page. Use browser_navigate first, or close extra embedded pages.",
        );
      if (typeof roots[0]!.windowRef !== "string")
        throw new Error("Missing embedded page identity.");
      this.root = roots[0]!.windowRef;
    }
    await this.call("observe_ui", { root: this.root, mode: "semantic" });
    this.document = await this.evaluate<string>(
      "document.documentElement.dataset.openpiBrowserDocument",
    );
    if (!this.document) throw new Error("The embedded document is not bound.");
  }

  assertRef(ref: string) {
    if (
      /^\s*\[?\d+\]?\s*$/u.test(ref) &&
      this.snapshotDocument !== this.document
    )
      throw new Error(
        "Element refs require browser_snapshot of this exact document.",
      );
  }

  override async goto(url: string) {
    const parsed = new URL(url);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    )
      throw new Error(
        "Browser navigation requires an HTTP(S) URL without credentials.",
      );
    const details = await this.call("find_roots", { kind: "browser_page" });
    if (!Array.isArray(details.windows))
      throw new Error("The browser returned no page inventory.");
    if (!details.windows.length && !this.root) {
      const opened = await this.call("launch_browser", { url: parsed.href });
      const root = object(opened.root);
      if (typeof root.ref !== "string")
        throw new Error("The page did not open.");
      this.root = root.ref;
    } else {
      await this.attach();
      await this.call("navigate_browser", {
        stateId: this.stateId,
        url: parsed.href,
      });
    }
    this.snapshotDocument = undefined;
    // A navigation receipt is not page readiness. Wait for the real binding.
    const deadline = Date.now() + 10_000;
    while (true) {
      try {
        await this.attach();
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        this.signal?.throwIfAborted();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  override evaluate<T = unknown>(js: string): Promise<T>;
  override evaluate<Args extends unknown[], T>(
    fn: BrowserEvaluateFunction<Args, T>,
    ...args: Args
  ): Promise<Awaited<T>>;
  override async evaluate(
    js: string | ((...args: never[]) => unknown),
    ...args: unknown[]
  ) {
    if (!this.stateId)
      throw new Error("Observe the bound embedded page before evaluating.");
    const result = await this.call("evaluate_browser", {
      stateId: this.stateId,
      expression: buildEvaluateExpression(js, args),
    });
    const evaluation = result.evaluation;
    if (
      evaluation &&
      typeof evaluation === "object" &&
      "truncated" in evaluation &&
      evaluation.truncated === true
    )
      throw new Error(
        "The browser result exceeded the experiment's transport limit.",
      );
    return evaluation;
  }

  override async getCurrentUrl() {
    return this.evaluate<string>("location.href");
  }

  override async snapshot() {
    const result = await super.snapshot({ interactive: true });
    this.snapshotDocument = this.document;
    return result;
  }

  override async wait(options: number | WaitOptions) {
    this.signal?.throwIfAborted();
    if (typeof options === "number") {
      await delay(options * 1000, undefined, { signal: this.signal });
      return;
    }
    await super.wait(options);
  }

  // OpenCLI's DOM preparation already focuses/scrolls the exact resolved node.
  // No daemon-backed Page methods may be used by these six tools.
  protected override async tryCdpOnResolvedElement() {
    return false;
  }

  protected override async tryNativeClick(x: number, y: number) {
    const size = object(
      await this.evaluate("({width:innerWidth,height:innerHeight})"),
    );
    if (typeof size.width !== "number" || typeof size.height !== "number")
      throw new Error("Missing frame viewport dimensions.");
    const visual = await this.call("observe_ui", {
      root: this.root,
      mode: "visual",
    });
    const capture = object(visual.capture);
    if (typeof capture.width !== "number" || typeof capture.height !== "number")
      throw new Error("Missing screenshot dimensions.");
    await this.call("act_ui", {
      stateId: this.stateId,
      actions: [
        {
          action: "click",
          x: (x * capture.width) / size.width,
          y: (y * capture.height) / size.height,
        },
      ],
    });
    return true;
  }

  protected override async tryNativeType(text: string) {
    await this.call("act_ui", {
      stateId: this.stateId,
      actions: [{ action: "typeText", text }],
    });
    return true;
  }

  protected override async tryNativeKeyPress(key: string, modifiers: string[]) {
    await this.call("act_ui", {
      stateId: this.stateId,
      actions: [{ action: "keypress", keys: [...modifiers, key] }],
    });
    return true;
  }
}
