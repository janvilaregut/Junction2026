#!/usr/bin/env node
// HTTP server: static UI + JSON API + live events. Listens on localhost only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, sha256 } from './util.js';
import { ask, clis } from './llm.js';
import { git, commits, resolveRef, diff, parseDiff } from './git.js';
import { listProjects, getProject, addProject, cloneProject, updateProject, removeProject, listPullRequests, findPullRequest, projectStatus } from './projects.js';
import { startRun, getRun, subscribe, activeRun, artifact, latestByPr, latestBriefs, saveSignoff } from './runs.js';
import { intake, replicaBudget } from './pipeline/run.js';
import { addedTestNames } from './pipeline/classify.js';
import { availableAgents } from './pipeline/replicas.js';
import { areaStates, areasOf, metrics, record, entries, K_EARN } from './ledger.js';
import { markdown, trailers, answer } from './report.js';
import { savePrompt } from './requirements.js';
import { liveToken } from './live.js';
import { getSettings, updateSettings } from './settings.js';
import { startConsensus, getConsensus, listConsensus, subscribeConsensus, isLive } from './consensus/run.js';
import { verifyIntegrity } from './integrity.js';
import { resolveProfile } from './profiles.js';
import { session, models } from './agents.js';
import { analyze as mathAnalyze } from './math/index.js';
import { marksOf, setMark } from './math/marks.js';
import { reviewNode, savedReview } from './math/nodereview.js';

const PORT = Number(process.env.PORT || 4173);
const UI = path.join(ROOT, 'mvp');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
const readBody = (req) => new Promise((resolve, reject) => {
  let s = '';
  req.on('data', (d) => { s += d; if (s.length > 2_000_000) reject(new Error('Cuerpo demasiado grande')); });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error('JSON no válido')); } });
});

/** Where the PR changed code, and which independent rebuilds (the run's candidates, built from the base
 *  without seeing the PR) changed the same places. Converging regions are reproduced; PR-only ones are the
 *  ones a human should read. Read-only: git diff plus the run's saved patches. */
async function versionsOf(project, from, to, run) {
  const prFiles = await diff(project.path, from, to);
  const kinds = Object.fromEntries((run?.brief?.files || []).map((f) => [f.path, f.kind]));
  const cands = (run?.brief?.candidates || []).filter((c) => c.patch).map((c) => {
    let files = []; try { files = parseDiff(artifact(project.id, run.id, c.patch)); } catch { /* patch missing */ }
    return { id: c.id, model: c.model, status: c.status, files };
  });
  const near = (a, b) => a.oldStart <= b.oldStart + Math.max(b.oldLines, 1) + 3 && b.oldStart <= a.oldStart + Math.max(a.oldLines, 1) + 3;
  const regions = [];
  for (const f of prFiles) {
    if (f.binary) continue;
    const kind = kinds[f.path] || (/test/i.test(f.path) ? 'test' : /\.(md|txt|rst)$/i.test(f.path) ? 'doc' : 'source');
    for (const h of f.hunks) {
      const who = cands.filter((c) => c.files.some((g) => g.path === f.path && (f.status === 'added' || g.hunks.some((k) => near(h, k))))).map((c) => c.id);
      regions.push({ file: f.path, kind, status: f.status, start: h.newStart, end: h.newStart + Math.max(h.newLines, 1) - 1, oldStart: h.oldStart, lines: h.added.length + h.removed.length, removed: h.removed.slice(0, 30), added: h.added.slice(0, 30), who });
    }
  }
  return { from, to, runId: run?.id || null, candidates: cands.map((c) => ({ id: c.id, model: c.model, status: c.status, files: c.files.map((f) => f.path) })), regions };
}

/** What a verification will and will not do for this PR, computed without running anything. */
async function planFor(project, pr, mode, profileId = 'standard') {
  const it = await intake(project, pr);
  const agents = await availableAgents();
  const tests = addedTestNames(it.files.filter((f) => f.kind === 'test'));
  const derived = it.files.filter((f) => f.kind === 'derived').length;
  const src = it.files.filter((f) => f.kind === 'source').length;
  const full = mode === 'completo';
  const profile = resolveProfile({ profile: profileId });
  const budget = replicaBudget(it.files);
  const will = [
    `Mezclar ${pr.branch} sobre ${project.base} en una copia aislada (tu repo no se toca)`,
    it.toolchain.kind !== 'none' ? `Compilar y pasar los tests afectados (${it.toolchain.describe})` : null,
    tests.length ? `Comprobar que los ${tests.length} tests nuevos fallan sin el cambio y pasan con él` : null,
    derived ? `Analizar ${derived} ficheros derivados: cambio repetido y anomalías` : null,
    src && it.toolchain.kind !== 'none' && (!full || profile.id === 'deep') ? 'Sembrar defectos en las líneas cambiadas y ver si algún test los detecta' : null,
    src && it.toolchain.kind !== 'none' && (!full || profile.id === 'deep') ? 'Rebobinar: quitar cada cambio de código de uno en uno y ver si algún test lo nota' : null,
    full ? `Contrato con fuentes; hasta ${profile.initialCandidates} alternativas independientes desde la base` : null,
    full ? `Mesa de pruebas, checkpoints de Entire y juicio con evidencia. Límite: ${profile.budgetMs/1000}s y ${profile.tokenBudget.toLocaleString()} tokens presupuestados; resultados pendientes si no alcanza` : null,
  ].filter(Boolean);
  const text = `${it.requirement?.title || ''}\n${it.requirement?.body || ''}`;
  const wont = [];
  if (!it.requirement?.title) wont.push({ what: 'Revisar contra un requisito', why: 'No encuentro ninguna issue enlazada a esta rama.' });
  if (it.toolchain.kind === 'none') wont.push({ what: 'Compilar y pasar tests', why: 'No detecto cómo se compila este proyecto. Puedes indicarlo en los ajustes.' });
  if (!full) wont.push({ what: 'Rehacer el cambio con agentes', why: 'La verificación rápida no lanza réplicas.' });
  if (it.provenance.status === 'none') wont.push({ what: 'Usar el prompt original', why: 'El commit no trae el prompt guardado. Uso el texto del requisito. Puedes añadirlo arriba.' });
  if (/native\s?aot|\baot\b|trimm/i.test(text)) wont.push({ what: 'NativeAOT y trimming', why: 'El requisito los menciona; el sandbox no los ejecuta.' });
  if (/windows/i.test(text) && process.platform !== 'win32') wont.push({ what: 'Windows', why: 'El requisito lo menciona; el sandbox es este equipo.' });
  if (it.toolchain.otherTestProjects) wont.push({ what: `Otros ${it.toolchain.otherTestProjects} proyectos de test`, why: 'Solo se ejecutan los afectados por el cambio.' });
  wont.push({ what: 'Rendimiento y seguridad en profundidad', why: 'El pipeline no ejecuta benchmarks ni análisis de seguridad dedicado.' });
  wont.push({ what: 'Aprobar o hacer merge', why: 'Eso lo decides y lo haces tú.' });
  return {
    totals: it.totals, kinds: it.kinds, head: it.headSha,
    requirement: it.requirement ? { id: it.requirement.id, title: it.requirement.title, url: it.requirement.url, missing: !!it.requirement.missing, excerpt: (it.requirement.body || '').slice(0, 500) } : null,
    provenance: it.provenance.status,
    toolchain: it.toolchain.describe,
    areas: areaStates(project.id, areasOf(it.files)),
    will, wont, budget,
    files: it.files.map((f) => ({ path: f.path, kind: f.kind, add: f.add, del: f.del })),
  };
}

async function askModel(question, brief) {
  if (process.env.KATSE_PRIVACY_MODE === 'strict' || brief.privacy?.mode === 'strict') return 'La privacidad estricta bloquea este chat auxiliar, que todavía no pasa por Gemma. Puedes consultar las pruebas y el informe local de la revisión.';
  const slim = { verdict: brief.verdict, contract: brief.contract?.expectations, candidates: brief.candidates?.map(c => ({id:c.id,status:c.status,checkpoint:c.checkpoint?.status})), lane: brief.lane, rules: brief.rules.fired, claims: brief.claims.map(({ evidence, ...c }) => c), questions: brief.questions, residue: { lines: brief.residue.lines, total: brief.residue.total, items: brief.residue.items.map(({ code, ...i }) => i) }, notChecked: brief.notChecked, requirement: brief.requirement, totals: brief.totals, replicas: brief.l3?.replicas?.map((r) => ({ label: r.label, ok: r.ok, summary: r.summary, decisions: r.decisions })) };
  const prompt = `Eres el asistente de una herramienta de verificación de pull requests. Responde en español, en 2 a 5 frases, sin formato, usando SOLO los datos de este informe. Si el informe no lo dice, di que no está comprobado. Nunca digas que el cambio está bien, es correcto o se puede aprobar: eso lo decide la persona.\n\nINFORME:\n${JSON.stringify(slim).slice(0, 24_000)}\n\nPREGUNTA: ${question.slice(0, 600)}`;
  if (process.env.GEMINI_API_KEY) {
    const artifacts = path.join(ROOT, 'data', 'chat', String(Date.now())); fs.mkdirSync(artifacts, { recursive: true });
    try {
      const r = await session({ dir: ROOT, artifacts, role: 'semantic-chat', model: models().fast, prompt: `${prompt}\nNO uses herramientas. Devuelve JSON {"answer":"respuesta breve"}.`, timeout: 35000, validate: x => typeof x.answer === 'string' });
      return r.result.answer;
    } catch { return null; }
  }
  const r = await ask(prompt, { cwd: path.join(ROOT, 'data'), timeout: 90_000, model: 'haiku' });
  return r?.text || null;
}

/** What the signer takes away: commit trailers, the commands to run themselves, and the PR text. */
function signedView(b, signoff) {
  const t = trailers(b, signoff);
  const commands = signoff.decision !== 'aprobar' ? [] : b.pr.direction === 'incoming'
    ? [`git checkout ${b.pr.base}`, `git merge --no-ff origin/${b.pr.branch} -m "Merge ${b.pr.branch}" -m "${t.replace(/"/g, '\\"')}"`]
    : [`git push -u origin ${b.pr.branch}`];
  return { trailers: t, commands, markdown: markdown(b, signoff) };
}

async function ledgerView(project) {
  const briefs = latestBriefs(project.id);
  const areas = new Set(briefs.flatMap((b) => (b.areas || []).map((a) => a.area)));
  return { k: K_EARN, areas: areaStates(project.id, [...areas]), metrics: metrics(project.id, briefs), entries: entries(project.id).filter((e) => e.type !== 'run').slice(-50).reverse() };
}

async function checkedRun(project, runId) {
  const r = getRun(project.id, runId);
  if (r.signoff && r.brief?.version >= 2) {
    const head = await git(project.path, ['rev-parse', '--verify', `${r.brief.input.proposedRef}^{commit}`], { allowFail: true });
    const base = await git(project.path, ['rev-parse', '--verify', `${r.brief.input.targetRef}^{commit}`], { allowFail: true });
    r.signatureValid = r.signatureValid && head.stdout.trim() === r.brief.input.proposed && base.stdout.trim() === r.brief.input.target;
  }
  return r;
}

async function api(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean).slice(1); // after "api"
  const method = req.method;

  if (seg[0] === 'settings') { // which models the review may call; keys are only reported as present or not
    const keys = { gemini: !!process.env.GEMINI_API_KEY, verda: !!process.env.VERDA_INFERENCE_KEY };
    if (method === 'GET') return send(res, 200, { ...getSettings(), keys });
    if (method === 'PATCH' || method === 'POST') return send(res, 200, { ...updateSettings(await readBody(req)), keys });
  }
  if (seg[0] === 'live' && seg[1] === 'token' && method === 'POST') return send(res, 200, await liveToken());
  // Consensus engine: Gemini variants solve blind, compare, debate in pairs.
  if (seg[0] === 'consenso') {
    if (!seg[1] && method === 'GET') return send(res, 200, listConsensus());
    if (!seg[1] && method === 'POST') return send(res, 200, await startConsensus(await readBody(req)));
    const c = getConsensus(seg[1]);
    if (!c) return send(res, 404, { error: 'No such consensus run' });
    if (!seg[2]) return send(res, 200, { ...c, events: undefined });
    if (seg[2] === 'events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      const write = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      for (const e of c.events || []) write(e);
      if (!isLive(seg[1])) {
        // Not running here. If it never reached done/error and no live process owns it (status 'interrupted'),
        // end with a terminal event so the client closes instead of reconnecting and replaying forever.
        // (A run still owned by another live process, e.g. the CLI, reports 'running': no terminal event.)
        const ended = (c.events || []).some((e) => e.type === 'done' || e.type === 'error');
        if (!ended && c.status !== 'running') write({ type: 'error', message: 'interrupted' });
        return res.end();
      }
      const off = subscribeConsensus(seg[1], (e) => { write(e); if (e.type === 'done' || e.type === 'error') res.end(); });
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => { off(); clearInterval(ping); });
      return undefined;
    }
  }
  if (seg[0] === 'state' && method === 'GET') {
    return send(res, 200, { projects: listProjects(), agents: await availableAgents(), clis: await clis(), workspace: path.join(ROOT, 'workspace') });
  }
  if (seg[0] === 'projects' && seg.length === 1 && method === 'POST') {
    const body = await readBody(req);
    const p = body.url ? await cloneProject(body.url, path.join(ROOT, 'workspace')) : await addProject(body.path || '');
    return send(res, 200, p);
  }
  if (seg[0] === 'projects' && seg[1]) {
    const project = getProject(seg[1]);
    const sub = seg[2];
    if (!sub && method === 'PATCH') return send(res, 200, updateProject(project.id, await readBody(req)));
    if (!sub && method === 'DELETE') { removeProject(project.id); return send(res, 200, { ok: true }); }
    if (sub === 'status') return send(res, 200, await projectStatus(project));
    if (sub === 'prs') {
      const prs = await listPullRequests(project, { fetch: url.searchParams.get('fetch') === '1' });
      const last = latestByPr(project.id);
      const act = activeRun(project.id);
      for (const pr of [...prs.incoming, ...prs.outgoing]) {
        const l = last[pr.id];
        pr.last = l ? { ...l, stale: !pr.sha || !l.head.startsWith(pr.sha) } : null;
        pr.running = act?.prId === pr.id ? act.id : null;
      }
      return send(res, 200, prs);
    }
    if (sub === 'versions') { // no run yet: the PR's own regions against its base
      const pr = await findPullRequest(project, url.searchParams.get('pr'));
      return send(res, 200, await versionsOf(project, `${await resolveRef(project.path, project.base)}...${pr.ref}`, null, null));
    }
    if (sub === 'commits') { // the branch's own commits (base..branch), oldest first, at most the last 40
      const pr = await findPullRequest(project, url.searchParams.get('pr'));
      const list = await commits(project.path, await resolveRef(project.path, project.base), pr.ref);
      return send(res, 200, { total: list.length, commits: list.slice(-40).map(({ sha, author, date, subject }) => ({ sha, author, date, subject })) });
    }
    if (sub === 'math') { // the mathematical pass: proofs, checks and measurements per changed function, no model and no execution
      if (seg[3] === 'mark' && method === 'POST') {
        const body = await readBody(req);
        const pr = await findPullRequest(project, body.pr);
        const m = await mathAnalyze(project, pr);
        return send(res, 200, { marks: setMark(project.id, m.head, String(body.node || ''), body.state, String(body.by || '').slice(0, 80)) });
      }
      if (seg[3] === 'review') { // one node, reviewed by agents: rebuilt blind from the requirement and compared
        const body = method === 'POST' ? await readBody(req) : { pr: url.searchParams.get('pr'), node: url.searchParams.get('node') };
        const pr = await findPullRequest(project, body.pr);
        if (method === 'POST') return send(res, 200, await reviewNode(project, pr, String(body.node || ''), { force: !!body.force }));
        const m = await mathAnalyze(project, pr);
        return send(res, 200, savedReview(project.id, m.head, String(body.node || '')) || { none: true });
      }
      const pr = await findPullRequest(project, url.searchParams.get('pr'));
      const m = await mathAnalyze(project, pr, { force: url.searchParams.get('force') === '1' });
      return send(res, 200, { ...m, marks: marksOf(project.id, m.head) });
    }
    if (sub === 'plan') {
      const pr = await findPullRequest(project, url.searchParams.get('pr'));
      return send(res, 200, await planFor(project, pr, url.searchParams.get('mode') || 'rapido', url.searchParams.get('profile') || 'standard'));
    }
    if (sub === 'verify' && method === 'POST') {
      const body = await readBody(req);
      if (body.proposedRef && (!/^[\w./-]+$/.test(body.proposedRef) || body.proposedRef.startsWith('-'))) throw new Error('Referencia propuesta no válida');
      if (body.baseRef && (!/^[\w./-]+$/.test(body.baseRef) || body.baseRef.startsWith('-'))) throw new Error('Referencia base no válida');
      const pr = body.proposedRef ? { id: `ref:${body.proposedRef}`, ref: body.proposedRef, branch: body.proposedRef, title: body.proposedRef, direction: 'incoming', requirementText: body.requirement || '' } : await findPullRequest(project, body.pr);
      if (body.requirement) pr.requirementText = String(body.requirement);
      const run = await startRun(body.baseRef ? { ...project, base: body.baseRef } : project, pr, body.options || {});
      return send(res, 200, { runId: run.id, options: run.options });
    }
    if (sub === 'prompt' && method === 'POST') {
      const body = await readBody(req);
      const pr = await findPullRequest(project, body.pr);
      const sha = (await git(project.path, ['rev-parse', pr.ref])).stdout.trim();
      return send(res, 200, await savePrompt(project.path, sha, body.prompt));
    }
    if (sub === 'ledger') return send(res, 200, await ledgerView(project));
    if (sub === 'escape' && method === 'POST') {
      const body = await readBody(req);
      if (!body.area || !String(body.note || '').trim()) throw new Error('Indica el área y qué ocurrió');
      record(project.id, { type: 'escape', area: body.area, areas: [body.area], note: String(body.note).slice(0, 500), pr: body.pr || null, by: String(body.by || '').slice(0, 80) });
      return send(res, 200, await ledgerView(project));
    }
    if (sub === 'chat' && method === 'POST') {
      const body = await readBody(req);
      const pr = await findPullRequest(project, body.pr);
      const brief = body.runId ? getRun(project.id, body.runId).brief : null;
      const plan = brief ? null : await planFor(project, pr, body.mode || 'rapido');
      let text = answer(String(body.question || ''), { brief, plan });
      let source = 'informe';
      if (!text && brief) { text = await askModel(String(body.question), brief); source = 'modelo'; }
      if (!text) { text = 'Puedo decirte qué he comprobado, qué no, qué tienes que leer y qué decides tú. Aprobar no lo hago: firmas tú.'; source = 'informe'; }
      return send(res, 200, { text, source });
    }
    if (sub === 'runs' && seg[3]) {
      const runId = seg[3];
      const action = seg[4];
      if (!action) {
        const r = await checkedRun(project, runId);
        return send(res, 200, { ...r, signed: r.signoff && r.brief && r.signatureValid !== false ? signedView(r.brief, r.signoff) : null });
      }
      if (action === 'versions') {
        const r = getRun(project.id, runId), i = r.brief?.input;
        if (!i?.proposed) throw new Error('Esta verificación no tiene versiones');
        return send(res, 200, await versionsOf(project, i.historicalBase || i.target, i.proposed, r));
      }
      if (action === 'continue' && method === 'POST') {
        const previous = await checkedRun(project, runId);
        if (previous.status !== 'done' || !previous.brief?.contract || !verifyIntegrity(previous.brief, path.join(previous.dir,'artifacts')).ok) throw new Error('La revisión anterior no tiene evidencia íntegra para continuar');
        const body = await readBody(req);
        const input = previous.brief.input;
        const pr = previous.prId.startsWith('ref:') ? { id:previous.prId,ref:input.proposedRef,branch:input.proposedRef,title:previous.branch,direction:'incoming' } : await findPullRequest(project, previous.prId);
        if(input.requirement?.id==='user-input') pr.requirementText=input.requirement.body;
        const next = await startRun({ ...project, base:input.targetRef }, pr, { mode:'completo', profile:body.profile || 'deep', resumeRunId:runId });
        return send(res,200,{runId:next.id,options:next.options});
      }
      if (action === 'events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        const write = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
        const r = getRun(project.id, runId);
        for (const e of r.events || []) write(e);
        if (r.status !== 'running') { write({ type: 'end', status: r.status }); return res.end(); }
        const off = subscribe(runId, (e) => { write(e); if (e.type === 'end') res.end(); });
        if (!off) { write({ type: 'end', status: 'done' }); return res.end(); }
        req.on('close', off);
        return undefined;
      }
      if (action === 'artifact') return send(res, 200, artifact(project.id, runId, url.searchParams.get('name') || ''), 'text/plain; charset=utf-8');
      if (action === 'report') {
        const r = await checkedRun(project, runId);
        return send(res, 200, markdown(r.brief, r.signatureValid === false ? null : r.signoff), 'text/markdown; charset=utf-8');
      }
      if (action === 'signoff' && method === 'POST') {
        const body = await readBody(req);
        const r = getRun(project.id, runId);
        const b = r.brief;
        if (!b) throw new Error('Esta verificación no tiene informe');
        // One decision per run: a second submit (double click, two tabs) must not add a second ledger entry.
        if (r.signoff) throw new Error('Esta verificación ya está firmada. Vuelve a verificar para decidir otra vez.');
        const signer = String(body.signer || '').trim();
        const risk = String(body.residualRisk || '').trim();
        const decision = body.decision === 'devolver' ? 'devolver' : 'aprobar';
        if (!signer) throw new Error('Falta tu nombre: la firma es de una persona.');
        if (decision === 'aprobar') {
          if (b.version >= 2) {
            const integrity = verifyIntegrity(b, path.join(r.dir, 'artifacts'));
            if (!integrity.ok) throw new Error(`Evidencia modificada: ${integrity.errors.join(', ')}`);
            if (b.verdict.status !== 'ready-for-human') throw new Error(`No se puede aprobar este informe: ${b.verdict.label}`);
            const head = await git(project.path, ['rev-parse', '--verify', `${b.input.proposedRef}^{commit}`]);
            const target = await git(project.path, ['rev-parse', '--verify', `${b.input.targetRef}^{commit}`]);
            if (head.stdout.trim() !== b.input.proposed || target.stdout.trim() !== b.input.target) throw new Error('El código o la base ha cambiado: vuelve a verificar');
          }
          const hard = b.rules.fired.filter((x) => ['conflicto', 'no-compila', 'suite-rota', 'tests-propios-fallan'].includes(x.id));
          if (hard.length) throw new Error(`No se puede aceptar: ${hard[0].title.toLowerCase()}. Devuélvelo al autor.`);
          const open = b.questions.filter((q) => !body.answers?.[q.id]);
          if (open.length) throw new Error(`Quedan ${open.length} pregunta(s) sin responder.`);
          if (b.residue.items.length && !body.checks?.residue) throw new Error('Confirma que has leído el residuo.');
          if (!body.checks?.notChecked) throw new Error('Confirma que has revisado lo que no se ha comprobado.');
          if (risk.length < 20) throw new Error('Escribe con tus palabras el riesgo residual que aceptas (al menos una frase).');
        }
        const signoff = {
          signer, decision, answers: body.answers || {}, checks: body.checks || {}, residualRisk: risk || '(devuelto al autor)',
          briefHash: sha256(JSON.stringify(b)), binding: b.binding, contractHash: b.contract?.hash, head: b.pr.head, lane: b.lane.id, auditRequired: !!b.audit && decision === 'aprobar',
          ts: new Date().toISOString(),
        };
        saveSignoff(project.id, runId, signoff);
        if (decision === 'aprobar') {
          record(project.id, {
            type: 'signoff', pr: b.pr.id, branch: b.pr.branch, head: b.pr.head, runId, lane: b.lane.id, signer, answers: signoff.answers,
            residualRisk: risk, briefHash: signoff.briefHash, areas: (b.areas || []).map((a) => a.area), read: b.residue.lines, total: b.totals.lines,
            minutesToSign: Math.max(0, Math.round((Date.now() - Date.parse(b.createdAt)) / 60000)), auditRequired: signoff.auditRequired,
          });
        } else {
          record(project.id, { type: 'returned', pr: b.pr.id, head: b.pr.head, runId, signer, answers: signoff.answers, areas: [] });
        }
        return send(res, 200, { signoff, ...signedView(b, signoff) });
      }
      if (action === 'attach' && method === 'POST') {
        // Attach the brief to the commit as a git note, so it travels with the branch. Only on explicit request.
        const r = await checkedRun(project, runId);
        const file = path.join(r.dir, 'note.md');
        fs.writeFileSync(file, markdown(r.brief, r.signatureValid === false ? null : r.signoff));
        await git(project.path, ['notes', '--ref=katse', 'add', '-f', '-F', file, r.brief.pr.head]);
        return send(res, 200, { ok: true, ref: 'refs/notes/katse', commit: r.brief.pr.head, push: 'git push origin refs/notes/katse' });
      }
    }
  }
  return send(res, 404, { error: 'Ruta desconocida' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const rel = url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, '').replace(/^\/+/, '');
    const file = path.join(UI, rel);
    if (!file.startsWith(UI) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'No encontrado', 'text/plain');
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    if (!res.headersSent) send(res, 400, { error: e.message });
    else res.end();
    return undefined;
  }
});

// Register the bundled demo repository on first start so there is something to look at.
const demo = path.join(ROOT, 'workspace', 'messagepack-csharp');
if (!listProjects().length && fs.existsSync(demo)) await addProject(demo).catch(() => {});

server.listen(PORT, '127.0.0.1', () => console.log(`Katse en http://localhost:${PORT}`));
