import type { SLARequirement, SLAMetric } from '@ophirai/protocol';
import { OphirError, OphirErrorCode } from '@ophirai/protocol';

/** Pre-built SLA templates for common AI service categories. */
export const SLA_TEMPLATES = {
  inference_realtime: (): SLARequirement => ({
    metrics: [
      { name: 'p99_latency_ms', target: 500, comparison: 'lte' },
      { name: 'uptime_pct', target: 99.9, comparison: 'gte' },
      { name: 'accuracy_pct', target: 95, comparison: 'gte' },
    ],
    dispute_resolution: { method: 'lockstep_verification', timeout_hours: 24 },
  }),

  inference_batch: (): SLARequirement => ({
    metrics: [
      { name: 'throughput_rpm', target: 1000, comparison: 'gte' },
      { name: 'accuracy_pct', target: 97, comparison: 'gte' },
      { name: 'error_rate_pct', target: 1, comparison: 'lte' },
    ],
    dispute_resolution: { method: 'lockstep_verification', timeout_hours: 48 },
  }),

  data_processing: (): SLARequirement => ({
    metrics: [
      { name: 'throughput_rpm', target: 500, comparison: 'gte' },
      { name: 'uptime_pct', target: 99.5, comparison: 'gte' },
      { name: 'error_rate_pct', target: 2, comparison: 'lte' },
    ],
    dispute_resolution: { method: 'automatic_escrow', timeout_hours: 24 },
  }),

  code_generation: (): SLARequirement => ({
    metrics: [
      { name: 'p99_latency_ms', target: 5000, comparison: 'lte' },
      { name: 'accuracy_pct', target: 90, comparison: 'gte' },
      { name: 'uptime_pct', target: 99, comparison: 'gte' },
    ],
    dispute_resolution: { method: 'lockstep_verification', timeout_hours: 24 },
  }),

  translation: (): SLARequirement => ({
    metrics: [
      { name: 'accuracy_pct', target: 95, comparison: 'gte' },
      { name: 'p99_latency_ms', target: 3000, comparison: 'lte' },
      { name: 'uptime_pct', target: 99, comparison: 'gte' },
    ],
    dispute_resolution: { method: 'lockstep_verification', timeout_hours: 24 },
  }),
} as const;

/** Per-metric comparison detail between two SLA offers. */
export interface SLAComparisonDetail {
  metric: string;
  a_value: number;
  b_value: number;
  better: 'a' | 'b' | 'tie';
}

/** Overall result of comparing two SLA requirements. */
export interface SLAComparisonResult {
  winner: 'a' | 'b' | 'tie';
  details: SLAComparisonDetail[];
}

function metricKey(m: SLAMetric): string {
  return m.name === 'custom' && m.custom_name ? m.custom_name : m.name;
}

/** Compare two SLA requirements metric-by-metric and determine which is better overall.
 * @param a - First SLA requirement to compare
 * @param b - Second SLA requirement to compare
 * @returns Comparison result with per-metric details and an overall winner
 * @throws {OphirError} When either SLA requirement is missing a metrics array
 * @example
 * ```typescript
 * const result = compareSLAs(sellerSLA, buyerSLA);
 * if (result.winner === 'a') console.log('Seller offers better terms');
 * ```
 */
export function compareSLAs(a: SLARequirement, b: SLARequirement): SLAComparisonResult {
  if (!a?.metrics || !b?.metrics) {
    throw new OphirError(
      OphirErrorCode.INVALID_MESSAGE,
      'Both SLA requirements must have a metrics array',
    );
  }
  const aMap = new Map(a.metrics.map((m) => [metricKey(m), m]));
  const bMap = new Map(b.metrics.map((m) => [metricKey(m), m]));
  const allKeys = new Set([...aMap.keys(), ...bMap.keys()]);

  const details: SLAComparisonDetail[] = [];
  let aWins = 0;
  let bWins = 0;

  for (const key of allKeys) {
    const am = aMap.get(key);
    const bm = bMap.get(key);
    if (!am || !bm) continue;

    const aVal = am.target;
    const bVal = bm.target;
    let better: 'a' | 'b' | 'tie';

    if (aVal === bVal) {
      better = 'tie';
    } else if (am.comparison === 'lte') {
      // Lower is better for lte metrics
      better = aVal < bVal ? 'a' : 'b';
    } else {
      // Higher is better for gte/eq metrics
      better = aVal > bVal ? 'a' : 'b';
    }

    if (better === 'a') aWins++;
    if (better === 'b') bWins++;

    details.push({ metric: key, a_value: aVal, b_value: bVal, better });
  }

  const winner = aWins > bWins ? 'a' : bWins > aWins ? 'b' : 'tie';
  return { winner, details };
}

/** An unmet SLA metric requirement with the gap between offered and required values. */
export interface SLAGap {
  metric: string;
  required: number;
  offered: number;
  gap: number;
}

/** Result of checking whether an offered SLA meets required thresholds. */
export interface SLAMeetsResult {
  meets: boolean;
  gaps: SLAGap[];
}

/** Check if an offered SLA meets all required metric thresholds.
 * @param offered - The SLA being offered by the seller
 * @param required - The SLA requirements demanded by the buyer
 * @returns Whether all requirements are met, with detailed gaps for any unmet metrics
 * @throws {OphirError} When either SLA requirement is missing a metrics array
 * @example
 * ```typescript
 * const { meets, gaps } = meetsSLARequirements(sellerSLA, buyerSLA);
 * if (!meets) gaps.forEach(g => console.log(`${g.metric} off by ${g.gap}`));
 * ```
 */
export function meetsSLARequirements(
  offered: SLARequirement,
  required: SLARequirement,
): SLAMeetsResult {
  if (!offered?.metrics || !required?.metrics) {
    throw new OphirError(
      OphirErrorCode.INVALID_MESSAGE,
      'Both SLA requirements must have a metrics array',
    );
  }
  const offeredMap = new Map(offered.metrics.map((m) => [metricKey(m), m]));
  const gaps: SLAGap[] = [];

  for (const req of required.metrics) {
    const key = metricKey(req);
    const off = offeredMap.get(key);

    if (!off) {
      gaps.push({ metric: key, required: req.target, offered: 0, gap: req.target });
      continue;
    }

    if (req.comparison === 'lte') {
      // Offered must be <= required target
      if (off.target > req.target) {
        gaps.push({
          metric: key,
          required: req.target,
          offered: off.target,
          gap: off.target - req.target,
        });
      }
    } else if (req.comparison === 'gte') {
      // Offered must be >= required target
      if (off.target < req.target) {
        gaps.push({
          metric: key,
          required: req.target,
          offered: off.target,
          gap: req.target - off.target,
        });
      }
    } else if (req.comparison === 'eq') {
      if (off.target !== req.target) {
        gaps.push({
          metric: key,
          required: req.target,
          offered: off.target,
          gap: Math.abs(req.target - off.target),
        });
      }
    }
  }

  return { meets: gaps.length === 0, gaps };
}

/** A Lockstep behavioral check derived from an SLA metric. */
export interface LockstepBehavioralCheck {
  metric: string;
  operator: string;
  threshold: number;
  measurement_method: string;
  measurement_window: string;
}

/** Lockstep verification spec derived from SLA terms. */
export interface LockstepVerificationSpec {
  version: string;
  agreement_id: string;
  agreement_hash: string;
  behavioral_checks: LockstepBehavioralCheck[];
  dispute_resolution: {
    method: string;
    timeout_hours?: number;
    arbitrator?: string;
  };
}

/** Convert an SLA requirement into a Lockstep behavioral verification spec.
 * @param sla - The SLA requirement containing metrics and dispute resolution terms
 * @param agreement - The agreement identifiers to bind the spec to
 * @param agreement.agreement_id - Unique identifier for the agreement
 * @param agreement.agreement_hash - Content hash of the agreement for integrity verification
 * @returns A Lockstep verification spec with behavioral checks derived from each SLA metric
 * @example
 * ```typescript
 * const spec = slaToLockstepSpec(sla, {
 *   agreement_id: 'agr_123',
 *   agreement_hash: '0xabc...',
 * });
 * ```
 */
export function slaToLockstepSpec(
  sla: SLARequirement,
  agreement: { agreement_id: string; agreement_hash: string },
): LockstepVerificationSpec {
  return {
    version: '1.0',
    agreement_id: agreement.agreement_id,
    agreement_hash: agreement.agreement_hash,
    behavioral_checks: sla.metrics.map((m) => ({
      metric: metricKey(m),
      operator: m.comparison,
      threshold: m.target,
      measurement_method: m.measurement_method ?? 'rolling_average',
      measurement_window: m.measurement_window ?? '1h',
    })),
    dispute_resolution: sla.dispute_resolution ?? {
      method: 'automatic_escrow',
      timeout_hours: 24,
    },
  };
}
