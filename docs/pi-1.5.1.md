# Pi 1.5.1 reconciliation

The installed CLI reports **1.5.1**, and the user restarted the interactive harness after upgrading. All four Pi development packages are now pinned to **1.5.1**, with npm regenerating the lockfile. Compatible `^1.0.0` peer ranges and Node >=22.19.0 remain unchanged.

Sources: the installed 1.5.1 changelog, extension documentation, public types and native bash implementation, compared with the locked 1.5.0 baseline. No global installation, credentials or settings were changed.

## Relevant changes

- **Grep/read:** grep context now comes from ripgrep, globs resolve relative to the search path, and read streams large files. The deprecated `GrepOperations.readFile` callback no longer supplies context. Our session-CWD wrapper delegates to the native factories and does not implement these callbacks, so no migration is needed.
- **Bash:** timeouts now explain when the shell already exited but a child kept writing to its pipes. The in-progress automatic-background integration uses Pi's native operations and tool factory, retaining this diagnosis. A regression exercises shell exit code 7 followed by a pipe-holding child and verifies the final `timed_out` result includes the upstream explanation.
- **Lifecycle:** RPC idle shutdown, cleanup during signals, active-tool disposal ordering and reload synchronization are fixed upstream. No child tool permissions, direct-only parent questions or handoff boundaries were changed locally.
- **Codemode/templates:** upstream fixes schema-reference handling, Unicode truncation and quoted template arguments. Our pending bash result remains an explicit `running` result without an exit code; native output schemas remain in use for finished commands.
- **Defaults/features:** cache warming now defaults to `idle` and can keep eligible caches warm for up to 30 minutes. Anthropic message threads, shell auth commands, Mermaid rendering and package-update summaries require no local adaptation. No setting was changed to opt into or out of these features.
- **Dependencies:** the Pi family moves together to 1.5.1, including codemode, MCP, schema and telemetry transitives. The renderer changes from grok-mermaid to lovely-mermaid 0.3.3. Other existing dependency versions are unchanged; npm's locked install reports zero vulnerabilities.

No extension runtime patch was required specifically for 1.5.1. The automatic-background work additionally changes completion delivery to `deliverAs: "steer"` with `triggerTurn: true`: results arrive at the next safe model boundary during work, or resume an idle agent. Completions from the same event-loop tick coalesce, active waiters can consume results first, and later batches are released when the previous receipt reaches session history. Shutdown cancels scheduled delivery. Package-content inspection also revealed generated Python caches in the tarball; package and Git exclusions now omit `__pycache__` without deleting local files or changing skills.

## Verification

- `make install`, `make format`, `make pack` and `make compat-package` against the exact 1.5.1 pins.
- **480 tests passed, 2 optional tests skipped**; strict TypeScript and Fallow passed. The pre-existing optional-chain lint warning in `extensions/translate/text.ts` remains advisory.
- The packed package loads all **21 extensions** through Pi 1.5.1. A separate package-content assertion checks that the foreground adapter is included and Python caches are excluded.
- A live command in the restarted interactive session ran for 30 seconds, handed off after 10 seconds, and continued producing searchable progress logs through completion. This test required no additional hosted model request. Its notification originally waited for idle; the subsequent steering change is covered by delivery tests and a real native bash handoff test that receives completion while its parent context remains busy. The updated steering behavior has not been visually retested in a reloaded TUI.
- `git diff --check`.

The initial version-inspection command tried a package.json subpath not exported by pi-ai; reading the manifests directly resolved that inspection failure. No compatibility gate failed. `make compat-latest` was intentionally not run: this upgrade targets 1.5.1, not the moving latest tag. No live RPC/provider test or new hosted child session was started for this upgrade.

The harness restart is already complete. Reload extensions when ready to use updated package resources; wait for active attached processes to finish first, since reload stops them.
