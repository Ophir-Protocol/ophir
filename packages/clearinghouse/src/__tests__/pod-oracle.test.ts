import { describe, it, expect, beforeEach } from 'vitest';
import { PoDOracle } from '../pod-oracle.js';
import { OphirError, OphirErrorCode } from '@ophirai/protocol';
import type { CompletedAgreement, MeasuredMetric, PoDScore } from '../types.js';

function makeMetrics(overrides: Partial<Record<string, { target: number; observed: number }>> = {}): MeasuredMetric[] {
  const defaults: Record<string, { target: number; observed: number; comparison: 'gte' | 'lte' }> = {
    uptime_pct:             { target: 99.9, observed: 99.95, comparison: 'gte' },
    accuracy_pct:           { target: 95,   observed: 96,    comparison: 'gte' },
    p99_latency_ms:         { target: 200,  observed: 180,   comparison: 'lte' },
    p50_latency_ms:         { target: 50,   observed: 45,    comparison: 'lte' },
    error_rate_pct:         { target: 1,    observed: 0.5,   comparison: 'lte' },
    throughput_rpm:          { target: 1000, observed: 1100,  comparison: 'gte' },
    time_to_first_byte_ms:  { target: 100,  observed: 80,    comparison: 'lte' },
    custom:                 { target: 100,  observed: 100,   comparison: 'gte' },
  };

  for (const [name, vals] of Object.entries(overrides)) {
    if (vals) {
      defaults[name] = { ...defaults[name], ...vals };
    }
  }

  return Object.entries(defaults).map(([name, v]) => ({
    name,
    target: v.target,
    observed: v.observed,
    comparison: v.comparison ?? 'gte',
  }));
}

function makeAgreement(index: number, metrics: MeasuredMetric[]): CompletedAgreement {
  const date = new Date(2026, 0, 1 + index);
  return {
    agreement_id: `agreement-${index}`,
    buyer_id: 'did:key:buyer',
    seller_id: 'did:key:seller',
    metrics,
    completed_at: date.toISOString(),
    deposit_amount: 1000,
  };
}

describe('PoDOracle', () => {
  let oracle: PoDOracle;

  beforeEach(() => {
    oracle = new PoDOracle();
  });

  it('computes score for single agreement with all metrics', () => {
    const agreements = [makeAgreement(0, makeMetrics())];
    const result = oracle.computeScore('agent-1', agreements);

    expect(result.score).toBeGreaterThan(0.9);
    expect(result.score).toBeLessThanOrEqual(1.0);
    expect(result.agent_id).toBe('agent-1');
    expect(result.sample_size).toBe(1);
  });

  it('computes score for agent with poor performance', () => {
    const poorMetrics = makeMetrics({
      uptime_pct:            { target: 99.9, observed: 50 },
      accuracy_pct:          { target: 95,   observed: 40 },
      p99_latency_ms:        { target: 200,  observed: 2000 },
      p50_latency_ms:        { target: 50,   observed: 500 },
      error_rate_pct:        { target: 1,    observed: 20 },
      throughput_rpm:         { target: 1000, observed: 100 },
      time_to_first_byte_ms: { target: 100,  observed: 1500 },
      custom:                { target: 100,  observed: 10 },
    });
    const agreements = [makeAgreement(0, poorMetrics)];
    const result = oracle.computeScore('agent-poor', agreements);

    expect(result.score).toBeLessThan(0.5);
  });

  it('margin rate is 100% for new agent with no history', () => {
    const result = oracle.computeScore('new-agent', []);

    expect(result.margin_rate).toBe(1.0);
    expect(result.score).toBe(0);
    expect(result.confidence).toBe(0);
    expect(result.sample_size).toBe(0);
  });

  it('margin rate decreases with good track record', () => {
    const agreements = Array.from({ length: 55 }, (_, i) =>
      makeAgreement(i, makeMetrics()),
    );
    const result = oracle.computeScore('veteran-agent', agreements);

    expect(result.margin_rate).toBeLessThan(0.15);
    expect(result.margin_rate).toBeGreaterThanOrEqual(0.05);
    expect(result.confidence).toBe(1.0);
  });

  it('confidence scales with sample size', () => {
    const tenAgreements = Array.from({ length: 10 }, (_, i) =>
      makeAgreement(i, makeMetrics()),
    );
    const fiftyAgreements = Array.from({ length: 50 }, (_, i) =>
      makeAgreement(i, makeMetrics()),
    );

    const result10 = oracle.computeScore('agent-10', tenAgreements);
    const result50 = oracle.computeScore('agent-50', fiftyAgreements);

    expect(result10.confidence).toBeCloseTo(0.2, 1);
    expect(result50.confidence).toBe(1.0);
  });

  it('handles missing metrics gracefully', () => {
    const partialMetrics: MeasuredMetric[] = [
      { name: 'uptime_pct', target: 99.9, observed: 99.5, comparison: 'gte' },
      { name: 'accuracy_pct', target: 95, observed: 94, comparison: 'gte' },
    ];
    const agreements = [makeAgreement(0, partialMetrics)];
    const result = oracle.computeScore('agent-partial', agreements);

    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThanOrEqual(1.0);
    expect(Number.isFinite(result.margin_rate)).toBe(true);
  });

  it('EMA gives more weight to recent agreements', () => {
    const goodMetrics = makeMetrics();
    const mediumMetrics = makeMetrics({
      uptime_pct:    { target: 99.9, observed: 75 },
      accuracy_pct:  { target: 95,   observed: 60 },
      p99_latency_ms:{ target: 200,  observed: 400 },
      error_rate_pct:{ target: 1,    observed: 5 },
      throughput_rpm: { target: 1000, observed: 500 },
    });

    const agreements: CompletedAgreement[] = [];
    // First 40: excellent
    for (let i = 0; i < 40; i++) {
      agreements.push(makeAgreement(i, goodMetrics));
    }
    // Last 10: mediocre
    for (let i = 40; i < 50; i++) {
      agreements.push(makeAgreement(i, mediumMetrics));
    }

    const result = oracle.computeScore('agent-ema', agreements);

    // Score should be pulled toward recent poor performance
    expect(result.score).toBeGreaterThan(0.5);
    expect(result.score).toBeLessThan(1.0);

    // Compare against all-good to confirm recent decline has effect
    const allGood = Array.from({ length: 50 }, (_, i) =>
      makeAgreement(i, goodMetrics),
    );
    const resultGood = oracle.computeScore('agent-allgood', allGood);
    expect(result.score).toBeLessThan(resultGood.score);
  });

  it('getMarginRequirement uses worst of buyer/seller margin', () => {
    const buyerPod: PoDScore = {
      agent_id: 'buyer',
      score: 0.9,
      margin_rate: 0.1,
      confidence: 1.0,
      sample_size: 50,
      last_updated: new Date().toISOString(),
    };
    const sellerPod: PoDScore = {
      agent_id: 'seller',
      score: 0.7,
      margin_rate: 0.3,
      confidence: 1.0,
      sample_size: 50,
      last_updated: new Date().toISOString(),
    };

    const margin = oracle.getMarginRequirement(buyerPod, sellerPod, 10_000);

    expect(margin.combined_margin_rate).toBe(0.3);
    expect(margin.buyer_margin_rate).toBe(0.1);
    expect(margin.seller_margin_rate).toBe(0.3);
    expect(margin.required_deposit).toBe(3000);
    expect(margin.full_deposit).toBe(10_000);
    expect(margin.savings).toBe(7000);
  });

  it('assessRisk returns correct tier', () => {
    const cases: Array<{ score: number; expectedTier: string }> = [
      { score: 0.95, expectedTier: 'LOW' },
      { score: 0.75, expectedTier: 'MEDIUM' },
      { score: 0.5,  expectedTier: 'HIGH' },
      { score: 0.2,  expectedTier: 'CRITICAL' },
    ];

    for (const { score, expectedTier } of cases) {
      const agentId = `agent-risk-${score}`;
      (oracle as any)['scores'].set(agentId, {
        agent_id: agentId,
        score,
        margin_rate: 0.1,
        confidence: 1,
        sample_size: 50,
        last_updated: new Date().toISOString(),
      });

      const risk = oracle.assessRisk(agentId);
      expect(risk.risk_tier).toBe(expectedTier);
    }
  });

  it('minimum margin rate is 0.05', () => {
    const agreements = Array.from({ length: 100 }, (_, i) =>
      makeAgreement(i, makeMetrics()),
    );
    const result = oracle.computeScore('perfect-agent', agreements);

    expect(result.margin_rate).toBeGreaterThanOrEqual(0.05);
  });

  describe('input validation', () => {
    it('throws OphirError on empty agent ID', () => {
      try {
        oracle.computeScore('', []);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(OphirError);
        expect((e as OphirError).code).toBe(OphirErrorCode.POD_SCORE_INSUFFICIENT);
      }
    });

    it('throws OphirError on non-positive agreement amount in margin requirement', () => {
      const pod: PoDScore = {
        agent_id: 'a', score: 0.9, margin_rate: 0.1, confidence: 1, sample_size: 10,
        last_updated: new Date().toISOString(),
      };
      try {
        oracle.getMarginRequirement(pod, pod, 0);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(OphirError);
        expect((e as OphirError).code).toBe(OphirErrorCode.MARGIN_ASSESSMENT_FAILED);
      }

      try {
        oracle.getMarginRequirement(pod, pod, -100);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(OphirError);
        expect((e as OphirError).code).toBe(OphirErrorCode.MARGIN_ASSESSMENT_FAILED);
      }
    });

    it('throws OphirError on penalty factor outside [0, 1]', () => {
      oracle.computeScore('agent-p', [makeAgreement(0, makeMetrics())]);
      try {
        oracle.applyPenalty('agent-p', 1.5);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(OphirError);
        expect((e as OphirError).code).toBe(OphirErrorCode.POD_SCORE_INSUFFICIENT);
      }

      try {
        oracle.applyPenalty('agent-p', -0.1);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(OphirError);
        expect((e as OphirError).code).toBe(OphirErrorCode.POD_SCORE_INSUFFICIENT);
      }
    });
  });

  describe('comparison-driven normalization', () => {
    it('lte metric with observed > target scores below 1', () => {
      const lteMetrics: MeasuredMetric[] = [
        { name: 'p99_latency_ms', target: 200, observed: 400, comparison: 'lte' },
      ];
      const result = oracle.computeScore('lte-agent', [makeAgreement(0, lteMetrics)]);
      expect(result.score).toBeLessThan(1.0);
      expect(result.score).toBeCloseTo(0.5, 1);
    });

    it('gte metric with observed >= target scores 1.0', () => {
      const gteMetrics: MeasuredMetric[] = [
        { name: 'uptime_pct', target: 99.0, observed: 100.0, comparison: 'gte' },
      ];
      const result = oracle.computeScore('gte-agent', [makeAgreement(0, gteMetrics)]);
      expect(result.score).toBe(1.0);
    });

    it('lte metric with observed = 0 scores 1.0 (perfect)', () => {
      const lteMetrics: MeasuredMetric[] = [
        { name: 'error_rate_pct', target: 1, observed: 0, comparison: 'lte' },
      ];
      const result = oracle.computeScore('zero-error', [makeAgreement(0, lteMetrics)]);
      expect(result.score).toBe(1.0);
    });

    it('gte metric with target = 0 scores 0 (avoid division by zero)', () => {
      const gteMetrics: MeasuredMetric[] = [
        { name: 'custom', target: 0, observed: 100, comparison: 'gte' },
      ];
      const result = oracle.computeScore('zero-target', [makeAgreement(0, gteMetrics)]);
      expect(result.score).toBe(0);
    });
  });
});
