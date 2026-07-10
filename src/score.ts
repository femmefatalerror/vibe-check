import type { CategoryResult, Finding } from './types';

const DEDUCTIONS: Record<Finding['severity'], number> = {
  error: 3,
  warn: 1.5,
  info: 0.5,
};

// 0-10 per category: start at 10, deduct per finding by severity
export function scoreCategory(findings: Finding[]): number {
  // `?? 3` guards against an invalid severity smuggled in via a programmatic
  // Config — an unknown severity must not NaN the score, so treat it as error
  const total = findings.reduce((sum, f) => sum + (DEDUCTIONS[f.severity] ?? 3), 0);
  return Math.max(0, 10 - total);
}

// 0-100 weighted aggregate across categories
export function computeWeightedScore(categories: CategoryResult[]): number {
  const totalWeight = categories.reduce((s, c) => s + c.weight, 0);
  if (totalWeight === 0) return 0;
  return (categories.reduce((s, c) => s + c.score * c.weight, 0) / totalWeight) * 10;
}
