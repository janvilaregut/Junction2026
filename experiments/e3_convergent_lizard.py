"""E3 — Convergent validity: qlab unit metrics vs lizard (independent tool).

Matches functions by (file, start line +-1) and compares cyclomatic complexity,
parameter count and length. Reports Spearman, ICC(2,1), exact-agreement rate,
Bland-Altman bias/limits, and a breakdown of disagreements by C# construct."""
import json
import subprocess
import sys
from collections import Counter
from pathlib import Path

import numpy as np

LAB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB)); sys.path.insert(0, str(LAB / "experiments"))
from qlab.source import load_repo          # noqa: E402
from qlab.model import extract             # noqa: E402
from qlab import complexity                # noqa: E402
from stats import spearman, icc_2_1        # noqa: E402

REPO = LAB / "corpus" / "messagepack-csharp"


def lizard_rows(files):
    cmd = [str(LAB / ".venv" / "bin" / "lizard"), "--csv", "-l", "csharp"] + [str(REPO / f.path) for f in files]
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    rows = []
    import csv, io
    for r in csv.reader(io.StringIO(out)):
        # NLOC,CCN,token,PARAM,length,location,file,function,long_name,start,end
        try:
            rows.append(dict(nloc=int(r[0]), ccn=int(r[1]), params=int(r[3]), length=int(r[4]),
                             file=str(Path(r[6]).resolve().relative_to(REPO.resolve())), name=r[7],
                             start=int(r[9]), end=int(r[10])))
        except (ValueError, IndexError):
            continue
    return rows


def main():
    files = load_repo(REPO, kinds={"prod"})
    ours = {}
    construct = {}
    for f in files:
        _, us = extract(f)
        complexity.measure_units(f, us)
        for u in us:
            if u.kind == "accessor":
                continue
            ours[(f.path, u.start)] = u
            construct[(f.path, u.start)] = Counter(k for k, _ in complexity.decision_points(u.body))
    liz = lizard_rows(files)
    pairs = []
    for r in liz:
        u = None
        for d in (0, 1, -1, 2, -2):
            u = ours.get((r["file"], r["start"] + d))
            if u is not None:
                break
        if u is not None:
            pairs.append((r, u))
    a_cc = np.array([u.cc for _, u in pairs]); b_cc = np.array([r["ccn"] for r, _ in pairs])
    a_p = np.array([u.params for _, u in pairs]); b_p = np.array([r["params"] for r, _ in pairs])
    a_l = np.array([u.sloc for _, u in pairs]); b_l = np.array([r["nloc"] for r, _ in pairs])
    diff = a_cc - b_cc
    # explain disagreements
    expl = Counter()
    for (r, u), d in zip(pairs, diff):
        if d == 0:
            continue
        c = construct[(u.file, u.start)]
        tags = []
        if c.get("foreach_statement"): tags.append("foreach (lizard ignores)")
        if c.get("arm"): tags.append("switch-expression arms (lizard ignores)")
        if c.get("do_statement"): tags.append("do-while")
        if c.get("or_pattern") or c.get("and_pattern"): tags.append("and/or patterns")
        if not tags: tags.append("other (nullable '?' tokens / ?. counted by lizard, catch, local functions)")
        expl[" + ".join(tags)] += 1
    res = dict(
        functions_ours=len(ours), functions_lizard=len(liz), matched=len(pairs),
        cc=dict(spearman=spearman(a_cc, b_cc), icc=icc_2_1(a_cc, b_cc), exact_agreement=float((diff == 0).mean()),
                bias=float(diff.mean()), loa=(float(diff.mean() - 1.96 * diff.std()), float(diff.mean() + 1.96 * diff.std())),
                ours_higher=int((diff > 0).sum()), lizard_higher=int((diff < 0).sum())),
        params=dict(spearman=spearman(a_p, b_p), exact_agreement=float((a_p == b_p).mean())),
        length=dict(spearman=spearman(a_l, b_l), icc=icc_2_1(a_l, b_l), mean_ratio=float((a_l / np.maximum(b_l, 1)).mean())),
        disagreement_causes=dict(expl.most_common()),
    )
    (LAB / "out" / "experiments").mkdir(parents=True, exist_ok=True)
    (LAB / "out" / "experiments" / "e3_convergent_lizard.json").write_text(json.dumps(res, indent=1))
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
