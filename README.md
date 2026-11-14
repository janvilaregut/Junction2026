# Katse

Valida cambios generados por IA mediante reconstrucción desde la base, ataques ejecutables y una decisión humana respaldada por evidencia. Proyecto para Junction 2026, reto Tieto «Earned Trust in AI Code».

## Backend completo: reconstrucción y ataques ejecutables

La rama `fabian` añade el pipeline v2 a `mode: completo`. Conserva la API, eventos y lectura de informes v1. El alcance ejecutable del MVP es Windows y C#/.NET, con el caso Tieto #2283.

### Preparación en Windows

1. Instala Node 22.15+ (probado con 24.19), Git y el SDK que indique el `global.json` del repositorio. #2283 usa .NET 8.0.402; Katse también detecta `%USERPROFILE%/.dotnet`.
2. Ejecuta `npm ci`. OpenCode queda fijado en 1.19.5.
3. Ejecuta `powershell -File scripts/setup-tools.ps1` para instalar Entire 0.13.4 con verificación SHA256. También puedes indicar `KATSE_ENTIRE_PATH`.
4. Copia `.env.example` a `.env.local` y rellena `GEMINI_API_KEY` y `VERDA_INFERENCE_KEY`. Este archivo está ignorado por Git. Las claves nunca se guardan en la configuración de OpenCode ni se pasan al runner .NET.
5. Ejecuta `npm run doctor`: verifica los modelos, JSON, herramientas y un checkpoint real de Entire. Consume llamadas reales a los proveedores.
6. Ejecuta `npm start` y abre `http://localhost:4173`. Abre la copia local de Tieto desde el selector de proyecto si aún no aparece. Selecciona `ju26-issue-2283` → **Completa · reconstrucción** → **Verificar** (o **Verificar de nuevo**).

Se usan `gemini-4-hydrogen`, `gemini-4-carbon` y `nemotron-3.5-super-vl`; los identificadores y el endpoint son configurables. `KATSE_THINKING_LEVEL=low` mantiene acotada la latencia de Gemini. [Control de razonamiento de Gemini](https://aistudio.google.com/docs/thinking). El perfil está adaptado a la versión fijada de OpenCode; no se debe copiar una configuración v2 en una instalación v1 sin comprobar compatibilidad.

### Entrada y ejecución

`POST /api/projects/:id/verify` sigue admitiendo `{ "pr": "in:ju26-issue-2283", "options": { "mode": "completo" } }`.

También admite referencias sin PR:

```json
{
  "baseRef": "rama-destino",
  "proposedRef": "rama-propuesta",
  "requirement": "Comportamiento que el cambio debe cumplir",
  "options": { "mode": "completo", "budgetMs": 900000 }
}
```

El máximo es 900000 ms. Se permiten dos sesiones de modelo y un runner a la vez. La generación se cierra a los diez minutos, los ataques a los catorce y el último minuto se reserva al informe. Los presupuestos menores conservan esa proporción. Al agotarse el plazo se cancelan los procesos hijos y se guarda un informe parcial.

1. Fija hashes de propuesta, destino, ancestro e integración. Ejecuta compilación, suite, reproducción en la base, mutaciones y retirada controlada.
2. Hydrogen reconstruye expectativas a partir del requisito y fuentes anteriores. Carbon las revisa. Las citas se comprueban literalmente; una fuente inexistente queda pendiente. Roslyn analiza símbolos, condiciones y referencias directas; la compilación parcial y las dependencias sin resolver se declaran como límite.
3. Crea entre dos y cuatro alternativas desde copias de la base sin remotos ni historial del parche. Puede conservar dos estrategias y generar hasta dos descendientes. La selección prioriza resultados ejecutados, cobertura del contrato y diversidad; la similitud de texto no demuestra corrección.
4. Los ataques proponen tests; un defensor verifica escenario y expectativa. Una disputa permite una revisión y después queda pendiente si sigue sin resolver. Los tests admitidos se aplican al original y a las alternativas. La suite final del candidato recibe también los tests que añadió el PR.
5. Congela original y candidato final, ejecuta tres misiones nuevas y alterna modelos con etiquetas A/B. El juez determinista exige evidencia real; Carbon revisa el significado y las fuentes. Un fallo solo del candidato no condena el original.

Las reglas de población y prioridad son heurísticas registradas en `budget`, no probabilidades de corrección. No se devuelve un porcentaje de confianza. Las salidas son **Pedir cambios**, **Evidencia insuficiente** y **Lista para aprobación humana**. La firma vincula commit, contrato e informe y rechaza referencias o artefactos modificados.

### Evidencia y comprobación

Cada ejecución conserva en `data/runs/<proyecto>/<run>/artifacts` el contrato, parches, sesiones, checkpoints, tests, TRX, comandos, resultados, presupuesto y veredicto. `GET /api/projects/:id/runs/:run/artifact?name=pipeline.json` expone el expediente, y `/report` el informe Markdown. Los nuevos eventos son `contract`, `candidate`, `attack`, `result` y `judgment`.

- `npm test`: pruebas del orquestador, límites, caché, evidencia, formato inválido, cuota, duplicados y firmas.
- `npm run test:controls`: ejecuta sobre #2283 una **regresión preparada** y una **acusación falsa preparada**; se etiquetan como controles, no como descubrimientos de la IA.
- `npm run evaluate -- <run-id> 240000`: compara revisión directa y reconstrucción con el mismo presupuesto y contrato. Guarda tokens, duración, tests ejecutados y hallazgos pendientes de validación. Un caso aislado no permite afirmar que una estrategia sea superior.

Las copias locales de Windows y las restricciones de herramientas no son un sandbox del sistema operativo. El runner ejecuta código del repositorio; este MVP está preparado para el repositorio de Tieto. La compilación y las copias se hacen bajo `%TEMP%/katse` para reducir la carga de OneDrive; los informes permanecen en `data/`. Se conservan copias y checkpoints locales para auditoría. La caché .NET exige también los hashes de las dependencias efectivamente restauradas. Entire aporta procedencia, no garantiza que el código sea correcto. Se extraen solo mensajes de usuario de la transcripción, nunca se interpreta todo `checkpoint explain` como el prompt original. [Integración de Entire](https://docs.entire.com/agents/opencode).

`entire-graph` es opcional y no es una dependencia de este MVP: el análisis local funciona con Roslyn. No se consulta ningún grafo de la propuesta desde los constructores.

## Validación local y límites observados (14/11/2026)

- 27 pruebas del backend superadas. Los controles preparados detectan una regresión deliberada y descartan una acusación falsa mediante ejecución real.
- Recorrido desde la web de #2283: 13 min 3 s; suite original de 170 tests correctos; tres reproducciones rojo→verde; tres de cuatro mutantes detectados. Cuatro propuestas produjeron tres alternativas distintas, con tres checkpoints reales de Entire; la cuarta era un duplicado.
- Resultado: **Evidencia insuficiente**. Una alternativa introduce fallos que el original no presenta. Quedan ataques inválidos/disputados, una validación de candidato agotó su fase y existe una ambigüedad sobre diagnósticos de miembros de tipos externos. Esto impide aprobar automáticamente el expediente.
- Comparación con el mismo límite de 300 s por estrategia y revisión de fuentes: diff directo 95 s / 13.851 tokens; reconstrucción 137 s / 45.198 tokens. Cada una produjo un test ejecutable, pero ambos repetían un caso ya existente. Cero casos nuevos y cero fallos confirmados: **este experimento no demuestra una ventaja de la reconstrucción**. Los tokens incluyen el total comunicado por el proveedor y la auditoría adicional de novedad.
- Una comprobación posterior validó la compilación en la carpeta temporal, los 170 tests y las tres reproducciones; el helper Roslyn identifica las condiciones que contienen las líneas cambiadas. La caché real se reutilizó tras comprobar seis archivos de dependencias restauradas. Los logs y experimentos locales quedan en `data/acceptance`, `data/evaluation` y `data/runs`; no se versionan.

Para mejorar el MVP, la siguiente prioridad es la calidad y novedad de los ataques y la resolución del contrato. Aumentar el número de agentes por sí solo no ha demostrado mejorar la evidencia. No están cubiertos NativeAOT, .NET 10, los otros siete proyectos de test, otros lenguajes ni un sandbox de ejecución del sistema operativo. `entire-graph` no está conectado.

## Archivos principales

- `server/pipeline/complete.js`: presupuesto, generaciones y juicio final.
- `server/agents.js`: proveedores, sesiones independientes de OpenCode y checkpoints Entire.
- `server/pipeline/contract.js` y `tools/Katse.Analyze`: fuentes, expectativas y análisis Roslyn.
- `server/pipeline/evidence.js`: runner, caché, selección y reglas del veredicto.
- `server/pipeline/messagepack-harness.js`: adaptador de escenarios del caso #2283; los modelos eligen inputs y expectativas y el adaptador genera la infraestructura repetitiva de los tests.
- `server/integrity.js`: manifiesto de artefactos y validación de firmas.
- `mvp/`: interfaz existente, ampliada para mostrar los datos v2.

La verificación rápida sigue disponible. Desde terminal: `node server/cli.js workspace/messagepack-csharp ju26-issue-2283 --completo`. Los modelos del pipeline completo se configuran por variables o `options.providers`, no mediante la antigua selección de réplicas del modo rápido.
