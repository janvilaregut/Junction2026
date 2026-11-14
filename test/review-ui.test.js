import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ctx = vm.createContext({esc, CLAIM:{parcial:['warn','Partial'],'no-ejecutado':['no','Not run']}});
vm.runInContext(fs.readFileSync(new URL('../mvp/review-evidence.js',import.meta.url),'utf8'),ctx);
const brief = () => ({
  contract:{expectations:[{id:'E1',status:'documented',critical:true,behavior:'No crash',sources:[{id:'ticket',quote:'Do not crash'}]}]},
  verdict:{pending:['E2 pending'],verified:['E1'],auditWarnings:['Alternative failed'],residualRisks:['Limited scope'],findings:[{expectations:['E1'],outcomes:[{version:'original',evidence:'o'}]}]},
  evidence:[{id:'o',version:'original',status:'passed',ran:171,executionComplete:true,artifact:'o.json',log:'o.log',trx:['o.trx'],tests:[]},{id:'c',version:'C2',status:'failed',ran:171,executionComplete:true,artifact:'c.json',tests:[{name:'PreserveDiagnostic',outcome:'Failed',error:'Unexpected diagnostic'}]}],
  candidates:[{id:'C2',model:'google/fast',requestedModel:'verda/nemotron',modelFallback:true,patch:'C2.patch',checkpoint:{status:'captured',id:'checkpoint',metadata:'C2-checkpoint.json',transcript:'C2-transcript.jsonl'}}],
  l2:{newTests:[{name:'Reproducer',red:'Failed',green:'Passed'}]},
});
test('review exposes original and candidate results, baseline, source citations and executable artifacts',()=>{
  const html=ctx.reviewEvidenceHTML(brief());
  for(const text of ['original · passed','C2 · failed','PreserveDiagnostic','Unexpected diagnostic','Base: Failed','Original: Passed','Do not crash','o.json','o.log','o.trx','E2 pending','Alternative failed']) assert.ok(html.includes(text),text);
});
test('candidate capture is separate from historical provenance and substitutions remain visible',()=>{
  const b=brief(); Object.assign(b.candidates[0],{continuedFrom:'previous-run',restoredFromCommit:'captured-sha'});
  const html=ctx.reviewEvidenceHTML(b);
  for(const text of ['C2-transcript.jsonl','C2-checkpoint.json','C2.patch','verda/nemotron','substituted','do not recover a missing historical prompt']) assert.ok(html.includes(text),text);
  assert.ok(html.includes('captured-sha')); assert.ok(html.includes('current commit records restoration'));
});
test('untrusted source, logs and identifiers are escaped and invalid artifact paths are refused',()=>{
  const b=brief();b.contract.expectations[0].behavior='<img src=x onerror=alert(1)>';
  b.evidence[1].tests[0].error='<script>bad</script>';
  const html=ctx.reviewEvidenceHTML(b);
  assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img'));assert.ok(html.includes('&lt;script&gt;'));
  assert.equal(ctx.artifactButton('../secret','Bad'),'');assert.equal(ctx.artifactButton('x" onclick="bad','Bad'),'');
});
test('partial and older reports retain honest empty states and unknown usage',()=>{
  const html=ctx.reviewEvidenceHTML({budget:{usageIncomplete:true,accounting:{unknownReserved:500}}});
  assert.ok(html.includes('0 results'));assert.ok(html.includes('Usage is incomplete'));assert.ok(html.includes('500 tokens reserved'));
  assert.ok(!html.includes('captured'));
});

test('mutation and rewind claims expose their limits and link executable artifacts',()=>{
  const html=ctx.claimEvidenceHTML([
    {status:'no-ejecutado',text:'Mutations',detail:'Disabled for this profile',evidence:[]},
    {status:'parcial',text:'Rewind',detail:'One group can be removed without failing tests',evidence:[{label:'Rewind details',artifact:'rewind.json'}]},
  ]);
  for(const text of ['Not run','Disabled for this profile','Partial','One group can be removed','rewind.json']) assert.ok(html.includes(text));
});
