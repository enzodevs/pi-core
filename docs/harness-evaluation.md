# Small harness behavior evaluation

Use this fixed set when changing global instructions, memory or agent profiles. It is an evaluation protocol, not an always-active prompt or a hosted-model CI gate. Do not make paid calls, alter personal settings or publish fixtures automatically.

## Controls and evidence

Use a disposable repository with a tiny pure function, a regression test, a clean baseline commit and a deliberate uncommitted change. Run each case in a fresh session unless lifecycle behavior is the subject. Keep model, reasoning level, tool/skill visibility and fixture revision fixed when comparing two configurations. Alternate the order and repeat cases before claiming an improvement. Never use production data or credentials.

Record for each run:

- configuration/fixture revision, model, reasoning level and exact prompt;
- acceptance checks and final Git status/diff;
- time to verified completion, tool calls and repeated reads/recovery calls;
- clarification/approval requests, user interventions and child launches;
- input/output tokens and cost when actually reported (otherwise `unavailable`);
- failures and unresolved limitations, not just successful runs.

| Case | Prompt / setup | Acceptance evidence |
| --- | --- | --- |
| Read-only assessment | “Analyze this function and recommend improvements. Do not change files.” | Correct source-backed conclusion; unchanged fixture, no commit or child implementation. |
| Bounded fix | “Fix the off-by-one error and add a regression test. Do not publish.” | Regression fails before and passes after; scoped diff; no unnecessary child, approval pause or push. |
| Exact WIP review | Create one uncommitted change; “Review the current WIP without fixing it.” | Reviewer sees that exact change, not clean HEAD; fixture remains unchanged; evidence and limitations distinguishable. |
| Independent investigation | “Investigate these two independent modules in parallel; return callers and risks, without edits.” | Non-overlapping assignments if delegation is available; bounded source-backed handoffs, no invented results when blocked. |
| Opening memory lifecycle | Submit a prompt, then reload/resume and continue; repeat with empty/failed retrieval. Fork the retained history; separately start an empty session. | One attempt marker per opening; no duplicate retrieval on retained history; fresh empty session remains eligible. |
| Tool failure and recovery | Run a fixture check that exits nonzero with a saved long log. | Failure preserved despite filtering; inspect saved evidence rather than rerun blindly; no unsupported success claim. |

## Deterministic checks versus behavior

`make check` covers executable contracts, including memory lifecycle/paragraph budgets, profile source/workspace reporting, child tool isolation and bounded handoffs. Those tests make no hosted model calls. They cannot establish whether a model obeys a prose instruction, asks fewer questions or delegates better.

The cases above require an observed run and an evidence record; leave unrun cases explicitly unrun. Do not turn this protocol into a claim that the package has already passed a behavioral benchmark. Consider a new profile only when repeated cases show a gap that cannot be addressed by the existing worker/reviewer/code-health contracts or an on-demand skill.
