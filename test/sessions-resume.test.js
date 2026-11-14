// Reopening a session that is not on this computer: its log is restored from the checkpoint, without keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture } from './entire-fixture.js';

test('resume restores the session log from the checkpoint, masking any key Entire missed', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'katse-home-'));
  process.env.HOME = home; // sessions.js reads ~/.claude when it loads
  const { resumeSession } = await import('../server/sessions.js');
  const leaked = 'dc_' + 'a1b2'.repeat(20);
  const { dir, b } = fixture({ fullTranscript: JSON.stringify({ type: 'user', message: { content: `nvidia:${leaked}` } }) + '\n' });
  const r = await resumeSession(dir, b, 0, { open: false });
  const f = path.join(home, '.claude', 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'), 'abc12345-0000.jsonl');
  assert.equal(r.restored, true);
  assert.equal(r.opened, false);
  assert.match(r.cmd, /claude --resume abc12345-0000$/);
  const text = fs.readFileSync(f, 'utf8');
  assert.ok(!text.includes(leaked), 'the key is not written back');
  assert.match(text, /nvidia:REDACTED/);
});
