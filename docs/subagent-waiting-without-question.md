# Subagent remains `waiting` after completing work

## Observed behavior

During work in `/home/rrghost/SoftEng/sabbadini.co`, multiple `worker` subagents created with `background_agent` completed repository work but never emitted a completion result. `agent_control status` reported them as `waiting` for more than 30 minutes even though there was no pending question.

Observed on 2026-09-20:

- Run `9ad3340036d5` committed `b888745` (`fix(checkout): enforce one-use customer coupons`) and left a clean isolated worktree, but remained `waiting`.
- Run `5ac190b41e57` appears to have completed and committed `2774813` (`feat: add SKU back-in-stock subscriptions`) onto the parent `main` branch rather than the expected isolated branch, then remained `waiting`.
- A replacement run, `d30a2b769335`, received its own worktree and branch but also remained `waiting`; its branch pointed at the already-created `2774813` commit and had no changes.
- `agent_control reply` returned `has no pending question` for the waiting runs.
- Sending a normal message asking the run to finish did not change the state.
- Stopping the runs was the only way to clear them. Committed work remained intact.

## Expected behavior

A finite subagent that has committed its work and has no blocking question should transition to a terminal state and push its completion report to the parent. A run should enter `waiting` only when it has emitted a concrete blocking question that the parent can answer with `agent_control reply`.

Worktree isolation should also be strict: two concurrent writing agents requested with `workspace: "worktree"` must never share a worktree or write to the parent branch.

## Diagnostic hypotheses

1. The child process reaches an internal completion/wait primitive without publishing the completion event.
2. Run state records `waiting` while no pending-question record is persisted, leaving `reply` unable to resume it.
3. Worktrunk allocation may reuse or misidentify a worktree under concurrent starts, allowing a child to operate on the parent branch.
4. A completion event may be produced but not consumed/forwarded to the parent session.

## Suggested diagnostics

- Assert the state invariant: `waiting` requires a persisted pending question with an ID.
- If a child process exits with a clean result and no pending question, force a terminal `completed`/`failed` transition.
- Log run ID, PID, workspace path, branch name, initial HEAD, final HEAD, pending-question ID, and completion-event acknowledgement.
- Before permitting writes, verify that a requested isolated workspace is not the parent path and that its branch is unique to the run.
- Add a watchdog for finite runs that are `waiting` with no pending question after the child process exits.
- Add concurrency tests starting two writing agents simultaneously and asserting distinct paths/branches plus independently delivered completion notifications.

## Recovery used

The parent inspected `git worktree list`, agent branches, clean status, and commit history directly; preserved committed work; stopped stale runs; and continued without relying on the missing completion payloads. No uncommitted work was discarded.
