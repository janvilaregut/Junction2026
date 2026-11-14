import test from 'node:test';
import assert from 'node:assert/strict';
import { intentInput, normalizeIntent, intentPending } from '../server/pipeline/intent.js';
import { validateContract } from '../server/pipeline/contract.js';
import { adjudicate } from '../server/pipeline/evidence.js';

const sources = [{id:'issue', kind:'requirement', text:'Preserve unrelated diagnostics.'}];
const contract = () => validateContract({expectations:[{behavior:'Preserve diagnostics', status:'documented', sources:[{id:'issue',quote:sources[0].text}]}]},sources);
const patch = '--- a/code.cs\n+++ b/code.cs\n-ReportDiagnostic(node);\n+if (node != null) ReportDiagnostic(node);\n';
const row = {expectation:'E1',assessment:'aligned',implemented:'Protege el diagnóstico con una condición.',patchQuote:'if (node != null)',source:{id:'issue',quote:sources[0].text},question:''};
const context = () => intentInput(contract(),patch,{proposed:'head',historicalBase:'base'});

test('original provenance never comes from candidate records or an inferred description', () => {
  const view = normalizeIntent([row],context(),contract());
  assert.equal(view.originalPromptStatus,'unavailable');
  assert.equal(view.confidenceContribution,0);
  assert.equal(view.patch,undefined);
  const c = contract(); c.sources.push({id:'prompt-1',kind:'user-prompt',uri:'entire:checkpoint:1',text:'Recorded user instruction'});
  assert.equal(intentInput(c,patch,{}).originalPrompts[0].uri,'entire:checkpoint:1');
});

test('fabricated citations, diff headers, duplicates and missing rows stay pending', () => {
  for (const rows of [[],[row,row],[{...row,patchQuote:'fabricated code'}],[{...row,patchQuote:'b/code.cs'}],[{...row,source:{id:'issue',quote:'invented requirement'}}]]) {
    const view = normalizeIntent(rows,context(),contract());
    assert.equal(view.rows[0].assessment,'uncertain');
    assert.equal(intentPending(view).length,1);
  }
});

test('citation-backed alignment cannot substitute for executed tests; deviations do not prove bugs', () => {
  const view = normalizeIntent([row],context(),contract());
  assert.equal(view.rows[0].citationsVerified,true);
  assert.deepEqual(intentPending(view),[]);
  const gap = normalizeIntent([{...row,assessment:'gap'}],context(),contract());
  const verdict = adjudicate({contract:contract(),semantic:{ambiguities:[],contradictions:[]},extraPending:intentPending(gap),complete:true});
  assert.equal(verdict.status,'insufficient-evidence');
  assert.equal(verdict.confirmed.length,0);
  assert.equal(verdict.score.value,null);
});

test('comparison input is bounded and binds both code and contract versions', () => {
  const input = context();
  assert.notEqual(input.patchHash,intentInput(contract(),patch+'changed',{}).patchHash);
  assert.equal(input.contractHash,contract().hash);
  const large = intentInput(contract(),'a'.repeat(8000),{});
  assert.equal(large.patch.length,6000); assert.equal(large.truncated,true);
});
