/* What the voice assistant can see and do in the app. Tools call the globals of app.js (S is a top-level const there,
   so it is read as S, not window.S). createTools({ act, end }) returns the Gemini Live declarations and their handlers;
   act(text, tone) shows a short note of what was done, end() closes the conversation. */
const app = () => (typeof S !== 'undefined' ? S : null);
const call = (name, ...a) => (typeof window[name] === 'function' ? window[name](...a) : undefined);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createTools({ act, end }) {
const T = (props = {}, required = []) => ({ type: 'OBJECT', properties: props, ...(required.length ? { required } : {}) });
const TOOLS = [
  { name: 'get_screen', description: 'What the user is looking at right now: home (branch tree), the graph of one pull request, or its review (the tree of agents and the verdict card); plus that PR and its verification summary. Call it whenever the user says "this", "here" or you are unsure.', parameters: T() },
  { name: 'list_pull_requests', description: 'List the pull requests (branches) of the current project with their verification state, and point at them on screen. By default only the active ones (recent or already verified); older stale branches only if include_old is true.', parameters: T({ direction: { type: 'STRING', enum: ['incoming', 'outgoing', 'all'], description: 'incoming = others want to merge into the base; outgoing = the user\'s own branches. Default all.' }, include_old: { type: 'BOOLEAN', description: 'Also include old, stale branches. Default false.' } }) },
  { name: 'highlight_pull_requests', description: 'Point at specific pull requests in the branch tree (dims the rest). Empty list clears.', parameters: T({ ids: { type: 'ARRAY', items: { type: 'STRING' }, description: 'PR ids from list_pull_requests' } }, ['ids']) },
  { name: 'open_pull_request', description: 'Open one pull request full screen. Accepts its id, branch, number, a word from its title, or an ordinal like "first"/"second".', parameters: T({ query: { type: 'STRING' } }, ['query']) },
  { name: 'go_home', description: 'Close the pull request and go back to the branch tree.', parameters: T() },
  { name: 'get_verification_details', description: 'Details of the current pull request verification, for explaining it: verdict lane, recommendation, what was checked and how (tests red-before/green-after, seeded defects, rewind, blind replicas), what was NOT checked and why, the lines the human must read, and the open questions.', parameters: T({ section: { type: 'STRING', enum: ['summary', 'checked', 'not_checked', 'residue', 'questions', 'all'] } }) },
  { name: 'open_review', description: 'Review & sign: open the review of the open pull request as the agents\' tree, growing out of a spot. Each AI agent that rebuilt the change from the ticket (without seeing the PR) is a branch with twigs for what it touched; when two branches meet the camera zooms in and the two agents argue; the attacker brings its test; everything merges into one trunk that ends in the verdict card, where the user signs (or sends it back, with the agents\' fix if the review found a problem). Use it when the user asks to review, check, prove, fix something, or whether it works. If the branch has no full review yet this STARTS one (minutes, real cost): ask for a yes first. Returns the story so you can narrate it.', parameters: T({ query: { type: 'STRING', description: 'The spot: a line like "985" or "TypeCollector.cs:985", a file name, or empty for the whole change.' } }) },
  { name: 'start_verification', description: 'Start the real review of the current pull request: contract, alternatives rebuilt from the base by AI agents, their debate, attacks on the PR and a judge with a 0-10 score. Profiles: quick (90 s, no alternatives), standard (5 min, default), deep (15 min). Ask the user to confirm first.', parameters: T({ profile: { type: 'STRING', enum: ['quick', 'standard', 'deep'] } }) },
  { name: 'get_consensus', description: 'Results of the multi-agent consensus for the current pull request: several Gemini agents solved the same requirement blind, a heatmap compared their code zone by zone with the PR, then they debated in pairs until a consensus. Returns agents, where they agreed/disagreed, each debate argument and who convinced whom, and the verdict (coincide = PR matches the consensus, difiere = the consensus proposes something else, dudoso = no clear majority).', parameters: T() },
  { name: 'start_consensus', description: 'Start a multi-agent consensus check on the current pull request (takes ~15 minutes). Ask the user to confirm first.', parameters: T() },
  { name: 'open_consensus', description: 'Open the raw technical consensus report page (heatmap, full arguments) for the current pull request. For the visual story of the agents use show_agent_debate instead.', parameters: T() },
  { name: 'show_commits', description: 'Unfold one branch in the tree so all its commits show on a long rail (the other branches fold away). Use when the user asks for the commits / history of a branch. query: id, branch, number, a word from its title, or empty for the one open or in focus.', parameters: T({ query: { type: 'STRING' } }) },
  { name: 'show_all_branches', description: 'Fold the commits back (or zoom back out) and show every branch in the tree again.', parameters: T() },
  { name: 'zoom_branch', description: 'Zoom the home tree\'s camera into one branch: a close-up of where it starts and its first commits, big, on one glowing line (the user can then slide along it). Use when the user asks to zoom in on, enlarge or magnify a branch ("amplíame la rama", "acércate a esa rama"). query: id, branch, number, a word from its title, or empty for the one in focus.', parameters: T({ query: { type: 'STRING' } }) },
  { name: 'focus_graph', description: 'Inside the open pull request graph: fly the camera to a node or group and light it up while you talk about it. query: a file name, "Tests", "Builds", "Mutation", a line like "Foo.cs:120", an agent, or a group: "what I must read" (red), "decisions" (yellow), "reproduced" (green), "checks", "files", "agents", "whole" (the core). Call it EVERY time you start explaining a specific part of the graph.', parameters: T({ query: { type: 'STRING' } }, ['query']) },
  { name: 'zoom_graph', description: 'Move the graph camera: "in" (closer), "out" (further), "overview" (back to the whole graph, clears the highlight).', parameters: T({ action: { type: 'STRING', enum: ['in', 'out', 'overview'] } }, ['action']) },
  { name: 'show_agent_debate', description: 'Dive into the animated story of the AI agents for the open pull request: bubbles that solve it blind, compare, argue round by round (they meet, merge when they agree, the convinced one takes the winner\'s colour) and reach a consensus. Use when the user asks how the agents are doing, how they debated, who convinced whom, or to see the agents. It plays by itself; returns the story so you can narrate it. Uses the REAL review run of the PR when it has one (alternatives from the base, their debate, the attacks on the PR and the judge); otherwise a sample (say so).', parameters: T() },
  { name: 'debate_step', description: 'Move through the agents story: next, previous, restart, or jump to a chapter: agents, solve, compare, debate, verdict.', parameters: T({ to: { type: 'STRING', enum: ['next', 'previous', 'restart', 'agents', 'solve', 'compare', 'debate', 'verdict'] } }, ['to']) },
  { name: 'open_agent', description: 'In the agents story: dive into one agent (its bubble fills the screen with its details, arguments and how its debates went). name as shown: in a real run "C1 Hydrogen"/"Hydrogen", "Attacker", "Judge", "The PR"; in a sample run Precise, Steady, Balanced, Curious, Bold.', parameters: T({ name: { type: 'STRING' } }, ['name']) },
  { name: 'close_agent', description: 'Leave the agent detail and go back to all the agents.', parameters: T() },
  { name: 'leave_debate', description: 'Leave the agents story and go back to the pull request graph.', parameters: T() },
  { name: 'end_conversation', description: 'Close the voice conversation: call it when the user says goodbye, thanks that is all, stop, or that they are done ("gracias, ya está", "eso es todo", "para").', parameters: T() },
];
TOOLS.push(
  { name: 'review_step', description: 'In the review tree: "skip" jumps to the verdict, "replay" plays it again.', parameters: T({ to: { type: 'STRING', enum: ['skip', 'replay'] } }, ['to']) },
  { name: 'leave_review', description: 'Leave the review tree and go back to the graph.', parameters: T() },
  { name: 'where_to_look', description: 'The spots of code the user should read first (the red "you read it" regions of the graph, where no agent reproduced the PR), lit up in the graph. Use it for "where do I start", "what should I review", "what is risky".', parameters: T() },
  { name: 'show_code', description: 'Fly the graph to one code region and return its code (removed and added lines) and which agents also wrote it. query: a line like "1429" or "TypeCollector.cs:985", or a file name. For understanding, not fixing.', parameters: T({ query: { type: 'STRING' } }, ['query']) },
  { name: 'ask_agent', description: 'What one agent did and said in the review: C1, C2 (agents that rebuilt the change from the base), the PR, the attacker, or the judge.', parameters: T({ name: { type: 'STRING' } }, ['name']) },
  { name: 'look_deeper', description: 'The user wants the change looked at harder: launches a Deep review (up to 15 min, real cost). ASK FOR A YES FIRST.', parameters: T() },
);
const RETIRED = new Set(['show_agent_debate', 'debate_step', 'open_agent', 'close_agent', 'leave_debate']); // Fix it tells that story now
for (let i = TOOLS.length - 1; i >= 0; i--) if (RETIRED.has(TOOLS[i].name)) TOOLS.splice(i, 1);
for (const t of TOOLS) t.behavior = 'BLOCKING';

function allPRs() {
  const s = app(); if (!s) return [];
  return [...(s.prs?.incoming || []).map((p) => ({ ...p, yours: false })), ...(s.prs?.outgoing || []).map((p) => ({ ...p, yours: true }))];
}
function prState(p) { try { return typeof state === 'function' ? state(p).label : (p.last?.laneName || 'Not verified'); } catch { return p.last?.laneName || 'Not verified'; } }
const prBrief = (p, i) => ({ ordinal: i + 1, id: p.id, branch: p.branch, title: p.title, yours: !!p.yours, state: prState(p), verifying: !!p.running, linesForHuman: p.last ? `${p.last.residue} of ${p.last.total}` : null, commitsAhead: p.ahead, date: p.date });
function view() {
  const full = document.getElementById('full');
  if (full && !full.hidden && call('treeOpen')) return 'review';
  if (full && !full.hidden && call('agentOpen')) return 'agent';
  if (full && !full.hidden && call('debateOpen')) return 'debate';
  if (full && !full.hidden) return 'graph';
  if (app()?.focus) return 'commits';
  if (app()?.zoom) return 'zoom';
  return 'home';
}
const inGraph = () => ['graph', 'review', 'debate', 'agent'].includes(view());
function graphSummary() {
  const g = typeof G !== 'undefined' ? G : null; if (!g) return null;
  return [...g.nodes.values()].slice(0, 40).map((n) => ({ label: n.label, kind: n.kind, file: n.file, state: n.info }));
}
function findPR(q) {
  const list = allPRs(); const s = String(q || '').toLowerCase().trim();
  const ord = { first: 0, primero: 0, primera: 0, second: 1, segundo: 1, segunda: 1, third: 2, tercero: 2, tercera: 2, last: list.length - 1, último: list.length - 1, ultimo: list.length - 1 };
  for (const [k, i] of Object.entries(ord)) if (s.includes(k)) return list[i];
  if (/^\d+$/.test(s) && Number(s) <= list.length && Number(s) < 100) return list[Number(s) - 1];
  return list.find((p) => p.id.toLowerCase() === s) || list.find((p) => p.branch.toLowerCase() === s)
    || list.find((p) => p.branch.toLowerCase().includes(s) || (p.requirement && String(p.requirement) === s.replace('#', '')))
    || list.find((p) => (p.title || '').toLowerCase().includes(s))
    || list.find((p) => s.split(/\s+/).filter((w) => w.length > 2).some((w) => p.branch.toLowerCase().includes(w) || (p.title || '').toLowerCase().includes(w)));
}
async function waitFor(cond, ms = 6000) { const t = performance.now(); while (!cond() && performance.now() - t < ms) await sleep(80); return cond(); }
const clip = (s, n = 400) => (s && String(s).length > n ? String(s).slice(0, n) + '…' : s);
function briefOf(b, section = 'summary') {
  if (!b) return null;
  const out = { lane: b.lane?.name || b.lane?.id, laneId: b.lane?.id, laneMeaning: b.lane?.summary, recommendation: b.recommendation?.name, linesForHuman: b.residue?.lines, totalLines: b.totals?.lines, minutes: b.timing?.totalMs ? Math.round(b.timing.totalMs / 6000) / 10 : null };
  const want = (k) => section === 'all' || section === k || (section === 'summary' && k !== 'residue');
  if (want('checked')) out.checked = (b.claims || []).slice(0, 14).map((c) => ({ status: c.status, what: clip(c.text, 300) }));
  if (want('not_checked')) out.notChecked = (b.notChecked || []).slice(0, 10).map((n) => ({ what: n.what, why: clip(n.why, 240) }));
  if (want('questions')) out.questions = (b.questions || []).map((q) => ({ question: clip(q.text, 300), options: q.options }));
  if (want('residue') || section === 'summary') out.toRead = (b.residue?.items || []).slice(0, section === 'summary' ? 4 : 10).map((i) => ({ where: `${i.file}:${i.start}${i.end !== i.start ? '-' + i.end : ''}`, lines: i.lines, why: clip(i.reason || i.why || '', 200), code: section === 'summary' ? undefined : clip((i.code || []).map((c) => [...c.removed.map((l) => '- ' + l), ...c.added.map((l) => '+ ' + l)].join('\n')).join('\n'), 700) }));
  if (b.version >= 2 && b.verdict) { // the real review pipeline: judge, attacks, debate, alternatives
    const v = b.verdict;
    out.review = {
      verdict: v.status, label: v.label, score: v.score?.value ?? null, scoreParts: (v.score?.components || []).map((c) => `${c.label}: ${c.earned}/${c.max} (${clip(c.reason, 160)})`), caps: (v.score?.caps || []).map((c) => `max ${c.max}: ${clip(c.reason, 160)}`),
      blockers: (v.pending || []).map((x) => clip(x, 200)), judge: clip(v.semantic?.explanation, 600),
      attacks: (v.findings || []).map((f) => ({ id: f.attack, result: f.classification, hypothesis: clip(f.hypothesis, 260), outcomes: (f.outcomes || []).map((o) => `${o.version}: ${o.outcome}`) })),
      debate: (Array.isArray(b.debate) ? b.debate : []).filter((d) => d.status !== 'incomplete').map((d) => ({ by: d.candidate, model: d.model, round: d.round, strength: clip(d.strength, 220), risk: clip(d.risk, 220), revision: clip(d.revision, 220) })),
      alternatives: (b.candidates || []).map((c) => ({ id: c.id, model: c.model, status: c.status })),
      budget: b.budget ? { profile: b.options?.profile, seconds: Math.round((b.budget.elapsedMs || 0) / 1000), tokens: b.budget.accounting?.observed ?? b.budget.tokens } : null,
      models: b.providers?.models, unavailable: b.providers?.errors,
    };
  }
  const known = new Set(['lane', 'recommendation', 'residue', 'totals', 'timing', 'claims', 'notChecked', 'questions', 'pr', 'cost', 'version', 'verdict', 'contract', 'candidates', 'attacks', 'evidence', 'budget', 'debate', 'input', 'environment', 'finalMissions', 'analysis', 'providers', 'continuation', 'artifactManifest']);
  out.otherSections = Object.keys(b).filter((k) => !known.has(k)).slice(0, 20);
  return out;
}
async function consensusFor(p) {
  const r = await fetch('/api/consenso'); if (!r.ok) return { available: false, note: 'The consensus engine is not installed on this server yet.' };
  const runs = (await r.json()).filter((x) => x.branch === p.branch);
  if (!runs.length) return { available: true, found: false };
  const c = await (await fetch(`/api/consenso/${encodeURIComponent(runs[0].id)}`)).json();
  const sol = c.solutions || {};
  return {
    available: true, found: true, id: c.id, status: c.status, model: c.model,
    agents: (c.agents || []).map((a) => ({ id: a.id, name: a.name, role: a.role, temperature: a.temperature, topP: a.topP, topK: a.topK, files: sol[a.id]?.files, summary: clip(sol[a.id]?.summary, 260), finished: sol[a.id]?.ok !== false, error: sol[a.id]?.error })),
    heatmap: (c.heatmap?.zones || []).slice(0, 12).map((z) => ({ where: `${z.file}${z.newFile ? ' (new)' : `:${z.start}-${z.end}`}`, agreement: Math.round(z.agreement * 100) + '%', differFromPR: Object.entries(z.cells || {}).filter(([id, v]) => id !== 'PR' && v.same_as_pr === false).map(([id]) => id) })),
    debates: (c.rounds || []).map((d) => ({ round: d.round, pair: d.pair, outcome: d.hold ? 'nobody convinced the other' : d.kind === 'equivalent' ? `${d.winner} and ${d.loser} are equivalent` : `${d.winner} convinced ${d.loser}`, reason: clip(d.reason, 300), arguments: Object.fromEntries(Object.entries(d.arguments || {}).map(([k, v]) => [k, { argument: clip(v.argument || v.argumento, 420), flaws: (v.rival_flaws || v.fallos_rival || []).slice(0, 3) }])) })),
    verdict: c.verdict ? { verdict: c.verdict.verdict, confidence: c.verdict.confidence, majority: c.verdict.members, prInConsensus: c.verdict.prInConsensus, prConceded: c.verdict.prConceded, summary: c.verdict.summary, issues: c.verdict.issues } : null,
  };
}
let overlay = null;
function showConsensus(id) {
  overlay?.remove();
  overlay = document.createElement('div'); overlay.className = 'm-overlay';
  overlay.innerHTML = `<div class="m-sheet"><button class="m-x" type="button" aria-label="Close">×</button><iframe title="Consensus" src="/consenso.html?id=${encodeURIComponent(id)}"></iframe></div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('on'));
  const close = () => { overlay?.classList.remove('on'); const o = overlay; overlay = null; setTimeout(() => o?.remove(), 400); };
  overlay.querySelector('.m-x').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
}

const TOOL_FN = {
  async get_screen() {
    const s = app(); const v = view(); const p = s?.cur && v !== 'home' ? s.cur : null;
    const project = s?.projects?.find((x) => x.id === s.pid);
    const f = v === 'commits' ? s.focus : v === 'zoom' ? s.zoom : null;
    return {
      view: v, project: project?.name, base: s?.base, pullRequest: p ? prBrief(p, allPRs().findIndex((x) => x.id === p.id)) : null, verification: p ? briefOf(s.run?.brief, 'summary') : null, verifyingNow: !!s?.es,
      graphNodes: v === 'graph' ? graphSummary() : undefined,
      commitsShown: f ? { branch: allPRs().find((x) => x.id === f.id)?.branch, total: f.total, commits: f.commits.map((c) => ({ sha: c.sha.slice(0, 7), subject: c.subject, author: c.author, date: c.date })) } : undefined,
      agentsStory: v === 'debate' || v === 'agent' ? call('debateInfo') : undefined,
      review: v === 'review' ? call('treeInfo') : undefined,
    };
  },
  async list_pull_requests({ direction = 'all', include_old = false } = {}) {
    const all = allPRs();
    const active = (p) => p.yours || p.last || p.running || (!p.behind && Date.now() - new Date(p.date) < 30 * 864e5);
    let list = direction === 'incoming' ? all.filter((p) => !p.yours) : direction === 'outgoing' ? all.filter((p) => p.yours) : all;
    const old = list.filter((p) => !active(p)).length;
    if (!include_old) list = list.filter(active);
    if (inGraph()) { call('closeGraph'); await sleep(780); }
    call('highlightLanes', list.map((p) => p.id));
    act(`Showing ${list.length} pull request${list.length === 1 ? '' : 's'}`);
    return { count: list.length, olderNotShown: include_old ? 0 : old, pullRequests: list.slice(0, 25).map((p) => prBrief(p, all.findIndex((x) => x.id === p.id))) };
  },
  async highlight_pull_requests({ ids = [] }) { if (inGraph()) { call('closeGraph'); await sleep(780); } call('highlightLanes', ids); return { ok: true }; },
  async open_pull_request({ query }) {
    const p = findPR(query);
    if (!p) return { error: `No pull request matches "${query}".`, available: allPRs().map((x) => x.branch).slice(0, 20) };
    const s = app();
    if (inGraph() && s?.cur?.id === p.id) { call('closeDebate'); return { alreadyOpen: true, pullRequest: prBrief(p, allPRs().findIndex((x) => x.id === p.id)) }; }
    if (inGraph()) { call('closeGraph'); await sleep(780); }
    if (s?.focus && s.focus.id !== p.id) { call('hideCommits'); await sleep(900); }
    if (s?.zoom && s.zoom.id !== p.id) { call('hideCommits'); await sleep(1100); }
    if (!s?.focus && !s?.zoom) { call('highlightLanes', [p.id]); await sleep(420); call('highlightLanes', []); }
    call('openGraph', p); // grows out of the branch's own dot in the tree
    act(`Opened ${p.branch}`);
    await waitFor(() => app()?.run?.brief || app()?.plan, 8000);
    return { opened: true, pullRequest: prBrief(p, allPRs().findIndex((x) => x.id === p.id)), verification: briefOf(app()?.run?.brief, 'summary'), notVerifiedYet: !app()?.run?.brief };
  },
  async go_home() { const was = inGraph(); call('closeGraph'); if (!was) call('hideCommits'); act('Back home'); return { ok: true }; },
  async show_commits({ query = '' } = {}) {
    const s = app();
    const p = query ? findPR(query) : allPRs().find((x) => x.id === (s?.focus?.id || s?.cur?.id));
    if (!p) return { error: query ? `No pull request matches "${query}".` : 'Which branch? Give a name.', available: allPRs().map((x) => x.branch).slice(0, 20) };
    const r = await call('showCommits', p.id);
    if (!r) return { error: 'Could not show the commits.' };
    act(`${r.total} commit${r.total === 1 ? '' : 's'} · ${p.branch}`);
    return { branch: p.branch, total: r.total, shown: r.commits.length, commits: r.commits.map((c) => ({ sha: c.sha.slice(0, 7), subject: c.subject, author: c.author, date: c.date })), tip: 'The newest commit is at the right end; open_pull_request opens the branch from there.' };
  },
  async zoom_branch({ query = '' } = {}) {
    const s = app();
    const p = query ? findPR(query) : allPRs().find((x) => x.id === (s?.zoom?.id || s?.focus?.id || s?.cur?.id));
    if (!p) return { error: query ? `No pull request matches "${query}".` : 'Which branch? Give a name.', available: allPRs().map((x) => x.branch).slice(0, 20) };
    const r = await call('zoomBranch', p.id);
    if (!r) return { error: 'Could not zoom into that branch.' };
    act(`Zoomed into ${p.branch}`);
    return { branch: p.branch, total: r.total, shown: r.commits.length, firstCommits: r.commits.slice(0, 6).map((c) => ({ sha: c.sha.slice(0, 7), subject: c.subject, author: c.author, date: c.date })), tip: 'Oldest commit on the left, where the branch leaves the base; the newest (filled dot) opens the branch. The user can slide along with the wheel or by dragging. show_all_branches zooms back out.' };
  },
  async show_all_branches() { if (inGraph()) { call('closeGraph'); await sleep(780); } call('hideCommits'); act('All branches'); return { ok: true }; },
  async focus_graph({ query }) {
    if (!inGraph()) return { error: 'No pull request is open. Open one first.' };
    if (call('debateOpen')) { call('closeDebate'); await sleep(500); }
    if (call('treeOpen')) { call('closeTree'); await sleep(700); }
    const list = call('focusGraph', query);
    if (!list) return { error: `Nothing in the graph matches "${query}".`, nodes: graphSummary() };
    act(list.length === 1 ? `Looking at ${list[0].label}` : `Looking at ${list.length} nodes`);
    const nb = (n) => G.links.filter((l) => l.a === n || l.b === n).map((l) => (l.a === n ? l.b : l.a).label);
    return { focused: list.map((n) => ({ label: n.label, kind: n.kind, file: n.file, state: n.info, connectedTo: nb(n).slice(0, 8) })) };
  },
  async zoom_graph({ action }) {
    if (!inGraph()) return { error: 'No pull request is open.' };
    if (call('debateOpen')) { call('closeDebate'); await sleep(400); }
    call('zoomGraph', action === 'overview' ? 'fit' : action);
    return { ok: true };
  },
  async show_agent_debate() {
    if (!inGraph()) return { error: 'Open a pull request first.' };
    if (!call('openDebate')) return { error: 'Could not open the agents view.' };
    act('Agents debating');
    return call('debateInfo');
  },
  async debate_step({ to }) {
    if (!call('debateOpen')) return { error: 'The agents story is not open. Call show_agent_debate first.' };
    return { chapter: call('debateGo', to) };
  },
  async open_agent({ name: who }) {
    if (!call('debateOpen')) { if (!inGraph()) return { error: 'Open a pull request first.' }; call('openDebate'); await sleep(900); }
    const a = call('openAgent', who);
    if (!a) return { error: `No agent called "${who}".`, agents: call('debateInfo')?.agents?.map((x) => x.name) };
    act(`Inside ${a.name}`);
    const info = call('debateInfo');
    return { agent: a.name, role: a.role, about: a.meta, stats: a.stats, says: a.quote, temperature: a.temperature, debates: info.rounds.filter((r) => r.pair.includes(a.name)), sample: info.sample };
  },
  async close_agent() { return { ok: !!call('closeAgent') }; },
  async review_step({ to }) { if (!call('treeOpen')) return { error: 'The review is not open. Call open_review first.' }; return { ok: !!call(to === 'skip' ? 'treeSkip' : 'treeReplay') }; },
  async leave_review() { call('closeTree'); act('Back to the graph'); return { ok: true }; },
  async where_to_look() {
    if (!inGraph()) return { error: 'Open a pull request first.' };
    if (call('treeOpen')) { call('closeTree'); await sleep(700); }
    const list = call('focusGraph', 'what I must read');
    if (!list) return { error: 'No red regions: nothing is left only for the human, or the branch is not verified yet.', nodes: graphSummary() };
    act(`${list.length} spot${list.length === 1 ? '' : 's'} to read`);
    return { read: list.map((n) => ({ where: `${n.file || ''}:${n.start ?? ''}`, why: n.info })), tip: 'Explain the first one in plain words; show_code opens its code.' };
  },
  async show_code({ query }) {
    if (!inGraph()) return { error: 'Open a pull request first.' };
    if (call('treeOpen')) { call('closeTree'); await sleep(700); }
    const list = call('focusGraph', query);
    const s = app(), r = s?.run;
    const m = String(query || '').match(/(?:([\w.-]+\.\w+)\s*)?:?\s*(\d+)/);
    try {
      const data = await (await fetch(r?.brief?.version >= 2 ? `/api/projects/${s.pid}/runs/${r.id}/versions` : `/api/projects/${s.pid}/versions?pr=${encodeURIComponent(s.cur.id)}`)).json();
      const q = String(query || '').toLowerCase();
      const pool = (data.regions || []).filter((x) => !m?.[1] && !m ? x.file.toLowerCase().includes(q) : !m[1] || x.file.toLowerCase().includes(m[1].toLowerCase()));
      const reg = m ? pool.sort((a, b) => Math.abs(a.start - m[2]) - Math.abs(b.start - m[2]))[0] : pool[0];
      if (!reg) return { error: `No code region matches "${query}".`, focused: !!list };
      act(`${reg.file.split('/').pop()}:${reg.start}`);
      return { where: `${reg.file}:${reg.start}-${reg.end}`, alsoWrittenBy: reg.who, code: [...reg.removed.map((x) => '- ' + x), ...reg.added.map((x) => '+ ' + x)].slice(0, 30).join('\n') };
    } catch (e) { return { error: e.message, focused: !!list }; }
  },
  async ask_agent({ name: who }) {
    const b = app()?.run?.brief;
    if (!b || !(b.version >= 2)) return { error: 'This branch has no full review yet: no agents to ask.' };
    const w = String(who || '').toLowerCase();
    if (/judge|juez/.test(w)) return { agent: 'judge', score: b.verdict?.score?.value ?? null, verdict: b.verdict?.status, says: b.verdict?.semantic?.explanation || null };
    if (/attack|atac/.test(w)) return { agent: 'attacker', attacks: (b.attacks || []).map((a) => ({ hypothesis: a.hypothesis, status: a.status })), findings: (b.verdict?.findings || []).map((f) => ({ classification: f.classification, outcomes: (f.outcomes || []).map((o) => `${o.version}: ${o.outcome}`) })) };
    if (/\bpr\b|original/.test(w)) { const e = (b.evidence || []).filter((x) => x.version === 'original').pop(); return { agent: 'the PR', tests: e ? `${e.status} (${e.ran} tests)` : null }; }
    const c = (b.candidates || []).find((x) => w.includes(x.id.toLowerCase()) || w.includes(String(x.model).split('-').pop()));
    if (!c) return { error: `No agent called "${who}".`, agents: (b.candidates || []).map((x) => x.id) };
    const deb = (Array.isArray(b.debate) ? b.debate : b.debate?.entries || []).filter((d) => d.candidate === c.id);
    const e = (b.evidence || []).filter((x) => x.version === c.id).pop();
    return { agent: c.id, model: c.model, status: c.status, summary: c.summary, tests: e ? `${e.status} (${e.ran} tests)` : null, said: deb.map((d) => ({ round: d.round, strength: d.strength, risk: d.risk, revision: d.revision })) };
  },
  async look_deeper() {
    const s = app(); if (!s?.cur || !inGraph()) return { error: 'Open a pull request first.' };
    s.profile = 'deep';
    const started = (await call('verify')) !== false;
    if (started) act('Deep review started');
    return { started };
  },
  async leave_debate() { call('closeDebate'); act('Back to the graph'); return { ok: true }; },
  async get_verification_details({ section = 'summary' } = {}) {
    const s = app();
    if (!s?.cur || view() === 'home') return { error: 'No pull request is open. Open one first.' };
    if (!s.run?.brief) return { verified: false, note: 'This pull request has not been verified yet.', plan: s.plan ? { files: s.plan.totals?.files, added: s.plan.totals?.added, removed: s.plan.totals?.removed } : null };
    return { pullRequest: s.cur.branch, ...briefOf(s.run.brief, section) };
  },
  async open_review({ query = '' } = {}) {
    if (!inGraph()) return { error: 'Open a pull request first.' };
    if (call('debateOpen')) call('closeDebate');
    const r = await call('openTree', { query });
    if (!r) return { error: 'Could not open the review.' };
    if (r.error) return r;
    act(r.spot ? `Review · ${r.spot.where}` : 'Review');
    return { ...r, note: r.live ? 'A real review is running now: the tree grows live and continues with the debate and verdict when it ends (minutes). Say so.' : 'Narrate it while it plays: who rebuilt it, the debate, the attack, the verdict; at the end the user signs in the card.' };
  },
  async start_verification({ profile = 'standard' } = {}) {
    const s = app(); if (!s?.cur || !inGraph()) return { error: 'Open a pull request first.' };
    if (call('debateOpen')) call('closeDebate');
    s.profile = ['quick', 'standard', 'deep'].includes(profile) ? profile : 'standard';
    const started = (await call('verify')) !== false;
    if (started) act(`Reviewing (${s.profile})`);
    return started ? { started: true, profile: s.profile, note: 'Live progress shows in the bottom bar; when it ends the graph, the score and the agents story update with the real result.' } : { started: false, note: 'A verification is already running or starting, or no pull request is open.' };
  },
  async get_consensus() {
    const s = app(); const p = s?.cur && view() !== 'home' ? s.cur : null;
    if (!p) return { error: 'Open a pull request first.' };
    return consensusFor(p);
  },
  async start_consensus() {
    const s = app(); const p = s?.cur && view() !== 'home' ? s.cur : null;
    if (!p) return { error: 'Open a pull request first.' };
    const project = s.projects.find((x) => x.id === s.pid);
    const r = await fetch('/api/consenso', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo: project.path, branch: p.branch, base: s.base, lang: 'en' }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { error: j.error || `Server answered ${r.status}` };
    act('Consensus started'); showConsensus(j.id);
    return { started: true, id: j.id, note: 'Takes about 15 minutes; the live view is open.' };
  },
  async open_consensus() {
    const s = app(); const p = s?.cur && view() !== 'home' ? s.cur : null;
    if (!p) return { error: 'Open a pull request first.' };
    const c = await consensusFor(p);
    if (!c.found) return { error: c.note || 'There is no consensus run for this pull request yet.' };
    showConsensus(c.id); act('Consensus view'); return { opened: true };
  },
  async end_conversation() { end(); return { ok: true, note: 'Say a very short goodbye (2-4 words); the voice closes when you finish.' }; },
};
return { TOOLS, TOOL_FN };
}
