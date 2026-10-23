# Maka embedded-browser experiment in OpenPI

- Status: validated local package and Chrome integration; live-model completion unavailable
- Created: 2026-10-23
- Verified: 2026-10-23
- Source boundary: OpenPI `a8fadafe2519414ab92b2c6f20a59bfa7422c7f4` plus this experimental branch; Apache Maka `173f1e7397ded73cdfc8f362e89858602e073ef4`; OpenCLI npm `1.8.6`; Pi `1.2.0`
- Issue: [#169](https://github.com/openpi-dev/openpi/issues/169)
- Related: [original Pi embedded integration](COMPUTER_USE_EMBEDDED_INTEGRATION_2026-10-23.md), [PR #892](https://github.com/openpi-dev/openpi/pull/892)
- Supersedes: none. This is an alternative experiment, not adoption or replacement of the original plugin.
- Evidence: private archive `/Users/admin/.codex/research/openpi-maka-browser-20261023-wjqd3ej_`. Raw Sessions, browser profiles, provider configuration and screenshots are not published. This is not a formal Benchmark.

## Question and frozen source

The user requested a separate worktree to try Maka's embedded browser. The local
Maka checkout exposes one desktop `maka_computer` tool and six independent
embedded-browser tools. These are different capabilities. Its embedded browser
uses OpenCLI's `CDPBridge` against a Session-owned Electron `WebContents`, not the
desktop computer-use helper. Only that six-tool embedded surface is ported here.

The source snapshot is explicit: this record does not claim that the local Maka
checkout or OpenCLI 1.8.6 is the current upstream release. The npm tarball's
integrity and selected sources are retained in the private archive.

## Implementation boundary

`experiments/maka-browser/` is a separate optional native Pi package. It registers
`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`,
`browser_wait` and `browser_extract`. The experimental profile has exactly one
OpenPI source and this package; it does not load the original eleven tools.

The actual unmodified OpenCLI `Page` DOM engine supplies snapshots, numbered
refs, target resolution, filling, clicks, waits and Markdown conversion. Its
public transport methods are adapted to OpenPI's existing Session/controller/
document-bound frame backend. No OpenCLI daemon, Electron runtime, global CDP
endpoint, additional model/provider stack or ordinary browser takeover is used.

Pi owns loading and the native Session. The existing Web turn and Chrome Bridge
own input authority. Per-tool cancellation reaches the frame transport, fixed
waits are abortable, one page rejects concurrent operations, and numbered refs
require a snapshot of the current document. Input uncertainty is propagated
without repeating it through a second input path. The package and six tools are
excluded from child resources. The existing permission fields are reused; no
new package preference or default is introduced.
The shared visibility catalog names the six optional tools, and their Session
activation requires the existing embedded grants and embedded default.

The experiment runs on local port 57162 with its own agent directory. Existing
port 57161, its current Session, permissions, installed package and source were
not replaced by this experiment. Loading the experimental Chrome Bridge is
necessary for its asynchronous condition waits. The original package baseline
remains on its separate branch.

## Verified results and capability gaps

The actual Pi loader registers six tools without the original plugin. Focused
tests also check cancellation, rejection of concurrent dispatch and the child
classification boundary.

A real isolated Chrome runs those Pi tools through OpenCLI and the frame backend
against a cross-process localhost iframe. Independent DOM and Chrome state
checks establish navigation, mixed Chinese/ASCII rich text, ordinary text input
with real Enter, multiline textarea content, trusted pointer events on a custom
menu, condition waiting, Markdown extraction, and rejection of refs after
navigation. A second active tab receives a separate exact input stream; its
full text, DOM focus and Chrome active tab IDs remain correct. This is a
controlled Chrome input test, not a claim about physical keyboard input on all
operating systems or two editors sharing the same DOM focus.

The initial Chrome run failed on a real `<input type="number">`: OpenCLI 1.8.6's
`fillText` rejects it as not fillable. The fixture retains that number input and
records its rejection and unchanged value. It also records rejection of native
`select` and file-input filling. An ordinary text field is checked separately;
its success is not counted as numeric-field support.

The six-tool baseline has no exposed upload, select-option, general keypress,
drag or screenshot tool. Broader OpenCLI library methods do not become callable
by the model just because the dependency contains them. No STEP upload, complete
simulation form, solver run, production SSO, production download, or original
Mozi workflow has passed in this experiment. No visible virtual cursor is added.

Extraction uses the existing bounded frame result transport and reports a
smaller HTML ceiling than Maka's Electron implementation. Large snapshots may
fail explicitly rather than silently truncate required engine state.

## Live-model attempts

Two actual experimental Web turns selected the user-requested
`local-codex/gpt-6.1-sol` with `xhigh`. Both failed with provider HTTP 503
`Service temporarily unavailable` before any tool call; recorded usage is zero.
Their tasks, native terminal state, Sessions and private evidence remain
available. This is an unavailable model completion check, not a model/schema
compatibility result and not a successful complex-form test.

## Recommendation

Keep this branch as an isolated comparison. The six-tool interface and real
OpenCLI DOM engine can operate the tested controls, but the frozen surface does
not cover the user's numeric parameters, native application selector or STEP
upload. Replacing the existing setup with this exact baseline would leave those
requirements unresolved. Any follow-up should explicitly evaluate broader
OpenCLI operations and the model-facing interface, then re-run the unchanged
business workflow. No such expansion is adopted by this record.

Repository gates and the await-Promise ablation are recorded with their exact
receipts in the private archive and completed before handoff.
`bun run check` passes. The isolated full `bun run test` passes with 2,398 Node
passes, 8 existing skips, and 1,642 UI passes across 107 files. The final Chrome
case also verifies that all six tools are active under the saved grants and the
original `act_ui` tool is absent. This is a supported-controls acceptance, with
the numeric/select/file limitations asserted separately.

Removing only frame-evaluation `awaitPromise` in a private extension copy makes
the same Chrome test fail: the wait returns while the actual page still says
`Waiting`, rather than `Ready to review`. The product retains this flag. The
adapter otherwise reuses OpenCLI and the existing frame backend rather than
adding another CDP server or action framework.

The first full Node run inherited this machine's ordinary Pi preferences and
failed six unrelated footer/renderer assertions that also fail on unchanged
`a8fadafe`; those checks pass in an empty private agent directory. A seventh
failure exposed the optional tools missing from OpenPI's shared visibility
catalog; that catalog was corrected. Final gates use the isolated directory,
without editing the user's preferences or weakening the assertions.
