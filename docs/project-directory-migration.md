# Moving a project directory and its Pi sessions

Use this runbook when renaming or moving a local project while keeping its existing Pi sessions, IDs and history. This is a maintenance operation, not a branding replacement across source code, domains or conversation text. A helper can follow it without a dedicated extension or skill.

Validated with Pi **1.5.2**. Inspect the installed version's session documentation and implementation before applying it to a different format. This guide does not authorize a migration by itself: a request for a dry run remains read-only.

## Choose the intended behavior

Pi records the original working directory in each session header. If that directory disappears, the interactive 1.5.2 harness offers:

- **Continue:** use the current directory for this run, without permanently changing the session's recorded CWD.
- **Fork:** create a new session with a new ID, linked to the current directory; leave the original intact.
- **Migration:** the maintenance procedure below relocates existing sessions without changing their IDs.

`pi --resume` initially lists sessions for the current folder. Tab switches to all folders. Non-interactive modes reject a missing stored CWD rather than offering the interactive choices.

## 1. Read-only dry run

Agree on absolute source and destination paths, including which parent directories remain unchanged. For example:

```text
/home/user/projects/old-name → /home/user/projects/new-name
```

Report, without changing anything:

1. Whether the source exists and whether the destination already exists. Stop on conflicts; do not silently merge directories or overwrite sessions.
2. Active Pi sessions, agents, watchers, servers and shells using the source or its descendants. Also inspect Git worktrees and any external configuration known to use the path.
3. Session files associated with the exact source CWD and descendant CWDs, their IDs, sizes and proposed destinations. Match path boundaries, not arbitrary string prefixes. Review stale worktree/subproject sessions rather than assuming every descendant directory still exists.
4. Header `parentSession` references that point to session files being moved, including known links from sessions outside the moving project. Expanding the inventory to inspect such links should be explicit. Report unresolved references instead of claiming all links were repaired.
5. Conflicts in the destination session storage, malformed headers and custom session-storage overrides.
6. Whether the project has a CC2 index. If it does, include the optional section below.

Pi normally groups session files beneath `~/.pi/agent/sessions/` using an encoded absolute CWD. Custom `--session-dir`, `PI_CODING_AGENT_SESSION_DIR` or `sessionDir` settings can change that. Resolve the actual storage convention from the installed Pi, rather than assuming a global text replacement will find everything. Directory names are discovery hints; verify the JSONL headers.

## 2. Apply the authorized migration

Run the helper from **outside** the moving directory. Close affected sessions and stop their processes/watchers first; do not rewrite a session that another process may append to. Uncommitted project work can move with the directory and must be preserved, not reset or cleaned.

A backup is **optional**, not a prerequisite. The required safeguards are a conflict-free plan, exclusive access to affected files, atomic file replacement and post-migration verification.

1. Rename/move the project directory to the agreed destination.
2. For each affected session, change only the header `cwd` to the new path, preserving any descendant suffix.
3. Update header `parentSession` values using the explicit old-session-file → new-session-file mapping. Change only references whose targets moved; do not replace unrelated parent links.
4. Preserve the session ID, version, timestamps, entry IDs and the entire body after the header. Do not rewrite historical system prompts, commands, messages or tool results containing old paths.
5. Write each changed file through a private temporary file and atomic replacement, preserving permissions and, where practical, file modification times. Move the session storage to the location expected for the new CWD. If custom storage stays in place, its files may need only header changes.
6. Check known project integrations separately: saved trust decisions, launcher paths, worktree metadata and local services may still refer to the old location. Other harnesses, such as Claude, need their own session-migration procedure.

Atomic replacement protects an individual file, not the entire multi-file operation. Keep track of completed steps; on failure, stop and reconcile the actual state before retrying. Do not blindly rerun a partially completed move. Cross-filesystem moves require explicit copy/validation handling rather than assuming an atomic directory rename.

Historical absolute paths remain historical. A recovered session may mention old paths even though new relative tool calls resolve correctly. Terminalized child/process history is not a promise to revive old runtime resources.

## 3. Validate before reopening work

- The planned sessions are discoverable under the new CWD, with the same IDs and no unintended duplicate active copies in the old location.
- Only intended header fields changed; the body of each migrated JSONL file is byte-identical to its pre-migration body. Compare hashes recorded during the dry run if not retaining full originals.
- Updated parent links resolve; existing broken or out-of-scope links are reported separately.
- `pi --resume` from the new directory lists the migrated sessions in **Current Folder**. Verify a representative session using `/session` and relative file access.
- Preserve model/provider settings. A real model-backed continuation is optional and should be explicitly authorized; listing and structural validation do not require a hosted request.

### Local experiment

A real Pi session created two files in a temporary project. After the directory was renamed, non-interactive resume failed with `Stored session working directory does not exist`, and the new CWD's session list was empty. After changing the header and moving storage, `pi --continue` resumed the same ID, recalled a word from the prior conversation, read a relative file and wrote another file in the new directory. The original history body was preserved byte for byte. Session discovery was verified through Pi's session manager; the interactive picker was not visually tested in that experiment.

## Optional: relocate an existing CC2 index

Moving the project does **not** mean moving the CC2 installation itself. Keep the existing index and embeddings when only the project's root path changes.

### Inspect first

- Use `cc2 list` to identify the exact project ID and registered root, plus current file/chunk counts. Use `cc2 watchers` to identify active watchers.
- Inspect the installed CC2 version/source and storage schema. Do not treat the implementation details below as a permanent public migration API.
- Check `.cc2` and `.cc2config`; relative inclusion rules/scopes generally move with the project unchanged.
- Keep the existing **project ID** unless renaming that identity is a separate explicit requirement. An index named `old-name` can legitimately point to a directory named `new-name`.

In the CC2 implementation inspected for this guide, code records use relative file paths, while absolute roots are stored in `cc2_corpora.source_root` and `code_files.project_root`. Audit associated graph/memory metadata and all affected refs before deciding which rows need changes. Updating only the displayed corpus root is not enough to establish that every consumer has moved.

### Relocate without rebuilding embeddings

1. Pause the applicable watchers before moving the directory or updating metadata. A global watcher also serves other projects; account for that temporary interruption.
2. Apply a scoped, transactional metadata update for the agreed project ID, refs and old root, including any additional affected path metadata found during inspection. Verify expected row counts and destination conflicts before committing the transaction. Use a supported relocation command if the installed release provides one; no dedicated relocation command was found in the inspected CLI.
3. Preserve relative paths, file/chunk identities and embeddings. Do not use `cc2 delete` followed by `cc2 index` just to rename a directory, or run an unbudgeted reindex as a migration shortcut.
4. Restart watchers against the new root. In the inspected implementation, the global watcher refresh loop detects added/removed project IDs but does not rebuild an existing task solely because its root changed.
5. Confirm `cc2 list` shows the new root with unchanged index counts, then use `cc2 check <existing-id>` for a non-indexing consistency check. Account for pre-existing WIP/index drift rather than treating every reported change as a migration defect. Verify CWD-to-project inference; any hosted semantic query or actual sync is a separate, authorized validation step.

The aim is to move location metadata, not regenerate unchanged content. If inspection reveals that a particular CC2 version requires more than that, report the additional scope before applying it.
