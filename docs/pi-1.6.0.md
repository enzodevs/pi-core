# Pi 1.6.0 reconciliation

The installed CLI reports **1.6.0** (updated from 1.5.2 with `pi update self`). All four Pi development pins, the lockfile and local installed test packages move from **1.5.2** to **1.6.0**. Compatible `^1.0.0` peers and Node >=22.19.0 remain unchanged. No extension runtime patch was needed.

## Release review

Source: the installed 1.6.0 changelog, checked against pi-core's extension code.

- **Breaking: `render()` returns `readonly string[]`, and `Container` caches its array.** Every pi-core component that renders another component (`ui/presentation.ts`, `image-clipboard`, `ask-user-question`, `skill-manager`) copies the result (spread, `map`, `filter`, `lineWindow`) instead of mutating it, and strict TypeScript accepts all of them against the 1.6.0 types. No `Container` subclass calls `super.render()`.
- **`pi.exec` reports 128 + signal for signalled commands** instead of 0. pi-core callers (`memory`) only treat `code === 0` as success, so signalled commands are now correctly treated as failures.
- **`find` path patterns are relative to the search directory.** pi-core does not wrap or rewrite `find` patterns.
- **RPC/JSON `session_start` fixes, diagnostics and Esc during tool batches** change upstream behavior only; pi-core's session handlers need no adaptation.
- **New models:** GPT-6.2 Astra and GPT-6.2 Sol on `openai`, `azure` and `openai-codex`; Sol becomes those providers' default. No provider settings were changed.
- **Dependency scope:** the Pi-family packages, plus upstream-driven `@google/genai` 2.32.0, `openai` 7.59.0 and `undici` 8.12.4 (security advisories). No unrelated dependency changed. The locked install reports zero vulnerabilities.

## Verification and limits

`make install`, `make format`, `make pack` and `make compat-package` all passed:

- **526 passing tests**, with the two optional Headroom engine tests skipped.
- Strict TypeScript, review-skill synchronization and Fallow passed.
- The packed package loaded all **22 extensions** through Pi 1.6.0.
- `git diff --check` passed.

No hosted model calls were made by the checks. `make compat-latest` was not run because the target is the exact 1.6.0 release. `/reload` refreshes extensions, not the running core: restart running sessions with the updated CLI.
