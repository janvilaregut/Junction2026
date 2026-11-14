// Routing. Turns the evidence into: a lane, the rules that fired (readable, no score), the residue a human
// must read, the questions the AI refuses to decide, and the list of what was not checked.
import path from 'node:path';

export const LANES = {
  devolver: { id: 'devolver', name: 'Devolver', tone: 'no', summary: 'No se puede revisar así. Vuelve al autor o al requisito.' },
  completa: { id: 'completa', name: 'Lectura completa', tone: 'warn', summary: 'Toca algo donde no hay atajo. El informe solo ordena la lectura.' },
  decision: { id: 'decision', name: 'Decides tú', tone: 'warn', summary: 'Lee el residuo y responde las preguntas. El resto está reproducido.' },
  residuo: { id: 'residuo', name: 'Solo residuo', tone: 'ok', summary: 'Lee solo lo que no se pudo reproducir.' },
  reproducido: { id: 'reproducido', name: 'Reproducido', tone: 'ok', summary: 'Todo lo comprobable está comprobado. Firma ligera.' },
};
const ORDER = ['devolver', 'completa', 'decision', 'residuo', 'reproducido'];

const SILENCE = [
  [/\bcatch\b\s*(\(|\{|$)/, 'captura una excepción'],
  [/#pragma warning disable|SuppressMessage|<NoWarn>/, 'desactiva un aviso'],
  [/^\s*(continue|return);\s*(\/\/.*)?$/, 'sale antes de tiempo y omite el resto'],
  [/\b(dropp?ed|ignor(e|ed|ing)|suppress(ed|es)?|skipp?(ed|ing)?|swallow(ed)?|silenc(e|ed))\b/i, 'descarta u omite algo (lo dice el propio código o su comentario)'],
  [/if\s*\(\s*!\s*[\w.]+\.Contains(Key)?\(/, 'omite una inserción si ya existe, sin avisar'],
];
const REMOVED_CHECK = [/\bthrow\b/, /\bAssert\./, /Debug\.Assert/, /\.Report(Diagnostic)?\(/];
const PUBLIC_TYPE = /^\s*public\s+(?:(?:sealed|static|abstract|partial|readonly|unsafe|new)\s+)*(class|interface|struct|record|enum|delegate)\s+(\w+)/;
const CONTRACT_FILE = /(PublicAPI\.(Un)?[Ss]hipped\.txt|AnalyzerReleases\.(Un)?[Ss]hipped\.md|\.proto$|openapi[\w.-]*\.(json|ya?ml)$|(^|\/)migrations?\/)/;
const SECURITY_PATH = /(^|\/)(auth\w*|crypto\w*|security|permissions?|secrets?)(\/|\.)/i;
const SECURITY_LINE = /(Process\.Start|BinaryFormatter|SqlCommand\(|\beval\(|child_process|password\s*=|api[_-]?key\s*=|PRIVATE KEY)/;

const short = (l, n = 110) => { const t = l.trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const loc = (f, a, b) => `${path.basename(f)}:${a}${b && b !== a ? `–${b}` : ''}`;

export function route(ctx) {
  const {
    files, totals, requirement, provenance, merge, build, groups, l2, mutation, compare, cross, replicas,
    areas, toolchain, options, env, judged,
  } = ctx;
  const fired = [];
  const notFired = [];
  const questions = [];
  const notChecked = [];
  const residue = new Map(); // key → item
  const addResidue = (file, start, end, lines, why, kind = 'source') => {
    const key = `${file}:${start}`;
    const prev = residue.get(key);
    if (prev) { if (!prev.why.includes(why)) prev.why.push(why); return; }
    residue.set(key, { file, start, end: end || start, lines, why: [why], kind });
  };
  const rule = (ok, id, title, detail, lane, evidence) => {
    if (ok) fired.push({ id, title, detail, lane, evidence: evidence || [] });
    else notFired.push({ id, title });
    return ok;
  };
  const q = (id, text, why, evidence, options = ['Aceptar tal cual', 'Devolver al autor', 'Separar en otro cambio']) =>
    questions.push({ id, text, why, evidence, options, source: 'regla' });

  const src = files.filter((f) => f.kind === 'source' || f.kind === 'config');
  const srcLines = src.reduce((n, f) => n + f.add + f.del, 0);
  const ran = (stage) => stage && !stage.skipped;

  // ── Hard stops ────────────────────────────────────────────────────────────
  rule(merge && !merge.ok, 'conflicto', 'No se mezcla limpio', merge?.conflicts?.length ? `Conflictos en ${merge.conflicts.slice(0, 5).join(', ')}` : 'El merge falla.', 'devolver');
  rule(build && !build.ok, 'no-compila', 'No compila', 'El resultado de mezclar el PR sobre la base no compila.', 'devolver', [{ label: 'Registro de compilación', artifact: 'build-merged.log' }]);
  if (ran(l2)) {
    const broken = l2.newFailures || [];
    rule(broken.length > 0, 'suite-rota', 'Rompe tests que antes pasaban',
      `${broken.length} test(s) fallan con el PR y no en la base: ${broken.slice(0, 3).map((t) => t.split('.').pop()).join(', ')}`, 'devolver', [{ label: 'Suite con el PR', artifact: 'suite-merged.log' }]);
    const redFail = (l2.newTests || []).filter((t) => t.green === 'Failed');
    rule(redFail.length > 0, 'tests-propios-fallan', 'Los tests del propio PR fallan', redFail.map((t) => t.name).join(', '), 'devolver');
  }
  const body = (requirement?.body || '').trim();
  const weakReq = !provenance?.prompt && (!requirement || requirement.missing || (body.length < 280 && !/expected|repro|steps|should|esperad/i.test(body)));
  rule(weakReq, 'requisito-insuficiente', 'El requisito no dice qué es correcto',
    !requirement || requirement.missing
      ? 'No hay requisito enlazado ni prompt guardado. No hay contra qué comprobar.'
      : `El requisito ${requirement.id} tiene ${body.length} caracteres y no describe el comportamiento esperado ni cómo reproducirlo.`,
    'devolver');
  if (weakReq) {
    q('requisito', '¿Cuál es exactamente el comportamiento esperado?',
      ['Sin un requisito comprobable, que los tests pasen solo demuestra que el código hace lo que el agente decidió.', 'Cualquier implementación podría parecer correcta.'],
      requirement?.url ? [{ label: `Requisito ${requirement.id}`, url: requirement.url }] : [],
      ['Aclarar el requisito y volver a verificar', 'Aceptar con el requisito actual']);
  }

  // ── Full read ─────────────────────────────────────────────────────────────
  const publicTypes = [];
  const contracts = [];
  const security = [];
  for (const f of src) {
    if (CONTRACT_FILE.test(f.path)) contracts.push(f.path);
    if (SECURITY_PATH.test(f.path)) security.push(f.path);
    for (const h of f.hunks) {
      h.added.forEach((l, i) => {
        const m = l.match(PUBLIC_TYPE);
        if (m) publicTypes.push({ name: m[2], kind: m[1], file: f.path, line: h.newStart + i });
        if (SECURITY_LINE.test(l)) security.push(`${loc(f.path, h.newStart + i)} · ${short(l, 60)}`);
      });
    }
  }
  for (const f of files) if (f.kind !== 'source' && f.kind !== 'config' && CONTRACT_FILE.test(f.path)) contracts.push(f.path);
  const api = rule(publicTypes.length + contracts.length > 0, 'api-publica', 'Cambia la superficie pública',
    [publicTypes.length ? `Tipos públicos nuevos: ${publicTypes.slice(0, 6).map((t) => t.name).join(', ')}` : '', contracts.length ? `Ficheros de contrato: ${[...new Set(contracts)].map((c) => path.basename(c)).join(', ')}` : ''].filter(Boolean).join('. '),
    'completa');
  if (api) {
    q('api', `¿Aceptas la nueva superficie pública${publicTypes.length ? ` (${publicTypes.slice(0, 4).map((t) => t.name).join(', ')})` : ''}?`,
      ['Una API pública es un compromiso con quien la usa: después no se puede cambiar sin romper.', 'El diseño de una API es una decisión de producto, no algo que se pueda reproducir.'],
      publicTypes.slice(0, 4).map((t) => ({ label: loc(t.file, t.line) })), ['Aceptar el diseño', 'Devolver al autor', 'Pedir revisión de diseño']);
  }
  rule(security.length > 0, 'seguridad', 'Toca una zona sensible de seguridad', [...new Set(security)].slice(0, 4).join(' · '), 'completa');
  const withdrawn = (areas || []).filter((a) => a.state === 'retirada');
  rule(withdrawn.length > 0, 'area-retirada', 'El área ha perdido la confianza',
    withdrawn.map((a) => `${a.area}: ${a.escapes} escape(s); faltan ${a.remaining} cambios firmados sin incidentes`).join(' · '), 'completa');

  // ── Decisions ─────────────────────────────────────────────────────────────
  const silences = [];
  for (const f of src) {
    for (const h of f.hunks) {
      h.added.forEach((l, i) => {
        const hit = SILENCE.find(([re]) => re.test(l));
        if (hit) silences.push({ file: f.path, line: h.newStart + i, text: short(l), what: hit[1], hunk: h });
      });
      h.removed.forEach((l) => {
        if (REMOVED_CHECK.some((re) => re.test(l))) silences.push({ file: f.path, line: h.newStart, text: short(l), what: 'elimina una comprobación existente', hunk: h });
      });
    }
  }
  if (rule(silences.length > 0, 'silencia', 'Silencia o relaja comportamiento existente',
    silences.slice(0, 4).map((s) => `${loc(s.file, s.line)} ${s.what}`).join(' · '), 'decision')) {
    for (const s of silences) addResidue(s.file, s.hunk.newStart, s.hunk.newStart + Math.max(s.hunk.newLines - 1, 0), s.hunk.added.length + s.hunk.removed.length, s.what);
    // If the judge already asks about the place where the silencing happens, do not ask twice.
    const judgedRegions = (judged || []).flatMap((j) => j.regions || []).map((id) => compare?.regions.find((r) => r.id === id)).filter(Boolean);
    const covered = silences.every((x) => judgedRegions.some((r) => r.file === x.file && x.line >= r.newStart && x.line <= r.newEnd));
    if (!covered) {
      q('silencia', `El cambio ${silences[0].what} en ${loc(silences[0].file, silences[0].line)}. ¿Es aceptable y está dentro de lo que pide el requisito?`,
        [`El requisito${requirement?.id ? ` ${requirement.id}` : ''} no pide explícitamente silenciar nada.`, 'Lo que se silencia deja de verse: si es un error, nadie se entera.'],
        silences.slice(0, 4).map((s) => ({ label: `${loc(s.file, s.line)} · ${s.text}` })));
    }
  }

  const ifs = [];
  for (const f of files) for (const h of f.hunks) for (const l of h.added) { const m = l.match(/^\s*#if\s+(.+)$/); if (m) ifs.push(m[1].trim()); }
  const conds = [...new Set(ifs)];
  if (rule(conds.length > 0, 'compilacion-condicional', 'Parte del cambio solo existe en algunos targets', conds.slice(0, 3).map((c) => `#if ${c}`).join(' · '), 'decision')) {
    q('targets', `El cambio queda dentro de «#if ${conds[0]}». ¿Es intencionado que no se aplique en el resto de targets?`,
      ['El requisito no menciona excepciones por plataforma.', 'El sandbox solo compila un target, así que el otro lado del #if no se ha ejecutado.'],
      [{ label: `${ifs.length} apariciones de #if en el cambio` }]);
    notChecked.push({ what: `Targets excluidos por «#if ${conds[0]}»`, why: 'El sandbox compila un único target; la rama excluida no se ha ejecutado.' });
  }

  if (ran(l2)) {
    const noTests = srcLines > 0 && !(l2.newTests || []).length;
    if (rule(noTests, 'sin-tests', 'Cambia código sin añadir tests', 'No hay ningún test nuevo que falle sin el cambio.', 'decision')) {
      q('sin-tests', 'El cambio no trae tests nuevos. ¿Cómo sabemos que hace lo que dice?', ['Sin un test que falle antes y pase después, no hay prueba ejecutable del requisito.'], []);
    }
    const toothless = (l2.newTests || []).filter((t) => t.red === 'Passed');
    if (rule(toothless.length > 0, 'tests-sin-dientes', 'Hay tests nuevos que ya pasaban sin el cambio',
      toothless.map((t) => t.name).join(', '), 'decision', [{ label: 'Tests nuevos sobre la base', artifact: 'red.log' }])) {
      q('dientes', `${toothless.length} test(s) nuevo(s) pasan también sin el cambio. ¿Prueban algo del requisito?`,
        ['Un test que no falla antes del cambio no demuestra que el cambio haga falta.'], toothless.slice(0, 4).map((t) => ({ label: t.name })));
    }
  }

  if (ran(l2)) {
    const unrun = (l2.newTests || []).filter((t) => t.green === 'NoEjecutado');
    if (rule(unrun.length > 0, 'tests-no-ejecutados', 'Hay tests nuevos que el sandbox no ha podido ejecutar',
      `${unrun.length} de ${l2.newTests.length}: ${unrun.slice(0, 3).map((t) => t.name).join(', ')}`, 'decision')) {
      q('no-ejecutados', `${unrun.length} test(s) nuevo(s) del PR no se han podido ejecutar aquí. ¿Los has visto pasar en otro entorno?`,
        ['Su proyecto de test no compila en este sandbox ni siquiera sin el PR, así que no es culpa del cambio.', 'Sin ejecutarlos no hay evidencia de lo que afirman.'],
        unrun.slice(0, 5).map((t) => ({ label: t.name })), ['Los he ejecutado yo y pasan', 'Devolver al autor', 'Acepto no tener esa evidencia']);
    }
  } else if (merge?.ok && (!build || build.ok) && srcLines > 0) {
    if (rule(true, 'sin-evidencia-ejecutable', 'No se ha podido ejecutar ningún test',
      toolchain.kind === 'none' ? 'No se ha detectado cómo compilar y probar este proyecto.' : 'El sandbox no puede compilar los tests de este proyecto, ni siquiera sin el PR.', 'decision')) {
      q('sin-evidencia', 'No hay ninguna evidencia ejecutada de que el cambio haga lo que dice. ¿Lo has probado tú?',
        ['Sin compilar ni pasar tests, lo único que hay es el texto del diff.'], [], ['Lo he probado yo', 'Devolver al autor', 'Acepto no tener esa evidencia']);
    }
  }

  if (compare) {
    const open = compare.regions.filter((r) => (r.kind === 'source' || r.kind === 'config') && (r.verdict === 'divergent' || r.verdict === 'surplus'));
    if (rule(open.length > 0, 'no-reproducido', 'Hay cambios que las réplicas no reproducen',
      `${open.length} de ${compare.regions.filter((r) => r.kind === 'source' || r.kind === 'config').length} zonas de código: ${open.slice(0, 3).map((r) => loc(r.file, r.newStart, r.newEnd)).join(', ')}`, 'decision')) {
      for (const r of open) addResidue(r.file, r.newStart, r.newEnd, r.lines, r.verdict === 'surplus' ? `ninguna de ${r.n} réplicas lo hizo` : `solo ${r.same} de ${r.n} réplicas lo hicieron igual`);
      const covered = new Set((judged || []).flatMap((j) => j.regions || []));
      const left = open.filter((r) => !covered.has(r.id));
      if (left.length) {
        const r0 = left[0];
        q(`regiones`, `${left.length === 1 ? 'Una zona' : `${left.length} zonas`} del cambio no ${left.length === 1 ? 'sale' : 'salen'} al rehacerlo desde el requisito (${left.slice(0, 3).map((r) => loc(r.file, r.newStart, r.newEnd)).join(', ')}). ¿Es intencionado y está dentro del alcance?`,
          [r0.verdict === 'surplus' ? `Ninguna de las ${r0.n} réplicas hizo este cambio: el requisito no lo pide de forma evidente.` : `Solo ${r0.same} de ${r0.n} réplicas lo resolvieron igual: el requisito admite varias soluciones.`, 'Donde el requisito no determina el código, alguien tomó una decisión.'],
          left.slice(0, 5).map((r) => ({ label: `${loc(r.file, r.newStart, r.newEnd)} · ${r.label}`, region: r.id })));
      }
    }
    for (const r of compare.regions.filter((x) => x.kind === 'doc' && (x.verdict === 'surplus' || x.verdict === 'divergent'))) {
      addResidue(r.file, r.newStart, r.newEnd, r.lines, 'documentación que las réplicas no escribieron', 'doc');
    }
    if (rule(compare.omissions.length > 0, 'posible-omision', 'Las réplicas cambiaron algo que el PR no toca',
      compare.omissions.slice(0, 3).map((o) => `${loc(o.file, o.lines[0], o.lines[1])} (${o.replicas.length} réplicas)`).join(' · '), 'decision')) {
      q('omision', `${compare.omissions[0].replicas.length} réplicas cambiaron además ${loc(compare.omissions[0].file, compare.omissions[0].lines[0], compare.omissions[0].lines[1])}, y el PR no. ¿Falta algo?`,
        ['Cuando varias derivaciones independientes coinciden en un cambio que el PR no tiene, puede ser una omisión.'],
        compare.omissions.slice(0, 4).map((o) => ({ label: `${loc(o.file, o.lines[0], o.lines[1])} · ${o.sample}` })), ['No falta: el PR es correcto así', 'Devolver al autor']);
    }
    if (cross?.length) {
      // A PR test that independent implementations of the same requirement do not pass is asserting
      // something the requirement does not fix. That is executable evidence of a hidden decision.
      const ran = cross.filter((c) => c.prTestsOnReplica?.status === 'ok');
      const failCount = new Map();
      for (const c of ran) for (const n of c.prTestsOnReplica.failedNames || []) failCount.set(n, (failCount.get(n) || 0) + 1);
      const narrow = [...failCount].filter(([, n]) => n >= Math.max(1, Math.ceil(ran.length / 2)));
      if (rule(narrow.length > 0, 'tests-no-universales', 'Tests del PR que las réplicas no pasan',
        narrow.slice(0, 3).map(([n, k]) => `${n.split('.').pop()} falla en ${k} de ${ran.length} réplicas`).join(' · '), 'decision',
        ran.map((c) => ({ label: `Tests del PR sobre ${c.label}`, artifact: `cross-${c.replica}-prtests.log` })))) {
        if (!(judged || []).length) {
          q('tests-estrechos', `El test «${narrow[0][0].split('.').pop()}» del PR falla en ${narrow[0][1]} de ${ran.length} implementaciones independientes del mismo requisito. ¿El comportamiento que afirma es el que queremos?`,
            ['Ese test fija un comportamiento que el requisito no determina: otras implementaciones válidas no lo cumplen.', 'Si se acepta, ese comportamiento queda protegido por un test y pasa a ser norma.'],
            narrow.slice(0, 4).map(([n, k]) => ({ label: `${n.split('.').pop()} · falla en ${k} de ${ran.length}` })));
        }
      }
      const prFailsTheirs = cross.filter((c) => c.replicaTestsOnPr && c.replicaTestsOnPr.failed > 0);
      if (rule(prFailsTheirs.length > 0, 'falla-tests-ajenos', 'El PR no pasa tests escritos por las réplicas',
        prFailsTheirs.map((c) => `${c.replica}: ${c.replicaTestsOnPr.failed} de ${c.replicaTestsOnPr.ran}`).join(' · '), 'decision',
        prFailsTheirs.map((c) => ({ label: `Tests de ${c.replica} sobre el PR`, artifact: `cross-${c.replica}-onpr.log` })))) {
        q('tests-ajenos', 'Tests escritos de forma independiente para el mismo requisito fallan con este PR. ¿Qué comportamiento es el correcto?',
          ['Es evidencia ejecutable de que el PR y otra implementación del mismo requisito se comportan distinto.', 'Puede que el test ajeno asuma algo que el requisito no dice: por eso lo decide una persona.'],
          prFailsTheirs.flatMap((c) => (c.replicaTestsOnPr.failedNames || []).slice(0, 3).map((n) => ({ label: `${c.replica}: ${n.split('.').pop()}` }))));
      }
    }
  }
  for (const j of judged || []) questions.push(j);

  const rewind = ctx.rewind;
  if (rewind && !rewind.skipped) {
    const loose = rewind.steps.filter((x) => x.status === 'sin-test');
    if (rule(loose.length > 0, 'cambio-sin-test', 'Hay cambios que se pueden quitar sin que falle ningún test',
      loose.slice(0, 3).map((x) => `${loc(x.file, x.start, x.end)}`).join(', '), 'decision', [{ label: 'Detalle de rebobinar', artifact: 'rewind.json' }])) {
      for (const x of loose) addResidue(x.file, x.start, x.end, x.end - x.start + 1, 'al quitar este cambio no falla ningún test');
      q('rebobinar', `Si se quita ${loose.length === 1 ? 'este cambio' : `cualquiera de estos ${loose.length} cambios`} (${loose.slice(0, 3).map((x) => loc(x.file, x.start, x.end)).join(', ')}), todos los tests siguen pasando. ¿Qué lo justifica y qué prueba debería cubrirlo?`,
        ['Ninguna prueba ejecutable depende de ese código: si estuviera mal, nadie se enteraría.', 'Puede ser código defensivo legítimo, pero entonces falta un test que lo demuestre.'],
        loose.slice(0, 4).map((x) => ({ label: `${loc(x.file, x.start, x.end)} · ${x.label}` })),
        ['Está justificado sin test', 'Pedir un test que lo cubra', 'Pedir que se quite']);
    }
  }

  if (mutation && !mutation.skipped) {
    const surv = mutation.mutants.filter((m) => m.status === 'sobrevive');
    rule(surv.length > 0, 'mutantes-vivos', 'Hay líneas que ningún test protege',
      `${surv.length} de ${mutation.valid} defectos sembrados no los detecta ningún test: ${surv.slice(0, 3).map((m) => loc(m.file, m.line)).join(', ')}`, 'residuo', [{ label: 'Detalle de mutantes', artifact: 'mutation.json' }]);
    for (const m of surv) addResidue(m.file, m.line, m.line, 1, `un defecto sembrado aquí (${m.op}) no lo detecta ningún test`);
  }

  // ── Residue ───────────────────────────────────────────────────────────────
  const anomalies = (groups || []).flatMap((g) => g.anomalies.map((a) => ({ ...a, group: g })));
  if (rule(anomalies.length > 0, 'anomalia-mecanica', 'Un fichero derivado cambia distinto a los demás',
    anomalies.slice(0, 3).map((a) => path.basename(a.path)).join(', '), 'residuo')) {
    for (const a of anomalies) {
      const at = a.added[0]?.at || a.removed[0]?.at || 1;
      addResidue(a.path, at, at + a.added.length, a.added.length + a.removed.length, `único fichero de ${a.group.files} con un cambio distinto al patrón repetido`, 'derived');
    }
  }
  const lane0 = ORDER.find((id) => fired.some((f) => f.lane === id));
  if (lane0 === 'completa') for (const f of src) for (const h of f.hunks) addResidue(f.path, h.newStart, h.newStart + Math.max(h.newLines - 1, 0), h.added.length + h.removed.length, 'lectura completa');
  // Without replicas nothing tells us which hand-written lines the requirement determines: all of them are residue.
  if (!compare || compare.n === 0) {
    for (const f of src) for (const h of f.hunks) {
      if ([...h.added, ...h.removed].every((l) => /^\s*(\/\/|\*|\/\*|$)/.test(l))) continue;
      addResidue(f.path, h.newStart, h.newStart + Math.max(h.newLines - 1, 0), h.added.length + h.removed.length, 'código escrito a mano; sin réplicas no se sabe si el requisito lo determina');
    }
  }
  const items = [...residue.values()].sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start);
  const residueLines = Math.min(totals.lines, items.reduce((n, i) => n + i.lines, 0));
  rule(items.length > 0 && !fired.some((f) => ['devolver', 'completa', 'decision'].includes(f.lane)) && !fired.some((f) => f.lane === 'residuo'),
    'residuo', 'Queda código sin reproducir', `${residueLines} líneas`, 'residuo');

  // Mark which seeded defects landed inside what the human reads.
  for (const m of mutation?.mutants || []) m.inResidue = items.some((i) => i.file === m.file && m.line >= i.start && m.line <= i.end);

  // ── Not checked ───────────────────────────────────────────────────────────
  const text = `${requirement?.title || ''}\n${body}`;
  if (/native\s?aot|\baot\b|trimm/i.test(text)) notChecked.push({ what: 'NativeAOT y trimming', why: 'El requisito los menciona; el sandbox no tiene un trabajo de AOT.' });
  if (/windows/i.test(text) && env.platform !== 'win32') notChecked.push({ what: 'Windows', why: `El requisito lo menciona; el sandbox es ${env.platform === 'darwin' ? 'macOS' : env.platform}.` });
  const v = text.match(/\.NET\s+(\d+)(?!\.\d+\.\d+ \()/i);
  if (v && toolchain.kind === 'dotnet' && env.dotnet && !env.dotnet.startsWith(`${v[1]}.`)) notChecked.push({ what: `.NET ${v[1]}`, why: `El requisito lo menciona; el sandbox usa el SDK ${env.dotnet}.` });
  if (/unity/i.test(text)) notChecked.push({ what: 'Unity', why: 'El requisito lo menciona; el sandbox no tiene Unity.' });
  if (toolchain.kind === 'none') notChecked.push({ what: 'Compilación y tests', why: 'No se ha detectado cómo compilar ni probar este proyecto.' });
  for (const e of toolchain.excluded || []) notChecked.push({ what: `Tests de ${e.name}`, why: `Ese proyecto ${e.why}. No es atribuible al cambio.` });
  if (toolchain.otherTestProjects) notChecked.push({ what: `Otros ${toolchain.otherTestProjects} proyectos de test del repo`, why: 'Solo se ejecutan los proyectos de test afectados por el cambio.' });
  if (!options.agents?.length) notChecked.push({ what: 'Réplicas independientes', why: 'Verificación rápida: no se ha rehecho el cambio con agentes, así que todo el código a mano es residuo.' });
  else if (replicas && replicas.filter((r) => r.ok).length < replicas.length) notChecked.push({ what: `${replicas.filter((r) => !r.ok).length} réplica(s) descartada(s)`, why: replicas.filter((r) => !r.ok).map((r) => `${r.label}: ${r.status}`).join(' · ').slice(0, 400) });
  if (replicas?.length) {
    const fam = new Set(replicas.filter((r) => r.ok).map((r) => String(r.model).split(/[-/.]/).find((x) => x && x !== 'opencode') || r.model));
    if (replicas.some((r) => r.ok) && fam.size < 2) notChecked.push({ what: 'Diversidad de las réplicas', why: 'Todas las réplicas válidas vienen de la misma familia de modelo: pueden compartir los mismos puntos ciegos.' });
  }
  if (env.repoTouched) rule(true, 'repo-modificado', 'El repositorio original cambió durante la verificación', `${env.repoTouched.slice(0, 4).join(', ')}. Algo se salió de su copia aislada; este informe no es fiable.`, 'devolver', [{ label: 'Estado antes y después', artifact: 'repo-touched.txt' }]);
  if (env.isolationBroken) notChecked.push({ what: 'Réplicas descartadas', why: `Un agente se salió de su copia y modificó el repositorio original (${env.isolationBroken.slice(0, 3).join(', ')}). Sus resultados ya no son independientes.` });
  else if (replicas?.length && env.confined === false) notChecked.push({ what: 'Aislamiento de las réplicas', why: 'Este sistema no tiene sandbox: los agentes trabajan en una copia sin historial, pero nada les impide leer otras carpetas.' });
  if (mutation?.skipped) notChecked.push({ what: 'Defectos sembrados', why: mutation.reason });
  if (provenance?.status === 'none') notChecked.push({ what: 'Prompt original del autor', why: 'El commit no trae el prompt guardado (ni sesión de Entire ni nota). La intención se ha reconstruido desde el requisito.' });
  notChecked.push({ what: 'Rendimiento', why: 'El pipeline no ejecuta benchmarks.' });
  notChecked.push({ what: 'Seguridad en profundidad', why: 'No hay análisis de seguridad dedicado, solo reglas sobre zonas sensibles.' });

  const probation = (areas || []).filter((a) => a.state === 'prueba');
  const laneId = ORDER.find((id) => fired.some((f) => f.lane === id)) || 'reproducido';
  if (laneId === 'reproducido') notFired.push({ id: 'residuo', title: 'Queda código sin reproducir' });

  // The three outcomes the human reads first. It is a recommendation; the decision is the signer's.
  const firedIds = new Set(fired.map((f) => f.id));
  const reproducibleFailure = ['conflicto', 'no-compila', 'suite-rota', 'tests-propios-fallan'].some((id) => firedIds.has(id));
  const insufficient = ['requisito-insuficiente', 'sin-evidencia-ejecutable', 'repo-modificado'].some((id) => firedIds.has(id));
  const recommendation = reproducibleFailure
    ? { id: 'cambios', name: 'Pedir cambios', why: 'Hay un fallo reproducible: el informe trae cómo repetirlo.' }
    : insufficient
      ? { id: 'insuficiente', name: 'Evidencia insuficiente', why: 'Falta algo para poder juzgar el cambio: el informe dice qué.' }
      : { id: 'lista', name: 'Lista para aprobación humana', why: questions.length ? 'Lo comprobable está comprobado. Quedan decisiones que solo puede tomar una persona.' : 'Lo comprobable está comprobado. Firma con el alcance documentado.' };

  return {
    recommendation,
    lane: LANES[laneId],
    rules: { fired, notFired },
    questions,
    residue: { lines: laneId === 'devolver' ? 0 : residueLines, total: totals.lines, items },
    notChecked,
    audit: probation.length > 0,
  };
}
