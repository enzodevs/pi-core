# Pi 1.5.0 reconciliation

The installed CLI reports **1.5.0**. All four Pi development pins move from 1.4.0 to the explicitly requested 1.5.0, with npm regenerating the lockfile. Compatible `^1.0.0` peers and Node >=22.19.0 remain unchanged. No extension runtime patch was needed.

Sources: the installed 1.5.0 changelog and extension documentation, matching installed public types, local extension code, and local integration tests. No global installation, settings, credentials, or skills were changed.

## Release review

- **Tool validation (breaking change):** Pi now validates JSON Schema through `@earendil-works/pi-schema`. pi-core already imports TypeBox directly and uses JSON-compatible schemas; no tool schemas use refinements, codecs, non-JSON types, or custom TypeBox formats. A new regression test passes the actual question-tool schema through Pi's validator, checking optional-null removal, boolean and array coercion, required fields, nested string constraints, and length/item limits. Tests avoid depending on the old validation-error wording.
- **Imports and built-in tools:** the removal of TypeBox re-exports from the published pi-ai root needs no migration here. Strict typechecking and session-CWD integration cover the wrappers around Pi's built-in tool definitions.
- **Execution and rendering:** upstream adds bounded `pi.exec()` output with a `truncated` result, fixes timeout escalation, UTF-8 decoding and spawn errors, and improves streaming/rendering. Existing callers remain compatible. pi-core has no imported `keyHint`/`keyText` calls needing migration to the newly injected render-context helpers.
- **Child isolation:** no child tool permissions, direct-only `ask_parent` behavior, disabled child classifier/image APIs, MCP inheritance, or bounded handoffs were changed. Existing real-codemode and subagent tests continue to cover this flow; no sandbox implementation was copied locally.
- **Security:** the lockfile picks up Pi's `undici` 8.10.2 → 8.12.3 and `minimatch` 10.2.6 → 11.0.3 updates, plus `@isaacs/nonrecursive-glob-match` 1.0.3 and the new pi-schema 1.5.0 package. Other existing non-Pi package versions are unchanged. Trust-decision, OAuth URL, and terminal-title fixes are upstream harness behavior, not local patches.
- **Optional features:** package-update changelogs, custom self-update commands, blocked-dialog status, usage provenance, and new model/provider support do not require pi-core changes. No new settings or tools were added just to expose upstream features.

## Verification and limits

Verified on Node 24.19.0:

- `make install` and `make format`.
- `make pack`: skill synchronization, formatting, strict TypeScript, **547 passing tests**, Fallow, and published-content inspection.
- `make compat-package`: packed, installed, and loaded all **21 extensions** through Pi 1.5.0.
- `git diff --check`.

Two intermediate `make pack` attempts caught TypeScript errors in the new regression test helper and its inferred test-case union (`unknown`/optional `undefined` were not valid JSON arguments). Both were corrected using Pi's `ToolCall["arguments"]` type before the final verification.

Two optional Headroom integration tests remain skipped because their Python runtime is not configured. These checks include local real-codemode integration, not hosted model/classifier/image calls or manual live RPC/TUI interaction. `make compat-latest` was not run: this review targets the exact requested 1.5.0, not the moving latest tag.

The audit reports eight vulnerable entries (one low, two moderate, three high, two critical): Fallow, music-metadata, sharp, source-map-js, Vite, Vitest, @vitest/mocker, and tinypool. These remain unresolved; no broad audit fix or unrelated dependency upgrade was applied. Formatting retains two existing advisory warnings, and npm reports four dependency install scripts without allowScripts approvals; no approvals were changed.

Reload extensions after updating pi-core. If the running harness predates the upgrade, fully restart Pi 1.5.0 and use `pi --resume`; `/reload` does not replace the running harness.
