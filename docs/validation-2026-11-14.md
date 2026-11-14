# Cierre de validación local — 14/11/2026

Implementación: grafo → selección de funciones → contrato y reconstrucción desde la base → debate → ataques ejecutados sobre original y alternativas → comprobación por nodo → juicio y evidencia. Las reparaciones se proponen y validan en copias; nunca modifican automáticamente el PR.

## Profundidad

| Perfil | Tiempo máximo | Tokens máximos | Alternativas nuevas |
|---|---:|---:|---|
| Quick | 90 s | 25.000 | 0 |
| Standard | 300 s | 100.000 | Hasta 2 |
| Deep | 900 s | 250.000 | Hasta 4 iniciales + 2 descendientes |

La demanda usa la misma fórmula `min(4, 2 + ceil(log2(G)) + H)`. El planificador la limita por perfil, tiempo y tokens restantes. G son grupos de comportamiento y H grupos de alto impacto. No son probabilidades de corrección. Quick no cumple la comparación independiente exigida para verificar nodos. En una continuación pueden conservarse más alternativas anteriores que el límite de nuevas construcciones.

## Ejecuciones reales del #2283

| Ejecución | Duración | Tokens nuevos observados | Original | C1 | C2 |
|---|---:|---:|---|---|---|
| Deep `ju26-issue-2283-mwgpjs3o` | 664,509 s | 114.151 | 174/174 | 173/174 | 170/174 |
| Continuación Standard `ju26-issue-2283-mwgpzdzn` | 262,734 s | 20.024 | 175/175 | 174/175 | 171/175 |

C1 usa Hydrogen y C2 Nemotron; C2 completó ambas suites sin timeout. Carbon emitió el juicio semántico. Deep reprodujo los tres casos rojo→verde y detectó tres de cuatro mutaciones; construyó tres alternativas, descartó dos propuestas inválidas y un duplicado. Entire recuperó checkpoints de C1, C2 y C3. Decisions participó en Deep con una respuesta de 483 ms. El prompt original de #2283 no está disponible: no se inventa a partir de los checkpoints de candidatos.

Deep quedó en 7/10 por un test disputado: el defensor desconocía el adaptador de pruebas añadido por Katse. Se corrigió el contexto para incluir su implementación real. Un control independiente con Nemotron admitió ese mismo test: 5,517 s y 5.757 tokens. No se reescribió el informe histórico.

La continuación se inició desde el botón de la web, reutilizó contrato, escenarios admitidos y candidatos, y recalculó las ejecuciones. Resultado: 9/10 en la rúbrica del requisito, sin fallos confirmados del original. **El grafo conserva 27% respaldado y tres nodos pendientes**, porque Standard solo tuvo tiempo de completar la comprobación de sensibilidad de GetObjectInfo. La firma global sigue bloqueada. 9/10 no equivale a 90% de probabilidad ni a cobertura total.

La cadena de continuación registra 167.865 tokens acumulados, incluyendo 33.690 de la revisión previa. No incluye otros controles ni intentos de diagnóstico. Las duraciones dependen del equipo, la compilación y los proveedores; no constituyen un benchmark comparativo.

## Comprobaciones adicionales

- Suite automatizada de Katse: 456 casos, 455 correctos, cero fallos y una omisión explícita de POSIX en Windows.
- Roslyn instrumenta métodos con cuerpo y expresiones, y rechaza C# sintácticamente inválido antes de una compilación costosa.
- Control preparado: una acusación falsa se descarta ejecutándola; una regresión sembrada se detecta; la reparación propuesta supera 171/171 tests. Son controles preparados, no descubrimientos de los agentes.
- El porcentaje usa pesos `1 + 4 * impact`, un denominador fijo y evidencia vinculada a código, contrato y entorno. No sube por leer el código o por acuerdo de modelos.
- La UI permite elegir profundidad, continuar, revisar todo el PR y consultar puntuación, pendientes, candidatos y checkpoints. No ofrece firma mientras falte alcance verificable.
- Una corrección adicional garantiza que la suite final incluya al candidato elegido aunque sea un descendiente tardío; cubierta por prueba de regresión.

## Límites pendientes

- Gemma real: reservado al otro ordenador. La integración y los bloqueos estrictos tienen pruebas automatizadas; no se ejecutó el modelo local aquí. El caso público fijado de Tieto usa la excepción explícita de privacidad.
- GetPropertyIdentifierLocation no fue sensible a los escenarios de Deep: requiere un escenario específico adicional. Otros dos nodos sí tuvieron pruebas sensibles en Deep, pero no se reutiliza esa conclusión como aprobación cuando aquel juicio quedó pendiente.
- Las copias locales de Windows no son un sandbox de seguridad del sistema operativo. Este cierre valida el caso C# de Tieto, no todos los repositorios o lenguajes.
- No se ha demostrado experimentalmente que reconstruir supere la revisión directa con presupuesto equivalente.

Arranque normal: `npm ci`, configuración local según README y `npm start`. Durante este cierre la instancia revisada se dejó en `http://localhost:4175`. Los informes y credenciales locales no se suben a Git.
