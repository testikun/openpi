# Maka embedded-browser experiment

Development experiment on `codex/maka-embedded-browser`, based on OpenPI
`a8fadafe2519414ab92b2c6f20a59bfa7422c7f4`. It is a separate optional Pi package,
not a new default or a replacement for the service on port 57161.

The six model-facing tools follow Apache Maka's
`apps/desktop/src/main/browser/browser-tools.ts` at
`173f1e7397ded73cdfc8f362e89858602e073ef4`:

- `browser_navigate`
- `browser_snapshot`
- `browser_click`
- `browser_type`
- `browser_wait`
- `browser_extract`

Their names and parameter shapes are ported to Pi's native tool registration.
OpenCLI **1.8.6**, the same frozen dependency used by that Maka checkout, supplies
the real DOM snapshot, ref matching, click, fill, wait and HTML-to-Markdown code.
`MakaBrowserPage` adapts its public `Page` API to OpenPI's existing frame transport.
No Electron runtime, OpenCLI daemon, second CDP WebSocket server, desktop helper,
provider stack, or model-specific schema is introduced.

## Scope and authority

Use a **separate Pi agent directory and Web port**. Load exactly one OpenPI source
and this local package in that profile. Do not also load `pi-computer-use` for the
comparison: the model should see these six browser tools, without the original
eleven. Browser Bridge must be loaded from this worktree's
`web/browser-extension`; this experiment also enables awaiting asynchronous
frame evaluations for OpenCLI's condition waits.

The existing `/openpi-setup` browser grants remain required:
`browser_control=true`, `browser_embedded=true`, `browser_default=embedded`.
Grants remain off in a fresh ordinary profile. Existing user profiles and
preferences must not be edited to run this experiment. The package is excluded
from child resources before import, and all six tools are parent-only.
They are registered inactive and are enabled at Session start only with the
existing embedded grants and embedded default. Runtime grant checks remain
authoritative for every operation, including revocation during a Session.

Only one embedded page is supported per initiating Session/controller. Closing
or changing that page does not select an unrelated page. Numbered refs require a
snapshot of the current document. Input retains the existing Session, turn,
controller, document and consumed-state checks. Cancellation is forwarded;
concurrent use of one page is rejected. An uncertain input failure is propagated
without silently trying a second input path.

## Intentional limitations

This is the **six-tool Maka baseline**, not all of OpenCLI's capabilities.
It has no file-upload tool, native select-option tool, general keypress tool,
drag tool or model-facing screenshot tool. Textarea newlines and optional Enter
submission are supported through `browser_type`. The broader OpenCLI library
contains APIs that this model surface does not expose; their existence does not
establish model usability here.

Real Chrome also reproduces `browser_type` refusing `<input type="number">` in
OpenCLI 1.8.6. The original numeric input remains in the fixture and its rejection
is recorded; it is not replaced with a text input to claim numeric-form support.
This baseline therefore cannot complete the earlier simulation form unchanged.

Transport output is bounded. Extraction uses a smaller HTML ceiling than Maka's
Electron implementation, and explicitly reports truncation. Very large DOM
snapshots can exceed the existing frame result budget and fail explicitly.
Nested application frames, production SSO, downloads outside the test fixture,
and native select popups need separate evidence. No visible virtual cursor is
added. A DOM match receipt does not establish a successful business operation.

## Validation

`tests/web/maka-browser.test.ts` loads the real optional package through Pi,
checks the six tools without the original plugin, and checks cancellation and
concurrent dispatch. The child-session drift guard includes this optional entry
point. Real Chrome and live-model evidence is recorded separately in
`docs/research/MAKA_BROWSER_EXPERIMENT_2026-10-23.md`; a package-load check is not
a live-browser acceptance result.

## Attribution

The tool behavior and interface are adapted from
[Apache Maka](https://github.com/apache/maka), revision
`173f1e7397ded73cdfc8f362e89858602e073ef4`, under Apache-2.0.
The source license and NOTICE are preserved in `LICENSE.maka` and `NOTICE.maka`.
OpenCLI is an unmodified dependency under Apache-2.0:
[jackwener/OpenCLI](https://github.com/jackwener/OpenCLI).
