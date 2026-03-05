import { describe, it, expect } from 'vitest';
import {
  RFQParamsSchema,
  QuoteParamsSchema,
  CounterParamsSchema,
  AcceptParamsSchema,
  RejectParamsSchema,
  DisputeParamsSchema,
  NegotiationStateSchema,
  AgentIdentitySchema,
  ServiceRequirementSchema,
  SLAMetricSchema,
  SLARequirementSchema,
  PricingOfferSchema,
  EscrowRequirementSchema,
  BudgetConstraintSchema,
  FinalTermsSchema,
  VolumeDiscountSchema,
  ViolationEvidenceSchema,
  LockstepSpecSchema,
  sha256HexString,
  base64Signature,
} from '../schemas.js';

// --- Helpers ---

const UUID = '550e8400-e29b-41d4-a716-446655440000';
const UUID2 = '6ba7b810-9dad-4d1d-80b4-00c04fd430c8';
const UUID3 = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

/** A valid-format base64 Ed25519 signature (64 zero-bytes). Not cryptographically meaningful. */
const FAKE_SIG = Buffer.alloc(64).toString('base64');

/** A valid-format SHA-256 hex hash (64 hex chars). Not a real hash. */
const FAKE_HASH = '0'.repeat(64);

function futureISO(ms = 300_000): string {
  return new Date(Date.now() + ms).toISOString();
}

function pastISO(): string {
  return new Date(Date.now() - 60_000).toISOString();
}

function validAgent() {
  return { agent_id: 'did:key:z6MkTest123456', endpoint: 'https://example.com' };
}

function validBudget() {
  return { max_price_per_unit: '0.10', currency: 'USDC', unit: 'request' };
}

function validPricing() {
  return { price_per_unit: '0.05', currency: 'USDC', unit: 'request', pricing_model: 'fixed' as const };
}

function validSLA() {
  return { metrics: [{ name: 'uptime_pct' as const, target: 99.9, comparison: 'gte' as const }] };
}

function validFinalTerms() {
  return { price_per_unit: '0.05', currency: 'USDC', unit: 'request' };
}

function validRFQ() {
  return {
    rfq_id: UUID,
    buyer: validAgent(),
    service: { category: 'inference' },
    budget: validBudget(),
    negotiation_style: 'rfq' as const,
    expires_at: futureISO(),
    signature: FAKE_SIG,
  };
}

function validQuote() {
  return {
    quote_id: UUID2,
    rfq_id: UUID,
    seller: validAgent(),
    pricing: validPricing(),
    expires_at: futureISO(),
    signature: FAKE_SIG,
  };
}

function validCounter() {
  return {
    counter_id: UUID3,
    rfq_id: UUID,
    in_response_to: UUID2,
    round: 1,
    from: { agent_id: 'did:key:z6MkBuyer', role: 'buyer' as const },
    modifications: { price_per_unit: '0.03' },
    expires_at: futureISO(),
    signature: FAKE_SIG,
  };
}

function validAccept() {
  return {
    agreement_id: UUID,
    rfq_id: UUID2,
    accepting_message_id: UUID3,
    final_terms: validFinalTerms(),
    agreement_hash: FAKE_HASH,
    buyer_signature: FAKE_SIG,
    seller_signature: FAKE_SIG,
  };
}

function validReject() {
  return {
    rfq_id: UUID,
    rejecting_message_id: UUID2,
    reason: 'Too expensive',
    from: { agent_id: 'did:key:z6MkBuyer' },
    signature: FAKE_SIG,
  };
}

function validDispute() {
  return {
    dispute_id: UUID,
    agreement_id: UUID2,
    filed_by: { agent_id: 'did:key:z6MkBuyer', role: 'buyer' as const },
    violation: {
      sla_metric: 'uptime_pct',
      agreed_value: 99.9,
      observed_value: 95.0,
      measurement_window: '24h',
      evidence_hash: 'a'.repeat(64),
    },
    requested_remedy: 'escrow_release',
    escrow_action: 'freeze',
    signature: FAKE_SIG,
  };
}

// --- AgentIdentity ---

describe('AgentIdentitySchema', () => {
  it('accepts valid agent identity', () => {
    expect(AgentIdentitySchema.safeParse(validAgent()).success).toBe(true);
  });

  it('accepts agent with optional fields', () => {
    const result = AgentIdentitySchema.safeParse({
      ...validAgent(),
      reputation_score: 0.95,
      completed_jobs: 100,
    });
    expect(result.success).toBe(true);
  });

  it('rejects agent_id without did:key:z6Mk prefix', () => {
    const result = AgentIdentitySchema.safeParse({
      agent_id: 'invalid-id',
      endpoint: 'https://example.com',
    });
    expect(result.success).toBe(false);
  });

  it('rejects agent_id with did:key: but non-Ed25519 multicodec prefix', () => {
    const result = AgentIdentitySchema.safeParse({
      agent_id: 'did:key:z6LsTest123',
      endpoint: 'https://example.com',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid endpoint URL', () => {
    const result = AgentIdentitySchema.safeParse({
      agent_id: 'did:key:z6MkTest',
      endpoint: 'not-a-url',
    });
    expect(result.success).toBe(false);
  });

  it('rejects reputation_score above 1', () => {
    const result = AgentIdentitySchema.safeParse({
      ...validAgent(),
      reputation_score: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative reputation_score', () => {
    const result = AgentIdentitySchema.safeParse({
      ...validAgent(),
      reputation_score: -0.1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative completed_jobs', () => {
    const result = AgentIdentitySchema.safeParse({
      ...validAgent(),
      completed_jobs: -5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer completed_jobs', () => {
    const result = AgentIdentitySchema.safeParse({
      ...validAgent(),
      completed_jobs: 3.5,
    });
    expect(result.success).toBe(false);
  });
});

// --- BudgetConstraintSchema ---

describe('BudgetConstraintSchema', () => {
  it('accepts valid budget', () => {
    expect(BudgetConstraintSchema.safeParse(validBudget()).success).toBe(true);
  });

  it('rejects non-numeric price string', () => {
    const result = BudgetConstraintSchema.safeParse({
      ...validBudget(),
      max_price_per_unit: 'not-a-number',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty currency', () => {
    const result = BudgetConstraintSchema.safeParse({
      ...validBudget(),
      currency: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-numeric total_budget', () => {
    const result = BudgetConstraintSchema.safeParse({
      ...validBudget(),
      total_budget: 'abc',
    });
    expect(result.success).toBe(false);
  });
});

// --- SLAMetricSchema ---

describe('SLAMetricSchema', () => {
  it('accepts valid metric', () => {
    expect(SLAMetricSchema.safeParse({
      name: 'p99_latency_ms',
      target: 500,
      comparison: 'lte',
    }).success).toBe(true);
  });

  it('accepts metric with all optional fields', () => {
    expect(SLAMetricSchema.safeParse({
      name: 'uptime_pct',
      target: 99.9,
      comparison: 'gte',
      measurement_method: 'rolling_average',
      measurement_window: '24h',
      penalty_per_violation: { amount: '10', currency: 'USDC' },
      custom_name: 'my_metric',
    }).success).toBe(true);
  });

  it('rejects invalid metric name', () => {
    expect(SLAMetricSchema.safeParse({
      name: 'invalid_metric',
      target: 99,
      comparison: 'gte',
    }).success).toBe(false);
  });

  it('rejects invalid comparison operator', () => {
    expect(SLAMetricSchema.safeParse({
      name: 'uptime_pct',
      target: 99,
      comparison: 'invalid',
    }).success).toBe(false);
  });

  it('rejects invalid measurement_method', () => {
    expect(SLAMetricSchema.safeParse({
      name: 'uptime_pct',
      target: 99,
      comparison: 'gte',
      measurement_method: 'guess',
    }).success).toBe(false);
  });

  it('rejects non-numeric penalty amount', () => {
    expect(SLAMetricSchema.safeParse({
      name: 'uptime_pct',
      target: 99,
      comparison: 'gte',
      penalty_per_violation: { amount: 'free', currency: 'USDC' },
    }).success).toBe(false);
  });

  it('accepts all valid metric names', () => {
    const names = [
      'uptime_pct', 'p50_latency_ms', 'p99_latency_ms', 'accuracy_pct',
      'throughput_rpm', 'error_rate_pct', 'time_to_first_byte_ms', 'custom',
    ];
    for (const name of names) {
      const data: Record<string, unknown> = { name, target: 99, comparison: 'gte' };
      if (name === 'custom') data.custom_name = 'my_metric';
      expect(SLAMetricSchema.safeParse(data).success).toBe(true);
    }
  });
});

// --- PricingOfferSchema ---

describe('PricingOfferSchema', () => {
  it('accepts valid pricing', () => {
    expect(PricingOfferSchema.safeParse(validPricing()).success).toBe(true);
  });

  it('accepts pricing with volume discounts', () => {
    expect(PricingOfferSchema.safeParse({
      ...validPricing(),
      volume_discounts: [{ min_units: 1000, price_per_unit: '0.03' }],
    }).success).toBe(true);
  });

  it('rejects invalid pricing model', () => {
    expect(PricingOfferSchema.safeParse({
      ...validPricing(),
      pricing_model: 'invalid',
    }).success).toBe(false);
  });

  it('rejects non-numeric price_per_unit', () => {
    expect(PricingOfferSchema.safeParse({
      ...validPricing(),
      price_per_unit: 'expensive',
    }).success).toBe(false);
  });

  it('rejects volume discount with non-positive min_units', () => {
    expect(PricingOfferSchema.safeParse({
      ...validPricing(),
      volume_discounts: [{ min_units: 0, price_per_unit: '0.03' }],
    }).success).toBe(false);
  });
});

// --- EscrowRequirementSchema ---

describe('EscrowRequirementSchema', () => {
  it('accepts valid escrow requirement', () => {
    expect(EscrowRequirementSchema.safeParse({
      type: 'solana_pda',
      deposit_amount: '100',
      release_condition: 'sla_met',
    }).success).toBe(true);
  });

  it('rejects invalid escrow type', () => {
    expect(EscrowRequirementSchema.safeParse({
      type: 'ethereum',
      deposit_amount: '100',
      release_condition: 'sla_met',
    }).success).toBe(false);
  });

  it('rejects non-numeric deposit_amount', () => {
    expect(EscrowRequirementSchema.safeParse({
      type: 'solana_pda',
      deposit_amount: 'lots',
      release_condition: 'sla_met',
    }).success).toBe(false);
  });
});

// --- LockstepSpecSchema ---

describe('LockstepSpecSchema', () => {
  it('accepts valid lockstep spec', () => {
    expect(LockstepSpecSchema.safeParse({ enabled: true }).success).toBe(true);
  });

  it('accepts lockstep with verification endpoint', () => {
    expect(LockstepSpecSchema.safeParse({
      enabled: true,
      verification_endpoint: 'https://lockstep.example.com/verify',
      spec_hash: 'deadbeef',
    }).success).toBe(true);
  });

  it('rejects invalid verification_endpoint URL', () => {
    expect(LockstepSpecSchema.safeParse({
      enabled: true,
      verification_endpoint: 'not-a-url',
    }).success).toBe(false);
  });
});

// --- RFQParamsSchema ---

describe('RFQParamsSchema', () => {
  it('accepts valid RFQ', () => {
    expect(RFQParamsSchema.safeParse(validRFQ()).success).toBe(true);
  });

  it('accepts RFQ with all optional fields', () => {
    expect(RFQParamsSchema.safeParse({
      ...validRFQ(),
      sla_requirements: validSLA(),
      max_rounds: 5,
      accepted_payments: [{ network: 'solana', token: 'USDC' }],
    }).success).toBe(true);
  });

  it('rejects RFQ with non-UUID rfq_id', () => {
    const result = RFQParamsSchema.safeParse({ ...validRFQ(), rfq_id: 'rfq-001' });
    expect(result.success).toBe(false);
  });

  it('rejects RFQ with empty rfq_id', () => {
    expect(RFQParamsSchema.safeParse({ ...validRFQ(), rfq_id: '' }).success).toBe(false);
  });

  it('rejects RFQ with expired date', () => {
    expect(RFQParamsSchema.safeParse({ ...validRFQ(), expires_at: pastISO() }).success).toBe(false);
  });

  it('rejects RFQ with invalid date format', () => {
    expect(RFQParamsSchema.safeParse({ ...validRFQ(), expires_at: 'not-a-date' }).success).toBe(false);
  });

  it('rejects RFQ with invalid negotiation_style', () => {
    expect(RFQParamsSchema.safeParse({ ...validRFQ(), negotiation_style: 'barter' }).success).toBe(false);
  });

  it('rejects RFQ missing required fields', () => {
    expect(RFQParamsSchema.safeParse({ rfq_id: UUID }).success).toBe(false);
  });

  it('rejects RFQ with negative max_rounds', () => {
    expect(RFQParamsSchema.safeParse({ ...validRFQ(), max_rounds: -1 }).success).toBe(false);
  });
});

// --- QuoteParamsSchema ---

describe('QuoteParamsSchema', () => {
  it('accepts valid quote', () => {
    expect(QuoteParamsSchema.safeParse(validQuote()).success).toBe(true);
  });

  it('accepts quote with optional fields', () => {
    expect(QuoteParamsSchema.safeParse({
      ...validQuote(),
      sla_offered: validSLA(),
      execution: { estimated_duration: '5m' },
      escrow_requirement: { type: 'solana_pda', deposit_amount: '50', release_condition: 'sla_met' },
    }).success).toBe(true);
  });

  it('rejects quote with empty signature', () => {
    expect(QuoteParamsSchema.safeParse({ ...validQuote(), signature: '' }).success).toBe(false);
  });

  it('rejects quote with non-UUID quote_id', () => {
    expect(QuoteParamsSchema.safeParse({ ...validQuote(), quote_id: 'q-1' }).success).toBe(false);
  });

  it('rejects quote with expired date', () => {
    expect(QuoteParamsSchema.safeParse({ ...validQuote(), expires_at: pastISO() }).success).toBe(false);
  });
});

// --- CounterParamsSchema ---

describe('CounterParamsSchema', () => {
  it('accepts valid counter', () => {
    expect(CounterParamsSchema.safeParse(validCounter()).success).toBe(true);
  });

  it('rejects counter with round 0', () => {
    expect(CounterParamsSchema.safeParse({ ...validCounter(), round: 0 }).success).toBe(false);
  });

  it('rejects counter with negative round', () => {
    expect(CounterParamsSchema.safeParse({ ...validCounter(), round: -2 }).success).toBe(false);
  });

  it('rejects counter with invalid role', () => {
    expect(CounterParamsSchema.safeParse({
      ...validCounter(),
      from: { agent_id: 'did:key:z6MkBuyer', role: 'observer' },
    }).success).toBe(false);
  });

  it('rejects counter with non-UUID counter_id', () => {
    expect(CounterParamsSchema.safeParse({ ...validCounter(), counter_id: 'c1' }).success).toBe(false);
  });
});

// --- AcceptParamsSchema ---

describe('AcceptParamsSchema', () => {
  it('accepts valid accept', () => {
    expect(AcceptParamsSchema.safeParse(validAccept()).success).toBe(true);
  });

  it('accepts accept with escrow in final_terms', () => {
    expect(AcceptParamsSchema.safeParse({
      ...validAccept(),
      final_terms: {
        ...validFinalTerms(),
        escrow: { network: 'solana', deposit_amount: '100', release_condition: 'sla_met' },
      },
    }).success).toBe(true);
  });

  it('accepts accept with lockstep_spec', () => {
    expect(AcceptParamsSchema.safeParse({
      ...validAccept(),
      lockstep_spec: { enabled: true, spec_hash: 'abc' },
    }).success).toBe(true);
  });

  it('rejects accept with empty agreement_hash', () => {
    expect(AcceptParamsSchema.safeParse({ ...validAccept(), agreement_hash: '' }).success).toBe(false);
  });

  it('rejects accept with non-UUID agreement_id', () => {
    expect(AcceptParamsSchema.safeParse({ ...validAccept(), agreement_id: 'agr-1' }).success).toBe(false);
  });

  it('rejects accept with empty buyer_signature', () => {
    expect(AcceptParamsSchema.safeParse({ ...validAccept(), buyer_signature: '' }).success).toBe(false);
  });
});

// --- RejectParamsSchema ---

describe('RejectParamsSchema', () => {
  it('accepts valid reject', () => {
    expect(RejectParamsSchema.safeParse({
      rfq_id: UUID,
      rejecting_message_id: UUID2,
      reason: 'Too expensive',
      from: { agent_id: 'did:key:z6MkBuyer' },
      signature: FAKE_SIG,
    }).success).toBe(true);
  });

  it('rejects reject with empty reason', () => {
    expect(RejectParamsSchema.safeParse({
      rfq_id: UUID,
      rejecting_message_id: UUID2,
      reason: '',
      from: { agent_id: 'did:key:z6MkBuyer' },
      signature: FAKE_SIG,
    }).success).toBe(false);
  });

  it('rejects reject with invalid agent_id', () => {
    expect(RejectParamsSchema.safeParse({
      rfq_id: UUID,
      rejecting_message_id: UUID2,
      reason: 'No thanks',
      from: { agent_id: 'not-a-did' },
      signature: FAKE_SIG,
    }).success).toBe(false);
  });

  it('rejects reject with non-UUID rfq_id', () => {
    expect(RejectParamsSchema.safeParse({
      rfq_id: 'rfq-bad',
      rejecting_message_id: UUID2,
      reason: 'No thanks',
      from: { agent_id: 'did:key:z6MkBuyer' },
      signature: FAKE_SIG,
    }).success).toBe(false);
  });

  it('rejects reject with empty signature', () => {
    expect(RejectParamsSchema.safeParse({
      rfq_id: UUID,
      rejecting_message_id: UUID2,
      reason: 'No thanks',
      from: { agent_id: 'did:key:z6MkBuyer' },
      signature: '',
    }).success).toBe(false);
  });

  it('rejects reject without signature', () => {
    expect(RejectParamsSchema.safeParse({
      rfq_id: UUID,
      rejecting_message_id: UUID2,
      reason: 'No thanks',
      from: { agent_id: 'did:key:z6MkBuyer' },
    }).success).toBe(false);
  });
});

// --- DisputeParamsSchema ---

describe('DisputeParamsSchema', () => {
  it('accepts valid dispute', () => {
    expect(DisputeParamsSchema.safeParse(validDispute()).success).toBe(true);
  });

  it('accepts dispute with lockstep report', () => {
    expect(DisputeParamsSchema.safeParse({
      ...validDispute(),
      lockstep_report: {
        verification_id: 'v-001',
        result: 'FAIL',
        deviations: ['uptime below threshold'],
      },
    }).success).toBe(true);
  });

  it('rejects dispute with invalid lockstep result', () => {
    expect(DisputeParamsSchema.safeParse({
      ...validDispute(),
      lockstep_report: {
        verification_id: 'v-001',
        result: 'MAYBE',
        deviations: [],
      },
    }).success).toBe(false);
  });

  it('rejects dispute with empty signature', () => {
    expect(DisputeParamsSchema.safeParse({ ...validDispute(), signature: '' }).success).toBe(false);
  });

  it('rejects dispute with missing violation fields', () => {
    expect(DisputeParamsSchema.safeParse({
      ...validDispute(),
      violation: { sla_metric: 'uptime_pct' },
    }).success).toBe(false);
  });
});

// --- FinalTermsSchema ---

describe('FinalTermsSchema', () => {
  it('accepts valid final terms', () => {
    expect(FinalTermsSchema.safeParse(validFinalTerms()).success).toBe(true);
  });

  it('rejects non-numeric price_per_unit', () => {
    expect(FinalTermsSchema.safeParse({
      ...validFinalTerms(),
      price_per_unit: 'free',
    }).success).toBe(false);
  });
});

// --- ViolationEvidenceSchema ---

describe('ViolationEvidenceSchema', () => {
  it('accepts valid violation evidence', () => {
    expect(ViolationEvidenceSchema.safeParse({
      sla_metric: 'uptime_pct',
      agreed_value: 99.9,
      observed_value: 95.0,
      measurement_window: '24h',
      evidence_hash: 'b'.repeat(64),
    }).success).toBe(true);
  });

  it('rejects evidence with empty evidence_hash', () => {
    expect(ViolationEvidenceSchema.safeParse({
      sla_metric: 'uptime_pct',
      agreed_value: 99.9,
      observed_value: 95.0,
      measurement_window: '24h',
      evidence_hash: '',
    }).success).toBe(false);
  });

  it('accepts evidence with optional evidence_url', () => {
    expect(ViolationEvidenceSchema.safeParse({
      sla_metric: 'uptime_pct',
      agreed_value: 99.9,
      observed_value: 95.0,
      measurement_window: '24h',
      evidence_hash: 'b'.repeat(64),
      evidence_url: 'https://evidence.example.com/report',
    }).success).toBe(true);
  });

  it('rejects evidence with invalid evidence_url', () => {
    expect(ViolationEvidenceSchema.safeParse({
      sla_metric: 'uptime_pct',
      agreed_value: 99.9,
      observed_value: 95.0,
      measurement_window: '24h',
      evidence_hash: 'b'.repeat(64),
      evidence_url: 'not-a-url',
    }).success).toBe(false);
  });
});

// --- sha256HexString ---

describe('sha256HexString', () => {
  it('accepts valid 64-char lowercase hex string', () => {
    expect(sha256HexString.safeParse('a'.repeat(64)).success).toBe(true);
    expect(sha256HexString.safeParse(FAKE_HASH).success).toBe(true);
  });

  it('accepts uppercase hex characters (case-insensitive)', () => {
    expect(sha256HexString.safeParse('A'.repeat(64)).success).toBe(true);
    expect(sha256HexString.safeParse('0'.repeat(63) + 'F').success).toBe(true);
  });

  it('rejects string that is too short (63 chars)', () => {
    expect(sha256HexString.safeParse('0'.repeat(63)).success).toBe(false);
  });

  it('rejects string that is too long (65 chars)', () => {
    expect(sha256HexString.safeParse('0'.repeat(65)).success).toBe(false);
  });

  it('rejects string with non-hex characters', () => {
    expect(sha256HexString.safeParse('g' + '0'.repeat(63)).success).toBe(false);
    expect(sha256HexString.safeParse('0'.repeat(63) + 'z').success).toBe(false);
  });

  it('rejects empty string', () => {
    expect(sha256HexString.safeParse('').success).toBe(false);
  });
});

// --- base64Signature ---

describe('base64Signature', () => {
  it('accepts valid base64-encoded 64-byte signature', () => {
    expect(base64Signature.safeParse(FAKE_SIG).success).toBe(true);
    expect(base64Signature.safeParse(Buffer.alloc(64, 0xff).toString('base64')).success).toBe(true);
  });

  it('rejects empty string', () => {
    expect(base64Signature.safeParse('').success).toBe(false);
  });

  it('rejects base64 of wrong length (32 bytes)', () => {
    const short = Buffer.alloc(32).toString('base64');
    expect(base64Signature.safeParse(short).success).toBe(false);
  });

  it('rejects non-base64 string', () => {
    expect(base64Signature.safeParse('!!!not-base64!!!').success).toBe(false);
  });

  it('rejects base64 of 128 bytes (too long)', () => {
    const long = Buffer.alloc(128).toString('base64');
    expect(base64Signature.safeParse(long).success).toBe(false);
  });
});

// --- Additional QuoteParamsSchema edge cases ---

describe('QuoteParamsSchema (strict signature validation)', () => {
  it('rejects quote with base64 signature that decodes to wrong length', () => {
    const wrongLengthSig = Buffer.alloc(32).toString('base64');
    expect(QuoteParamsSchema.safeParse({ ...validQuote(), signature: wrongLengthSig }).success).toBe(false);
  });
});

// --- Additional AcceptParamsSchema edge cases ---

describe('AcceptParamsSchema (strict hash validation)', () => {
  it('accepts accept with uppercase hex agreement_hash (case-insensitive)', () => {
    expect(AcceptParamsSchema.safeParse({ ...validAccept(), agreement_hash: 'A'.repeat(64) }).success).toBe(true);
  });

  it('rejects accept with too-short agreement_hash', () => {
    expect(AcceptParamsSchema.safeParse({ ...validAccept(), agreement_hash: '0'.repeat(63) }).success).toBe(false);
  });
});

// --- NegotiationStateSchema ---

describe('NegotiationStateSchema', () => {
  it('accepts all valid states', () => {
    const states = [
      'IDLE', 'RFQ_SENT', 'QUOTES_RECEIVED', 'COUNTERING',
      'ACCEPTED', 'ESCROWED', 'ACTIVE', 'COMPLETED',
      'REJECTED', 'DISPUTED', 'RESOLVED',
    ];
    for (const state of states) {
      expect(NegotiationStateSchema.safeParse(state).success).toBe(true);
    }
  });

  it('rejects invalid state', () => {
    expect(NegotiationStateSchema.safeParse('PENDING').success).toBe(false);
    expect(NegotiationStateSchema.safeParse('').success).toBe(false);
  });
});

// --- SLARequirementSchema ---

describe('SLARequirementSchema', () => {
  it('rejects empty metrics array', () => {
    expect(SLARequirementSchema.safeParse({ metrics: [] }).success).toBe(false);
  });

  it('accepts SLA with dispute resolution', () => {
    expect(SLARequirementSchema.safeParse({
      ...validSLA(),
      dispute_resolution: {
        method: 'lockstep_verification',
        timeout_hours: 48,
      },
    }).success).toBe(true);
  });

  it('rejects invalid dispute resolution method', () => {
    expect(SLARequirementSchema.safeParse({
      ...validSLA(),
      dispute_resolution: { method: 'fist_fight' },
    }).success).toBe(false);
  });
});

// ============================================================
// Additional security-focused edge case tests
// ============================================================

// --- 1. Nested validation tests ---

describe('Nested validation – invalid inner objects', () => {
  it('rejects RFQ with invalid SLA metric name inside sla_requirements', () => {
    const result = RFQParamsSchema.safeParse({
      ...validRFQ(),
      sla_requirements: {
        metrics: [{ name: 'bogus_metric', target: 99, comparison: 'gte' }],
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects Quote with invalid pricing_model inside pricing', () => {
    const result = QuoteParamsSchema.safeParse({
      ...validQuote(),
      pricing: { ...validPricing(), pricing_model: 'barter' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects Accept with non-numeric price_per_unit inside final_terms', () => {
    const result = AcceptParamsSchema.safeParse({
      ...validAccept(),
      final_terms: { ...validFinalTerms(), price_per_unit: 'free-lunch' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects Counter with invalid role inside from', () => {
    const result = CounterParamsSchema.safeParse({
      ...validCounter(),
      from: { agent_id: 'did:key:z6MkBuyer', role: 'middleman' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects Quote with non-numeric escrow deposit inside escrow_requirement', () => {
    const result = QuoteParamsSchema.safeParse({
      ...validQuote(),
      escrow_requirement: { type: 'solana_pda', deposit_amount: 'millions', release_condition: 'sla_met' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects Accept with empty release_condition inside final_terms.escrow', () => {
    const result = AcceptParamsSchema.safeParse({
      ...validAccept(),
      final_terms: {
        ...validFinalTerms(),
        escrow: { network: 'solana', deposit_amount: '100', release_condition: '' },
      },
    });
    expect(result.success).toBe(false);
  });
});

// --- 2. Boundary value tests ---

describe('Boundary value tests', () => {
  it('accepts SLA metric target of 0', () => {
    const result = SLAMetricSchema.safeParse({
      name: 'error_rate_pct',
      target: 0,
      comparison: 'lte',
    });
    expect(result.success).toBe(true);
  });

  it('accepts SLA metric target of negative number (valid for some metrics)', () => {
    const result = SLAMetricSchema.safeParse({
      name: 'custom',
      custom_name: 'temperature_delta',
      target: -10,
      comparison: 'gte',
    });
    expect(result.success).toBe(true);
  });

  it('rejects VolumeDiscount with min_units of 0 (must be positive)', () => {
    const result = VolumeDiscountSchema.safeParse({
      min_units: 0,
      price_per_unit: '0.01',
    });
    expect(result.success).toBe(false);
  });

  it('rejects VolumeDiscount with negative min_units', () => {
    const result = VolumeDiscountSchema.safeParse({
      min_units: -5,
      price_per_unit: '0.01',
    });
    expect(result.success).toBe(false);
  });

  it('rejects VolumeDiscount with fractional min_units', () => {
    const result = VolumeDiscountSchema.safeParse({
      min_units: 1.5,
      price_per_unit: '0.01',
    });
    expect(result.success).toBe(false);
  });

  it('accepts Budget with max_price_per_unit of "0"', () => {
    const result = BudgetConstraintSchema.safeParse({
      ...validBudget(),
      max_price_per_unit: '0',
    });
    expect(result.success).toBe(true);
  });

  it('accepts Budget with max_price_per_unit of "-1" (valid numeric string)', () => {
    const result = BudgetConstraintSchema.safeParse({
      ...validBudget(),
      max_price_per_unit: '-1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects Budget with max_price_per_unit of "abc"', () => {
    const result = BudgetConstraintSchema.safeParse({
      ...validBudget(),
      max_price_per_unit: 'abc',
    });
    expect(result.success).toBe(false);
  });

  it('rejects Budget with max_price_per_unit of empty string', () => {
    const result = BudgetConstraintSchema.safeParse({
      ...validBudget(),
      max_price_per_unit: '',
    });
    expect(result.success).toBe(false);
  });

  it('accepts Budget with max_price_per_unit of "1e18" (scientific notation)', () => {
    const result = BudgetConstraintSchema.safeParse({
      ...validBudget(),
      max_price_per_unit: '1e18',
    });
    expect(result.success).toBe(true);
  });

  it('rejects Budget with max_price_per_unit of "Infinity"', () => {
    const result = BudgetConstraintSchema.safeParse({
      ...validBudget(),
      max_price_per_unit: 'Infinity',
    });
    expect(result.success).toBe(false);
  });

  it('rejects Budget with max_price_per_unit of "NaN"', () => {
    const result = BudgetConstraintSchema.safeParse({
      ...validBudget(),
      max_price_per_unit: 'NaN',
    });
    expect(result.success).toBe(false);
  });

  it('accepts RFQ with max_rounds of 1 (minimum positive)', () => {
    const result = RFQParamsSchema.safeParse({
      ...validRFQ(),
      max_rounds: 1,
    });
    expect(result.success).toBe(true);
  });

  it('rejects RFQ with max_rounds of 0', () => {
    const result = RFQParamsSchema.safeParse({
      ...validRFQ(),
      max_rounds: 0,
    });
    expect(result.success).toBe(false);
  });

  it('rejects Counter with round of fractional number', () => {
    const result = CounterParamsSchema.safeParse({
      ...validCounter(),
      round: 1.5,
    });
    expect(result.success).toBe(false);
  });
});

// --- 3. Cross-field validation ---

describe('Cross-field validation', () => {
  it('rejects custom SLA metric without custom_name', () => {
    const result = SLAMetricSchema.safeParse({
      name: 'custom',
      target: 50,
      comparison: 'gte',
      // custom_name intentionally omitted
    });
    expect(result.success).toBe(false);
  });

  it('accepts custom SLA metric with custom_name provided', () => {
    const result = SLAMetricSchema.safeParse({
      name: 'custom',
      target: 50,
      comparison: 'gte',
      custom_name: 'my_special_metric',
    });
    expect(result.success).toBe(true);
  });

  it('rejects Escrow with empty release_condition', () => {
    const result = EscrowRequirementSchema.safeParse({
      type: 'solana_pda',
      deposit_amount: '100',
      release_condition: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects FinalTerms with empty currency', () => {
    const result = FinalTermsSchema.safeParse({
      ...validFinalTerms(),
      currency: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects FinalTerms with empty unit', () => {
    const result = FinalTermsSchema.safeParse({
      ...validFinalTerms(),
      unit: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects Accept where final_terms.escrow has empty network', () => {
    const result = AcceptParamsSchema.safeParse({
      ...validAccept(),
      final_terms: {
        ...validFinalTerms(),
        escrow: { network: '', deposit_amount: '50', release_condition: 'sla_met' },
      },
    });
    expect(result.success).toBe(false);
  });
});

// --- 4. UUID format edge cases ---

describe('UUID format validation edge cases', () => {
  it('rejects UUID with missing section', () => {
    const result = RFQParamsSchema.safeParse({
      ...validRFQ(),
      rfq_id: '550e8400-e29b-41d4-a716',
    });
    expect(result.success).toBe(false);
  });

  it('rejects UUID with extra section', () => {
    const result = RFQParamsSchema.safeParse({
      ...validRFQ(),
      rfq_id: '550e8400-e29b-41d4-a716-446655440000-extra',
    });
    expect(result.success).toBe(false);
  });

  it('rejects UUID with braces', () => {
    const result = RFQParamsSchema.safeParse({
      ...validRFQ(),
      rfq_id: '{550e8400-e29b-41d4-a716-446655440000}',
    });
    expect(result.success).toBe(false);
  });

  it('rejects UUID with spaces', () => {
    const result = RFQParamsSchema.safeParse({
      ...validRFQ(),
      rfq_id: '550e8400 e29b 41d4 a716 446655440000',
    });
    expect(result.success).toBe(false);
  });

  it('rejects UUID with non-hex characters', () => {
    const result = RFQParamsSchema.safeParse({
      ...validRFQ(),
      rfq_id: 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz',
    });
    expect(result.success).toBe(false);
  });

  it('rejects UUID v1 (version digit is not 4)', () => {
    const result = RFQParamsSchema.safeParse({
      ...validRFQ(),
      rfq_id: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    });
    expect(result.success).toBe(false);
  });

  it('rejects UUID with invalid variant digit', () => {
    const result = RFQParamsSchema.safeParse({
      ...validRFQ(),
      rfq_id: '550e8400-e29b-4e29-0716-446655440000',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty string as UUID', () => {
    const result = RFQParamsSchema.safeParse({
      ...validRFQ(),
      rfq_id: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects UUID without dashes (raw 32 hex chars)', () => {
    const result = RFQParamsSchema.safeParse({
      ...validRFQ(),
      rfq_id: '550e8400e29b41d4a716446655440000',
    });
    expect(result.success).toBe(false);
  });

  it('accepts uppercase UUID (regex is case-insensitive)', () => {
    const result = RFQParamsSchema.safeParse({
      ...validRFQ(),
      rfq_id: '550E8400-E29B-41D4-A716-446655440000',
    });
    expect(result.success).toBe(true);
  });
});

// --- 5. Expiration / datetime edge cases ---

describe('Expiration datetime validation', () => {
  it('rejects RFQ with past expiration', () => {
    const result = RFQParamsSchema.safeParse({
      ...validRFQ(),
      expires_at: pastISO(),
    });
    expect(result.success).toBe(false);
  });

  it('rejects RFQ with non-ISO date string', () => {
    const result = RFQParamsSchema.safeParse({
      ...validRFQ(),
      expires_at: 'March 4, 2030',
    });
    expect(result.success).toBe(false);
  });

  it('rejects RFQ with date-only string (no time component)', () => {
    const result = RFQParamsSchema.safeParse({
      ...validRFQ(),
      expires_at: '2030-12-31',
    });
    expect(result.success).toBe(false);
  });

  it('rejects RFQ with Unix timestamp number instead of string', () => {
    const result = RFQParamsSchema.safeParse({
      ...validRFQ(),
      expires_at: Date.now() + 300_000,
    });
    expect(result.success).toBe(false);
  });

  it('rejects Quote with past expiration', () => {
    const result = QuoteParamsSchema.safeParse({
      ...validQuote(),
      expires_at: pastISO(),
    });
    expect(result.success).toBe(false);
  });

  it('rejects Counter with past expiration', () => {
    const result = CounterParamsSchema.safeParse({
      ...validCounter(),
      expires_at: pastISO(),
    });
    expect(result.success).toBe(false);
  });

  it('accepts RFQ with far-future ISO 8601 datetime', () => {
    const result = RFQParamsSchema.safeParse({
      ...validRFQ(),
      expires_at: '2099-12-31T23:59:59.999Z',
    });
    expect(result.success).toBe(true);
  });
});

// --- 6. ServiceRequirementSchema edge cases ---

describe('ServiceRequirementSchema edge cases', () => {
  it('rejects empty category string', () => {
    const result = ServiceRequirementSchema.safeParse({
      category: '',
    });
    expect(result.success).toBe(false);
  });

  it('accepts category with only whitespace (min(1) checks length, not content)', () => {
    const result = ServiceRequirementSchema.safeParse({
      category: ' ',
    });
    expect(result.success).toBe(true);
  });

  it('accepts requirements with nested objects', () => {
    const result = ServiceRequirementSchema.safeParse({
      category: 'inference',
      requirements: {
        model: 'gpt-4',
        parameters: { temperature: 0.7, max_tokens: 1024 },
        nested: { deep: { value: true } },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts requirements with array values', () => {
    const result = ServiceRequirementSchema.safeParse({
      category: 'inference',
      requirements: {
        supported_formats: ['json', 'text', 'markdown'],
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts requirements as empty object', () => {
    const result = ServiceRequirementSchema.safeParse({
      category: 'inference',
      requirements: {},
    });
    expect(result.success).toBe(true);
  });

  it('rejects service with category as a number', () => {
    const result = ServiceRequirementSchema.safeParse({
      category: 123,
    });
    expect(result.success).toBe(false);
  });

  it('accepts service with optional description', () => {
    const result = ServiceRequirementSchema.safeParse({
      category: 'inference',
      description: 'LLM inference for production workloads',
    });
    expect(result.success).toBe(true);
  });
});

// --- RFQParamsSchema signature validation ---

describe('RFQParamsSchema signature validation', () => {
  it('rejects RFQ with empty signature', () => {
    expect(RFQParamsSchema.safeParse({ ...validRFQ(), signature: '' }).success).toBe(false);
  });

  it('rejects RFQ without signature field', () => {
    const rfq = validRFQ();
    delete (rfq as any).signature;
    expect(RFQParamsSchema.safeParse(rfq).success).toBe(false);
  });

  it('rejects RFQ with signature that decodes to wrong length (32 bytes)', () => {
    const wrongLengthSig = Buffer.alloc(32).toString('base64');
    expect(RFQParamsSchema.safeParse({ ...validRFQ(), signature: wrongLengthSig }).success).toBe(false);
  });
});

// --- Schema null rejection tests ---

describe('Schema null rejection tests', () => {
  it('RFQParamsSchema rejects null for required fields', () => {
    expect(RFQParamsSchema.safeParse({ ...validRFQ(), rfq_id: null }).success).toBe(false);
  });

  it('QuoteParamsSchema rejects null for required fields', () => {
    expect(QuoteParamsSchema.safeParse({ ...validQuote(), quote_id: null }).success).toBe(false);
  });

  it('CounterParamsSchema rejects null for required fields', () => {
    expect(CounterParamsSchema.safeParse({ ...validCounter(), counter_id: null }).success).toBe(false);
  });

  it('AcceptParamsSchema rejects null for required fields', () => {
    expect(AcceptParamsSchema.safeParse({ ...validAccept(), agreement_id: null }).success).toBe(false);
  });

  it('RejectParamsSchema rejects null rfq_id', () => {
    expect(RejectParamsSchema.safeParse({
      rfq_id: null,
      rejecting_message_id: UUID2,
      reason: 'No thanks',
      from: { agent_id: 'did:key:z6MkBuyer' },
      signature: FAKE_SIG,
    }).success).toBe(false);
  });

  it('DisputeParamsSchema rejects null dispute_id', () => {
    expect(DisputeParamsSchema.safeParse({ ...validDispute(), dispute_id: null }).success).toBe(false);
  });
});

// --- Schema empty string rejection for required string fields ---

describe('Schema empty string rejection for required string fields', () => {
  it('RFQParamsSchema rejects empty buyer.agent_id', () => {
    expect(RFQParamsSchema.safeParse({
      ...validRFQ(),
      buyer: { agent_id: '', endpoint: 'https://example.com' },
    }).success).toBe(false);
  });

  it('QuoteParamsSchema rejects empty seller.agent_id', () => {
    expect(QuoteParamsSchema.safeParse({
      ...validQuote(),
      seller: { agent_id: '', endpoint: 'https://example.com' },
    }).success).toBe(false);
  });

  it('CounterParamsSchema rejects empty from.agent_id', () => {
    expect(CounterParamsSchema.safeParse({
      ...validCounter(),
      from: { agent_id: '', role: 'buyer' as const },
    }).success).toBe(false);
  });

  it('DisputeParamsSchema rejects empty requested_remedy', () => {
    expect(DisputeParamsSchema.safeParse({
      ...validDispute(),
      requested_remedy: '',
    }).success).toBe(false);
  });

  it('DisputeParamsSchema rejects empty escrow_action', () => {
    expect(DisputeParamsSchema.safeParse({
      ...validDispute(),
      escrow_action: '',
    }).success).toBe(false);
  });
});

// --- Strict schema enforcement (no extra fields) ---

describe('Strict schema enforcement', () => {
  it('RFQParamsSchema rejects extra fields', () => {
    expect(RFQParamsSchema.safeParse({
      ...validRFQ(),
      extra_field: 'should not be here',
    }).success).toBe(false);
  });

  it('QuoteParamsSchema rejects extra fields', () => {
    expect(QuoteParamsSchema.safeParse({
      ...validQuote(),
      extra_field: 'should not be here',
    }).success).toBe(false);
  });

  it('CounterParamsSchema rejects extra fields', () => {
    expect(CounterParamsSchema.safeParse({
      ...validCounter(),
      extra_field: 'should not be here',
    }).success).toBe(false);
  });

  it('AcceptParamsSchema rejects extra fields', () => {
    expect(AcceptParamsSchema.safeParse({
      ...validAccept(),
      extra_field: 'should not be here',
    }).success).toBe(false);
  });

  it('RejectParamsSchema rejects extra fields', () => {
    expect(RejectParamsSchema.safeParse({
      ...validReject(),
      extra_field: 'should not be here',
    }).success).toBe(false);
  });

  it('DisputeParamsSchema rejects extra fields', () => {
    expect(DisputeParamsSchema.safeParse({
      ...validDispute(),
      extra_field: 'should not be here',
    }).success).toBe(false);
  });
});

// --- Evidence hash format validation ---

describe('Evidence hash validation', () => {
  it('rejects evidence_hash that is not 64-char hex', () => {
    expect(ViolationEvidenceSchema.safeParse({
      sla_metric: 'uptime_pct',
      agreed_value: 99.9,
      observed_value: 95.0,
      measurement_window: '24h',
      evidence_hash: 'abc123',
    }).success).toBe(false);
  });

  it('rejects evidence_hash with non-hex characters', () => {
    expect(ViolationEvidenceSchema.safeParse({
      sla_metric: 'uptime_pct',
      agreed_value: 99.9,
      observed_value: 95.0,
      measurement_window: '24h',
      evidence_hash: 'g'.repeat(64),
    }).success).toBe(false);
  });

  it('accepts valid 64-char hex evidence_hash', () => {
    expect(ViolationEvidenceSchema.safeParse({
      sla_metric: 'uptime_pct',
      agreed_value: 99.9,
      observed_value: 95.0,
      measurement_window: '24h',
      evidence_hash: 'a1b2c3d4e5f6'.padEnd(64, '0'),
    }).success).toBe(true);
  });
});

// --- custom_name cross-field validation ---

describe('custom_name cross-field validation', () => {
  it('rejects name=custom without custom_name', () => {
    expect(SLAMetricSchema.safeParse({
      name: 'custom',
      target: 50,
      comparison: 'gte',
    }).success).toBe(false);
  });

  it('rejects name=custom with empty custom_name', () => {
    expect(SLAMetricSchema.safeParse({
      name: 'custom',
      target: 50,
      comparison: 'gte',
      custom_name: '',
    }).success).toBe(false);
  });

  it('accepts name=custom with valid custom_name', () => {
    expect(SLAMetricSchema.safeParse({
      name: 'custom',
      target: 50,
      comparison: 'gte',
      custom_name: 'response_quality',
    }).success).toBe(true);
  });

  it('does not require custom_name for standard metric names', () => {
    expect(SLAMetricSchema.safeParse({
      name: 'uptime_pct',
      target: 99.9,
      comparison: 'gte',
    }).success).toBe(true);
  });
});
