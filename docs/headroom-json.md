# Opt-in Headroom JSON pilot

This is a narrow, local, **lossless-only** experiment, not a replacement for Pi's output limits or compaction. The removed rolling context guard remains removed. No historical messages, provider payloads, system instructions, or prompt-cache prefixes are rewritten. No model-facing tools or always-on prompt text are added.

## Install and activate

Node remains the harness runtime. This optional adapter needs `uv` and Python 3.10+ for Headroom; setup uses `python3`. It installs the hashed, pinned requirements into a dedicated venv, without proxy/ML/code/embedding extras:

```sh
make headroom-install
make headroom-test
```

Then `/reload` in Pi and opt in for the current Pi process:

```text
/headroom-json on
/headroom-json status
/headroom-json off
```

Alternatively launch Pi with `--headroom-json`. Default is off, including after reload/restart. The preference is not persisted or automatically propagated to subagents. `PI_CORE_HEADROOM_PYTHON` can select an existing compatible interpreter; the worker requires `headroom-ai==0.37.0`. The setup target always manages only its dedicated venv, never that override.

Setup, checks, and the extension share Pi's `CONFIG_DIR_NAME`-based state path and select `venv/bin/python` on POSIX or `venv/Scripts/python.exe` on Windows. The real-engine suite was exercised on Linux; Windows path selection has a unit regression, not an end-to-end platform certification.

Loading the extension does not download anything. Only explicit setup uses the network. Runtime calls do not inherit provider credentials or Python path overrides, and the Python worker blocks socket connections. There is no proxy, model download, paid inference, or CCR cache/retrieval at runtime. A missing/mismatched runtime or other failure leaves the original result unchanged.

## Deliberately small eligible surface

Only new, successful, single-text **bash results** containing an entire JSON document are considered, between 8 KiB and 256 KiB. Existing Pi truncation/full-output references and nonzero exit metadata are respected. Normal file read/edit/write tools, images, multipart results, non-JSON logs, and command failures pass through.

Supported data is a flat, homogeneous array of 20–5,000 objects, or one such array in a top-level object whose other properties are supported scalars. Columns must have consistent string, boolean, safe-integer, or finite-float types and simple ASCII identifiers. Duplicate JSON keys, null/mixed/nested columns, unsafe integers, decimals that would round during parsing, ambiguous schemas, explicit error fields, and unsuccessful top-level envelopes pass through. These restrictions intentionally cover less than Headroom's full API; extend them only with preservation tests.

Headroom `SmartCrusher` is explicitly configured with `lossless_only=True`, `csv-schema`, and CCR disabled. The adapter validates the header, row count, columns, types, **every rendered CSV cell**, and row ordering against the parsed input. It refuses row dropping, offloaded blobs, retrieval markers, and unknown output formats. There is no neural compression or content-router heuristic. Integers are never reserialized through JavaScript before Python validates them.

A replacement must save at least 20% of UTF-8 bytes **including its original-file reference**. This is a cheap runtime gate, not a claim about Astra's token billing. The table is labeled as CSV-schema, not ordinary JSON. Top-level array fields become labeled table strings in the representation; the original retains the real JSON schema and exact bytes.

Each worker is bounded to two seconds, 256 KiB input, 512 KiB protocol output, and 8 KiB stderr. Cancellation kills it. At most two workers run simultaneously per extension instance; excess results pass through immediately rather than queueing. There is one local subprocess per admitted result, no daemon or hidden cache; cold-start cost remains part of the pilot evaluation.

## Originals and data protection

Before replacing any output, the extension atomically stores the exact original beneath:

```text
~/.pi/agent/pi-core/headroom-json/originals/<sha256>-<uuid>.json
```

On POSIX, the newly created directory is private (0700) and files are 0600. The result includes the quoted absolute path. Per-result UUIDs ensure that rolling back one unpublished original cannot delete another result's recovery reference. Use the existing bounded `read`/`grep` tools to recover needed portions; `read` results are never recompressed. Original tool details, error/exit state, and usage are not patched.

These files can contain sensitive tool data. Published originals persist across sessions and are **not automatically deleted**, so old references remain valid. If cancellation or final savings validation prevents publication, the adapter attempts to remove only its new artifact; filesystem cleanup failures can still leave a private orphan. Stop compacting when the best-effort shared store reaches 256 files or 32 MiB. Multiple simultaneous Pi processes can slightly exceed that budget. Explicitly remove originals only when their session references are no longer needed; no global cleanup job is installed.

## Permanent regression coverage

`make check` requires no Python dependency. Its Node tests cover opt-in activation, absence of history rewriting/model tools, protected outputs, exit 7 and middle failure evidence, immutable inputs, fallback, atomic original recovery, store budget, unpublished-artifact rollback, platform paths, concurrency admission, protocol identity, timeout, cancellation, and output caps.

`make headroom-test` adds real pinned-engine tests: middle error and normal-record evidence, all-row preservation, CSV escaping, Unicode, types, rejected JSON shapes/duplicate keys, deliberately corrupted engine output, offline behavior, and an actual Node → Python → original-file integration. This target fails rather than silently skipping when the runtime is missing. The regular Node suite explicitly skips its two real-engine integration tests unless `PI_CORE_HEADROOM_PYTHON` is supplied.

The corresponding `agent-memory` correction has a permanent FTS regression with the synthetic Atlas corpus: correct BM25 direction, retained sub-six-decimal score differences, and precision cutoff behavior. It belongs in that repository rather than duplicating its implementation here. Re-running the same temporary 19-query lexical benchmark after updating the installed CLI improved expected top-1 retrieval from 7/15 to 13/15 answerable/control queries; abstention remained 4/4 and explicit project isolation had no violations. The two strong vocabulary-shift paraphrases still failed. These are synthetic lexical results, not a hybrid-search or production-quality benchmark.

## Acceptance before expanding the pilot

The temporary measurements motivated this implementation but did not establish end-to-end task quality. Compare real, equivalent Pi/Astra tasks with this pilot off/on. Record correct verified completion, total tool/model calls (including recovery), elapsed time, tokens/cost, and interventions. Do not promote it globally based solely on byte reduction or selected marker retention. RTK and ICM are not installed or wired into the harness by this change.
