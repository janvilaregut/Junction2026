import { AsyncLocalStorage } from 'node:async_hooks';

export const execution = new AsyncLocalStorage();

export class DeadlineError extends Error {
  constructor(message = 'Presupuesto de ejecución agotado') { super(message); this.name = 'DeadlineError'; }
}

export class Queue {
  constructor(limit) { this.limit = limit; this.active = 0; this.waiting = []; }
  async use(fn) {
    if (this.active >= this.limit) await new Promise(resolve => this.waiting.push(resolve));
    else this.active++;
    try {
      const context = execution.getStore();
      if (context && Date.now() >= context.deadline) throw new DeadlineError();
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next(); else this.active--;
    }
  }
}

export function remaining(maximum = Infinity) {
  const context = execution.getStore();
  const ms = Math.floor(Math.min(maximum, Number.isFinite(context?.deadline) ? context.deadline - Date.now() : Infinity));
  if (ms <= 0) throw new DeadlineError();
  return ms;
}

export function within(deadline, fn) {
  return execution.run({ ...execution.getStore(), deadline }, fn);
}

export function initialPopulation(groups) {
  if (!groups.length) return 0;
  return Math.min(4, 2 + Math.ceil(Math.log2(groups.length)) + groups.filter(g => g.risk === 3).length);
}

export function priority(group) {
  return group.risk * (1 + group.unverified + (group.disagreement ?? 0)) /
    (Math.max(1, group.estimatedMs) * (1 + group.explored));
}
