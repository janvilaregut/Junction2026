import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyProposal, deduplicateCandidates } from '../server/pipeline/proposals.js';
import { loadContinuation } from '../server/pipeline/resume.js';
import { contractHash, validateContract } from '../server/pipeline/contract.js';
import { sourceBlocks } from '../server/pipeline/source-context.js';
import { artifactManifest } from '../server/integrity.js';
import { DATA } from '../server/util.js';

function scratch(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'katse-proposal-test-'));
  t.after(()=>{assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'katse-proposal-test-'));fs.rmSync(dir,{recursive:true,force:true});});
  fs.mkdirSync(path.join(dir,'src'));fs.writeFileSync(path.join(dir,'src/A.cs'),'class A { string Text = "before"; }\n');
  fs.writeFileSync(path.join(dir,'src/B.cs'),'class B {}\n');return dir;
}
function continuation(t) {
  const root=path.join(DATA,'runs');fs.mkdirSync(root,{recursive:true});
  const dir=fs.mkdtempSync(path.join(root,'katse-resume-test-'));
  const projectId=path.basename(dir),runId='previous';const origin=path.join(dir,runId,'artifacts');fs.mkdirSync(origin,{recursive:true});
  const destination=fs.mkdtempSync(path.join(os.tmpdir(),'katse-resume-copy-'));
  t.after(()=>{
    assert.ok(path.resolve(dir).startsWith(path.resolve(root)+path.sep+'katse-resume-test-'));fs.rmSync(dir,{recursive:true,force:true});
    assert.ok(path.resolve(destination).startsWith(path.resolve(os.tmpdir())+path.sep+'katse-resume-copy-'));fs.rmSync(destination,{recursive:true,force:true});
  });
  const input={proposed:'head',target:'target',historicalBase:'base',requirement:{id:'2283',body:'required behavior'}};
  const contract={version:1,sources:[{id:'ticket',kind:'requirement',text:'required behavior'}],expectations:[{id:'E1',critical:true,status:'documented',sources:[{id:'ticket',quote:'required behavior'}],behavior:'required behavior'}]};contract.hash=contractHash(contract);
  const state={input,contract,candidates:[],attacks:[],sessions:[]};
  fs.writeFileSync(path.join(origin,'pipeline.json'),JSON.stringify(state));fs.writeFileSync(path.join(origin,'test.cs'),'class Test {}');
  const brief={version:2,contract,artifactManifest:artifactManifest(origin)};fs.writeFileSync(path.join(origin,'brief.json'),JSON.stringify(brief));
  return {input,contract,projectId,runId,origin,destination,state,brief,load:(changed=input)=>loadContinuation(projectId,runId,changed,destination)};
}

test('proposal applies unique literal replacements including dollar metacharacters',t=>{
  const dir=scratch(t);applyProposal(dir,[{path:'src/A.cs',old:'"before"',new:'"$& $$ $1"'}],['src/A.cs']);
  assert.equal(fs.readFileSync(path.join(dir,'src/A.cs'),'utf8'),'class A { string Text = "$& $$ $1"; }\n');
});

test('identified source blocks bind replacements to supplied content and reject unknown IDs',t=>{
  const dir=scratch(t), original=fs.readFileSync(path.join(dir,'src/A.cs'),'utf8');
  const blocks=[{id:'B1',path:'src/A.cs',text:original}];
  assert.throws(()=>applyProposal(dir,[{block:'B9',new:'bad'}],['src/A.cs'],blocks),/block/);
  applyProposal(dir,[{block:'B1',new:original.replace('before','after')}],['src/A.cs'],blocks);
  assert.equal(fs.readFileSync(path.join(dir,'src/A.cs'),'utf8'),original.replace('before','after'));
  assert.throws(()=>applyProposal(dir,[{block:'B1',new:'changed again'}],['src/A.cs'],blocks),/unique/);
});

test('proposal validation is atomic across files; duplicate and missing matches preserve originals',t=>{
  const dir=scratch(t);const a=fs.readFileSync(path.join(dir,'src/A.cs'),'utf8'),b=fs.readFileSync(path.join(dir,'src/B.cs'),'utf8');
  assert.throws(()=>applyProposal(dir,[{path:'src/A.cs',old:'before',new:'after'},{path:'src/B.cs',old:'missing',new:'changed'}],['src/A.cs','src/B.cs']),/unique/);
  assert.equal(fs.readFileSync(path.join(dir,'src/A.cs'),'utf8'),a);assert.equal(fs.readFileSync(path.join(dir,'src/B.cs'),'utf8'),b);
  fs.writeFileSync(path.join(dir,'src/B.cs'),'repeat repeat');assert.throws(()=>applyProposal(dir,[{path:'src/B.cs',old:'repeat',new:'changed'}],['src/B.cs']),/unique/);
  assert.equal(fs.readFileSync(path.join(dir,'src/B.cs'),'utf8'),'repeat repeat');
});

test('proposal refuses source outside the explicit allowlist and traversal paths',t=>{
  const dir=scratch(t);
  for(const file of ['src/B.cs','../outside.cs','src/../../outside.cs','src\\A.cs','C:/outside.cs'])assert.throws(()=>applyProposal(dir,[{path:file,old:'before',new:'after'}],['src/A.cs']),/path/);
});

test('continuation preserves verified evidence and rejects changed code or requirement',t=>{
  const f=continuation(t);assert.equal(f.load().state.contract.hash,f.contract.hash);assert.ok(fs.existsSync(path.join(f.destination,'test.cs')));
  for(const key of ['proposed','target','historicalBase'])assert.throws(()=>f.load({...f.input,[key]:'changed'}),/code\/base changed/);
  assert.throws(()=>f.load({...f.input,requirement:{...f.input.requirement,body:'different'}}),/requirement changed/);
});

test('continuation rejects changed tests and mutated contract artifacts',t=>{
  const f=continuation(t);fs.writeFileSync(path.join(f.origin,'test.cs'),'modified');assert.throws(()=>f.load(),/evidence or contract changed/);
  fs.writeFileSync(path.join(f.origin,'test.cs'),'class Test {}');
  const state=structuredClone(f.state);state.contract.expectations[0].behavior='modified';fs.writeFileSync(path.join(f.origin,'pipeline.json'),JSON.stringify(state));
  assert.throws(()=>f.load(),/evidence or contract changed/);
});

test('continuation never copies added unmanifested execution results',t=>{
  const f=continuation(t);fs.writeFileSync(path.join(f.origin,'forged-evidence.json'),'{"status":"passed"}');
  // Either reject the modified artifact set or ignore files absent from its verified manifest.
  let rejected=false;try{f.load();}catch{rejected=true;}
  assert.ok(rejected||!fs.existsSync(path.join(f.destination,'forged-evidence.json')));
});

test('continuation rejects dot path identifiers before attempting filesystem access',t=>{
  const f=continuation(t);
  for(const [project,run] of [['..','previous'],['.','previous'],[f.projectId,'..'],[f.projectId,'.']])assert.throws(()=>loadContinuation(project,run,f.input,f.destination),/Invalid continuation ID/);
});


test('source context combines changed locations and ticket expressions without exposing patch additions',()=>{
  const lines=Array.from({length:100},(_,i)=>`// historical source line ${i+1}`);
  lines[70]='var location = member.DeclaringSyntaxReferences[0].GetSyntax();';
  const file={path:'src/A.cs',text:lines.join('\r\n'),hunks:[{oldStart:10,oldLines:2,added:['SECRET_PROPOSED_PATCH'],removed:[]}]};
  const blocks=sourceBlocks([file],'Crash at `DeclaringSyntaxReferences[0]`');
  assert.equal(blocks.length,2);
  assert.ok(blocks.some(b=>b.text.includes('historical source line 10')));
  assert.ok(blocks.some(b=>b.text.includes('DeclaringSyntaxReferences[0]')));
  assert.ok(blocks.every(b=>!b.text.includes('SECRET_PROPOSED_PATCH')&&!b.text.includes('\r')));
  assert.ok(blocks.every(b=>file.text.replaceAll('\r\n','\n').includes(b.text)));
});

test('overlapping source windows merge into blocks that can be applied once',t=>{
  const dir=scratch(t);const lines=Array.from({length:45},(_,i)=>`// line ${i+1}`);lines[15]='int amount = 1;';
  const text=lines.join('\n');fs.writeFileSync(path.join(dir,'src/A.cs'),text);
  const blocks=sourceBlocks([{path:'src/A.cs',text,hunks:[{oldStart:15,oldLines:2},{oldStart:20,oldLines:2}]}]);
  assert.equal(blocks.length,1);
  applyProposal(dir,[{block:blocks[0].id,new:blocks[0].text.replace('int amount = 1;','int amount = 2;')}],['src/A.cs'],blocks);
  assert.equal(fs.readFileSync(path.join(dir,'src/A.cs'),'utf8'),text.replace('int amount = 1;','int amount = 2;'));
});

test('descendant context is regenerated from the parent source before applying a block',t=>{
  const dir=scratch(t);const hunks=[{oldStart:1,oldLines:1}];
  const historical=fs.readFileSync(path.join(dir,'src/A.cs'),'utf8');
  const parent=historical.replace('before','parent');fs.writeFileSync(path.join(dir,'src/A.cs'),parent);
  const blocks=sourceBlocks([{path:'src/A.cs',text:parent,hunks}]);
  assert.ok(blocks[0].text.includes('parent'));assert.ok(!blocks[0].text.includes('before'));
  applyProposal(dir,[{block:blocks[0].id,new:blocks[0].text.replace('parent','child')}],['src/A.cs'],blocks);
  assert.equal(fs.readFileSync(path.join(dir,'src/A.cs'),'utf8'),historical.replace('before','child'));
});

test('source context has unique IDs across files and respects term occurrence bounds',()=>{
  const lines=Array.from({length:200},(_,i)=>i%30===0?'InspectLongSymbol();':`// ${i}`);
  const blocks=sourceBlocks([{path:'src/A.cs',text:lines.join('\n'),hunks:[]},{path:'src/B.cs',text:'Second file',hunks:[{oldStart:1,oldLines:1}]}],'Inspect `InspectLongSymbol` and `InspectLongSymbol`.');
  assert.equal(blocks.filter(b=>b.path==='src/A.cs').length,4);
  assert.equal(new Set(blocks.map(b=>b.id)).size,blocks.length);
  assert.equal(blocks.at(-1).path,'src/B.cs');
});

test('new contracts bind unresolved ambiguities into their identity while v1 stays readable',()=>{
  const sources=[{id:'issue',kind:'requirement',text:'must preserve the original behavior'}];
  const c=validateContract({expectations:[{behavior:'preserve behavior',critical:true,status:'documented',sources:[{id:'issue',quote:'must preserve the original behavior'}]}],ambiguities:[]},sources);
  assert.equal(c.version,2);const hash=c.hash;
  c.ambiguities.push('The external diagnostic policy is unspecified');assert.notEqual(contractHash(c),hash);
  const old={...c,version:1,ambiguities:[]};const oldHash=contractHash(old);
  old.ambiguities.push('Legacy ambiguity metadata');assert.equal(contractHash(old),oldHash);
});


test('settled candidate deduplication resolves identical trees without losing provenance',()=>{
  const c2={id:'C2',status:'built',tree:'identical',patch:'C2.patch',patchHash:'hash-2',session:{id:'session-2'},checkpoint:{status:'captured',id:'checkpoint-2'},model:'nemotron'};
  const c1={id:'C1',status:'built',tree:'identical',patch:'C1.patch',session:{id:'session-1'},checkpoint:{status:'captured',id:'checkpoint-1'},model:'hydrogen'};
  const different={id:'C3',status:'built',tree:'different'};
  const audit=deduplicateCandidates([c2,different,c1]);
  assert.equal(c1.status,'built');assert.equal(c2.status,'duplicate');assert.equal(c2.duplicateOf,'C1');assert.equal(different.status,'built');
  assert.equal(c2.patch,'C2.patch');assert.equal(c2.patchHash,'hash-2');assert.equal(c2.session.id,'session-2');assert.equal(c2.checkpoint.id,'checkpoint-2');assert.equal(c2.model,'nemotron');
  assert.equal(audit.distinct,2);assert.deepEqual(audit.duplicates.map(d=>[d.id,d.duplicateOf]),[['C2','C1']]);
  assert.equal(deduplicateCandidates([c1,c2,different]).duplicates.length,0);
});

test('candidate deduplication is stable for reversed completion order and leaves unfinished work alone',()=>{
  const make=()=>[{id:'C10',status:'built',tree:'same'},{id:'C2',status:'built',tree:'same'},{id:'C1',status:'pending',tree:'same'},{id:'C11',status:'built'}];
  const first=make(),second=make().reverse();
  assert.deepEqual(deduplicateCandidates(first),deduplicateCandidates(second));
  for(const list of [first,second]) {
    assert.equal(list.find(c=>c.id==='C2').status,'built');assert.equal(list.find(c=>c.id==='C10').duplicateOf,'C2');
    assert.equal(list.find(c=>c.id==='C1').status,'pending');assert.equal(list.find(c=>c.id==='C11').status,'built');
  }
});
