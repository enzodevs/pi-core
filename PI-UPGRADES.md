# Pi harness upgrades

Use this workflow when the user says “Pi updated”, “a new Pi version is out”, or asks to adapt pi-core. Run maintenance in the pi-core repository, not an unrelated project or an installed package's `node_modules` directory.

A version announcement or compatibility question authorizes investigation, not edits. A request to update/adapt pi-core authorizes dependency updates, necessary compatibility fixes, and verification. Do not update the user's global Pi installation, migrate credentials, enable providers/MCP, commit, or push without authorization covering that action.

## 1. Identify the versions

- Check `command -v pi` and `pi --version`: these identify the CLI selected by the current shell, not necessarily the running session's harness.
- Read the four Pi development pins and peer ranges in `package.json`, and the resolved versions in `package-lock.json` / `node_modules`.
- Treat installed CLI, running harness, locked test baseline, and requested target as separate facts. Multiple Node/Pi installations can coexist. If needed, inspect the tool shell's parent PID, start time, and executable without reading process environments or credentials.
- `/reload` refreshes extensions/resources, not the running Pi core. If the harness was updated after this process started, recommend restarting the updated CLI and selecting the current session with `pi --resume`. Do not terminate it yourself.

Use an explicit requested release when provided; otherwise identify the installed release. Do not silently substitute `latest` for a known target.

## 2. Review the release

Read the matching installed Pi `CHANGELOG.md`, relevant `docs/`, examples, and public types. If unavailable, fetch primary upstream release/docs sources. Do not send private repository content or secrets to external research. The cached upstream snapshot mentioned in `AGENTS.md` may be stale; verify its version before using it.

Focus on changed extension APIs, event ordering, tool exposure/schemas, codemode, CWD/read behavior, RPC/TUI children, providers, Node requirements, and security fixes. A patch version or green typecheck alone does not prove compatibility. Reuse upstream fixes instead of copying sandbox/provider implementations into pi-core.

## 3. Apply an authorized update

Keep these four development packages pinned to the same exact target release:

- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-ai`
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`

Use npm to regenerate the manifest/lockfile together; never hand-edit lockfile integrity data. For example, replace `1.0.1` below with the confirmed target:

```bash
PI_VERSION=1.0.1
npm install --save-dev --save-exact --ignore-scripts --no-audit --no-fund \
  "@earendil-works/pi-agent-core@$PI_VERSION" \
  "@earendil-works/pi-ai@$PI_VERSION" \
  "@earendil-works/pi-coding-agent@$PI_VERSION" \
  "@earendil-works/pi-tui@$PI_VERSION"
```

Inspect the resulting dependency diff and resolved security-sensitive transitives. Do not use broad `npm audit fix --force` or upgrade unrelated dependencies. Keep compatible peer ranges unless evidence requires changing the supported range; a development baseline bump alone is not a reason to raise the minimum. Update the tested baseline in `README.md`. Add runtime changes/regressions only for concrete API or behavior differences.

Preserve child tool allowlists, direct-only `ask_parent`, disabled child classifier/image APIs, no implicit MCP inheritance, and bounded parent handoffs. Do not add parent-facing upgrade/delegation flags or repeated prompt instructions.

## 4. Verify through the stable interface

Run `make install`, `make format`, `make pack`, and `make compat-package`. These install the locked baseline, run required gates, inspect published contents, and load every packed extension through Pi. Exercise local integration tests for affected behavior; do not silently run hosted model/classifier/image requests or incur provider spending.

Use `make compat-latest` when checking the newest published release is relevant. It uses the moving npm `latest` tag, not necessarily the requested target, so distinguish its result from locked-target verification. Compatibility commands require network access for npm dependencies but do not publish the package. Temporary workspaces are cleaned by default. If `PI_CORE_KEEP_COMPAT_TEMP=1` is needed to inspect resolved versions or diagnose failures, remove the task-owned workspaces afterward, including nested package-smoke workspaces.

Save full check logs, preserve exit statuses, and report failures even if a later unchanged rerun succeeds. Follow `CONTEXT-HYGIENE.md`: return conclusions, not logs or child transcripts.

## 5. Close the loop

Inspect the final diff and `git diff --check`. Report the target/tested versions, concrete changes, checks actually run, skipped tests, and remaining limits. Distinguish live reload observations from local sandbox tests and from hosted RPC/TUI runs. Remind the user about a full harness restart when relevant. Review before any requested commit/push; otherwise leave changes uncommitted. Do not retain routine backups or change unrelated global prompts/settings.
