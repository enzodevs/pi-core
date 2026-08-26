#!/usr/bin/env python3
"""Create and safely finalize temporary evidence-first review workspaces."""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path

MARKER_NAME = ".evidence-first-code-review-workspace.json"
PREFIX = "evidence-review-"
CANONICAL_ARTIFACTS = ("manifest.json", "ledger.json", "report.md")
SCHEMA_VERSION = 1


class WorkspaceError(RuntimeError):
    """Raised when a workspace operation cannot be completed safely."""


def utc_now() -> datetime:
    return datetime.now(UTC)


def marker_payload(workspace: Path, created_at: datetime | None = None) -> dict[str, object]:
    return {
        "schema_version": SCHEMA_VERSION,
        "path": str(workspace.resolve()),
        "created_at": (created_at or utc_now()).isoformat(),
    }


def write_marker(workspace: Path, created_at: datetime | None = None) -> None:
    marker = workspace / MARKER_NAME
    marker.write_text(
        json.dumps(marker_payload(workspace, created_at), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def validate_workspace(path: Path) -> tuple[Path, dict[str, object]]:
    if path.is_symlink():
        raise WorkspaceError(f"Workspace must not be a symlink: {path}")
    workspace = path.resolve()
    forbidden = {Path("/").resolve(), Path.home().resolve(), Path(tempfile.gettempdir()).resolve()}
    if workspace in forbidden:
        raise WorkspaceError(f"Refusing broad workspace path: {workspace}")
    if not workspace.is_dir():
        raise WorkspaceError(f"Workspace does not exist: {workspace}")

    marker = workspace / MARKER_NAME
    if marker.is_symlink() or not marker.is_file():
        raise WorkspaceError(f"Workspace marker is missing or unsafe: {marker}")
    try:
        payload = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise WorkspaceError(f"Cannot read workspace marker: {error}") from error
    if not isinstance(payload, dict):
        raise WorkspaceError("Workspace marker must contain a JSON object")
    if payload.get("schema_version") != SCHEMA_VERSION:
        raise WorkspaceError("Unsupported workspace marker version")
    if payload.get("path") != str(workspace):
        raise WorkspaceError("Workspace marker path does not match the requested directory")
    return workspace, payload


def remove_workspace(path: Path) -> None:
    workspace, _payload = validate_workspace(path)
    shutil.rmtree(workspace)


def sweep_stale(root: Path, older_than_hours: float, now: datetime | None = None) -> int:
    if older_than_hours <= 0:
        return 0
    resolved_root = root.resolve()
    if not resolved_root.is_dir():
        raise WorkspaceError(f"Temporary root does not exist: {resolved_root}")

    threshold = (now or utc_now()) - timedelta(hours=older_than_hours)
    removed = 0
    for candidate in resolved_root.glob(f"{PREFIX}*"):
        if candidate.is_symlink() or not candidate.is_dir():
            continue
        try:
            workspace, payload = validate_workspace(candidate)
            created_at = datetime.fromisoformat(str(payload["created_at"]))
        except (KeyError, ValueError, WorkspaceError):
            continue
        if created_at.tzinfo is None:
            continue
        if created_at.astimezone(UTC) <= threshold:
            shutil.rmtree(workspace)
            removed += 1
    return removed


def create_workspace(root: Path, stale_after_hours: float = 24.0) -> Path:
    resolved_root = root.resolve()
    sweep_stale(resolved_root, stale_after_hours)
    workspace = Path(tempfile.mkdtemp(prefix=PREFIX, dir=resolved_root)).resolve()
    write_marker(workspace)
    return workspace


def copy_report(workspace: Path, destination: Path) -> Path:
    source, _payload = validate_workspace(workspace)
    target = destination.resolve(strict=False)
    if target == source or target.is_relative_to(source):
        raise WorkspaceError("Report destination must be outside the temporary workspace")
    if target.exists() and (not target.is_dir() or any(target.iterdir())):
        raise WorkspaceError(f"Report destination must be absent or empty: {target}")

    sources: list[Path] = []
    for name in CANONICAL_ARTIFACTS:
        artifact = source / name
        if artifact.is_symlink() or not artifact.is_file():
            raise WorkspaceError(f"Canonical review artifact is missing or unsafe: {artifact}")
        sources.append(artifact)

    target.mkdir(parents=True, exist_ok=True)
    for artifact in sources:
        shutil.copy2(artifact, target / artifact.name)
    return target


def finalize_workspace(path: Path, policy: str, destination: Path | None = None) -> str:
    workspace, _payload = validate_workspace(path)
    if policy == "keep":
        return f"kept review workspace: {workspace}"
    if policy == "report":
        if destination is None:
            raise WorkspaceError("--destination is required with --policy report")
        target = copy_report(workspace, destination)
        remove_workspace(workspace)
        return f"saved canonical review artifacts to {target} and removed {workspace}"
    remove_workspace(workspace)
    return f"removed review workspace: {workspace}"


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(description=__doc__)
    subcommands = command.add_subparsers(dest="command", required=True)

    create = subcommands.add_parser("create", help="Create a marked temporary workspace")
    create.add_argument("--root", type=Path, default=Path(tempfile.gettempdir()))
    create.add_argument(
        "--stale-after-hours",
        type=float,
        default=24.0,
        help="Remove older marked workspaces under the same root; use 0 to disable",
    )

    finalize = subcommands.add_parser("finalize", help="Retain or safely remove a workspace")
    finalize.add_argument("--path", type=Path, required=True)
    finalize.add_argument("--policy", choices=("cleanup", "keep", "report"), default="cleanup")
    finalize.add_argument("--destination", type=Path)

    sweep = subcommands.add_parser("sweep", help="Remove stale marked workspaces")
    sweep.add_argument("--root", type=Path, default=Path(tempfile.gettempdir()))
    sweep.add_argument("--older-than-hours", type=float, default=24.0)
    return command


def main() -> int:
    args = parser().parse_args()
    try:
        if args.command == "create":
            print(create_workspace(args.root, args.stale_after_hours))
            return 0
        if args.command == "finalize":
            print(finalize_workspace(args.path, args.policy, args.destination))
            return 0
        removed = sweep_stale(args.root, args.older_than_hours)
        print(f"removed {removed} stale review workspace(s)")
        return 0
    except WorkspaceError as error:
        print(f"review_workspace: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
