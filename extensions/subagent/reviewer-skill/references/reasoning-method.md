# Review reasoning method

Use this method for each changed behavior. It is intentionally hypothesis-driven: generation is broad enough to find risks, while validation is strict enough to protect reviewer trust.

## Behavioral proof tuple

A confirmed correctness finding needs:

1. **Changed control:** the changed line or deletion that alters behavior.
2. **Reachable input/state:** a realistic caller, event, configuration, or state that reaches it.
3. **Missing or incorrect guard:** the exact absent, misplaced, incomplete, or fail-open control.
4. **Observable consequence:** wrong output, lost data, unsafe side effect, bypass, crash, deadlock, unbounded cost, or broken gate.
5. **Countercontrol analysis:** the exact surrounding mechanisms checked and why they do not defeat the path.

If one element is unknown, the candidate is normally deferred rather than confirmed.

## Review lenses

### Contract and compatibility

- Compare callsites with changed signatures, return values, exceptions, serialization shapes, lifecycle, and default behavior.
- Check both forward and backward compatibility where persisted data, public APIs, queues, caches, or rolling deployments are involved.
- Treat documentation as intent evidence, not runtime proof.

### State and ordering

- Enumerate important states before and after the change.
- Challenge early returns, retries, duplicate delivery, partial failure, cancellation, timeouts, and rollback.
- Check whether validation occurs before irreversible effects.
- For concurrency, identify ownership, atomicity, idempotency, lock scope, and stale-state assumptions.

### Boundaries and authorization

- Identify the actual principal, tenant/object boundary, resource, action, and enforcement point.
- Follow server-side behavior; client hiding is not authorization.
- Verify the guarded object is the object later consumed or mutated.
- Check alternate routes, batch operations, callbacks, background jobs, and fallbacks separately.

### Data and persistence

- Verify schema/config changes against all readers and writers.
- Check null/default/backfill behavior and mixed-version deployment states.
- For multi-step writes, reason about transaction boundaries and external side effects.
- For deletions, trace consumers and recovery behavior.

### CI/CD and operations

- Treat workflow semantics as code: events, path filters, conditions, permissions, dependencies, concurrency, caches, failure modes, and promotion ordering.
- Compare path filters with every real build/deployment input, including generated inputs.
- Distinguish an assurance check from a merge gate; timing and event order can change semantics.
- Make API/tool failures fail safe without accidentally suppressing required work.
- Optimize compute without weakening gates or silently moving them after merge.

### Tests

- Ask which exact changed failure mode a test would catch.
- Inspect whether mocks erase the property being tested.
- Confirm negative and boundary cases, not only happy paths.
- Do not request tests for trivial syntax or behavior already proven by a deterministic gate.

## Counterexample search

Try at least one plausible counterexample for each consequential invariant:

- first/last/empty/duplicate input;
- missing configuration or dependency;
- retry after partial success;
- same identity across two tenants or scopes;
- concurrent or reordered events;
- delayed promotion after prior checks finish;
- API timeout, malformed response, rate limit, or permission denial;
- renamed, deleted, or generated file omitted by a selector;
- safe primary path with unsafe fallback or sibling path.

Choose counterexamples that could occur in the actual system. Exotic states with no reachable source should not become findings.

## Falsification ladder

Use the cheapest decisive evidence first:

1. Exact local countercontrol visible in source.
2. Caller/consumer/configuration trace.
3. Focused existing test or analyzer.
4. Minimal new reproduction in a temporary location.
5. Realistic local interface reproduction.
6. Broader integration or environment validation when proportionate and authorized.

Record failed attempts and remaining gaps. Never convert “could not reproduce” into “safe” unless the attempted path exercised the real preconditions and controls.

