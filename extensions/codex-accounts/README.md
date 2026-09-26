# Personal Codex accounts (opt-in)

Requires Pi / pi-ai 0.87.x. This extension is deliberately absent from the package's auto-loaded extension list. It registers only `/codex-accounts`, `Ctrl+Alt+A`, and a session-state restoration handler. No tools, model prompts, message injection, or polling.

## Enable locally

From this checkout:

```sh
pi -e ./extensions/codex-accounts/index.ts
```

For permanent personal installation, add the **absolute path** to `extensions/codex-accounts/index.ts` to the `extensions` array in `~/.pi/agent/settings.json`, or create a user extension that re-exports its default export. Do not load it both ways. Use `/reload` after enabling.

## Enroll and switch

The existing Codex OAuth login in Pi's `auth.json` appears automatically as **Login padrão do Pi**, marked **● (ativa)** when the session uses `openai-codex`. No enrollment or token copy is needed for that account. Its 5-hour/weekly usage is queried alongside saved accounts; Pi itself owns any required refresh. Choose that row to switch back from a saved account. It cannot be removed through this extension: use Pi's `/logout`. The row follows subsequent `/login` changes rather than retaining a snapshot of an old login.

For additional accounts:

1. Keep each ChatGPT account signed into its own Chrome profile.
2. Open `/codex-accounts` (or `Ctrl+Alt+A`). Choose **Adicionar conta**, give it a recognizable label, then **Browser login**.
3. Open the displayed OAuth URL **in the intended Chrome profile**, not necessarily the browser's default profile. This is OAuth with PKCE, not an emailed magic link. Pi receives the callback on `localhost:1455`; if needed, paste the redirect URL into the **TUI login dialog**, never into an agent message. A device-code option is also provided by Pi (subject to account support).
4. Repeat for all accounts. Adding does not activate the account. Duplicate account IDs are rejected without overwriting an existing login.
5. With an OpenAI Codex model selected, open an account and choose **Usar nesta sessão**. The current model is retained under the private `codex-accounts` provider. Pi-core Fast mode remains compatible (it now recognizes the Codex API rather than a single provider name). No reload is needed to switch.

Use ↑/↓, Enter, and Esc in the native Pi menus. **Atualizar limites** refreshes on demand; Esc cancels the progress dialog. Each row shows remaining 5-hour and weekly percentages and available **reset credits**, when returned by OpenAI. The reset count is `rate_limit_reset_credits.available_count` from the same read-only usage request; zero is displayed as zero, and missing/invalid counts are “não informado”, not assumed zero. These are redeemable reset credits, not the scheduled window-reset timestamps. This extension never consumes them. Opening a row shows exact usage, local-time reset dates, and the observation time. Missing windows are explicitly “não informado”, never assumed unlimited. These are the main Codex windows, not model-specific/additional or code-review quotas. The response contains percentages, not a guaranteed remaining number of requests/tokens.

Choose **Renomear conta** in any account's submenu to set a local name (1–60 characters), including the active/default Pi account. Renaming does not log in again, change tokens, change the selected model, or rename the account at OpenAI. Saved-account names stay with their vault record; default-login aliases are stored under `piLabels` in the private vault, keyed by account ID so a different `/login` does not inherit another account's name. Old vault files without aliases remain compatible.

**Usar login padrão do Pi** restores normal Codex auth. Remove an inactive account through its submenu, with confirmation. Removing only deletes local credentials; revoke the authorization separately through OpenAI if needed. For an expired/revoked login, switch away, remove, and enroll again.

## Isolation and security

- Newly enrolled account tokens live in `~/.pi/agent/pi-core/codex-accounts/accounts.json` (directory `0700`, file `0600`); the existing Pi login remains in Pi's `auth.json`. This is filesystem protection, **not encryption or an OS keychain**. Processes running as your user/root and backups can read it. Never commit, paste, or share this directory.
- Updates use private temporary files and atomic rename. `proper-lockfile` serializes changes and refreshes across Pi processes, with stale-lock recovery. Successful refresh results are persisted even if cancellation arrives after token rotation.
- The extension reads the default Codex credential through Pi's public `readStoredCredential` API (honoring `PI_CODING_AGENT_DIR`) only to identify the existing login. Tokens are never copied into the vault. Usage for that row resolves auth through Pi's model registry, which owns refresh and any resulting `auth.json` updates. Resolving a saved account still uses a separate provider ID and cannot accidentally refresh/use the normal login.
- Each session chooses its own account; selecting does not change other running sessions. Pi custom entries retain only account ID/model ID for reload/resume and are excluded from model context. No tokens, labels, or limits are stored in the transcript. New sessions do not inherit a selection. A removed account cannot silently fall back to a different vault account.
- Quotas are requested only when opening/refreshing the menu or after enrollment. Requests use a fixed HTTPS origin, reject redirects, have timeouts and a 128 KiB response cap. Raw auth/server errors are not displayed because they may contain secrets.
- No browser cookies are read; no browser profile is automated; no automatic quota-driven account rotation occurs.

## Implementation and limitations

`store.ts` owns private persistence and credential-store adapters; `service.ts` reuses Pi's OAuth and locked-refresh orchestration; `pi-account.ts` references the existing host login without duplicating credentials; `usage.ts` owns the usage endpoint and validation; `index.ts` owns TUI and session wiring. Accounts are not hard-coded to three.

OAuth and provider behavior were verified against installed Pi 0.87.0 docs/types/source. A credential-free RPC smoke test also loaded the extension successfully in the installed personal CLI, 0.87.1. The usage endpoint is internal and may change or reject requests: errors become unavailable status, not fabricated quota values. Automated tests use fixtures and fake credentials; real browser authorization and live quota values require your login.

Primary references:

- Pi `@earendil-works/pi-ai/README.md`: OAuth Providers and Credential Store.
- Pi `@earendil-works/pi-coding-agent/docs/extensions.md`: native providers, commands, dialogs, and custom entries.
- [Official Codex backend client](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client.rs): ChatGPT auth headers and usage calls.
- [Codex reset-credit types](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/types.rs) and [read-only usage flow](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/rate_limit_resets.rs): `available_count` semantics, also verified in the local opensrc `openai/codex/main` snapshot. That snapshot has no release identity; it is not claimed to match the installed Codex CLI 0.156.1 exactly.
