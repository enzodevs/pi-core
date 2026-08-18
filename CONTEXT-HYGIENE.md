# Context hygiene

Context is a finite runtime resource. Every always-active instruction, tool schema, tool result, and repeated message increases latency, cost, and distraction. Design Pi extensions for the smallest model-visible surface that remains reliable.

These rules adapt the agent-interface principles described by [AXI](https://axi.md/) to Pi extensions and agent orchestration.

## Principles

1. **Minimize always-on schemas**
   - Prefer one focused tool over a catalog of overlapping tools.
   - Keep parameters few, required, and semantically distinct.
   - Do not expose implementation controls that the model should not choose.
   - Remove inactive compatibility tools instead of leaving them advertised.

2. **Keep work outside the parent context**
   - Perform intermediate reads, searches, tool calls, parsing, and aggregation in code or an isolated child agent.
   - Return conclusions, not transcripts.
   - Do not round-trip bulk data through the model when code can filter it first.

3. **Use compact, content-first output**
   - Lead with the answer or live state, not acknowledgements and metadata.
   - Use terse key/value or tabular forms for repetitive structured data.
   - Consider TOON or another compact encoding for large homogeneous datasets when it measurably saves tokens; do not encode short prose merely for fashion.

4. **Truncate deliberately**
   - Bound every untrusted or potentially large result.
   - Preserve the beginning or most relevant slice and report omitted size.
   - Offer full retrieval only when a real workflow requires it.

5. **Pre-compute useful aggregates**
   - Return counts, status, and conclusions that prevent follow-up calls.
   - Combine action and observation when safe.
   - Prefer one meaningful result over several low-information confirmations.

6. **Make empty and failure states definitive**
   - Say `0 results`, `complete`, `failed`, or the concrete error.
   - Do not force the model to infer whether missing output means success, emptiness, truncation, or failure.

7. **Use contextual disclosure**
   - Keep specialized guidance on demand through skills or narrowly activated tools.
   - Put only durable, universal rules in always-active prompts.
   - Avoid help text that repeats facts already encoded by a schema.

8. **Avoid polling when completion can be pushed**
   - Start independent work asynchronously.
   - Deliver completion once at the next safe turn boundary.
   - Do not expose job-management ceremony unless users actually need cancellation, prioritization, or history.

9. **Treat injected results as durable context**
   - A completion message remains in subsequent requests until compaction or branching.
   - Inject only the final handoff needed for decisions.
   - Exclude child reasoning, tool transcripts, usage internals, duplicate task text, and TUI-only details.

10. **Measure before adding clever formats**
    - Compare schema tokens, result bytes, request count, latency, and task success.
    - Optimize the dominant cost rather than applying compression everywhere.
    - Reliability and clear recovery paths outrank small token savings.

## Pi-core policy

- Model-facing tools require a context-cost review.
- New tool parameters need a demonstrated model decision.
- Outputs with variable external content must have a byte or item cap.
- TUI metadata belongs in tool `details`, not model-visible `content`.
- Background agents return a concise final handoff only.
- Child contexts remain isolated; only bounded final output enters the parent.
- Prefer skills for optional procedural knowledge and tools for executable capabilities.
- Keep project-local prompts opt-in because repositories control their contents.

## Review checklist

Before shipping an extension, ask:

- Is its schema sent on every turn? Can the capability be merged, delayed, or made on-demand?
- Can any parameter be inferred from session context?
- Can code filter or aggregate before the model sees the result?
- Is output bounded, with an explicit truncation marker?
- Does success, emptiness, and failure each have an unambiguous representation?
- Are we injecting a transcript where a handoff would suffice?
- Does the interface eliminate round trips rather than create them?
- Did we preserve the information required to act correctly?
