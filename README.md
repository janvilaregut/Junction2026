# Quality Lab

Rama huérfana (`quality-lab`) sin código del producto: un laboratorio para certificar
matemáticamente, sin IA, que un código C# cumple buenas prácticas, y para validar esa
certificación con experimentos. Objetivo de pruebas: el repo del reto (MessagePack-CSharp)
y sus 4 PRs escritas por agentes (Junction 2026, reto Tieto «Earned Trust in AI Code»).

- `qlab/` — analizador (tree-sitter + numpy/scipy): DRY, KISS, tamaño, parámetros, cohesión,
  acoplamiento/ciclos, código muerto, números mágicos, encapsulación, documentación, nombres,
  estilo, manejo de errores, seguridad y fiabilidad; puntuación con IC por bootstrap, veredicto
  de tres estados, perfil de riesgo SIG, puerta de calidad (lógica de Kleene), SARIF y heatmap.
- `experiments/` — E0–E10 (calibración, inyección, invariancia, concordancia, predicción,
  refactorizaciones, PRs, co-cambio de clones, pesos, fiabilidad, flags) y el catálogo de herramientas.
- `research/` — 17 informes de investigación con referencias.
- `report/` — informe y heatmap interactivo (`python3 experiments/build_report.py`).

```bash
python3 -m venv .venv && .venv/bin/pip install tree-sitter tree-sitter-c-sharp numpy scipy lizard
.venv/bin/python -m qlab.cli analyze <repo> --out out/<nombre>
```

Los corpus (`corpus/`) y las salidas en bruto de herramientas no se versionan: son grandes y
contienen rutas locales. Los scripts los regeneran.
