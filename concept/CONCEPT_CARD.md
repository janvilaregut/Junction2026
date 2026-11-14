# Concept card · Katse

## Recomendación

**No leas el cambio: reprodúcelo.** Un cambio escrito por un agente es barato de producir, así que es barato volver a producirlo. Lo que una máquina reproduce de forma independiente queda respaldado por evidencia ejecutable. Lo que no se reproduce es el **residuo**, y es lo único que lee y firma una persona con nombre.

La revisión deja de escalar con las líneas y pasa a escalar con las decisiones.

## Cómo funciona

1. **Reproducción determinista.** Los ficheros derivados (snapshots, código generado) se tratan como consecuencia de su fuente: se detecta el cambio repetido y se aísla el que cambia distinto.
2. **Reproducción conductual.** Los tests nuevos tienen que fallar sin el cambio y pasar con él. Se siembran defectos en las líneas cambiadas para ver si algún test los detecta.
3. **Reproducción generativa.** Varios agentes de modelos distintos rehacen el cambio a ciegas desde el requisito (y desde el prompt original si está guardado). Donde coinciden, el requisito no dejaba elegir. Donde divergen, alguien tomó una decisión.

El resultado es un carril decidido por reglas legibles, un informe y una firma.

## Principios

1. **Reproducir, no leer.**
2. **La evidencia es ejecutable o no es evidencia.** No hay porcentajes de confianza.
3. **El consenso dirige la atención; nunca aprueba.**
4. **La IA dice qué no decidió y qué no comprobó.** Negarse es un resultado válido.
5. **Firma una persona con nombre:** qué se comprobó, qué no, y qué riesgo acepta.
6. **La profundidad sigue reglas de riesgo que se pueden leer.**
7. **La confianza se gana por área con historial y se retira tras un escape.** Al revisor también se le examina.
8. **Primero la procedencia:** todo cambio de un agente lleva su requisito y su prompt.

## Cómo equilibra los cinco factores

| Factor | Mecanismo |
|---|---|
| Riesgo | Carriles por reglas. Lectura completa donde un fallo sale caro: API pública, seguridad, áreas que han tenido un escape |
| Alucinación | Ninguna afirmación sin algo ejecutado detrás. Réplicas a ciegas. El modelo solo redacta preguntas |
| Transparencia | Tres listas siempre visibles: comprobado, no comprobado, no decidido. Cada una enlaza su evidencia |
| Confianza | Estados discretos (reproducido, parcial, falla, no ejecutado) en lugar de una cifra |
| Calidad | Tests con dientes, defectos sembrados, tests cruzados entre implementaciones independientes |

## Carriles

| Carril | Cuándo | Qué hace la persona |
|---|---|---|
| Reproducido | Todo comprobado, sin residuo | Firma ligera; auditoría por muestreo |
| Solo residuo | Queda código sin reproducir, acotado | Lee solo eso |
| Decides tú | La IA se negó a decidir algo | Lee el residuo y responde |
| Lectura completa | API pública, seguridad o área sin confianza | Lo lee todo; el informe ordena la lectura |
| Devolver | No compila, rompe tests o el requisito no dice qué es correcto | Lo devuelve al autor o aclara el requisito |

## Quién es dueño de la decisión

Una persona con nombre. La herramienta no tiene veredicto de aprobación y nunca hace merge. La firma exige responder cada pregunta abierta, confirmar lo leído y escribir con sus palabras el riesgo residual. Queda registrada con el commit, la fecha y el hash del informe.

## Cómo se mide la confianza

- **Defectos sembrados:** cuántos detectan los tests, cuántos llegan al menos a la persona, cuántos escaparían.
- **Líneas que lee una persona** sobre líneas cambiadas.
- **Cambios enrutados a lectura completa.**
- **Hallazgos que cambiaron algo:** preguntas en las que la persona no respondió «aceptar».
- **Estabilidad del revisor:** el mismo commit verificado dos veces cae en el mismo carril.
- **Escapes por área:** reverts e incidentes después del merge.

Condición de seguridad: el tiempo de revisión solo puede bajar mientras los escapes no suban. Un escape retira la confianza del área.

## Trade-offs

| Ganamos | Pagamos |
|---|---|
| La atención humana va entera a donde está el riesgo | Minutos de cómputo y tokens por cada réplica |
| Evidencia que cualquiera puede volver a ejecutar | El informe llega minutos después del PR, no segundos |
| Las decisiones escondidas salen a la luz | Depende de que el requisito diga qué es correcto |
| Se detecta el cambio que excede el requisito | La comparación con las réplicas es textual |

## Límites

- **Consenso correlacionado.** Réplicas del mismo modelo fallan igual. Por eso se mezclan modelos y el consenso nunca aprueba.
- **Cambios grandes o de arquitectura.** Nadie rehace igual mil líneas. Ahí quedan los niveles 1 y 2 y la lectura completa.
- **Lo que el sandbox no tiene:** rendimiento, otras plataformas, seguridad en profundidad. Aparece como no comprobado.
- **El revisor no es determinista.** Se mide su estabilidad.
- **Sesgo de automatización.** La persona puede firmar sin mirar. La firma exige respuestas y hay auditoría de una segunda persona mientras el área está en prueba.
- **Un requisito malo no se arregla revisando.** Se devuelve.

## Qué nos haría desconfiar de nuestro propio resultado

- Que todas las réplicas vengan del mismo modelo.
- Que los tests nuevos pasen también sin el cambio.
- Que sobrevivan defectos sembrados fuera de lo que lee la persona.
- Que el sandbox no haya podido compilar o ejecutar.
- Que dos verificaciones del mismo commit den carriles distintos.
- Que no haya prompt guardado ni requisito claro.
