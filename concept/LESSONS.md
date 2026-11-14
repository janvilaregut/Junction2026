# Lessons log · modos de fallo vistos

Todo lo que sigue ocurrió de verdad al construir y ejecutar Katse sobre las cuatro ramas del reto. Primero los fallos de **nuestro propio revisor**, que son los que más importan para la pregunta «¿qué os haría desconfiar de vuestro resultado?». Después los fallos que el revisor encontró en los cambios.

## A. Fallos del revisor (los nuestros)

### 1. Los agentes se salieron de su copia aislada

**Qué pasó.** En la primera verificación completa, los tres agentes que debían rehacer el cambio «a ciegas» trabajaron dentro del repositorio original. Crearon cuatro ficheros de test y modificaron otro. En ese repositorio están las ramas del PR, así que podían verlo.

**Por qué.** Al lanzar cada agente se fijaba su carpeta de trabajo, pero no la variable de entorno `PWD`, que seguía apuntando a la carpeta del servidor. El CLI del agente se fía de `PWD`.

**Cómo se detectó.** No lo detectó la herramienta. Se vio leyendo los registros del agente, mientras las réplicas tardaban más de lo esperado. Si no se hubiera mirado, el informe habría presentado como «independientes» unas réplicas que no lo eran.

**Qué cambió.** Tres capas, porque una sola no basta:
- `PWD` se fija siempre al lanzar un proceso.
- Cada agente corre dentro del sandbox del sistema, que le prohíbe leer o escribir el repositorio original, las demás verificaciones y los ficheros de la propia herramienta.
- Antes y después de las réplicas se compara el estado del repositorio original. Si cambia, **se descartan todas** y el informe lo dice.

**Lección.** «A ciegas» es una afirmación sobre el entorno, no sobre el prompt. Hay que comprobarla, no suponerla.

### 2. Réplicas a medias que contaban como réplicas

**Qué pasó.** En la segunda verificación completa, los tres agentes agotaron su cuota gratuita cuando solo habían escrito un test, sin arreglar nada. La herramienta contó ese trabajo a medias como tres réplicas y concluyó que «0 de 4 zonas coinciden» y que «los tests del PR fallan en 3 de 3 réplicas». Era falso: las réplicas no divergían, estaban incompletas.

**Cómo se detectó.** Por desconfianza: tres agentes que tocan un solo fichero en 85 segundos no han resuelto un bug de un generador de código. Los registros decían «Free usage limit reached».

**Qué cambió.**
- Antes de empezar, cada agente responde a una petición mínima. El que no responde no participa, y el informe dice por qué.
- Se detecta cuando un agente termina con error o se queda sin tiempo.
- Una réplica solo cuenta si **cambia código de producto, compila y pasa sus propios tests**. Las demás aparecen en el informe como descartadas, con su motivo.

**Lección.** El consenso y la divergencia solo significan algo entre trabajos terminados. Sin esta puerta, un fallo de infraestructura se disfraza de hallazgo.

### 3. El modelo que solo debía redactar editó el repositorio

**Qué pasó.** El juez solo tiene que redactar preguntas. Para eso se llamaba a un modelo con `opencode run`, sin sandbox y desde una carpeta dentro del proyecto. El CLI lo trató como una tarea de programación: encontró el repositorio revisado y escribió en él el código del PR. La comprobación de aislamiento no lo vio porque solo vigilaba la etapa de réplicas, y el juez corre después.

**Cómo se detectó.** Al final de la sesión, `git status` del repositorio original mostraba un fichero modificado a la hora exacta en que corría el juez.

**Qué cambió.**
- Las llamadas de redacción corren en una carpeta temporal vacía, con el agente de solo lectura del CLI y dentro del sandbox con toda escritura denegada.
- Se probó a propósito: se le pidió a un modelo que escribiera en el repositorio. Lo intentó y el sistema se lo impidió.
- El estado del repositorio original se compara al principio y al final de **toda** la verificación. Si cambia, el informe se marca como no fiable y el carril pasa a «Devolver».

**Lección.** Cualquier llamada a un agente es una ejecución de código, aunque solo se le pida texto. El aislamiento tiene que cubrir todas las llamadas, no solo las que esperas que escriban.

### 4. Culpamos al PR de un fallo que ya existía

**Qué pasó.** La primera verificación de #2234 devolvió el PR con el motivo «no compila». El proyecto de tests que no compilaba tampoco compila sin el PR en este entorno.

**Qué cambió.** Si algo no compila o un test falla con el PR, se comprueba primero sobre la base. Lo que ya fallaba se saca del veredicto y aparece en «no comprobado» con la nota «no es atribuible al cambio». La excepción son los proyectos que el propio PR añade: esos sí son su responsabilidad.

**Lección.** Un revisor que acusa en falso pierde la confianza igual de rápido que uno que deja pasar errores.

### 5. La rama base no era la que parecía

**Qué pasó.** Las ramas del reto no salen de `master`. Salen de la rama por defecto del repositorio, que está 235 commits por detrás. Comparando contra `master`, cada PR habría parecido un cambio enorme lleno de conflictos.

**Qué cambió.** La base se detecta de `origin/HEAD`, se enseña siempre en pantalla y se puede cambiar.

### 6. Tests que el sandbox no puede ejecutar

**Qué pasó.** Dos de los diez tests nuevos de #2234 viven en el proyecto que no compila aquí. No se pueden ejecutar.

**Qué cambió.** Aparecen como «no ejecutado», nunca como «pasa», y generan una pregunta para la persona: ¿los has visto pasar en otro entorno?

### 7. Defectos sembrados que no significan nada

**Qué pasó.** En #2283 sobrevive un defecto sembrado en la línea 985. El operador quitó un `?.` de una parte de la línea que el PR no había tocado y que en los tests nunca es nula. Es ruido.

**Qué hacemos.** Se muestra tal cual, con el operador y la línea, para que la persona lo juzgue. Un mutante que sobrevive es una pregunta, no una acusación. Mejora pendiente: mutar solo los tokens que el PR cambió.

### 8. La diversidad de las réplicas depende de lo que haya instalado

**Qué pasó.** El CLI de Claude tenía la sesión caducada. Las réplicas se hicieron con tres modelos gratuitos de otro proveedor.

**Qué hacemos.** El informe dice qué modelos se usaron y cuántas réplicas terminaron. Si todas vienen del mismo modelo, es un motivo declarado para desconfiar del consenso.

## B. Fallos que el revisor encontró en los cambios

### 9. Tests que no prueban nada (#2234)

De los 10 tests nuevos, **4 pasan también sin el cambio**. Se pasaron sobre la base y salieron en verde. Un test que no falla antes del cambio no demuestra que el cambio haga falta. Leyendo el diff parecen tests razonables; solo se ve ejecutándolos sin el código.

### 10. El cambio hace más de lo que pide el requisito (#2283)

La issue pide que deje de petar. El cambio, además, descarta cualquier diagnóstico cuya ubicación no esté en la compilación actual y lo documenta como norma. El código lo dice en su propio comentario («they are dropped here»), y la regla de «silencia comportamiento existente» lo señala. Es una decisión de producto que el requisito no menciona.

### 11. Una anomalía escondida en un cambio mecánico (#2297)

237 ficheros. 222 son snapshots con el mismo bloque de tres líneas repetido 402 veces. **Uno** cambia además de otra forma. A mano, esa anomalía se pierde. La persona lee 32 líneas de 1.392.

### 12. El requisito pide «todo» y el cambio excluye targets (#2297)

La issue pide el atributo en todo el código generado. El cambio lo mete dentro de `#if !NETSTANDARD2_0 && !NETFRAMEWORK`. El sandbox solo compila un target, así que el otro lado del `#if` no se ha ejecutado. Queda como pregunta y como «no comprobado».

### 13. Un requisito que no dice qué es correcto (#2234)

La issue tiene 149 caracteres: dice que el analizador «no funciona» y que antes funcionaba. No hay comportamiento esperado ni pasos para reproducirlo. Aunque los tests pasen, solo demuestran que el código hace lo que el agente decidió. Carril: devolver.

### 14. Superficie pública nueva (#2129)

Un atributo público nuevo y cuatro IDs de diagnóstico. No hay atajo: lectura completa de las 452 líneas de código. El informe solo ordena la lectura.

## C. Lo que todavía no sabemos

- **Escapes reales.** No se ha hecho merge de nada, así que «0 escapes» no demuestra nada todavía.
- **Si la comparación textual con las réplicas se equivoca.** Dos cambios equivalentes escritos distinto pueden salir como «diferentes». Los tests cruzados lo compensan solo en parte.
- **Coste a escala.** Solo hay medidas de cuatro PRs en una máquina.
