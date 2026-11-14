import '../server/util.js';
import {PrivacyGateway} from '../server/privacy.js';
const gate=new PrivacyGateway({mode:'strict',terms:['KatseFixtureInternal']});
try {
  // VioletCedarBilling is deliberately absent from the rule-based term list:
  // this checks that Gemma detects something, not just that the endpoint responds.
  const source='class KatseFixtureInternal {} // confidential internal project codename: VioletCedarBilling; contact: fixture@example.com; password="synthetic-credential-only"';
  const safe=await gate.prepare(source);
  if(['KatseFixtureInternal','VioletCedarBilling','fixture@example.com','synthetic-credential-only'].some(s=>safe.text.includes(s)) || safe.restore(safe.text)!==source) throw new Error('Masking/restore smoke test failed');
  console.log(JSON.stringify({status:'passed',...gate.snapshot(),note:'Synthetic smoke test, not a general privacy guarantee; no cloud request made'},null,2));
} catch(e) {console.error(JSON.stringify({status:'blocked',reason:e.message,...gate.snapshot()}));process.exitCode=1;}
