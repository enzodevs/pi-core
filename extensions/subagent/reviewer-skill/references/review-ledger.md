# Review ledger contract

The ledger preserves coverage and the lifecycle of review hypotheses. Prefer `review.py start` and its incremental commands; the legacy `review_ledger.py init` remains available. One coordinator owns the canonical ledger. Workers return isolated bundle receipts; they never edit it concurrently. Do not change `manifest_diff_sha256` or manifest IDs. Artifacts stay outside the target repo.

Schema 2 adds old-side deletion points and a mutable-scope fingerprint checked by the CLI. It is drift detection, not a frozen filesystem. Pause writers throughout a WIP review. Schema-1 revision manifests remain readable; regenerate legacy WIP/index manifests.

`review` may include `approved_decisions`, `not_yet`, and `questions`, each a list of non-empty strings. Decisions include the approval source and exact scope. Questions are unresolved owner questions and block `--strict`; when answered, record the answer/provenance in intent or approved decisions and remove it from the unresolved list. A question is not a candidate disposition.

Before validation, set `review.state` to `complete` or `incomplete`, identify the reviewer, summarize the intended change, and list the behavioral invariants used during review. `complete` means the requested review process finished; deferred candidates remain visible proof gaps rather than silently disappearing.

## Coverage entries

Every manifest item has exactly one entry:

```json
{
  "item_id": "item-123",
  "path": "src/example.ts",
  "status": "reviewed",
  "checks": [
    "Traced callers through src/router.ts",
    "Ran focused test tests/example.test.ts"
  ],
  "summary": "The changed fallback preserves the documented error contract.",
  "proof_gap": ""
}
```

Allowed statuses:

- `reviewed`: `checks` and `summary` are required.
- `not_applicable`: explain in `summary` why the artifact carries no reviewable behavior.
- `deferred`: `proof_gap` is required.
- `pending`: initialization state; final validation rejects it.

## Confirmed candidate

```json
{
  "id": "C-001",
  "item_id": "item-123",
  "path": "src/example.ts",
  "line": 42,
  "disposition": "confirmed",
  "severity": "P1",
  "confidence": 0.91,
  "title": "Fallback bypasses the tenant boundary",
  "invariant": "Every record lookup must be constrained to the resolved tenant.",
  "failure_path": "A tenant-scoped request misses the primary lookup, enters the fallback, and loads by global ID.",
  "impact": "An authenticated user can read another tenant's record.",
  "evidence": [
    "The fallback query at src/example.ts:42 has no tenant predicate.",
    "routes/example.ts supplies a request-controlled record ID."
  ],
  "counterevidence_checked": [
    "No global tenant scope is registered on the model.",
    "The route middleware authenticates but does not authorize this record."
  ],
  "verification": [
    "Focused policy test reproduces a 200 response for a foreign-tenant ID."
  ],
  "remediation": "Resolve the fallback through the tenant relation and retain the policy check."
}
```

For deleted files use `"anchor": "deletion"` instead of `line`. For a pure-deletion hunk in a modified file, also provide `"old_line": 42` within an item's `deletion_points.old_start..old_end`. The `new_line` is a position, possibly zero at the start of a file, not a claim that a surviving line changed.

Optional `next_action` is `fix` or `ask_owner` for confirmed findings; approval-dependent remedies use `ask_owner` without weakening factual disposition/severity. A demonstrated unintended consequence remains in Findings. Optional `reproduce` may hold a non-destructive command, but it is data for review, never automatically executed. Describe execution and its result in `verification`; a command alone is not proof.

## Suppressed candidate

```json
{
  "id": "C-002",
  "item_id": "item-123",
  "path": "src/example.ts",
  "disposition": "suppressed",
  "suppression_reason": "The framework middleware rejects the state before this branch.",
  "counterevidence": [
    "routes/example.ts applies RequireConfirmedAccount",
    "The middleware test covers the exact unconfirmed state."
  ]
}
```

## Deferred candidate

```json
{
  "id": "C-003",
  "item_id": "item-123",
  "path": "src/example.ts",
  "disposition": "deferred",
  "proof_gap": "Production proxy redirect behavior is unavailable, so the final destination control cannot be established."
}
```

Do not delete suppressed or deferred candidates merely to produce a cleaner report. They are evidence that the review challenged the code and accounted for uncertainty.

## Incremental CLI

All paths below point to a marked workspace outside the reviewed repository. `status` lists 50 coverage rows by default; paginate using `--offset`/`--limit`. `show --full` expands a truncated patch. Both validate mutable-scope freshness.

```bash
python3 <skill-dir>/scripts/review.py show --workspace <workspace> --path src/example.ts
printf '%s\n' '{"path":"src/example.ts","line":42,"title":"Investigate fallback"}' |
  python3 <skill-dir>/scripts/review.py cand add --workspace <workspace> --data -
# The response includes the new candidate ID; disposition defaults to open.
# Update using a JSON object containing that id plus the new fields:
python3 <skill-dir>/scripts/review.py cand update --workspace <workspace> --data <candidate.json>
python3 <skill-dir>/scripts/review.py finish --workspace <workspace> --strict
```

For snippet anchoring, omit `line` and add `--code <exact-unique-full-line-snippet>`. To anchor a removed guard, supply `anchor: deletion` plus `old_line`, or `anchor: deletion` plus `--code`. An `open` candidate needs an immediate valid anchor but not yet the final proof fields. Confirmation requires the same proof tuple as before. Final validation rejects all open candidates. Raw edits are allowed only by the coordinator; they bypass incremental protection but not final validation.

`cand update` merges fields; `intent` replaces each list explicitly supplied while preserving omitted lists. To clear answered questions, the coordinator can edit `review.questions` to an empty list after preserving the answer and provenance. Avoid putting sensitive source or secrets in shell arguments; use private JSON files/stdin when appropriate.

One CLI writer owns each read-modify-write transaction. A competing writer fails clearly; after a crash, verify the PID in `.ledger-writer.lock` has stopped before explicitly removing a stale lock. Do not use lock recovery to allow parallel ledger writers. Canonical JSON replacement is atomic; a lock does not freeze the reviewed repo.

## Bundle receipts and re-review

Workers return: manifest fingerprint, assigned paths with status/checks/conclusion, candidate objects and proof gaps. They do not create a second authority for the full review or mark unassigned paths reviewed. The coordinator verifies fingerprint and ownership, assigns collision-free candidate IDs, consolidates duplicates only with root-cause evidence, and checks cross-bundle dependencies before finish. Retain receipts with the session when required; no worker writes the canonical ledger.

On a correction pass, preserve the prior ledger/report as evidence of what was challenged, but regenerate the new manifest. Revalidate previous findings and suppression evidence if their dependencies changed; prior approval or suppression is not a reusable proof of current correctness.
