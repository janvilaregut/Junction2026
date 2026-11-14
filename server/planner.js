import { initialPopulation, priority } from './execution.js';
export function populationPlan(groups,profile,{remainingMs,tokens,buildMs=45000,validationMs=40000}={}) {
  const proposed=initialPopulation(groups), cap=profile.id==='quick'?0:profile.id==='standard'?2:4;
  // One runner: every candidate must have time to be tested, not merely generated.
  const timeCap=Math.max(0,Math.floor((remainingMs-60000)/(validationMs+buildMs/2)));
  const tokenCap=Math.max(0,Math.floor((tokens-18000)/10000));
  return {formula:'min(4, 2 + ceil(log2(G)) + H)',G:groups.length,H:groups.filter(g=>g.risk===3).length,proposed,admitted:Math.min(proposed,cap,timeCap,tokenCap),caps:{profile:cap,time:timeCap,tokens:tokenCap},estimates:{buildMs,validationMs},reason:'Heuristic demand bounded by remaining time, tokens and profile; validation and reporting reserved'};
}
export function allocateGroup(groups) {
  const group=[...groups].sort((a,b)=>priority(b)-priority(a)||a.id.localeCompare(b.id))[0];
  if(!group)return null;
  const selected={...group,priority:priority(group)};
  group.explored++; // reserve before concurrent work starts, not when it ends
  return selected;
}
export function groupMission(group,contract,decision='repair') {
  if(!group)return 'No executable group';
  return JSON.stringify({group:group.id,file:group.file,symbol:group.symbol,lines:[group.start,group.end],risk:group.risk,riskReason:group.riskReason,mission:decision,expectations:contract.expectations.filter(e=>group.expectations.includes(e.id)).map(e=>({id:e.id,behavior:e.behavior})),instruction:'Focus on this group and its direct dependencies. Preserve every other contract expectation. Do not invent changes outside supplied source blocks.'});
}
// This is a work list, never proof of coverage. Only the admitted test's own
// expectation IDs and an original execution can remove a critical gap.
export function unverifiedCritical(expectations,attacks,evidence,outcome) {
  const covered=new Set(attacks.filter(a=>a.status==='admitted' && evidence.some(e=>e.version==='original' && outcome(a,e)==='passed')).flatMap(a=>a.expectations));
  return expectations.filter(e=>e.critical && e.status!=='pending' && e.sources?.length && !covered.has(e.id)).map(e=>e.id);
}
export function updateGroups(groups,attacks,evidence,outcome) {
  for(const g of groups) {
    const relevant=attacks.filter(a=>a.status==='admitted'&&a.expectations.some(id=>g.expectations.includes(id)));
    const verified=new Set(relevant.filter(a=>evidence.some(e=>e.version==='original'&&outcome(a,e)==='passed')).flatMap(a=>a.expectations));
    g.unverified=g.expectations.filter(id=>!verified.has(id)).length/Math.max(1,g.expectations.length);
    g.disagreement=relevant.length?relevant.filter(a=>new Set(evidence.map(e=>outcome(a,e)).filter(x=>x!=='pending')).size>1).length/relevant.length:null;
  }
}
