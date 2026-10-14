"""Safe, read-only Git plumbing access.

This module is deliberately small. Keeping every Git invocation here makes
the local-only guarantee easy to audit.
"""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


class GitError(RuntimeError):
    """A read-only Git command failed."""


@dataclass(frozen=True)
class GitResult:
    stdout: bytes
    stderr: bytes
    returncode: int


class Git:
    """Run only explicitly allow-listed local Git commands."""

    def __init__(self, repo: str | os.PathLike[str]):
        self.repo = Path(repo).expanduser().resolve()
        if not self.repo.exists():
            raise GitError(f"repository path does not exist: {self.repo}")
        self._env = os.environ.copy()
        self._env.update({
            # Block implicit lazy-fetch transports even on older Git versions.
            "GIT_ALLOW_PROTOCOL": "",
            "GIT_NO_LAZY_FETCH": "1",
            "GIT_OPTIONAL_LOCKS": "0",
            "GIT_TERMINAL_PROMPT": "0",
        })

    def run(self, args: Iterable[str], *, check: bool = True) -> GitResult:
        args = tuple(args)
        forbidden = {"fetch", "clone", "pull", "push", "ls-remote"}
        if args and args[0] in forbidden:
            raise GitError(f"network-capable Git command is not allowed: {args[0]}")
        proc = subprocess.run(
            ["git", "-C", str(self.repo), "-c", "fetch.ifMissing=false",
             "-c", "protocol.allow=never", *args],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=self._env,
            check=False,
        )
        result = GitResult(proc.stdout, proc.stderr, proc.returncode)
        if check and proc.returncode:
            message = proc.stderr.decode("utf-8", "replace").strip()
            raise GitError(message or f"git {' '.join(args)} failed")
        return result

    def text(self, args: Iterable[str], *, check: bool = True) -> str:
        return self.run(args, check=check).stdout.decode("utf-8", "surrogateescape")

    def git_dir(self) -> Path:
        raw = self.text(["rev-parse", "--git-dir"]).strip()
        path = Path(raw)
        return path if path.is_absolute() else self.repo / path

    def object_path(self, oid: str) -> Path:
        return self.git_dir() / "objects" / oid[:2] / oid[2:]

    def cat(self, oid: str) -> tuple[str | None, bytes | None]:
        """Return an object's type and contents without triggering a fetch."""
        result = self.run(["cat-file", "--batch"], check=False)
        # This method is only used through batch(), retained as a clear error
        # rather than accidentally running a fetch-capable convenience command.
        del result
        raise GitError("single-object cat is unavailable; use Git.batch")

    def batch(self, oids: Iterable[str]) -> dict[str, tuple[str | None, bytes | None]]:
        values = sorted(set(oids))
        if not values:
            return {}
        proc = subprocess.run(
            ["git", "-C", str(self.repo), "-c", "fetch.ifMissing=false",
             "-c", "protocol.allow=never", "cat-file", "--batch"],
            input=("\n".join(values) + "\n").encode("ascii"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=self._env,
            check=False,
        )
        if proc.returncode:
            raise GitError(proc.stderr.decode("utf-8", "replace").strip() or "git cat-file --batch failed")
        answer: dict[str, tuple[str | None, bytes | None]] = {}
        data = proc.stdout
        pos = 0
        for requested in values:
            end = data.find(b"\n", pos)
            if end < 0:
                raise GitError("truncated git cat-file --batch response")
            header = data[pos:end].decode("ascii", "replace").split()
            pos = end + 1
            if len(header) >= 2 and header[1] == "missing":
                answer[requested] = (None, None)
                continue
            if len(header) < 3:
                raise GitError("malformed git cat-file --batch response")
            kind, size = header[1], int(header[2])
            content = data[pos:pos + size]
            if len(content) != size:
                raise GitError("truncated git cat-file --batch object")
            pos += size
            if pos < len(data) and data[pos:pos + 1] == b"\n":
                pos += 1
            answer[requested] = (kind, content)
        return answer
