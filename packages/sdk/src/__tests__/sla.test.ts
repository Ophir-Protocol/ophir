import { describe, it, expect } from 'vitest';
import {
  SLA_TEMPLATES,
  compareSLAs,
  meetsSLARequirements,
  slaToLockstepSpec,
} from '../sla.js';
import type { LockstepVerificationSpec } from '../sla.js';
import type { SLARequirement } from '@ophir/protocol';

describe('SLA_TEMPLATES', () => {
  it('inference_realtime returns valid structure', () => {
    const sla = SLA_TEMPLATES.inference_realtime();
    expect(sla.metrics).toHaveLength(3);
    expect(sla.dispute_resolution).toBeDefined();

    const names = sla.metrics.map((m) => m.name);
    expect(names).toContain('p99_latency_ms');
    expect(names).toContain('uptime_pct');
    expect(names).toContain('accuracy_pct');
  });

  it('inference_batch returns valid structure', () => {
    const sla = SLA_TEMPLATES.inference_batch();
    expect(sla.metrics).toHaveLength(3);
    const names = sla.metrics.map((m) => m.name);
    expect(names).toContain('throughput_rpm');
    expect(names).toContain('accuracy_pct');
    expect(names).toContain('error_rate_pct');
  });

  it('all templates have metrics and dispute_resolution', () => {
    for (const key of Object.keys(SLA_TEMPLATES) as (keyof typeof SLA_TEMPLATES)[]) {
      const sla = SLA_TEMPLATES[key]();
      expect(sla.metrics.length).toBeGreaterThan(0);
      expect(sla.dispute_resolution).toBeDefined();
      for (const m of sla.metrics) {
        expect(m.name).toBeTruthy();
        expect(typeof m.target).toBe('number');
        expect(['gte', 'lte', 'eq', 'between']).toContain(m.comparison);
      }
    }
  });
});

describe('compareSLAs', () => {
  it('identifies winner with better gte metrics', () => {
    const a: SLARequirement = {
      metrics: [
        { name: 'uptime_pct', target: 99.9, comparison: 'gte' },
        { name: 'accuracy_pct', target: 98, comparison: 'gte' },
      ],
    };
    const b: SLARequirement = {
      metrics: [
        { name: 'uptime_pct', target: 99.5, comparison: 'gte' },
        { name: 'accuracy_pct', target: 95, comparison: 'gte' },
      ],
    };

    const result = compareSLAs(a, b);
    expect(result.winner).toBe('a');
    expect(result.details).toHaveLength(2);
    expect(result.details.every((d) => d.better === 'a')).toBe(true);
  });

  it('identifies winner with better lte metrics', () => {
    const a: SLARequirement = {
      metrics: [{ name: 'p99_latency_ms', target: 200, comparison: 'lte' }],
    };
    const b: SLARequirement = {
      metrics: [{ name: 'p99_latency_ms', target: 500, comparison: 'lte' }],
    };

    const result = compareSLAs(a, b);
    expect(result.winner).toBe('a');
    expect(result.details[0].better).toBe('a');
  });

  it('returns tie when metrics are equal', () => {
    const sla: SLARequirement = {
      metrics: [{ name: 'uptime_pct', target: 99.9, comparison: 'gte' }],
    };

    const result = compareSLAs(sla, sla);
    expect(result.winner).toBe('tie');
  });

  it('handles mixed metric winners', () => {
    const a: SLARequirement = {
      metrics: [
        { name: 'uptime_pct', target: 99.9, comparison: 'gte' },
        { name: 'p99_latency_ms', target: 800, comparison: 'lte' },
      ],
    };
    const b: SLARequirement = {
      metrics: [
        { name: 'uptime_pct', target: 99.5, comparison: 'gte' },
        { name: 'p99_latency_ms', target: 200, comparison: 'lte' },
      ],
    };

    const result = compareSLAs(a, b);
    expect(result.winner).toBe('tie');
  });
});

describe('meetsSLARequirements', () => {
  it('passes when offered meets all requirements', () => {
    const required: SLARequirement = {
      metrics: [
        { name: 'uptime_pct', target: 99, comparison: 'gte' },
        { name: 'p99_latency_ms', target: 500, comparison: 'lte' },
      ],
    };
    const offered: SLARequirement = {
      metrics: [
        { name: 'uptime_pct', target: 99.9, comparison: 'gte' },
        { name: 'p99_latency_ms', target: 300, comparison: 'lte' },
      ],
    };

    const result = meetsSLARequirements(offered, required);
    expect(result.meets).toBe(true);
    expect(result.gaps).toHaveLength(0);
  });

  it('detects gap for gte metric not met', () => {
    const required: SLARequirement = {
      metrics: [{ name: 'uptime_pct', target: 99.9, comparison: 'gte' }],
    };
    const offered: SLARequirement = {
      metrics: [{ name: 'uptime_pct', target: 98, comparison: 'gte' }],
    };

    const result = meetsSLARequirements(offered, required);
    expect(result.meets).toBe(false);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].metric).toBe('uptime_pct');
    expect(result.gaps[0].required).toBe(99.9);
    expect(result.gaps[0].offered).toBe(98);
    expect(result.gaps[0].gap).toBeCloseTo(1.9);
  });

  it('detects gap for lte metric not met', () => {
    const required: SLARequirement = {
      metrics: [{ name: 'p99_latency_ms', target: 500, comparison: 'lte' }],
    };
    const offered: SLARequirement = {
      metrics: [{ name: 'p99_latency_ms', target: 800, comparison: 'lte' }],
    };

    const result = meetsSLARequirements(offered, required);
    expect(result.meets).toBe(false);
    expect(result.gaps[0].gap).toBe(300);
  });

  it('detects missing metric as a gap', () => {
    const required: SLARequirement = {
      metrics: [{ name: 'accuracy_pct', target: 95, comparison: 'gte' }],
    };
    const offered: SLARequirement = {
      metrics: [],
    };

    const result = meetsSLARequirements(offered, required);
    expect(result.meets).toBe(false);
    expect(result.gaps[0].metric).toBe('accuracy_pct');
    expect(result.gaps[0].offered).toBe(0);
  });
});

describe('slaToLockstepSpec', () => {
  it('converts SLA to Lockstep behavioral spec', () => {
    const sla = SLA_TEMPLATES.inference_realtime();
    const agreement = { agreement_id: 'agr-1', agreement_hash: 'abc123' };
    const spec: LockstepVerificationSpec = slaToLockstepSpec(sla, agreement);

    expect(spec.version).toBe('1.0');
    expect(spec.agreement_id).toBe('agr-1');
    expect(spec.agreement_hash).toBe('abc123');
    expect(spec.behavioral_checks).toHaveLength(3);
    expect(spec.behavioral_checks[0].metric).toBe('p99_latency_ms');
    expect(spec.behavioral_checks[0].operator).toBe('lte');
    expect(spec.behavioral_checks[0].threshold).toBe(500);
    expect(spec.dispute_resolution).toBeDefined();
  });

  it('handles empty metrics array', () => {
    const sla: SLARequirement = { metrics: [] };
    const agreement = { agreement_id: 'agr-empty', agreement_hash: 'hash' };
    const spec: LockstepVerificationSpec = slaToLockstepSpec(sla, agreement);

    expect(spec.behavioral_checks).toHaveLength(0);
    expect(spec.dispute_resolution).toBeDefined();
  });

  it('uses custom_name for custom metrics', () => {
    const sla: SLARequirement = {
      metrics: [{ name: 'custom', custom_name: 'gpu_utilization_pct', target: 80, comparison: 'gte' }],
    };
    const agreement = { agreement_id: 'agr-custom', agreement_hash: 'hash' };
    const spec: LockstepVerificationSpec = slaToLockstepSpec(sla, agreement);

    expect(spec.behavioral_checks[0].metric).toBe('gpu_utilization_pct');
  });
});

describe('edge cases', () => {
  it('compareSLAs with empty metrics returns tie', () => {
    const empty: SLARequirement = { metrics: [] };
    const result = compareSLAs(empty, empty);
    expect(result.winner).toBe('tie');
    expect(result.details).toHaveLength(0);
  });

  it('meetsSLARequirements with empty required returns meets', () => {
    const offered: SLARequirement = {
      metrics: [{ name: 'uptime_pct', target: 99, comparison: 'gte' }],
    };
    const required: SLARequirement = { metrics: [] };
    const result = meetsSLARequirements(offered, required);
    expect(result.meets).toBe(true);
    expect(result.gaps).toHaveLength(0);
  });

  it('meetsSLARequirements handles custom metric name', () => {
    const required: SLARequirement = {
      metrics: [{ name: 'custom', custom_name: 'tokens_per_sec', target: 100, comparison: 'gte' }],
    };
    const offered: SLARequirement = {
      metrics: [{ name: 'custom', custom_name: 'tokens_per_sec', target: 150, comparison: 'gte' }],
    };
    const result = meetsSLARequirements(offered, required);
    expect(result.meets).toBe(true);
  });

  it('each template has at least 3 metrics', () => {
    for (const key of Object.keys(SLA_TEMPLATES) as (keyof typeof SLA_TEMPLATES)[]) {
      const sla = SLA_TEMPLATES[key]();
      expect(sla.metrics.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('SLA utilities additional coverage', () => {
  describe('compareSLAs edge cases', () => {
    it('handles single metric comparison', () => {
      const a: SLARequirement = { metrics: [{ name: 'uptime_pct', target: 99.9, comparison: 'gte' }] };
      const b: SLARequirement = { metrics: [{ name: 'uptime_pct', target: 99.5, comparison: 'gte' }] };
      const result = compareSLAs(a, b);
      expect(result.winner).toBe('a');
      expect(result.details).toHaveLength(1);
    });

    it('handles non-overlapping metrics', () => {
      const a: SLARequirement = { metrics: [{ name: 'uptime_pct', target: 99, comparison: 'gte' }] };
      const b: SLARequirement = { metrics: [{ name: 'p99_latency_ms', target: 500, comparison: 'lte' }] };
      const result = compareSLAs(a, b);
      expect(result.winner).toBe('tie');
      expect(result.details).toHaveLength(0);
    });

    it('handles lte comparison correctly - lower is better', () => {
      const a: SLARequirement = { metrics: [{ name: 'p99_latency_ms', target: 200, comparison: 'lte' }] };
      const b: SLARequirement = { metrics: [{ name: 'p99_latency_ms', target: 500, comparison: 'lte' }] };
      const result = compareSLAs(a, b);
      expect(result.winner).toBe('a');
    });

    it('handles eq comparison correctly', () => {
      const a: SLARequirement = { metrics: [{ name: 'uptime_pct', target: 99.9, comparison: 'eq' }] };
      const b: SLARequirement = { metrics: [{ name: 'uptime_pct', target: 99.9, comparison: 'eq' }] };
      const result = compareSLAs(a, b);
      expect(result.winner).toBe('tie');
    });
  });

  describe('meetsSLARequirements edge cases', () => {
    it('handles eq comparison - exact match passes', () => {
      const offered: SLARequirement = { metrics: [{ name: 'uptime_pct', target: 99.9, comparison: 'eq' }] };
      const required: SLARequirement = { metrics: [{ name: 'uptime_pct', target: 99.9, comparison: 'eq' }] };
      const result = meetsSLARequirements(offered, required);
      expect(result.meets).toBe(true);
      expect(result.gaps).toHaveLength(0);
    });

    it('handles eq comparison - mismatch fails', () => {
      const offered: SLARequirement = { metrics: [{ name: 'uptime_pct', target: 99.5, comparison: 'eq' }] };
      const required: SLARequirement = { metrics: [{ name: 'uptime_pct', target: 99.9, comparison: 'eq' }] };
      const result = meetsSLARequirements(offered, required);
      expect(result.meets).toBe(false);
      expect(result.gaps).toHaveLength(1);
      expect(result.gaps[0].gap).toBeCloseTo(0.4);
    });

    it('handles multiple gaps', () => {
      const offered: SLARequirement = { metrics: [
        { name: 'uptime_pct', target: 95, comparison: 'gte' },
        { name: 'p99_latency_ms', target: 1000, comparison: 'lte' },
      ] };
      const required: SLARequirement = { metrics: [
        { name: 'uptime_pct', target: 99.9, comparison: 'gte' },
        { name: 'p99_latency_ms', target: 500, comparison: 'lte' },
      ] };
      const result = meetsSLARequirements(offered, required);
      expect(result.meets).toBe(false);
      expect(result.gaps).toHaveLength(2);
    });

    it('offered exceeds required is still a pass', () => {
      const offered: SLARequirement = { metrics: [{ name: 'uptime_pct', target: 99.99, comparison: 'gte' }] };
      const required: SLARequirement = { metrics: [{ name: 'uptime_pct', target: 99.9, comparison: 'gte' }] };
      const result = meetsSLARequirements(offered, required);
      expect(result.meets).toBe(true);
    });
  });

  describe('SLA_TEMPLATES validation', () => {
    it('data_processing template has 3 metrics', () => {
      const sla = SLA_TEMPLATES.data_processing();
      expect(sla.metrics).toHaveLength(3);
      expect(sla.dispute_resolution?.method).toBe('automatic_escrow');
    });

    it('code_generation template has 3 metrics', () => {
      const sla = SLA_TEMPLATES.code_generation();
      expect(sla.metrics).toHaveLength(3);
      const names = sla.metrics.map(m => m.name);
      expect(names).toContain('p99_latency_ms');
      expect(names).toContain('accuracy_pct');
    });

    it('translation template has 3 metrics', () => {
      const sla = SLA_TEMPLATES.translation();
      expect(sla.metrics).toHaveLength(3);
    });

    it('inference_batch template has throughput metric', () => {
      const sla = SLA_TEMPLATES.inference_batch();
      const throughput = sla.metrics.find(m => m.name === 'throughput_rpm');
      expect(throughput).toBeDefined();
      expect(throughput!.target).toBe(1000);
    });

    it('all templates return fresh objects', () => {
      const a = SLA_TEMPLATES.inference_realtime();
      const b = SLA_TEMPLATES.inference_realtime();
      expect(a).not.toBe(b); // different references
      expect(a).toEqual(b); // same content
    });
  });

  describe('slaToLockstepSpec detailed', () => {
    it('includes all standard operator mappings', () => {
      const sla: SLARequirement = { metrics: [
        { name: 'uptime_pct', target: 99.9, comparison: 'gte' },
        { name: 'p99_latency_ms', target: 500, comparison: 'lte' },
        { name: 'accuracy_pct', target: 95, comparison: 'eq' },
      ] };
      const spec = slaToLockstepSpec(sla, { agreement_id: 'a1', agreement_hash: 'h1' });
      expect(spec.behavioral_checks).toHaveLength(3);
      expect(spec.behavioral_checks[0].operator).toBe('gte');
      expect(spec.behavioral_checks[1].operator).toBe('lte');
      expect(spec.behavioral_checks[2].operator).toBe('eq');
    });

    it('uses custom measurement_method when specified', () => {
      const sla: SLARequirement = { metrics: [
        { name: 'p99_latency_ms', target: 500, comparison: 'lte', measurement_method: 'percentile', measurement_window: '24h' },
      ] };
      const spec = slaToLockstepSpec(sla, { agreement_id: 'a1', agreement_hash: 'h1' });
      expect(spec.behavioral_checks[0].measurement_method).toBe('percentile');
      expect(spec.behavioral_checks[0].measurement_window).toBe('24h');
    });

    it('uses default measurement_method when not specified', () => {
      const sla: SLARequirement = { metrics: [
        { name: 'uptime_pct', target: 99.9, comparison: 'gte' },
      ] };
      const spec = slaToLockstepSpec(sla, { agreement_id: 'a1', agreement_hash: 'h1' });
      expect(spec.behavioral_checks[0].measurement_method).toBe('rolling_average');
      expect(spec.behavioral_checks[0].measurement_window).toBe('1h');
    });

    it('includes dispute_resolution from SLA', () => {
      const sla: SLARequirement = {
        metrics: [{ name: 'uptime_pct', target: 99.9, comparison: 'gte' }],
        dispute_resolution: { method: 'lockstep_verification', timeout_hours: 48 },
      };
      const spec = slaToLockstepSpec(sla, { agreement_id: 'a1', agreement_hash: 'h1' });
      expect(spec.dispute_resolution.method).toBe('lockstep_verification');
      expect(spec.dispute_resolution.timeout_hours).toBe(48);
    });
  });
});
