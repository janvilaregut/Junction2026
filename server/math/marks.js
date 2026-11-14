// What happened to a node after the mathematics: an agent review reproduced it, found it different, or a
// person read it. Kept per head commit, so a new push starts clean: a mark is about that exact code.
import path from 'node:path';
import { DATA, readJSON, writeJSON } from '../util.js';

const STATES = new Set(['reproduced', 'differs', 'unclear', 'read', 'none']);
const file = (projectId, head) => path.join(DATA, 'math', projectId, `marks-${String(head).slice(0, 20)}.json`);

export const marksOf = (projectId, head) => readJSON(file(projectId, head), {}) || {};

/** Set (or clear, with 'none') the state of one node. Returns every mark of that commit. */
export function setMark(projectId, head, node, state, by = '', extra = {}) {
  if (!node || !STATES.has(state)) throw new Error('Invalid mark');
  const marks = marksOf(projectId, head);
  if (state === 'none') delete marks[node]; else marks[node] = { state, by, ...extra };
  writeJSON(file(projectId, head), marks);
  return marks;
}
