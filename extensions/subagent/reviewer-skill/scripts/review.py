#!/usr/bin/env python3
"""Small agent-facing facade. JSON artifacts, explicit workspace, one ledger owner."""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Never

if not __package__:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts import review_ledger as ledger_tools
from scripts import review_scope as scope_tools
from scripts import review_workspace as workspace_tools


def emit(value: dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=True, separators=(",", ":")))


@contextmanager
def writer_lock(workspace: Path):
    """Fail fast on concurrent writers; never overwrite a lock after a crash."""
    lock = workspace / ".ledger-writer.lock"
    try:
        fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as error:
        raise ValueError(
            f"Ledger writer active or interrupted: {lock}. Use one consolidator; "
            "only remove a stale lock after verifying its owner has stopped."
        ) from error
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(str(os.getpid()))
        yield
    finally:
        lock.unlink()


def select_item(manifest: dict[str, Any], path: str) -> dict[str, Any]:
    matches = [item for item in manifest["items"] if item["path"] == path]
    if len(matches) != 1:
        raise ValueError(
            f"Expected one changed item for {path!r}; use status to select its exact path"
        )
    return matches[0]


def anchor_code(manifest: dict[str, Any], item: dict[str, Any], code: str, old: bool) -> int:
    repo = Path(manifest["repository"])
    change = scope_tools.Change(item["status"], item["path"], item.get("old_path"))
    if old:
        content = scope_tools.run_git(
            repo,
            "show",
            f"{manifest['scope']['base']}:{change.old_path or change.path}",
            text=False,
        )
    else:
        content = scope_tools.file_bytes(repo, manifest["scope"], change)
    assert isinstance(content, bytes)
    lines = content.decode("utf-8", errors="replace").splitlines()
    needle = code.splitlines()
    matches = [
        i + 1
        for i in range(len(lines) - len(needle) + 1)
        if needle and lines[i : i + len(needle)] == needle
    ]
    if len(matches) != 1:
        raise ValueError(f"Code anchor has {len(matches)} matches; supply a unique snippet or line")
    return matches[0]


def check_anchor(item: dict[str, Any], candidate: dict[str, Any]) -> None:
    if item["status"] == "D":
        if candidate.get("anchor") != "deletion":
            raise ValueError("Deleted file requires anchor=deletion")
        return
    if candidate.get("anchor") == "deletion":
        line = candidate.get("old_line")
        valid = (
            isinstance(line, int)
            and not isinstance(line, bool)
            and any(
                point["old_start"] <= line <= point["old_end"]
                for point in item.get("deletion_points", [])
            )
        )
    else:
        line = candidate.get("line")
        valid = (
            isinstance(line, int)
            and not isinstance(line, bool)
            and ledger_tools.line_is_changed(
                item,
                line,
            )
        )
    if not valid:
        raise ValueError(
            "Anchor is outside changed behavior; use show and select a new/removed line"
        )


def numbered_patch(patch: str) -> str:
    old = new = 0
    in_hunk = False
    result = []
    for line in patch.splitlines():
        match = scope_tools.HUNK_RE.match(line)
        if match:
            in_hunk = True
            old, new = int(match.group("old_start")), int(match.group("start"))
            result.append(line)
        elif not in_hunk and line.startswith(("---", "+++")):
            result.append(line)
        elif line.startswith("-"):
            result.append(f"old:{old} {line}")
            old += 1
        elif line.startswith("+"):
            result.append(f"new:{new} {line}")
            new += 1
        else:
            result.append(line)
    return "\n".join(result)


def run(args: argparse.Namespace) -> dict[str, Any]:
    if args.command == "start":
        if args.staged and args.base:
            raise ValueError("--staged cannot be combined with --base")
        if args.merge_base and not args.base:
            raise ValueError("--merge-base requires --base")
        if args.head != "HEAD" and (args.working_tree or not args.base):
            raise ValueError("--head requires a committed --base range")
        manifest = scope_tools.build_manifest(args)
        temporary_root = Path(tempfile.gettempdir()).resolve()
        if temporary_root.is_relative_to(Path(manifest["repository"])):
            raise ValueError("TMPDIR is inside the target repository; select an external TMPDIR")
        workspace = workspace_tools.create_workspace(temporary_root, 0)
        ledger_tools.write_json(workspace / "manifest.json", manifest)
        ledger_tools.write_json(workspace / "ledger.json", ledger_tools.initialize(manifest))
        return {
            "workspace": str(workspace),
            "scope": manifest["scope"],
            **manifest["summary"],
            "next": "Set reviewer, intent and invariants; see intent --help",
        }

    workspace, _ = workspace_tools.validate_workspace(args.workspace)
    manifest = ledger_tools.load_json(workspace / "manifest.json")
    if workspace.is_relative_to(Path(manifest["repository"]).resolve()):
        raise ValueError("Review artifacts must be outside the target repository")
    scope_tools.assert_fresh(manifest)
    if args.command == "show":
        item = select_item(manifest, args.path)
        change = scope_tools.Change(item["status"], item["path"], item.get("old_path"))
        text = numbered_patch(
            scope_tools.item_patch(Path(manifest["repository"]), manifest["scope"], change)
        )
        limit = len(text) if args.full else 12000
        return {
            "item": item,
            "patch": text[:limit],
            "total_characters": len(text),
            "truncated": len(text) > limit,
            "next": "Use --full if truncated; inspect full source and callers separately",
        }
    if args.command == "status":
        ledger = ledger_tools.load_json(workspace / "ledger.json")
        errors, warnings = ledger_tools.validate(manifest, ledger, final=False)
        rows = ledger["coverage"]
        selected = rows[args.offset : args.offset + args.limit]
        return {
            "state": ledger["review"]["state"],
            "total": len(rows),
            "items": [{key: row[key] for key in ("path", "status")} for row in selected],
            "remaining": max(0, len(rows) - args.offset - len(selected)),
            "candidates": len(ledger["candidates"]),
            "errors": errors[:20],
            "error_count": len(errors),
            "warnings": warnings[:20],
            "warning_count": len(warnings),
            "next": "show --workspace <workspace> --path <path>; paginate status with --offset",
        }

    with writer_lock(workspace):
        ledger = ledger_tools.load_json(workspace / "ledger.json")
        if args.command == "intent":
            for field, value in {
                "reviewer": args.reviewer,
                "intent": args.text,
                "invariants": args.invariant,
                "approved_decisions": args.approved,
                "not_yet": args.not_yet,
                "questions": args.question,
            }.items():
                if value is not None:
                    ledger["review"][field] = value
        elif args.command == "mark":
            item = select_item(manifest, args.path)
            row = next(row for row in ledger["coverage"] if row["item_id"] == item["id"])
            row.update(
                status=args.status,
                checks=args.check,
                summary=args.summary,
                proof_gap=args.proof_gap,
            )
        elif args.command == "cand":
            data = (
                json.load(sys.stdin)
                if args.data == "-"
                else ledger_tools.load_json(Path(args.data))
            )
            if not isinstance(data, dict):
                raise ValueError("Candidate data must be a JSON object")
            existing = next((c for c in ledger["candidates"] if c["id"] == data.get("id")), None)
            if args.operation == "update" and existing is None:
                raise ValueError("Unknown candidate id; use cand add first")
            if args.operation == "add" and existing is not None:
                raise ValueError("Candidate id already exists; use cand update")
            candidate: dict[str, Any] = {**(existing or {}), **data}
            item = select_item(manifest, candidate.get("path", ""))
            if existing and existing["item_id"] != item["id"]:
                raise ValueError(
                    "Cannot move a candidate to another item; add a separate candidate"
                )
            candidate["item_id"] = item["id"]
            next_id = len(ledger["candidates"]) + 1
            used_ids = {entry["id"] for entry in ledger["candidates"]}
            while f"C-{next_id:03d}" in used_ids:
                next_id += 1
            candidate.setdefault("id", f"C-{next_id:03d}")
            candidate.setdefault("disposition", "open")
            if args.code is not None:
                old = candidate.get("anchor") == "deletion"
                candidate["old_line" if old else "line"] = anchor_code(
                    manifest, item, args.code, old
                )
            check_anchor(item, candidate)
            if existing is None:
                ledger["candidates"].append(candidate)
            else:
                existing.clear()
                existing.update(candidate)
        elif args.command == "finish":
            ledger["review"]["state"] = args.state

        if args.command != "finish":
            ledger["review"]["state"] = "open"
        errors, warnings = ledger_tools.validate(manifest, ledger, final=args.command == "finish")
        if errors or (args.command == "finish" and args.strict and warnings):
            issues = errors + (warnings if args.command == "finish" and args.strict else [])
            raise ValueError(f"{len(issues)} issues: " + "; ".join(issues[:20]))
        scope_tools.assert_fresh(manifest)
        ledger_tools.write_json(workspace / "ledger.json", ledger)
        if args.command != "finish":
            (workspace / "report.md").unlink(missing_ok=True)
        if args.command == "finish":
            report = ledger_tools.render(manifest, ledger)
            (workspace / "report.md").write_text(report, encoding="utf-8")
            return {
                "report": str(workspace / "report.md"),
                "warnings": warnings[:20],
                "warning_count": len(warnings),
                "next": "Deliver report.md; retain artifacts through the correction cycle",
            }
        result = {
            "updated": args.command,
            "warnings": warnings[:20],
            "warning_count": len(warnings),
            "next": "Resolve coverage and candidates, then finish --strict",
        }
        if args.command == "cand":
            result["candidate"] = {key: candidate[key] for key in ("id", "path", "disposition")}
        return result


class Parser(argparse.ArgumentParser):
    def error(self, message: str) -> Never:
        emit({"error": message, "help": self.format_usage().strip()})
        raise SystemExit(2)


def parser() -> argparse.ArgumentParser:
    command = Parser(description=__doc__)
    subs = command.add_subparsers(dest="command", required=True)
    start = subs.add_parser(
        "start", help="Inventory WIP by default; --base alone selects committed range"
    )
    start.add_argument("--repo", type=Path, default=Path.cwd())
    start.add_argument("--base")
    start.add_argument("--head", default="HEAD")
    start.add_argument("--merge-base", action="store_true")
    modes = start.add_mutually_exclusive_group()
    modes.add_argument("--staged", action="store_true")
    modes.add_argument("--working-tree", action="store_true")
    for name in ("status", "show", "intent", "mark", "cand", "finish"):
        sub = subs.add_parser(name)
        sub.add_argument("--workspace", type=Path, required=True)
        if name == "status":
            sub.add_argument("--offset", type=int, default=0)
            sub.add_argument("--limit", type=int, default=50)
        elif name == "show":
            sub.add_argument("--path", required=True)
            sub.add_argument("--full", action="store_true")
        elif name == "intent":
            sub.add_argument("--reviewer")
            sub.add_argument("--text")
            for flag in ("invariant", "approved", "not-yet", "question"):
                sub.add_argument(f"--{flag}", action="append")
        elif name == "mark":
            sub.add_argument("--path", required=True)
            sub.add_argument("--status", choices=sorted(ledger_tools.REVIEW_STATES), required=True)
            sub.add_argument("--check", action="append", default=[])
            sub.add_argument("--summary", default="")
            sub.add_argument("--proof-gap", default="")
        elif name == "cand":
            sub.add_argument("operation", choices=("add", "update"))
            sub.add_argument(
                "--data", required=True, help="JSON file or - for stdin; update requires id"
            )
            sub.add_argument(
                "--code", help="Unique exact full-line snippet; deletion uses old side"
            )
        else:
            sub.add_argument("--strict", action="store_true")
            sub.add_argument("--state", choices=("complete", "incomplete"), default="complete")
    return command


def main() -> int:
    if len(sys.argv) == 1:
        emit(
            {
                "state": "no workspace selected",
                "next": "review.py start --repo <repo>, or status --workspace <path>",
            }
        )
        return 0
    args = parser().parse_args()
    try:
        if args.command == "status" and (args.offset < 0 or not 1 <= args.limit <= 500):
            raise ValueError("status requires --offset >= 0 and --limit between 1 and 500")
        emit(run(args))
        return 0
    except (OSError, ValueError, scope_tools.ScopeError, workspace_tools.WorkspaceError) as error:
        emit(
            {
                "error": str(error),
                "next": "Fix the stated input or scope; use the subcommand --help",
            }
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
