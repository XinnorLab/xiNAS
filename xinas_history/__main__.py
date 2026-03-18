"""CLI entry point for xiNAS Configuration History.

Usage:
    python3 -m xinas_history snapshot list [--format json|table]
    python3 -m xinas_history snapshot show <id> [--format json|yaml]
    python3 -m xinas_history snapshot create --source <source> --operation <op> [--preset <name>]
    python3 -m xinas_history snapshot diff <id1> <id2> [--format json|unified]
    python3 -m xinas_history snapshot reset-to-baseline --reason <text> [--yes] [--format json]
    python3 -m xinas_history gc run
    python3 -m xinas_history status
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from typing import Optional

import yaml

from .engine import SnapshotEngine
from .models import SnapshotStatus, SnapshotType
from .store import FilesystemStore


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="xinas-history",
        description="xiNAS Configuration History Management",
    )
    parser.add_argument("--store-path", default=None, help="Override store path")
    parser.add_argument("--repo-root", default="/opt/xiNAS", help="xiNAS repo root")
    parser.add_argument(
        "--grpc-address", default="localhost:6066", help="gRPC address",
    )

    subparsers = parser.add_subparsers(dest="command")

    # -- snapshot subcommand ------------------------------------------------
    snap_parser = subparsers.add_parser("snapshot", help="Snapshot operations")
    snap_sub = snap_parser.add_subparsers(dest="action")

    # snapshot list
    list_parser = snap_sub.add_parser("list", help="List snapshots")
    list_parser.add_argument(
        "--format", choices=["json", "table"], default="table",
    )

    # snapshot show
    show_parser = snap_sub.add_parser("show", help="Show snapshot details")
    show_parser.add_argument("id", help="Snapshot ID")
    show_parser.add_argument(
        "--format", choices=["json", "yaml"], default="yaml",
    )

    # snapshot create
    create_parser = snap_sub.add_parser("create", help="Create snapshot")
    create_parser.add_argument("--source", required=True)
    create_parser.add_argument("--operation", required=True)
    create_parser.add_argument("--preset", default="")
    create_parser.add_argument(
        "--type",
        default="rollback_eligible",
        choices=["baseline", "rollback_eligible", "ephemeral"],
    )
    create_parser.add_argument(
        "--summary", default=None, help="Diff summary",
    )

    # snapshot diff
    diff_parser = snap_sub.add_parser("diff", help="Diff two snapshots")
    diff_parser.add_argument("from_id")
    diff_parser.add_argument("to_id")
    diff_parser.add_argument(
        "--format", choices=["json", "unified"], default="unified",
    )

    # snapshot reset-to-baseline
    reset_parser = snap_sub.add_parser(
        "reset-to-baseline", help="Reset to initial baseline configuration",
    )
    reset_parser.add_argument(
        "--reason", required=True, help="Audit reason for the reset",
    )
    reset_parser.add_argument(
        "--yes", action="store_true",
        help="Execute the reset (without --yes, shows plan only)",
    )
    reset_parser.add_argument(
        "--format", choices=["json", "text"], default="text",
    )
    reset_parser.add_argument(
        "--source", default="api",
        help="Operation source (default: api)",
    )

    # -- gc subcommand ------------------------------------------------------
    gc_parser = subparsers.add_parser("gc", help="Garbage collection")
    gc_sub = gc_parser.add_subparsers(dest="action")
    gc_sub.add_parser("run", help="Run GC")

    # -- status subcommand --------------------------------------------------
    status_parser = subparsers.add_parser("status", help="Show history status")
    status_parser.add_argument(
        "--format", choices=["json", "table"], default="table",
    )

    args = parser.parse_args()

    if args.command is None:
        parser.print_help()
        return 1

    # Build engine
    store_kwargs = {}
    if args.store_path:
        store_kwargs["root"] = args.store_path
    store = FilesystemStore(**store_kwargs)
    engine = SnapshotEngine(
        store=store,
        repo_root=args.repo_root,
        grpc_address=args.grpc_address,
    )

    # Dispatch
    try:
        if args.command == "snapshot":
            return _dispatch_snapshot(args, engine)
        elif args.command == "gc":
            return _dispatch_gc(args, engine)
        elif args.command == "status":
            return _dispatch_status(args, engine)
        else:
            parser.print_help()
            return 1
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


# ---------------------------------------------------------------------------
# Snapshot subcommand handlers
# ---------------------------------------------------------------------------


def _dispatch_snapshot(args: argparse.Namespace, engine: SnapshotEngine) -> int:
    if args.action is None:
        print(
            "Error: specify an action: list, show, create, diff, reset-to-baseline",
            file=sys.stderr,
        )
        return 1

    if args.action == "list":
        return _cmd_snapshot_list(args, engine)
    elif args.action == "show":
        return _cmd_snapshot_show(args, engine)
    elif args.action == "create":
        return _cmd_snapshot_create(args, engine)
    elif args.action == "diff":
        return _cmd_snapshot_diff(args, engine)
    elif args.action == "reset-to-baseline":
        return _cmd_snapshot_reset_to_baseline(args, engine)
    else:
        print(f"Error: unknown snapshot action: {args.action}", file=sys.stderr)
        return 1


def _cmd_snapshot_list(args: argparse.Namespace, engine: SnapshotEngine) -> int:
    manifests = engine.list_snapshots()

    if args.format == "json":
        print(json.dumps([m.to_dict() for m in manifests], indent=2))
        return 0

    # Table format
    if not manifests:
        print("No snapshots found.")
        return 0

    # Header
    header = f"{'ID':<45} {'Timestamp':<25} {'Operation':<18} {'Status':<12} {'Rollback Class'}"
    print(header)
    print("-" * len(header))

    for m in manifests:
        print(
            f"{m.id:<45} {m.timestamp:<25} {m.operation:<18} "
            f"{m.status:<12} {m.rollback_class}"
        )

    return 0


def _cmd_snapshot_show(args: argparse.Namespace, engine: SnapshotEngine) -> int:
    manifest = engine.get_snapshot(args.id)
    if manifest is None:
        print(f"Error: snapshot not found: {args.id}", file=sys.stderr)
        return 1

    data = manifest.to_dict()

    if args.format == "json":
        print(json.dumps(data, indent=2))
    else:
        print(yaml.safe_dump(data, default_flow_style=False, sort_keys=False))

    return 0


def _cmd_snapshot_create(args: argparse.Namespace, engine: SnapshotEngine) -> int:
    snapshot_type = args.type

    if snapshot_type == "baseline":
        manifest = asyncio.run(
            engine.create_baseline(
                source=args.source,
                preset=args.preset,
            )
        )
    else:
        manifest = asyncio.run(
            engine.create_snapshot(
                source=args.source,
                operation=args.operation,
                preset=args.preset,
                snapshot_type=snapshot_type,
                diff_summary=args.summary,
            )
        )

    print(manifest.id)
    return 0


def _cmd_snapshot_diff(args: argparse.Namespace, engine: SnapshotEngine) -> int:
    diff_result = engine.diff(args.from_id, args.to_id)

    if args.format == "json":
        print(json.dumps(diff_result.to_dict(), indent=2))
        return 0

    # Unified / human-readable format
    print(f"Diff: {diff_result.from_id} -> {diff_result.to_id}")
    print(f"Rollback class: {diff_result.rollback_class}")
    print(f"Summary: {diff_result.summary}")
    print()

    if diff_result.config_changes:
        print("Config changes:")
        for change in diff_result.config_changes:
            marker = _change_marker(change.get("change_type", ""))
            print(f"  {marker} {change.get('file', change.get('summary', ''))}")
        print()

    if diff_result.runtime_changes:
        print("Runtime changes:")
        for change in diff_result.runtime_changes:
            marker = _change_marker(change.get("change_type", ""))
            print(
                f"  {marker} {change.get('resource', change.get('summary', ''))}"
            )
        print()

    if not diff_result.config_changes and not diff_result.runtime_changes:
        print("No differences found.")

    return 0


def _cmd_snapshot_reset_to_baseline(
    args: argparse.Namespace, engine: SnapshotEngine,
) -> int:
    """Handle ``snapshot reset-to-baseline`` — plan or execute baseline reset."""
    from .runner import TransactionalRunner

    # Verify baseline exists
    try:
        baseline = engine.get_baseline_manifest()
    except ValueError as exc:
        _error_output(args, str(exc))
        return 1

    if not args.yes:
        # Plan mode — show what would happen
        effective = engine.get_current_effective()
        plan: dict = {
            "mode": "plan",
            "baseline_id": baseline.id,
            "baseline_timestamp": baseline.timestamp,
            "baseline_preset": baseline.preset,
            "rollback_class": "destroying_data",
            "warning": (
                "This will reset ALL configuration to the initial baseline "
                "state. RAID arrays, NFS exports, network settings, and all "
                "managed services will be reverted."
            ),
        }
        if effective:
            try:
                diff_result = engine.diff(effective.id, baseline.id)
                plan["diff"] = diff_result.to_dict()
                plan["current_effective_id"] = effective.id
            except Exception:
                plan["diff"] = None
                plan["current_effective_id"] = effective.id

        if args.format == "json":
            print(json.dumps(plan, indent=2))
        else:
            print("Reset to Baseline — Plan")
            print("=" * 40)
            print(f"Baseline:  {baseline.id}")
            print(f"Created:   {baseline.timestamp}")
            print(f"Preset:    {baseline.preset}")
            print(f"Risk:      DESTROYING_DATA")
            print()
            print("WARNING: {}\n".format(plan["warning"]))
            if effective:
                print(f"Current effective: {effective.id}")
            print("\nRun with --yes to execute the reset.")
        return 0

    # Execute mode
    runner = TransactionalRunner(engine=engine)

    def _progress(line: str) -> None:
        if args.format != "json":
            print(line)

    result = asyncio.run(
        runner.execute_reset_to_baseline(
            source=args.source,
            reason=args.reason,
            progress_cb=_progress,
        )
    )

    if args.format == "json":
        print(json.dumps(result.to_dict(), indent=2))
    else:
        if result.success:
            print(f"\nReset to baseline completed successfully.")
            print(f"Snapshot: {result.snapshot_id}")
        else:
            print(f"\nReset to baseline FAILED: {result.error}")
            if result.rollback_performed:
                status = "succeeded" if result.rollback_success else "FAILED"
                print(f"Auto-rollback: {status}")

    return 0 if result.success else 1


def _error_output(args: argparse.Namespace, message: str) -> None:
    """Print an error in the requested format."""
    fmt = getattr(args, "format", "text")
    if fmt == "json":
        print(json.dumps({"error": message}))
    else:
        print(f"Error: {message}", file=sys.stderr)


# ---------------------------------------------------------------------------
# GC subcommand handler
# ---------------------------------------------------------------------------


def _dispatch_gc(args: argparse.Namespace, engine: SnapshotEngine) -> int:
    if args.action is None or args.action != "run":
        print("Error: specify action: run", file=sys.stderr)
        return 1

    return _cmd_gc_run(engine)


def _cmd_gc_run(engine: SnapshotEngine) -> int:
    effective = engine.get_current_effective()
    effective_id = effective.id if effective else None

    purged = engine._gc.run(current_effective_id=effective_id)

    if purged:
        print(f"Purged {len(purged)} snapshot(s):")
        for sid in purged:
            print(f"  - {sid}")
    else:
        print("No snapshots purged.")

    return 0


# ---------------------------------------------------------------------------
# Status subcommand handler
# ---------------------------------------------------------------------------


def _dispatch_status(args: argparse.Namespace, engine: SnapshotEngine) -> int:
    summary = engine.get_history_summary()

    if args.format == "json":
        print(json.dumps(summary, indent=2))
        return 0

    # Table / human-readable format
    baseline = summary.get("baseline")
    current = summary.get("current_effective")
    total = summary.get("total_count", 0)
    eligible = summary.get("rollback_eligible_count", 0)

    print("xiNAS Configuration History Status")
    print("=" * 40)
    print(f"Baseline:              {'Yes' if baseline else 'No'}")
    if baseline:
        print(f"  ID:                  {baseline.get('id', 'N/A')}")
        print(f"  Created:             {baseline.get('timestamp', 'N/A')}")
    print(f"Total snapshots:       {total}")
    print(f"Rollback-eligible:     {eligible}")
    if current:
        print(f"Current effective:     {current.get('id', 'N/A')}")
        print(f"  Operation:           {current.get('operation', 'N/A')}")
        print(f"  Applied:             {current.get('timestamp', 'N/A')}")
    else:
        print("Current effective:     None")

    return 0


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------


def _change_marker(change_type: str) -> str:
    """Return a visual marker for a change type."""
    if change_type == "added":
        return "+"
    elif change_type == "removed":
        return "-"
    elif change_type == "modified":
        return "~"
    return "?"


if __name__ == "__main__":
    sys.exit(main())
