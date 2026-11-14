import {test} from 'node:test';
import assert from 'node:assert/strict';
import {graphScope,focusGroups,nodeResults,trustProgress} from '../server/graph-review.js';
const n={id:'f.cs::F',file:'f.cs',name:'F',kind:'method',start:10,end:20,status:'modified',verdict:'risky',impact:1};
const other={...n,id:'g.cs::G',file:'g.cs',name:'G',impact:0};
const math={key:'code-v1',head:'head',base:'base',nodes:[n,other]};
const scope=graphScope(math,[n.id],'requirement');
const report=status=>({graphReview:{scope,nodes:[{id:n.id,status}]}});
test('selection cannot shrink the denominator or accept an unknown node',()=>{assert.equal(scope.denominator.length,2);assert.throws(()=>graphScope(math,['unknown'],'r'));});
test('weighted scope, failures and untested work remain separate',()=>{assert.equal(trustProgress(scope,[report('verified')]).percent,83);assert.equal(trustProgress(scope,[report('failed')]).percent,0);assert.equal(trustProgress(scope,[report('failed')]).failed,1);});
test('changed code or requirement invalidates earlier support',()=>{assert.equal(trustProgress(graphScope({...math,key:'v2'},[n.id],'requirement'),[report('verified')]).percent,0);assert.equal(trustProgress(graphScope(math,[n.id],'new requirement'),[report('verified')]).percent,0);});
test('latest failed or incomplete review replaces prior success',()=>{assert.equal(trustProgress(scope,[report('verified'),report('pending')]).percent,0);});
test('names bind historical groups despite line shifts; other files excluded',()=>{const groups=focusGroups([{file:'f.cs',symbol:'Class.F(System.String, Namespace.Type)',start:1,end:4},{file:'g.cs',symbol:'G'}],scope);assert.equal(groups.length,1);assert.deepEqual(groups[0].nodeIds,[n.id]);assert.throws(()=>focusGroups([{file:'other.cs',symbol:'F'}],scope));});
const attack={id:'A',status:'admitted',nodeIds:[n.id],names:['Test'],expectations:['E1']};
const result=(version,outcome='Passed')=>({id:version,version,scope:'relevant-suite',status:outcome==='Passed'?'passed':'failed',ran:1,executionComplete:true,tests:[{name:'Test',outcome}]});
const state=()=>({nodeProbes:[{node:n.id,status:'detected',attacks:['A']}],groups:[{id:'G1',nodeIds:[n.id],expectations:['E1']}],verdict:{status:'ready-for-human',confirmed:[],verified:['E1']},attacks:[attack],candidates:[{id:'C1',group:'G1',status:'built'},{id:'C2',group:'G1',status:'built'}],evidence:[result('original'),result('C1'),result('C2')]});
test('executed original and alternatives support only declared selected scope',()=>{assert.equal(nodeResults(scope,state())[0].status,'verified');});
for(const [name,edit] of Object.entries({zero:s=>s.evidence.forEach(e=>e.ran=0),timeout:s=>s.evidence[0].status='timeout',noCandidate:s=>s.candidates=[],noTarget:s=>s.attacks=[],incomplete:s=>s.verdict.status='insufficient-evidence',noContract:s=>s.verdict.verified=[],unfinished:s=>s.evidence[0].executionComplete=false})) test(name+' never earns support',()=>{const s=state();edit(s);assert.equal(nodeResults(scope,s)[0].status,'pending');});
test('candidate-only failure does not accuse original',()=>{const s=state();s.evidence[1]=result('C1','Failed');assert.equal(nodeResults(scope,s)[0].status,'verified');});
test('confirmed original failure blocks support',()=>{const s=state();s.verdict.confirmed=[{expectations:['E1']}];assert.equal(nodeResults(scope,s)[0].status,'failed');});
test('partial graph cannot produce fully verified scope',()=>assert.equal(nodeResults({...scope,partial:true},state())[0].status,'pending'));

import {materializeScenario} from '../server/pipeline/messagepack-harness.js';
test('double-escaped source separators fail admission before compilation',()=>{assert.throws(()=>materializeScenario({test:{kind:'metadata',source:'using MessagePack;'+String.fromCharCode(92)+'npublic class Foo {}',library:'class Bar {}'}},'A'),/scenario-escaped-source/);});

test('model node attribution alone cannot earn support',()=>{const s=state();s.nodeProbes=[];assert.equal(nodeResults(scope,s)[0].status,'pending');});

import {probeOutcome} from '../server/pipeline/node-probes.js';
import {repairAccepted} from '../server/pipeline/repair.js';
test('probe requires the same passing test to fail with its unique marker',()=>{const a={names:['Test']};const good=result('original');const bad=result('probe','Failed');bad.tests[0].error='KATSE_PROBE_abc';assert.equal(probeOutcome('KATSE_PROBE_abc',a,good,bad),true);assert.equal(probeOutcome('different',a,good,bad),false);assert.equal(probeOutcome('KATSE_PROBE_abc',a,bad,bad),false);});
test('repair requires completed nonempty passing regression execution',()=>{assert.equal(repairAccepted({...result('repair'),failed:0}),true);assert.equal(repairAccepted({...result('repair'),failed:0,ran:0}),false);assert.equal(repairAccepted({...result('repair'),failed:1}),false);assert.equal(repairAccepted({...result('repair'),failed:0,executionComplete:false}),false);});
