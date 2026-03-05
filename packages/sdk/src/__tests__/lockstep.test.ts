import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  agreementToLockstepSpec,
  LockstepMonitor,
} from '../lockstep.js';
import type { LockstepSpec } from '../lockstep.js';
import type { Agreement } from '../types.js';
import type { SLAMetric } from '@ophirai/protocol';

function makeAgreement(overrides: Partial<Agreement> = {}): Agreement {
  return {
    agreement_id: 'agr_001',
    rfq_id: 'rfq_001',
    accepting_message_id: 'quote_001',
    final_terms: {
      price_per_unit: '0.005',
      currency: 'USDC',
      unit: 'request',
      sla: {
        metrics: [
          {
            name: 'uptime_pct',
            target: 99.9,
            comparison: 'gte',
            measurement_method: 'rolling_average',
            measurement_window: '24h',
            penalty_per_violation: {
              amount: '10.0',
              currency: 'USDC',
            },
          },
          {
            name: 'p99_latency_ms',
            target: 200,
            comparison: 'lte',
          },
          {
            name: 'accuracy_pct',
            target: 95,
            comparison: 'gte',
            measurement_method: 'sampled',
            measurement_window: '1h',
          },
        ],
      },
    },
    agreement_hash: 'abc123def456',
    buyer_signature: 'buyer_sig_base64',
    seller_signature: 'seller_sig_base64',
    ...overrides,
  };
}

describe('agreementToLockstepSpec', () => {
  it('produces valid structure with spec_version and verification_mode', () => {
    const agreement = makeAgreement();
    const spec = agreementToLockstepSpec(agreement);

    expect(spec.spec_version).toBe('1.0');
    expect(spec.verification_mode).toBe('continuous');
    expect(spec.agent_id).toBe('agr_001');
  });

  it('maps all SLA metrics to behavioral requirements', () => {
    const agreement = makeAgreement();
    const spec = agreementToLockstepSpec(agreement);

    expect(spec.behavioral_requirements).toHaveLength(3);

    const [uptime, latency, accuracy] = spec.behavioral_requirements;

    expect(uptime.metric).toBe('uptime_pct');
    expect(uptime.operator).toBe('gte');
    expect(uptime.threshold).toBe(99.9);
    expect(uptime.measurement_method).toBe('rolling_average');
    expect(uptime.measurement_window).toBe('24h');

    expect(latency.metric).toBe('p99_latency_ms');
    expect(latency.operator).toBe('lte');
    expect(latency.threshold).toBe(200);
    expect(latency.measurement_method).toBe('rolling_average'); // default
    expect(latency.measurement_window).toBe('1h'); // default

    expect(accuracy.metric).toBe('accuracy_pct');
    expect(accuracy.operator).toBe('gte');
    expect(accuracy.threshold).toBe(95);
    expect(accuracy.measurement_method).toBe('sampled');
    expect(accuracy.measurement_window).toBe('1h');
  });

  it('uses custom_name for custom metrics', () => {
    const agreement = makeAgreement({
      final_terms: {
        price_per_unit: '0.01',
        currency: 'USDC',
        unit: 'request',
        sla: {
          metrics: [
            {
              name: 'custom',
              custom_name: 'gpu_utilization_pct',
              target: 80,
              comparison: 'gte',
            },
          ],
        },
      },
    });
    const spec = agreementToLockstepSpec(agreement);

    expect(spec.behavioral_requirements).toHaveLength(1);
    expect(spec.behavioral_requirements[0].metric).toBe('gpu_utilization_pct');
  });

  it('sets on_violation with escrow address when present', () => {
    const agreement = makeAgreement({
      escrow: {
        address: 'EscrowPDA123abc',
        txSignature: 'tx_sig_123',
      },
    });
    const spec = agreementToLockstepSpec(agreement);

    expect(spec.on_violation.action).toBe('trigger_dispute');
    expect(spec.on_violation.escrow_address).toBe('EscrowPDA123abc');
  });

  it('sets penalty_rate from first metric penalty_per_violation', () => {
    const agreement = makeAgreement();
    const spec = agreementToLockstepSpec(agreement);

    expect(spec.on_violation.penalty_rate).toBe(10.0);
  });

  it('omits penalty_rate when no penalty_per_violation', () => {
    const agreement = makeAgreement({
      final_terms: {
        price_per_unit: '0.01',
        currency: 'USDC',
        unit: 'request',
        sla: {
          metrics: [
            { name: 'uptime_pct', target: 99, comparison: 'gte' },
          ],
        },
      },
    });
    const spec = agreementToLockstepSpec(agreement);

    expect(spec.on_violation.penalty_rate).toBeUndefined();
  });

  it('handles agreement with no SLA metrics', () => {
    const agreement = makeAgreement({
      final_terms: {
        price_per_unit: '0.01',
        currency: 'USDC',
        unit: 'request',
      },
    });
    const spec = agreementToLockstepSpec(agreement);

    expect(spec.behavioral_requirements).toHaveLength(0);
    expect(spec.on_violation.penalty_rate).toBeUndefined();
  });

  it('omits escrow_address when no escrow on agreement', () => {
    const agreement = makeAgreement();
    delete (agreement as unknown as Record<string, unknown>).escrow;
    const spec = agreementToLockstepSpec(agreement);

    expect(spec.on_violation.escrow_address).toBeUndefined();
  });

  it('maps all 8 standard SLA metric names', () => {
    const metricNames: SLAMetric['name'][] = [
      'uptime_pct',
      'p50_latency_ms',
      'p99_latency_ms',
      'accuracy_pct',
      'throughput_rpm',
      'error_rate_pct',
      'time_to_first_byte_ms',
      'custom',
    ];

    const metrics: SLAMetric[] = metricNames.map((name) => ({
      name,
      target: 99,
      comparison: 'gte' as const,
      ...(name === 'custom' ? { custom_name: 'my_metric' } : {}),
    }));

    const agreement = makeAgreement({
      final_terms: {
        price_per_unit: '0.01',
        currency: 'USDC',
        unit: 'request',
        sla: { metrics },
      },
    });
    const spec = agreementToLockstepSpec(agreement);

    expect(spec.behavioral_requirements).toHaveLength(8);
    const mapped = spec.behavioral_requirements.map((r) => r.metric);
    expect(mapped).toContain('uptime_pct');
    expect(mapped).toContain('p50_latency_ms');
    expect(mapped).toContain('p99_latency_ms');
    expect(mapped).toContain('accuracy_pct');
    expect(mapped).toContain('throughput_rpm');
    expect(mapped).toContain('error_rate_pct');
    expect(mapped).toContain('time_to_first_byte_ms');
    expect(mapped).toContain('my_metric'); // custom resolved to custom_name
  });
});

describe('LockstepMonitor', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('defaults to https://api.lockstep.dev/v1 endpoint', () => {
    const monitor = new LockstepMonitor();
    // Verify by observing fetch URL during startMonitoring
    const agreement = makeAgreement();
    const mockFetch = vi.fn().mockRejectedValue(new Error('skip'));
    vi.stubGlobal('fetch', mockFetch);

    monitor.startMonitoring(agreement);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.lockstep.dev/v1/monitors',
      expect.any(Object),
    );
  });

  it('uses custom verification endpoint', () => {
    const monitor = new LockstepMonitor({
      verificationEndpoint: 'http://localhost:9000',
    });
    const agreement = makeAgreement();
    const mockFetch = vi.fn().mockRejectedValue(new Error('skip'));
    vi.stubGlobal('fetch', mockFetch);

    monitor.startMonitoring(agreement);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:9000/monitors',
      expect.any(Object),
    );
  });

  it('startMonitoring returns a monitoringId', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const monitor = new LockstepMonitor();
    const agreement = makeAgreement();
    const result = await monitor.startMonitoring(agreement);

    expect(result.monitoringId).toBe('mon_agr_001');
  });

  it('startMonitoring succeeds even when endpoint is unreachable', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', mockFetch);

    const monitor = new LockstepMonitor();
    const agreement = makeAgreement();
    const result = await monitor.startMonitoring(agreement);

    expect(result.monitoringId).toBe('mon_agr_001');
  });

  it('checkCompliance returns remote data when available', async () => {
    const remoteResult = {
      compliant: false,
      violations: [
        { metric: 'uptime_pct', threshold: 99.9, observed: 98.5, timestamp: '2026-03-04T00:00:00Z' },
      ],
    };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(remoteResult),
    });
    vi.stubGlobal('fetch', mockFetch);

    const monitor = new LockstepMonitor();
    const result = await monitor.checkCompliance('mon_agr_001');

    expect(result.compliant).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].metric).toBe('uptime_pct');
  });

  it('checkCompliance reports non-compliant when endpoint fails (safe default)', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('timeout'));
    vi.stubGlobal('fetch', mockFetch);

    const monitor = new LockstepMonitor();
    const result = await monitor.checkCompliance('mon_agr_001');

    // When the verification endpoint is unreachable, compliance is unknown.
    // The safe default is to report non-compliant with no specific violations,
    // so callers don't mistakenly treat unverified state as verified compliance.
    expect(result.compliant).toBe(false);
    expect(result.violations).toHaveLength(0);
  });

  it('checkCompliance reports non-compliant when response is not ok', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal('fetch', mockFetch);

    const monitor = new LockstepMonitor();
    const result = await monitor.checkCompliance('mon_agr_001');

    expect(result.compliant).toBe(false);
    expect(result.violations).toHaveLength(0);
  });

  it('triggerDispute returns remote result when available', async () => {
    const remoteDispute = {
      dispute_id: 'dispute_remote_123',
      outcome: 'penalty_applied' as const,
      txSignature: 'tx_abc123',
    };
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true }) // startMonitoring
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(remoteDispute),
      });
    vi.stubGlobal('fetch', mockFetch);

    const monitor = new LockstepMonitor();
    await monitor.startMonitoring(makeAgreement());
    const result = await monitor.triggerDispute('mon_agr_001', {
      metric: 'uptime_pct',
      threshold: 99.9,
      observed: 98.5,
    });

    expect(result.dispute_id).toBe('dispute_remote_123');
    expect(result.outcome).toBe('penalty_applied');
  });

  it('triggerDispute returns pending fallback when endpoint fails', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('unreachable'));
    vi.stubGlobal('fetch', mockFetch);

    const monitor = new LockstepMonitor();
    const result = await monitor.triggerDispute('mon_agr_001', {
      metric: 'uptime_pct',
      threshold: 99.9,
      observed: 98.5,
    });

    expect(result.dispute_id).toMatch(/^dispute_mon_agr_001_/);
    expect(result.outcome).toBe('pending');
  });

  it('triggerDispute sends spec and violation in body', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true }) // startMonitoring
      .mockResolvedValueOnce({ ok: false }); // triggerDispute fails, that's OK
    vi.stubGlobal('fetch', mockFetch);

    const monitor = new LockstepMonitor({
      verificationEndpoint: 'http://local:8080',
    });
    const agreement = makeAgreement();
    await monitor.startMonitoring(agreement);

    const violation = { metric: 'p99_latency_ms', threshold: 200, observed: 500 };
    await monitor.triggerDispute('mon_agr_001', violation);

    const disputeCall = mockFetch.mock.calls[1];
    expect(disputeCall[0]).toBe('http://local:8080/monitors/mon_agr_001/dispute');
    const body = JSON.parse(disputeCall[1].body);
    expect(body.violation).toEqual(violation);
    expect(body.spec).toBeDefined();
    expect(body.spec.agent_id).toBe('agr_001');
  });
});
