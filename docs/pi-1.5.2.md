# Pi 1.5.2 reconciliation

The installed CLI reports **1.5.2**. All four Pi development pins, the lockfile and local installed test packages move from **1.5.1** to **1.5.2**. Compatible `^1.0.0` peers and Node >=22.19.0 remain unchanged. No extension runtime patch was needed.

## Release review

Sources: the installed 1.5.2 changelog and session documentation, compared with the 1.5.1 extension types and native bash implementation.

- **Missing session directory:** interactive startup, resume, import and extension-driven session switching now offer Continue, Fork or Cancel. Fork creates a new session in the current directory rather than repeatedly asking about the missing original directory. Other modes still reject missing directories. pi-core does not override this upstream choice.
- **Import cleanup:** upstream removes failed imports instead of leaving duplicate copies with the same session ID.
- **Anthropic OAuth:** requests now report the updated Claude Code version. No credentials, provider settings or authentication implementation were changed locally.
- **Extension/background compatibility:** the public extension types and native bash implementation are byte-identical to the 1.5.1 baseline. Automatic handoff, steering completion delivery and child isolation require no adaptation.
- **Dependency scope:** only the eight Pi-family packages change versions, including codemode, MCP, schema and telemetry transitives. No unrelated or security-sensitive third-party dependency versions changed. The locked install reports zero vulnerabilities.

## Verification and limits

On Node 24.19.0, `make install`, `make format`, `make pack` and `make compat-package` all passed:

- **480 passing tests**, with the two optional Headroom engine tests skipped.
- Strict TypeScript, review-skill synchronization and Fallow passed.
- The packed package loaded all **21 extensions** through Pi 1.5.2; Python caches remain excluded.
- `git diff --check` passed.

The existing optional-chain lint warning in `extensions/translate/text.ts` remains advisory. npm also reports three unapproved dependency install scripts; approvals were not changed. No check failed. No hosted model calls, live OAuth request or manual missing-directory TUI flow was exercised. `make compat-latest` was not run because the target is the exact 1.5.2 release.

The CLI version and dependency baseline were verified separately; the running harness version was not independently established from its process executable. If the core was upgraded without a full restart, restart with the updated CLI and resume this session. `/reload` refreshes extensions, not the running core. No global installation, settings or credentials were changed by this patch.
