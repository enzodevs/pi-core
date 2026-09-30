# Read-triggered nested project guides

Tested API: **Pi 0.99.1**. This opt-in extension adds applicable nested project instructions to the model request following a successful `read`. It adds no tool, queues no turn and changes no guide/skill files.

## Enable / disable

Reload Pi after installing/updating pi-core, then use `/nested-agents on` (or launch with `--nested-agents`). `/nested-agents off` stops discovery and request-time injection; `/nested-agents status` reports the switch. The default is off. Command overrides reset on session start/reload; the CLI flag applies to the new session.

Both **Pi project trust** and **nonempty startup context files** are required. Trust alone does not opt in. Pi does not expose `noContextFiles` to extensions; an empty startup context or a forced system prompt disables this extension conservatively. Consequently, even a trusted project with no startup instructions must add a normal startup guide and reload before using this feature. There is no override for this guard. No project settings are read independently of Pi's trust decision.

## Scope and precedence

The boundary is the nearest `.git` ancestor of the startup CWD, including a linked-worktree `.git` file. Without Git it is the startup CWD. Home-directory and filesystem-root boundaries disable discovery. Reading outside that boundary or inside another nested repository does not import instructions. Source paths use Pi 0.99.1's `read` normalization: relative paths use the execution context CWD; `@`, `~`, file URLs, Unicode spaces and macOS filename fallback variants are supported. Arbitrary third-party replacements of `read` with different path semantics are unsupported.

Discovery follows the **canonical source path** from project root to its containing directory. In-directory candidates follow Pi's precedence: `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`. Unreadable candidates fall through as in Pi. Unsafe, binary, non-UTF-8 or oversized selected guides produce omissions instead of falling through to a lower-priority guide. Symlinked source/guide paths cannot import outside-root content. In-project guide aliases deduplicate by canonical path; their applicable directory scopes are combined.

Only successful top-level `read` results activate discovery, including offset/limit and image reads. Failed reads, directories, bash/search/write/edit results and nested calls made by other tools do not activate it. A full explicit guide read counts as supplied; a partial guide read does not pretend to supply the entire guide. Exact startup content is fingerprinted and not duplicated.

## Context and lifecycle

`tool_result` adds only canonical path/root metadata to `details`. Source content, images, errors, usage and other details are preserved. The synchronous request boundary is Pi's supported `context` hook: guidance is appended to copies of successful read results **before the next provider request**, not promoted into a system message.

The projection is rebuilt from the **actual active model context** each request. It has no session-wide seen set, persistent instruction cache or extra session messages:

- Repeated or parallel reads share one copy of each guide in that request.
- Resume/branch/reload use only the active transcript's annotated read results, not abandoned branches.
- After compaction removes those results, guidance is not replayed speculatively. The next successful source read supplies it again. Files intentionally read before this extension was enabled have no annotation; re-read them to activate it.
- Guide content is re-read and fingerprinted once per directory per request. Changes to nested guides refresh the ephemeral copy. Changed startup guides produce a reload notice instead of attempting to override Pi's existing system-context copy; use `/reload` to update them. Unchanged offset reads do not append further transcript content.
- Another extension that discards read metadata/content or rewrites context afterward can defeat this contract. Filesystem containment checks are not a filesystem snapshot against adversarial concurrent renames.

Each block states its origin and directory scope and identifies repository text as lower-trust guidance, not authority to override user instructions, approval requirements or safety policy. Markdown links are not followed.

## Budgets

All limits are UTF-8 bytes, including labels/wrappers for added context:

| Limit | Bytes |
| --- | ---: |
| Raw content per guide | 8,192 |
| Added guidance per read activation | 16,384 |
| Total added guidance in the active session context/request | 32,768 |
| Omission notices within that total | 2,048 |

A 256-byte reserve ensures notice saturation can be summarized. Guides are loaded completely or omitted, never silently truncated. Individual omission notices name the guide and reason; saturation adds an aggregate notice. Scope labels exceeding 512 bytes are omitted rather than ambiguously abbreviated. Long origin paths in notices are explicitly marked as shortened. The budget is a ceiling on **currently supplied context**, not a lifetime token allowance: unchanged guides remain available across requests without accumulating stored copies.

## Verification and limitations

`tests/nested-agents.test.ts` covers discovery order/precedence, sibling exclusion, original-result preservation, repeated/parallel/full/partial reads, failure/non-read paths, containment/worktrees, binary/image handling, budgets/notice saturation, unreadable fallback, aliases, content refresh and projection after context loss. Wiring tests cover opt-in, trust, empty context, forced prompts and nested-call exclusion.

`tests/nested-agents-runtime.test.ts` runs the **actual installed Pi SDK and built-in read tool**, with isolated settings/auth and a deterministic local provider stream. Random guide markers never appear in the prompt. Provider-bound requests and tool execution events prove:

1. Root-started + enabled: the nested marker appears after exactly one source read, with no guide read.
2. Disabled: identical source read, nested marker absent.
3. No context files: identical source read, marker absent.
4. Nested startup + tools disabled: Pi's own ancestor injection contains the marker, with zero reads.

These are executable runtime-boundary controls, **not live external-model evaluation** or proof that a model will follow the guides. No paid model calls or delegated agents are used. Live positive/negative model controls remain unverified; do not describe model adherence as established. Compaction/branch/resume projection is unit-tested; actual model-generated compaction quality is outside this feature's contract.

Acceptance coverage (handoff scenario numbers):

| Scenario | Evidence |
| --- | --- |
| 1: automatic read activation + negative/positive controls | `tests/nested-agents-runtime.test.ts:23` |
| 2: levels, precedence, sibling exclusion | `tests/nested-agents.test.ts:51`, `:72` |
| 3: startup and repeated/offset reads | `tests/nested-agents-runtime.test.ts:23`, `tests/nested-agents.test.ts:82` |
| 4: explicit guide reads | `tests/nested-agents.test.ts:82`, `:97`, `:210` |
| 5: non-read exclusion | `tests/nested-agents.test.ts:105`, `:276` |
| 6: failures and unreadable candidates | `tests/nested-agents.test.ts:105`, `:197` |
| 7: containment and worktrees | `tests/nested-agents.test.ts:114`, `:131`, `:261` |
| 8: opt-in/trust/no-context guards | `tests/nested-agents.test.ts:276`, `tests/nested-agents-runtime.test.ts:23` |
| 9: budgets and honest omissions | `tests/nested-agents.test.ts:138`, `:236` |
| 10: parallel projection deduplication | `tests/nested-agents.test.ts:82` |
| 11: context loss/resume/branch projection and changes | `tests/nested-agents.test.ts:182` (unit projection, not live compaction) |
| 12: original result and lower-trust scope labels | `tests/nested-agents.test.ts:51`, `:161`, `tests/nested-agents-runtime.test.ts:23` |

A containment-guard mutation caused the external-guide leakage assertion to fail; the guard was restored before final verification.

Verification commands: `make test`, `make check`, `make pack`, `make compat-package`.
