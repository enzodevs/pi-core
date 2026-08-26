#!/usr/bin/env python3
"""Build an immutable, machine-checkable inventory for a Git code review."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path, PurePosixPath
from typing import Any

SCHEMA_VERSION = 1
HUNK_RE = re.compile(r"^@@ -(?:\d+)(?:,\d+)? \+(?P<start>\d+)(?:,(?P<count>\d+))? @@")


class ScopeError(RuntimeError):
    """Raised when the requested review scope cannot be represented safely."""


@dataclass(frozen=True)
class Change:
    status: str
    path: str
    old_path: str | None = None


def run_git(repo: Path, *arguments: str, text: bool = True) -> str | bytes:
    completed = subprocess.run(
        ["git", "-C", str(repo), *arguments],
        check=False,
        capture_output=True,
        text=text,
    )
    if completed.returncode != 0:
        stderr = completed.stderr if text else completed.stderr.decode(errors="replace")
        raise ScopeError(stderr.strip() or f"git {' '.join(arguments)} failed")
    return completed.stdout


def repository_root(repo: Path) -> Path:
    result = run_git(repo, "rev-parse", "--show-toplevel")
    assert isinstance(result, str)
    return Path(result.strip()).resolve()


def resolve_revision(repo: Path, revision: str) -> str:
    result = run_git(repo, "rev-parse", "--verify", f"{revision}^{{commit}}")
    assert isinstance(result, str)
    return result.strip()


def parse_name_status(raw: bytes) -> list[Change]:
    fields = raw.split(b"\0")
    if fields and fields[-1] == b"":
        fields.pop()

    changes: list[Change] = []
    index = 0
    while index < len(fields):
        status = fields[index].decode("utf-8", errors="surrogateescape")
        index += 1
        if not status:
            continue
        if status[0] in {"R", "C"}:
            if index + 1 >= len(fields):
                raise ScopeError("Malformed rename/copy record from git diff")
            old_path = fields[index].decode("utf-8", errors="surrogateescape")
            path = fields[index + 1].decode("utf-8", errors="surrogateescape")
            index += 2
            changes.append(Change(status=status[0], path=path, old_path=old_path))
            continue
        if index >= len(fields):
            raise ScopeError("Malformed path record from git diff")
        path = fields[index].decode("utf-8", errors="surrogateescape")
        index += 1
        changes.append(Change(status=status[0], path=path))
    return changes


def diff_arguments(args: argparse.Namespace) -> tuple[list[str], dict[str, Any]]:
    if args.base:
        base_sha = resolve_revision(args.repo, args.base)
        head_sha = resolve_revision(args.repo, args.head)
        return [base_sha, head_sha], {
            "mode": "revisions",
            "base": base_sha,
            "head": head_sha,
            "requested_base": args.base,
            "requested_head": args.head,
        }
    if args.staged:
        head_sha = resolve_revision(args.repo, "HEAD")
        return ["--cached"], {"mode": "staged", "base": head_sha, "head": "INDEX"}
    head_sha = resolve_revision(args.repo, "HEAD")
    return [head_sha], {"mode": "working-tree", "base": head_sha, "head": "WORKTREE"}


def untracked_changes(repo: Path) -> list[Change]:
    raw = run_git(repo, "ls-files", "--others", "--exclude-standard", "-z", text=False)
    assert isinstance(raw, bytes)
    return [
        Change(status="A", path=value.decode("utf-8", errors="surrogateescape"))
        for value in raw.split(b"\0")
        if value
    ]


def safe_repo_path(repo: Path, relative_path: str) -> Path:
    candidate = (repo / relative_path).resolve(strict=False)
    if not candidate.is_relative_to(repo):
        raise ScopeError(f"Changed path escapes repository: {relative_path}")
    return candidate


def file_bytes(repo: Path, scope: dict[str, Any], change: Change) -> bytes:
    if change.status == "D":
        source_path = change.old_path or change.path
        content = run_git(repo, "show", f"{scope['base']}:{source_path}", text=False)
        assert isinstance(content, bytes)
        return content
    if scope["mode"] == "revisions":
        content = run_git(repo, "show", f"{scope['head']}:{change.path}", text=False)
        assert isinstance(content, bytes)
        return content
    if scope["mode"] == "staged":
        content = run_git(repo, "show", f":{change.path}", text=False)
        assert isinstance(content, bytes)
        return content
    working_path = repo / change.path
    safe_repo_path(repo, change.path)
    if working_path.is_symlink():
        return os.readlink(working_path).encode("utf-8", errors="surrogateescape")
    return working_path.read_bytes()


def changed_ranges(repo: Path, diff_args: list[str], change: Change) -> list[dict[str, int]]:
    pathspec = change.path
    output = run_git(
        repo,
        "diff",
        "--no-ext-diff",
        "--find-renames",
        "--unified=0",
        *diff_args,
        "--",
        pathspec,
    )
    assert isinstance(output, str)
    ranges: list[dict[str, int]] = []
    for line in output.splitlines():
        match = HUNK_RE.match(line)
        if not match:
            continue
        count = int(match.group("count") or "1")
        start = int(match.group("start"))
        if count > 0:
            ranges.append({"start": start, "end": start + count - 1})
    return ranges


def git_object_exists(repo: Path, object_name: str) -> bool:
    completed = subprocess.run(
        ["git", "-C", str(repo), "cat-file", "-e", object_name],
        check=False,
        capture_output=True,
    )
    return completed.returncode == 0


def instruction_files(repo: Path, changed_path: str, scope: dict[str, Any]) -> list[str]:
    parent = PurePosixPath(changed_path).parent
    directories = [PurePosixPath(".")]
    current = PurePosixPath()
    for part in parent.parts:
        if part in {"", "."}:
            continue
        current /= part
        directories.append(current)

    matches: list[str] = []
    for directory in directories:
        candidate = (directory / "AGENTS.md").as_posix()
        exists = False
        if scope["mode"] == "revisions":
            exists = git_object_exists(repo, f"{scope['head']}:{candidate}")
        elif scope["mode"] == "staged":
            exists = git_object_exists(repo, f":{candidate}")
        else:
            exists = safe_repo_path(repo, candidate).is_file()
        if exists:
            matches.append(candidate.removeprefix("./"))
    return matches


def risk_tags(path: str, content: bytes) -> list[str]:
    normalized = path.lower()
    sample = content[:250_000].decode("utf-8", errors="ignore").lower()
    tags: set[str] = set()
    path_rules = {
        "ci": (".github/workflows/", ".gitlab-ci", "jenkinsfile"),
        "dependencies": ("composer.json", "package.json", "pyproject.toml", "lock"),
        "database": ("migration", "schema", "database/"),
        "deployment": ("dockerfile", "docker-compose", "compose.", "deploy", "infra/"),
        "tests": ("tests/", ".test.", ".spec."),
        "authentication": ("auth", "login", "fortify", "oauth"),
    }
    for tag, needles in path_rules.items():
        if any(needle in normalized for needle in needles):
            tags.add(tag)

    content_rules = {
        "authorization": ("authorize(", "policy", "permission", "tenant_id"),
        "concurrency": ("concurrency", "mutex", "lock(", "transaction"),
        "external-io": ("http", "fetch(", "curl", "subprocess", "exec("),
        "secrets": ("secret", "token", "password", "credential"),
    }
    if b"\0" not in content:
        for tag, needles in content_rules.items():
            if any(needle in sample for needle in needles):
                tags.add(tag)
    return sorted(tags)


def bundle_key(path: str, tags: list[str]) -> str:
    normalized = path.lower()
    if normalized.startswith(".github/") or normalized.startswith("scripts/ci-"):
        return "ci"
    if normalized.startswith("tests/") or "tests" in tags:
        return "tests"
    if normalized.startswith("docs/"):
        return "docs"
    priority = ("ci", "deployment", "database", "authentication", "authorization")
    for tag in priority:
        if tag in tags:
            return tag
    parts = PurePosixPath(path).parts
    return parts[0] if len(parts) > 1 else "repository-root"


def item_identifier(change: Change) -> str:
    identity = f"{change.status}\0{change.old_path or ''}\0{change.path}".encode()
    return f"item-{hashlib.sha256(identity).hexdigest()[:12]}"


def build_manifest(args: argparse.Namespace) -> dict[str, Any]:
    repo = repository_root(args.repo)
    args.repo = repo
    selected_diff_args, scope = diff_arguments(args)
    raw = run_git(
        repo,
        "diff",
        "--name-status",
        "-z",
        "--find-renames",
        *selected_diff_args,
        text=False,
    )
    assert isinstance(raw, bytes)
    changes = parse_name_status(raw)
    untracked_paths: set[str] = set()
    if scope["mode"] == "working-tree":
        known = {change.path for change in changes}
        untracked = [change for change in untracked_changes(repo) if change.path not in known]
        untracked_paths = {change.path for change in untracked}
        changes.extend(untracked)

    items: list[dict[str, Any]] = []
    for change in changes:
        content = file_bytes(repo, scope, change)
        tags = risk_tags(change.path, content)
        ranges = (
            []
            if change.status == "D" or (scope["mode"] == "working-tree" and not selected_diff_args)
            else changed_ranges(repo, selected_diff_args, change)
        )
        if scope["mode"] == "working-tree" and change.status == "A" and not ranges:
            line_count = content.count(b"\n") + (
                1 if content and not content.endswith(b"\n") else 0
            )
            if line_count:
                ranges = [{"start": 1, "end": line_count}]
        items.append(
            {
                "id": item_identifier(change),
                **asdict(change),
                "binary": b"\0" in content,
                "size_bytes": len(content),
                "content_sha256": hashlib.sha256(content).hexdigest(),
                "changed_ranges": ranges,
                "instruction_files": instruction_files(repo, change.path, scope),
                "instruction_source": scope["head"],
                "risk_tags": tags,
                "suggested_bundle": bundle_key(change.path, tags),
            }
        )

    diff_bytes = run_git(
        repo,
        "diff",
        "--binary",
        "--no-ext-diff",
        "--find-renames",
        *selected_diff_args,
        text=False,
    )
    assert isinstance(diff_bytes, bytes)
    if scope["mode"] == "working-tree":
        for change in changes:
            if change.path in untracked_paths:
                path_bytes = change.path.encode("utf-8", errors="surrogateescape")
                diff_bytes += b"\0UNTRACKED\0" + path_bytes + b"\0"
                diff_bytes += file_bytes(repo, scope, change)

    bundles: dict[str, list[str]] = {}
    for item in items:
        bundles.setdefault(item["suggested_bundle"], []).append(item["id"])

    return {
        "schema_version": SCHEMA_VERSION,
        "repository": str(repo),
        "scope": scope,
        "diff_sha256": hashlib.sha256(diff_bytes).hexdigest(),
        "summary": {
            "item_count": len(items),
            "binary_count": sum(bool(item["binary"]) for item in items),
            "deleted_count": sum(item["status"] == "D" for item in items),
        },
        "bundles": [{"id": key, "item_ids": item_ids} for key, item_ids in sorted(bundles.items())],
        "items": items,
    }


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(description=__doc__)
    command.add_argument("--repo", type=Path, default=Path.cwd())
    scope = command.add_mutually_exclusive_group()
    scope.add_argument("--base", help="Base revision for a committed range")
    scope.add_argument("--staged", action="store_true", help="Review the index against HEAD")
    scope.add_argument(
        "--working-tree",
        action="store_true",
        help="Review tracked and untracked working-tree changes (default)",
    )
    command.add_argument("--head", default="HEAD", help="Head revision used with --base")
    command.add_argument("--output", type=Path, help="Write JSON to this path instead of stdout")
    return command


def main() -> int:
    args = parser().parse_args()
    try:
        manifest = build_manifest(args)
    except (OSError, ScopeError) as error:
        print(f"review_scope: {error}", file=sys.stderr)
        return 2
    encoded = json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    else:
        sys.stdout.write(encoded)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
