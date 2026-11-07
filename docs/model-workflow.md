# Model workflow and prompting

## Policy and evidence

The workflow favors clear outcomes, scoped initiative, targeted research, and verified completion. It does not depend on a model nickname or require maximum reasoning effort for every task.

OpenAI's [current model guide](https://developers.openai.com/api/docs/guides/latest-model), checked on 2026-09-07, identifies GPT-6 Astra and explicitly recommends **initiative and follow-through**: infer intended scope, act on requests for action, persist through completion, and prepare concrete work before asking for approval. It also notes sensitivity to skill instructions. The guide is a moving reference; revisit it when the provider or model changes.

The local policy adapts those recommendations rather than granting unlimited authority: investigations remain read-only, ordinary implementation decisions do not require approval, and destructive actions, spending, publication, and consequential scope changes still require authorization. Research-before-asking is a workflow choice for discoverable facts, not permission to infer private preferences or upload private code to search services.

## Where instructions belong

- `~/.agents/AGENTS.md` (also supplied to Pi through `~/.pi/agent/AGENTS.md`): shared authority, initiative, safety, research and verification policy. Keep each universal rule here once.
- `~/.pi/agent/SYSTEM.md`: Pi-specific tool mechanics, installed API documentation, codemode and delegation guidance. It replaces Pi's default prompt; do not repeat the shared agreement here. These are personal configuration files, not files installed or overwritten by this package.
- Repository `AGENTS.md`: project commands, constraints, and conventions.
- `CONTEXT-HYGIENE.md`: extension design and output contracts.
- Individual requests: the actual outcome, operation, constraints, and acceptance evidence.
- Skills: task-specific procedures loaded only when relevant. The skill-manager prompt names the actual `search_skills` and `load_skill` tools.

Do not paste all of this guide into every request or add a second global autonomy policy. Explicit task instructions may narrow normal autonomy.

A custom `SYSTEM.md` retains tool schemas, project context, skill injection, and extension event wiring. It bypasses Pi's default prompt body, including generated tool-snippet/guideline prose; essential tool-use guidance therefore lives in the custom prompt. Project-local or CLI system-prompt overrides can supersede the global file. After Pi upgrades, compare the installed default prompt for useful changes instead of blindly copying it. `SYSTEM.md` carries no maintenance prose, since every request would pay for it; this section is the maintenance note. Retain project/skill injection and do not duplicate policy in `APPEND_SYSTEM.md`. Verify that the shared agreement reaches both the parent and child launch paths before removing duplicates. A configuration that disables context files must supply its safety policy explicitly; the Pi-specific prompt alone is not a replacement for the shared agreement.

## Context without the rolling guard

The former context guard, artifact store, lookup tool, and explicit child-agent guard loading have been removed. Pi Core no longer projects historical tool results into a small rolling evidence budget. Pi's own tool output limits and normal compaction still apply; this is not unlimited context retention.

Select output before it enters context:

- Use a known path and a bounded `read`, `grep`, or exact `find` query.
- For bash, choose appropriate installed helpers such as `rg`, `jq`, `head`, and `tail`; inspect unfamiliar CLI help rather than guessing syntax.
- Save noisy output and preserve the producer's exit status. A successful filter is not evidence that a test or build passed.
- Retrieve needed portions of a saved log instead of repeating the command.
- Increase limits when needed for correctness; do not hide diagnostic evidence merely to reduce bytes.

For example, a finite check can retain full evidence while bounding the returned output:

```bash
log=$(mktemp /tmp/pi-check.XXXXXX) || exit 1
make check >"$log" 2>&1
status=$?
tail -n 60 "$log"
printf '\nFull log: %s\nExit status: %s\n' "$log" "$status"
exit "$status"
```

An optional [Headroom JSON pilot](headroom-json.md) can compact new successful tabular JSON bash results, with cell-by-cell validation and private exact-original recovery. It is off by default and never rewrites historical messages. This does not reinstate the rolling guard.

Reload extensions or start a new Pi session after upgrading. A running session may still hold the old extension in memory. Reload does not reconstruct already compacted evidence; use a fresh session for comparisons. Old `~/.pi/agent/pi-core/context-artifacts/` files are left untouched and are no longer used.

## Research before asking

Inspect local evidence first for repository-specific questions and version-matched installed docs for Pi APIs. Follow the shared policy for current public library documentation: use Context7 when available; use targeted `exa-search` queries for recency-sensitive facts or when Context7 is unavailable, then fetch the relevant primary source. If Exa is unavailable or extraction fails, use another available fetch/search method and disclose unresolved uncertainty. Do not turn every task into a web search.

Do not send secrets, private code, or identifying internal details to external search. Ask the user about genuine choices that public documentation cannot settle.

When docs and types cannot answer a dependency-internals question, use the `opensrc` skill/tool and reuse cached source. Verify the source version against the installed dependency; a repository checkout at `main` is not necessarily the installed release. The Pi checkout at `/home/rrghost/.opensrc/repos/github.com/earendil-works/pi/main` is a read-only reference, not a patch target.

## Outcome-first prompts

Natural language is sufficient. Use only the pieces the task needs:

> **Operation:** investigate, specify, implement, or review.\
> **Outcome:** what should become true for the user?\
> **Constraints:** what matters and what must stay untouched?\
> **Done when:** what evidence demonstrates success?\
> **Autonomy:** which decisions may the agent make?

### Specify

> Specify this, without editing code yet: customers should receive a WhatsApp confirmation after a booking is accepted, without duplicate messages. Inspect the current booking flow, recommend the smallest suitable approach, and identify decisions that materially change the design. Choose sensible defaults for minor details.

### Implement

> Implement WhatsApp booking confirmations. Send only after acceptance, prevent duplicate delivery, and expose failures to staff. Reuse existing infrastructure and preserve unrelated work. Continue through relevant tests without waiting for plan approval. Ask before paid-service commitments or consequential product choices that local evidence cannot answer.

### Voice prompts

Explain the scenario naturally, then finish with a short decision summary:

> So, the actual request is to investigate first, not edit anything, and recommend one approach. The important constraint is X; the other ideas were possibilities, not requirements.

Or:

> So, implement that outcome. Decide the internal details and continue through testing. Only stop for a material product decision, external commitment, or concrete blocker.

## Reasoning effort and evaluation

The inspected personal configuration defaults to `openai-codex/gpt-6-astra` at `medium`; a session can override that to `low`. The update does not change this default or the transport. Check the effective session setting when comparing runs.

Try low effort for bounded edits and medium for ambiguous debugging or cross-cutting changes. These are starting hypotheses, not measured model guarantees. Do not add unsupported API controls or force an effort level through prose.

Use comparable clean checkouts and fresh sessions for repeated real tasks. Change one variable at a time (policy, guard presence, or effort), using historical guard runs where available rather than re-enabling it globally. Record:

- acceptance criteria met and relevant checks passed;
- total time to verified completion, not just first response;
- tool calls, repeated reads, and evidence-recovery calls;
- user interventions and unnecessary approval questions;
- tokens/cost when available and regressions or unwanted changes.

Use the small [behavioral evaluation set](harness-evaluation.md) before changing prompts or adding agent profiles. It separates deterministic contract checks from model-mediated observations; passing unit tests alone does not establish improved agent behavior.

No controlled low-versus-medium benchmark was performed as part of this patch. The reason for removing the guard is observed evidence loss and recovery work, not a claimed universal speedup.
