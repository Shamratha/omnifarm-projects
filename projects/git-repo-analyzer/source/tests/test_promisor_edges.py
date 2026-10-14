"""Integration checks using real, locally constructed promisor packs."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from git_repo_analyzer.analyzer import Analyzer


@pytest.fixture
def promised_repository(tmp_path: Path, monkeypatch):
    """Pack commits/trees but omit two blobs; no clone or transport is used."""
    monkeypatch.setenv("GIT_AUTHOR_DATE", "2000-01-01T00:00:00+0000")
    monkeypatch.setenv("GIT_COMMITTER_DATE", "2000-01-01T00:00:00+0000")
    repo = tmp_path / "repo"
    repo.mkdir()

    def git(*args: str, input: str | None = None) -> str:
        return subprocess.run(
            ["git", *args], cwd=repo, input=input, text=True,
            capture_output=True, check=True, timeout=10,
        ).stdout.strip()

    git("init", "-q", "-b", "main")
    git("config", "user.name", "Promisor Fixture")
    git("config", "user.email", "fixture@example.invalid")
    (repo / "src").mkdir()
    (repo / "docs").mkdir()
    (repo / "src/main.py").write_text("print('promised')\n")
    (repo / "src/local.py").write_text("print('local')\n")
    (repo / "docs/guide.md").write_text("excluded promised blob\n")
    git("add", ".")
    git("commit", "-qm", "boundary parent")
    (repo / "src/local.py").write_text("print('local revision')\n")
    git("add", ".")
    git("commit", "-qm", "boundary commit")
    head = git("rev-parse", "HEAD")
    parent = git("rev-parse", "HEAD^")
    promised_blob = git("rev-parse", "HEAD:src/main.py")
    excluded_blob = git("rev-parse", "HEAD:docs/guide.md")
    src_tree = git("rev-parse", "HEAD:src")
    all_oids = {line.split()[0] for line in git("rev-list", "--objects", "--all").splitlines()}
    retained = all_oids - {promised_blob, excluded_blob}
    pack_dir = repo / ".git/objects/pack"
    digest = git("pack-objects", str(pack_dir / "pack"), input="\n".join(sorted(retained)) + "\n")
    (pack_dir / f"pack-{digest}.promisor").write_text("")
    for oid in all_oids:
        (repo / ".git/objects" / oid[:2] / oid[2:]).unlink()
    (repo / ".git/shallow").write_text(head + "\n")
    git("config", "extensions.partialClone", "origin")
    git("config", "remote.origin.promisor", "true")
    git("config", "remote.origin.partialclonefilter", "blob:none")
    git("config", "core.sparseCheckout", "true")
    git("config", "core.sparseCheckoutCone", "false")
    (repo / ".git/info/sparse-checkout").write_text("/src/\n!/src/local.py\n")

    # This helper can only leave a marker and exit. It cannot contact a
    # network; reaching it proves that lazy-fetch transport was attempted.
    marker = tmp_path / "transport-attempted"
    helper = tmp_path / "git-remote-analyzertrap"
    helper.write_text(
        f"#!{sys.executable}\nfrom pathlib import Path\n"
        f"Path({str(marker)!r}).write_text('transport attempted')\nraise SystemExit(99)\n"
    )
    helper.chmod(0o755)
    monkeypatch.setenv("PATH", str(tmp_path) + os.pathsep + os.environ["PATH"])
    git("config", "remote.origin.url", "analyzertrap::never-contact")

    yield {
        "repo": repo, "head": head, "parent": parent, "blob": promised_blob,
        "excluded_blob": excluded_blob, "src_tree": src_tree,
        "marker": marker, "retained": retained,
    }
    assert not marker.exists(), "analyzer invoked a Git transport helper"


def test_real_promisor_pack_missing_sparse_blob(promised_repository):
    fixture = promised_repository
    analyzer = Analyzer(fixture["repo"])
    report = analyzer.analyze(
        "checkout", paths=["src/main.py"], respect_sparse=True
    ).to_dict()

    assert report["status"] == "incomplete"
    assert report["objects"]["missing"] == [fixture["blob"]]
    assert report["paths"]["selected"] == ["src", "src/main.py"]
    assert report["paths"]["not_present"] == []
    assert report["requirements"]["enumerated"] == 4
    assert report["requirements"]["coverage"] == 0.75
    assert report["cost"]["missing_blob_count"] == 1
    assert report["cost"]["unknown_missing_size_count"] == 1
    assert report["cost"]["promisor_fetch_required"] is True
    assert report["statistics"]["promisor_object_count"] == len(fixture["retained"])
    assert report["statistics"]["pack"]["packs"]["count"] == 1
    assert report["anchor"]["reachable_from_refs"] is True
    assert report["network_attempted"] is False


def test_shallow_boundary_and_promisor_risks_are_independent(promised_repository):
    fixture = promised_repository
    analyzer = Analyzer(fixture["repo"])
    full = analyzer.analyze("log", paths=["src/main.py"], patch=True).to_dict()
    bounded = analyzer.analyze(
        "log", paths=["src/main.py"], history="depth:1", patch=True
    ).to_dict()
    metadata = analyzer.analyze("log", history="depth:1").to_dict()

    assert full["status"] == "incomplete"
    assert full["history"]["status"] == "indeterminate"
    assert full["history"]["boundary_reached"] == [fixture["head"]]
    assert set(full["diagnostics"]) == {"shallow_history_boundary_reached", "promisor_fetch_required"}
    assert full["objects"]["missing"] == [fixture["blob"]]
    assert fixture["parent"] not in full["objects"]["required"]
    assert bounded["history"]["status"] == "complete"
    assert bounded["status"] == "incomplete"
    assert metadata["status"] == "complete"
    assert metadata["cost"]["promisor_fetch_required"] is False


def test_sparse_excluded_promised_blob_is_not_a_fetch_requirement(promised_repository):
    fixture = promised_repository
    analyzer = Analyzer(fixture["repo"])
    sparse = analyzer.analyze("checkout", respect_sparse=True).to_dict()
    excluded = analyzer.analyze("checkout", paths=["docs"], respect_sparse=True).to_dict()
    explicit = analyzer.analyze("checkout", paths=["docs"]).to_dict()

    assert sparse["objects"]["missing"] == [fixture["blob"]]
    assert sparse["paths"]["sparse_excluded"] == ["docs", "src/local.py"]
    assert fixture["excluded_blob"] not in sparse["objects"]["required"]
    assert "src/local.py" not in sparse["paths"]["selected"]
    assert excluded["status"] == "indeterminate"
    assert excluded["cost"]["missing_object_count"] == 0
    assert excluded["cost"]["promisor_fetch_required"] is False
    assert explicit["status"] == "incomplete"
    assert explicit["objects"]["missing"] == [fixture["excluded_blob"]]


def test_promisor_missing_tree_does_not_hide_unknown_descendants(promised_repository):
    fixture = promised_repository
    repo = fixture["repo"]
    pack_dir = repo / ".git/objects/pack"
    old_files = list(pack_dir.iterdir())
    retained = fixture["retained"] - {fixture["src_tree"]}
    subprocess.run(
        ["git", "pack-objects", str(pack_dir / "pack")], cwd=repo,
        input="\n".join(sorted(retained)) + "\n", text=True,
        capture_output=True, check=True, timeout=10,
    )
    for index in pack_dir.glob("*.idx"):
        if index not in old_files:
            index.with_suffix(".promisor").write_text("")
    for path in old_files:
        path.unlink()

    report = Analyzer(repo).analyze("checkout", paths=["src"], respect_sparse=True).to_dict()
    assert report["status"] == "incomplete"
    assert report["objects"]["missing"] == [fixture["src_tree"]]
    assert report["requirements"]["unknown_frontier"] == 1
    assert report["cost"]["missing_tree_count"] == 1
    assert report["cost"]["promisor_fetch_required"] is True
    assert set(report["diagnostics"]) == {"missing_tree_prevented_enumeration", "promisor_fetch_required"}


@pytest.mark.parametrize("report_format", ["json", "text"])
def test_promisor_reports_export_identically_across_cli_processes(promised_repository, tmp_path, report_format):
    fixture = promised_repository
    for command, options in (
        ("simulate", ["--path", "src/main.py", "--respect-sparse"]),
        ("analyze", ["--workflow", "log", "--path", "src/main.py", "--patch"]),
        ("compare", ["--path", "src/main.py"]),
    ):
        exports = [tmp_path / f"{command}-{index}.{report_format}" for index in range(2)]
        for path in exports:
            subprocess.run(
                [sys.executable, "-m", "git_repo_analyzer.cli", command,
                 "--repo", str(fixture["repo"]), *options,
                 "--format", report_format, "--output", str(path)],
                capture_output=True, check=True, timeout=15,
            )
        first, second = (path.read_bytes() for path in exports)
        assert first == second
        assert hashlib.sha256(first).hexdigest() == hashlib.sha256(second).hexdigest()
        if report_format == "text":
            assert b"promisor_fetch_required" in first
            assert b"network attempted: False" in first
            continue
        report = json.loads(first)
        assert report["network_attempted"] is False
        if command == "simulate":
            assert report["simulation"]["would_fetch"] == [fixture["blob"]]
            assert report["simulation"]["fetch_performed"] is False
            assert report["simulation"]["remote_contacted"] is False
        elif command == "analyze":
            assert report["history"]["status"] == "indeterminate"
            assert report["history"]["boundary_reached"] == [fixture["head"]]
        else:
            expected = {"full": (7, 0, 2), "sparse": (4, 0, 1),
                        "blobless": (4, 3, 2), "treeless": (1, 6, 2)}
            for strategy in report["strategies"]:
                cost = strategy["cost"]
                initial, deferred, missing = expected[strategy["strategy"]]
                assert cost["initial"]["object_count"] == initial
                assert cost["deferred"]["object_count"] == deferred
                assert cost["local_missing"]["missing_object_count"] == missing
                assert cost["local_missing"]["promisor_fetch_required"] is True
                assert cost["transfer_bytes"] is None
                required = strategy["requirements"]
                assert sum(required["by_type"].values()) == required["enumerated"]
                assert sum(required["present_by_type"].values()) == required["present"]
                assert sum(required["missing_by_type"].values()) == missing
                assert initial + deferred == required["enumerated"]
                assert required["present"] + missing == required["enumerated"]
                assert cost["initial"]["unknown_size_count"] + cost["deferred"]["unknown_size_count"] == missing
