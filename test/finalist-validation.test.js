import {test} from 'node:test';
import assert from 'node:assert/strict';
import {finalValidationCandidates} from '../server/planner.js';

test('a later winning descendant is validated before the second scoped comparison',()=>{
  const candidates=[{id:'C1',status:'built'},{id:'C2',status:'failed'},{id:'C3',status:'built'},{id:'C6',status:'built',generation:2}];
  assert.deepEqual(finalValidationCandidates(candidates,'C6',{profile:'deep',scoped:true}).map(c=>c.id),['C6','C1']);
  assert.deepEqual(finalValidationCandidates(candidates,'C6',{profile:'deep',scoped:false}).map(c=>c.id),['C6']);
  assert.equal(candidates[0].id,'C1');
});
