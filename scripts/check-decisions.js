import '../server/util.js';
import {decisionMissions} from '../server/decisions.js';
const r=await decisionMissions([{id:'G1',symbol:'PublicExample',risk:3,expectations:['E1']}],{expectations:[{id:'E1',behavior:'Preserve existing public diagnostics while fixing a metadata crash'}]});
console.log(JSON.stringify(r,null,2));if(r.status!=='used')process.exitCode=1;
