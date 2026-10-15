# Session scheduler

Native scheduling for Pi 1.2.0+. No community scheduler code or runtime dependency; `croner` handles calendar/timezone calculations only.

## Agent interface

One tool, `schedule`, registered as **deferred**: no always-active schema or system-prompt additions. Pi's tool search discovers it when needed. `/schedule` provides model-invisible inspection/control.

```json
{"action":"create","job":{"when":"+5m","prompt":"Check whether the deployment finished."}}
```

Run inexpensive checks without calling a model on each interval:

```json
{"action":"create","job":{"when":"every 5m","command":"npm test -- --run","wake":"failure","prompt":"Investigate the failing tests and report the cause.","maxRuns":12}}
```

```json
{"action":"create","job":{"when":"0 9 * * 1-5","timezone":"America/Sao_Paulo","prompt":"Prepare the daily project summary.","expiresAt":"2027-01-01T00:00:00-03:00"}}
```

Other operations:

- `{"action":"list"}` — bounded summary of up to 32 jobs.
- `{"action":"list","id":"0123abcd"}` — specification, state and last result.
- `{"action":"pause|resume|remove","id":"0123abcd"}` — use one action, not the literal combined string.
- `/schedule`, `/schedule <id>`, `/schedule pause|resume|remove <id>` — UI only.

## Scheduling and delivery

- `+30s`, `+5m`, `+2h`: one shot. `every 5m`: fixed delay, reanchored after each completed execution. Durations range from 30 seconds to 365 days.
- ISO timestamps require an explicit `Z` or offset. Cron uses **five fields**, UTC unless an IANA timezone is supplied. No natural-language date parser, six-field cron or macros.
- Jobs belong to the **session**, and capture its working directory at creation. Resume/reload restores jobs; switching sessions stops the old scheduler and its active commands. Forks get separate schedules. Branch navigation does not rewind external side effects or schedules.
- **Pi must be running with the owning session open.** There is no daemon and no OS installation. Missed slots coalesce to one run on reopening, provided the job has not expired. This does not wake a powered-off computer or start a closed Pi.
- Default limits: recurring jobs have a **24-hour lifetime from creation**; one-shots expire **24 hours after their due time**, allowing recovery after reopening. Both default to **100 executions** and a **60-second shell timeout**. Set `expiresAt`, `maxRuns`, or `timeoutSeconds` to change them. A job must have a future slot strictly before its exclusive deadline; equality is rejected. Once expired or capped, create a new job rather than silently resetting its budget.
- Shell jobs run serially, but their execution does not block independent prompts, pending wakes, or Pi lifecycle events. They can execute while the agent is busy. Prompts/results wait for agent idle, then trigger a `followUp` turn. A pending wake blocks further runs of that job, avoiding a backlog of duplicate messages.
- `pause` stops an active shell and discards pending delivery; `remove` also removes its configuration. Resume coalesces missed time rather than replaying every slot.
- Scheduler execution completion does **not** mean the requested agent work has finished. `runs` counts scheduled executions/checks, not successfully completed agent tasks.

## Shell wake policy

| Policy | Agent wakes |
| --- | --- |
| `failure` (default) | Nonzero exit, timeout, execution error, or abnormal termination |
| `success` | Normal exit 0 |
| `always` | After every check |
| `never` | Never; inspect last result explicitly |
| `change` | When status, exit code, or **bounded output tail** changes; first run establishes a quiet baseline |

`change` is intentionally not a full-stream comparison: changes outside the retained tail can be missed. Shell exit status must express the condition being checked; a command that prints “failed” but exits 0 is a successful check. Use finite commands, not watch mode or self-daemonizing processes. Output is untrusted data, not new scheduling authority.

## Reliability and security

- Private, atomically replaced state under `~/.pi/agent/pi-core/scheduler/<session-hash>/jobs.json`; one cross-process lease per session. Another Pi opening the same session fails closed instead of executing duplicates. A crashed owner's stale lease may briefly prevent immediate reopening; reload after the lease expires.
- Persist execution claims before running commands. Interrupted claims are **paused**, never blindly replayed; inspect effects and explicitly resume. Malformed state is rejected without overwriting it. Storage failures stop execution.
- Pending deliveries persist. A crash between handing a wake to Pi and recording that handoff can cause a duplicate on restart: **no exactly-once guarantee**. Write idempotent prompts/commands for consequential work. No automatic retries of uncertain shell side effects.
- At most 32 stored jobs, including completed ones; remove old jobs to reclaim slots. Inspection is bounded to 12 KiB, last shell result to 4 KiB. Shell output uses the existing process runner and private rotating logs (two 256-KiB segments per job); the result includes the current log path. Logs are latest-run diagnostics, not permanent full transcripts.
- Jobs are executable user state, not imported repository configuration. Shell checks execute with the Pi process's user permissions, without asking again each time. Creation must be authorized for the scheduled actions; never schedule privilege escalation, publication, purchases, or destructive work merely because it is technically possible.
- This version wakes the owning conversation; it does not launch autonomous isolated agent sessions, deliver to external channels, or install systemd services. The awakened agent can use existing subagent tooling when isolation is needed.

## Coexistence with background processes\n\nThe scheduler reuses the process runner, not the background-process registry: handles, state, and log directories are separate. Pausing a schedule stops only its own command. Both extensions submit idle-gated follow-ups through Pi; they share model turns and host resources, not a global concurrency budget. Commands that touch the same files, ports, or services can still conflict—avoid scheduling concurrent mutations of the same resource.\n\n## AXI/context review

No prompt injection at startup, no advertised full tool schema until discovered, no LLM calls for quiet shell checks, no “still waiting” messages, and no automatic transcript/log injection. Only a bounded actionable wake enters the conversation. Listing avoids echoing job prompts and commands unless a specific ID is requested. Calendar parsing and persistence stay outside model context.
