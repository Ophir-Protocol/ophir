import type { LockstepVerificationSpec } from './sla.js';

/** A single metric observation recorded by the buyer. */
export interface MetricSample {
  metric: string;
  value: number;
  timestamp: string;
  agreement_id: string;
  measurement_window: string;
  sample_count: number;
}

/** A detected SLA violation with evidence. */
export interface Violation {
  violation_id: string;
  agreement_id: string;
  agreement_hash: string;
  metric: string;
  threshold: number;
  observed: number;
  operator: string;
  measurement_window: string;
  sample_count: number;
  timestamp: string;
  consecutive_count: number;
  samples: MetricSample[];
  evidence_hash: string;
}

interface MetricBuffer {
  observations: { value: number; timestamp: number }[];
  consecutiveFailures: number;
  lastViolationTime: number;
}

/**
 * Collects metric observations and evaluates behavioral checks from a Lockstep spec.
 * Runs locally — no external service required.
 */
export class MetricCollector {
  private buffers = new Map<string, MetricBuffer>();
  private agreementId: string;
  private agreementHash: string;
  private retentionMs: number;

  constructor(agreement: { agreement_id: string; agreement_hash: string }, retentionHours = 168) {
    this.agreementId = agreement.agreement_id;
    this.agreementHash = agreement.agreement_hash;
    this.retentionMs = retentionHours * 3600_000;
  }

  /** Record a raw observation for a metric. */
  record(metric: string, value: number): void {
    let buf = this.buffers.get(metric);
    if (!buf) {
      buf = { observations: [], consecutiveFailures: 0, lastViolationTime: 0 };
      this.buffers.set(metric, buf);
    }
    buf.observations.push({ value, timestamp: Date.now() });
    this.evict(buf);
  }

  /** Evict observations older than the retention window. */
  private evict(buf: MetricBuffer): void {
    const cutoff = Date.now() - this.retentionMs;
    while (buf.observations.length > 0 && buf.observations[0].timestamp < cutoff) {
      buf.observations.shift();
    }
  }

  /** Compute the aggregate value for a metric over a measurement window. */
  aggregate(
    metric: string,
    method: string,
    windowMs: number,
  ): { value: number; sampleCount: number } | null {
    const buf = this.buffers.get(metric);
    if (!buf || buf.observations.length === 0) return null;

    const cutoff = Date.now() - windowMs;
    const windowObs = buf.observations.filter((o) => o.timestamp >= cutoff);
    if (windowObs.length === 0) return null;

    const values = windowObs.map((o) => o.value);
    let value: number;

    switch (method) {
      case 'percentile':
        // For p99, p50 etc — sort and pick percentile
        values.sort((a, b) => a - b);
        value = values[Math.floor(values.length * 0.99)] ?? values[values.length - 1];
        break;
      case 'count':
        value = values.length;
        break;
      case 'rate':
        value = values.reduce((s, v) => s + v, 0) / (windowMs / 60_000);
        break;
      case 'instant':
        value = values[values.length - 1];
        break;
      case 'rolling_average':
      default:
        value = values.reduce((s, v) => s + v, 0) / values.length;
        break;
    }

    return { value, sampleCount: windowObs.length };
  }

  /** Evaluate all behavioral checks in a Lockstep spec and return violations. */
  evaluate(spec: LockstepVerificationSpec): Violation[] {
    const violations: Violation[] = [];
    const now = Date.now();

    for (const check of spec.behavioral_checks) {
      const windowMs = parseDuration(check.measurement_window);
      const agg = this.aggregate(check.metric, check.measurement_method, windowMs);
      const minSamples = (check as { min_samples?: number }).min_samples ?? 10;
      if (!agg || agg.sampleCount < minSamples) {
        continue;
      }

      let failed = false;
      switch (check.operator) {
        case 'lte':
          failed = agg.value > check.threshold;
          break;
        case 'gte':
          failed = agg.value < check.threshold;
          break;
        case 'eq':
          failed = agg.value !== check.threshold;
          break;
      }

      const buf = this.buffers.get(check.metric);
      if (!buf) continue;

      if (failed) {
        buf.consecutiveFailures++;
      } else {
        buf.consecutiveFailures = 0;
        continue;
      }

      const policy = (check as { violation_policy?: { consecutive_failures?: number; cooldown_seconds?: number } }).violation_policy;
      const requiredFailures = policy?.consecutive_failures ?? 3;
      const cooldownMs = (policy?.cooldown_seconds ?? 300) * 1000;

      if (buf.consecutiveFailures < requiredFailures) continue;
      if (now - buf.lastViolationTime < cooldownMs) continue;

      buf.lastViolationTime = now;

      const cutoff = now - windowMs;
      const windowObs = buf.observations.filter((o) => o.timestamp >= cutoff);
      const samples: MetricSample[] = windowObs.map((o) => ({
        metric: check.metric,
        value: o.value,
        timestamp: new Date(o.timestamp).toISOString(),
        agreement_id: this.agreementId,
        measurement_window: check.measurement_window,
        sample_count: 1,
      }));

      violations.push({
        violation_id: crypto.randomUUID(),
        agreement_id: this.agreementId,
        agreement_hash: this.agreementHash,
        metric: check.metric,
        threshold: check.threshold,
        observed: agg.value,
        operator: check.operator,
        measurement_window: check.measurement_window,
        sample_count: agg.sampleCount,
        timestamp: new Date(now).toISOString(),
        consecutive_count: buf.consecutiveFailures,
        samples,
        evidence_hash: '', // Computed by caller via agreementHash(samples)
      });
    }

    return violations;
  }

  /** Get the number of observations recorded for a metric. */
  getObservationCount(metric: string): number {
    return this.buffers.get(metric)?.observations.length ?? 0;
  }

  /** Clear all recorded observations. */
  clear(): void {
    this.buffers.clear();
  }
}

/** Parse an ISO 8601 duration string to milliseconds. Supports PT{n}H, PT{n}M, PT{n}S, P{n}D. */
function parseDuration(iso: string): number {
  const match = iso.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!match) return 3600_000; // default 1 hour
  const days = parseInt(match[1] || '0', 10);
  const hours = parseInt(match[2] || '0', 10);
  const minutes = parseInt(match[3] || '0', 10);
  const seconds = parseInt(match[4] || '0', 10);
  return ((days * 24 + hours) * 3600 + minutes * 60 + seconds) * 1000;
}
