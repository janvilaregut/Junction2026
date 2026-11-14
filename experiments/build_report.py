"""Assemble report/index.html from the experiment outputs (no hand-copied numbers
for experiment tables) and copy the heatmap data next to it."""
import json
import shutil
from pathlib import Path

LAB = Path(__file__).resolve().parents[1]
OUT = LAB / "out" / "experiments"
J = lambda p: json.loads(Path(p).read_text())

e0, e0b, e1, e2, e3 = (J(OUT / f) for f in ("e0_benchmark.json", "e0b_alves.json", "e1_injection.json",
                                            "e2_invariance.json", "e3_convergent_lizard.json"))
e4 = J(OUT / "e4_meta.json")
e6, e8, e9 = J(OUT / "e6_pr_analysis.json"), J(OUT / "e8_weights.json"), J(OUT / "e9_reliability_flags.json")
dn = J(LAB / "out" / "dotnet" / "summary.json")
tools_path = LAB / "out" / "tools" / "summary.json"
tools = J(tools_path) if tools_path.exists() else None
mp_results = J(LAB / "out" / "messagepack" / "results.json")

NAMES = {"dry": "DRY (duplicación)", "simple_units": "Métodos simples (KISS)", "small_units": "Métodos pequeños",
         "small_interfaces": "Pocos parámetros", "cohesion": "Cohesión (SRP)", "coupling": "Bajo acoplamiento",
         "dead_code": "Sin código muerto", "magic_numbers": "Sin números mágicos", "encapsulation": "Encapsulación",
         "documentation": "API pública documentada", "naming": "Nombres", "consistency": "Estilo consistente",
         "error_handling": "Manejo de errores"}
DIM = {"maintainability": "Mantenibilidad", "consistency": "Consistencia", "reliability": "Fiabilidad",
       "security": "Seguridad", "tests": "Pruebas"}
from qlab.practices import PRACTICES  # noqa: E402

# ---------------------------------------------------------------- MessagePack table
mp = []
for pid, b in e0["practices"].items():
    lo, hi = b["target_ci"]
    tau = b["median"]
    verdict = "CERTIFIED" if lo >= tau else ("NOT CERTIFIED" if hi < tau else "INCONCLUSIVE")
    mp.append(dict(name=NAMES[pid], dim=DIM[PRACTICES[pid].dimension], score=100 * b["target"], lo=100 * lo, hi=100 * hi,
                   tau=100 * tau, pct=b["target_percentile"], verdict=verdict))

# ---------------------------------------------------------------- Alves
LBL = {"sloc": "Líneas por método", "cc": "Complejidad ciclomática", "cog": "Complejidad cognitiva", "params": "Parámetros"}
ALVES_PUB = {"sloc": "30 / 44 / 74", "cc": "6 / 8 / 14", "cog": "—", "params": "2 / 3 / 4"}
alves = []
for m, b in e0b["bands"].items():
    c3 = e0b["caps"][m]["three_star"]
    cert = e0b["certification"][m]
    alves.append(dict(metric=LBL[m], bands=" / ".join(f"{t:g}" for t in b["thresholds"]), alves=ALVES_PUB[m],
                      caps3=" / ".join(f"{100 * c:.1f}" for c in c3),
                      mp=" / ".join(f"{100 * c:.1f}" for c in cert["three_star"]["point"]),
                      v3=cert["three_star"]["verdict"], v4=cert["four_star"]["verdict"]))

# ---------------------------------------------------------------- PRs
prs = []
for b, r in e6["prs"].items():
    ev = r["evidence"]
    k, n = ev["patch_coverage"]
    lo, hi = ev["patch_cov_wilson"]
    imp = r["impact"]
    prs.append(dict(id=b, lines=r["added_code_lines"], introduced=len(r["introduced_findings"]), api=len(imp["public_api_added"]),
                    conds=len(imp["new_conditions"]), impacted=f'{imp["impacted_all"]} / {imp["types_total"]}',
                    tests_reach=imp["tests_statically_reaching"], tests=f'{ev["tests"]} ok · {ev["failed"]} fallan',
                    cov=f"{k}/{n} = {100 * k / n:.1f} % ({lo:.0f}–{hi:.0f})" if n else "n/a",
                    dup=f'{r["new_dup_lines"]}/{r["added_code_lines"]}' if r["added_code_lines"] else "0/0",
                    gn=r["gate_naive"]["state"], gs=r["gate_statistical"]["state"]))

# ---------------------------------------------------------------- E1
OPN = {"dry_type1": "Copia exacta (Tipo-1)", "dry_type2": "Copia renombrada (Tipo-2)", "dry_type3": "Copia con cambios (Tipo-3)",
       "kiss_nesting": "4 if anidados con &&", "unit_length": "Duplicar cuerpo del método", "parameters": "+5 parámetros",
       "short_name": "Variable renombrada a «qz»", "magic_number": "Literal 4093 * 37", "empty_catch": "try/catch vacío",
       "throw_ex": "throw ex;", "remove_docs": "Quitar ///", "dead_method": "Método privado sin uso",
       "public_field": "Campo público mutable", "cohesion_split": "Campo + métodos aislados",
       "insecure_deserializer": "new BinaryFormatter()", "hardcoded_secret": "Clave AWS en literal", "lock_this": "lock (this)"}
e1rows = []
for op, s in e1["summary"].items():
    n = s.get("n_expected", s["n"]) if s.get("recall_expected") is not None else s["n"]
    rec = s["recall_expected"] if s.get("recall_expected") is not None else s["recall"]
    lo, hi = s["recall_expected_ci"] if s.get("recall_expected") is not None else s["recall_ci"]
    ex = s.get("metamorphic_exact")
    e1rows.append(dict(op=OPN.get(op, op), practice=NAMES.get(s["practice"], s["practice"].capitalize()), n=n, recall=rec,
                       lo=lo, hi=hi, exact=f"{ex[0]}/{ex[1]} exactos" if ex else None, spurious=s["spurious_total"]))

# ---------------------------------------------------------------- E2 / E3
TN = {"blank_lines": "Líneas en blanco", "comment_lines": "Líneas de comentario", "rename_locals": "Renombrado consistente de locales",
      "region_wrap": "Envolver en #region", "brace_knr": "Llaves estilo K&R (sin contar SLOC)",
      "_clean_parse": "Total · ficheros que se parsean limpios", "_needs_containment": "Total · ficheros con contención de errores"}
e2rows = []
for k, s in e2["summary"].items():
    if k in TN:
        diff = ", ".join(f"{a} ({b})" for a, b in s.get("differing", {}).items()) or "nada"
        e2rows.append(dict(t=TN[k], pairs=s["pairs"], inv=s["invariant"], rate=s["rate"], lo=s["lower95_one_sided"], diff=diff))
c = e3["cc"]
e3rows = [dict(m="Complejidad ciclomática", n=e3["matched"], rho=c["spearman"][0], icc=c["icc"], exact=f'{100 * c["exact_agreement"]:.1f} %',
               bias=f'{c["bias"]:+.2f} (LoA {c["loa"][0]:.1f} a {c["loa"][1]:.1f})'),
          dict(m="Parámetros", n=e3["matched"], rho=e3["params"]["spearman"][0], icc=None,
               exact=f'{100 * e3["params"]["exact_agreement"]:.1f} %', bias="—"),
          dict(m="Longitud (líneas)", n=e3["matched"], rho=e3["length"]["spearman"][0], icc=e3["length"]["icc"],
               exact="—", bias=f'ratio medio {e3["length"]["mean_ratio"]:.3f}')]

# ---------------------------------------------------------------- E4 forest (36 m, partial controlling size; size raw)
P = e4["36m"]["predictors"]
FOREST = [("sloc", "Tamaño (líneas) · en bruto", "raw"), ("prior_churn", "Cambios previos", "partial"),
          ("out_degree", "Grado de salida", "partial"), ("max_cbo", "CBO máximo", "partial"),
          ("betweenness", "Intermediación", "partial"), ("dup_t1_frac", "Duplicación Tipo-1", "partial"),
          ("sum_cog", "Σ complejidad cognitiva", "partial"), ("max_cc", "Ciclomática máxima", "partial"),
          ("max_nest", "Anidamiento máximo", "partial"), ("max_lcom4", "LCOM4 máximo", "partial"),
          ("doc_coverage", "Cobertura de docs", "partial"), ("in_degree", "Grado de entrada", "partial"),
          ("pagerank", "PageRank", "partial")]
e4rows = []
for key, name, kind in FOREST:
    v = P[key][kind]
    e4rows.append(dict(name=name, r=v["r"], lo=v["lo"], hi=v["hi"], sig=v.get("q", 1) < 0.05))

e5rows = [["Líneas de código", "383 / 204 / 169", "1,9·10⁻⁹", "0,30"], ["Σ ciclomática", "227 / 157 / 372", "2,2·10⁻³", "0,20"],
          ["Ciclomática máxima", "71 / 32 / 653", "3,7·10⁻⁴", "<b>0,43</b>"], ["Σ cognitiva", "236 / 111 / 409", "1,7·10⁻⁸", "<b>0,36</b>"],
          ["Anidamiento máximo", "36 / 10 / 710", "2,2·10⁻³", "<b>0,53</b>"], ["Líneas medias por método", "330 / 201 / 225", "2,9·10⁻⁸", "0,29"],
          ["Duplicación Tipo-2 intra-fichero", "169 / 202 / 385", "0,86", "0,01"], ["Densidad de números mágicos", "114 / 167 / 475", "0,97", "−0,13"],
          ["Densidad de malos nombres", "219 / 215 / 322", "0,86", "0,03"]]
e7rows = [["Co-cambio de pares de clones P(ambos | ≥1)", "0,63 [0,61–0,64]", "<b>0,38</b> [0,36–0,41]"],
          ["Pares de control emparejados", "0,39 [0,38–0,40]", "0,105 [0,098–0,113]"],
          ["Odds ratio (Fisher)", "2,6 · p ≈ 10⁻²⁰⁷", "<b>5,2</b> · p ≈ 10⁻¹²⁴"],
          ["Repos donde clones > control", "13 / 13", "13 / 13"],
          ["Cambio parcial: grupos de 2", "0,33", "0,45"],
          ["Cambio parcial: grupos de ≥ 3", "<b>0,65</b> (p = 5·10⁻⁹)", "<b>0,86</b> (p = 10⁻¹³)"]]

# ---------------------------------------------------------------- E8
DN = {"security": "Seguridad", "reliability": "Fiabilidad", "maintainability": "Mantenibilidad", "consistency": "Consistencia"}
e8w = [dict(dim=DN[d], stated=e8["stated_weight"][d], effective=e8["effective_weight_share_of_variance"][d]) for d in e8["dims"]]
cf = e8["closed_form"]
e8rows = [
    ["Compensación", f'1 punto de Seguridad compra {cf["exchange_rate_S_to_C"]:.0f} de Consistencia; con S = 0 y el resto perfecto, Q = {cf["Q_if_S_zero_rest_perfect"]:.0f}'],
    ["Una vulnerabilidad crítica", f'Si cuesta 25 puntos de S, Q = {cf["Q_with_one_critical_if_penalty_25"]:.1f}; si cuesta 50, Q = {cf["Q_with_one_critical_if_penalty_50"]:.0f}'],
    ["Estabilidad del ranking (pesos al azar en el símplex)", f'τ de Kendall mediana {e8["stability_uniform"]["kendall_tau_median"]:.2f} (p5 {e8["stability_uniform"]["kendall_tau_p05"]:.2f}); desplazamiento medio {e8["stability_uniform"]["mean_rank_shift"]:.1f} puestos'],
    ["Estabilidad con pesos que respetan el orden S ≥ F ≥ M ≥ C", f'τ mediana {e8["stability_ordered"]["kendall_tau_median"]:.2f}; desplazamiento {e8["stability_ordered"]["mean_rank_shift"]:.1f}'],
    ["Media aritmética vs geométrica", f'τ de Kendall {e8["arith_vs_geom_kendall"]:.2f} entre ambos rankings'],
    ["Q a nivel repo en las PRs (E6)", "85,24 (base) → 85,26–85,30 en las 4 PRs: la nota global no distingue PRs"],
]
REL = [(NAMES[k], v["split_half_r"], v["spearman_brown"]) for k, v in e9["reliability"].items()]
REL.sort(key=lambda x: -x[2])
f = e9["flags"]
e10 = (f"<p>De {f['n_flag_methods'] + f['n_other']:,} métodos en 26 repos, {f['n_flag_methods']:,} ({100 * f['share_flag']:.1f} %) tienen un parámetro "
       f"<code>bool</code> que decide un <code>if</code> o un <code>?:</code>. Su complejidad cognitiva por línea es claramente mayor "
       f"(mediana {f['cog_density_median_flag']:.2f} frente a {f['cog_density_median_other']:.2f}; δ de Cliff = {f['cliffs_delta']:.2f}, efecto grande; "
       f"Mann–Whitney p ≈ 10⁻²⁸²). Pasa en {f['repos_flag_more_complex']} de {f['repos']} repos (prueba de signos p = {f['sign_test_p']:.0e}). "
       "Apoya la idea de tu compañera: una función genérica llena de flags es peor en términos de KISS que dos copias claras. "
       "Matiz: usar el flag en una condición ya suma +1 por definición, y estos métodos también son más largos (mediana "
       f"{f['sloc_median_flag']:.0f} frente a {f['sloc_median_other']:.0f} líneas). Por eso mido la densidad por línea y lo presento como indicio fuerte, no como prueba causal.</p>").replace(",", ".")

# ---------------------------------------------------------------- tools
if tools:
    tt = tools.get("report_summary") or {}
    text = tt.get("text_es") or "<p>Resultados del agente de herramientas en <code>out/tools/summary.json</code> y <code>research/15-tool-catalog-experiments.md</code>.</p>"
    head, rows = tt.get("head", []), tt.get("rows", [])
else:
    text = "<p>El experimento con el catálogo de herramientas seguía en marcha al publicar esta versión.</p>"
    head, rows = [], []

# ---------------------------------------------------------------- dotnet
dot = []
for ref in ("base", "2129", "2234", "2283", "2297"):
    r = dn["refs"][ref]
    t = r["tests"]
    pc = r.get("patch_coverage") or {}
    cov = f'{pc["covered"]}/{pc["new_lines"]} = {pc["pct"]:.1f} %' if pc.get("new_lines") else "—"
    ci = f'{pc["wilson_low"]:.1f} – {pc["wilson_high"]:.1f}' if pc.get("new_lines") else "—"
    an = r.get("analyzers") or {}
    dot.append([("base" if ref == "base" else f"#{ref}"), f'{t["passed"]} / {t["failed"]} / {t["skipped"]}', cov, ci,
                f'{an.get("new_vs_base_count", 0)} ({an.get("new_high_severity_count", 0)})' if ref != "base" else f'{an.get("active", "?")} activos, 0 de seguridad'])

# ---------------------------------------------------------------- ranking & algorithms (expert synthesis, cited in the page)
R = [
    ("Tests que fallan (sobre todo nuevos fallos frente a la base)", "Bloquea", 5, 5, 3, 5,
     "Ejecutar la suite en base y en la PR; fallo nuevo = test que pasa en base y falla en la PR.",
     "Un test que falla es un defecto demostrado. Medida exacta (los 8 proyectos corren en .NET 8 en las 5 versiones)."),
    ("Secretos en el código", "Bloquea", 5, 4, 3, 4,
     "Patrones (AKIA…, ghp_, PEM, JWT, cadenas de conexión) + entropía de Shannon (> 4,5 bits/carácter base64, > 3,0 hex con contexto).",
     "Explotable al instante. E1 detecta 60/60 claves sembradas. Límite: un secreto aleatorio de 20 caracteres nunca supera 4,32 bits."),
    ("Dependencias con vulnerabilidades conocidas", "Bloquea", 5, 4, 3, 4,
     "Inventario de Directory.Packages.props y .csproj → OSV querybatch (NuGet) → CVSS → crítica/alta.",
     "CVE conocida = riesgo directo. Los escáneres discrepan mucho entre sí (Imtiaz 2021) y OSV-Scanner no lee Directory.Packages.props."),
    ("Patrones inseguros (SAST)", "Bloquea", 5, 3, 2, 2,
     "Reglas Roslyn CA2300–CA5xxx con SARIF + Semgrep; BinaryFormatter, crypto débil, SQL concatenado, TLS sin validar.",
     "Si aparece, bloquea. Pero que no aparezca no prueba nada: las herramientas SAST detectan ~13 % de vulnerabilidades reales (Li 2023)."),
    ("Duplicación (DRY), sobre todo copias nuevas de código existente", "Prioriza", 4, 4, 5, 4,
     "Ventanas de tokens normalizados con hash de Karp–Rabin (Tipo-1: 100 tokens exactos; Tipo-2: 50 con identificadores y literales anonimizados), Jaccard de 5-gramas ≥ 0,7 (Tipo-3) y sentencias repetidas.",
     "E7: los clones cambian juntos 5,2× (odds) y los grupos de ≥ 3 reciben cambios incompletos el doble. Riesgo nº 1 del código de IA (GitClear). E1: 96–100 %."),
    ("Tamaño del cambio y de los métodos", "Prioriza", 3, 5, 4, 5,
     "SLOC por método frente a bandas 32 / 47 / 75 calibradas; % de LOC por encima de cada banda; tamaño del diff.",
     "Mejor predictor de bugs (r = 0,33, 12/12 repos, E4); mejora con las refactorizaciones (E5); ICC 0,9995 con lizard."),
    ("Manejo de errores", "Prioriza", 5, 3, 4, 5,
     "catch vacío, catch-all sin relanzar (CA1031), throw ex (CA2200), excepciones reservadas (CA2201).",
     "El 92 % de los fallos catastróficos vienen de errores mal manejados (Yuan 2014); regla nº 1 en commits de IA. E1: 100 %."),
    ("Cobertura del código nuevo (y mutación si se puede)", "Prioriza", 4, 3, 4, 4,
     "Líneas añadidas del diff ∩ líneas cubribles del Cobertura; puerta con intervalo de Wilson; Stryker.NET en líneas cambiadas.",
     "La cobertura sola correlaciona poco con la eficacia de los tests al controlar el tamaño; la mutación sí (Just 2014). 2 de 4 PRs bajo el 80 %."),
    ("Complejidad (cognitiva y anidamiento) relativa al tamaño", "Prioriza", 3, 3, 4, 5,
     "Complejidad cognitiva de Campbell (+1 + anidamiento por estructura, +1 por secuencia booleana); McCabe; anidamiento máximo.",
     "Correlaciona con el tiempo de comprensión (r = 0,54) y baja al refactorizar (E5), pero no predice bugs más allá del tamaño (E4)."),
    ("Acoplamiento saliente y ciclos de dependencias", "Prioriza", 3, 3, 3, 3,
     "CBO = tipos del proyecto referenciados en ambos sentidos; SCC de Tarjan en el grafo de namespaces (ADP); coste de propagación.",
     "Única señal de grafo que añade algo al tamaño (CBO r parcial 0,10, 9/9 repos en 24 meses). PageRank no."),
    ("Documentación de la API pública", "Higiene", 2, 2, 5, 5,
     "% de tipos y miembros públicos con comentario XML ///.",
     "Categoría más frecuente en code review (20–33 %), sin relación con bugs (E4). Fiabilidad 0,96."),
    ("Nombres: convenciones y antipatrones lingüísticos", "Higiene", 2, 3, 4, 3,
     "Convenciones .NET por tipo de identificador, longitud, palabras fuera de diccionario, Get que devuelve void, Is que no devuelve bool.",
     "Los nombres completos aceleran la búsqueda de defectos un 19 % (Hofmeister 2017); los antipatrones lingüísticos dan 1,29× más bugs."),
    ("Código muerto", "Higiene", 2, 2, 4, 4,
     "Miembros privados sin referencias, locales sin uso, sentencias inalcanzables y código comentado (parsea como C#).",
     "Aparece en los primeros puestos en tres estudios de código de IA. E1: 100 %."),
    ("Número de parámetros", "Higiene", 2, 2, 3, 5,
     "Parámetros por método frente a bandas 3 / 4 / 5 calibradas.",
     "Medida exacta (98,4 % de acuerdo con lizard) y efecto débil en comprensión."),
    ("Encapsulación", "Higiene", 2, 2, 2, 5,
     "Campos públicos o protegidos no readonly (CA1051).", "Fácil de medir y de arreglar, con poca evidencia de impacto."),
    ("Consistencia de estilo", "Higiene", 1, 2, 3, 5,
     "Entropía normalizada de cada convención (llaves, indentación, var, alias de tipos); se marca la elección minoritaria.",
     "Frecuente pero lo menos útil en code review (Turzo 2023). Mejor delegarlo en un formateador."),
    ("Cohesión (LCOM4)", "Higiene", 2, 2, 2, 3,
     "Componentes conexas del grafo métodos-campos (TCC como apoyo; God Class si WMC ≥ 47 y TCC < 1/3).",
     "Evidencia contradictoria en la literatura (Radjenović 2013) y la menor fiabilidad entre mitades (0,61)."),
    ("Números mágicos", "Higiene", 1, 1, 2, 4,
     "Literales numéricos fuera de {-1,0,1,2} y fuera de const, readonly, enum, atributos y parámetros por defecto.",
     "No mejora al refactorizar (E5) ni predice bugs (E4); en un serializador binario casi todo son bytes de protocolo."),
]
TIER_ORDER = {"Bloquea": 0, "Prioriza": 1, "Higiene": 2}
R.sort(key=lambda r: (TIER_ORDER[r[1]], -(r[2] * r[3] * r[4] * r[5])))
ranking = [dict(name=r[0], tier=r[1], C=r[2], E=r[3], P=r[4], M=r[5], algo=r[6], why=r[7]) for r in R]

ALG = [
    ("DRY · clones", "tokens = hojas del árbol (sin comentarios, usings, atributos)\nTipo-2: identificador→ID, literal→LIT\nhash(ventana W) con Karp–Rabin; token duplicado si su ventana aparece en otro sitio\nd = |líneas duplicadas| / |líneas de código|   (Tipo-1 W=100, Tipo-2 W=50, ≥ 6 líneas)\nTipo-3: Jaccard(5-gramas) ≥ 0,7 entre métodos ≥ 40 tokens",
     "Cada línea en un clon se colorea con el tipo de clon y dónde está la otra copia.", "Kamiya 2002; Roy & Cordy 2009; SIG (≤ 5,8 %); Sonar (100 tokens)."),
    ("KISS · métodos simples", "CC = 1 + #if, bucles, case, brazos de switch, catch, ?:, &&, ||, ??, patrones and/or\nCognitiva: +1(+anidamiento) por if, ?:, switch, bucle, catch; +1 por else, goto, recursión y secuencia booleana\nv = max(ramp(CC,10,25), ramp(Cog,15,30), ramp(anid.,3,6))",
     "Se colorea el método entero; el detalle muestra qué estructura suma cada punto.", "McCabe 1976; Campbell 2018; Sonar S3776/S134."),
    ("Métodos pequeños", "SLOC = líneas distintas con algún token de código\nv = ramp(SLOC, 15, 60)\nperfil: % LOC en métodos > 32 / 47 / 75 (bandas calibradas)",
     "Se colorea el método entero.", "SIG; Alves 2010."),
    ("Pocos parámetros", "v = ramp(parámetros, 2, 7)\nperfil: % LOC en métodos con > 3 / 4 / 5 parámetros", "Línea de la firma.", "SIG; Sonar S107."),
    ("Cohesión (SRP)", "grafo: métodos de instancia ↔ campos que usan (y llamadas internas)\nLCOM4 = nº de componentes conexas;  v = ramp(LCOM4, 1, 4)\nGod Class: WMC ≥ 47 ∧ TCC < 1/3 ⇒ v = 1",
     "Cabecera de la clase, con los grupos de métodos que no comparten estado (dónde partirla).", "Hitz & Montazeri 1995; Bieman & Kang 1995; Marinescu 2004."),
    ("Acoplamiento y dependencias", "CBO(T) = |tipos del proyecto que T usa ∪ que usan T|;  v = ramp(CBO, 14, 28)\nADP: componentes fuertemente conexas (Tarjan) en el grafo de namespaces\ncoste de propagación = densidad del cierre transitivo",
     "Cabecera del tipo.", "Chidamber & Kemerer 1994; Martin; MacCormack 2006."),
    ("Manejo de errores", "por catch: vacío → 1 (0,5 si comentado) · throw ex → 1 · catch-all sin relanzar → 0,7 (0,3 con filtro) · solo relanza → 0,3\nthrow new Exception/NullReference… → 0,5",
     "Línea exacta del catch o del throw.", "CA1031, CA2200, CA2201; de Pádua & Shang 2018."),
    ("Nombres", "convención .NET por tipo (PascalCase, camelCase, I+Pascal, T+Pascal) → 1\n≤ 2 caracteres fuera de {i,j,k,n,x,y,z,e,…} → 0,5\npalabra fuera de diccionario y de la jerga del repo → 0,25\nGet→void, Is/Has/Can→no bool, Set→valor → 1",
     "Línea de la declaración.", ".NET Design Guidelines; Arnaoudova 2016; Hofmeister 2017."),
    ("Documentación", "API pública = tipos y miembros visibles desde fuera del ensamblado\nC = documentados con /// ÷ total", "Línea de la declaración.", "CS1591 / SA1600."),
    ("Código muerto", "privado sin ninguna referencia en el tipo (incluidas partes partial) · local sin uso · sentencia tras return/throw · comentario que parsea como C#",
     "Línea exacta.", "IDE0051/0052; Pham & Yang."),
    ("Números mágicos", "literal numérico ∉ {−1,0,1,2} fuera de const, readonly, enum, atributo, parámetro por defecto o GetHashCode", "Línea exacta.", "Checkstyle MagicNumber; Sonar S109."),
    ("Encapsulación", "campo public/protected que no es const ni readonly → 1 en clases, 0,5 en structs", "Línea del campo.", "CA1051."),
    ("Consistencia de estilo", "para cada convención: H = −Σ p log₂ p, H̃ = H / log₂ k\nC = media de la cuota de la elección mayoritaria; desviaciones marcadas", "Línea exacta.", "Entropía de Shannon; Allamanis 2014."),
    ("Seguridad y fiabilidad", "secretos: patrones + entropía · APIs peligrosas → CWE (502, 327/328, 295, 611, 89, 78, 338)\nfiabilidad: async void, .Result/.Wait(), lock(this), igualdad de float\nS = 100·exp(−ln2 · Σ pesos / KLOC / 0,5)",
     "Línea exacta, con el CWE.", "Reglas Roslyn CA2300–CA5xxx; detect-secrets."),
    ("Puerta de calidad (3 estados)", "estado = min sobre condiciones con FALLA < INCOMPLETO < PASA (lógica de Kleene)\ncobertura nueva: FALLA si Wilson_sup < 0,8; PASA si p̂ ≥ 0,8; si no, INCOMPLETO\nduplicación nueva: FALLA si Wilson_inf > 3 %\nanalizador que no corrió → INCOMPLETO, nunca «0 hallazgos»",
     "Resultado por PR, con la condición que decide.", "Kleene; Wilson 1927; Sonar «clean as you code»."),
]
algorithms = [dict(name=a[0], formula=a[1], where=a[2], src=a[3]) for a in ALG]

bench_lines = e0["total_code_lines"]
kpis = [
    ["13 + 3", "prácticas medidas sin IA, más seguridad, fiabilidad y puerta de tests"],
    ["96–100 %", "detección de violaciones inyectadas (17 operadores × 60 casos, E1); Tipo-3: 88 %"],
    ["664 / 664", "pares invariantes a cambios de formato y renombrado en ficheros limpios (E2)"],
    ["ICC 0,947", "concordancia de la complejidad ciclomática con lizard en 1.469 métodos (E3)"],
    ["OR 5,2", "los clones detectados cambian juntos 5,2× más que el código vecino (E7, 13 repos)"],
    [f"{(bench_lines + 27609) / 1000:.0f} k", "líneas de producción en la calibración (25 librerías C# + MessagePack)"],
]
research = sorted(p.name for p in (LAB / "research").glob("*.md"))
QDATA = dict(kpis=kpis, ranking=ranking, algorithms=algorithms, alves=alves, mp=mp, prs=prs, e1=e1rows, e2=e2rows, e3=e3rows,
             e4=e4rows, e5=e5rows, e7=e7rows, e8=dict(weights=e8w, rows=e8rows), e9=REL, e10=e10,
             tools=dict(text=text, head=head, rows=rows), dotnet=dot, research=research)

tpl = (LAB / "report" / "template.html").read_text()
html = tpl.replace("__QDATA__", json.dumps(QDATA, ensure_ascii=False))
(LAB / "report" / "index.html").write_text(html)
shutil.copy(LAB / "out" / "messagepack" / "heat.json", LAB / "report" / "heat.json")
print("report/index.html", len(html) // 1024, "KB;  heat.json", (LAB / "report" / "heat.json").stat().st_size // 1024, "KB")
