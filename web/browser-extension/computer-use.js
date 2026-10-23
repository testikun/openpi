// Browser-only adaptation of pi-computer-use 0.5.1's CDP operations.
// See LICENSE.pi-computer-use. Chrome owns permission; the bound document owns every target.
const attachments = new Map();

// Runs atomically in the exact observed document. Browser editing preserves rich
// editor state; assigning contentEditable.textContent destroys its document tree.
function editText(text, replace) {
  this.scrollIntoView({ block: "center", inline: "center" });
  this.focus();
  if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
    if (this.disabled || this.readOnly || this.type === "file")
      throw new Error("The control is not a text input");
    const value = (replace ? "" : this.value) + text;
    const proto =
      this instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(this, value);
    this.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text,
      }),
    );
    this.dispatchEvent(new Event("change", { bubbles: true }));
    if (this.value !== value)
      throw new Error("The text input did not retain the requested value");
    return;
  }
  if (!this.isContentEditable)
    throw new Error("The observed control is not editable");
  const selection = this.ownerDocument.getSelection();
  const range = this.ownerDocument.createRange();
  range.selectNodeContents(this);
  if (!replace) range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
  if (!this.ownerDocument.execCommand("insertText", false, text))
    throw new Error("The browser could not edit this rich text control");
}

function fileInputInfo() {
  if (!(this instanceof HTMLInputElement) || this.type !== "file")
    throw new Error("The observed control is not a file input");
  return {
    name:
      this.getAttribute("aria-label") ||
      [...(this.labels || [])].map((label) => label.innerText).join(" ") ||
      this.name ||
      "File input",
    files: [...this.files].map((file) => ({
      name: file.name,
      size: file.size,
    })),
    multiple: this.multiple,
    disabled: this.disabled,
  };
}
chrome.debugger?.onEvent.addListener((source, method, params) => {
  const operation = attachments.get(source.tabId);
  if (
    method === "Target.attachedToTarget" &&
    operation &&
    params.targetInfo.type === "iframe"
  )
    operation.sessions.set(params.targetInfo.targetId, params.sessionId);
});
function bounded(promise) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            "Browser command timed out; delivery or cleanup is uncertain.",
          ),
        ),
      5000,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
chrome.debugger?.onDetach.addListener((source) => {
  attachments.get(source.tabId)?.cancel();
});

export function cancelBrowserControl(owner, requestId) {
  const operation = owner.control;
  if (!operation || (requestId && operation.id !== requestId)) return;
  operation.cancel();
}

export async function controlBrowser(
  tabId,
  owner,
  peer,
  requestId,
  request,
  current,
) {
  if (owner.control) throw new Error("Another browser operation is running.");
  const operation = {
    id: requestId,
    page: peer.id,
    cancelled: false,
    sessions: new Map(),
    cancel() {
      this.cancelled = true;
      if (attached) void detach().catch(() => {});
    },
  };
  owner.control = operation;
  const check = () => {
    if (
      operation.cancelled ||
      !current() ||
      owner.peers.get(peer.nonce) !== peer ||
      !owner.pages.has(peer.id)
    )
      throw new Error(
        "Embedded document control was revoked; delivery may be uncertain.",
      );
  };
  let attached = false;
  let observed = false;
  const baseRefs = peer.refs;
  let cleanup;
  const detach = () => (cleanup ??= bounded(chrome.debugger.detach({ tabId })));
  const send = async (method, params = {}, sessionId) => {
    check();
    const result = await bounded(
      chrome.debugger.sendCommand(
        { tabId, ...(sessionId ? { sessionId } : {}) },
        method,
        params,
      ),
    );
    if (method === "Page.navigate") {
      if (operation.cancelled || !current())
        throw new Error("Navigation was interrupted; delivery is uncertain.");
    } else {
      check();
    }
    return result;
  };
  try {
    check();
    await chrome.debugger.attach({ tabId }, "1.3");
    attached = true;
    attachments.set(tabId, operation);
    await send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: "iframe", exclude: false }],
    });
    const selector = `iframe[data-openpi-browser-page=${JSON.stringify(peer.id)}]`;
    const document = await send("DOM.getDocument", { depth: 1 });
    const queried = await send("DOM.querySelector", {
      nodeId: document.root.nodeId,
      selector,
    });
    if (!queried.nodeId) throw new Error("The embedded iframe is gone.");
    const frameId = (await send("DOM.describeNode", { nodeId: queried.nodeId }))
      .node.frameId;
    if (!frameId)
      throw new Error("The selected iframe has no controllable frame.");
    // Same-process frames share the parent target; OOPIFs need only their exact target.
    const sessionId = operation.sessions.get(frameId);
    const frameSend = (method, params) => send(method, params, sessionId);
    await frameSend("Runtime.enable");
    const world = await frameSend("Page.createIsolatedWorld", {
      frameId,
      worldName: "openpi-computer-use",
      grantUniveralAccess: false,
    });
    const evaluate = async (expression) => {
      const result = await frameSend("Runtime.evaluate", {
        contextId: world.executionContextId,
        expression,
        returnByValue: true,
        timeout: 5000,
      });
      if (result.exceptionDetails)
        throw new Error(
          result.exceptionDetails.text || "Embedded evaluation failed.",
        );
      return result.result.value;
    };
    const documentIdentity =
      "document.documentElement.dataset.openpiBrowserDocument";
    if ((await evaluate(documentIdentity)) !== peer.nonce)
      throw new Error("The frame's document no longer matches its binding.");
    // Do not resolve element identities across frames, observations, or navigations.
    const withNode = async (ref, declaration, args = [], internal = false) => {
      if (!internal && !baseRefs?.has(ref))
        throw new Error("Element ref is stale; observe again.");
      const backendNodeId = Number(ref.slice(2));
      const resolved = await frameSend("DOM.resolveNode", {
        backendNodeId,
        executionContextId: world.executionContextId,
      });
      if (!resolved.object?.objectId)
        throw new Error("The observed element is gone.");
      const result = await frameSend("Runtime.callFunctionOn", {
        objectId: resolved.object.objectId,
        functionDeclaration: `function(nonce, ...args){if(!this.isConnected || this.ownerDocument!==document || ${documentIdentity}!==nonce)throw new Error('Stale frame element');return (${declaration}).apply(this,args);}`,
        arguments: [peer.nonce, ...args].map((value) => ({ value })),
        returnByValue: true,
      });
      if (result.exceptionDetails)
        throw new Error(
          `Embedded action failed: ${String(
            result.exceptionDetails.exception?.description ||
              result.exceptionDetails.text ||
              "element changed",
          )
            .split("\n")[0]
            .slice(0, 500)}. Effects may be uncertain; observe again.`,
        );
      return result.result.value;
    };
    const focusedNode = async () => {
      const active = await frameSend("Runtime.evaluate", {
        contextId: world.executionContextId,
        expression: "document.activeElement",
      });
      if (!active.result.objectId)
        throw new Error("No focused control in the selected frame.");
      const described = await frameSend("DOM.describeNode", {
        objectId: active.result.objectId,
      });
      return `@e${described.node.backendNodeId}`;
    };
    const keys = async (names) => {
      if (!Array.isArray(names) || !names.length || names.length > 16)
        throw new Error("Invalid keypress.");
      const bits = {
        alt: 1,
        option: 1,
        control: 2,
        ctrl: 2,
        meta: 4,
        command: 4,
        cmd: 4,
        shift: 8,
      };
      const modifiers = names.reduce(
        (value, name) => value | (bits[name.toLowerCase()] || 0),
        0,
      );
      for (const name of names.filter((name) => !bits[name.toLowerCase()])) {
        const key =
          { return: "Enter", esc: "Escape", space: " " }[name.toLowerCase()] ||
          name;
        await frameSend("Input.dispatchKeyEvent", {
          type: "keyDown",
          key,
          modifiers,
          ...(key.length === 1 && !modifiers ? { text: key } : {}),
          ...((modifiers === 2 || modifiers === 4) && key.toLowerCase() === "a"
            ? { commands: ["selectAll"] }
            : {}),
        });
        await frameSend("Input.dispatchKeyEvent", {
          type: "keyUp",
          key,
          modifiers,
        });
      }
    };
    const pointer = async (
      x,
      y,
      type,
      button = "left",
      clickCount = 1,
      buttons = 0,
    ) => {
      const capture = peer.capture;
      if (
        !capture ||
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < 0 ||
        y < 0 ||
        x >= capture.width ||
        y >= capture.height
      )
        throw new Error(
          "Coordinates require this frame's last screenshot and must stay inside it.",
        );
      const point = {
        x: capture.x + (x * capture.cssWidth) / capture.width,
        y: capture.y + (y * capture.cssHeight) / capture.height,
      };
      const allowed = await send("Runtime.evaluate", {
        expression: `(()=>{const f=document.querySelector(${JSON.stringify(selector)});if(!f || f.dataset.openpiBrowserDocument!==${JSON.stringify(peer.nonce)})return false;const r=f.getBoundingClientRect();return ${point.x}>=r.left && ${point.x}<r.right && ${point.y}>=r.top && ${point.y}<r.bottom && document.elementFromPoint(${point.x},${point.y})===f;})()`,
        returnByValue: true,
      });
      if (allowed.result.value !== true)
        throw new Error(
          "The screenshot point is covered or its frame moved. Observe again.",
        );
      await send("Input.dispatchMouseEvent", {
        type,
        ...point,
        button,
        clickCount,
        buttons,
      });
    };
    peer.refs = undefined;
    if (request.operation === "act") {
      if (
        !Array.isArray(request.actions) ||
        request.actions.length < 1 ||
        request.actions.length > 20
      )
        throw new Error("Invalid action batch.");
      // Validate every ref before delivering steps. A batch may have partial effects.
      for (const action of request.actions)
        if (action.ref && !baseRefs?.has(action.ref))
          throw new Error("Element ref is stale; observe again.");
      for (const action of request.actions) {
        check();
        if (action.action === "press")
          await withNode(
            action.ref,
            "function(){this.scrollIntoView({block:'center',inline:'center'});this.focus();this.click();}",
          );
        else if (action.action === "click" && action.ref) {
          await withNode(
            action.ref,
            "function(){this.scrollIntoView({block:'center',inline:'center'});this.click();}",
          );
        } else if (action.action === "setFiles") {
          const input = await withNode(action.ref, fileInputInfo.toString());
          if (input.disabled) throw new Error("The file input is disabled.");
          await frameSend("DOM.setFileInputFiles", {
            backendNodeId: Number(action.ref.slice(2)),
            files: action.files,
          });
          const selected = await withNode(action.ref, fileInputInfo.toString());
          if (
            JSON.stringify(selected.files) !==
            JSON.stringify(action.expectedFiles)
          )
            throw new Error(
              "The file input did not receive the expected file names and sizes. Upload delivery is uncertain.",
            );
        } else if (
          action.action === "setText" ||
          action.action === "typeText"
        ) {
          if (typeof action.text !== "string" || action.text.length > 16000)
            throw new Error("Invalid input text.");
          const ref = action.ref || (await focusedNode());
          await withNode(
            ref,
            editText.toString(),
            [action.text, action.action === "setText"],
            !action.ref,
          );
        } else if (action.action === "keypress") {
          if (action.ref)
            await withNode(action.ref, "function(){this.focus();}");
          {
            const focused = await send("Runtime.evaluate", {
              expression: `document.activeElement===document.querySelector(${JSON.stringify(selector)})`,
              returnByValue: true,
            });
            if (!focused.result.value)
              throw new Error(
                "The selected embedded frame has no keyboard focus. Focus an observed control in this action batch.",
              );
          }
          await keys(action.keys);
        } else if (action.action === "click") {
          await pointer(
            action.x,
            action.y,
            "mousePressed",
            action.button,
            action.clickCount,
          );
          await pointer(
            action.x,
            action.y,
            "mouseReleased",
            action.button,
            action.clickCount,
          );
        } else if (action.action === "moveMouse") {
          await pointer(action.x, action.y, "mouseMoved", "none");
        } else if (action.action === "drag") {
          if (
            !Array.isArray(action.path) ||
            action.path.length < 2 ||
            action.path.length > 1000
          )
            throw new Error("Invalid drag path.");
          const points = action.path.map((point) =>
            Array.isArray(point) ? { x: point[0], y: point[1] } : point,
          );
          await pointer(points[0].x, points[0].y, "mousePressed");
          for (const point of points.slice(1))
            await pointer(point.x, point.y, "mouseMoved", "left", 1, 1);
          const last = points.at(-1);
          await pointer(last.x, last.y, "mouseReleased");
        } else if (action.action === "scroll") {
          if (
            [action.scrollX ?? 0, action.scrollY ?? 0].some(
              (value) => !Number.isFinite(value) || Math.abs(value) > 10000,
            )
          )
            throw new Error("Invalid scroll distance.");
          if (action.ref)
            await withNode(
              action.ref,
              "function(dx,dy){this.scrollBy(dx,dy);}",
              [action.scrollX ?? 0, action.scrollY ?? 0],
            );
          else
            await evaluate(
              `window.scrollBy(${action.scrollX ?? 0},${action.scrollY ?? 0})`,
            );
        } else throw new Error("Unsupported embedded action.");
      }
    } else if (request.operation === "navigate") {
      const url = new URL(request.url);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.origin === owner.origin
      )
        throw new Error("Invalid embedded navigation URL.");
      peer.refs = undefined;
      const result = await frameSend("Page.navigate", {
        frameId,
        url: url.href,
      });
      if (result.errorText) throw new Error(result.errorText);
      return { navigated: true };
    } else if (request.operation === "evaluate") {
      if (
        typeof request.expression !== "string" ||
        request.expression.length > 65_536
      )
        throw new Error("Invalid evaluation expression.");
    } else if (request.operation !== "observe")
      throw new Error("Unsupported embedded operation.");
    let evaluation;
    if (request.operation === "evaluate") {
      const value = await evaluate(request.expression);
      const serialized = JSON.stringify(value) ?? "null";
      evaluation =
        serialized.length > 16000
          ? { text: serialized.slice(0, 16000), truncated: true }
          : value;
    }
    const tree = await frameSend("Accessibility.getFullAXTree", { frameId });
    const all = (tree.nodes || []).filter(
      (node) => !node.ignored && node.backendDOMNodeId,
    );
    const refs = new Map(
      all.map((node) => [node.nodeId, `@e${node.backendDOMNodeId}`]),
    );
    const records = new Map(
      (tree.nodes || []).map((node) => [node.nodeId, node]),
    );
    const parent = (node) => {
      let id = node.parentId;
      for (let depth = 0; id && depth < 100; depth++) {
        if (refs.has(id)) return refs.get(id);
        id = records.get(id)?.parentId;
      }
    };
    const nodes = all.slice(0, 5000).map((node) => ({
      ref: `@e${node.backendDOMNodeId}`,
      role: String(node.role?.value || "").slice(0, 100),
      name: String(node.name?.value || "").slice(0, 500),
      ...(node.value
        ? { value: String(node.value.value ?? "").slice(0, 16000) }
        : {}),
      ...(parent(node) ? { parent: parent(node) } : {}),
    }));
    // Hidden file inputs are genuine controls, commonly activated by an upload
    // button. Expose their exact DOM identities instead of treating that button
    // as a text field or opening an OS-wide file picker.
    const fileArray = await frameSend("Runtime.evaluate", {
      contextId: world.executionContextId,
      expression:
        "Array.from(document.querySelectorAll('input[type=file]')).slice(0,64)",
    });
    const inputs = await frameSend("Runtime.getProperties", {
      objectId: fileArray.result.objectId,
      ownProperties: true,
    });
    for (const input of inputs.result.filter(
      (property) => /^\d+$/.test(property.name) && property.value?.objectId,
    )) {
      const described = await frameSend("DOM.describeNode", {
        objectId: input.value.objectId,
      });
      const ref = `@e${described.node.backendNodeId}`;
      const info = await withNode(ref, fileInputInfo.toString(), [], true);
      const previous = nodes.findIndex((node) => node.ref === ref);
      const file = {
        ref,
        role: "file_input",
        name: `${info.name} — setText: absolute local file path; empty text clears selection`.slice(
          0,
          500,
        ),
        value: JSON.stringify(info.files).slice(0, 16000),
        actions: info.disabled ? [] : ["setText"],
      };
      if (previous >= 0) nodes[previous] = file;
      else if (nodes.length < 5000) nodes.push(file);
    }
    const fullText = String(
      (await evaluate("document.body ? document.body.innerText : ''")) || "",
    );
    const observation = {
      nodes,
      text: fullText.slice(0, 16000),
      truncated: all.length > 5000 || fullText.length > 16000,
      ...(evaluation !== undefined ? { evaluation } : {}),
    };
    peer.refs = new Set(nodes.map((node) => node.ref));
    if (request.image) {
      // Attaching Chrome's debugger changes its native viewport. Let layout and
      // compositor paint settle before measuring and capturing the exact frame.
      await send("Runtime.evaluate", {
        expression:
          "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))",
        awaitPromise: true,
        returnByValue: true,
        timeout: 5000,
      });
      const geometry = await send("Runtime.evaluate", {
        expression: `(()=>{const f=document.querySelector(${JSON.stringify(selector)});if(!f || [...document.querySelectorAll('dialog[open],[role="dialog"],[role="alertdialog"]')].some(d=>!d.contains(f)&&d.getClientRects().length&&getComputedStyle(d).visibility!=='hidden'))return null;const r=f.getBoundingClientRect(),v=f.parentElement.getBoundingClientRect();const x=Math.max(0,r.left,v.left),y=Math.max(0,r.top,v.top);return {x:x+scrollX,y:y+scrollY,width:Math.min(r.right,v.right,innerWidth)-x,height:Math.min(r.bottom,v.bottom,innerHeight)-y};})()`,
        returnByValue: true,
      });
      const clip = geometry.result.value;
      if (!clip || clip.width <= 0 || clip.height <= 0)
        throw new Error(
          "Show this browser page and close covering dialogs before requesting a screenshot.",
        );
      // The clip is already bounded to the visible viewport. Capturing beyond
      // it can resize the page during capture and include the workbench footer.
      const capture = await send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
        clip: {
          ...clip,
          scale: Math.min(1, 1600 / Math.max(clip.width, clip.height)),
        },
      });
      if (!capture.data || capture.data.length > 4_000_000)
        throw new Error("Embedded screenshot exceeds the image limit.");
      observation.image = capture.data;
      const header = Uint8Array.from(
        atob(capture.data.slice(0, 48)),
        (character) => character.charCodeAt(0),
      );
      const view = new DataView(header.buffer);
      const offset = await send("Runtime.evaluate", {
        expression: "({x:scrollX,y:scrollY})",
        returnByValue: true,
      });
      peer.capture = {
        x: clip.x - offset.result.value.x,
        y: clip.y - offset.result.value.y,
        cssWidth: clip.width,
        cssHeight: clip.height,
        width: view.getUint32(16),
        height: view.getUint32(20),
      };
    } else {
      peer.capture = undefined;
    }
    if (
      new TextEncoder().encode(JSON.stringify(observation)).byteLength >
      4_200_000
    )
      throw new Error(
        "Browser observation exceeds the transport limit. Actions may already have taken effect; observe semantically before continuing.",
      );
    observed = true;
    return observation;
  } catch (error) {
    if (operation.cancelled)
      throw new Error(
        "Embedded document control was revoked; delivery may be uncertain. Observe again.",
      );
    throw error;
  } finally {
    if (!observed) {
      peer.refs = undefined;
      peer.capture = undefined;
    }
    if (attached) await detach();
    if (owner.control === operation) owner.control = undefined;
    if (attachments.get(tabId) === operation) attachments.delete(tabId);
  }
}
