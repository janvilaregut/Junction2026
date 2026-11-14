# Katse

**No lo leas: reprodúcelo.** Katse verifica pull requests escritos por agentes con evidencia que se puede ejecutar, y deja a una persona con nombre solo lo que no se pudo comprobar.

Proyecto para Junction 2026 · reto *Earned Trust in AI Code* (Tieto) y *Best Use of Entire* (MLH).
El concepto completo está en [PLANNING.md](PLANNING.md) y en la carpeta [concept/](concept/).

## Qué hace

Eliges un repositorio. Katse te enseña sus pull requests: los que **recibes** (ramas remotas) y los que vas a **enviar** (tus ramas locales). Pulsas **Verificar** y, en una copia aislada del repo:

| Nivel | Qué hace | Usa IA |
|---|---|---|
| 1 · Determinista | Clasifica cada fichero. En los derivados (snapshots, código generado) detecta el mismo cambio repetido y aísla el que cambia distinto | No |
| 2 · Conductual | Mezcla sobre la base, compila, pasa la suite. Comprueba que los tests nuevos **fallan sin el cambio y pasan con él**. Siembra defectos en las líneas cambiadas y mira si algún test los detecta. **Rebobina**: quita cada cambio de uno en uno y mira si algún test lo nota | No |
| 3 · Generativa | Varios agentes rehacen el cambio **a ciegas** desde el requisito. Cuántos: `mín(6, 1 + grupos de cambios + grupos de alto riesgo)`, cada uno con una misión distinta. Compara zona a zona y cruza los tests: los del PR contra cada réplica y los de cada réplica contra el PR | Sí |

Con eso da una **recomendación** (pedir cambios, evidencia insuficiente o lista para aprobación humana) y decide un **carril** mediante reglas que se pueden leer (no hay puntuación):

`Reproducido` · `Solo residuo` · `Decides tú` · `Lectura completa` · `Devolver`

El informe dice **qué se comprobó** (con su evidencia), **qué no se comprobó y por qué**, **qué se negó a decidir** y **qué líneas tiene que leer una persona**. Esa persona responde, escribe el riesgo que acepta y firma. Katse nunca aprueba ni hace merge.

## Arrancar

Requisitos: Node 20 o superior y git. Para los tests del repo de ejemplo, .NET SDK 8 (Katse lo busca en `~/.dotnet` y en el `PATH`).

```bash
npm start
```

Abre http://localhost:4173. La primera vez registra el repo de ejemplo si existe en `workspace/messagepack-csharp`. Para usar otro, pulsa **+** y escribe la ruta de un repo local o una URL para clonarlo.

Desde la terminal:

```bash
node server/cli.js workspace/messagepack-csharp ju26-issue-2283
```

```bash
node server/cli.js workspace/messagepack-csharp ju26-issue-2283 --completo
```

`--completo` lanza las réplicas. Otras opciones: `--mutantes N`, `--agentes glm-5.3-flash,claude-sonnet`, `--base rama`.

## Agentes para las réplicas

Katse usa los CLIs de agentes que encuentre instalados y con sesión iniciada:

- **opencode** (`opencode run`): aparecen todos sus modelos `opencode/*`. Los gratuitos tienen una cuota pequeña por modelo; un PR sobre un repo grande la puede agotar.
- **Claude Code** (`claude -p`): necesita sesión iniciada con `claude auth login`.

Antes de empezar se comprueba que cada agente responde. Una réplica solo cuenta si cambia código de producto, compila y pasa sus propios tests; las demás aparecen en el informe con el motivo por el que se descartaron.

Conviene mezclar modelos de familias distintas: si todas las réplicas salen del mismo modelo, comparten los mismos puntos ciegos, y el informe lo avisa.

Los agentes corren dentro del sandbox de macOS (`sandbox-exec`): no pueden leer ni escribir tu repositorio, las demás verificaciones ni los ficheros de Katse. En otros sistemas trabajan en una copia sin historial y el informe avisa de que no hay sandbox.

## Procedencia: el prompt de cada commit (Entire)

Si el repo tiene [Entire](https://entire.io) activo, cada commit hecho con un agente lleva el trailer `Entire-Checkpoint`. Katse lee esa sesión con `entire checkpoint explain` y da a las réplicas **el mismo prompt** que recibió el autor. Sin Entire usa el texto de la issue y lo marca en el informe como menos confianza.

```bash
brew install --cask entireio/tap/entire
```

```bash
entire enable
```

## Estructura

```
server/
  index.js            servidor HTTP: interfaz, API y eventos en vivo (solo localhost)
  cli.js              verificación desde la terminal
  projects.js         proyectos y descubrimiento de PRs (ramas por delante de la base)
  requirements.js     requisito (issue) y procedencia (Entire)
  runs.js             registro de verificaciones
  ledger.js           libro de confianza: firmas, escapes, confianza por área, medidas
  report.js           informe en Markdown, líneas de firma y respuestas del asistente
  llm.js              llamadas a modelos (solo para redactar, nunca para decidir)
  pipeline/
    run.js            orquestador de las etapas
    classify.js       nivel 1: tipos de fichero y cambios mecánicos
    toolchain.js      compilar y pasar tests (.NET, Node, Python o comandos propios)
    sandbox.js        copias aisladas: worktrees y copias sin historial para las réplicas
    mutation.js       defectos sembrados
    replicas.js       nivel 3: agentes a ciegas
    compare.js        comparación PR ↔ réplicas por zonas
    judge.js          redacta lo que la IA se niega a decidir
    lanes.js          reglas de riesgo → carril, residuo, preguntas, no comprobado
mvp/                  interfaz (HTML, CSS y JavaScript sin compilación)
data/                 resultados, evidencias y libro de confianza (no se versiona)
workspace/            repos clonados para probar (no se versiona)
```

## Principios que el código hace cumplir

- **La evidencia es ejecutable.** Cada afirmación del informe enlaza el registro o el parche que la respalda.
- **El consenso no aprueba.** Que las réplicas coincidan solo decide dónde mira la persona.
- **Negarse es un resultado.** El juez solo puede formular preguntas; no tiene veredicto de aprobación.
- **Antes de culpar al PR, se mira la base.** Si algo no compila o falla con el PR, se comprueba si ya fallaba sin él.
- **Lo no ejecutado se dice.** Un test que no se pudo ejecutar aparece como «no ejecutado», nunca como «pasa».
- **Firma una persona.** La firma exige responder cada pregunta, confirmar lo leído y escribir el riesgo aceptado.
- **Tu repositorio no se toca.** Todo ocurre en copias temporales. La única escritura opcional es adjuntar el informe como `git notes`, y solo si lo pides.

## Límites conocidos

- Las réplicas corren en tu máquina. En macOS van dentro de `sandbox-exec` con el repositorio original vetado, pero conservan acceso a la red (lo necesitan para hablar con el modelo). No es un contenedor.
- La comparación entre el PR y las réplicas es textual (por zonas y similitud de tokens). La equivalencia de comportamiento la dan los tests cruzados.
- Los defectos sembrados son operadores sencillos. Un mutante que sobrevive puede ser equivalente al original.
- Solo se ejecutan los proyectos de test afectados por el cambio.
- No hay benchmarks ni análisis de seguridad dedicado: aparece siempre en «no comprobado».
- La interfaz está en español. Los textos están en `mvp/app.js`, `server/pipeline/lanes.js` y `server/report.js`.
