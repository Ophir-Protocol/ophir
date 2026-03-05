import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CONFIG,
  PROTOCOL_VERSION,
  ESCROW_PROGRAM_ID,
  SUPPORTED_SLA_METRICS,
  NEGOTIATION_STATES,
} from '../constants.js';

describe('DEFAULT_CONFIG', () => {
  it('has Solana devnet RPC', () => {
    expect(DEFAULT_CONFIG.solana_rpc).toBe('https://api.devnet.solana.com');
  });

  it('has 5 minute RFQ timeout', () => {
    expect(DEFAULT_CONFIG.rfq_timeout_ms).toBe(5 * 60 * 1000);
  });

  it('has 2 minute quote timeout', () => {
    expect(DEFAULT_CONFIG.quote_timeout_ms).toBe(2 * 60 * 1000);
  });

  it('has 2 minute counter timeout', () => {
    expect(DEFAULT_CONFIG.counter_timeout_ms).toBe(2 * 60 * 1000);
  });

  it('max negotiation rounds is 5', () => {
    expect(DEFAULT_CONFIG.max_negotiation_rounds).toBe(5);
  });

  it('currency is USDC', () => {
    expect(DEFAULT_CONFIG.currency).toBe('USDC');
  });

  it('escrow PDA seeds start with "escrow"', () => {
    expect(DEFAULT_CONFIG.escrow_pda_seeds).toEqual(['escrow']);
  });

  it('payment network is solana', () => {
    expect(DEFAULT_CONFIG.payment_network).toBe('solana');
  });

  it('payment token is USDC', () => {
    expect(DEFAULT_CONFIG.payment_token).toBe('USDC');
  });
});

describe('PROTOCOL_VERSION', () => {
  it('is 1.0', () => {
    expect(PROTOCOL_VERSION).toBe('1.0');
  });
});

describe('ESCROW_PROGRAM_ID', () => {
  it('is a valid base58 Solana program ID', () => {
    expect(ESCROW_PROGRAM_ID).toBe('CHwqh23SpWSM6WLsd15iQcP4KSkB351S9eGcN4fQSVqy');
    expect(ESCROW_PROGRAM_ID).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
  });
});

describe('SUPPORTED_SLA_METRICS', () => {
  it('contains all 8 SLA metric names', () => {
    expect(SUPPORTED_SLA_METRICS).toHaveLength(8);
  });

  it('includes uptime_pct', () => {
    expect(SUPPORTED_SLA_METRICS).toContain('uptime_pct');
  });

  it('includes p50_latency_ms', () => {
    expect(SUPPORTED_SLA_METRICS).toContain('p50_latency_ms');
  });

  it('includes p99_latency_ms', () => {
    expect(SUPPORTED_SLA_METRICS).toContain('p99_latency_ms');
  });

  it('includes accuracy_pct', () => {
    expect(SUPPORTED_SLA_METRICS).toContain('accuracy_pct');
  });

  it('includes throughput_rpm', () => {
    expect(SUPPORTED_SLA_METRICS).toContain('throughput_rpm');
  });

  it('includes error_rate_pct', () => {
    expect(SUPPORTED_SLA_METRICS).toContain('error_rate_pct');
  });

  it('includes time_to_first_byte_ms', () => {
    expect(SUPPORTED_SLA_METRICS).toContain('time_to_first_byte_ms');
  });

  it('includes custom', () => {
    expect(SUPPORTED_SLA_METRICS).toContain('custom');
  });
});

describe('NEGOTIATION_STATES', () => {
  it('contains all 11 states', () => {
    expect(NEGOTIATION_STATES).toHaveLength(11);
  });

  it('includes all states in lifecycle order', () => {
    expect(NEGOTIATION_STATES).toEqual([
      'IDLE',
      'RFQ_SENT',
      'QUOTES_RECEIVED',
      'COUNTERING',
      'ACCEPTED',
      'ESCROWED',
      'ACTIVE',
      'COMPLETED',
      'REJECTED',
      'DISPUTED',
      'RESOLVED',
    ]);
  });

  it('has no duplicate states', () => {
    const unique = new Set(NEGOTIATION_STATES);
    expect(unique.size).toBe(NEGOTIATION_STATES.length);
  });
});
