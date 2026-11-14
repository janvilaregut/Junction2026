// Graph-directed execution. Percentages describe checked scope, never probability of correctness.
import { sha256, ROOT } from './util.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const environmentKey=()=>sha256(JSON.stringify([process.platform,process.arch,process.version,process.env.DOTNET_ROOT || '',(fs.existsSync(path.join(os.homedir(),'.dotnet','sdk'))?fs.readdirSync(path.join(os.homedir(),'.dotnet','sdk')).sort():[]),...['graph-review.js','pipeline/evidence.js','pipeline/node-probes.js','pipeline/toolchain.js','pipeline/messagepack-harness.js'].map(f=>sha256(fs.readFileSync(path.join(ROOT,'server',f))))]));
import { attackOutcome } from './pipeline/evidence.js';
export const eligible = n => n.status !== 'context' && n.verdict !== 'context' && n.status !== 'removed' && !['doc','config','generated','type','test'].includes(n.kind) && n.file?.endsWith('.cs');
// A node's `name` is the label the graph draws, cut at 28 characters: the scope carries the full name (`qname`),
// or a long function could never be matched to its behaviour group.
export function graphScope(math, requested, requirement) {
  const pool = math.nodes.filter(eligible);
  const relevant = pool.filter(n => n.verdict !== 'proved');
  const ids = requested === 'all' ? relevant.map(n=>n.id) : requested === 'relevant' ? relevant.filter(n => ['risky','uncertain'].includes(n.verdict) || n.impact >= .6).map(n=>n.id) : requested;
  if (!Array.isArray(ids) || !ids.length || ids.length > 44 || ids.some(id=>!pool.some(n=>n.id===id))) throw new Error('Select an existing changed C# function to execute');
  const nodes = pool.filter(n=>ids.includes(n.id)).map(n=>({id:n.id,file:n.file,symbol:n.qname || n.name,status:n.status,start:n.start,end:n.end,impact:n.impact,priority:n.priority}));
  return {version:2,key:sha256(JSON.stringify([2, math.key, requirement, environmentKey()])),head:math.head,base:math.base,nodes,partial:math.partial,denominator:relevant.map(n=>({id:n.id,weight:1+4*Math.max(0,Math.min(1,n.impact || 0))})),meaning:'Share of changed executable scope supported by scoped checks, weighted by impact; not a bug-free probability'};
}
export function focusGroups(groups, scope) {
  if (!scope) return groups;
  const focused = groups.flatMap(g=> {
    const nodes=scope.nodes.filter(n=>n.file===g.file && (g.symbol ? g.symbol.split('(')[0].split('.').pop()===n.symbol.split('(')[0].split('.').pop() : (n.status==='added' && g.fallback) || (g.start<=n.end && g.end>=n.start)));
    return nodes.length ? [{...g,nodeIds:nodes.map(n=>n.id),risk:Math.max(g.risk,...nodes.map(n=>n.impact>=.6?3:2)),riskReason:g.riskReason+'; selected from dependency graph'}] : [];
  });
  if (!focused.length) throw new Error('Selected nodes could not be mapped to historical behavior groups');
  return focused;
}
export function nodeResults(scope, state) {
  if (!scope) return [];
  return scope.nodes.map(n=>{
    const groups=state.groups.filter(g=>g.nodeIds?.includes(n.id));
    const ids=[...new Set(groups.flatMap(g=>g.expectations))];
    const findings=state.verdict.confirmed.filter(f=>f.expectations.some(id=>ids.includes(id)));
    const attacks=state.attacks.filter(a=>a.status==='admitted' && a.nodeIds?.includes(n.id));
    const originals=state.evidence.filter(e=>e.version==='original');
    const candidates=state.candidates.filter(c=>c.status==='built' && (c.scopeNodes?.includes(n.id) || groups.some(g=>g.id===c.group)));
    const compared=attacks.filter(a=>originals.some(e=>attackOutcome(a,e)==='passed') && candidates.filter(c=>state.evidence.some(e=>e.version===c.id && ['passed','failed'].includes(attackOutcome(a,e)))).length>=2);
    const suite=originals.some(e=>e.scope==='relevant-suite' && e.status==='passed' && e.ran>0 && e.executionComplete===true);
    const reached=compared.some(a=>(state.nodeProbes || []).some(p=>p.node===n.id && p.status==='detected' && p.attacks.includes(a.id)));
    const passed=reached && !scope.partial && state.verdict.status==='ready-for-human' && ids.length>0 && ids.every(id=>state.verdict.verified.includes(id)) && compared.length>0 && suite;
    return {id:n.id,status:findings.length?'failed':passed?'verified':'pending',expectations:ids,attacks:compared.map(a=>a.id),evidence:[...new Set(originals.filter(e=>e.ran>0).map(e=>e.id))],reason:findings.length?'A grounded original failure was reproduced; inspect the linked expectation':passed?'Declared expectations, independent alternatives and relevant regression suite checked':'Requires grounded expectations, two tested alternatives, targeted attacks, a detected deterministic node probe and completed judgment'};
  });
}
export function trustProgress(scope, reports) {
  const latest=new Map();
  for (const r of reports) if(r.graphReview?.scope?.key===scope.key) for(const n of r.graphReview.nodes) latest.set(n.id,n);
  const nodes=scope.denominator.map(n=>({...n,...latest.get(n.id),status:latest.get(n.id)?.status || 'pending'}));
  const total=nodes.reduce((s,n)=>s+n.weight,0), supported=nodes.filter(n=>n.status==='verified').reduce((s,n)=>s+n.weight,0);
  const percent=total?Math.floor(100*supported/total):null;
  return {percent:scope.partial && percent===100?99:percent,verified:nodes.filter(n=>n.status==='verified').length,failed:nodes.filter(n=>n.status==='failed').length,pending:nodes.filter(n=>n.status==='pending').length,total:nodes.length,nodes,meaning:scope.meaning,partial:scope.partial};
}
