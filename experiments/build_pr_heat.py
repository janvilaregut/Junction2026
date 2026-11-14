"""Heatmap data for the changed production files of each agent PR, with the added lines marked."""
import json
import sys
from pathlib import Path

LAB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB)); sys.path.insert(0, str(LAB / "experiments"))
from qlab.analyze import analyze      # noqa: E402
from qlab.report import heat_data     # noqa: E402
from e6_pr_analysis import added_lines  # noqa: E402

out = {}
for b in ("2129", "2234", "2283", "2297"):
    A = analyze(LAB / "corpus" / "dotnet" / b)
    add = added_lines(b)
    prod = {f.path for f in A.files}
    changed = {f for f in add if f in prod}
    H = heat_data(A, None, files=changed)
    for f in H["files"]:
        f["added"] = sorted(add.get(f["path"], ()))
    out[b] = dict(files=H["files"])
    print(b, [(f["path"].split("/")[-1], len(f["added"])) for f in H["files"]])
(LAB / "out" / "messagepack" / "pr_heat.json").write_text(json.dumps(out, separators=(",", ":")))
