"""Repository inventory, object closure, and deterministic workflow analysis."""

from __future__ import annotations

import fnmatch
import hashlib
import json
import re
from collections import Counter, deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from .git import Git, GitError

OBJECT_TYPES = ("commit", "tree", "blob", "tag")
OBJECT_TYPES_WITH_UNKNOWN = (*OBJECT_TYPES, "unknown")


@dataclass(frozen=True)
class ObjectInfo:
    oid: str
    kind: str
    size: int | None = None
    disk_size: int | None = None
    storage: str = "unknown"
    reachable: bool = False
    reflog_reachable: bool = False
    promisor: bool = False


@dataclass
class Inventory:
    objects: dict[str, ObjectInfo]
    shallow: list[str]
    refs: dict[str, str]
    head: str | None
    sparse_patterns: list[str]
    sparse_enabled: bool
    sparse_cone: bool
    partial_clone: dict[str, Any]
    pack_stats: dict[str, Any]
    commit_stats: dict[str, int]
    tree_stats: dict[str, int]

    @property
    def present(self) -> set[str]:
        return set(self.objects)


@dataclass
class Analysis:
    repo: str
    workflow: str
    status: str
    anchor: dict[str, Any]
    requested_paths: list[str]
    selected_paths: list[str]
    sparse_excluded: list[str]
    not_present_paths: list[str]
    required: set[str]
    missing: set[str]
    missing_types: dict[str, str]
    unknown_frontier: int
    history_status: str
    history_scope: str
    boundary_reached: list[str]
    diagnostics: list[str]
    inventory: Inventory
    path_status: dict[str, str] = field(default_factory=dict)
    patch: bool = False

    def to_dict(self, *, include_objects: bool = True) -> dict[str, Any]:
        required_by_type = _oid_type_counts(self.required, self.inventory, self.missing_types)
        present_by_type = _oid_type_counts(self.required & self.inventory.present, self.inventory, {})
        missing_by_type = _oid_type_counts(self.missing, self.inventory, self.missing_types)
        known_bytes = 0
        unknown_sizes = 0
        for oid in self.missing:
            info = self.inventory.objects.get(oid)
            # Missing objects cannot normally have an ObjectInfo. A size hint
            # can be supplied by a promisor/pack catalog in a future format.
            if info and info.size is not None:
                known_bytes += info.size
            else:
                unknown_sizes += 1
        count = len(self.required)
        present = len(self.required & self.inventory.present)
        status = self.status
        result: dict[str, Any] = {
            "schema_version": 1,
            "repo": self.repo,
            "network_attempted": False,
            "workflow": self.workflow,
            "status": status,
            "anchor": self.anchor,
            "paths": {
                "requested": sorted(self.requested_paths),
                "selected": sorted(self.selected_paths),
                "sparse_excluded": sorted(self.sparse_excluded),
                "not_present": sorted(self.not_present_paths),
                "status": {key: self.path_status[key] for key in sorted(self.path_status)},
            },
            "requirements": {
                "enumerated": count,
                "present": present,
                "missing": len(self.missing),
                "unknown_frontier": self.unknown_frontier,
                "coverage": round(present / count, 10) if count else 1.0,
                "by_type": required_by_type,
                "present_by_type": present_by_type,
                "missing_by_type": missing_by_type,
            },
            "cost": {
                "missing_object_count": len(self.missing),
                "missing_commit_count": missing_by_type["commit"],
                "missing_tree_count": missing_by_type["tree"],
                "missing_blob_count": missing_by_type["blob"],
                "missing_tag_count": missing_by_type["tag"],
                "missing_unknown_count": missing_by_type["unknown"],
                "known_missing_bytes": known_bytes,
                "unknown_missing_size_count": unknown_sizes,
                "missing_by_type": missing_by_type,
                "promisor_fetch_required": bool(self.missing and self.inventory.partial_clone["enabled"]),
            },
            "history": {
                "scope": self.history_scope,
                "shallow": bool(self.inventory.shallow),
                "status": self.history_status,
                "boundary_reached": sorted(self.boundary_reached),
            },
            "diagnostics": sorted(set(self.diagnostics)),
            "statistics": inventory_dict(self.inventory),
        }
        if include_objects:
            result["objects"] = {
                "required": sorted(self.required),
                "missing": sorted(self.missing),
            }
        return result


class Analyzer:
    """Analyze one repository. Construction performs no mutating operation."""

    def __init__(self, repo: str | Path):
        self.git = Git(repo)
        self.repo = str(self.git.repo)
        object_format = self.git.text(["rev-parse", "--show-object-format"], check=False).strip()
        self.hash_len = 32 if object_format == "sha256" else 20
        self.inventory = self._inventory()
        self._cache: dict[str, tuple[str | None, bytes | None]] = {}

    def _inventory(self) -> Inventory:
        refs: dict[str, str] = {}
        result = self.git.run(["for-each-ref", "--format=%(refname) %(objectname)"], check=False)
        if result.returncode == 0:
            for line in result.stdout.decode("ascii", "replace").splitlines():
                parts = line.split()
                if len(parts) == 2:
                    refs[parts[0]] = parts[1]
        head_result = self.git.run(["rev-parse", "--verify", "HEAD"], check=False)
        head = head_result.stdout.decode("ascii", "replace").strip() if head_result.returncode == 0 else None
        reachable = self._rev_objects(["--all", "HEAD"] if head else ["--all"])
        reflog_objects = self._reflog_objects()
        object_lines = self.git.run(
            ["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype) %(objectsize) %(objectsize:disk)"],
            check=False,
        )
        if object_lines.returncode:
            raise GitError(object_lines.stderr.decode("utf-8", "replace").strip() or "cannot inventory objects")
        promisor = self._promisor_objects()
        pack_oids, pack_indexes = self._pack_inventory()
        objects: dict[str, ObjectInfo] = {}
        for line in object_lines.stdout.decode("ascii", "replace").splitlines():
            parts = line.split()
            if len(parts) < 4:
                continue
            oid, kind = parts[0], parts[1]
            if kind not in OBJECT_TYPES:
                continue
            objects[oid] = ObjectInfo(
                oid=oid,
                kind=kind,
                size=_int_or_none(parts[2]),
                disk_size=_int_or_none(parts[3]),
                storage=_storage_kind(self.git.object_path(oid).exists(), oid in pack_oids),
                reachable=oid in reachable,
                reflog_reachable=oid in reflog_objects,
                promisor=oid in promisor,
            )
        shallow_path = self.git.git_dir() / "shallow"
        shallow = []
        if shallow_path.exists():
            shallow = sorted({line.strip() for line in shallow_path.read_text("ascii", "ignore").splitlines() if line.strip()})
        sparse_patterns, sparse_enabled, sparse_cone = self._sparse()
        partial_clone = self._partial_clone()
        pack_stats = self._pack_stats(objects, pack_indexes)
        commit_stats = _type_stats(objects, "commit")
        tree_stats = _type_stats(objects, "tree")
        return Inventory(
            objects=objects,
            shallow=shallow,
            refs=dict(sorted(refs.items())),
            head=head,
            sparse_patterns=sparse_patterns,
            sparse_enabled=sparse_enabled,
            sparse_cone=sparse_cone,
            partial_clone=partial_clone,
            pack_stats=pack_stats,
            commit_stats=commit_stats,
            tree_stats=tree_stats,
        )

    def _rev_objects(self, args: list[str]) -> set[str]:
        # Partial-clone graphs may have absent promised leaves. Preserve the
        # reachable objects that can be walked instead of dropping the entire
        # graph (and incorrectly marking the referenced HEAD as dangling).
        result = self.git.run(["rev-list", "--objects", "--missing=allow-any", *args], check=False)
        if result.returncode:
            return set()
        answer = set()
        for line in result.stdout.decode("ascii", "replace").splitlines():
            value = line.split()[0] if line.split() else ""
            if re.fullmatch(r"[0-9a-fA-F]{40,64}", value):
                answer.add(value)
        return answer

    def _reflog_objects(self) -> set[str]:
        result = self.git.run(["reflog", "--all", "--format=%H"], check=False)
        if result.returncode:
            return set()
        return {line.strip() for line in result.stdout.decode("ascii", "replace").splitlines() if re.fullmatch(r"[0-9a-fA-F]{40,64}", line.strip())}

    def _promisor_objects(self) -> set[str]:
        """Read object IDs from local .promisor packs, never from the remote."""
        answer: set[str] = set()
        pack_dir = self.git.git_dir() / "objects" / "pack"
        for promisor in sorted(pack_dir.glob("*.promisor")):
            idx = promisor.with_suffix(".idx")
            if not idx.exists():
                continue
            result = self.git.run(["show-index"], check=False) if False else None
            del result
            # An index's fanout table and sorted names are enough to recover
            # IDs without invoking a potentially remote-capable command.
            try:
                raw = idx.read_bytes()
                answer.update(_pack_index_oids(raw, self.hash_len))
            except (OSError, ValueError):
                continue
        return answer

    def _pack_inventory(self) -> tuple[set[str], list[dict[str, Any]]]:
        """Return unique packed OIDs and normalized physical pack statistics."""
        packed: set[str] = set()
        indexes: list[dict[str, Any]] = []
        pack_dir = self.git.git_dir() / "objects" / "pack"
        for index_path in sorted(pack_dir.glob("*.idx")):
            try:
                oids = _pack_index_oids(index_path.read_bytes(), self.hash_len)
            except OSError:
                continue
            pack_path = index_path.with_suffix(".pack")
            indexes.append({
                "name": index_path.name,
                "object_entries": len(oids),
                "pack_bytes": pack_path.stat().st_size if pack_path.exists() else 0,
                "index_bytes": index_path.stat().st_size,
            })
            packed.update(oids)
        return packed, indexes

    def _sparse(self) -> tuple[list[str], bool, bool]:
        enabled_text = self.git.text(["config", "--bool", "--get", "core.sparseCheckout"], check=False).strip().lower()
        enabled = enabled_text == "true"
        cone_text = self.git.text(["config", "--bool", "--get", "core.sparseCheckoutCone"], check=False).strip().lower()
        cone = cone_text != "false"
        path_result = self.git.run(["rev-parse", "--git-path", "info/sparse-checkout"], check=False)
        patterns: list[str] = []
        if path_result.returncode == 0:
            path = Path(path_result.stdout.decode("utf-8", "surrogateescape").strip())
            if not path.is_absolute():
                path = self.git.repo / path
            if path.exists():
                patterns = path.read_text("utf-8", "surrogateescape").splitlines()
        return patterns, enabled, cone

    def _partial_clone(self) -> dict[str, Any]:
        extension = self.git.text(["config", "--get", "extensions.partialClone"], check=False).strip()
        remotes = []
        result = self.git.run(["config", "--get-regexp", r"^remote\..*\.promisor$"], check=False)
        if result.returncode == 0:
            remotes = [line.split()[0] for line in result.stdout.decode("utf-8", "replace").splitlines() if line]
        return {"enabled": bool(extension or remotes), "extensions_partial_clone": extension or None, "promisor_remotes": sorted(remotes)}

    def _pack_stats(self, objects: dict[str, ObjectInfo], indexes: list[dict[str, Any]]) -> dict[str, Any]:
        result = self.git.run(["count-objects", "-v"], check=False)
        values: dict[str, int] = {}
        if result.returncode == 0:
            for line in result.stdout.decode("ascii", "replace").splitlines():
                if " " in line:
                    key, value = line.split(" ", 1)
                    try:
                        values[key] = int(value)
                    except ValueError:
                        pass
        packed = Counter(info.kind for info in objects.values() if info.storage in {"pack", "both"})
        loose = Counter(info.kind for info in objects.values() if info.storage in {"loose", "both"})
        by_type = Counter(info.kind for info in objects.values())
        storage = Counter(info.storage for info in objects.values())
        count_objects = {key.rstrip(":"): value for key, value in values.items()}
        count_objects = {key: count_objects.get(key, 0) for key in (
            "count", "size", "in-pack", "packs", "size-pack", "prune-packable", "garbage", "size-garbage"
        )}
        return {
            "count_objects": dict(sorted(count_objects.items())),
            "count_objects_size_unit": "KiB",
            "objects": {
                "unique": len(objects),
                "by_type": _complete_counts(by_type),
                "storage": _complete_counts(storage, ("loose", "pack", "both", "unknown")),
            },
            "packs": {
                "count": len(indexes),
                "object_entries": sum(item["object_entries"] for item in indexes),
                "unique_objects": sum(1 for info in objects.values() if info.storage in {"pack", "both"}),
                "pack_bytes": sum(item["pack_bytes"] for item in indexes),
                "index_bytes": sum(item["index_bytes"] for item in indexes),
            },
            "packed_by_type": _complete_counts(packed),
            "loose_by_type": _complete_counts(loose),
        }

    def _read(self, oid: str, expected: str | None = None) -> tuple[str | None, bytes | None]:
        # The inventory is local-only and exhaustive. Do not ask cat-file to
        # read absent promised objects: some Git versions abort after trying
        # a lazy fetch even when the transport is blocked.
        if oid not in self.inventory.objects:
            return None, None
        if oid not in self._cache:
            self._cache.update(self.git.batch([oid]))
        value = self._cache[oid]
        if expected and value[0] and value[0] != expected:
            raise GitError(f"object {oid} is {value[0]}, expected {expected}")
        return value

    def resolve(self, revision: str) -> str:
        # verify accepts raw OIDs and symbolic revisions, but no URL syntax is
        # passed to a transport command.
        result = self.git.run(["rev-parse", "--verify", "--end-of-options", f"{revision}^{{commit}}"], check=False)
        if result.returncode:
            raise ValueError(f"invalid commit revision: {revision}")
        return result.stdout.decode("ascii", "replace").strip()

    def analyze(
        self,
        workflow: str,
        revision: str = "HEAD",
        *,
        base: str | None = None,
        paths: Iterable[str] = (),
        respect_sparse: bool = False,
        history: str = "full",
        patch: bool = False,
    ) -> Analysis:
        if workflow not in {"checkout", "log", "diff", "merge"}:
            raise ValueError(f"unsupported workflow: {workflow}")
        requested = list(paths)
        if any(not path for path in requested):
            raise ValueError("empty --path is invalid; omit --path to use all paths or active sparse patterns")
        anchor_oid = self.resolve(revision)
        base_oid = self.resolve(base) if base else None
        required: set[str] = set()
        missing_types: dict[str, str] = {}
        unknown = 0
        selected_paths: set[str] = set()
        sparse_excluded: set[str] = set()
        not_present: set[str] = set()
        path_status: dict[str, str] = {}
        diagnostics: list[str] = []
        boundary_reached: set[str] = set()
        history_status = "complete"

        if workflow == "checkout":
            unknown += self._commit_tree_requirements(anchor_oid, requested, respect_sparse, required, missing_types, selected_paths, sparse_excluded, not_present, path_status)
        elif workflow == "diff":
            if not base_oid:
                raise ValueError("diff requires --base")
            commits, hit_boundary = self._history_commits(anchor_oid, history)
            commits2, hit_boundary2 = self._history_commits(base_oid, "depth:1")
            boundary_reached.update(hit_boundary | hit_boundary2)
            required.update(commits | commits2)
            unknown += self._tree_requirements_for_commit(anchor_oid, requested, required, missing_types, selected_paths, not_present, path_status)
            unknown += self._tree_requirements_for_commit(base_oid, requested, required, missing_types, selected_paths, not_present, path_status)
            if patch:
                self._blob_requirements_for_paths(anchor_oid, requested, required, missing_types)
                self._blob_requirements_for_paths(base_oid, requested, required, missing_types)
        elif workflow == "merge":
            if not base_oid:
                raise ValueError("merge requires --base")
            required.update({anchor_oid, base_oid})
            merge_base = self._merge_base(anchor_oid, base_oid)
            if merge_base:
                required.add(merge_base)
                self._tree_requirements_for_commit(merge_base, requested, required, missing_types, selected_paths, not_present, path_status)
            unknown += self._tree_requirements_for_commit(anchor_oid, requested, required, missing_types, selected_paths, not_present, path_status)
            unknown += self._tree_requirements_for_commit(base_oid, requested, required, missing_types, selected_paths, not_present, path_status)
        else:  # log
            commits, hit_boundary = self._history_commits(anchor_oid, history)
            boundary_reached.update(hit_boundary)
            required.update(commits)
            if requested:
                for commit in sorted(commits):
                    unknown += self._tree_requirements_for_commit(commit, requested, required, missing_types, selected_paths, not_present, path_status)
                    if patch:
                        self._blob_requirements_for_paths(commit, requested, required, missing_types)

        if boundary_reached:
            history_status = "indeterminate"
            diagnostics.append("shallow_history_boundary_reached")
        if unknown:
            diagnostics.append("missing_tree_prevented_enumeration")
        if sparse_excluded and requested:
            diagnostics.append("explicit_path_sparse_excluded")
        for oid in required:
            if oid not in self.inventory.present:
                missing_types.setdefault(oid, self._guess_type(oid))
        missing = required - self.inventory.present
        status = "complete"
        if unknown or boundary_reached:
            status = "indeterminate"
        if "explicit_path_sparse_excluded" in diagnostics:
            status = "indeterminate"
        if missing:
            status = "incomplete"
            if self.inventory.partial_clone["enabled"]:
                diagnostics.append("promisor_fetch_required")
        if requested and not selected_paths and not not_present and not sparse_excluded and not unknown:
            diagnostics.append("no_path_entries_selected")
        reachable = anchor_oid in {oid for oid, info in self.inventory.objects.items() if info.reachable}
        anchor = {"input": revision, "oid": anchor_oid, "reachable_from_refs": reachable, "status": "reachable" if reachable else "dangling_anchor"}
        if base_oid:
            anchor["base"] = base_oid
        return Analysis(
            repo=self.repo,
            workflow=workflow,
            status=status,
            anchor=anchor,
            requested_paths=requested,
            selected_paths=sorted(selected_paths),
            sparse_excluded=sorted(sparse_excluded),
            not_present_paths=sorted(not_present),
            required=required,
            missing=missing,
            missing_types=missing_types,
            unknown_frontier=unknown,
            history_status=history_status,
            history_scope=history,
            boundary_reached=sorted(boundary_reached),
            diagnostics=diagnostics,
            inventory=self.inventory,
            path_status=path_status,
            patch=patch,
        )

    def _guess_type(self, oid: str) -> str:
        # A missing object has no cat-file type. Commit/tree requirements are
        # known at the call site; this fallback is intentionally explicit.
        return "unknown"

    def _merge_base(self, first: str, second: str) -> str | None:
        result = self.git.run(["merge-base", first, second], check=False)
        return result.stdout.decode("ascii", "replace").strip() if result.returncode == 0 else None

    def _history_commits(self, start: str, scope: str) -> tuple[set[str], set[str]]:
        args = ["rev-list", "--no-walk", start]
        if scope == "full":
            args = ["rev-list", start]
        elif scope.startswith("depth:"):
            try:
                depth = max(1, int(scope.split(":", 1)[1]))
            except ValueError as exc:
                raise ValueError(f"invalid history scope: {scope}") from exc
            args = ["rev-list", f"--max-count={depth}", start]
        elif scope == "first-parent":
            args = ["rev-list", "--first-parent", start]
        else:
            raise ValueError(f"invalid history scope: {scope}")
        result = self.git.run(args, check=False)
        if result.returncode:
            raise ValueError(f"cannot walk history from {start}")
        commits = {line.strip() for line in result.stdout.decode("ascii", "replace").splitlines() if line.strip()}
        boundaries = commits & set(self.inventory.shallow)
        # A bounded walk is complete when its boundary is exactly the last
        # requested commit. It becomes indeterminate only when the requested
        # scope would need a parent beyond that boundary.
        if scope.startswith("depth:"):
            requested_depth = max(1, int(scope.split(":", 1)[1]))
            if len(commits) >= requested_depth:
                boundaries = set()
        return commits, boundaries

    def _commit_tree_requirements(
        self, commit: str, requested: list[str], respect_sparse: bool,
        required: set[str], missing_types: dict[str, str], selected: set[str],
        sparse_excluded: set[str], not_present: set[str], path_status: dict[str, str],
    ) -> int:
        required.add(commit)
        kind, content = self._read(commit, "commit")
        if content is None:
            missing_types.setdefault(commit, "commit")
            return 1
        tree = _header(content, b"tree")
        if not tree:
            return 1
        return self._tree_requirements(
            tree, requested, respect_sparse, required, missing_types, selected,
            sparse_excluded, not_present, path_status, prefix="",
        )

    def _tree_requirements_for_commit(
        self, commit: str, requested: list[str], required: set[str],
        missing_types: dict[str, str], selected: set[str], not_present: set[str],
        path_status: dict[str, str],
    ) -> int:
        required.add(commit)
        kind, content = self._read(commit, "commit")
        if content is None:
            missing_types.setdefault(commit, "commit")
            return 1
        tree = _header(content, b"tree")
        return self._tree_requirements(tree or "", requested, False, required, missing_types, selected, set(), not_present, path_status, prefix="")

    def _tree_requirements(
        self, tree: str, requested: list[str], respect_sparse: bool,
        required: set[str], missing_types: dict[str, str], selected: set[str],
        sparse_excluded: set[str], not_present: set[str], path_status: dict[str, str],
        prefix: str,
    ) -> int:
        if not tree:
            return 1
        required.add(tree)
        kind, content = self._read(tree, "tree")
        if content is None:
            missing_types.setdefault(tree, "tree")
            return 1
        entries = _tree_entries(content, self.hash_len)
        wanted = [path.strip("/") for path in requested if path.strip("/")]
        unknown = 0
        scope_all = bool(prefix) and any(item == prefix or prefix.startswith(item + "/") for item in wanted)
        for mode, oid, name in entries:
            path = f"{prefix}{name}" if not prefix else f"{prefix}/{name}"
            is_dir = mode.startswith("04") or mode == "40000"
            matching = scope_all or not wanted or any(_path_matches(path, item, is_dir) or item.startswith(path + "/") for item in wanted)
            if not matching:
                continue
            explicit = any(_path_matches(path, item, is_dir) for item in wanted)
            if respect_sparse and self.inventory.sparse_enabled and not self._sparse_matches(path, is_dir):
                sparse_excluded.add(path)
                path_status[path] = "sparse_excluded"
                continue
            selected.add(path)
            path_status[path] = "present_and_selected"
            required.add(oid)
            missing_types.setdefault(oid, "tree" if is_dir else "blob")
            if is_dir:
                unknown += self._tree_requirements(oid, wanted, respect_sparse, required, missing_types, selected, sparse_excluded, not_present, path_status, path)
            elif explicit or not wanted:
                # Blob already belongs to the requirement closure.
                pass
        if wanted and not prefix and not unknown:
            for item in wanted:
                if not any(path == item or path.startswith(item + "/") for path in selected) and not any(
                    path == item or item.startswith(path + "/") or path.startswith(item + "/") for path in sparse_excluded
                ):
                    not_present.add(item)
                    path_status[item] = "path_not_present_at_revision"
        return unknown

    def _blob_requirements_for_paths(self, commit: str, paths: list[str], required: set[str], missing_types: dict[str, str]) -> None:
        if not paths:
            return
        self._collect_blobs(commit, paths, required, missing_types)

    def _collect_blobs(self, commit: str, paths: list[str], required: set[str], missing_types: dict[str, str]) -> None:
        kind, content = self._read(commit, "commit")
        if content is None:
            return
        tree = _header(content, b"tree")
        if tree:
            self._collect_tree_blobs(tree, paths, required, missing_types, "")

    def _collect_tree_blobs(self, tree: str, paths: list[str], required: set[str], missing_types: dict[str, str], prefix: str) -> None:
        kind, content = self._read(tree, "tree")
        if content is None:
            return
        for mode, oid, name in _tree_entries(content, self.hash_len):
            path = f"{prefix}/{name}" if prefix else name
            if not any(_path_matches(path, item, mode.startswith("04")) or item.startswith(path + "/") for item in paths):
                continue
            required.add(oid)
            missing_types.setdefault(oid, "tree" if mode.startswith("04") else "blob")
            if mode.startswith("04"):
                self._collect_tree_blobs(oid, paths, required, missing_types, path)

    def _sparse_matches(self, path: str, is_dir: bool) -> bool:
        if not self.inventory.sparse_enabled:
            return True
        if not self.inventory.sparse_patterns:
            return False
        included = False
        for raw in self.inventory.sparse_patterns:
            pattern = raw.strip()
            if not pattern or pattern.startswith("#"):
                continue
            negate = pattern.startswith("!")
            pattern = pattern.lstrip("!").lstrip("/")
            directory_pattern = pattern.rstrip("/")
            candidates = [path]
            parts = path.split("/")
            candidates.extend("/".join(parts[:index]) for index in range(1, len(parts)))
            matched = any(fnmatch.fnmatch(candidate, directory_pattern) for candidate in candidates)
            matched = matched or fnmatch.fnmatch(path, directory_pattern + "/**")
            if matched:
                included = not negate
        return included


def _header(content: bytes, key: bytes) -> str | None:
    prefix = key + b" "
    for line in content.split(b"\n"):
        if line.startswith(prefix):
            return line[len(prefix):].decode("ascii", "replace")
        if not line:
            break
    return None


def _tree_entries(content: bytes, hash_len: int = 20) -> list[tuple[str, str, str]]:
    """Decode raw Git tree records for SHA-1 or SHA-256 repositories."""
    result: list[tuple[str, str, str]] = []
    pos = 0
    while pos < len(content):
        nul = content.find(b"\0", pos)
        if nul < 0:
            break
        header = content[pos:nul].split(b" ", 1)
        if len(header) != 2:
            break
        oid_start = nul + 1
        oid_raw = content[oid_start:oid_start + hash_len]
        if len(oid_raw) != hash_len:
            break
        result.append((header[0].decode("ascii", "replace"), oid_raw.hex(), header[1].decode("utf-8", "surrogateescape")))
        pos = oid_start + hash_len
    return result


def _path_matches(path: str, requested: str, is_dir: bool) -> bool:
    requested = requested.strip("/")
    return path == requested or (is_dir and requested.startswith(path + "/")) or fnmatch.fnmatch(path, requested)


def _int_or_none(value: str) -> int | None:
    try:
        return int(value)
    except ValueError:
        return None


def _type_stats(objects: dict[str, ObjectInfo], kind: str) -> dict[str, int]:
    values = [info for info in objects.values() if info.kind == kind]
    return {"count": len(values), "logical_bytes": sum(info.size or 0 for info in values), "disk_bytes": sum(info.disk_size or 0 for info in values)}


def _complete_counts(values: Counter[str] | dict[str, int], keys: Iterable[str] = OBJECT_TYPES) -> dict[str, int]:
    return {key: int(values.get(key, 0)) for key in keys}


def _storage_kind(loose: bool, packed: bool) -> str:
    if loose and packed:
        return "both"
    if loose:
        return "loose"
    if packed:
        return "pack"
    return "unknown"


def _oid_type_counts(oids: Iterable[str], inventory: Inventory, hints: dict[str, str]) -> dict[str, int]:
    counts: Counter[str] = Counter()
    for oid in oids:
        info = inventory.objects.get(oid)
        counts[info.kind if info else hints.get(oid, "unknown")] += 1
    return _complete_counts(counts, OBJECT_TYPES_WITH_UNKNOWN)


def _pack_index_oids(raw: bytes, hash_len: int = 20) -> set[str]:
    # Read v2 .idx names. v1 indexes are ignored safely.
    if raw[:4] != b"\xfftOc" or len(raw) < 8 + 256 * 4:
        return set()
    version = int.from_bytes(raw[4:8], "big")
    if version != 2:
        return set()
    offset = 8
    fanout = [int.from_bytes(raw[offset + i * 4:offset + i * 4 + 4], "big") for i in range(256)]
    count = fanout[-1]
    start = 8 + 256 * 4
    return {raw[start + i * hash_len:start + (i + 1) * hash_len].hex() for i in range(count)}


def inventory_dict(inventory: Inventory) -> dict[str, Any]:
    return {
        "object_format": "sha256" if inventory.objects and len(next(iter(inventory.objects))) == 64 else "sha1",
        "head": inventory.head,
        "refs": inventory.refs,
        "shallow_boundaries": inventory.shallow,
        "sparse_checkout": {"enabled": inventory.sparse_enabled, "cone": inventory.sparse_cone, "patterns": inventory.sparse_patterns},
        "partial_clone": inventory.partial_clone,
        "pack": inventory.pack_stats,
        "objects_by_type": {kind: inventory.commit_stats if kind == "commit" else inventory.tree_stats if kind == "tree" else _type_stats(inventory.objects, kind) for kind in OBJECT_TYPES},
        "reachable_object_count": sum(info.reachable for info in inventory.objects.values()),
        "unreachable_object_count": sum(not info.reachable for info in inventory.objects.values()),
        "promisor_object_count": sum(info.promisor for info in inventory.objects.values()),
    }
