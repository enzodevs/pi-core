#!/usr/bin/env python3
"""Initialize, validate, and render evidence-first code-review ledgers."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

REVIEW_STATES = {"pending", "reviewed", "not_applicable", "deferred"}
DISPOSITIONS = {"confirmed", "suppressed", "deferred"}
SEVERITIES = {"P0", "P1", "P2", "P3"}


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"Cannot read {path}: {error}") from error
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object in {path}")
    return value


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def initialize(manifest: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "manifest_diff_sha256": manifest.get("diff_sha256"),
        "review": {
            "state": "open",
            "created_at": datetime.now(UTC).isoformat(),
            "reviewer": "",
            "intent": "",
            "invariants": [],
        },
        "coverage": [
            {
                "item_id": item["id"],
                "path": item["path"],
                "status": "pending",
                "checks": [],
                "summary": "",
                "proof_gap": "",
            }
            for item in manifest.get("items", [])
        ],
        "candidates": [],
    }


def is_nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def is_nonempty_list(value: Any) -> bool:
    return isinstance(value, list) and len(value) > 0


def line_is_changed(item: dict[str, Any], line: int) -> bool:
    return any(
        isinstance(entry, dict)
        and isinstance(entry.get("start"), int)
        and isinstance(entry.get("end"), int)
        and entry["start"] <= line <= entry["end"]
        for entry in item.get("changed_ranges", [])
    )


def validate(manifest: dict[str, Any], ledger: dict[str, Any]) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    items = {item.get("id"): item for item in manifest.get("items", []) if item.get("id")}

    if ledger.get("manifest_diff_sha256") != manifest.get("diff_sha256"):
        errors.append("Ledger diff hash does not match the immutable review manifest")

    review = ledger.get("review")
    if not isinstance(review, dict):
        errors.append("review must be an object")
    else:
        if review.get("state") not in {"complete", "incomplete"}:
            errors.append("review.state must be complete or incomplete")
        for field in ("reviewer", "intent"):
            if not is_nonempty_string(review.get(field)):
                errors.append(f"review.{field} is required")
        if not is_nonempty_list(review.get("invariants")):
            errors.append("review.invariants must be a non-empty list")

    coverage_entries = ledger.get("coverage")
    if not isinstance(coverage_entries, list):
        return [*errors, "coverage must be a list"], warnings

    seen_coverage: set[str] = set()
    for index, entry in enumerate(coverage_entries):
        label = f"coverage[{index}]"
        if not isinstance(entry, dict):
            errors.append(f"{label} must be an object")
            continue
        item_id = entry.get("item_id")
        if item_id not in items:
            errors.append(f"{label} references unknown item_id {item_id!r}")
            continue
        if item_id in seen_coverage:
            errors.append(f"{label} duplicates item_id {item_id}")
        seen_coverage.add(item_id)
        if entry.get("path") != items[item_id].get("path"):
            errors.append(f"{label}.path must match the manifest item path")
        state = entry.get("status")
        if state not in REVIEW_STATES:
            errors.append(f"{label}.status must be one of {sorted(REVIEW_STATES)}")
        if state == "pending":
            errors.append(f"{label} is still pending")
        if state == "reviewed":
            if not is_nonempty_list(entry.get("checks")):
                errors.append(f"{label}.checks must describe the review work performed")
            if not is_nonempty_string(entry.get("summary")):
                errors.append(f"{label}.summary is required after review")
        if state == "not_applicable" and not is_nonempty_string(entry.get("summary")):
            errors.append(f"{label}.summary must explain why the item is not applicable")
        if state == "deferred":
            if not is_nonempty_string(entry.get("proof_gap")):
                errors.append(f"{label}.proof_gap is required when review is deferred")
            warnings.append(f"Incomplete coverage: {items[item_id]['path']}")

    missing = set(items) - seen_coverage
    if missing:
        errors.append(f"Missing coverage entries for: {', '.join(sorted(missing))}")

    candidates = ledger.get("candidates")
    if not isinstance(candidates, list):
        return [*errors, "candidates must be a list"], warnings

    seen_candidates: set[str] = set()
    for index, candidate in enumerate(candidates):
        label = f"candidates[{index}]"
        if not isinstance(candidate, dict):
            errors.append(f"{label} must be an object")
            continue
        candidate_id = candidate.get("id")
        if not is_nonempty_string(candidate_id):
            errors.append(f"{label}.id is required")
        elif candidate_id in seen_candidates:
            errors.append(f"{label}.id {candidate_id!r} is duplicated")
        else:
            seen_candidates.add(candidate_id)

        item_id = candidate.get("item_id")
        item = items.get(item_id)
        if item is None:
            errors.append(f"{label} references unknown item_id {item_id!r}")
            continue
        if candidate.get("path") != item.get("path"):
            errors.append(f"{label}.path must match the manifest item path")

        disposition = candidate.get("disposition")
        if disposition not in DISPOSITIONS:
            errors.append(f"{label}.disposition must be one of {sorted(DISPOSITIONS)}")
            continue

        if disposition == "confirmed":
            severity = candidate.get("severity")
            if severity not in SEVERITIES:
                errors.append(f"{label}.severity must be one of {sorted(SEVERITIES)}")
            confidence = candidate.get("confidence")
            if not isinstance(confidence, int | float) or isinstance(confidence, bool):
                errors.append(f"{label}.confidence must be a number")
            elif not 0.0 <= float(confidence) <= 1.0:
                errors.append(f"{label}.confidence must be between 0 and 1")
            elif float(confidence) < 0.8:
                errors.append(f"{label} must be deferred below 0.8 confidence")
            for field in ("title", "invariant", "failure_path", "impact", "remediation"):
                if not is_nonempty_string(candidate.get(field)):
                    errors.append(f"{label}.{field} is required for confirmed findings")
            for field in ("evidence", "counterevidence_checked", "verification"):
                if not is_nonempty_list(candidate.get(field)):
                    errors.append(f"{label}.{field} must be a non-empty list")
            if item.get("status") == "D":
                if candidate.get("anchor") != "deletion":
                    errors.append(f"{label}.anchor must be 'deletion' for deleted files")
            else:
                line = candidate.get("line")
                if not isinstance(line, int) or isinstance(line, bool):
                    errors.append(f"{label}.line must identify a changed line")
                elif not line_is_changed(item, line):
                    errors.append(f"{label}.line {line} is not within a changed range")
        elif disposition == "suppressed":
            if not is_nonempty_string(candidate.get("suppression_reason")):
                errors.append(f"{label}.suppression_reason is required")
            if not is_nonempty_list(candidate.get("counterevidence")):
                errors.append(f"{label}.counterevidence must be a non-empty list")
        elif disposition == "deferred":
            if not is_nonempty_string(candidate.get("proof_gap")):
                errors.append(f"{label}.proof_gap is required")
            warnings.append(f"Deferred candidate: {candidate_id}")

    return errors, warnings


def render(manifest: dict[str, Any], ledger: dict[str, Any]) -> str:
    items = {item.get("id"): item for item in manifest.get("items", [])}
    candidates = ledger.get("candidates", [])
    confirmed = [
        candidate
        for candidate in candidates
        if isinstance(candidate, dict) and candidate.get("disposition") == "confirmed"
    ]
    order = {"P0": 0, "P1": 1, "P2": 2, "P3": 3}
    confirmed.sort(
        key=lambda finding: (order.get(finding.get("severity"), 9), -finding.get("confidence", 0))
    )

    reviewed = sum(
        entry.get("status") in {"reviewed", "not_applicable"}
        for entry in ledger.get("coverage", [])
    )
    deferred_coverage = [
        entry for entry in ledger.get("coverage", []) if entry.get("status") == "deferred"
    ]
    deferred_candidates = [
        candidate
        for candidate in candidates
        if isinstance(candidate, dict) and candidate.get("disposition") == "deferred"
    ]
    base = manifest.get("scope", {}).get("base")
    head = manifest.get("scope", {}).get("head")
    suppressed_count = sum(
        candidate.get("disposition") == "suppressed"
        for candidate in candidates
        if isinstance(candidate, dict)
    )

    lines = ["# Evidence-first code review", "", "## Findings", ""]
    if not confirmed:
        if deferred_coverage or deferred_candidates:
            lines.append(
                "No confirmed findings, but the review has unresolved coverage or proof gaps."
            )
        else:
            lines.append(
                "No confirmed findings. The review ledger accounts for the complete change scope."
            )
    for finding in confirmed:
        location = finding["path"]
        if isinstance(finding.get("line"), int):
            location += f":{finding['line']}"
        lines.extend(
            [
                f"### [{finding['severity']}] {finding['title']}",
                "",
                f"- Location: `{location}`",
                f"- Confidence: {float(finding['confidence']):.2f}",
                f"- Invariant: {finding['invariant']}",
                f"- Failure path: {finding['failure_path']}",
                f"- Impact: {finding['impact']}",
                f"- Evidence: {'; '.join(str(value) for value in finding['evidence'])}",
                "- Counterevidence checked: "
                + "; ".join(str(value) for value in finding["counterevidence_checked"]),
                f"- Verification: {'; '.join(str(value) for value in finding['verification'])}",
                f"- Remediation: {finding['remediation']}",
                "",
            ]
        )

    lines.extend(
        [
            "## Coverage",
            "",
            f"- Diff: `{base}` → `{head}`",
            f"- Accounted items: {reviewed}/{len(items)}",
            f"- Confirmed findings: {len(confirmed)}",
            f"- Suppressed candidates: {suppressed_count}",
            f"- Deferred candidates: {len(deferred_candidates)}",
        ]
    )
    if deferred_coverage:
        lines.extend(["", "### Coverage gaps", ""])
        for entry in deferred_coverage:
            lines.append(f"- `{entry.get('path')}`: {entry.get('proof_gap')}")
    if deferred_candidates:
        lines.extend(["", "### Deferred candidates", ""])
        for candidate in deferred_candidates:
            path = items.get(candidate.get("item_id"), {}).get("path", candidate.get("path"))
            lines.append(f"- `{path}` — {candidate.get('id')}: {candidate.get('proof_gap')}")
    return "\n".join(lines).rstrip() + "\n"


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(description=__doc__)
    subcommands = command.add_subparsers(dest="command", required=True)

    init = subcommands.add_parser("init", help="Create a pending ledger from a manifest")
    init.add_argument("--manifest", type=Path, required=True)
    init.add_argument("--output", type=Path, required=True)

    check = subcommands.add_parser("validate", help="Validate coverage and finding evidence")
    check.add_argument("--manifest", type=Path, required=True)
    check.add_argument("--ledger", type=Path, required=True)
    check.add_argument("--strict", action="store_true", help="Treat deferred work as failure")

    report = subcommands.add_parser("render", help="Render a validated Markdown review")
    report.add_argument("--manifest", type=Path, required=True)
    report.add_argument("--ledger", type=Path, required=True)
    report.add_argument("--output", type=Path)
    return command


def main() -> int:
    args = parser().parse_args()
    try:
        manifest = load_json(args.manifest)
        if args.command == "init":
            write_json(args.output, initialize(manifest))
            return 0
        ledger = load_json(args.ledger)
        errors, warnings = validate(manifest, ledger)
        if args.command == "validate":
            for warning in warnings:
                print(f"warning: {warning}", file=sys.stderr)
            for error in errors:
                print(f"error: {error}", file=sys.stderr)
            if errors or (args.strict and warnings):
                return 1
            print(
                f"review ledger valid: {len(manifest.get('items', []))} items, "
                f"{len(ledger.get('candidates', []))} candidates"
            )
            return 0
        rendered = render(manifest, ledger)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(rendered, encoding="utf-8")
        else:
            sys.stdout.write(rendered)
        return 0
    except ValueError as error:
        print(f"review_ledger: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
