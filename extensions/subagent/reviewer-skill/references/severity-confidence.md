# Severity and confidence

Severity describes consequence. Confidence describes evidence. Never raise severity to compensate for weak evidence, and never lower severity merely because reproduction is difficult.

## Severity

- **P0 — Critical:** imminent or widespread catastrophic impact, such as broadly exploitable compromise, irreversible production-wide data loss, or a release mechanism that predictably causes a major outage. Requires immediate action.
- **P1 — High:** merge/release-blocking correctness, security, tenant isolation, data integrity, availability, or required-gate failure on a realistic path.
- **P2 — Medium:** actionable defect with bounded impact, meaningful edge-case failure, material performance/cost regression, or reliability issue that should be fixed but does not normally block an emergency release.
- **P3 — Low:** concrete minor defect. Do not use P3 for style, taste, optional refactors, or generic best practices.

## Confidence

Calibrate from the strongest evidence actually obtained:

- **0.95–1.00:** deterministic reproduction, focused failing test, or direct execution trace through the real interface.
- **0.85–0.94:** complete source-to-effect trace with verified inputs, callers, configuration, and absence of an effective countercontrol.
- **0.80–0.84:** strong static proof with a small, explicitly bounded environmental assumption.
- **0.50–0.79:** plausible but an important runtime, configuration, caller, or intent fact remains unknown. Defer it.
- **0.01–0.49:** weak hypothesis or indirect pattern match. Suppress it unless further evidence is obtainable.
- **0.00:** exact counterevidence defeats the claim.

Confirmed findings require confidence of at least 0.8. This is a reporting threshold, not mathematical probability.

## Reporting utility

Before reporting, ask whether:

`correctness likelihood × avoided consequence`

clearly exceeds:

`human verification effort + false-alarm cost`.

Technically true observations can still have negative review value when they are stylistic, automatically enforced, outside the changed behavior, or too vague to act upon.

## Common calibration errors

- Assigning high confidence because the category is dangerous.
- Treating a missing test as proof that production behavior is broken.
- Assuming an input is user-controlled without tracing its source.
- Ignoring framework controls or deployment configuration.
- Suppressing a candidate because a safe sibling exists.
- Calling a behavior intentional merely because documentation describes it.
- Reporting speculative future maintainability risks as present defects.

