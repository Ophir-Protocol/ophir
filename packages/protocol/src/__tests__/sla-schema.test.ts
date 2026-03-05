import { describe, it, expect } from 'vitest';
import { SLA_JSON_SCHEMA } from '../sla-schema.js';

describe('SLA_JSON_SCHEMA', () => {
  it('uses JSON Schema draft 2020-12', () => {
    expect(SLA_JSON_SCHEMA.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it('has a schema ID', () => {
    expect(SLA_JSON_SCHEMA.$id).toBe('https://ophir.dev/schemas/sla/v1');
  });

  it('has a title and description', () => {
    expect(SLA_JSON_SCHEMA.title).toBe('Ophir SLA Specification');
    expect(SLA_JSON_SCHEMA.description).toBeTruthy();
  });

  it('is an object type', () => {
    expect(SLA_JSON_SCHEMA.type).toBe('object');
  });

  it('requires metrics array', () => {
    expect(SLA_JSON_SCHEMA.required).toContain('metrics');
  });

  it('metrics items require name, target, comparison', () => {
    const metricsItems = SLA_JSON_SCHEMA.properties.metrics.items;
    expect(metricsItems.required).toContain('name');
    expect(metricsItems.required).toContain('target');
    expect(metricsItems.required).toContain('comparison');
  });

  it('defines all 8 SLA metric names in the enum', () => {
    const nameEnum = SLA_JSON_SCHEMA.properties.metrics.items.properties.name.enum;
    expect(nameEnum).toHaveLength(8);
    expect(nameEnum).toContain('uptime_pct');
    expect(nameEnum).toContain('p50_latency_ms');
    expect(nameEnum).toContain('p99_latency_ms');
    expect(nameEnum).toContain('accuracy_pct');
    expect(nameEnum).toContain('throughput_rpm');
    expect(nameEnum).toContain('error_rate_pct');
    expect(nameEnum).toContain('time_to_first_byte_ms');
    expect(nameEnum).toContain('custom');
  });

  it('defines comparison operators', () => {
    const compEnum = SLA_JSON_SCHEMA.properties.metrics.items.properties.comparison.enum;
    expect(compEnum).toEqual(['gte', 'lte', 'eq', 'between']);
  });

  it('defines measurement methods', () => {
    const mmEnum = SLA_JSON_SCHEMA.properties.metrics.items.properties.measurement_method.enum;
    expect(mmEnum).toEqual(['rolling_average', 'percentile', 'absolute', 'sampled']);
  });

  it('requires custom_name when name is custom (conditional schema)', () => {
    const items = SLA_JSON_SCHEMA.properties.metrics.items;
    expect(items.if).toBeDefined();
    expect(items.if.properties.name.const).toBe('custom');
    expect(items.then.required).toContain('custom_name');
  });

  it('defines dispute resolution with 4 methods', () => {
    const dr = SLA_JSON_SCHEMA.properties.dispute_resolution;
    expect(dr.required).toContain('method');
    expect(dr.properties.method.enum).toEqual([
      'automatic_escrow',
      'lockstep_verification',
      'timeout_release',
      'manual_arbitration',
    ]);
  });

  it('disallows additional properties at all levels', () => {
    expect(SLA_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(SLA_JSON_SCHEMA.properties.metrics.items.additionalProperties).toBe(false);
    expect(SLA_JSON_SCHEMA.properties.dispute_resolution.additionalProperties).toBe(false);
  });
});
