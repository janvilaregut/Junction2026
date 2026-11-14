"""Practice registry: every practice, its dimension, thresholds and sources.

Violation severity of an entity is a ramp: v(x) = clamp((x - lo) / (hi - lo), 0, 1),
so v = 0 at or below the "low risk" bound and v = 1 at the "very high risk" bound.
Thresholds come from the sources cited in research/*.md.
"""
from __future__ import annotations

from dataclasses import dataclass, field


def clamp(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))


def ramp(x, lo, hi):
    if hi == lo:
        return 1.0 if x > lo else 0.0
    return clamp((x - lo) / (hi - lo))


@dataclass
class Practice:
    id: str
    name: str
    dimension: str            # maintainability | consistency | reliability | security | tests
    population: str
    definition: str
    thresholds: dict = field(default_factory=dict)
    sources: list = field(default_factory=list)


PRACTICES: dict[str, Practice] = {p.id: p for p in [
    Practice("dry", "Write code once (DRY)", "maintainability", "code lines",
             "share of code lines not covered by Type-1 (v=1), Type-2 (0.7), near-miss Type-3 (0.4) or repeated-statement micro-clones (0.3)",
             {"type1_window_tokens": 100, "type2_window_tokens": 50, "min_lines": 6},
             ["Kamiya 2002 CCFinder", "Roy & Cordy 2009", "SIG 2026 duplication cap 5.8%", "Sonar C# 100 tokens/10 lines"]),
    Practice("simple_units", "Keep units simple (KISS)", "maintainability", "units, weighted by SLOC",
             "v = max(ramp(CC,10,25), ramp(Cognitive,15,30), ramp(nesting,3,6))",
             {"cc": (10, 25), "cog": (15, 30), "nest": (3, 6), "sig_bands_cc": (5, 10, 25)},
             ["McCabe 1976", "Campbell 2018 (Sonar cognitive, default 15)", "SIG 2026 McCabe bands 5/10/25", "Sonar S134 nesting 3"]),
    Practice("small_units", "Keep units small", "maintainability", "units, weighted by SLOC",
             "v = ramp(SLOC, 15, 60)", {"sloc": (15, 60), "sig_bands": (15, 30, 60)},
             ["SIG Building Maintainable Software, unit size bands 15/30/60"]),
    Practice("small_interfaces", "Keep unit interfaces small", "maintainability", "units, weighted by SLOC",
             "v = ramp(parameters, 2, 7)", {"params": (2, 7), "sig_bands": (3, 5, 7)},
             ["SIG parameter bands >=3/>=5/>=7", "Sonar S107 default 7", "Code Climate 4"]),
    Practice("cohesion", "Single responsibility / high cohesion", "maintainability", "classes with state, weighted by SLOC",
             "v = ramp(LCOM4, 1, 4); God Class (WMC>=47 and TCC<1/3) => v = 1",
             {"lcom4": (1, 4), "god_wmc": 47, "god_tcc": 1 / 3},
             ["Hitz & Montazeri 1995 LCOM4", "Bieman & Kang 1995 TCC", "Marinescu 2004 detection strategies"]),
    Practice("coupling", "Loose coupling", "maintainability", "types, weighted by SLOC",
             "v = ramp(CBO, 14, 28) with CBO = |efferent U afferent| project types; plus namespace cycles (ADP) and propagation cost at repo level",
             {"cbo": (14, 28)},
             ["Chidamber & Kemerer 1994", "Sahraoui CBO 14 / Shatnawi 9", "Martin ADP", "MacCormack 2006 propagation cost"]),
    Practice("dead_code", "No dead code (YAGNI)", "maintainability", "code + commented-out lines",
             "share of lines that are unused private members, unused locals, unreachable statements or commented-out code",
             {}, ["IDE0051/IDE0052", "Pham & Yang commented-out code", "ISO 5055 commented-out code"]),
    Practice("magic_numbers", "No magic numbers", "maintainability", "code lines",
             "share of code lines without unnamed numeric literals (ignoring -1,0,1,2 and const/readonly/enum/attribute/default-parameter contexts)",
             {"ignored": [-1, 0, 1, 2]}, ["Checkstyle MagicNumber", "Sonar S109"]),
    Practice("encapsulation", "Encapsulation", "maintainability", "fields of classes/structs",
             "share of fields that are not publicly writable (CA1051)", {}, ["CA1051", "Lanza & Marinescu"]),
    Practice("documentation", "Document the public API", "maintainability", "publicly visible types and members",
             "share of public API elements with an XML doc comment (CS1591)", {}, ["CS1591/SA1600", "Beller 2014: documentation is the largest review category"]),
    Practice("naming", "Meaningful, conventional names", "consistency", "declared identifiers",
             "v = 1 convention violation or linguistic antipattern, 0.5 too short / inconsistent, 0.25 abbreviation",
             {}, [".NET Framework Design Guidelines", "Hofmeister 2017", "Arnaoudova 2013/2016 linguistic antipatterns", "Butler 2010"]),
    Practice("consistency", "Consistent style", "consistency", "style decisions",
             "mean over conventions of the share following the repository majority", {}, ["Allamanis 2014 (conventions)", "normalised Shannon entropy"]),
    Practice("error_handling", "Handle errors properly", "reliability", "catch clauses and throw sites",
             "v: empty catch 1 (0.5 commented), throw ex 1, catch-all without rethrow 0.7 (0.3 filtered), reserved exception 0.5, useless catch 0.3",
             {}, ["CA1031", "CA2200", "CA2201", "de Padua & Shang 2017/2018"]),
]}

DIMENSIONS = {
    "security": ["security"],
    "reliability": ["error_handling", "reliability"],
    "tests": ["tests"],
    "maintainability": ["dry", "simple_units", "small_units", "small_interfaces", "cohesion", "coupling",
                        "dead_code", "magic_numbers", "encapsulation", "documentation"],
    "consistency": ["naming", "consistency"],
}

# teammate proposal (Q = 0.30 S + 0.25 F + 0.20 P + 0.15 M + 0.10 C)
TEAM_WEIGHTS = {"security": 0.30, "reliability": 0.25, "tests": 0.20, "maintainability": 0.15, "consistency": 0.10}

# SIG / TUV NORD 4-star caps (guidance v18.1, 2026): max % of LOC above each band
SIG_4STAR = {
    "small_units": {"bands": (15, 30, 60), "caps": (0.480, 0.242, 0.091)},
    "simple_units": {"bands": (5, 10, 25), "caps": (0.207, 0.075, 0.011)},
    "small_interfaces": {"bands": (2, 4, 6), "caps": (0.154, 0.034, 0.009)},   # >=3, >=5, >=7
    "duplication_cap": 0.058,
}
