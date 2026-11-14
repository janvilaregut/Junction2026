// Product review budgets, independent of provider-specific thinking settings.
export const reviewProfiles = Object.freeze({
  quick: Object.freeze({ id: 'quick', budgetMs: 90000, tokenBudget: 25000, initialCandidates: 0, maxDescendants: 0, finalMissions: 0 }),
  standard: Object.freeze({ id: 'standard', budgetMs: 300000, tokenBudget: 100000, initialCandidates: 2, maxDescendants: 0, finalMissions: 1 }),
  deep: Object.freeze({ id: 'deep', budgetMs: 900000, tokenBudget: 250000, initialCandidates: 2, maxDescendants: 2, finalMissions: 3 }),
});

const bounded = (value, fallback, max, name) => {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${name}: expected a positive number`);
  return Math.min(max, Math.max(1, Math.floor(value)));
};

export function resolveProfile(options = {}) {
  const id = options.profile ?? 'standard';
  if (!Object.hasOwn(reviewProfiles, id)) throw new Error('Unknown review profile');
  const p = reviewProfiles[id];
  return { ...p,
    budgetMs: bounded(options.budgetMs, p.budgetMs, 900000, 'budgetMs'),
    tokenBudget: bounded(options.tokenBudget, p.tokenBudget, 250000, 'tokenBudget'),
  };
}
