"""Stable human and machine-readable report rendering."""

from __future__ import annotations

import json
from typing import Any


def render_json(data: dict[str, Any]) -> str:
    return json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def render_text(data: dict[str, Any]) -> str:
    lines = [
        f"Git repository analyzer: {data['repo']}",
        f"workflow: {data.get('workflow', 'inspect')}",
        f"status: {data.get('status', 'ok')}",
        f"network attempted: {data.get('network_attempted', False)}",
    ]
    if "requirements" in data:
        req = data["requirements"]
        cost = data["cost"]
        lines.extend([
            f"objects: {req['present']} present / {req['enumerated']} required / {req['missing']} missing",
            f"coverage: {req['coverage']:.10f}",
            f"cost: {cost['missing_object_count']} objects, {cost['unknown_missing_size_count']} unknown sizes, {cost['known_missing_bytes']} known bytes",
            f"history: {data['history']['status']} ({data['history']['scope']})",
        ])
        if data.get("paths", {}).get("sparse_excluded"):
            lines.append("sparse excluded: " + ", ".join(data["paths"]["sparse_excluded"]))
    if data.get("strategies"):
        lines.append("scope: " + data["scope"])
        lines.append("strategy costs:")
        for strategy in data["strategies"]:
            cost = strategy["cost"]
            initial = cost["initial"]
            deferred = cost["deferred"]
            missing = cost["local_missing"]
            lines.append(
                f"  {strategy['strategy']}: initial {initial['object_count']} objects/{initial['known_logical_bytes']} known logical bytes, "
                f"deferred {deferred['object_count']} objects/{deferred['known_logical_bytes']} known logical bytes, "
                f"local missing {missing['missing_object_count']} objects; status: {strategy['status']}"
            )
            for phase, summary in (("initial", initial), ("deferred", deferred)):
                types = ", ".join(f"{kind}={count}" for kind, count in sorted(summary["by_type"].items()))
                lines.append(f"    {phase}: {types}; unknown sizes={summary['unknown_size_count']}")
            lines.append(
                f"    local missing: {missing['known_missing_bytes']} known bytes; "
                f"unknown sizes={missing['unknown_missing_size_count']}"
            )
            if strategy["diagnostics"]:
                lines.append("    diagnostics: " + ", ".join(strategy["diagnostics"]))
        lines.append("Transfer/pack bytes cannot be predicted; costs above are logical object bytes.")
    stats = data.get("statistics", {})
    if stats:
        lines.extend([
            f"HEAD: {stats.get('head') or '(unborn or unavailable)'}",
            f"object format: {stats.get('object_format', 'unknown')}",
            f"reachable/unreachable: {stats.get('reachable_object_count', 0)}/{stats.get('unreachable_object_count', 0)}",
            f"shallow boundaries: {len(stats.get('shallow_boundaries', []))}",
        ])
        pack = stats.get("pack", {}).get("packs")
        if pack:
            lines.append(
                f"local packs: {pack['count']}; entries={pack['object_entries']}; "
                f"unique objects={pack['unique_objects']}; pack bytes={pack['pack_bytes']}; index bytes={pack['index_bytes']}"
            )
    diagnostics = data.get("diagnostics", [])
    if diagnostics:
        lines.append("diagnostics: " + ", ".join(diagnostics))
    if "objects" in data and data["objects"].get("missing"):
        lines.append("missing object IDs:")
        lines.extend(f"  {oid}" for oid in data["objects"]["missing"])
    return "\n".join(lines) + "\n"
