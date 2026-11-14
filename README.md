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
6. Ejecuta `npm start` y abre `http://localhost:4173`. Abre la copia local de Tieto desde el selector de proyecto si aún no aparece. Selecciona `ju26-issue-2283` → **Standard** → **Verificar** (o **Verificar de nuevo**).

Se usan `gemini-4-hydrogen`, `gemini-4-carbon` y `nemotron-3.5-super-vl`; los identificadores y el endpoint son configurables. `KATSE_THINKING_LEVEL=low` mantiene acotada la latencia de Gemini. [Control de razonamiento de Gemini](https://aistudio.google.com/docs/thinking). Nemotron utiliza `chat_template_kwargs.enable_thinking=false` para propuestas JSON breves; `KATSE_VERDA_THINKING=true` lo activa explícitamente. Las sesiones de propuesta se vinculan a sus commits locales con `entire session attach`; el informe distingue propuesta del modelo y aplicación por el orquestador. El perfil está adaptado a la versión fijada de OpenCode; no se debe copiar una configuración v2 en una instalación v1 sin comprobar compatibilidad.

### Entrada y ejecución

`POST /api/projects/:id/verify` sigue admitiendo `{ "pr": "in:ju26-issue-2283", "options": { "mode": "completo" } }`.

También admite referencias sin PR:

```json
{
  "baseRef": "rama-destino",
  "proposedRef": "rama-propuesta",
  "requirement": "Comportamiento que el cambio debe cumplir",
  "options": { "mode": "completo", "profile": "standard" }
}
```

Los perfiles son Quick (90 s / 25.000 tokens presupuestados), Standard (300 s / 100.000) y Deep (900 s / 250.000). Standard es el predeterminado. Dos modelos y un runner como máximo. El límite de tokens reserva capacidad antes de cada llamada, incluye reintentos y reconcilia el uso informado por el proveedor. La tokenización y el contexto interno de OpenCode se estiman: no se promete un techo exacto de facturación. El consumo desconocido conserva su reserva y se muestra como incompleto. Cada petición limita la salida del modelo. Al agotarse un límite se conserva evidencia parcial.

1. Fija hashes y fuentes; compila y ejecuta la suite relevante y reproducciones rojo→verde. Mutaciones y retirada de grupos se reservan para Deep.
2. Hydrogen reconstruye un contrato breve. Se verifican citas literales; Carbon audita contrato y evidencia al final. Roslyn localiza símbolos y referencias. Se declaran los límites del análisis parcial.
3. Standard genera dos propuestas independientes desde la base con Hydrogen y Nemotron. Los modelos reciben el ticket y bloques previos del código alrededor del cambio y de expresiones citadas en el requisito; devuelven ediciones literales; el backend comprueba rutas y coincidencias únicas antes de aplicarlas. Sin herramientas de lectura ni edición para el modelo. No se recupera un prompt histórico inexistente.
4. Los constructores intercambian decisiones y parches candidatos, sin ver el original. Una ronda produce fortalezas, riesgos y escenarios; otra puede rectificar tras las ejecuciones. El intercambio no constituye evidencia ni votos. Tras la construcción concurrente se eliminan árboles duplicados antes de volver a ejecutar pruebas; sus sesiones se conservan para auditoría.
5. Los ataques reciben esas hipótesis y producen escenarios ejecutables. Standard valida estructura y fuentes localmente; Deep añade defensa semántica. El juicio final puede invalidar pruebas. Se ejecutan suites sobre el original y candidatos mientras quede presupuesto, y se reproducen fallos del original contra la base.
6. El juez determina **Pedir cambios**, **Evidencia insuficiente** o **Lista para aprobación humana**, siempre sobre el original. Un fallo exclusivo de una alternativa y un checkpoint ausente son advertencias de auditoría, no defectos del original.

La nota 0–10 es una rúbrica heurística: contrato 4, regresiones 3, grupos de riesgo comprobados 2 y reproducibilidad 1. No es probabilidad de ausencia de bugs. Sin ejecución no hay nota; un incumplimiento crítico confirmado limita la nota a 2, crítico pendiente a 5, revisión incompleta a 7. El perfil no reduce las exigencias del contrato. La firma vincula commit, contrato, informe y artefactos.

**Continuar investigando** (`POST /api/projects/:id/runs/:run/continue`, `{ "profile": "deep" }`) abre un nuevo expediente enlazado. Verifica integridad y hashes de código/base/requisito, conserva contrato, escenarios y parches verificados; vuelve a ejecutar las pruebas para observar el entorno actual. Separa consumo heredado del de la nueva ejecución. Los ataques invalidados por el juez no se vuelven a admitir automáticamente. Un cambio de requisito o commit exige revisión nueva.

La disponibilidad se comprueba con reintento acotado y caché de cinco minutos para resultados correctos. Si Verda no responde, el flujo puede usar Hydrogen en su lugar y registra la sustitución; ya no representa diversidad entre familias de modelos. Si falta Entire, se registra la captura pendiente sin bloquear los tests.

Gemini Decisions, Gemma local y entire-graph aún no forman parte del flujo. No se ofrece una garantía de anonimización de código privado. El alcance de ejecución local se limita al repositorio público de Tieto.

### Evidencia y comprobación

Cada ejecución conserva en `data/runs/<proyecto>/<run>/artifacts` el contrato, parches, sesiones, checkpoints, tests, TRX, comandos, resultados, presupuesto y veredicto. `GET /api/projects/:id/runs/:run/artifact?name=pipeline.json` expone el expediente, y `/report` el informe Markdown. Los nuevos eventos son `contract`, `candidate`, `debate`, `attack`, `result` y `judgment`.

- `npm test`: pruebas del orquestador, límites, caché, evidencia, formato inválido, cuota, duplicados y firmas.
- `npm run test:controls`: ejecuta sobre #2283 una **regresión preparada** y una **acusación falsa preparada**; se etiquetan como controles, no como descubrimientos de la IA.
- `npm run evaluate -- <run-id> 240000`: compara revisión directa y reconstrucción con el mismo presupuesto y contrato. Guarda tokens, duración, tests ejecutados y hallazgos pendientes de validación. Un caso aislado no permite afirmar que una estrategia sea superior.

Las copias locales de Windows y las restricciones de herramientas no son un sandbox del sistema operativo. El runner ejecuta código del repositorio; este MVP está preparado para el repositorio de Tieto. La compilación y las copias se hacen bajo `%TEMP%/katse` para reducir la carga de OneDrive; los informes permanecen en `data/`. Se conservan copias y checkpoints locales para auditoría. La caché .NET exige también los hashes de las dependencias efectivamente restauradas. Entire aporta procedencia, no garantiza que el código sea correcto. Se extraen solo mensajes de usuario de la transcripción, nunca se interpreta todo `checkpoint explain` como el prompt original. [Integración de Entire](https://docs.entire.com/agents/opencode).

`entire-graph` es opcional y no es una dependencia de este MVP: el análisis local funciona con Roslyn. No se consulta ningún grafo de la propuesta desde los constructores.

## Validación del flujo optimizado (14/11/2026)

- `npm test`: **76/76** pruebas superadas. Los controles .NET preparados detectan la regresión y descartan la acusación falsa.
- Última ejecución Standard: `ju26-issue-2283-mwg81iv6`, **4 min 30 s / 33.332 tokens comunicados**, dentro de 300 s / 100.000 presupuestados. Las 170 pruebas existentes y el nuevo escenario adversarial pasan en el original; se conservan las tres reproducciones rojo→verde.
- Dos alternativas distintas, dos checkpoints reales de Entire y una ronda de debate entre sus autores. El ataque comprueba un `readonly struct` genérico nullable de dos parámetros desde otro ensamblado. Carbon valida el escenario y las fuentes.
- Resultado del original: **7/10, listo para aprobación humana dentro del alcance declarado**. La nota es una rúbrica, no un porcentaje de fiabilidad. No se confirmó ningún defecto del original. C1 falla una regresión existente y C2 no termina su suite dentro de la fase de ejecución; ninguna alternativa se presenta como sustituto validado.
- Verda agotó dos comprobaciones de conexión. Esta ejecución usó Hydrogen como sustituto explícito y Carbon como juez: no demuestra diversidad entre familias de modelos. Nemotron respondió en ejecuciones anteriores, pero su disponibilidad externa no está garantizada.
- Continuación real comprobada en `ju26-issue-2283-mwg7bskq`: reutilizó contrato/parche de C1, mantuvo trazabilidad y separó 11.379 tokens nuevos de 26.503 heredados; volvió a ejecutar los tests.
- Pendiente de validación tras esta optimización: una ejecución Deep completa, ampliar riesgos y repetición independiente, estabilidad de Verda y demostrar con presupuestos iguales que la reconstrucción aporta más que revisar el diff. Standard reduce alcance respecto al histórico de 13 minutos; los tiempos no son una comparación de cobertura equivalente.

## Medición histórica previa a la optimización (14/11/2026)

- 27 pruebas del backend superadas. Los controles preparados detectan una regresión deliberada y descartan una acusación falsa mediante ejecución real.
- Recorrido desde la web de #2283: 13 min 3 s; suite original de 170 tests correctos; tres reproducciones rojo→verde; tres de cuatro mutantes detectados. Cuatro propuestas produjeron tres alternativas distintas, con tres checkpoints reales de Entire; la cuarta era un duplicado.
- Resultado: **Evidencia insuficiente**. Una alternativa introduce fallos que el original no presenta. Quedan ataques inválidos/disputados, una validación de candidato agotó su fase y existe una ambigüedad sobre diagnósticos de miembros de tipos externos. El expediente quedó pendiente; un error exclusivo de un candidato no demuestra un defecto del original.
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
