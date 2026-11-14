// Pairwise debate between candidate solutions. Whoever convinces the other absorbs their group and moves on.
// Groups start from the heatmap (near-identical solutions already agree) and merge round by round.
// Each member keeps a stance: 'own' (its code is the group's), 'equivalent' (merged as behaviourally equal)
// or 'conceded' (it gave up its code). A PR that conceded is not "in" the consensus, even if it sits in the group.
import { generateJSON, TOP_MODEL } from './gemini.js';
import { disagreements } from './heatmap.js';
import { LANG_NAME, langOf, strings } from './lang.js';

const MAX_ROUNDS = 4;
const SAME_AT = 0.9;
const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + '\n… (truncated)' : s || '');

const debater = (lang) => `You take part in a code review by debate. Several independent solutions try to satisfy the SAME requirement.
Your goal is not to win: it is for the group to end up with the correct solution. Judge only by the requirement and by the code's behaviour.
Differences in style, naming or formatting do not matter; behavioural bugs, edge cases and anything the requirement asks for and is missing do.
A flaw only counts if it breaks something the requirement states (quote the sentence) or the code's existing contract (e.g. it breaks an existing test or behaviour).
Extra hardening the requirement does not ask for (unusual input types, hypothetical misuse, defensive checks, more tests) is NOT a flaw of the solution without it.
Always answer in JSON. Write every text field in ${LANG_NAME[lang]}.`;

function who(c) {
  return c.role === 'advocate'
    ? 'You defend the real pull request (someone else wrote it). Defend it honestly, without inventing virtues.'
    : 'You defend the solution you wrote.';
}

function brief(c) {
  return `Solution ${c.id}${c.role === 'advocate' ? ' (the pull request)' : ''}${c.summary ? `\nIts author's summary: ${clip(c.summary, 500)}` : ''}\n\`\`\`diff\n${clip(c.diff, 9000) || '(changes nothing)'}\n\`\`\``;
}

const genFor = (c) => ({ ...c.gen, thinkingLevel: c.gen?.thinkingLevel || 'high' });

async function argue(me, rival, ctx) {
  const prompt = `${who(me)}\n\n## Requirement\n${ctx.requirement}\n\n## Your solution\n${brief(me)}\n\n## The rival solution\n${brief(rival)}\n\n## Zones where you disagree\n${disagreements(ctx.heatmap, me.id, rival.id) || '(the texts almost match)'}\n\nWrite your argument for the rival: defend what your solution does right and point out CONCRETE flaws of the rival against the requirement. Each flaw must quote the requirement sentence it breaks and give an example input with actual vs expected result. If the rival is better or equivalent, say so plainly.\nJSON: {"argument": "max 120 words", "rival_flaws": ["«quoted requirement sentence» — input → actual vs expected"], "confidence": 0..1}`;
  return generateJSON({ model: me.model || TOP_MODEL, system: debater(ctx.lang), gen: genFor(me), contents: [{ role: 'user', parts: [{ text: prompt }] }] });
}

async function decide(me, rival, rivalArg, ctx) {
  const prompt = `${who(me)}\n\n## Requirement\n${ctx.requirement}\n\n## Your solution\n${brief(me)}\n\n## The rival solution\n${brief(rival)}\n\n## The rival's argument\n${rivalArg.argument}\nFlaws it points out in yours: ${(rivalArg.rival_flaws || []).join(' | ') || '(none)'}\n\nCheck every flaw it points out against your code AND against the requirement text. Decide:\n- convinced=true only if a flaw is real in your code AND breaks a sentence the requirement actually states (or an existing behaviour/test). Trace the example input through your code before accepting it.\n- equivalent=true if both behave the same for everything the requirement asks, even if one adds hardening or tests the requirement does not ask for.\n- If its flaws are not real, or are only about things the requirement does not ask, hold your ground: convinced=false.\nJSON: {"convinced": bool, "equivalent": bool, "reason": "max 60 words", "confidence": 0..1}`;
  return generateJSON({ model: me.model || TOP_MODEL, system: debater(ctx.lang), gen: genFor(me), contents: [{ role: 'user', parts: [{ text: prompt }] }] });
}

/** Initial groups: candidates whose code is identical in every zone (whitespace aside). Anything else debates. */
export function initialGroups(candidates, heatmap) {
  const groups = [];
  for (const c of candidates) {
    const g = groups.find((x) => (heatmap.exact ? heatmap.exact[x.leader]?.[c.id] : (heatmap.matrix[x.leader]?.[c.id] ?? 0) >= SAME_AT));
    if (g) g.members.push(c.id); else groups.push({ leader: c.id, members: [c.id] });
  }
  return groups;
}

/**
 * Run the tournament. emit(event) receives debate/argument/decision/convinced/hold/groups events.
 * Returns { groups, rounds, stance }.
 */
export async function runDebate({ candidates, heatmap, requirement, emit, lang = 'en' }) {
  lang = langOf(lang);
  const t = strings(lang);
  const byId = Object.fromEntries(candidates.map((c) => [c.id, c]));
  let groups = initialGroups(candidates, heatmap);
  const stance = Object.fromEntries(candidates.map((c) => [c.id, 'own']));
  for (const g of groups) for (const m of g.members) if (m !== g.leader) stance[m] = 'equivalent';
  const ctx = { requirement, heatmap, lang };
  const tried = new Set();
  const rounds = [];
  const snapshot = () => groups.map((g) => ({ leader: g.leader, members: [...g.members] }));
  emit({ type: 'groups', round: 0, groups: snapshot(), stance: { ...stance } });

  for (let round = 1; round <= MAX_ROUNDS && groups.length > 1; round++) {
    // Pair groups: biggest first, each with the most different group it has not faced yet.
    const order = [...groups].sort((a, b) => b.members.length - a.members.length);
    const used = new Set();
    const pairs = [];
    for (const g of order) {
      if (used.has(g.leader)) continue;
      const rival = order
        .filter((h) => h !== g && !used.has(h.leader) && !tried.has([g.leader, h.leader].sort().join('|')))
        .sort((x, y) => (heatmap.matrix[g.leader]?.[x.leader] ?? 0) - (heatmap.matrix[g.leader]?.[y.leader] ?? 0))[0];
      if (!rival) continue;
      used.add(g.leader); used.add(rival.leader);
      tried.add([g.leader, rival.leader].sort().join('|'));
      pairs.push([g, rival]);
    }
    if (!pairs.length) break;

    const results = await Promise.all(pairs.map(async ([ga, gb]) => {
      const a = byId[ga.leader];
      const b = byId[gb.leader];
      emit({ type: 'debate', round, pair: [a.id, b.id] });
      try {
        const [argA, argB] = await Promise.all([argue(a, b, ctx), argue(b, a, ctx)]);
        emit({ type: 'argument', round, from: a.id, to: b.id, text: argA.argument, faults: argA.rival_flaws || [] });
        emit({ type: 'argument', round, from: b.id, to: a.id, text: argB.argument, faults: argB.rival_flaws || [] });
        const [decA, decB] = await Promise.all([decide(a, b, argB, ctx), decide(b, a, argA, ctx)]);
        emit({ type: 'decision', round, agent: a.id, convinced: !!decA.convinced, equivalent: !!decA.equivalent, reason: decA.reason, confidence: decA.confidence });
        emit({ type: 'decision', round, agent: b.id, convinced: !!decB.convinced, equivalent: !!decB.equivalent, reason: decB.reason, confidence: decB.confidence });
        const rec = { round, pair: [a.id, b.id], arguments: { [a.id]: argA, [b.id]: argB }, decisions: { [a.id]: decA, [b.id]: decB } };
        if (decA.convinced && decB.convinced) {
          // Mutual concession: each admits a real flaw in its own code, so neither code can win (no merge).
          // Every member of both groups now backs code its own leader called flawed: they count as conceded.
          for (const m of [...ga.members, ...gb.members]) stance[m] = 'conceded';
          const why = `${t.mutual} ${a.id}: ${decA.reason} · ${b.id}: ${decB.reason}`;
          emit({ type: 'hold', round, pair: [a.id, b.id], reason: why, stance: { ...stance } });
          return { ...rec, hold: true, mutual: true, reason: why };
        }
        let winner = null;
        let kind = 'convinced';
        let reason = '';
        if (decA.convinced) { winner = gb; reason = decA.reason; }
        else if (decB.convinced) { winner = ga; reason = decB.reason; }
        else if (decA.equivalent && decB.equivalent) {
          winner = ga.members.length >= gb.members.length ? ga : gb;
          kind = 'equivalent';
          reason = t.equivalent(decA.reason);
        }
        const loser = winner === ga ? gb : winner === gb ? ga : null;
        if (winner) {
          for (const m of loser.members) if (kind === 'convinced' || stance[m] === 'own') stance[m] = kind === 'convinced' ? 'conceded' : 'equivalent';
          winner.members.push(...loser.members);
          loser.members = [];
          emit({ type: 'convinced', round, kind, winner: winner.leader, loser: loser.leader, absorbed: [...winner.members], reason, stance: { ...stance } });
          return { ...rec, kind, winner: winner.leader, loser: loser.leader, reason };
        }
        const why = `${a.id}: ${decA.reason} · ${b.id}: ${decB.reason}`;
        emit({ type: 'hold', round, pair: [a.id, b.id], reason: why });
        return { ...rec, hold: true, reason: why };
      } catch (e) {
        emit({ type: 'hold', round, pair: [a.id, b.id], reason: t.debateError(e.message) });
        return { round, pair: [a.id, b.id], hold: true, error: e.message };
      }
    }));
    rounds.push(...results);
    groups = groups.filter((g) => g.members.length);
    emit({ type: 'groups', round, groups: snapshot(), stance: { ...stance } });
    // Stop when nobody changed their mind and every remaining pair has already met.
    if (results.every((r) => r.hold) && groups.every((g, i) => groups.every((h, j) => i === j || tried.has([g.leader, h.leader].sort().join('|'))))) break;
  }
  return { groups, rounds, stance };
}
