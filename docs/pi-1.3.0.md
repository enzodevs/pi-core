# Pi 1.3.0 reconciliation

The four Pi development packages and their locked Pi transitives move from 1.2.0 to **1.3.0**, matching the installed CLI. Compatible `^1.0.0` peer ranges and Node >=22.19.0 remain unchanged. No extension runtime patch was needed.

Sources: the installed 1.3.0 coding-agent changelog, CLI/settings and extension documentation, and the existing child launch and tool-exposure implementation/tests. No cached upstream snapshot or global configuration changes were needed.

## Compatibility review

- **Resumed active tools:** upstream now restores tools activated during a session. Plain-name `--tools` still explicitly replaces selection. Child RPC/TUI launches already supply the complete allowlist, including on resume; no additive flags or broader tool inheritance are needed. Direct-only `ask_parent`, disabled child model APIs, and existing MCP isolation remain intact.
- **Codemode:** cancellation and live-worker admission fixes belong upstream. Keep the existing sandbox and bounded output; do not copy worker management into pi-core. Local runtime tests pass against the updated implementation.
- **Overlays and read labels:** upstream fixes overlay ownership and numeric-string/null read-range labels. No compensating local patch is required.
- **Providers and model switching:** cache preservation, dropping earlier models' thinking, model-provider disambiguation, malformed argument validation, image error results, provider endpoints, thinking levels and transient retries are harness fixes. No provider, credential, model catalog override, or account changes were made. External Kimi Code base URL overrides now require `/v1`.
- **Sharing:** `sessionShareDestination` is optional upstream configuration; pi-core needs no default or migration.
- **Dependency consistency:** upstream now pins internal Pi dependencies exactly. The npm-generated lockfile updates seven Pi packages only; unrelated dependencies and their resolved versions remain unchanged.
- **Other fixes:** Nix packaging, prompt-template empty arguments and print/export rendering require no pi-core implementation changes.

## Verification and limits

Passed on Node 24.19.0 against the locked 1.3.0 target:

- `make install` and `make format` (no formatting changes; two existing advisory lint warnings).
- `make pack`: skill synchronization, formatting, strict types, **526 passing tests**, Fallow and package-content inspection.
- `make compat-package`: packed, installed and loaded all **21 extensions** through Pi.

Two optional Headroom integration tests were skipped because their Python runtime was not configured. No hosted model/classifier/image calls or manual remote TUI/clipboard checks were performed. `make compat-latest` was not run because this review targets the explicitly requested 1.3.0, not the moving npm tag.

`make install` still reports six vulnerable dependency entries (two moderate, two high, two critical). Non-Pi dependency versions are unchanged by this update; these findings need separate security maintenance, not a forced broad upgrade. npm also warns about four dependency install scripts without allowScripts approvals; no approvals or global settings were changed.

Reload extensions after updating pi-core. If the running harness predates the upgrade, fully restart Pi 1.3.0 and use `pi --resume`; `/reload` does not replace the harness.
