# Review ledger contract

The ledger preserves coverage and the complete lifecycle of review hypotheses. Initialize it with `review_ledger.py init`; edit the resulting JSON without changing `manifest_diff_sha256` or manifest item IDs.

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

For deleted files use `"anchor": "deletion"` instead of `line`.

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
