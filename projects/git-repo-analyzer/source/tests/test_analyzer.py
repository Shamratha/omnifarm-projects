from __future__ import annotations

import json
import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from git_repo_analyzer.analyzer import Analyzer
from git_repo_analyzer.cli import _compare, main
from git_repo_analyzer.report import render_json, render_text


def run_git(repo: Path, *args: str, input: str | None = None) -> str:
    result = subprocess.run(["git", "-C", str(repo), *args], input=input, text=True, capture_output=True, check=True)
    return result.stdout.strip()


def make_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    run_git(repo, "init", "-q", "-b", "main")
    run_git(repo, "config", "user.email", "test@example.invalid")
    run_git(repo, "config", "user.name", "Analyzer Test")
    (repo / "src").mkdir()
    (repo / "docs").mkdir()
    (repo / "src" / "main.py").write_text("print('ok')\n")
    (repo / "docs" / "guide.md").write_text("guide\n")
    run_git(repo, "add", ".")
    run_git(repo, "commit", "-qm", "initial")
    return repo


def test_sparse_path_is_selected_without_counting_docs(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    run_git(repo, "config", "core.sparseCheckout", "true")
    run_git(repo, "config", "core.sparseCheckoutCone", "false")
    sparse = repo / ".git" / "info" / "sparse-checkout"
    sparse.parent.mkdir(parents=True, exist_ok=True)
    sparse.write_text("/src/\n")

    report = Analyzer(repo).analyze("checkout", paths=["src"], respect_sparse=True).to_dict()

    assert report["status"] == "complete"
    assert "src/main.py" in report["paths"]["selected"]
    assert "docs" not in report["paths"]["selected"]
    assert report["cost"]["missing_object_count"] == 0


def test_explicit_sparse_exclusion_is_not_reported_as_complete(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    run_git(repo, "config", "core.sparseCheckout", "true")
    run_git(repo, "config", "core.sparseCheckoutCone", "false")
    sparse = repo / ".git" / "info" / "sparse-checkout"
    sparse.parent.mkdir(parents=True, exist_ok=True)
    sparse.write_text("/src/\n")

    report = Analyzer(repo).analyze("checkout", paths=["docs"], respect_sparse=True).to_dict()

    assert report["status"] == "indeterminate"
    assert "explicit_path_sparse_excluded" in report["diagnostics"]


def test_empty_sparse_patterns_do_not_select_a_path(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    run_git(repo, "config", "core.sparseCheckout", "true")
    run_git(repo, "config", "core.sparseCheckoutCone", "false")
    sparse = repo / ".git" / "info" / "sparse-checkout"
    sparse.parent.mkdir(parents=True, exist_ok=True)
    sparse.write_text("")

    report = Analyzer(repo).analyze("checkout", paths=["src"], respect_sparse=True).to_dict()

    assert report["status"] == "indeterminate"
    assert report["paths"]["sparse_excluded"] == ["src"]
    assert report["requirements"]["missing"] == 0


def test_missing_blob_is_incomplete_and_has_deterministic_cost(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    blob = run_git(repo, "rev-parse", "HEAD:src/main.py")
    object_path = repo / ".git" / "objects" / blob[:2] / blob[2:]
    object_path.unlink()

    first = Analyzer(repo).analyze("checkout", paths=["src/main.py"]).to_dict()
    second = Analyzer(repo).analyze("checkout", paths=["src/main.py"]).to_dict()

    assert first == second
    assert first["status"] == "incomplete"
    assert first["cost"]["missing_blob_count"] == 1
    assert first["cost"]["unknown_missing_size_count"] == 1


def test_sparse_path_requires_promisor_fetch_without_contacting_remote(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    run_git(repo, "config", "extensions.partialClone", "origin")
    run_git(repo, "config", "remote.origin.promisor", "true")
    run_git(repo, "config", "remote.origin.url", "https://example.invalid/no-contact.git")
    run_git(repo, "config", "core.sparseCheckout", "true")
    run_git(repo, "config", "core.sparseCheckoutCone", "false")
    sparse = repo / ".git" / "info" / "sparse-checkout"
    sparse.parent.mkdir(parents=True, exist_ok=True)
    sparse.write_text("/src/\n")
    blob = run_git(repo, "rev-parse", "HEAD:src/main.py")
    (repo / ".git" / "objects" / blob[:2] / blob[2:]).unlink()

    real_run = subprocess.run
    with patch("git_repo_analyzer.git.subprocess.run", wraps=real_run) as mocked_run:
        report = Analyzer(repo).analyze(
            "checkout", paths=["src"], respect_sparse=True
        ).to_dict()

    commands = [call.args[0] for call in mocked_run.call_args_list if call.args]
    forbidden = {"fetch", "clone", "pull", "push", "ls-remote"}
    assert not any(any(token in forbidden for token in command) for command in commands)
    assert report["status"] == "incomplete"
    assert report["paths"]["selected"] == ["src", "src/main.py"]
    assert report["cost"]["missing_blob_count"] == 1
    assert report["cost"]["promisor_fetch_required"] is True
    assert "promisor_fetch_required" in report["diagnostics"]
    assert report["statistics"]["partial_clone"]["enabled"] is True
    assert report["network_attempted"] is False


def test_unreachable_commit_can_be_explicitly_analyzed(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    (repo / "orphan.txt").write_text("orphan\n")
    run_git(repo, "add", "orphan.txt")
    run_git(repo, "commit", "-qm", "orphan")
    orphan = run_git(repo, "rev-parse", "HEAD")
    run_git(repo, "reset", "--hard", "HEAD^")
    run_git(repo, "update-ref", "-d", "refs/heads/main")

    analyzer = Analyzer(repo)
    assert analyzer.inventory.objects[orphan].reachable is False
    report = analyzer.analyze("checkout", orphan).to_dict()
    assert report["anchor"]["status"] == "dangling_anchor"
    assert report["status"] == "complete"


def test_shallow_boundary_makes_full_log_indeterminate(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    (repo / "second.txt").write_text("second\n")
    run_git(repo, "add", ".")
    run_git(repo, "commit", "-qm", "second")
    first = run_git(repo, "rev-parse", "HEAD^")
    (repo / ".git" / "shallow").write_text(first + "\n")

    report = Analyzer(repo).analyze("log", history="full").to_dict()
    bounded = Analyzer(repo).analyze("log", history="depth:1").to_dict()
    exact_boundary = Analyzer(repo).analyze("log", history="depth:2").to_dict()

    assert report["status"] == "indeterminate"
    assert report["history"]["status"] == "indeterminate"
    assert "shallow_history_boundary_reached" in report["diagnostics"]
    assert report["cost"]["missing_object_count"] == 0
    assert report["cost"]["promisor_fetch_required"] is False
    assert bounded["status"] == "complete"
    assert exact_boundary["status"] == "complete"
    assert exact_boundary["history"]["status"] == "complete"
    analyzer = Analyzer(repo)
    at_boundary = analyzer.analyze("log", first, history="depth:1").to_dict()
    crossing_boundary = analyzer.analyze("log", first, history="depth:2").to_dict()
    checkout = analyzer.analyze("checkout", first).to_dict()
    assert at_boundary["status"] == "complete"
    assert checkout["status"] == "complete"
    assert crossing_boundary["status"] == "indeterminate"
    assert crossing_boundary["history"]["boundary_reached"] == [first]
    assert crossing_boundary["cost"]["missing_object_count"] == 0
    assert crossing_boundary["cost"]["unknown_missing_size_count"] == 0


def test_cli_json_export_is_local_and_parseable(tmp_path: Path, capsys) -> None:
    repo = make_repo(tmp_path)
    output = tmp_path / "report.json"
    assert main(["analyze", "--repo", str(repo), "--workflow", "checkout", "--format", "json", "--output", str(output)]) == 0
    data = json.loads(output.read_text())
    assert data["network_attempted"] is False
    assert data["status"] == "complete"
    assert capsys.readouterr().out == ""


def test_compare_has_normalized_costs_for_each_strategy(tmp_path: Path, capsys) -> None:
    repo = make_repo(tmp_path)
    output = tmp_path / "compare.json"
    assert main(["compare", "--repo", str(repo), "--path", "src", "--format", "json", "--output", str(output)]) == 0
    data = json.loads(output.read_text())

    assert [item["strategy"] for item in data["strategies"]] == ["full", "sparse", "blobless", "treeless"]
    for strategy in data["strategies"]:
        assert set(strategy["required_by_type"]) == {"commit", "tree", "blob", "tag", "unknown"}
        assert set(strategy["cost"]) == {"initial", "deferred", "local_missing", "transfer_bytes"}
        assert strategy["cost"]["transfer_bytes"] is None
        assert set(strategy["cost"]["initial"]["by_type"]) == {"commit", "tree", "blob", "tag", "unknown"}
        initial = strategy["cost"]["initial"]
        deferred = strategy["cost"]["deferred"]
        assert sum(strategy["required_by_type"].values()) == strategy["required_objects"]
        assert sum(initial["by_type"].values()) == initial["object_count"]
        assert sum(deferred["by_type"].values()) == deferred["object_count"]
        assert initial["object_count"] + deferred["object_count"] == strategy["required_objects"]
    strategies = {item["strategy"]: item for item in data["strategies"]}
    assert strategies["full"]["cost"]["initial"]["object_count"] == 6
    assert strategies["sparse"]["cost"]["initial"]["object_count"] == 4
    assert strategies["sparse"]["cost"]["initial"]["by_type"]["blob"] == 1
    assert strategies["sparse"]["cost"]["deferred"]["object_count"] == 0
    assert strategies["blobless"]["cost"]["initial"]["object_count"] == 4
    assert strategies["blobless"]["cost"]["deferred"]["object_count"] == 2
    assert strategies["treeless"]["cost"]["initial"]["object_count"] == 1
    assert strategies["treeless"]["cost"]["deferred"]["object_count"] == 5
    assert strategies["blobless"]["cost"]["deferred"]["known_logical_bytes"] == len("print('ok')\n".encode()) + len("guide\n".encode())
    assert data["statistics"]["pack"]["objects"]["unique"] == sum(
        data["statistics"]["pack"]["objects"]["by_type"].values()
    )
    assert capsys.readouterr().out == ""
    before = output.read_bytes()
    assert main(["compare", "--repo", str(repo), "--path", "src", "--format", "json", "--output", str(output)]) == 0
    assert before == output.read_bytes()
    text = render_text(data)
    for name in strategies:
        assert f"  {name}:" in text


def test_empty_sparse_selection_has_metadata_cost_only(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    run_git(repo, "config", "core.sparseCheckout", "true")
    run_git(repo, "config", "core.sparseCheckoutCone", "false")
    (repo / ".git" / "info" / "sparse-checkout").write_text("")
    report = _compare(Analyzer(repo), "HEAD", [])
    sparse = next(item for item in report["strategies"] if item["strategy"] == "sparse")
    assert sparse["status"] == "complete"
    assert sparse["cost"]["initial"]["object_count"] == 2
    assert sparse["cost"]["initial"]["by_type"]["blob"] == 0
    assert sparse["cost"]["deferred"]["object_count"] == 0


def test_empty_path_argument_is_rejected(tmp_path: Path, capsys) -> None:
    repo = make_repo(tmp_path)
    assert main(["compare", "--repo", str(repo), "--path", ""]) == 2
    assert "empty --path is invalid" in capsys.readouterr().err


def test_sparse_path_with_no_entries_has_no_blob_cost(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    report = _compare(Analyzer(repo), "HEAD", ["absent-directory"])
    sparse = next(item for item in report["strategies"] if item["strategy"] == "sparse")
    assert sparse["cost"]["initial"]["object_count"] == 2
    assert sparse["cost"]["initial"]["by_type"]["blob"] == 0
    assert sparse["cost"]["local_missing"]["missing_object_count"] == 0


def test_empty_tree_is_complete_with_no_missing_cost(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    run_git(repo, "rm", "-r", ".")
    run_git(repo, "commit", "-qm", "empty checkout")
    report = Analyzer(repo).analyze("checkout").to_dict()
    assert report["status"] == "complete"
    assert report["requirements"]["unknown_frontier"] == 0
    assert report["requirements"]["enumerated"] == 2
    assert report["cost"]["missing_object_count"] == 0


def test_strategy_cost_preserves_missing_object_type_and_unknown_size(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    blob = run_git(repo, "rev-parse", "HEAD:src/main.py")
    (repo / ".git" / "objects" / blob[:2] / blob[2:]).unlink()
    report = _compare(Analyzer(repo), "HEAD", ["src"])
    for strategy in report["strategies"]:
        cost = strategy["cost"]
        assert sum(strategy["required_by_type"].values()) == strategy["required_objects"]
        assert cost["local_missing"]["missing_blob_count"] == 1
        assert cost["local_missing"]["unknown_missing_size_count"] == 1
        assert cost["initial"]["unknown_size_count"] + cost["deferred"]["unknown_size_count"] == 1
        phase = "deferred" if strategy["strategy"] in {"blobless", "treeless"} else "initial"
        assert cost[phase]["unknown_size_count"] == 1
    assert render_json(report) == render_json(_compare(Analyzer(repo), "HEAD", ["src"]))


def test_strategy_totals_are_deterministic_with_promisor_missing_blob(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    run_git(repo, "config", "extensions.partialClone", "origin")
    run_git(repo, "config", "remote.origin.promisor", "true")
    blob = run_git(repo, "rev-parse", "HEAD:src/main.py")
    (repo / ".git" / "objects" / blob[:2] / blob[2:]).unlink()

    first = _compare(Analyzer(repo), "HEAD", ["src"])
    second = _compare(Analyzer(repo), "HEAD", ["src"])

    assert render_json(first) == render_json(second)
    for strategy in first["strategies"]:
        assert sum(strategy["required_by_type"].values()) == strategy["required_objects"]
        assert strategy["cost"]["initial"]["object_count"] + strategy["cost"]["deferred"]["object_count"] == strategy["required_objects"]
        assert strategy["cost"]["local_missing"]["missing_object_count"] == 1
        assert strategy["cost"]["local_missing"]["missing_by_type"]["blob"] == 1
        assert strategy["cost"]["transfer_bytes"] is None


def test_missing_tree_comparison_preserves_unknown_frontier(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    tree = run_git(repo, "rev-parse", "HEAD:src")
    (repo / ".git" / "objects" / tree[:2] / tree[2:]).unlink()
    report = _compare(Analyzer(repo), "HEAD", ["src"])
    for strategy in report["strategies"]:
        assert strategy["status"] == "incomplete"
        assert strategy["requirements"]["unknown_frontier"] == 1
        assert strategy["cost"]["local_missing"]["missing_tree_count"] == 1
        assert sum(strategy["required_by_type"].values()) == strategy["required_objects"]


@pytest.mark.parametrize("duplicate_loose", [False, True])
def test_pack_and_object_counts_are_normalized(tmp_path: Path, duplicate_loose: bool) -> None:
    repo = make_repo(tmp_path)
    blob = run_git(repo, "rev-parse", "HEAD:src/main.py")
    blob_path = repo / ".git" / "objects" / blob[:2] / blob[2:]
    loose_bytes = blob_path.read_bytes()
    run_git(repo, "repack", "-ad")
    if duplicate_loose:
        blob_path.parent.mkdir(exist_ok=True)
        blob_path.write_bytes(loose_bytes)
    stats = Analyzer(repo).inventory.pack_stats
    assert stats["objects"]["unique"] == 6
    assert sum(stats["objects"]["storage"].values()) == 6
    assert stats["objects"]["storage"]["both"] == int(duplicate_loose)
    assert stats["objects"]["storage"]["pack"] == 6 - int(duplicate_loose)
    assert stats["packs"]["count"] == 1
    assert stats["packs"]["object_entries"] == stats["packs"]["unique_objects"] == 6
    assert stats["packs"]["pack_bytes"] == sum(path.stat().st_size for path in (repo / ".git" / "objects" / "pack").glob("*.pack"))
    assert stats["packs"]["index_bytes"] == sum(path.stat().st_size for path in (repo / ".git" / "objects" / "pack").glob("*.idx"))
    assert stats["packed_by_type"] == {"commit": 1, "tree": 3, "blob": 2, "tag": 0}
    assert stats["loose_by_type"] == {"commit": 0, "tree": 0, "blob": int(duplicate_loose), "tag": 0}
    assert stats["count_objects_size_unit"] == "KiB"
