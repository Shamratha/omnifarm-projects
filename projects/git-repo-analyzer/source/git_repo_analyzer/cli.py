"""Command-line interface for the local-only analyzer."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .analyzer import Analyzer, inventory_dict
from .report import render_json, render_text


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="git-repo-analyzer", description="Analyze a local Git object database without contacting a remote")
    sub = root.add_subparsers(dest="command", required=True)

    inspect = sub.add_parser("inspect", help="report repository and object statistics")
    _common(inspect)

    analyze = sub.add_parser("analyze", help="analyze a local workflow")
    _common(analyze)
    analyze.add_argument("--workflow", choices=["checkout", "log", "diff", "merge"], default="checkout")
    analyze.add_argument("--rev", default="HEAD")
    analyze.add_argument("--base")
    analyze.add_argument("--path", action="append", default=[])
    analyze.add_argument("--respect-sparse", action="store_true")
    analyze.add_argument("--history", default="full", help="full, first-parent, or depth:N")
    analyze.add_argument("--patch", action="store_true", help="include blobs needed for patch output")
    analyze.add_argument("--no-objects", action="store_true")

    verify = sub.add_parser("verify", help="analyze and return 0 only for a proven-complete workflow")
    _common(verify)
    verify.add_argument("--workflow", choices=["checkout", "log", "diff", "merge"], default="checkout")
    verify.add_argument("--rev", default="HEAD")
    verify.add_argument("--base")
    verify.add_argument("--path", action="append", default=[])
    verify.add_argument("--respect-sparse", action="store_true")
    verify.add_argument("--history", default="full")
    verify.add_argument("--patch", action="store_true")
    verify.add_argument("--no-objects", action="store_true")

    simulate = sub.add_parser("simulate", help="simulate a fetch for a commit and path; never fetch")
    _common(simulate)
    simulate.add_argument("--commit", "--rev", dest="rev", default="HEAD")
    simulate.add_argument("--path", action="append", default=[])
    simulate.add_argument("--respect-sparse", action="store_true")

    compare = sub.add_parser("compare", help="compare full, sparse, blobless, and treeless strategies")
    _common(compare)
    compare.add_argument("--rev", default="HEAD")
    compare.add_argument("--path", action="append", default=[])

    return root


def _common(command: argparse.ArgumentParser) -> None:
    command.add_argument("--repo", default=".", help="local repository path")
    command.add_argument("--format", choices=["text", "json"], default="text")
    command.add_argument("--output", type=Path)


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        analyzer = Analyzer(args.repo)
        if args.command == "inspect":
            data = {
                "schema_version": 1,
                "repo": analyzer.repo,
                "network_attempted": False,
                "status": "ok",
                "statistics": inventory_dict(analyzer.inventory),
            }
        elif args.command == "compare":
            data = _compare(analyzer, args.rev, args.path)
        else:
            workflow = "checkout" if args.command == "simulate" else args.workflow
            analysis = analyzer.analyze(
                workflow, args.rev, base=getattr(args, "base", None), paths=args.path,
                respect_sparse=getattr(args, "respect_sparse", False),
                history=getattr(args, "history", "full"), patch=getattr(args, "patch", False),
            )
            data = analysis.to_dict(include_objects=not getattr(args, "no_objects", False))
            if args.command == "simulate":
                data["simulation"] = {
                    "requested_commit": args.rev,
                    "requested_paths": sorted(args.path),
                    "would_fetch": sorted(data["objects"]["missing"]),
                    "fetch_performed": False,
                    "remote_contacted": False,
                }
        output = render_json(data) if args.format == "json" else render_text(data)
        if args.output:
            args.output.write_text(output, encoding="utf-8")
        else:
            sys.stdout.write(output)
        if args.command == "verify":
            return 0 if data.get("status") == "complete" else 1
        return 0
    except (ValueError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:
        print(f"analyzer error: {exc}", file=sys.stderr)
        return 3


def _compare(analyzer: Analyzer, revision: str, paths: list[str]) -> dict:
    full = analyzer.analyze("checkout", revision, paths=())
    sparse = analyzer.analyze("checkout", revision, paths=paths, respect_sparse=True)
    # Explicitly snapshot-scoped accounting, not an estimate of server packs
    # or unseen ancestry. Sparse includes the selected blobs, not blob:none.
    full_data = full.to_dict()
    sparse_data = sparse.to_dict()
    def projection(name: str, data: dict, omitted: set[str]) -> dict:
        required = data["objects"]["required"]
        missing = data["objects"]["missing"]
        counts = data["requirements"]["by_type"]
        initial_by_type = {kind: count if kind not in omitted else 0 for kind, count in counts.items()}
        deferred_by_type = {kind: count if kind in omitted else 0 for kind, count in counts.items()}
        initial_bytes = deferred_bytes = 0
        initial_unknown = deferred_unknown = 0
        for oid in required:
            info = analyzer.inventory.objects.get(oid)
            # Missing types are available from the analyzed requirement graph;
            # use its OID hints rather than local inventory to classify costs.
            source = sparse if name == "sparse" else full
            kind = info.kind if info else source.missing_types.get(oid, "unknown")
            deferred = kind in omitted
            if info is not None and info.size is not None:
                if deferred:
                    deferred_bytes += info.size
                else:
                    initial_bytes += info.size
            elif deferred:
                deferred_unknown += 1
            else:
                initial_unknown += 1
        omitted_count = sum(deferred_by_type.values())
        return {
            "strategy": name,
            "required_objects": len(required),
            "required_by_type": counts,
            "missing_objects": len(missing),
            "locally_present_objects": data["requirements"]["present"],
            "omitted_local_objects": sum(
                1 for oid in required
                if oid in analyzer.inventory.objects and analyzer.inventory.objects[oid].kind in omitted
            ),
            "initial_retained_objects": len(required) - omitted_count,
            "coverage": data["requirements"]["coverage"],
            "status": data["status"],
            "requirements": data["requirements"],
            "cost": {
                "initial": {
                    "object_count": sum(initial_by_type.values()),
                    "by_type": initial_by_type,
                    "known_logical_bytes": initial_bytes,
                    "unknown_size_count": initial_unknown,
                },
                "deferred": {
                    "object_count": omitted_count,
                    "by_type": deferred_by_type,
                    "known_logical_bytes": deferred_bytes,
                    "unknown_size_count": deferred_unknown,
                },
                "local_missing": data["cost"],
                "transfer_bytes": None,
            },
            "history": data["history"],
            "diagnostics": data["diagnostics"],
        }
    return {
        "schema_version": 1,
        "repo": analyzer.repo,
        "network_attempted": False,
        "workflow": "compare",
        "scope": "enumerated checkout snapshot (not a full-history clone)",
        "revision": revision,
        "paths": sorted(paths),
        "strategies": [
            projection("full", full_data, set()),
            projection("sparse", sparse_data, set()),
            projection("blobless", full_data, {"blob"}),
            projection("treeless", full_data, {"blob", "tree"}),
        ],
        "statistics": inventory_dict(analyzer.inventory),
        "note": "Sparse models a path-scoped object projection; ordinary Git sparse checkout alone does not filter transfer. Costs are logical object bytes, not predicted wire/pack bytes. No fetch is performed.",
    }


if __name__ == "__main__":
    raise SystemExit(main())
