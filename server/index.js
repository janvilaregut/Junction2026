#!/usr/bin/env node
// HTTP server: static UI + JSON API + live events. Listens on localhost only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, sha256 } from './util.js';
import { ask, clis } from './llm.js';
import { git } from './git.js';
import { listProjects, getProject, addProject, cloneProject, updateProject, removeProject, listPullRequests, findPullRequest, projectStatus } from './projects.js';
import { startRun, getRun, subscribe, activeRun, artifact, latestByPr, latestBriefs, saveSignoff } from './runs.js';
import { intake, replicaBudget } from './pipeline/run.js';
import { addedTestNames } from './pipeline/classify.js';
import { availableAgents } from './pipeline/replicas.js';
import { areaStates, areasOf, metrics, record, entries, K_EARN } from './ledger.js';
import { markdown, trailers, answer } from './report.js';
import { savePrompt } from './requirements.js';

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

/** What a verification will and will not do for this PR, computed without running anything. */
async function planFor(project, pr, mode) {
  const it = await intake(project, pr);
  const agents = await availableAgents();
  const tests = addedTestNames(it.files.filter((f) => f.kind === 'test'));
  const derived = it.files.filter((f) => f.kind === 'derived').length;
  const src = it.files.filter((f) => f.kind === 'source').length;
  const full = mode === 'completo';
  const budget = replicaBudget(it.files);
  const will = [
    `Mezclar ${pr.branch} sobre ${project.base} en una copia aislada (tu repo no se toca)`,
    it.toolchain.kind !== 'none' ? `Compilar y pasar los tests afectados (${it.toolchain.describe})` : null,
    tests.length ? `Comprobar que los ${tests.length} tests nuevos fallan sin el cambio y pasan con él` : null,
    derived ? `Analizar ${derived} ficheros derivados: cambio repetido y anomalías` : null,
    src && it.toolchain.kind !== 'none' ? 'Sembrar defectos en las líneas cambiadas y ver si algún test los detecta' : null,
    src && it.toolchain.kind !== 'none' ? 'Rebobinar: quitar cada cambio de código de uno en uno y ver si algún test lo nota' : null,
    full && agents.length ? `Rehacer el cambio a ciegas con ${budget.n} ${budget.n === 1 ? 'agente' : 'agentes'}, ${budget.formula}, cada uno con una misión distinta, y comparar` : null,
    full && agents.length && tests.length ? 'Cruzar tests: los del PR contra cada réplica y los de cada réplica contra el PR' : null,
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
  };
}

async function askModel(question, brief) {
  const slim = { lane: brief.lane, rules: brief.rules.fired, claims: brief.claims.map(({ evidence, ...c }) => c), questions: brief.questions, residue: { lines: brief.residue.lines, total: brief.residue.total, items: brief.residue.items.map(({ code, ...i }) => i) }, notChecked: brief.notChecked, requirement: brief.requirement, totals: brief.totals, replicas: brief.l3?.replicas?.map((r) => ({ label: r.label, ok: r.ok, summary: r.summary, decisions: r.decisions })) };
  const prompt = `Eres el asistente de una herramienta de verificación de pull requests. Responde en español, en 2 a 5 frases, sin formato, usando SOLO los datos de este informe. Si el informe no lo dice, di que no está comprobado. Nunca digas que el cambio está bien, es correcto o se puede aprobar: eso lo decide la persona.\n\nINFORME:\n${JSON.stringify(slim).slice(0, 24_000)}\n\nPREGUNTA: ${question.slice(0, 600)}`;
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

async function api(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean).slice(1); // after "api"
  const method = req.method;

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
    if (sub === 'plan') {
      const pr = await findPullRequest(project, url.searchParams.get('pr'));
      return send(res, 200, await planFor(project, pr, url.searchParams.get('mode') || 'rapido'));
    }
    if (sub === 'verify' && method === 'POST') {
      const body = await readBody(req);
      const pr = await findPullRequest(project, body.pr);
      const run = await startRun(project, pr, body.options || {});
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
        const r = getRun(project.id, runId);
        return send(res, 200, { ...r, signed: r.signoff && r.brief ? signedView(r.brief, r.signoff) : null });
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
        const r = getRun(project.id, runId);
        return send(res, 200, markdown(r.brief, r.signoff), 'text/markdown; charset=utf-8');
      }
      if (action === 'signoff' && method === 'POST') {
        const body = await readBody(req);
        const r = getRun(project.id, runId);
        const b = r.brief;
        if (!b) throw new Error('Esta verificación no tiene informe');
        const signer = String(body.signer || '').trim();
        const risk = String(body.residualRisk || '').trim();
        const decision = body.decision === 'devolver' ? 'devolver' : 'aprobar';
        if (!signer) throw new Error('Falta tu nombre: la firma es de una persona.');
        if (decision === 'aprobar') {
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
          briefHash: sha256(JSON.stringify(b)), head: b.pr.head, lane: b.lane.id, auditRequired: !!b.audit && decision === 'aprobar',
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
        const r = getRun(project.id, runId);
        const file = path.join(r.dir, 'note.md');
        fs.writeFileSync(file, markdown(r.brief, r.signoff));
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
