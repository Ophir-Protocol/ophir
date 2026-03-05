import type { ReputationRow } from './db.js';

/**
 * Compute a reputation score from 0-100.
 * Formula: base 50, +0.5 per completed, -2 per dispute lost,
 * +1 per dispute won, -0.1 per 100ms avg response time above 500ms.
 */
export function computeReputationScore(rep: ReputationRow): number {
  let score = 50;
  score += rep.completed_agreements * 0.5;
  score -= rep.disputes_lost * 2;
  score += rep.disputes_won * 1;

  if (rep.avg_response_time_ms > 500) {
    const excessMs = rep.avg_response_time_ms - 500;
    score -= (excessMs / 100) * 0.1;
  }

  return Math.max(0, Math.min(100, score));
}
