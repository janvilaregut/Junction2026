// Agent sessions behind commits, read from Entire checkpoints in git (server/sessions.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiOfMany, aiOfRange, sessionOf } from '../server/sessions.js';
import { fixture } from './entire-fixture.js';

test('commits made in an agent session are found, with the prompt that led to each', async () => {
  const { dir, a, b, c } = fixture();
  const ai = await aiOfMany(dir, [a, b, c]);
  assert.equal(ai[c], undefined, 'a hand-made commit has no session');
  assert.equal(ai[a][0].agent, 'Claude Code');
  assert.equal(ai[a][0].prompt, 'Make file a');
  assert.equal(ai[b][0].prompt, 'Now file b please', 'injected system text is skipped');
  assert.deepEqual(await aiOfRange(dir, 'main..feature'), { commits: 2, of: 3, agents: ['Claude Code'] });
});

test('the session view folds what came before and after the commit', async () => {
  const { dir, b } = fixture();
  const s = await sessionOf(dir, b);
  assert.equal(s.located, true);
  const zones = (z) => s.messages.filter((m) => m.zone === z).map((m) => m.role);
  assert.deepEqual(zones('before'), ['user', 'tools']);
  assert.deepEqual(zones('this'), ['user', 'ai', 'tools']);
  assert.deepEqual(zones('after'), ['user']);
  assert.equal(s.commit.subject, 'Add b');
  assert.match(s.resume.cmd, /claude --resume abc12345-0000$/);
});
