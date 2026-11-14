import fs from 'node:fs';
import path from 'node:path';
import {run, ROOT, sha256, writeJSON} from '../util.js';
import {out, git} from '../git.js';
import {attackOutcome, evaluate} from './evidence.js';
// This perturbation establishes that an admitted assertion notices a failure in the selected method.
// It does not prove full line/branch coverage or all possible inputs.
export function probeOutcome(marker, attack, original, probe) {
  if (attackOutcome(attack,original)!=='passed' || attackOutcome(attack,probe)!=='failed') return false;
  return probe.tests.some(t=>attack.names.some(n=>t.name.includes(n)) && t.outcome==='Failed' && t.error?.includes(marker));
}
export async function probeNode({node,original,originalResult,state,tc,artifacts,emit,suiteOverlay}) {
  const marker='KATSE_PROBE_'+sha256(node.id+original.tree+Date.now()).slice(0,24);
  const record={node:node.id,status:'pending',marker,originalTree:original.tree,attacks:[],evidence:[]};
  const file=path.resolve(original.dir,node.file), root=path.resolve(original.dir)+path.sep;
  if(!file.startsWith(root)) throw new Error('Probe outside runner');
  const before=fs.readFileSync(file);
  const attacks=state.attacks.filter(a=>a.status==='admitted' && a.nodeIds?.includes(node.id));
  if(!attacks.length) return {...record,reason:'No admitted scenario targets this node'};
  const manifest=path.join(artifacts,'probe-input-'+marker+'.json');
  try {
    writeJSON(manifest,{root:original.dir,probe:{file:node.file,start:node.start,marker}});
    const result=await run('dotnet',[path.join(ROOT,'tools/Katse.Analyze/bin/Release/net8.0/Katse.Analyze.dll'),manifest],{timeout:15000});
    if(result.code) throw new Error('Node instrumentation unsupported: '+result.stderr.slice(-500));
    await git(original.dir,['add','--',node.file]);
    const tree=await out(original.dir,['write-tree']);
    const evidence=await evaluate({version:{...original,id:'probe-'+marker,tree},attacks,contract:state.contract,tc,environment:state.environment,artifacts,emit,suiteOverlay});
    record.attacks=attacks.filter(a=>probeOutcome(marker,a,originalResult,evidence)).map(a=>a.id);
    record.evidence=[evidence.id];record.status=record.attacks.length?'detected':'pending';
    record.reason=record.attacks.length?'Original scenario passes; the same assertion detects a unique exception injected into this method':'No passing original scenario detected the injected method failure';
    record.executionStatus=evidence.status;
  } catch(e) {record.reason=e.message;}
  finally {
    fs.writeFileSync(file,before); await git(original.dir,['add','--',node.file]);
    if(await out(original.dir,['write-tree'])!==original.tree) throw new Error('Node probe restoration failed');
    writeJSON(path.join(artifacts,'node-probe-'+marker+'.json'),record);
  }
  return record;
}
