import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {run,ROOT} from '../server/util.js';
const dll=path.join(ROOT,'tools/Katse.Analyze/bin/Release/net8.0/Katse.Analyze.dll');
test('Roslyn instrumentation handles blocks and expressions and rejects malformed candidates',{skip:!fs.existsSync(dll)},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'katse-probe-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'X.cs'),manifest=path.join(dir,'request.json');
  for(const start of [2,3]) {
    fs.writeFileSync(file,'class X {\n int F()=>1;\n int G(){return 2;}\n}');
    fs.writeFileSync(manifest,JSON.stringify({root:dir,probe:{file:'X.cs',start,marker:'KATSE_PROBE_abcdef'}}));
    const r=await run('dotnet',[dll,manifest]);assert.equal(r.code,0,r.stderr);assert.match(fs.readFileSync(file,'utf8'),/throw new global::System.InvalidOperationException/);
  }
  fs.writeFileSync(file,'class X { int F(){ return 1;');fs.writeFileSync(manifest,JSON.stringify({root:dir,files:['X.cs'],syntaxOnly:true}));
  const r=await run('dotnet',[dll,manifest]);assert.equal(r.code,2);assert.ok(JSON.parse(r.stdout).errors.length);
});
