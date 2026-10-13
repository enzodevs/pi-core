# Pi 1.2.0 reconciliation

The development baseline moves from Pi 1.1.0 to **1.2.0** for all four pinned Pi packages. The CLI selected during this review also reports 1.2.0; Node is 24.19.0. Compatible `^1.0.0` peer ranges and the Node >=22.19.0 requirement remain unchanged.

Sources: the installed 1.2.0 `CHANGELOG.md`, extension/SDK/codemode/environment/theme documentation and public declarations. The complete [upstream release notes](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/CHANGELOG.md) were reviewed, not just the highlights. No cached upstream source snapshot was needed.

## Required patches

- **Memory startup:** `before_agent_start` is now a union. Idle runs started with `pi.sendMessage(..., { triggerTurn: true })` have `messageType: "custom"` and no `prompt`. Skip these before accessing the prompt, without consuming the session's opening memory lookup. User events from older supported Pi versions, which lack `messageType`, still work.
- **Codemode test setup:** the runner's `emitBeforeAgentStart` now takes a trigger object and system-prompt options, instead of three arguments. Update the local runtime fixture to use the public signature.
- **Regression coverage:** test custom starts before/after the opening memory query, blank prompts, and legacy user-event shapes. Exercise a custom-message run through the real local Pi session with managed skills, nested guides, and a tool continuation; assert that structured system sections persist unchanged.

The initial typecheck against 1.2.0 failed on exactly the memory prompt accesses and old test signature, confirming the migration points.

## Reviewed changes needing no pi-core patch

| Upstream area | Assessment |
| --- | --- |
| Startup concurrency and queued messages | Pi now marks startup busy, queues messages into the starting run, delivers pending `nextTurn` messages on custom starts, and preserves aborts. Our completion delivery checks `isIdle()` outside startup handlers and uses explicit delivery modes. Keep those guards; do not add a second startup lifecycle. |
| System sections on extension-triggered runs | Skill visibility and nested-guide startup context must apply to both user and custom starts; do **not** add user-only guards to these handlers. Upstream now preserves their sections after tools, avoiding prompt-cache churn. |
| Configuration schemas and stricter startup theme validation | pi-core ships no Pi theme JSON or affected schema URLs. No migration is needed here. External custom themes must use `https://pi.dev/schemas/theme.schema.json`, put reusable colors in `vars`, and omit unsupported metadata. Editor `$schema` entries for settings/models/keybindings are optional. |
| Tool reachability and namespace aliases | pi-core uses upstream codemode, not a replacement dispatcher or MCP discovery layer. Its own tools do not call other registered tools. No custom `reachesTools`/alias plumbing is needed. Child allowlists, direct-only interactive tools, disabled child classifier/image APIs, and no implicit MCP inheritance remain unchanged. |
| Codemode | Constraint comments, elapsed time, explicit MCP result declarations, misplaced-options rejection, linear output joining, and the Node watch bridge fix belong upstream. Existing tests cover nested calls, output bounds, structured bash failures, and tool isolation. Output-schema failures resolve with a value; callers must still inspect exit/error fields. No sandbox fork or duplicate schema prose. |
| Providers | Per-key/regional/offline OpenRouter catalogs and nonnegative router prices, Mistral stream timeout handling, Anthropic strict-tool fallback, and transient upstream-error retries are harness fixes. No provider implementation is copied into pi-core, and no account/provider configuration is changed. |
| MCP | Resource availability replaces counts; structured content may be non-object; canceled OAuth waits no longer send calls; unverifiable OAuth issuers fail closed; login timeout documentation is corrected. pi-core does not consume resource counts or implement these paths. The lockfile picks up pi-mcp 1.2.0. |
| Project context and resource paths | Symlinked worktree guides and `~` expansion in resource filters are fixed upstream. Keep existing trust, CWD, and nested-guide boundaries. |
| Compaction and print mode | Conversation serialization now omits thinking. Truncated print-mode output exits nonzero. pi-core's child transport is RPC/TUI, not print-output parsing, and memory evidence already excludes thinking. |
| TUI | Hardware cursor behavior, overlay scrolling, fragmented color replies, shifted-symbol shortcuts, Herdr inline images, and custom-editor compaction colors are upstream fixes. Keep the custom image editor and current attachment workflow; no compensating TUI patch. |
| Windows authentication | Lock-directory deletion retries are upstream; no local credential migration. |
| Removed experimental stack/chord | pi-core imports neither. npm removes the now-unused chord package from the lockfile. |
| Default system prompt | The installed 1.1.0 and 1.2.0 `dist/core/system-prompt.js` files are identical. No new default guidance needs transplanting into a custom prompt. Global prompts were not modified. |

## Remote clipboard: MOSH / WireGuard / tmux / Mac

Pi 1.2.0 adds `PI_CLIPBOARD_OSC52=1` to force an OSC 52 **text copy from Pi to the client terminal's clipboard**, even when SSH variables are absent (for example, attaching remotely to an existing multiplexer).

For an optional test, start Pi inside the remote tmux pane with:

```sh
PI_CLIPBOARD_OSC52=1 pi --resume
```

Then copy text using Pi and paste into a local Mac application. The terminal, MOSH path, and tmux must allow/forward the clipboard sequence; WireGuard alone does not provide clipboard transport. Setting the variable in another shell does not change an already-running Pi process.

This is **not** screenshot upload or reading the Mac's image clipboard. It does not replace the existing transfer/paste workaround or pi-core's image attachments. No shell, tmux, MOSH, clipboard, or global Pi settings were changed. End-to-end Mac clipboard behavior requires a manual test from that client and is not established by the automated tests.

## Verification and limits

Passed against the locked 1.2.0 target:

- `make install` and `make format` (two existing advisory lint warnings remain).
- `make pack`: formatting, strict types, skill synchronization, 501 passing tests, Fallow, and package-content inspection.
- `make compat-package`: packed, installed, and loaded all 20 configured extensions through Pi.
- `git diff --check`.

Two optional real-Python Headroom integration tests were skipped because `PI_CORE_HEADROOM_PYTHON` was not configured. Runtime tests use deterministic local streams, not hosted model calls or delegated agents. No hosted RPC/TUI run or end-to-end remote clipboard test was performed. The moving `make compat-latest` target was not run: this review targets the explicitly requested 1.2.0 release.

`npm ci`/`npm audit` also reported six **pre-existing, unchanged** vulnerable dependency entries: `music-metadata` 11.15.0 and `sharp` 0.35.4 (runtime); `source-map-js` 1.2.1, `tinypool` 1.1.1, `@vitest/mocker` 3.2.7, and `vitest` 3.2.7 (development). Audit reports two moderate, two high, and two critical entries, including inherited findings. These are not introduced by the Pi update; audit is not clean. Fixing them is a separate dependency/security maintenance task, including a major Vitest migration rather than `npm audit fix --force`. No unrelated dependency upgrades were folded into this reconciliation.

Reload extensions after updating pi-core. If the running harness predates the CLI upgrade, fully restart the updated CLI and resume the session; `/reload` does not replace the Pi core.
