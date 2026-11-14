# Katse

Valida cambios generados por IA mediante reconstrucción desde la base, ataques ejecutables y una decisión humana respaldada por evidencia. Proyecto para Junction 2026, reto Tieto «Earned Trust in AI Code».

## Última comprobación con NVIDIA (14/11/2026)

Verda respondió y Nemotron participó realmente, sin sustitución por Google. Actívalo en **Settings → Nemotron**; la selección se guarda en este ordenador. La prueba desde la web `ju26-issue-2283-mwgfnpkl` usó Standard sin ampliar límites (300 s / 100.000 tokens) y terminó en **4 min 29 s / 40.247 tokens informados**, sin consumo desconocido.

- **Original:** 171/171 tests correctos, incluido un ataque nuevo de Nemotron; tres casos rojo→verde de la referencia.
- **C2 / Nemotron:** propuesta en 15,0 s / 4.744 tokens; preparación y checkpoint en 40,1 s en total. Compiló y completó los 171 tests en otros 40,0 s: 170 correctos y un fallo, sin timeout. C1 tuvo el mismo balance.
- El fallo de las alternativas es `ClosedGenericStruct_FromMetadataReference_UnkeyedMember`: emiten dos diagnósticos MsgPack004 donde se esperan cero. El original supera ese test. Terminar una validación no significa que el candidato sea correcto.
- **Consumo por proveedor:** Nemotron 16.620; Hydrogen 18.217; Carbon 4.813; Decisions 597. Entire capturó ambos candidatos. La fórmula propuso cuatro alternativas y el presupuesto admitió dos.
- **Resultado:** 7/10, lista para aprobación humana dentro del alcance declarado. Un grupo de riesgo atacado; faltan más diversidad y repetición independiente. Una intervención final de C1 agotó su límite de salida y se muestra incompleta; C2 completó ambas rondas. Decisions respondió en 445 ms, pero sus propuestas no superaron el umbral de confianza y se aplicaron reglas deterministas.

Se corrigió el montaje del test: Katse añade el resolver atribuido en un árbol sintáctico separado, los agentes solo proponen el escenario. Los ataques priorizan expectativas críticas aún no comprobadas, sin convertir esa prioridad en cobertura. El reintento de formato recibe un motivo concreto y sigue limitado a uno. Validación: **101/101 tests de Katse**, una prueba .NET aislada del harness y la ejecución completa anterior.

Hubo tres ejecuciones de diagnóstico previas (44.686, 49.489 y 44.171 tokens); las cuatro revisiones suman **178.593 tokens informados**. No es el coste de una sola revisión. Los informes históricos se conservan. Gemma no se ejecutó: esta prueba usó la excepción del ejemplo público fijado de Tieto. La revisión privada con Gemma y una ejecución Deep con NVIDIA siguen pendientes. Mutación y retirada de cambios no se ejecutan en Standard.

## Arranque en otro ordenador con Gemma (Windows)

`main` reúne el panel de modelos y soporte de archivos nuevos de `ui-hud`, junto con el pipeline, la evidencia y la privacidad de `fabian`. Esta es la ruta para probar **#2283 con Gemma real**. Los informes y claves del ordenador de Fabián no se transfieren por Git.

1. Instala Git, Node 22.15+ (recomendado Node 24), el **SDK de .NET 8** compatible con `global.json` de Tieto (8.0.402) y [Ollama](https://ollama.com/download/windows). Abre otra terminal tras instalarlos. El modelo Gemma descarga unos 4,3 GB; deja memoria libre adicional para el modelo, .NET y la web. Usa una carpeta fuera de OneDrive para reducir esperas de disco.

2. Clona el repo, o actualiza tu copia existente en `main`:

   ```powershell
   git clone https://github.com/janvilaregut/Junction2026.git
   cd Junction2026
   git switch main
   git pull --ff-only origin main
   npm ci
   powershell -File scripts/setup-tools.ps1
   if (!(Test-Path .env.local)) { Copy-Item .env.example .env.local }
   ```

   Si ya tienes la carpeta, empieza con `cd` a tu copia, sin repetir `git clone`. Si Git detecta cambios locales, consérvalos antes de actualizar. `setup-tools.ps1` instala Entire; OpenCode viene con `npm ci`.

3. Edita `.env.local`. Rellena `GEMINI_API_KEY` con la clave del evento compartida por el equipo y, para probar NVIDIA, `VERDA_INFERENCE_KEY`. **No publiques este archivo ni las claves.** Mantén el resto de la plantilla y cambia:

   ```dotenv
   KATSE_PRIVACY_MODE=strict
   KATSE_GEMMA_URL=http://127.0.0.1:11434
   KATSE_GEMMA_MODEL=gemma4:e2b-it-qat
   KATSE_PRIVATE_TERMS=
   ```

   Añade a `KATSE_PRIVATE_TERMS` nombres internos separados por comas si hace falta. `strict` es necesario para probar Gemma sobre el ejemplo público; `auto` exime ese caso concreto. Ollama debe ejecutarse en **el mismo ordenador que el backend**: no se admiten endpoints externos.

4. Descarga y comprueba Gemma antes de iniciar la web:

   ```powershell
   powershell -File scripts/setup-gemma.ps1
   npm run check:privacy
   npm run check:decisions
   npm start
   ```

   `check:privacy` debe mostrar `status: passed`, `mode: strict` y fragmentos escaneados. Usa datos sintéticos y comprueba que Gemma detecta un nombre interno no incluido en las reglas; no llama a la nube. Si muestra `blocked`, revisa Ollama y `ollama list`. Si el modelo tarda en arrancar, precaliéntalo con `ollama run gemma4:e2b-it-qat "Reply OK"` y repite el chequeo. `check:decisions` sí hace una petición pequeña a Google; si falla, el pipeline puede seguir con reglas deterministas. `npm run doctor` es un diagnóstico opcional de proveedores y Entire, no un requisito de arranque; puede fallar si Verda no responde.

5. Abre **http://localhost:4173**. En el selector de proyecto elige **Or clone from a URL** e introduce `https://github.com/te-industry-tech-office/junction26-messagepack-csharp.git`. Katse crea tu copia local en `workspace/`. También puedes prepararla desde otra terminal con la web arrancada:

   ```powershell
   $project = Invoke-RestMethod http://localhost:4173/api/projects -Method Post -ContentType 'application/json' -Body (@{url='https://github.com/te-industry-tech-office/junction26-messagepack-csharp.git'} | ConvertTo-Json)
   Invoke-RestMethod "http://localhost:4173/api/projects/$($project.id)" -Method Patch -ContentType 'application/json' -Body (@{name='Tieto - MessagePack'; base='dependabot/nuget/develop/PolySharp-1.15.0'; issueRepo='MessagePack-CSharp/MessagePack-CSharp'} | ConvertTo-Json)
   ```

   Recarga la página, selecciona el proyecto y abre **#2283**. En el engranaje deja Hydrogen y Carbon activados. **Nemotron está desactivado por defecto**; actívalo solo para probar Verda. El informe registra cuándo se sustituye por Google. Las preferencias se guardan localmente, no en Git.

6. Ejecuta **Standard**. Para la primera prueba en otro equipo puedes usar el mismo perfil con diez minutos, sin subir su límite de 100.000 tokens, desde la terminal anterior (ejecuta primero los comandos del paso 5 para definir `$project`):

   ```powershell
   Invoke-RestMethod "http://localhost:4173/api/projects/$($project.id)/verify" -Method Post -ContentType 'application/json' -Body (@{pr='in:ju26-issue-2283'; options=@{mode='completo'; profile='standard'; budgetMs=600000; privacy='strict'}} | ConvertTo-Json -Depth 4)
   ```

   Elige una de las dos formas de iniciar la revisión; no lances ambas a la vez. Recargar la web recupera la ejecución. La primera compilación puede descargar dependencias. En **Review & sign → Local privacy gateway** confirma `strict` y `scannedChunks > 0`; revisa también pruebas del original, candidatos, límites y bloqueos. Los resultados quedan en `data/runs/` de ese equipo. Si modificas `.env.local`, reinicia `npm start`.

**Qué está validado y qué falta:** los tests automatizados verifican la integración y el bloqueo cuando falta Gemma; el #2283 ya se ejecutó con modelos de Google y checkpoints de Entire en modo público. **Falta validar la revisión privada completa con Gemma real en este otro ordenador.** En modo estricto se envía texto saneado directamente al proveedor: no hay captura nueva de Entire y se bloquean voz, consensus y chat auxiliares que aún no pasan por Gemma. La detección no garantiza anonimización perfecta. Si Gemma no responde o agota su presupuesto, no se envía el texto sin escanear ni se fuerza una nota aprobatoria.

## Backend completo: reconstrucción y ataques ejecutables

`main` incluye el pipeline v2 de `fabian` en `mode: completo`. Conserva la API, eventos y lectura de informes v1. El alcance ejecutable del MVP es Windows y C#/.NET, con el caso Tieto #2283.

### Preparación en Windows

1. Instala Node 22.15+ (probado con 24.19), Git y el SDK que indique el `global.json` del repositorio. #2283 usa .NET 8.0.402; Katse también detecta `%USERPROFILE%/.dotnet`.
2. Ejecuta `npm ci`. OpenCode queda fijado en 1.19.5.
3. Ejecuta `powershell -File scripts/setup-tools.ps1` para instalar Entire 0.13.4 con verificación SHA256. También puedes indicar `KATSE_ENTIRE_PATH`.
4. Copia `.env.example` a `.env.local` y rellena `GEMINI_API_KEY` y `VERDA_INFERENCE_KEY`. Este archivo está ignorado por Git. Las claves nunca se guardan en la configuración de OpenCode ni se pasan al runner .NET.
5. Ejecuta `npm run doctor`: verifica los modelos, JSON, herramientas y un checkpoint real de Entire. Consume llamadas reales a los proveedores.
6. Ejecuta `npm start` y abre `http://localhost:4173`. Abre la copia local de Tieto desde el selector de proyecto si aún no aparece. Pulsa el nodo **#2283**. Sin revisión previa, selecciona **Standard** y verifica; con una revisión guardada, abre **Review & sign → Standard** para ejecutarla de nuevo.

### Revisar la evidencia en la nueva interfaz

- **Versions** muestra alternativas, debate, ataques y resultados; **Replay** reproduce eventos guardados, sin ejecutar otra revisión. La coincidencia de regiones editadas solo ayuda a navegar: no demuestra equivalencia ni corrección.
- **Review & sign** contiene la rúbrica, bloqueos, contrato con citas, contraste solicitado/implementado, tests por versión con logs/TRX y fallos concretos, checkpoints/transcripciones de Entire y detalles de compilación, mutación y rewind. Los tests de una alternativa se distinguen de los del original.
- **Continue with Deep** reutiliza contrato, escenarios admitidos y parches conservados; vuelve a ejecutar pruebas y muestra consumo heredado y acumulado. Los checkpoints restaurados pertenecen a la sesión de origen, no a una nueva generación.
- Recargar y abrir de nuevo la rama recupera la ejecución activa y su tiempo transcurrido. Una revisión nueva oculta el veredicto anterior. Sin pruebas suficientes no hay nota ni aprobación automática.

Standard prepara su ataque final mientras termina la referencia .NET y reserva la conversación posterior para cuando las validaciones hayan terminado. No añade llamadas a modelos ni otro runner. Cinco minutos son un presupuesto, no una garantía de terminar en cualquier ordenador; una referencia lenta o falta de RAM puede dejar evidencia pendiente.

Prueba desde la interfaz del 14/11: `ju26-issue-2283-mwgcicms`, continuación Deep de `ju26-issue-2283-mwgcb08g`, terminó en **11 min 31 s / 88.907 tokens nuevos**. Original: 175 tests correctos, cinco ataques superados y tres reproducciones rojo→verde. C1: dos ataques focalizados correctos y un fallo en la suite de 175; C2: dos ataques focalizados correctos, sin suite completa en esta ejecución. Mutación: 3/4 detectados; rewind: un grupo retirable sin fallos. Ambos checkpoints originales se conservaron. Resultado **7/10, evidencia insuficiente**: el juez dejó E3 como interpretación pendiente. Dos intervenciones del debate inicial agotaron su tiempo; la ronda posterior terminó. Las propuestas descendientes no aportaron ediciones: después de observarlo, se corrigió su tratamiento para conservarlas como duplicado/sin cambios y evitar una reparación inútil. Esa corrección no altera el informe histórico.

El consumo informado de la continuación es parcial: suma 123.313 tokens conocidos incluyendo el intento heredado y conserva una reserva de 16.750 tokens por intentos sin uso confirmado. El intento Standard anterior agotó el tiempo de referencia y no recibió nota. Otro intento Standard de esta sesión pasó 171 tests del original pero dejó C2 pendiente. Estos casos demuestran la recuperación y los límites, no un tiempo garantizado. NVIDIA/Verda no estuvo disponible y se usó el sustituto Google, indicado en la web. Validación local del código: **86 tests correctos**.

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
3. La fórmula de complejidad propone de dos a cuatro alternativas; el presupuesto admite hasta dos en Standard y cuatro en Deep. Hydrogen y Nemotron reciben misiones asignadas a grupos concretos, el ticket y bloques previos del código alrededor del cambio y de expresiones citadas en el requisito; devuelven ediciones literales. El backend comprueba rutas y coincidencias únicas antes de aplicarlas. Sin herramientas de lectura ni edición para el modelo. No se recupera un prompt histórico inexistente.
4. Los constructores intercambian decisiones y parches candidatos, sin ver el original. Una ronda produce fortalezas, riesgos y escenarios; otra puede rectificar tras las ejecuciones. El intercambio no constituye evidencia ni votos. Tras la construcción concurrente se eliminan árboles duplicados antes de volver a ejecutar pruebas; sus sesiones se conservan para auditoría.
5. Los ataques reciben esas hipótesis y producen escenarios ejecutables. Standard valida estructura y fuentes localmente; Deep añade defensa semántica. El juicio final puede invalidar pruebas. Se ejecutan suites sobre el original y candidatos mientras quede presupuesto, y se reproducen fallos del original contra la base.
6. El juez determina **Pedir cambios**, **Evidencia insuficiente** o **Lista para aprobación humana**, siempre sobre el original. Un fallo exclusivo de una alternativa y un checkpoint ausente son advertencias de auditoría, no defectos del original.

La nota 0–10 es una rúbrica heurística: contrato 4, regresiones 3, grupos de riesgo comprobados 2 y reproducibilidad 1. No es probabilidad de ausencia de bugs. Sin ejecución no hay nota; un incumplimiento crítico confirmado limita la nota a 2, crítico pendiente a 5, revisión incompleta a 7. El perfil no reduce las exigencias del contrato. La firma vincula commit, contrato, informe y artefactos.

**Continuar investigando** (`POST /api/projects/:id/runs/:run/continue`, `{ "profile": "deep" }`) abre un nuevo expediente enlazado. Verifica integridad y hashes de código/base/requisito, conserva contrato, escenarios y parches verificados; vuelve a ejecutar las pruebas para observar el entorno actual. Separa consumo heredado del de la nueva ejecución. Los ataques invalidados por el juez no se vuelven a admitir automáticamente. Un cambio de requisito o commit exige revisión nueva.

La disponibilidad se comprueba con reintento acotado y caché de cinco minutos para resultados correctos. Si Verda no responde, el flujo puede usar Hydrogen en su lugar y registra la sustitución; ya no representa diversidad entre familias de modelos. Si falta Entire, se registra la captura pendiente sin bloquear los tests.

### Asignación adaptativa, Decisions y privacidad local

El orquestador es código que controla colas, presupuestos, hashes y admisión de pruebas. Los modelos proponen decisiones y Carbon interpreta el expediente final; ningún modelo puede saltarse las comprobaciones. No hay un superagente con autoridad ilimitada.

- Demanda inicial: `min(4, 2 + ceil(log2(G)) + H)`, con cero alternativas si no hay grupos ejecutables. `G` son grupos de comportamiento y `H` los de alto impacto. Se acota por perfil, tiempo para construir **y probar**, y tokens disponibles. La estimación inicial reserva 60 s y 18.000 tokens para trabajo restante; es una heurística, no una garantía de coste.
- Asignación: `R*(1+U+D)/(C*(1+N))`. Cada reserva incrementa `N` antes de lanzar la tarea concurrente. El constructor recibe el grupo, símbolo, expectativas y misión; ya no es solo una cifra del informe. `C` se actualiza con tiempos observados y solo las pruebas superadas respaldan expectativas. Deep admite hasta dos descendientes si quedan dudas y presupuesto, seis candidatos como máximo.
- [Gemini Decisions](https://codelabs.developers.google.com/codelabs/discriminative-models): una petición agrupada a `gemini-decision-1` elige entre `repair`, `preserve` y `boundary`, con 3,5 s de plazo y sin reintento. Solo se adopta una elección válida con confianza >= 0,8; el resto usa reglas por riesgo. El umbral también es heurístico. No decide el veredicto, no puntúa la confianza del PR y no omite pruebas. Si no hay candidatos admitidos, no se llama. La petición también pasa por privacidad y contabiliza tokens.
- La web muestra demanda/admisión, límites efectivos, misión de cada candidato y respuesta de Decisions. `allocation.json` conserva la asignación y las observaciones finales.

**Gemma en el otro ordenador:** instala [Ollama para Windows](https://docs.ollama.com/windows), abre una nueva terminal en este repositorio y ejecuta:

```powershell
powershell -File scripts/setup-gemma.ps1
npm run check:privacy
```

El script descarga [`gemma4:e2b-it-qat`](https://ollama.com/library/gemma4/tags), comprueba el servidor local y ejecuta una prueba sintética de detección y restauración, sin enviar datos a la nube. El modelo ocupa unos 4,3 GB de descarga; la memoria necesaria para ejecutarlo es adicional. Configura en `.env.local`:

```dotenv
KATSE_PRIVACY_MODE=strict
KATSE_GEMMA_URL=http://127.0.0.1:11434
KATSE_GEMMA_MODEL=gemma4:e2b-it-qat
KATSE_PRIVATE_TERMS=NombreInterno,ClientePrivado,dominio.interno
```

Reinicia `npm start` tras cambiar la configuración. `strict` permite probar también el #2283 a través de Gemma. Con `auto`, únicamente el commit público #2283 y su base fijada quedan exentos de Gemma; un requisito propio o una transcripción de Entire exige modo estricto. La exención se indica en el informe.

El gateway combina reglas para secretos y datos personales, un diccionario explícito y detección de nombres internos con Gemma. Sustituye coincidencias por alias estables; restaura las ediciones **localmente** antes de validarlas. Solo admite un endpoint de loopback, bloquea respuestas incompletas o inciertas, usa caché y limita los escaneos a 45 s por revisión y 12 s por fragmento, siempre dentro del plazo de la revisión. Si el ordenador no mantiene ese ritmo, conserva evidencia pendiente en vez de enviar texto sin escanear. La detección sigue siendo probabilística: no garantiza anonimización completa.

**Límite de integración:** la protección cubre las llamadas del pipeline v2 (`mode: completo`). En modo estricto se usa transporte directo de texto saneado, sin OpenCode ni herramientas que puedan añadir contexto del repositorio. Eso implica que **no hay captura nueva de Entire para esos candidatos**; quedan sus artefactos y commits locales. El ejemplo público sigue usando OpenCode y checkpoints reales de Entire. Los módulos antiguos de voz/live, consensus y chat auxiliar no están cubiertos por este gateway: quedan bloqueados al configurar `KATSE_PRIVACY_MODE=strict`. El chat de un informe v2 privado también se bloquea aunque el servidor esté en `auto`. Para trabajar con información privada configura el servidor entero en `strict`. `entire-graph` sigue pendiente.

Validación del 14/11: 97 tests automatizados correctos. Una llamada real a Decisions respondió en 1,06 s / 592 tokens dentro del #2283; sus tres elecciones quedaron por debajo de 0,8 y se mantuvieron las reglas deterministas. El transporte directo de Gemini respondió a una prueba sintética en 1,79 s. Gemma **no se ha ejecutado realmente en este ordenador** por falta de recursos: se verificaron el bloqueo sin modelo y la integración con respuestas simuladas. La ejecución privada completa necesita validación en el otro equipo.

Comprobación histórica anterior a la recuperación de Verda: `ju26-issue-2283-mwgdn6hs`, perfil Standard con presupuesto temporal ampliado explícitamente a 600 s, terminó en **5 min 12 s / 43.598 tokens**, sin consumo desconocido. Demanda 4, admitidos 2. Original: 171 tests correctos y tres reproducciones rojo→verde. C1 y C2: 170 correctos y un fallo cada uno; ambos completaron la suite y tienen checkpoints reales. Resultado **7/10, lista para aprobación humana dentro del alcance declarado**, sin fallos confirmados en el original; falta más diversidad de ataques y repetición independiente. Mutación/retirada de cambios no se ejecutan en Standard. Verda agotó el timeout y se sustituyó por Hydrogen, por lo que esta ejecución no demuestra diversidad entre familias. Esta medición no demuestra que el perfil predeterminado de 300 s complete siempre.

### Evidencia y comprobación

Cada ejecución conserva en `data/runs/<proyecto>/<run>/artifacts` el contrato, parches, sesiones, checkpoints, tests, TRX, comandos, resultados, presupuesto y veredicto. `GET /api/projects/:id/runs/:run/artifact?name=pipeline.json` expone el expediente, y `/report` el informe Markdown. Los nuevos eventos son `contract`, `candidate`, `debate`, `attack`, `result` y `judgment`.

- `npm test`: pruebas del orquestador, límites, caché, evidencia, formato inválido, cuota, duplicados y firmas.
- `npm run test:controls`: ejecuta sobre #2283 una **regresión preparada** y una **acusación falsa preparada**; se etiquetan como controles, no como descubrimientos de la IA.
- `npm run evaluate -- <run-id> 240000`: compara revisión directa y reconstrucción con el mismo presupuesto y contrato. Guarda tokens, duración, tests ejecutados y hallazgos pendientes de validación. Un caso aislado no permite afirmar que una estrategia sea superior.

Las copias locales de Windows y las restricciones de herramientas no son un sandbox del sistema operativo. El runner ejecuta código del repositorio; este MVP está preparado para el repositorio de Tieto. La compilación y las copias se hacen bajo `%TEMP%/katse` para reducir la carga de OneDrive; los informes permanecen en `data/`. Se conservan copias y checkpoints locales para auditoría. La caché .NET exige también los hashes de las dependencias efectivamente restauradas. Entire aporta procedencia, no garantiza que el código sea correcto. Se extraen solo mensajes de usuario de la transcripción, nunca se interpreta todo `checkpoint explain` como el prompt original. [Integración de Entire](https://docs.entire.com/agents/opencode).

`entire-graph` es opcional y no es una dependencia de este MVP: el análisis local funciona con Roslyn. No se consulta ningún grafo de la propuesta desde los constructores.

## Contraste entre encargo e implementación

El contrato sigue saliendo del ticket, tests anteriores y mensajes originales de Entire cuando existen. Los constructores no reciben el parche propuesto ni la interpretación del juez. La llamada final ya existente a Carbon contrasta ese contrato con un extracto acotado del diff original: no se añade una ronda de modelos ni se amplía el límite de cinco minutos de Standard. El máximo de salida del juez pasa de 2.500 a 6.000 tokens, incluyendo razonamiento interno; se compactan sus fuentes y resultados para reducir consumo efectivo; el diff añadido se limita a 6.000 caracteres y la truncación queda registrada. Se acortan las intervenciones del debate para reducir respuestas truncadas.

El informe y la web muestran, por expectativa, lo solicitado, la implementación interpretada, citas literales comprobadas y preguntas pendientes. `intent-comparison.json` vincula contrato, base, commit y hash del parche completo `original-change.patch`; ambos forman parte del manifiesto de integridad. Una coincidencia no añade puntos, una posible desviación no confirma un bug y una interpretación ausente o sin citas válidas queda pendiente. Las citas acreditan procedencia textual, no garantizan la interpretación semántica del modelo. Los tests siguen decidiendo el soporte ejecutable. Las nuevas preguntas del juez final se muestran para revisión; no disparan automáticamente otra generación de pruebas en esta ejecución.

Entire separa mensajes del original y checkpoints de candidatos. En #2283 no hay mensajes originales registrados: no se presenta una descripción inferida como un prompt recuperado. Este contraste se inspira en [Round-Trip Correctness, Allamanis et al., ICML 2024](https://proceedings.mlr.press/v235/allamanis24a.html); no implementa su benchmark ni presenta una equivalencia funcional demostrada. La comparación con revisión directa sigue siendo necesaria para medir valor adicional.

Validación final desde la API: `ju26-issue-2283-mwgbdpvz`, **3 min 49 s / 42.365 tokens**, sin ampliar Standard ni añadir llamadas al juez. Frente al registro previo de 4 min 31 s / 40.859 tokens, esta ejecución usa ~3,7 % más tokens; los tiempos varían con compilación, caché y modelos y no son un benchmark controlado. Las tres expectativas tienen contraste con citas verificadas. Original: 171 tests correctos y tres casos rojo→verde; C1 y C2: 171 tests ejecutados por versión, un fallo de regresión existente cada una, sin timeout. Dos checkpoints reales de Entire. Resultado: **7/10, listo para aprobación humana en el alcance declarado**, sin defectos confirmados del original. Una intervención posterior de C1 se truncó; la ronda inicial, la ejecución de ambas alternativas y el juez sí terminaron. No se interpreta esa intervención ausente como una aprobación.

`npm test`: **81/81**. Se verifican citas inventadas, filas ausentes o duplicadas, diferencias entre procedencia original y candidatos, vinculación de hashes y ausencia de puntos por coincidencia. El primer intento del juez agotó 3.200 tokens en razonamiento; queda conservado como evidencia insuficiente. La llamada ajustada se comprobó primero con evidencia guardada y después en la ejecución completa anterior. El diagnóstico autenticado de Verda volvió a agotar catálogo e inferencia mínima; el flujo final registra Google como sustituto. No se ha validado Nemotron en esta ejecución.

## Corrección del tiempo de C2 y diagnóstico de Verda (14/11/2026)

La captura de las propuestas se vincula después de la sesión mediante `entire session attach`. En las copias desechables se conserva el plugin generado fuera de las rutas de carga automática: la importación explícita evita cargarlo también durante la exportación de OpenCode. Los debates usan una copia de revisión sin hooks y solo el contexto suministrado. [Adjuntar sesiones existentes en Entire](https://docs.entire.com/cli-reference/session).

La fase de tests reserva ahora 30 segundos para el informe, manteniendo Standard en cinco minutos. Una validación de candidato incompleta queda explícitamente pendiente. Se registran los tiempos anteriores al primer evento de ejecución de OpenCode y la duración de sus pasos observados.

Validación real `ju26-issue-2283-mwg90r70`: **4 min 31 s, 40.859 tokens, 171 tests por versión**. El original pasa; C1 y C2 completan la suite y fallan un test cada uno. Ambos conservan checkpoints de Entire. La preparación de cada candidato fue de unos 38 segundos frente a unos 77 en la ejecución anterior. Resultado: **5/10, evidencia insuficiente** porque E2 no quedó asociado a una prueba admitida. Una respuesta de la ronda posterior del debate se truncó; la ejecución de tests de C2 sí terminó. La puntuación no se fuerza para que el demo aparezca aprobado.

**Diagnóstico histórico, anterior a la recuperación documentada al inicio: Verda no respondía con las credenciales recibidas.** URL y modelo coinciden con las instrucciones del evento. GET /models y POST /chat/completions autenticados agotan el plazo, también mediante comprobaciones fuera de OpenCode; una comprobación larga agotó 90 segundos. Las peticiones sin clave y con una clave deliberadamente inválida devuelven HTTP 404 rápidamente. Esto no permite confirmar el estado del despliegue ni de la autenticación sin una respuesta del proveedor. No se ha cambiado de endpoint ni se afirma que Nemotron esté arreglado. La web muestra la sustitución por Google.

`npm run check:verda` reproduce el diagnóstico sin enviar código y guarda un JSON sin credenciales en `data/diagnostics`. `-- --timeout=90000` amplía cada comprobación hasta 90 segundos. El comando devuelve un código de error mientras catálogo e inferencia no estén disponibles.

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

## Pasada matemática y grafo de dependencias

Al abrir una rama, antes de cualquier agente, Katse lee los dos lados del cambio desde objetos git y establece para cada función tocada lo que se puede saber **sin IA y sin ejecutar nada** (≈ 1 s en el repositorio del reto). El resultado es el grafo de dependencias de la rama: el **tamaño** de una bolita es cuánto código depende de ella y el **color** es lo que la matemática puede afirmar.

| Color | Qué afirma | Base |
|---|---|---|
| Demostrado (anillo) | La edición no puede cambiar el comportamiento | Mismos tokens (solo comentarios y formato) o renombrado de locales sin captura; `server/math/proof.js` |
| Despejado | Nada marcado. No es una prueba | Cambio pequeño, medidas bajo umbral, un test escrito con el cambio la alcanza |
| Incierto | El comportamiento cambió y la matemática no puede avalarlo | Estado por defecto de lo que cambia de verdad |
| Arriesgado | Falló una comprobación determinista, o cambio grande, complejo y sin tests | `checks.js` (imports, aridad, referencias colgantes, tests borrados, secretos) y `risk.js` |

Lo que queda abierto va a los agentes **de función en función** (`server/math/nodereview.js`, unos 15 s): tres agentes la reconstruyen a ciegas desde el requisito, la comparación con la versión del PR es exacta (tokens, renombrado, similitud) y un juez solo puede dar una diferencia por válida si cita literalmente la frase del requisito que la decide; la cita se comprueba con una búsqueda de texto. Gemini Decisions puede subir el impacto de una bolita y dejar una revisión abierta; nunca baja el impacto ni cierra nada.

```bash
npm run math:selftest          # ataca el certificado: muta funciones reales y cuenta qué se certifica (debe ser 0)
npm run math:selftest -- workspace/messagepack-csharp origin/ju26-issue-2283
```

Medido el 14/11/2026: 0 de 14.538 ediciones que cambian el comportamiento certificadas sobre este repositorio y 0 de 6.314 sobre el de C# (cota superior al 95 %: 0,021 % y 0,047 %); en el PR de 237 ficheros (#2297) quedan 55 de 1.307 líneas por mirar; en la demo `demo-consenso`, `pr-con-fallo`, «Review all» revisa las 4 funciones abiertas en 25 s y marca en rojo `cartTotal` y `couponDiscount` con la entrada concreta, la regla citada y el arreglo.

Límites: «demostrado» solo cubre ediciones sin efecto; el grafo se construye por nombres, sin inferencia de tipos (no ve reflexión ni tests que pasan por un framework); la exposición ordena y no es una probabilidad (pesos de la literatura, no ajustados a este repositorio); la revisión por función no compila ni ejecuta, eso sigue siendo la revisión completa.

Rutas: `GET /api/projects/:id/math?pr=…` (la pasada), `POST /api/projects/:id/math/review` (agentes para una bolita), `POST /api/projects/:id/math/mark` (marcar una bolita como leída). Interfaz en `mvp/math.js` y `mvp/review.js`.

## Archivos principales

- `server/pipeline/complete.js`: presupuesto, generaciones y juicio final.
- `server/agents.js`: proveedores, sesiones independientes de OpenCode y checkpoints Entire.
- `server/pipeline/contract.js` y `tools/Katse.Analyze`: fuentes, expectativas y análisis Roslyn.
- `server/pipeline/evidence.js`: runner, caché, selección y reglas del veredicto.
- `server/pipeline/messagepack-harness.js`: adaptador de escenarios del caso #2283; los modelos eligen inputs y expectativas y el adaptador genera la infraestructura repetitiva de los tests.
- `server/integrity.js`: manifiesto de artefactos y validación de firmas.
- `mvp/`: interfaz existente, ampliada para mostrar los datos v2.

La verificación rápida sigue disponible. Desde terminal: `node server/cli.js workspace/messagepack-csharp ju26-issue-2283 --completo`. Los modelos del pipeline completo se configuran por variables o `options.providers`, no mediante la antigua selección de réplicas del modo rápido.

## Consenso multi-agente (Gemini)

Una segunda forma de verificar, más rápida de montar: **varios agentes resuelven el mismo prompt a ciegas y debaten hasta ponerse de acuerdo**.

1. **Resolver.** 5 variaciones de `gemini-4-carbon` (distinta temperatura, topP, topK y nivel de razonamiento) reciben el requisito: el prompt que escribas o, si no, los mensajes de commit. Cada una trabaja en su propia copia del repo con un pequeño arnés de herramientas (leer, buscar, editar, pasar tests). Un sexto agente defiende el PR real.
2. **Comparar.** Mapa de calor zona a zona: en cada trozo del código, quién escribió lo mismo, quién algo distinto y quién lo dejó igual.
3. **Debatir.** Por parejas, del grupo más grande al más pequeño y empezando por las parejas más distintas. Cada uno defiende su solución y señala fallos concretos de la otra. Quien convence al otro absorbe su grupo y pasa a la siguiente ronda. Si son equivalentes, se fusionan.
4. **Veredicto.** `coincide` si el PR acaba en el grupo mayoritario, `difiere` si no (con los problemas concretos y la solución del consenso) y `dudoso` si hay empate o no hay mayoría.

La clave va en `.env` (no se versiona):

```bash
echo 'GEMINI_API_KEY=tu-clave' > .env
```

Interfaz en vivo con burbujas: http://localhost:4173/consenso.html. Desde la terminal:

```bash
npm run consenso -- workspace/demo-consenso pr-con-fallo --base main
```

Antes de hacer push de tu rama (sale con código 1 si el consenso no la respalda):

```bash
node server/consensus/cli.js . "$(git branch --show-current)"
```

API: `POST /api/consenso {repo, branch, base?, prompt?, agents?}` → `{id}`; `GET /api/consenso/:id/events` (SSE). El código está en `server/consensus/`.
