import type { SLAMetric } from '@ophirai/protocol';
import type { Agreement, DisputeResult } from './types.js';

const DEFAULT_LOCKSTEP_ENDPOINT = 'https://api.lockstep.dev/v1';

/** A single behavioral requirement in a Lockstep verification spec. */
export interface LockstepBehavioralRequirement {
  metric: string;
  operator: string;
  threshold: number;
  measurement_method: string;
  measurement_window: string;
}

/** Lockstep behavioral verification specification derived from SLA terms. */
export interface LockstepSpec {
  spec_version: string;
  agent_id: string;
  behavioral_requirements: LockstepBehavioralRequirement[];
  verification_mode: string;
  on_violation: {
    action: string;
    escrow_address?: string;
    penalty_rate?: number;
  };
}

/** Convert agreed SLA terms into a Lockstep behavioral verification specification.
 * @param agreement - The finalized agreement containing SLA metrics and escrow details
 * @returns A Lockstep spec with behavioral requirements derived from the agreement's SLA metrics
 * @example
 * ```typescript
 * const spec = agreementToLockstepSpec(agreement);
 * console.log(spec.behavioral_requirements); // [{ metric: 'latency', operator: '<=', ... }]
 * ```
 */
export function agreementToLockstepSpec(agreement: Agreement): LockstepSpec {
  const sla = agreement.final_terms.sla;
  const metrics: SLAMetric[] = sla?.metrics ?? [];

  return {
    spec_version: '1.0',
    agent_id: agreement.agreement_id,
    behavioral_requirements: metrics.map((m) => ({
      metric: m.name === 'custom' && m.custom_name ? m.custom_name : m.name,
      operator: m.comparison,
      threshold: m.target,
      measurement_method: m.measurement_method ?? 'rolling_average',
      measurement_window: m.measurement_window ?? '1h',
    })),
    verification_mode: 'continuous',
    on_violation: {
      action: 'trigger_dispute',
      escrow_address: agreement.escrow?.address,
      penalty_rate: metrics.length > 0 && metrics[0].penalty_per_violation
        ? parseFloat(metrics[0].penalty_per_violation.amount) || undefined
        : undefined,
    },
  };
}

/** Configuration for the LockstepMonitor. */
export interface LockstepMonitorConfig {
  /** Lockstep verification API endpoint. Defaults to the Lockstep public API. */
  verificationEndpoint?: string;
}

/** Result of an SLA compliance check against the Lockstep verification service. */
export interface ComplianceResult {
  compliant: boolean;
  violations: {
    metric: string;
    threshold: number;
    observed: number;
    timestamp: string;
  }[];
}

/**
 * Monitor agent compliance with agreed SLA terms via Lockstep verification.
 */
export class LockstepMonitor {
  private verificationEndpoint: string;
  private specs = new Map<string, LockstepSpec>();

  constructor(config: LockstepMonitorConfig = {}) {
    this.verificationEndpoint =
      config.verificationEndpoint ?? DEFAULT_LOCKSTEP_ENDPOINT;
  }

  /** Register an agreement for continuous SLA monitoring. Operates locally if the endpoint is unavailable.
   * @param agreement - The finalized agreement to monitor for SLA compliance
   * @returns An object containing the assigned monitoringId
   * @example
   * ```typescript
   * const monitor = new LockstepMonitor();
   * const { monitoringId } = await monitor.startMonitoring(agreement);
   * ```
   */
  async startMonitoring(
    agreement: Agreement,
  ): Promise<{ monitoringId: string }> {
    const spec = agreementToLockstepSpec(agreement);
    const monitoringId = `mon_${agreement.agreement_id}`;
    this.specs.set(monitoringId, spec);

    try {
      await fetch(`${this.verificationEndpoint}/monitors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ monitoring_id: monitoringId, spec }),
      });
      // Spec is already stored locally; remote registration is best-effort
    } catch (_err: unknown) {
      // Lockstep endpoint not available — operate in local mode.
      // This is best-effort: the spec is stored locally regardless.
    }

    return { monitoringId };
  }

  /** Check SLA compliance for a monitored agreement.
   * Returns unknown compliance status if the verification endpoint is unavailable,
   * so callers can distinguish between verified compliance and missing data.
   * @param monitoringId - The monitoring ID returned by startMonitoring
   * @returns A compliance result with violation details; `compliant` is false with an empty violations array when the endpoint is unreachable (unknown state)
   * @example
   * ```typescript
   * const result = await monitor.checkCompliance(monitoringId);
   * if (!result.compliant) console.log('Violations:', result.violations);
   * ```
   */
  async checkCompliance(monitoringId: string): Promise<ComplianceResult> {
    try {
      const res = await fetch(
        `${this.verificationEndpoint}/monitors/${monitoringId}/compliance`,
      );
      if (res.ok) {
        return (await res.json()) as ComplianceResult;
      }
    } catch (_err: unknown) {
      // Lockstep endpoint unavailable — cannot verify compliance
    }

    // Cannot verify compliance — report as non-compliant with no specific violations
    // so callers don't mistakenly treat unverified state as verified compliance.
    return { compliant: false, violations: [] };
  }

  /** Trigger an SLA violation dispute via the Lockstep service. Returns a pending result if the endpoint is unavailable.
   * @param monitoringId - The monitoring ID for the agreement in violation
   * @param violation - Details of the observed SLA violation
   * @returns The dispute result with outcome status ("pending" when the endpoint is unavailable)
   * @example
   * ```typescript
   * const dispute = await monitor.triggerDispute(monitoringId, {
   *   metric: 'latency', threshold: 200, observed: 450,
   * });
   * ```
   */
  async triggerDispute(
    monitoringId: string,
    violation: { metric: string; threshold: number; observed: number },
  ): Promise<DisputeResult> {
    const spec = this.specs.get(monitoringId);

    try {
      const res = await fetch(
        `${this.verificationEndpoint}/monitors/${monitoringId}/dispute`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ violation, spec }),
        },
      );
      if (res.ok) {
        return (await res.json()) as DisputeResult;
      }
    } catch (_err: unknown) {
      // Lockstep endpoint unavailable — return pending result
    }

    return {
      dispute_id: `dispute_${monitoringId}_${Date.now()}`,
      outcome: 'pending',
    };
  }
}
