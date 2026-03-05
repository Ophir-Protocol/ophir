import { MetricCollector, slaToLockstepSpec } from '@ophirai/sdk';
import type { Violation, LockstepVerificationSpec } from '@ophirai/sdk';
import type { SLARequirement } from '@ophirai/protocol';

export interface MonitoredAgreement {
  agreementId: string;
  sellerId: string;
  collector: MetricCollector;
  violations: Violation[];
  requestCount: number;
  totalLatencyMs: number;
  errorCount: number;
  lastErrors: string[];
  slaSpec: LockstepVerificationSpec | null;
}

/**
 * Tracks SLA compliance across active agreements.
 * Uses MetricCollector.evaluate() against Lockstep specs to detect violations
 * automatically after each recorded observation.
 */
export class SLAMonitor {
  private agreements = new Map<string, MonitoredAgreement>();

  /** Start monitoring a new agreement. */
  track(agreementId: string, sellerId: string, agreementHash: string, sla?: SLARequirement): void {
    if (this.agreements.has(agreementId)) return;

    const collector = new MetricCollector({
      agreement_id: agreementId,
      agreement_hash: agreementHash,
    });

    const slaSpec = sla
      ? slaToLockstepSpec(sla, { agreement_id: agreementId, agreement_hash: agreementHash })
      : null;

    this.agreements.set(agreementId, {
      agreementId,
      sellerId,
      collector,
      violations: [],
      requestCount: 0,
      totalLatencyMs: 0,
      errorCount: 0,
      lastErrors: [],
      slaSpec,
    });
  }

  /** Stop monitoring an agreement. */
  untrack(agreementId: string): void {
    const entry = this.agreements.get(agreementId);
    if (entry) {
      entry.collector.clear();
      this.agreements.delete(agreementId);
    }
  }

  /** Record a successful request for an agreement. */
  recordSuccess(agreementId: string, latencyMs: number): void {
    const entry = this.agreements.get(agreementId);
    if (!entry) return;

    entry.requestCount++;
    entry.totalLatencyMs += latencyMs;

    entry.collector.record('p99_latency_ms', latencyMs);
    entry.collector.record('p50_latency_ms', latencyMs);
    entry.collector.record('time_to_first_byte_ms', latencyMs);
    entry.collector.record('uptime_pct', 100);
    entry.collector.record('error_rate_pct', 0);

    this.evaluateViolations(entry);
  }

  /** Record a failed request for an agreement. */
  recordFailure(agreementId: string, error: string): void {
    const entry = this.agreements.get(agreementId);
    if (!entry) return;

    entry.requestCount++;
    entry.errorCount++;

    // Keep a bounded ring of recent errors
    entry.lastErrors.push(error);
    if (entry.lastErrors.length > 10) {
      entry.lastErrors.shift();
    }

    entry.collector.record('uptime_pct', 0);
    entry.collector.record('error_rate_pct', 100);

    this.evaluateViolations(entry);
  }

  /** Get current stats for an agreement. */
  getStats(agreementId: string): {
    requestCount: number;
    avgLatencyMs: number;
    errorRate: number;
    violations: Violation[];
    successCount: number;
    lastErrors: string[];
    slaCompliance: number;
  } | null {
    const entry = this.agreements.get(agreementId);
    if (!entry) return null;

    const successCount = entry.requestCount - entry.errorCount;

    return {
      requestCount: entry.requestCount,
      avgLatencyMs: successCount > 0
        ? entry.totalLatencyMs / successCount
        : 0,
      errorRate: entry.requestCount > 0
        ? entry.errorCount / entry.requestCount
        : 0,
      violations: [...entry.violations],
      successCount,
      lastErrors: [...entry.lastErrors],
      slaCompliance: this.computeCompliance(entry),
    };
  }

  /** Get all agreements with active violations. */
  getViolations(): Array<{ agreementId: string; sellerId: string; violations: Violation[] }> {
    const result: Array<{ agreementId: string; sellerId: string; violations: Violation[] }> = [];

    for (const entry of this.agreements.values()) {
      if (entry.violations.length > 0) {
        result.push({
          agreementId: entry.agreementId,
          sellerId: entry.sellerId,
          violations: [...entry.violations],
        });
      }
    }

    return result;
  }

  /** Get SLA compliance score for a specific seller (0-1, 1 = perfect). */
  getSellerCompliance(sellerId: string): number | null {
    let totalRequests = 0;
    let totalViolations = 0;
    let found = false;

    for (const entry of this.agreements.values()) {
      if (entry.sellerId === sellerId) {
        found = true;
        totalRequests += entry.requestCount;
        totalViolations += entry.violations.length;
      }
    }

    if (!found || totalRequests === 0) return null;
    return Math.max(0, 1 - totalViolations / totalRequests);
  }

  /** Get all monitored agreement IDs. */
  getAgreementIds(): string[] {
    return [...this.agreements.keys()];
  }

  /** Get the seller ID for a monitored agreement. */
  getSellerForAgreement(agreementId: string): string | null {
    return this.agreements.get(agreementId)?.sellerId ?? null;
  }

  /** Evaluate the Lockstep spec against recorded metrics and accumulate new violations. */
  private evaluateViolations(entry: MonitoredAgreement): void {
    if (!entry.slaSpec) return;

    const newViolations = entry.collector.evaluate(entry.slaSpec);
    for (const v of newViolations) {
      // Avoid duplicate violations for the same metric in the same window
      const isDuplicate = entry.violations.some(
        (existing) =>
          existing.metric === v.metric &&
          existing.timestamp === v.timestamp,
      );
      if (!isDuplicate) {
        entry.violations.push(v);
      }
    }
  }

  /** Compute SLA compliance as a 0-1 score based on error rate and violations. */
  private computeCompliance(entry: MonitoredAgreement): number {
    if (entry.requestCount === 0) return 1;

    const errorPenalty = entry.errorCount / entry.requestCount;
    const violationPenalty = Math.min(entry.violations.length * 0.1, 0.5);

    return Math.max(0, 1 - errorPenalty - violationPenalty);
  }
}
