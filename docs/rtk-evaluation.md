# Context guard and RTK evaluation

## Decision

Keep the command-agnostic context guard as the default. RTK is useful for selected, measured command families, but do not install its global command-rewriting hook. Do not add SQLite or DuckDB to the runtime yet: bounded file-backed recovery addresses the observed problem without another storage layer.

RTK v0.48.0 was installed in an isolated evaluation directory, not on `PATH`, and its matching source was inspected through `opensrc`. The Linux x86_64 musl archive was verified against the release API's SHA-256 digest:

```
e4e650fa1677c0de2f6839a6040d7b17f312d32f163c402b75af70e9e5af1a91
```

No Pi hook or global configuration was installed. Evaluation used isolated XDG directories, `RTK_TELEMETRY_DISABLED=1`, and tee mode `always`.

## Measured command output

These are UTF-8 **bytes**, not model tokens. Each command was executed once normally and once through RTK. Timings and test durations vary between executions. The harness captured stdout and stderr independently before any projection; RTK's own tee files were checked separately.

| Case | Plain bytes | RTK bytes | Exit codes, plain / RTK | Observation |
| --- | ---: | ---: | --- | --- |
| Redapro `make worker-test` | 33,461 | 250 | 0 / 0 | Retained 236 passes, 0 failures, and 1,329 assertions; includes the target's TypeScript check |
| Redapro `make health-hotspots` | 572 | 573 | 2 / 2 | Preserved the existing architecture-test failure; no useful reduction |
| Pi Core `make test` | 1,859 | 247 | 0 / 0 | Useful reduction of passing test output |
| Native Node failing-test fixture | 1,731 | 249 | 1 / 1 | Retained actual/expected values but **dropped the failing test name**; tee retained it |
| Arbitrary successful Python command | 10,009 | 2,067 | 0 / 0 | Dropped middle evidence; **no tee artifact**, despite `always` |
| Arbitrary failing Python command | 10,009 | 2,067 | 7 / 1 | Dropped middle evidence and changed the exact exit code; no tee artifact |
| Same Python command through `rtk proxy` | 10,009 | 10,009 | 0 / 0 | Preserved evidence, without savings |
| Default `rtk read` on TypeScript | 8,834 | 8,834 | 0 / 0 | No reduction |
| `git status --short --untracked-files=all` fixture | 450 | 373 | 0 / 0 | Modest reduction; sampled filenames retained |

Redapro was tested in its existing checkout without changes to tracked files. Its `health-hotspots` target failed in both runs because an existing measured size of 2,468 exceeded the 2,384 baseline; the subsequent Insights command did not run. That failure was not caused or repaired by this work.

The Pi Core test-count snapshot above predates the last regression tests added during this implementation.

## Guard changes and comparison

The prior guard could classify earlier results in the same parallel batch as historical before the model had seen them. It also emitted overlapping snippets, deduplicated structurally significant repeated lines, and advertised artifact recovery even when the complete result fitted.

The revised guard:

- Shares the bounded first-delivery budget across **all** unseen results.
- Passes fitting results through unchanged; attaches recovery references only when omitting output.
- Merges evidence windows by source position, preserving repeated braces and blank lines.
- Prioritizes failure evidence before routine status lines and labels gaps and clipped long lines.
- Keeps a single retrieval tool: ranked lexical evidence with up to eight surrounding lines per side, or a contiguous stored-line range, always within the response byte budget. Search retains only bounded top candidates rather than sorting every matching line.
- Reports total/shown search hits, range continuation, and incomplete stored prefixes, including zero-match searches.
- Captures outputs above the historical allowance, caps file count as well as bytes and age, and avoids recursively archiving retrieval excerpts.

On the captured Redapro worker output, the revised guard produced **6,038 bytes**, retaining test totals and diagnostic evidence. The prior guard produced 5,648 bytes. This is deliberately not a maximum-compression contest: RTK produced a much smaller successful-test summary, but its generic failure behavior lost evidence in another case.

On eight unseen 1.7 KiB read results, the old guard prematurely compressed four results. The revised guard delivered all eight intact within the existing 24 KiB aggregate budget. After observation, results can shrink into historical evidence. A smaller first response that causes another read is not necessarily more context-efficient overall.

A warmed, 30-sample in-process projection microbenchmark measured roughly **0.38 ms** median on the 33 KiB worker output. A separate small-artifact test near the 512-file retention cap measured about **5.1 ms** median and **7.0 ms** p95 for storage plus cleanup. These are local microbenchmarks, not end-to-end agent latency or task-success measurements.

## Recovery boundaries

Artifacts remain bounded, private, session-owned files, not an unconditional lossless archive. Captured Pi Bash overflow output can precede the built-in display truncation, but an upstream wrapper that already filtered its subprocess output cannot be undone by the guard. Retrieval of an oversized single line is explicitly clipped; lexical search can target evidence within that line.

A database is worth reconsidering if measured file-index costs or cross-run analytics warrant it. Prefer SQLite for live metadata and optional lexical indexing; consider DuckDB for offline analysis only when the dataset and queries justify it.

Before enabling RTK for a command family, validate raw capture coverage, exit semantics, failure identity and diagnostics, and total cost including recovery calls. Byte savings alone are not evidence of better agent performance.

## Local reproduction artifacts

The isolated installation and evaluation evidence are under:

```
~/.pi/agent/pi-core/evaluations/rtk-v0.48.0/
```

It contains `evaluate.py`, `redapro.py`, `guard-benchmark.mjs`, JSON measurements, separate raw/filtered stream logs, and RTK tee logs. `redapro.py` defaults to `make worker-test`; `redapro.py health-hotspots` reproduces the architecture check. These scripts are local experiments, not package dependencies or published runtime commands. Review targets before rerunning them against a changed checkout.
