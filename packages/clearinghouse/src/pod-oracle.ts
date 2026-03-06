import { OphirError, OphirErrorCode } from '@ophirai/protocol';
import type {
  PoDScore,
  CompletedAgreement,
  MeasuredMetric,
  MarginRequirement,
  RiskAssessment,
} from './types.js';

const METRIC_WEIGHTS: Record<string, number> = {
  uptime_pct: 0.25,
  accuracy_pct: 0.20,
  p99_latency_ms: 0.15,
  error_rate_pct: 0.15,
  throughput_rpm: 0.10,
  p50_latency_ms: 0.05,
  time_to_first_byte_ms: 0.05,
  custom: 0.05,
};

const MIN_MARGIN = 0.05;
const EMA_DECAY = 0.95;
const CONFIDENCE_THRESHOLD = 50;

const RISK_TIERS = [
  { min: 0.9, tier: 'LOW' as const, max_exposure: 1_000_000 },
  { min: 0.7, tier: 'MEDIUM' as const, max_exposure: 500_000 },
  { min: 0.4, tier: 'HIGH' as const, max_exposure: 100_000 },
  { min: -Infinity, tier: 'CRITICAL' as const, max_exposure: 10_000 },
];

/**
 * Normalize a metric observation to a 0–1 score using the metric's `comparison`
 * field rather than hardcoded directionality assumptions. The `comparison` field
 * is the canonical indicator of whether higher or lower is better:
 * - `gte` / `eq`: observed should meet or exceed target (higher is better)
 * - `lte`: observed should stay at or below target (lower is better)
 * - `between`: treated as higher-is-better (target is the midpoint goal)
 */
function normalizeMetric(metric: MeasuredMetric): number {
  if (metric.comparison === 'lte') {
    // Lower is better: ratio of target / observed (clamped to [0, 1])
    if (metric.observed === 0) return 1;
    return Math.min(1, metric.target / metric.observed);
  }
  // gte, eq, between: higher is better
  if (metric.target === 0) return 0;
  return Math.min(1, metric.observed / metric.target);
}

function computeWeightedAverage(metrics: MeasuredMetric[]): number {
  let totalWeight = 0;
  let weightedSum = 0;

  for (const metric of metrics) {
    const weight = METRIC_WEIGHTS[metric.name] ?? METRIC_WEIGHTS['custom'];
    const normalized = normalizeMetric(metric);
    weightedSum += normalized * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return 0;
  return weightedSum / totalWeight;
}

export class PoDOracle {
  private scores = new Map<string, PoDScore>();

  computeScore(agentId: string, completedAgreements: CompletedAgreement[]): PoDScore {
    if (!agentId) {
      throw new OphirError(
        OphirErrorCode.POD_SCORE_INSUFFICIENT,
        'Agent ID is required for PoD score computation',
        { agentId },
      );
    }

    if (completedAgreements.length === 0) {
      const score: PoDScore = {
        agent_id: agentId,
        score: 0,
        margin_rate: 1.0,
        confidence: 0,
        sample_size: 0,
        last_updated: new Date().toISOString(),
      };
      this.scores.set(agentId, score);
      return score;
    }

    // Sort chronologically
    const sorted = [...completedAgreements].sort(
      (a, b) => new Date(a.completed_at).getTime() - new Date(b.completed_at).getTime(),
    );

    // EMA across agreements
    let emaScore = computeWeightedAverage(sorted[0].metrics);
    for (let i = 1; i < sorted.length; i++) {
      const current = computeWeightedAverage(sorted[i].metrics);
      emaScore = emaScore * EMA_DECAY + current * (1 - EMA_DECAY);
    }

    const confidence = Math.min(1.0, sorted.length / CONFIDENCE_THRESHOLD);
    const marginRate = Math.max(MIN_MARGIN, 1.0 - emaScore * confidence * 0.95);

    const podScore: PoDScore = {
      agent_id: agentId,
      score: emaScore,
      margin_rate: marginRate,
      confidence,
      sample_size: sorted.length,
      last_updated: new Date().toISOString(),
    };

    this.scores.set(agentId, podScore);
    return podScore;
  }

  getScore(agentId: string): PoDScore | undefined {
    return this.scores.get(agentId);
  }

  getMarginRequirement(
    buyerPod: PoDScore,
    sellerPod: PoDScore,
    agreementAmount: number,
  ): MarginRequirement {
    if (agreementAmount <= 0) {
      throw new OphirError(
        OphirErrorCode.MARGIN_ASSESSMENT_FAILED,
        `Agreement amount must be positive, got ${agreementAmount}`,
        { agreementAmount },
      );
    }

    const combinedMarginRate = Math.max(buyerPod.margin_rate, sellerPod.margin_rate);
    const requiredDeposit = agreementAmount * combinedMarginRate;
    const fullDeposit = agreementAmount;

    return {
      buyer_margin_rate: buyerPod.margin_rate,
      seller_margin_rate: sellerPod.margin_rate,
      combined_margin_rate: combinedMarginRate,
      required_deposit: requiredDeposit,
      full_deposit: fullDeposit,
      savings: fullDeposit - requiredDeposit,
    };
  }

  applyPenalty(agentId: string, factor: number): PoDScore | undefined {
    if (factor < 0 || factor > 1) {
      throw new OphirError(
        OphirErrorCode.POD_SCORE_INSUFFICIENT,
        `Penalty factor must be between 0 and 1, got ${factor}`,
        { agentId, factor },
      );
    }

    const pod = this.scores.get(agentId);
    if (!pod) return undefined;
    const penalized: PoDScore = {
      ...pod,
      score: pod.score * factor,
      margin_rate: Math.max(MIN_MARGIN, 1.0 - pod.score * factor * pod.confidence * 0.95),
      last_updated: new Date().toISOString(),
    };
    this.scores.set(agentId, penalized);
    return penalized;
  }

  assessRisk(agentId: string): RiskAssessment {
    const pod = this.scores.get(agentId);
    const score = pod?.score ?? 0;

    const { tier, max_exposure } = RISK_TIERS.find((t) => score >= t.min)!;

    return {
      agent_id: agentId,
      risk_tier: tier,
      max_exposure,
      current_exposure: 0,
      available_capacity: max_exposure,
    };
  }
}
