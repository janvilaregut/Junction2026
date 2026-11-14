import { AsyncLocalStorage } from 'node:async_hooks';

export const execution = new AsyncLocalStorage();

export class DeadlineError extends Error {
  constructor(message = 'Presupuesto de ejecución agotado') { super(message); this.name = 'DeadlineError'; }
}

export class TokenBudgetError extends Error {
  constructor(message = 'Presupuesto de tokens agotado') { super(message); this.name = 'TokenBudgetError'; }
}

// Reservations protect concurrent calls and leave capacity for the final report.
// Prompt tokenization and OpenCode's hidden context are estimated. Provider usage
// is authoritative after each attempt; unknown/aborted usage retains its reserve.
export class TokenBudget {
  constructor(limit, { reportReserve = Math.min(12000, Math.floor(limit / 5)) } = {}) {
    if (!Number.isFinite(limit) || limit <= 0) throw new TokenBudgetError('Invalid token budget');
    if (!Number.isFinite(reportReserve) || reportReserve < 0) throw new TokenBudgetError('Invalid report reservation');
    this.limit = Math.floor(limit); this.reportReserve = Math.max(0, Math.min(this.limit, Math.floor(reportReserve)));
    this.observed = 0; this.unknownReserved = 0; this.active = new Map(); this.attempts = []; this.nextId = 0;
  }
  reserve(amount, { role = '', report = role === 'semantic-judge' } = {}) {
    if (!Number.isFinite(amount) || amount <= 0) throw new TokenBudgetError('Invalid token reservation');
    const tokens = Math.ceil(amount), available = this.limit - this.observed - this.unknownReserved - this.reserved - (report ? 0 : this.reportReserve);
    if (tokens > available) throw new TokenBudgetError(`${role}: needs ${tokens} estimated tokens; ${Math.max(0, available)} available`);
    const id = ++this.nextId; this.active.set(id, { id, role, tokens }); return id;
  }
  settle(id, actual = null, { incomplete = false } = {}) {
    const reservation = this.active.get(id); if (!reservation) throw new Error('Unknown token reservation');
    this.active.delete(id);
    const known = Number.isFinite(actual) && actual >= 0;
    if (known) this.observed += Math.ceil(actual);
    if (!known || incomplete) this.unknownReserved += known ? Math.max(0, reservation.tokens - Math.ceil(actual)) : reservation.tokens;
    this.attempts.push({ ...reservation, actual: known ? Math.ceil(actual) : null, incomplete: !known || incomplete });
  }
  get reserved() { return [...this.active.values()].reduce((n, r) => n + r.tokens, 0); }
  snapshot() {
    return { limit: this.limit, observed: this.observed, reserved: this.reserved, unknownReserved: this.unknownReserved,
      remaining: Math.max(0, this.limit - this.observed - this.unknownReserved - this.reserved),
      reportReserve: this.reportReserve, attempts: this.attempts.length, usageIncomplete: this.attempts.some(a => a.incomplete),
      exceeded: this.observed + this.unknownReserved > this.limit,
      enforcement: 'estimated admission reservations; per-request output cap; observed provider usage reconciled after every attempt' };
  }
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
