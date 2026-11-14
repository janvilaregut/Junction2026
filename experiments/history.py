"""Shared helpers for history-based experiments (E4, E5, E7).

Read-only access to a git clone: commit logs with rename tracking, batch blob
reads, keyword-based bug-fix labelling and point-in-time loading of a tree
into qlab SourceFiles (classification uses the snapshot's own file list)."""
from __future__ import annotations

import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

LAB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB))
from qlab.source import load_file, classify, GEN_NAME   # noqa: E402

# ---------------------------------------------------------------- bug-fix labelling
BUGFIX = re.compile(r"\b(fix(e[sd]|es|ing)?|bug(s|fix)?|crash(es|ed)?|regression|defect|hang(s)?|leak(s)?|"
                    r"exception|wrong|incorrect(ly)?|broken|fault(y)?)\b", re.I)
FALSE_FRIENDS = re.compile(
    r"\b(prefix|suffix|fixture|code ?fix(es)?|codefix(es)?|fix(es|ed)? (the )?(typo|typos|build|builds|ci|test|tests|style|"
    r"code style|readme|docs?|documentation|link|links|anchor|pack|packaging|linux agent|compile|compiler warnings?|warnings?|"
    r"lint|format|formatting|whitespace|spelling|comment|comments|pipeline|yaml|yml|nuget|release|version)|"
    r"dependabot|^bump\b|\bci:|^ci\b|^merge\b)", re.I)


def is_bugfix(msg: str) -> bool:
    first = msg.strip().split("\n")[0]
    if FALSE_FRIENDS.search(first) and not re.search(r"\b(bug|crash|regression|incorrect|wrong)\b", first, re.I):
        return False
    return bool(BUGFIX.search(first))


# ---------------------------------------------------------------- git access
def git(repo: Path, *args, input: str | None = None) -> str:
    r = subprocess.run(["git", "-C", str(repo), "-c", "diff.renameLimit=200000", "-c", "core.quotepath=off", *args],
                       capture_output=True, text=True, input=input)
    if r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args[:3])}: {r.stderr[:300]}")
    return r.stdout


def rev(repo, spec):
    return git(repo, "rev-parse", spec).strip()


def commit_date(repo, sha):
    return git(repo, "log", "-1", "--format=%cI", sha).strip()


def snapshot_months_before(repo, head, months: int) -> str:
    import datetime as dt
    d = dt.datetime.fromisoformat(commit_date(repo, head).replace("Z", "+00:00"))
    y, m = d.year, d.month - months
    while m <= 0:
        m += 12; y -= 1
    target = d.replace(year=y, month=m, day=min(d.day, 28))
    return git(repo, "log", "--first-parent", f"--before={target.isoformat()}", "-1", "--format=%H", head).strip()


@dataclass
class Commit:
    sha: str
    date: str
    subject: str
    parent: str
    changes: list = field(default_factory=list)   # (status, old_path, new_path)

    @property
    def bugfix(self):
        return is_bugfix(self.subject)


def commits(repo, rng: str, no_merges=True, extra=()) -> list[Commit]:
    fmt = "%x00%H%x1f%cI%x1f%P%x1f%s"
    args = ["log", "--reverse", "-M", "--name-status", f"--format={fmt}"] + (["--no-merges"] if no_merges else []) + list(extra) + [rng]
    out = git(repo, *args)
    res = []
    for block in out.split("\x00")[1:]:
        lines = block.split("\n")
        sha, date, parents, subject = (lines[0].split("\x1f") + ["", "", "", ""])[:4]
        c = Commit(sha, date, subject, parents.split(" ")[0] if parents else "")
        for ln in lines[1:]:
            if not ln.strip():
                continue
            parts = ln.split("\t")
            st = parts[0]
            if st.startswith("R") or st.startswith("C"):
                c.changes.append((st[0], parts[1], parts[2]))
            elif len(parts) >= 2:
                c.changes.append((st[0], parts[1], parts[1]))
        res.append(c)
    return res


class RenameTracker:
    """Maps paths seen after T0 back to their T0 path (None if born after T0)."""

    def __init__(self, t0_paths):
        self.cur = {p: p for p in t0_paths}       # current path -> t0 path

    def apply(self, c: Commit):
        touched = []
        for st, old, new in c.changes:
            if st == "R":
                t0 = self.cur.pop(old, None)
                if t0 is not None:
                    self.cur[new] = t0
                touched.append((t0, old, new))
            elif st == "D":
                touched.append((self.cur.pop(old, None), old, None))
            elif st == "A":
                touched.append((self.cur.get(new), None, new))
            else:
                touched.append((self.cur.get(new), new, new))
        return touched


def ls_tree(repo, sha) -> list[str]:
    return [p for p in git(repo, "ls-tree", "-r", "--name-only", sha).split("\n") if p]


def cat_blobs(repo, specs: list[str]) -> dict[str, str]:
    """Read many `rev:path` blobs with one `git cat-file --batch` process."""
    if not specs:
        return {}
    p = subprocess.run(["git", "-C", str(repo), "cat-file", "--batch"], input=("\n".join(specs) + "\n").encode(),
                       capture_output=True)
    data = p.stdout
    out, pos = {}, 0
    for spec in specs:
        nl = data.index(b"\n", pos)
        header = data[pos:nl].decode()
        pos = nl + 1
        if header.endswith("missing") or " blob " not in header:
            continue
        size = int(header.split()[-1])
        out[spec] = data[pos:pos + size].decode("utf-8-sig", errors="replace")
        pos += size + 1
    return out


def classify_at(rel: str, raw: str, snapshot_paths: set) -> str:
    kind = classify(rel, raw, Path("/nonexistent-qlab"))
    if kind == "prod" and str(Path(rel).with_suffix(".tt")) in snapshot_paths:
        return "generated"
    return kind


def load_snapshot(repo, sha, kinds=("prod",), paths=None):
    allp = ls_tree(repo, sha)
    snap = set(allp)
    cs = [p for p in (paths or allp) if p.endswith(".cs")]
    blobs = cat_blobs(repo, [f"{sha}:{p}" for p in cs])
    files = []
    for p in cs:
        raw = blobs.get(f"{sha}:{p}")
        if raw is None:
            continue
        k = classify_at(p, raw, snap)
        if k not in kinds:
            continue
        sf = load_file(repo, p, text=raw)
        sf.kind = k
        files.append(sf)
    return files, snap
