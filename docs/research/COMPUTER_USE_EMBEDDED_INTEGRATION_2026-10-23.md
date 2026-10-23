# Original Pi computer use in OpenPI's embedded browser

- Status: validated local integration; real-model completion and deployment remain unverified
- Created: 2026-10-23
- Verified: 2026-10-23
- Source: PR [#892](https://github.com/openpi-dev/openpi/pull/892), initially `fd9624676f6213881b6f184c836920f29681a42c`, then `b5c97616b3081f31a96172c77a780d07e4229473`, integrated onto its rewritten `ebbce2f63e35629c6783bcf96202b2ee77299cb4`; the accompanying integration commit; Pi `1.2.0`; original `@injaneity/pi-computer-use` `0.5.1`; OpenPI Browser Bridge `0.5.0`
- Issue: [#169](https://github.com/openpi-dev/openpi/issues/169)
- Supersedes: the active custom `openpi_browser` / external-profile transport from the [October 9 browser adaptation](PI_BROWSER_TOOLS_2026-10-09.md). Earlier observations remain historical evidence, not results for this implementation.
- Evidence: private archive `/Users/admin/.codex/research/openpi-embedded-computer-use-20261023-xiw73g8p`; raw Sessions, model configuration, browser profiles and screenshots remain outside Git. This is an integration investigation, not a formal Benchmark.

## Problem and source boundary

The user requested the original plugin's interface for both native and embedded operation, with the duplicate interfaces removed. Loading a Pi package is sufficient for its native desktop/browser backend. Loading it does not make its top-page CDP observation target an OpenPI iframe: that requires the exact initiating tab, frame document and tool state.

Installation must also be checked in the actual Web profile. The existing service on port 57161 reports its own OpenPI runtime through `pi list`; the separate global Pi profile's installed plugin does not establish that the Web service has loaded it. The acceptance fixtures use private profiles whose single OpenPI source is this checkout. They do not change that service or its preferences.

## Implemented mechanism

Pi's native resource loader owns the optional original package and its eleven tool definitions: `find_roots`, `observe_ui`, `search_ui`, `expand_ui`, `inspect_ui`, `act_ui`, `read_text`, `wait_for`, `launch_browser`, `navigate_browser`, and `evaluate_browser`. Parameter objects, tool descriptions and prompt guidance are retained. There are no model-specific parameter patches, duplicated model schemas or new browser tools.

The existing resource-loader extension hook wraps execution. Embedded selection or a previously issued embedded identity routes to the bound frame backend; native selection invokes the original execution function with unchanged arguments. An unsupported embedded plugin version fails explicitly. An unavailable frame never causes a fallback to desktop control.

The previous `openpi_browser`, portable extension and custom external-profile pairing/control implementation are removed. Browser Bridge now serves only embedded navigation, binding and scoped CDP delivery. Its read-only version handshake works before a frame exists, allowing the first `launch_browser` to open a page. It does not open an extra OpenPI tab during connection.

The raw browser broker owns dispatch, cancellation, timeout, grants and state consumption. It checks the native Session, workspace, command, turn epoch, initiating controller, page and document. The model-facing backend adds bounded cached queries, subtree text without a silent layout-depth cutoff, immutable `read_text` continuations and checked expectations. Each asynchronous operation retains its original owner. A dispatched write consumes its state even if delivery becomes uncertain; a successful transport receipt alone is not application success.

Embedded `setText` uses the browser's text editing behavior, including rich editors. An observed actual `file_input` advertises `setText` with an absolute local path, or empty text to clear. The host validates a regular file; the internal transport sets that exact input and verifies the selected name and size. This retains the original tool schema. Native mode keeps the original plugin's file-dialog behavior.

Visual observations contain a cropped PNG and its pixel dimensions. Coordinate actions use that screenshot's frame-relative pixels and reject a moved, covered, closed or replaced frame. Keyboard delivery requires focus in that same frame. These operations use CDP without moving the system mouse or selecting another Chrome tab; this does not claim that every native desktop action can run without foreground focus.

Upstream 0.5.1 stores native state in its module, and Pi caches extension factories. The adapter copies tool/handler maps and lazily initializes native state under one Session owner. Another Session cannot reset or clean up that runtime. Embedded-only Sessions never initialize it. This restriction is version-scoped; it is not a new multi-agent orchestration mechanism.

## Configuration and authority

`/openpi-setup` remains the canonical configuration episode. `computer_use_action=install` or `disable` reviews the fixed `npm:@injaneity/pi-computer-use@0.5.1` source with native confirmation, uses Pi's package manager/settings, preserves existing preferences, checks installed identity and verifies persistence. Installation does not reload a running Session. Newly created plugin preferences are private and declared in the review.

`browser_default=embedded` requires both embedded grants and Browser Bridge in Chromium. Legacy external default names select the original native plugin; `browser_external` remains a preserved preference with no native authority. Settings distinguishes package loading, bridge readiness and saved grants. The package is excluded from children before extension execution by source/manifest identity, including renamed local packages.

## Validation and ablation

The focused tests load the actual original package with Pi and verify all eleven original parameter object identities, embedded/native routing, lifecycle ownership, child exclusion, cached reads, file dispatch, uncertain-state consumption, bounded output continuation and asynchronous owner revocation. Native routing/lifecycle tests substitute execution receipts; they do not claim a fresh OS desktop acceptance.

Real isolated Chrome exercises both same-process and cross-process iframes. Independent DOM and HTTP verifiers establish exact mixed Chinese/ASCII rich-text editing, dependent input plus Enter, a hidden STEP input with a Chinese filename, and full uploaded bytes plus SHA256. Screenshot-grounded pointer events and frame-scoped JavaScript also pass. The test checks Chrome's actual active tab IDs and another tab's unchanged input. Existing navigation, popup, cancellation, screenshot crop and document-replacement regressions pass.

The settings fixtures pass desktop/narrow layout, reachable controls and serious/critical accessibility checks. These fixtures do not prove native installation. The mechanical UI detector reports no findings.

The simplification removes the entire second external-browser transport, portable build and model-facing custom tool. Further removal of the per-operation owner guard in a private source copy makes the suspended-launch regression fail with a missing expected rejection: the operation continues into the replacement owner. The original regression passes. The guard is retained; the mutation is not present in product code.

Initial gates at `b5c97616` plus this patch passed with 2,378 Node passes / 8 existing skips and 1,536 UI passes. After rebasing onto PR #892's `ebbce2f6`, final implementation `691625d1def965b213115b8b8f6439179a6750ae` passed `bun run check` and `VITEST_MAX_WORKERS=2 bun run test`: 2,395 Node passes / 8 existing skips and 1,642 UI passes in 107 files. Six relevant real Chrome cases passed again across the original-tool, frame-control, settings and navigation suites. The final metadata amendment only updates this validation record.

## Real-model attempt and remaining limits

Three actual isolated Web turns selected the user-requested `local-codex/gpt-6.1-sol` and `xhigh`, with the original tool schemas intact: two before the PR rebase and one on the integrated source. All terminated with provider HTTP 503 `Service temporarily unavailable` before any browser tool call. This is an unavailable live-model check, not a browser success or a model/schema incompatibility finding. The archive retains the task, source provenance, native terminal state, zero-call count and usage receipts. Initial harness precondition failures are retained separately.

Unverified boundaries include completion by a live model, the original Mozi production workflow, platform OS permissions outside the prior native investigation, non-Chromium hosts, nested application frames, dynamic OS file pickers and downloading production artifacts. The fixture upload is a complete-byte integration check, not numerical solver validation. Existing user configuration and the service on port 57161 were not deployed or restarted by these tests.

## Follow-up: simultaneous input and virtual cursor

On 2026-10-23 the user requested a stronger non-interference and virtual-input check of implementation `1f4b143e`. Extending the original-tool Chrome fixture reproduced a real keyboard failure: `keypress(["Backspace"])` emitted an event but left `ABCDE` unchanged. The former shared text setter also appended `typeText` regardless of caret or selected text. The earlier Enter-listener test did not protect native editing defaults.

The embedded driver now supplies control-key codes and uses CDP's `Input.insertText` for typing. Full-content replacement retains the existing setter/rich-editor behavior. Keyboard delivery checks the bound frame's focus before each key, including dependent steps. This removes the custom append path without adding a tool, setting, model override or alternate input framework.

The revised fixture continuously types a separate exact stream in another active Chrome tab while the agent performs screenshot-grounded trusted pointer input, Backspace, caret movement, selection replacement, Chinese input and a native textarea newline. Both same-process and OOPIF cases pass. Independent receipts retain both full human strings (206 and 107 characters in the recorded run), the actual active tab IDs, focus, pointer event trust, and the target fields. The old keyboard fails this same test; the changed implementation passes. In an additional private extension copy, removing only virtual-key-code delivery reproduces the unchanged `ABCDE` failure, so that mapping is retained. The simplification to native `Input.insertText` removes the unnecessary shared append implementation. Evidence is archived separately at `/Users/admin/.codex/research/openpi-virtual-input-20261023-n8ng9cgr`.

These are direct original-tool calls in a real isolated Chrome, without a model call or OS input injection. The result establishes parallel input across those tabs, not unrestricted simultaneous editing of the same DOM focus. The current embedded driver does not render a visible virtual cursor or an on-screen keyboard. Upstream's native `cursor_overlay` / `AgentCursor` belongs to its desktop delivery path; its foreground/HID fallback remains distinct. No new overlay was added by this test and keyboard correction.

Follow-up gates: `bun run check` and the full `VITEST_MAX_WORKERS=2 bun run test` pass again (2,395 Node passes / 8 existing skips; 1,642 UI passes). The original-tool concurrent-input and frame/cancellation Chrome cases both pass after the keyboard correction. No deployment was performed.
