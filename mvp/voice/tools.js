/* What the voice assistant can see and do in the app. Tools call the globals of app.js (S is a top-level const there,
   so it is read as S, not window.S). createTools({ act, end }) returns the Gemini Live declarations and their handlers;
   act(text, tone) shows a short note of what was done, end() closes the conversation. */
const app = () => (typeof S !== 'undefined' ? S : null);
const call = (name, ...a) => (typeof window[name] === 'function' ? window[name](...a) : undefined);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createTools({ act, end }) {
const T = (props = {}, required = []) => ({ type: 'OBJECT', properties: props, ...(required.length ? { required } : {}) });
const TOOLS = [
  { name: 'get_screen', description: 'What the user is looking at right now: the project picker, home (branch tree), the graph of one pull request, the code panel of one spot, or a review (the tree of agents and the verdict card); plus that PR and its verification summary. Call it whenever the user says "this", "here" or you are unsure.', parameters: T() },
  { name: 'list_pull_requests', description: 'List the pull requests (branches) of the current project with their verification state, and point at them on screen. By default only the active ones (recent or already verified); older stale branches only if include_old is true.', parameters: T({ direction: { type: 'STRING', enum: ['incoming', 'outgoing', 'all'], description: 'incoming = others want to merge into the base; outgoing = the user\'s own branches. Default all.' }, include_old: { type: 'BOOLEAN', description: 'Also include old, stale branches. Default false.' } }) },
  { name: 'highlight_pull_requests', description: 'Point at specific pull requests in the branch tree (dims the rest). Empty list clears.', parameters: T({ ids: { type: 'ARRAY', items: { type: 'STRING' }, description: 'PR ids from list_pull_requests' } }, ['ids']) },
  { name: 'open_pull_request', description: 'Open one pull request full screen. Accepts its id, branch, number, a word from its title, or an ordinal like "first"/"second".', parameters: T({ query: { type: 'STRING' } }, ['query']) },
  { name: 'go_home', description: 'Close the pull request and go back to the branch tree.', parameters: T() },
  { name: 'get_verification_details', description: 'Details of the current pull request verification, for explaining it: verdict lane, recommendation, what was checked and how (tests red-before/green-after, seeded defects, rewind, blind replicas), what was NOT checked and why, the lines the human must read, and the open questions.', parameters: T({ section: { type: 'STRING', enum: ['summary', 'checked', 'not_checked', 'residue', 'questions', 'all'] } }) },
  { name: 'open_spot', description: 'Go to one spot of the graph (a changed function, or a file): the camera flies to it and the CODE PANEL opens on the right, with the chunks worth reading open and the filler folded, so the person can review it themselves. This is the DEFAULT for "go to", "enter", "open", "show me", "let\'s see", "look at" a spot ("entra en X", "vamos a X", "enséñame X", "ábreme X", "amplíame X"). It never starts the agents. After it: say in one or two sentences what the spot is and which lines deserve reading, then ASK whether they want the agents to review it. query: the function name, a file name or file:line; empty = the spot already selected, else the most pressing open one.', parameters: T({ query: { type: 'STRING' } }) },
  { name: 'spot_tab', description: 'Switch the tab of the open code panel: "code" (only the chunks worth reading), "all_code" (the whole file), "evidence" (what mathematics established and every criterion it is held to), "dependencies" (which chunks read each other and through which names). Use it for "show me all the code", "the evidence", "the dependencies" of the spot that is open.', parameters: T({ tab: { type: 'STRING', enum: ['code', 'all_code', 'evidence', 'dependencies'] } }, ['tab']) },
  { name: 'open_review', description: 'Send one spot to the AGENTS, shown as the agents\' tree growing out of that node: three AI agents rebuild that one function blind from the requirement (each is a branch), mathematics compares their versions with the pull request, they argue at the junction and it ends in a verdict card (reproduced, differs with a fix, or you decide). Takes about 15 seconds. ONLY when the user explicitly asks for the agents or for a review ("open the agents", "ábreme el agente", "que lo revisen los agentes", "review / check / verify / fix it", "is it right?"), or says yes after you offered it. To just go to a spot or see its code use open_spot. query: the function name or file:line; empty = the spot that is open or selected, else the most pressing open one.', parameters: T({ query: { type: 'STRING', description: 'The spot: a function name, a line like "985" or "TypeCollector.cs:985", or empty for the one that is open.' } }) },
  { name: 'start_verification', description: 'Start the real review of the current pull request: contract, alternatives rebuilt from the base by AI agents, their debate, attacks on the PR and a judge with a 0-10 score. Profiles: quick (90 s, no alternatives), standard (5 min, default), deep (15 min). Ask the user to confirm first.', parameters: T({ profile: { type: 'STRING', enum: ['quick', 'standard', 'deep'] } }) },
  { name: 'show_commits', description: 'Unfold one branch in the tree so all its commits show on a long rail (the other branches fold away). Use when the user asks for the commits / history of a branch. query: id, branch, number, a word from its title, or empty for the one open or in focus.', parameters: T({ query: { type: 'STRING' } }) },
  { name: 'show_all_branches', description: 'Fold the commits back (or zoom back out) and show every branch in the tree again.', parameters: T() },
  { name: 'zoom_branch', description: 'Zoom the home tree\'s camera into one branch: a close-up of where it starts and its first commits, big, on one glowing line (the user can then slide along it). Use when the user asks to zoom in on, enlarge or magnify a branch ("amplíame la rama", "acércate a esa rama"). query: id, branch, number, a word from its title, or empty for the one in focus.', parameters: T({ query: { type: 'STRING' } }) },
  { name: 'focus_graph', description: 'Inside the open pull request graph: fly the camera to a node or group and light it up while you talk about it. query: a file name, "Tests", "Builds", "Mutation", a line like "Foo.cs:120", an agent, or a group: "what I must read" (red), "decisions" (yellow), "reproduced" (green), "checks", "files", "agents", "whole" (the core). Call it EVERY time you start explaining a specific part of the graph.', parameters: T({ query: { type: 'STRING' } }, ['query']) },
  { name: 'zoom_graph', description: 'Move the graph camera: "in" (closer), "out" (further), "turn_left" / "turn_right" (turn the graph in 3D, so its depth shows), "overview" (back to the whole flat graph: clears the highlight, the turn and closes the code panel).', parameters: T({ action: { type: 'STRING', enum: ['in', 'out', 'turn_left', 'turn_right', 'overview'] } }, ['action']) },
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
  { name: 'ask_agent', description: 'What one agent did and said in the review: C1, C2 (agents that rebuilt the change from the base), the PR, the attacker, or the judge.', parameters: T({ name: { type: 'STRING' } }, ['name']) },
  { name: 'review_all', description: 'Send every open spot of the graph to the agents at once (three at a time, about 15 seconds each): the nodes turn green when the agents reproduce them, red when they wrote it differently, and stay amber when a person must decide. Use it for "review everything", "check it all", "turn it green".', parameters: T() },
  { name: 'graph_overview', description: 'What mathematics settled in the open pull request, without any AI: how many changed functions are proved (the edit cannot change behaviour), cleared (nothing flagged, not a proof), uncertain and risky, how many lines still need someone, and the open spots in order. Use it for "how risky is this", "what did the maths say", "can I approve".', parameters: T() },
  { name: 'prove_it', description: 'Open "Prove it" on one changed function of the graph: the card grows into the full list of engineering principles it is held to without any AI (same behaviour, contract intact, public API stable, guards kept, errors not swallowed, no dangerous APIs or secrets, no blocking on async, reached by a test, used, simple, small, small interface, written once), each pass / warn / fail with its exact value. Use it for "prove it", "why is this green", "what does it fail", "show me the principles", "amplíame la info de este punto". query: the function name or file:line; empty = the spot already selected.', parameters: T({ query: { type: 'STRING' } }) },
  { name: 'mark_read', description: 'The user says they read a spot and accept it: mark that function as read by them so it turns green. query: the function name or file:line. Only when the user says so.', parameters: T({ query: { type: 'STRING' } }, ['query']) },
  { name: 'decide_pull_request', description: 'The person gives their OK on the open pull request. decision "accept": accept and merge the pull request that is OPEN right now (the user says "merge it", "haz el merge", "acepta el pull request" while inside it): only possible when it is all green; the app itself goes back to the branch tree (the four demo branches) and that branch is seen merging into the base line. Do not open, list or expand anything else for this. decision "request_changes": send it back to the author (when the agents wrote a spot differently). ONLY when the user clearly says so ("ok, merge it", "accept it", "acéptalo", "haz el merge", "send it back", "pide cambios"). It is a visual decision kept for this session only: nothing is merged in git.', parameters: T({ decision: { type: 'STRING', enum: ['accept', 'apply_fix', 'request_changes'], description: 'apply_fix: the agents implement their version of the spot(s) they wrote differently (they turn green, then the branch can be accepted). On the user\'s OWN branch ("yours", outgoing) it fixes every such spot and request_changes is not possible: your own work is fixed, never sent back. On someone else\'s branch it works for ONE spot; with two or more the merge is blocked and only request_changes (back to its author) is possible.' } }, ['decision']) },
  { name: 'why_the_maths', description: 'WHY mathematics gave a spot its colour (proved, cleared, uncertain, risky), with the exact algorithms and numbers behind it: PageRank percentile and fan-in/dependents in the call graph, tests that reach it, cyclomatic/cognitive complexity and nesting, the token-level equivalence proof, the principle gate (Kleene: every criterion must pass), entropy of its parts, sensitivity. Use it whenever the user asks why a spot is green, amber or red, "por qué", "en qué se basa". query: function name; empty = the selected spot.', parameters: T({ query: { type: 'STRING' } }) },
  { name: 'show_ai_session', description: 'Open the panel with the AI agent session (recorded by Entire) behind one commit: which agent and model made it, the prompt that led to it and the conversation up to it, with a button to reopen it in its agent. ONLY when the user explicitly and directly asks for it: the prompt, the AI session, the conversation, or which AI made a commit ("¿con qué prompt se hizo este commit?", "enséñame la sesión de Claude del último commit", "which AI wrote this"). NEVER call it on your own initiative, to illustrate something else, or as part of a review. query: a commit (sha, words from its message, "last"/"first"); empty = the newest commit with a session. branch: optional branch, else the one unfolded or open, else the history of the base line.', parameters: T({ query: { type: 'STRING' }, branch: { type: 'STRING' } }) },
  { name: 'close_ai_session', description: 'Close the AI session panel.', parameters: T() },
  { name: 'look_deeper', description: 'The user wants the change looked at harder: launches a Deep review (up to 15 min, real cost). ASK FOR A YES FIRST.', parameters: T() },
  { name: 'run_tests', description: 'The second way to settle a spot: back it with EXECUTABLE TESTS instead of agents. The full pipeline (contract, alternatives rebuilt from the base, attacks, a probe that runs) on the chosen functions; only this moves "backed by tests" in the depth menu. Only changed C# functions; takes minutes and real model cost, bounded by the depth: quick (90 s, cannot settle a spot), standard (5 min), deep (15 min). ASK FOR A YES FIRST. scope: "spot" (query, else the one open, else the next pending one), "all" (the whole change), "continue" (same contract, new budget, after a review that ended with not enough evidence). Use it for "test this", "back it with tests", "run the tests on this spot", "test the whole change", "continue the investigation".', parameters: T({ scope: { type: 'STRING', enum: ['spot', 'all', 'continue'] }, query: { type: 'STRING' }, depth: { type: 'STRING', enum: ['quick', 'standard', 'deep'], description: 'Optional: change the review depth first.' } }, ['scope']) },
  { name: 'open_report', description: 'Open the report of the last full review of this pull request: the verdict card with the score, what was and was not checked and the evidence; it is where the person signs or sends it back. Use it for "show me the report / the verdict / the score", "I want to sign". If there is no review yet it says so (start_verification runs one).', parameters: T() },
  { name: 'explain_context', description: 'What things ARE, in words, so you can explain them instead of reciting numbers. about "project": what this repository is and does (its own README) and how it is laid out. about "change": what the open pull request was asked to do (the linked issue, the recorded prompt or its commit messages) and which parts it touches. about "spot": what one function does: its own comment, its code, who calls it, what it calls and which tests reach it (query: the function; empty = the one open). Call it BEFORE explaining what something does or why it matters, and whenever the user asks "what is this", "what does it do", "what is this for", "explain it", "why does this matter".', parameters: T({ about: { type: 'STRING', enum: ['project', 'change', 'spot'] }, query: { type: 'STRING' } }, ['about']) },
  { name: 'open_project', description: 'Switch to another project (repository), or with an empty query show the project picker with every project and how many branches each has to review. Use it for "open the project X", "change project", "show me the projects".', parameters: T({ query: { type: 'STRING', description: 'Project name or part of it; empty = show the picker.' } }) },
);
// Retired: the bubbles story. Agents are shown in one place only, the review tree (open_review); the raw
// consensus page that the voice could open is gone.
// show_code gave way to open_spot: the code now has its own panel.
const RETIRED = new Set(['show_agent_debate', 'debate_step', 'open_agent', 'close_agent', 'leave_debate', 'show_code']);
for (let i = TOOLS.length - 1; i >= 0; i--) if (RETIRED.has(TOOLS[i].name)) TOOLS.splice(i, 1);
for (const t of TOOLS) t.behavior = 'BLOCKING';

const screen = () => TOOL_FN._screen();
/* What decides the open branch NOW (the graph: mathematics + the agents per function), in words, with the next step.
   The full-pipeline report, if an old one exists, is not this. */
function branchStatus() {
  const s = app(); if (!s?.cur || !s.math || view() === 'home') return null;
  const nodes = (s.math.nodes || []).filter((n) => n.verdict !== 'context'), marks = s.marks || {};
  const by = (st) => nodes.filter((n) => marks[n.id]?.state === st).map((n) => n.qname || n.name);
  const blocker = call('mergeBlocker') || '', own = s.cur.direction === 'outgoing', notReviewed = nodes.filter((n) => !marks[n.id]).map((n) => n.qname || n.name);
  const differs = by('differs');
  const next = !blocker ? 'It can be merged now (decide_pull_request accept).'
    : notReviewed.length ? 'The agents have not reviewed it yet: offer review_all (three agents rebuild each changed function blind and compare).'
    : differs.length && own ? 'Offer apply_fix: the agents implement their fix on the user\'s own branch, then merge.'
    : differs.length === 1 ? 'Offer apply_fix (the agents have a one-line fix), or request_changes to send it back.'
    : differs.length ? 'Merge is blocked: offer request_changes (back to its author).' : 'Open spots remain: open_spot / where_to_look.';
  return { whose: own ? 'the user\'s own branch' : 'someone else\'s branch, wanting in', state: (typeof state === 'function' ? state(s.cur).label : ''), changedFunctions: nodes.map((n) => n.qname || n.name), notReviewedByAgentsYet: notReviewed, reproducedByAgents: by('reproduced'), agentsWroteDifferently: differs, mergeBlockedBecause: blocker || null, next,
    note: 'Describe THIS state in one or two sentences. Do not talk about tests or "insufficient evidence" unless asked for the full report.' };
}
function allPRs() {
  const s = app(); if (!s) return [];
  return [...(s.prs?.incoming || []).map((p) => ({ ...p, yours: false })), ...(s.prs?.outgoing || []).map((p) => ({ ...p, yours: true }))];
}
function prState(p) { try { return typeof state === 'function' ? state(p).label : (p.last?.laneName || 'Not verified'); } catch { return p.last?.laneName || 'Not verified'; } }
const prBrief = (p, i) => ({ ordinal: i + 1, id: p.id, branch: p.branch, title: p.title, yours: !!p.yours, state: prState(p), verifying: !!p.running, linesForHuman: p.last ? `${p.last.residue} of ${p.last.total}` : null, commitsAhead: p.ahead, date: p.date });
function view() {
  const full = document.getElementById('full'), landing = document.getElementById('landing');
  if (landing && !landing.hidden) return 'projects';
  if (full && !full.hidden && call('treeOpen')) return 'review';
  if (full && !full.hidden && call('agentOpen')) return 'agent';
  if (full && !full.hidden && call('debateOpen')) return 'debate';
  if (full && !full.hidden && call('codeInfo')) return 'code';
  if (full && !full.hidden) return 'graph';
  if (app()?.focus) return 'commits';
  if (app()?.zoom) return 'zoom';
  return 'home';
}
const inGraph = () => ['graph', 'code', 'review', 'debate', 'agent'].includes(view());
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
const projectList = () => (app()?.projects || []).map((p) => ({ name: p.name, base: p.base, toReview: app().counts?.[p.id]?.review ?? null, current: p.id === app().pid }));
/* What things are, in words (server/context.js). Kept for the page's life: it only changes with the code. */
const CONTEXT = new Map();
async function context(about, node) {
  const s = app(); if (!s?.pid) return null;
  const pr = about === 'project' ? '' : s.cur?.id || '';
  const key = [s.pid, about, pr, s.cur?.sha || '', node || ''].join('|');
  if (!CONTEXT.has(key)) {
    try {
      const r = await fetch(`/api/projects/${s.pid}/context?about=${about}${pr ? `&pr=${encodeURIComponent(pr)}` : ''}${node ? `&node=${encodeURIComponent(node)}` : ''}`);
      const d = await r.json();
      if (!r.ok || d.error) return null;
      CONTEXT.set(key, d[about] || null);
    } catch { return null; }
  }
  return CONTEXT.get(key);
}
/* The project picker covers the branch tree: step into the current project before pointing at its branches. */
const leaveProjects = () => { if (view() === 'projects' && app()?.pid) call('pickProject', app().pid); };
/* How much of the change executable tests back (only changed C# functions can be tested). */
function tested() {
  const t = app()?.math?.trust;
  return t?.total ? { percent: t.percent, backed: t.verified, failing: t.failed, pending: t.pending, of: t.total, meaning: 'Share of the changed functions backed by tests that ran, weighted by impact. Not the odds that the change is right.' } : { possible: false, why: 'No changed C# function here: tests cannot back this change, the agents can still review it.' };
}
/* The changed function a query means, preferring product code over files and neighbours. */
function findSpot(query) {
  const hits = call('findNodes', query) || [];
  return hits.find((n) => n.kind === 'sym' && n.m && n.m.verdict !== 'context') || hits.find((n) => n.m && n.m.verdict !== 'context') || hits.find((n) => n.kind === 'file') || hits.find((n) => n.m) || null;
}
/* Close whatever covers the graph (the old debate, the review tree) before acting on it. */
async function toGraph() {
  if (call('debateOpen')) { call('closeDebate'); await sleep(400); }
  if (call('treeOpen')) { call('closeTree'); await sleep(700); }
}
function setDepth(depth) {
  const s = app(); if (!s || !['quick', 'standard', 'deep'].includes(depth) || s.profile === depth) return;
  s.profile = depth; try { store.set('katse.profile', depth); } catch { /* not kept */ }
  call('renderBar');
}
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
    return { ...(await screen()), branchStatus: branchStatus() || undefined };
  },
  async get_verification_details({ section = 'summary' } = {}) {
    const s = app();
    if (!s?.cur || view() === 'home') return { error: 'No pull request is open. Open one first.' };
    const st = branchStatus();
    if (st) return { pullRequest: s.cur.branch, ...st, olderFullReview: s.run?.brief ? 'There is an older full-pipeline report for this branch; it is NOT what decides here. Mention it only if asked for the full report.' : undefined };
    if (!s.run?.brief) return { verified: false, note: 'This pull request has not been verified yet.', plan: s.plan ? { files: s.plan.totals?.files, added: s.plan.totals?.added, removed: s.plan.totals?.removed } : null };
    return { pullRequest: s.cur.branch, ...briefOf(s.run.brief, section) };
  },
  async _screen() {
    const s = app(); const v = view(); const p = s?.cur && v !== 'home' ? s.cur : null;
    const project = s?.projects?.find((x) => x.id === s.pid);
    const f = v === 'commits' ? s.focus : v === 'zoom' ? s.zoom : null;
    return {
      view: v, project: project?.name, base: s?.base, pullRequest: p ? prBrief(p, allPRs().findIndex((x) => x.id === p.id)) : null, verification: p && !s?.math ? briefOf(s.run?.brief, 'summary') : null, verifyingNow: !!s?.es,
      projects: v === 'projects' ? projectList() : undefined,
      graphNodes: v === 'graph' && !s?.math ? graphSummary() : undefined,
      mathematics: (v === 'graph' || v === 'code') && s?.math ? { proved: s.math.summary.nodes.proved, cleared: s.math.summary.nodes.cleared, uncertain: s.math.summary.nodes.uncertain, risky: s.math.summary.nodes.risky, openNow: (call('mathQueue') || []).slice(0, 8).map((x) => ({ name: x.name, state: x.state, why: x.why })), selected: s.fixTarget?.label || null, backedByTests: tested(), reviewDepth: s.profile } : undefined,
      codePanel: v === 'code' ? call('codeInfo') : undefined,
      commitsShown: f ? { branch: allPRs().find((x) => x.id === f.id)?.branch, total: f.total, commits: f.commits.map((c) => ({ sha: c.sha.slice(0, 7), subject: c.subject, author: c.author, date: c.date, madeWith: c.ai?.[0]?.agent })) } : undefined,
      aiSessionOpen: !!call('aiSessionOpen') || undefined,
      agentsStory: v === 'debate' || v === 'agent' ? call('debateInfo') : undefined,
      review: v === 'review' ? call('treeInfo') : undefined,
    };
  },
  async list_pull_requests({ direction = 'all', include_old = false } = {}) {
    leaveProjects();
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
    leaveProjects();
    if (inGraph() && s?.cur?.id === p.id) { call('closeDebate'); return { alreadyOpen: true, pullRequest: prBrief(p, allPRs().findIndex((x) => x.id === p.id)) }; }
    if (inGraph()) { call('closeGraph'); await sleep(780); }
    if (s?.focus && s.focus.id !== p.id) { call('hideCommits'); await sleep(900); }
    if (s?.zoom && s.zoom.id !== p.id) { call('hideCommits'); await sleep(1100); }
    if (!s?.focus && !s?.zoom) { call('highlightLanes', [p.id]); await sleep(420); call('highlightLanes', []); }
    call('openGraph', p); // grows out of the branch's own dot in the tree
    act(`Opened ${p.branch}`);
    const [, change] = await Promise.all([waitFor(() => app()?.run?.brief || app()?.plan, 8000), context('change')]);
    return { opened: true, pullRequest: prBrief(p, allPRs().findIndex((x) => x.id === p.id)), whatItIsFor: change ? { askedFor: clip(change.askedFor?.text, 700), from: change.askedFor?.from, touches: change.touches } : undefined, verification: briefOf(app()?.run?.brief, 'summary'), notVerifiedYet: !app()?.run?.brief, note: 'Say first what this change is for, in one plain sentence taken from whatItIsFor; then where it stands.' };
  },
  async go_home() { leaveProjects(); const was = inGraph(); call('closeGraph'); if (!was) call('hideCommits'); act('Back home'); return { ok: true }; },
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
  async show_ai_session({ query = '', branch = '' } = {}) {
    const s = app();
    const p = branch ? findPR(branch) : allPRs().find((x) => x.id === (s?.focus?.id || s?.zoom?.id || s?.cur?.id));
    const shown = s?.focus || s?.zoom;
    let list = shown && (!p || shown.id === p.id) ? shown.commits : null;
    if (!list && p) list = (await call('commitsOf', p, s.pid))?.commits;
    if (!list && !branch && s?.history?.commits) list = [...s.history.commits].reverse(); // the base's history, oldest first
    if (!list) return { error: 'Which branch? Name it, or unfold its commits first.', available: allPRs().map((x) => x.branch).slice(0, 20) };
    const q = String(query).toLowerCase().trim();
    const withAi = list.filter((c) => c.ai);
    const c = !q || /\b(last|latest|newest)\b|últim|ultim|reciente/.test(q) ? [...list].reverse().find((x) => x.ai) || list[list.length - 1]
      : /\bfirst\b|primer/.test(q) ? withAi[0] || list[0]
      : list.find((x) => x.sha.startsWith(q)) || list.find((x) => x.subject.toLowerCase().includes(q)) || list.find((x) => q.split(/\s+/).filter((w) => w.length > 3).some((w) => x.subject.toLowerCase().includes(w)));
    if (!c) return { error: `No commit matches "${query}".`, commits: list.slice(-12).map((x) => ({ subject: x.subject, madeWith: x.ai?.[0]?.agent || null })) };
    if (!c.ai) return { noSession: true, commit: c.subject, note: 'No agent session was recorded for this commit: made by hand, or on a computer that did not record it.', commitsWithSessions: withAi.slice(-8).map((x) => x.subject) };
    const d = await call('openAiSession', c);
    act(`${c.ai[0].agent} session`);
    return { commit: c.subject, agent: d?.agent, model: d?.model, turns: d?.turns, promptThatLedToIt: clip(d?.prompt, 300), firstPromptOfSession: clip(d?.firstPrompt, 200), canReopen: !!d?.resume, tip: 'The panel shows the conversation up to this commit; earlier and later parts are folded. It has a button to reopen the session in its agent.' };
  },
  async close_ai_session() { return { closed: !!call('closeAiSession') }; },
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
    if (action === 'turn_left' || action === 'turn_right') { // the turn in 3D: a quarter of the way round each time
      const r = typeof G !== 'undefined' ? G.rot : null; if (!r) return { error: 'This graph cannot turn.' };
      r.tyaw = Math.max(-1.1, Math.min(1.1, r.tyaw + (action === 'turn_left' ? -0.5 : 0.5))); r.tpitch = r.tpitch || -0.18;
      call('startLoop'); act('Turned the graph');
      return { ok: true, tip: '"overview" brings it back flat.' };
    }
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
      return { open: q.length, spots: q.slice(0, 8).map((x) => ({ name: x.name, where: `${x.file}:${x.line}`, state: x.state, why: x.why, lines: x.lines, dependents: x.dependents })), tip: 'Say the first one in plain words. open_spot goes to it and opens its code; the agents only if the user asks (open_review for one, review_all for all).' };
    }
    const list = call('focusGraph', 'what I must read');
    if (!list) return { error: 'No red regions: nothing is left only for the human, or the branch is not verified yet.', nodes: graphSummary() };
    act(`${list.length} spot${list.length === 1 ? '' : 's'} to read`);
    return { read: list.map((n) => ({ where: `${n.file || ''}:${n.start ?? ''}`, why: n.info })), tip: 'Explain the first one in plain words; open_spot opens its code.' };
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
    setDepth('deep');
    const started = (await call('verify')) !== false;
    if (started) act('Deep review started');
    return { started };
  },
  async leave_debate() { call('closeDebate'); act('Back to the graph'); return { ok: true }; },
  async open_spot({ query = '' } = {}) {
    if (!inGraph()) return { error: 'Open a pull request first.' };
    await toGraph();
    const s = app(), g = typeof G !== 'undefined' ? G : null;
    if (!s?.math) return TOOL_FN.show_code({ query }); // a graph without the mathematical pass: its code regions
    const next = (call('mathQueue') || []).map((x) => g?.nodes.get(x.id)).find(Boolean);
    const node = query ? findSpot(query) : s.fixTarget || next;
    if (!node) return query ? { error: `Nothing in the graph matches "${query}".`, open: (call('mathQueue') || []).map((x) => x.name).slice(0, 12) } : { error: 'Say which spot: nothing is selected and nothing is left open.' };
    if (!call('mathTap', node)) return { error: `"${node.label}" has nothing to open.` };
    act(`Looking at ${node.label}`);
    await waitFor(() => { const i = call('codeInfo'); return !i || !i.loading; }, 9000);
    const info = call('codeInfo');
    // No code to read (documentation, configuration, removed code, an unchanged neighbour): its evidence card instead.
    if (!info) return { spot: node.m?.qname || node.label, panel: 'evidence card', colour: node.m?.verdict, why: node.m?.claim, note: 'This spot has no code panel: its evidence card is open next to it. Say what it is in one sentence. Agents do not review it.' };
    const about = node.m ? await context('spot', node.m.id) : null;
    const whatItDoes = about ? { itsOwnComment: about.itsOwnComment, change: about.change, calledBy: about.calledBy.slice(0, 6), calls: about.calls.slice(0, 6), testedBy: about.testedBy.slice(0, 4), code: clip(about.code, 1400) } : undefined;
    return { panel: 'code, on the right', whatItDoes, ...info, note: info.canReviewWithAgents
      ? 'The code panel is open; the agents have NOT been started. Say in one or two sentences what this function DOES and what the change did to it (from whatItDoes, in plain words, no metrics), and which part deserves reading. Then ask whether they want the agents to review it (open_review) or prefer to read it themselves (mark_read when they say they read it).'
      : 'The code panel is open. Say in one or two sentences what it is and does. Agents do not review this kind of spot.' };
  },
  async spot_tab({ tab }) {
    const mode = { code: 'code', all_code: 'all', evidence: 'ev', dependencies: 'deps' }[tab];
    if (!call('codeInfo')) return { error: 'No code panel is open. Call open_spot first.' };
    if (!mode || !call('codeTab', mode)) return { error: `This spot has no "${tab}" tab.` };
    act(tab === 'all_code' ? 'All code' : tab[0].toUpperCase() + tab.slice(1));
    return { ...call('codeInfo'), note: tab === 'dependencies' ? 'Say which two chunks should be read together and through which name.' : tab === 'evidence' ? 'Say what was established and which criteria it misses, if any.' : undefined };
  },
  async open_review({ query = '' } = {}) {
    if (!inGraph()) return { error: 'Open a pull request first.' };
    if (call('debateOpen')) call('closeDebate');
    let r;
    if (app()?.math) { // one function of the mathematical graph, reviewed alone by three agents
      const g = typeof G !== 'undefined' ? G : null;
      const found = query ? findSpot(query) : null, hit = found?.kind === 'sym' ? found : null;
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
      first: q.slice(0, 5).map((x) => ({ name: x.name, where: `${x.file}:${x.line}`, state: x.state, why: x.why })), backedByTests: tested(), dependencyGraph: m.graph, decisionModel: m.routing?.status === 'used' ? `asked, raised ${m.routing.adopted.length} node(s)` : m.routing?.status,
      meaning: 'proved = a proof that the edit cannot change behaviour (same tokens, or only local variables renamed). cleared = nothing flagged and low exposure, NOT a proof. uncertain / risky = behaviour changed and mathematics cannot vouch for it: these go to the agents and to the person. Node size = how much code depends on it.', limits: s.math.limits };
  },
  async prove_it({ query = '' } = {}) {
    const s = app(); if (!inGraph() || !s?.math) return { error: 'Open a pull request first.' };
    if (call('treeOpen')) { call('closeTree'); await sleep(600); }
    const node = query ? (call('findNodes', query) || []).find((n) => n.m?.principles) : s.fixTarget?.m?.principles ? s.fixTarget : null;
    if (!node) return { error: query ? `No changed function with principles matches "${query}".` : 'Say which function: nothing is selected.' };
    const d = call('proveNode', node.id);
    if (!d) return { error: 'That spot has no principles (documentation, configuration or an unchanged neighbour).' };
    act(`Prove it · ${node.label}`);
    const g = d.principleGate || {};
    return { spot: d.qname, colour: d.verdict, passes: `${g.passed}/${g.applicable}`, failing: d.principles.filter((p) => p.state === 'warn' || p.state === 'fail').map((p) => ({ principle: p.name, value: p.value, why: p.detail })), passing: d.principles.filter((p) => p.state === 'pass' || p.state === 'inherited').map((p) => `${p.name}: ${p.value}`), note: 'Say first which principles it does not meet and why, in plain words; then that the rest pass. Passing a check is not proof of correctness; only "Same behaviour" is a proof. What principles cannot say (does it do what was asked) is what the agents check.' };
  },
  async decide_pull_request({ decision }) {
    const s = app(); if (!inGraph() || !s?.math || !s.cur) return { error: 'Open a pull request first.' };
    const left = call('mathQueue') || [], differs = Object.values(s.marks || {}).filter((m) => m.state === 'differs').length, name = s.cur.branch;
    const own = s.cur.direction === 'outgoing';
    if (decision === 'accept' && (own || !differs)) { // the agents review what is left (and fix your own branch) and it merges
      act(`Merging · ${name}`);
      const r = await call('mergeFlow');
      if (r?.ok) return { ok: true, decision, screen: 'home', note: 'The agents checked what was left and it merged: back on the branch tree, the branch is merging into the base line. Say it in one short sentence.' };
      return { error: r?.error || 'It could not be merged.', note: r?.differs ? 'The agents found faults in someone else\'s branch: offer apply_fix (one fault) or request_changes.' : undefined };
    }
    if (decision === 'request_changes' && own) return { error: 'This is the user\'s own branch: it is not sent back. If the agents found faults, offer apply_fix: they implement the fix.' };
    if (decision === 'apply_fix' && own && differs) {
      const f = await call('applyFix');
      if (!f) return { error: 'The fix could not be applied.' };
      act(`Fixed · ${name}`, 'ok');
      return { ok: true, ...f, note: 'The agents implemented the fix on the user\'s own branch; the spots are green. Say what they changed in one sentence, then ask whether to merge (decision accept).' };
    }
    if (decision === 'apply_fix') {
      if (differs !== 1) return { error: differs ? `Merge blocked: the agents wrote ${differs} spots differently. That is not a small fix; offer to request changes.` : 'There is nothing to fix here.' };
      const f = await call('applyFix');
      if (!f) return { error: 'The fix could not be applied.' };
      act(`Fixed · ${f.spot}`, 'ok');
      return { ok: true, ...f, note: 'The spot is green now. Say in one sentence what the agents changed and why, then ask whether to merge (decision accept).' };
    }
    if (decision === 'accept' && left.length) return { error: differs > 1 ? `Merge blocked: the agents wrote ${differs} spots differently. Warn the user and offer to request changes.` : differs ? 'It cannot be accepted as it is: the agents wrote one spot differently, and they have a small fix. Offer apply_fix, then accept.' : `It cannot be accepted yet: ${left.length} spot(s) still open. Review them first (review_all).`, open: left.slice(0, 5).map((n) => n.name) };
    const why = decision === 'accept' ? call('mergeBlocker') : '';
    if (why) return { error: why, hint: /not been reviewed/.test(why) ? 'Offer review_all, then apply_fix if a spot differs, then accept.' : undefined };
    if (!call('decidePR', decision === 'accept' ? 'merged' : 'returned')) return { error: 'Could not record the decision.' };
    act(decision === 'accept' ? `Merged · ${name}` : `Changes requested · ${name}`, decision === 'accept' ? 'ok' : 'bad');
    return { ok: true, decision, screen: 'home', note: decision === 'accept' ? 'Back on the branch tree: the branch is merging into the base line right now. Say it in one short sentence.' : 'Back on the branch tree: the branch is marked as sent back to its author. Say it in one short sentence.' };
  },
  async why_the_maths({ query = '' } = {}) {
    const s = app(); if (!inGraph() || !s?.math) return { error: 'Open a pull request first.' };
    const node = query ? (call('findNodes', query) || []).find((n) => n.m && n.kind !== 'ctx') : s.fixTarget;
    const d = node?.m; if (!d) return { error: query ? `No changed spot matches "${query}".` : 'Say which spot.' };
    const c = d.centrality || {}, g = d.principleGate || {}, mt = d.metrics || {};
    return {
      spot: d.qname, colour: d.verdict, claim: d.claim,
      callGraph: { pagerankPercentile: c.pagerankPct != null ? Math.round(c.pagerankPct * 100) : null, fanIn: c.fanIn ?? null, transitiveDependents: c.dependents ?? null, testsThatReachIt: c.testedBy ?? null, impact: d.impact, likelihood: d.likelihood, priority: d.priority },
      complexity: mt.cyclomatic != null ? { cyclomatic: mt.cyclomatic, before: mt.before, cognitive: mt.cognitive, nesting: mt.nesting, loc: mt.loc } : null,
      proof: d.proof ? `proved equivalent at level ${d.proof.level}` : 'no equivalence proof (behaviour changed)',
      principleGate: `${g.passed ?? '?'} of ${g.applicable ?? '?'} criteria pass`, failing: (d.principles || []).filter((p) => !p.info && (p.state === 'warn' || p.state === 'fail')).map((p) => `${p.name}: ${p.value}`),
      evidence: (d.evidence || []).map((r) => `${r.label}: ${r.value}`), entropyOfParts: (d.parts || []).map((p) => p.nats).slice(0, 4), sensitivity: d.sensitive?.label || 'normal',
      note: 'Answer in ONE or TWO short, technical sentences, naming the algorithms and the numbers that decided it (e.g. "PageRank in the 94th percentile with 17 callers, cyclomatic 9, no equivalence proof: amber"). No filler, no analogies. Only expand if asked.',
    };
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
    setDepth(['quick', 'standard', 'deep'].includes(profile) ? profile : 'standard');
    const started = (await call('verify')) !== false;
    if (started) act(`Reviewing (${s.profile})`);
    return started ? { started: true, profile: s.profile, note: 'Live progress shows in the bottom bar; when it ends the graph, the score and the agents story update with the real result.' } : { started: false, note: 'A verification is already running or starting, or no pull request is open.' };
  },
  async run_tests({ scope = 'spot', query = '', depth } = {}) {
    const s = app(); if (!s?.cur || !inGraph() || !s.math) return { error: 'Open a pull request first.' };
    if (s.es || s.starting) return { started: false, note: 'A review is already running: its progress is in the bottom bar.' };
    if (depth) setDepth(depth);
    if (scope === 'continue') {
      if (!s.run?.brief?.contract || s.run.signoff) return { error: 'There is no unfinished review to continue. Use scope "spot" or "all".' };
      await toGraph();
      const ok = await call('continueReview');
      if (ok) act('Continuing the investigation');
      return ok ? { started: true, depth: s.profile, note: 'Same contract, new budget. It takes minutes; the tree grows live.' } : { started: false, note: 'It could not continue. The bar says why.' };
    }
    const t = s.math.trust;
    if (!t?.total) return { error: 'Tests can only back changed C# functions, and this change has none. The agents (open_review) work in any language.' };
    let focus = 'all', name = 'the whole change';
    if (scope !== 'all') {
      const asked = query ? findSpot(query) : s.fixTarget;
      if (query && !asked) return { error: `No changed function matches "${query}".` };
      const n = call('testTarget', asked?.m || null);
      if (!n) return { started: false, note: 'Every function tests can reach is already backed by tests.', backedByTests: tested() };
      if (query && n.id !== asked?.m?.id) return { error: `Tests cannot take "${asked.label}": it is not a changed C# function, or it is already backed.`, next: n.qname };
      focus = [n.id]; name = n.qname || n.name;
    }
    await toGraph();
    const r = await call('openTree', { force: true, focusNodes: focus });
    if (!r || r.started === false || r.error) return { started: false, error: r?.error || 'The review could not start. The bar says why.' };
    act(`Testing ${scope === 'all' ? 'the whole change' : name.split('.').pop()}`);
    return { started: true, scope: name, depth: s.profile, note: `A real review is running now, up to ${{ quick: '90 seconds', standard: '5 minutes', deep: '15 minutes' }[s.profile]}: the tree grows live and ends in a verdict card.${s.profile === 'quick' ? ' At Quick depth it cannot settle the spot: say so.' : ''} "Backed by tests" in the depth menu moves only if the tests back it.` };
  },
  async open_report() {
    const s = app(); if (!s?.cur || !inGraph()) return { error: 'Open a pull request first.' };
    const b = s.run?.brief;
    if (!(b?.version >= 2) && !s.es) return { error: 'This pull request has no full review yet, so there is no report.', tip: 'start_verification runs one (ask for a yes first); run_tests backs single functions with tests.' };
    await toGraph();
    const r = await call('openReview', { full: true });
    if (!r || r.error) return { error: r?.error || 'Could not open the report.' };
    act(s.run?.signoff ? 'Sign-off' : 'Report');
    return { ...r, summary: briefOf(b, 'summary'), scopedToSomeFunctions: !!b?.graphReview || undefined, note: r.live ? 'The review is still running: the tree grows live.' : 'The verdict card is on screen. Say the verdict and the score in one sentence and what blocks approval, if anything. Signing is done by the person in the card, never by you.' };
  },
  async explain_context({ about = 'project', query = '' } = {}) {
    const s = app(); if (!s?.pid) return { error: 'No project is open. open_project shows them.' };
    if (about === 'project') return (await context('project')) || { error: 'Could not read the project.' };
    if (!s.cur || !inGraph()) return { error: 'Open a pull request first.' };
    if (about === 'change') return (await context('change')) || { error: 'Could not read what this change is for.' };
    if (!s.math) return { error: 'This graph has no functions to explain.' };
    const node = query ? findSpot(query) : s.fixTarget || (call('codeInfo') ? (call('findNodes', call('codeInfo').spot) || [])[0] : null);
    if (!node?.m) return { error: query ? `No function matches "${query}".` : 'Say which function: none is open.' };
    const d = await context('spot', node.m.id);
    return d ? { ...d, note: 'Explain what it does as you would to a colleague new to this code: its job, who relies on it, what this change did to it. Not line by line, no metrics.' } : { error: 'Could not read that function.' };
  },
  async open_project({ query = '' } = {}) {
    const s = app(), list = s?.projects || [];
    if (!list.length) return { error: 'There are no projects yet. One is added from the project picker, by hand.' };
    const q = String(query).toLowerCase().trim();
    const p = q ? list.find((x) => x.name.toLowerCase() === q) || list.find((x) => x.name.toLowerCase().includes(q)) || list.find((x) => q.split(/\s+/).filter((w) => w.length > 2).some((w) => x.name.toLowerCase().includes(w))) : null;
    if (q && !p) return { error: `No project matches "${query}".`, projects: projectList() };
    if (inGraph()) { call('closeGraph'); await sleep(780); }
    if (!p) { call('showLanding'); act('Projects'); await sleep(500); return { shown: 'the project picker', projects: projectList() }; }
    if (p.id === s.pid) { call('pickProject', p.id); return { alreadyOpen: true, project: p.name }; }
    call('pickProject', p.id); act(`Project ${p.name}`);
    await waitFor(() => app()?.pid === p.id && !!app()?.prsKey, 9000); // its branches have loaded
    const all = allPRs();
    return { opened: p.name, base: app()?.base, pullRequests: all.slice(0, 12).map((x, i) => prBrief(x, i)) };
  },
  async end_conversation() { end(); return { ok: true, note: 'Say a very short goodbye (2-4 words); the voice closes when you finish.' }; },
};
return { TOOLS, TOOL_FN };
}
