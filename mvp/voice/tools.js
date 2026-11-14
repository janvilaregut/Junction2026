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
  { name: 'open_review', description: 'Review one spot with the agents, shown as the agents\' tree growing out of that node: three AI agents rebuild that one function blind from the requirement (each is a branch), mathematics compares their versions with the pull request, they argue at the junction and it ends in a verdict card (reproduced, differs with a fix, or you decide). Takes about 15 seconds. query: the function name or file:line of the spot; empty = the most pressing open spot. Use it when the user asks to review, check, verify or fix a spot, or asks whether it is right.', parameters: T({ query: { type: 'STRING', description: 'The spot: a line like "985" or "TypeCollector.cs:985", a file name, or empty for the whole change.' } }) },
  { name: 'start_verification', description: 'Start the real review of the current pull request: contract, alternatives rebuilt from the base by AI agents, their debate, attacks on the PR and a judge with a 0-10 score. Profiles: quick (90 s, no alternatives), standard (5 min, default), deep (15 min). Ask the user to confirm first.', parameters: T({ profile: { type: 'STRING', enum: ['quick', 'standard', 'deep'] } }) },
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
  { name: 'where_to_look', description: 'The spots that still need someone, most pressing first, lit up in the graph: the risky (red) and uncertain (amber) functions that mathematics could not settle and no agent or person has settled since. Use it for "where do I start", "what should I review", "what is risky", "what is left".', parameters: T() },
  { name: 'show_code', description: 'Fly the graph to one code region and return its code (removed and added lines) and which agents also wrote it. query: a line like "1429" or "TypeCollector.cs:985", or a file name. For understanding, not fixing.', parameters: T({ query: { type: 'STRING' } }, ['query']) },
  { name: 'ask_agent', description: 'What one agent did and said in the review: C1, C2 (agents that rebuilt the change from the base), the PR, the attacker, or the judge.', parameters: T({ name: { type: 'STRING' } }, ['name']) },
  { name: 'review_all', description: 'Send every open spot of the graph to the agents at once (three at a time, about 15 seconds each): the nodes turn green when the agents reproduce them, red when they wrote it differently, and stay amber when a person must decide. Use it for "review everything", "check it all", "turn it green".', parameters: T() },
  { name: 'graph_overview', description: 'What mathematics settled in the open pull request, without any AI: how many changed functions are proved (the edit cannot change behaviour), cleared (nothing flagged, not a proof), uncertain and risky, how many lines still need someone, and the open spots in order. Use it for "how risky is this", "what did the maths say", "can I approve".', parameters: T() },
  { name: 'mark_read', description: 'The user says they read a spot and accept it: mark that function as read by them so it turns green. query: the function name or file:line. Only when the user says so.', parameters: T({ query: { type: 'STRING' } }, ['query']) },
  { name: 'look_deeper', description: 'The user wants the change looked at harder: launches a Deep review (up to 15 min, real cost). ASK FOR A YES FIRST.', parameters: T() },
);
// Retired: the bubbles story. Agents are shown in one place only, the review tree (open_review); the raw
// consensus page that the voice could open is gone.
const RETIRED = new Set(['show_agent_debate', 'debate_step', 'open_agent', 'close_agent', 'leave_debate']);
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
const TOOL_FN = {
  async get_screen() {
    const s = app(); const v = view(); const p = s?.cur && v !== 'home' ? s.cur : null;
    const project = s?.projects?.find((x) => x.id === s.pid);
    const f = v === 'commits' ? s.focus : v === 'zoom' ? s.zoom : null;
    return {
      view: v, project: project?.name, base: s?.base, pullRequest: p ? prBrief(p, allPRs().findIndex((x) => x.id === p.id)) : null, verification: p ? briefOf(s.run?.brief, 'summary') : null, verifyingNow: !!s?.es,
      graphNodes: v === 'graph' && !s?.math ? graphSummary() : undefined,
      mathematics: v === 'graph' && s?.math ? { proved: s.math.summary.nodes.proved, cleared: s.math.summary.nodes.cleared, uncertain: s.math.summary.nodes.uncertain, risky: s.math.summary.nodes.risky, openNow: (call('mathQueue') || []).slice(0, 8).map((x) => ({ name: x.name, state: x.state, why: x.why })), selected: s.fixTarget?.label || null } : undefined,
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
    if (app()?.math) { // the mathematical graph: the open spots, most pressing first
      const q = call('mathQueue') || [];
      if (!q.length) return { open: 0, note: 'Nothing is left: every changed spot is proved, cleared or settled.' };
      call('focusOn', q.slice(0, 6).map((x) => x.id), { noTip: true });
      act(`${q.length} spot${q.length === 1 ? '' : 's'} to review`);
      return { open: q.length, spots: q.slice(0, 8).map((x) => ({ name: x.name, where: `${x.file}:${x.line}`, state: x.state, why: x.why, lines: x.lines, dependents: x.dependents })), tip: 'Say the first one in plain words. open_review reviews one with the agents; review_all sends them all.' };
    }
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
    let r;
    if (app()?.math) { // one function of the mathematical graph, reviewed alone by three agents
      const g = typeof G !== 'undefined' ? G : null;
      const hit = query ? (call('findNodes', query) || []).find((n) => n.kind === 'sym') : null;
      const next = (call('mathQueue') || []).find((x) => g?.nodes.get(x.id)?.kind === 'sym');
      const node = hit || (query ? null : app().fixTarget || (next && g.nodes.get(next.id)));
      if (!node) return query ? { error: `No changed function matches "${query}".`, open: (call('mathQueue') || []).map((x) => x.name).slice(0, 12) } : { error: 'There is no open spot left to review. For the whole pull request use start_verification.' };
      call('focusOn', [node.id], { noTip: true }); await sleep(500);
      r = await call('openReview', { node });
      if (r && !r.error) { act(`Review · ${node.label}`); return { ...r, spot: node.label, result: r.verdict?.label, note: 'Say what the agents concluded in one or two sentences: reproduced, or the concrete input where they differ and the rule of the requirement that decides it. The verdict card has the fix.' }; }
    } else r = await call('openTree', { query });
    if (!r) return { error: 'Could not open the review.' };
    if (r.error) return r;
    act(r.spot ? `Review · ${r.spot.where}` : 'Review');
    return { ...r, note: r.live ? 'A real review is running now: the tree grows live and continues with the debate and verdict when it ends (minutes). Say so.' : 'Narrate it while it plays: who rebuilt it, the debate, the attack, the verdict; at the end the user signs in the card.' };
  },
  async review_all() {
    if (!inGraph() || !app()?.math) return { error: 'Open a pull request first.' };
    if (call('treeOpen')) { call('closeTree'); await sleep(700); }
    const before = (call('mathQueue') || []).length;
    if (!before) return { open: 0, note: 'Nothing is left to review.' };
    act(`Agents review ${before} spot${before === 1 ? '' : 's'}`);
    const res = await call('reviewAll');
    const s = app(), left = call('mathQueue') || [];
    const by = {}; for (const m of Object.values(s.marks || {})) by[m.state] = (by[m.state] || 0) + 1;
    return { started: res !== false, reviewedByAgents: res?.reviewed ?? 0, reproduced: by.reproduced || 0, differ: by.differs || 0, forThePerson: by.unclear || 0, stillOpen: left.map((x) => ({ name: x.name, state: x.state, why: x.why })).slice(0, 8), note: 'Say how many turned green, which ones the agents wrote differently (red) and why, and what is left for the user.' };
  },
  async graph_overview() {
    const s = app(); if (!inGraph() || !s?.math) return { error: 'Open a pull request first.' };
    const m = s.math.summary, q = call('mathQueue') || [];
    return { settledByMathematics: { proved: m.nodes.proved, cleared: m.nodes.cleared }, open: { uncertain: m.nodes.uncertain, risky: m.nodes.risky, now: q.length }, lines: { total: m.lines.total, proved: m.lines.proved, cleared: m.lines.cleared, needSomeone: q.reduce((n, x) => n + x.lines, 0) },
      first: q.slice(0, 5).map((x) => ({ name: x.name, where: `${x.file}:${x.line}`, state: x.state, why: x.why })), dependencyGraph: m.graph, decisionModel: m.routing?.status === 'used' ? `asked, raised ${m.routing.adopted.length} node(s)` : m.routing?.status,
      meaning: 'proved = a proof that the edit cannot change behaviour (same tokens, or only local variables renamed). cleared = nothing flagged and low exposure, NOT a proof. uncertain / risky = behaviour changed and mathematics cannot vouch for it: these go to the agents and to the person. Node size = how much code depends on it.', limits: s.math.limits };
  },
  async mark_read({ query }) {
    const s = app(); if (!inGraph() || !s?.math) return { error: 'Open a pull request first.' };
    const node = (call('findNodes', query) || []).find((n) => n.kind === 'sym' || n.kind === 'grp');
    if (!node) return { error: `No changed spot matches "${query}".` };
    const ok = await call('markNode', node.id, 'read');
    if (ok) act(`Read · ${node.label}`);
    return { ok: !!ok, left: (call('mathQueue') || []).length };
  },
  async start_verification({ profile = 'standard' } = {}) {
    const s = app(); if (!s?.cur || !inGraph()) return { error: 'Open a pull request first.' };
    if (call('debateOpen')) call('closeDebate');
    s.profile = ['quick', 'standard', 'deep'].includes(profile) ? profile : 'standard';
    const started = (await call('verify')) !== false;
    if (started) act(`Reviewing (${s.profile})`);
    return started ? { started: true, profile: s.profile, note: 'Live progress shows in the bottom bar; when it ends the graph, the score and the agents story update with the real result.' } : { started: false, note: 'A verification is already running or starting, or no pull request is open.' };
  },
  async end_conversation() { end(); return { ok: true, note: 'Say a very short goodbye (2-4 words); the voice closes when you finish.' }; },
};
return { TOOLS, TOOL_FN };
}
