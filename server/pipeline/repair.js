import fs from 'node:fs';
import path from 'node:path';
import {blindCopy} from './sandbox.js';
import {out,git} from '../git.js';
import {applyProposal} from './proposals.js';
import {sourceBlocks} from './source-context.js';
import {evaluate} from './evidence.js';
import {session,models,setupCapture,attachSession,checkpoint} from '../agents.js';
import {sha256,writeJSON} from '../util.js';
export const repairAccepted = e => e?.status==='passed' && e.executionComplete===true && e.ran>0 && e.failed===0;
// Proposes and validates ONE repair on a copy of the ORIGINAL, never a candidate or source checkout.
export async function repairOriginal({it,original,state,artifacts,tempRoot,emit,timeout=60000}) {
  const rec={status:'pending',base:it.headSha,appliedToOriginal:false};
  const dir=path.join(tempRoot,'proposed-repair');
  try {
    await blindCopy(it.repo,dir,it.headSha);
    const files=state.sourceChanges.map(f=>({...f,text:fs.readFileSync(path.join(dir,f.path),'utf8'),hunks:f.hunks.map(h=>({...h,oldStart:h.newStart,oldLines:h.newLines}))}));
    const blocks=sourceBlocks(files,state.requirementContext);
    const result=await session({dir,artifacts,role:'repair-original',model:models().fast,noTools:true,timeout,maxOutputTokens:4000,
      prompt:`Repair ONLY the reproduced original failure. Return JSON {"summary":"reason","edits":[{"block":"B1","new":"complete replacement block"}]}. No tools. Preserve unrelated behavior. Contract:${JSON.stringify(state.contract.expectations)} Failed tests:${JSON.stringify(state.evidence.filter(e=>e.version==='original').flatMap(e=>e.tests.filter(t=>t.outcome==='Failed'))).slice(0,6000)} Original source:${JSON.stringify(blocks)}`,validate:x=>typeof x.summary==='string' && Array.isArray(x.edits) && x.edits.length>0});
    applyProposal(dir,result.result.edits,files.map(f=>f.path),blocks);
    await git(dir,['add','-A']);
    const patch=await out(dir,['diff','--cached','--binary','HEAD']);
    if(!patch.trim()) throw new Error('Empty repair');
    rec.patch='proposed-repair.patch';fs.writeFileSync(path.join(artifacts,rec.patch),patch);
    rec.patchHash=sha256(patch);rec.session=result.artifact;rec.summary=result.result.summary;rec.model=result.model;
    try {if(result.sessionId){await setupCapture(dir,{manual:true});await git(dir,['-c','user.name=Katse','-c','user.email=katse@localhost','-c','commit.gpgsign=false','commit','-qm','Katse proposed original repair']);rec.capture=await attachSession(dir,result.sessionId);rec.checkpoint=await checkpoint(dir,await out(dir,['rev-parse','HEAD']),artifacts,'repair');}} catch(e){rec.capture={status:'unavailable',reason:e.message};}
    const evidence=await evaluate({version:{id:'proposed-repair',dir,tree:await out(dir,['write-tree'])},attacks:state.attacks,contract:state.contract,tc:it.toolchain,environment:state.environment,artifacts,emit,full:true,suiteOverlay:[...state.harness,...state.suiteOverlay]});
    rec.status=repairAccepted(evidence)?'validated-proposal':'rejected';rec.evidence=evidence.id;rec.tests={ran:evidence.ran,passed:evidence.passed,failed:evidence.failed};
  } catch(e) {rec.reason=e.message;}
  writeJSON(path.join(artifacts,'repair.json'),rec);emit({type:'repair',...rec});return rec;
}
