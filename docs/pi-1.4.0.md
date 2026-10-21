# Pi 1.4.0 reconciliation

The installed CLI and npm's `latest` coding-agent release are **1.4.0** at review time. All four Pi development pins and seven resolved Pi packages move from 1.3.0 to 1.4.0. Compatible `^1.0.0` peers and Node >=22.19.0 remain unchanged. No extension runtime patch was needed.

Sources: the matching installed 1.4.0 changelog, codemode and extension documentation, local extension wiring and real-sandbox integration tests. No cached upstream snapshot or global settings changes were needed.

## Native primitives review

- **Codemode and child isolation:** pi-core already uses upstream `createCodemodeExtension({ mode: "on", models: false })` for children, rather than maintaining a sandbox. Upstream 1.4.0 queues scripts when workers are occupied; deadlines include queue time. Retain upstream worker admission instead of adding retries or a second queue. Child tool allowlists, direct-only `ask_parent`, disabled classifier/image APIs, no implicit MCP inheritance, and bounded parent handoffs remain intact.
- **Classifier images:** upstream `models.classify()` now accepts images for supported models. Parent codemode can use this natively; no pi-core wrapper or always-active schema is necessary. Child paid model APIs remain deliberately disabled. No provider spending or credentials changes were made.
- **Concurrent dialogs:** upstream now preserves pending interactive dialogs instead of replacing them and leaving unresolved promises. pi-core continues using native UI primitives; no local dialog stack is needed.
- **Restored tools:** upstream fixes activation of newly registered extension tools on resumed sessions and tree navigation. Keep explicit child tool selections; do not broaden child permissions as a workaround.
- **Compaction and providers:** output-limit summaries, split-turn compaction instructions, provider attribution, retry handling, truncated tool-call recovery and whitespace-only tool results are harness fixes. pi-core does not override the changed summary functions or attribution hooks and needs no compensating implementation.
- **Rendering, clipboard and built-in tools:** terminal teardown, clipboard process handling, grep configuration isolation, autocomplete regex escaping and CJK Markdown fixes belong upstream. The only added non-Pi locked package is `marked-cjk-friendly@0.1.2`, required by Pi TUI; all existing non-Pi versions are unchanged.

## Verification and limits

Passed on Node 24.19.0:

- `make install` and `make format` (no formatting changes; two existing advisory warnings).
- `make pack`: skill synchronization, formatting, strict TypeScript, **541 passing tests**, Fallow and published-content inspection.
- `make compat-package`: packed, installed and loaded all **21 extensions** through Pi 1.4.0.
- `make compat-latest`: independent temporary installation against the moving npm latest tags, typecheck, **541 passing tests**, package inspection and loading all **21 extensions**.
- `git diff --check`.

The test suite includes real upstream codemode batching, failure handling, tool exposure and session-CWD integration. Two optional Headroom integration tests were skipped because their Python runtime was not configured. These are local tests, not hosted model/classifier/image calls or manual live RPC/TUI interaction checks.

`npm audit` reports seven vulnerable entries (two moderate, three high, two critical), including development tooling and transitive dependencies. Existing non-Pi dependency versions are unchanged; resolving these findings needs separate targeted security maintenance, not a forced broad upgrade. npm also reports four dependency install scripts without allowScripts approvals; no approvals were changed.

Reload extensions after updating pi-core. If the running harness predates the upgrade, fully restart Pi 1.4.0 and use `pi --resume`; `/reload` does not replace the harness.
