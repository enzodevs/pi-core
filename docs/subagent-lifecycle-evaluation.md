# Managed subagent lifecycle: measured acceptance test

Tested implementation: `3f01753`, compared statically with `1f54d10`.

## Method

A fresh Pi RPC parent ran inside pi-core with all 18 configured extensions explicitly loaded. Skill and prompt-template discovery were disabled to isolate the extension surface. Temporary instrumentation recorded serialized request sizes and tool-result sizes, not provider credentials. A disposable Git repository contained a one-line addition bug, a Node test, and a trusted Worktrunk `pre-merge` hook.

Both parent and worker used `openrouter/openai/gpt-5.6-sol`, thinking `low`. The requested Codex route was attempted first but returned a usage-limit error; the same model was available through OpenRouter. No substitute model was used. Agent state and fixture changes were isolated from the user's normal agent state and project branches.

The parent was authorized to delegate one worker, review its committed diff, and request exact-revision integration into the fixture only. No manual merge, remote push, worktree deletion, or status polling was permitted. After the final response, the driver invoked `/worktrees-clean` to ensure any deferred cleanup completed.

## Observed results

| Measure | Result |
| --- | --- |
| End-to-end wall time | 27 seconds |
| Worker model / effort | GPT 5.6 Sol / low |
| Automatic verification | Passed |
| Parent review | Inspected committed one-line diff |
| Integration | Verified SHA fast-forwarded into fixture `main` |
| Remaining fixture worktrees | Main only |
| Parent model requests / tool calls | 6 / 4 |
| Worker model requests / tool calls | 5 / 6 |
| Parent reported cost | $0.0202334 |
| Worker reported cost | $0.0128750 |
| Parent `background_agent` result | 250 serialized UTF-8 bytes |
| Parent `agent_control status` result | 570 bytes |
| Parent diff-inspection result | 329 bytes |
| Parent `agent_control integrate` result | 97 bytes |
| First / final serialized provider request | 18,830 / 28,954 bytes |

Costs are provider-reported estimates from this run, not a billing guarantee. Request bytes are not token counts and include protocol overhead. Repeated input/cache tokens are not additive context-window occupancy.

## AXI/context-cost comparison

The installed Pi loader inspected all configured extension tool definitions at both revisions using identical serialization (`name`, `description`, `parameters`). Registered surfaces and runtime-active surfaces differ because extensions can replace built-in tools and runtime policy can deactivate tools.

| Registered schema measure | Before | After |
| --- | ---: | ---: |
| Registered extension tool definitions | 17 | 17 |
| Total schema bytes | 12,094 | 12,309 |
| `background_agent` schema bytes | 996 | 996 |
| `agent_control` schema bytes | 706 | 921 |
| `agent_control` guideline bytes | 0 | 162 |

The feature adds **215 schema bytes plus 162 guidance bytes**, without another always-active tool. Actual active non-built-in-name tool schemas totaled 6,326 bytes in the live parent. Verification transcripts stayed in private bounded logs; the model received conclusions and references. The parent did make one explicit status read after automatic completion, so there is still an opportunity to reduce repeated evidence retrieval.

This is functional acceptance plus a static surface comparison, **not** a controlled before/after agent-performance benchmark. It does not establish that every extension follows AXI, that all prompts are minimal, or that this workflow costs fewer tokens overall than its predecessor. A broader audit should measure each extension's always-on definitions, conditional prompt injection, result size, repeated delivery, task success, and recovery overhead across multiple representative tasks.

## Other verification

- `make check`: 371 tests passed; 2 pre-existing optional integration tests skipped.
- `make compat-package`: all 18 packaged extensions loaded.
- Real Worktrunk test: unapproved setup refused; approved setup and >100 KB check output handled; dirty target preserved; exact commit integrated; cleanup and repeated integration reconciled.
- Disposable-copy mutations: replacing the verified SHA with a moving branch failed the race regression; bypassing hook approval failed the approval regression.
- A repeated smoke test exposed output-drain timing in the command runner. It now waits for `close`, with a regression covering output arriving after `exit`.
- Independent review was attempted but blocked by the Codex usage limit. Final source review was performed by the implementing parent; it is not represented as an independent green review.
