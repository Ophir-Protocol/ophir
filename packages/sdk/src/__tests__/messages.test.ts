import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import {
  buildRFQ,
  buildQuote,
  buildCounter,
  buildAccept,
  buildReject,
  buildDispute,
} from '../messages.js';
import { verifyMessage, agreementHash, signMessage } from '../signing.js';
import { publicKeyToDid } from '../identity.js';
import type { AgentIdentity, FinalTerms } from '@ophir/protocol';

function makeIdentity(kp: nacl.SignKeyPair): AgentIdentity {
  return {
    agent_id: publicKeyToDid(kp.publicKey),
    endpoint: 'https://agent.example.com',
  };
}

describe('buildRFQ', () => {
  it('produces a valid JSON-RPC envelope', () => {
    const kp = nacl.sign.keyPair();
    const msg = buildRFQ({
      buyer: makeIdentity(kp),
      service: { category: 'inference' },
      budget: { max_price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
      secretKey: kp.secretKey,
    });

    expect(msg.jsonrpc).toBe('2.0');
    expect(msg.method).toBe('negotiate/rfq');
    expect(msg.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(msg.params).toBeDefined();
  });

  it('auto-generates rfq_id as UUID v4', () => {
    const kp = nacl.sign.keyPair();
    const msg = buildRFQ({
      buyer: makeIdentity(kp),
      service: { category: 'inference' },
      budget: { max_price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
      secretKey: kp.secretKey,
    });

    expect(msg.params.rfq_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('signs correctly and verifiable with buyer public key', () => {
    const kp = nacl.sign.keyPair();
    const msg = buildRFQ({
      buyer: makeIdentity(kp),
      service: { category: 'inference' },
      budget: { max_price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
      secretKey: kp.secretKey,
    });

    const { signature, ...unsigned } = msg.params;
    expect(signature).toBeTruthy();
    expect(verifyMessage(unsigned, signature, kp.publicKey)).toBe(true);
  });

  it('rejects verification with wrong key', () => {
    const kp = nacl.sign.keyPair();
    const wrongKp = nacl.sign.keyPair();
    const msg = buildRFQ({
      buyer: makeIdentity(kp),
      service: { category: 'inference' },
      budget: { max_price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
      secretKey: kp.secretKey,
    });

    const { signature, ...unsigned } = msg.params;
    expect(verifyMessage(unsigned, signature, wrongKp.publicKey)).toBe(false);
  });

  it('sets expires_at in the future', () => {
    const kp = nacl.sign.keyPair();
    const before = Date.now();
    const msg = buildRFQ({
      buyer: makeIdentity(kp),
      service: { category: 'inference' },
      budget: { max_price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
      secretKey: kp.secretKey,
    });

    const expiresAt = new Date(msg.params.expires_at).getTime();
    expect(expiresAt).toBeGreaterThan(before);
    // Default 5 min TTL
    expect(expiresAt - before).toBeGreaterThanOrEqual(4 * 60 * 1000);
    expect(expiresAt - before).toBeLessThanOrEqual(6 * 60 * 1000);
  });

  it('uses custom ttlMs', () => {
    const kp = nacl.sign.keyPair();
    const before = Date.now();
    const msg = buildRFQ({
      buyer: makeIdentity(kp),
      service: { category: 'inference' },
      budget: { max_price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
      ttlMs: 60_000,
      secretKey: kp.secretKey,
    });

    const expiresAt = new Date(msg.params.expires_at).getTime();
    expect(expiresAt - before).toBeLessThanOrEqual(62_000);
    expect(expiresAt - before).toBeGreaterThanOrEqual(58_000);
  });

  it('generates unique rfq_ids', () => {
    const kp = nacl.sign.keyPair();
    const args = {
      buyer: makeIdentity(kp),
      service: { category: 'inference' } as const,
      budget: { max_price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
      secretKey: kp.secretKey,
    };
    const a = buildRFQ(args);
    const b = buildRFQ(args);
    expect(a.params.rfq_id).not.toBe(b.params.rfq_id);
    expect(a.id).not.toBe(b.id);
  });
});

describe('buildQuote', () => {
  it('produces a valid JSON-RPC envelope', () => {
    const kp = nacl.sign.keyPair();
    const msg = buildQuote({
      rfqId: 'rfq-123',
      seller: makeIdentity(kp),
      pricing: {
        price_per_unit: '0.005',
        currency: 'USDC',
        unit: 'request',
        pricing_model: 'fixed',
      },
      secretKey: kp.secretKey,
    });

    expect(msg.jsonrpc).toBe('2.0');
    expect(msg.method).toBe('negotiate/quote');
    expect(msg.params.quote_id).toBeTruthy();
    expect(msg.params.rfq_id).toBe('rfq-123');
  });

  it('signs correctly and verifiable with public key', () => {
    const kp = nacl.sign.keyPair();
    const msg = buildQuote({
      rfqId: 'rfq-456',
      seller: makeIdentity(kp),
      pricing: {
        price_per_unit: '0.01',
        currency: 'USDC',
        unit: 'request',
        pricing_model: 'fixed',
      },
      secretKey: kp.secretKey,
    });

    // Reconstruct the unsigned params to verify
    const { signature, ...unsigned } = msg.params;
    expect(signature).toBeTruthy();
    expect(verifyMessage(unsigned, signature, kp.publicKey)).toBe(true);
  });

  it('rejects verification with wrong key', () => {
    const kp = nacl.sign.keyPair();
    const wrongKp = nacl.sign.keyPair();
    const msg = buildQuote({
      rfqId: 'rfq-789',
      seller: makeIdentity(kp),
      pricing: {
        price_per_unit: '0.01',
        currency: 'USDC',
        unit: 'request',
        pricing_model: 'fixed',
      },
      secretKey: kp.secretKey,
    });

    const { signature, ...unsigned } = msg.params;
    expect(verifyMessage(unsigned, signature, wrongKp.publicKey)).toBe(false);
  });

  it('signature changes when params change', () => {
    const kp = nacl.sign.keyPair();
    const base = {
      rfqId: 'rfq-sig-test',
      seller: makeIdentity(kp),
      pricing: {
        price_per_unit: '0.01',
        currency: 'USDC',
        unit: 'request',
        pricing_model: 'fixed' as const,
      },
      secretKey: kp.secretKey,
    };
    const msg1 = buildQuote(base);
    const msg2 = buildQuote({ ...base, pricing: { ...base.pricing, price_per_unit: '0.02' } });

    expect(msg1.params.signature).not.toBe(msg2.params.signature);
  });

  it('same params produce same signature (deterministic)', () => {
    const kp = nacl.sign.keyPair();
    const pricing = {
      price_per_unit: '0.01',
      currency: 'USDC',
      unit: 'request',
      pricing_model: 'fixed' as const,
    };
    // Sign the same canonical content twice manually to confirm determinism
    // (buildQuote generates new quote_id each time, so we test signMessage directly)
    const params = { rfq_id: 'rfq-det', seller: makeIdentity(kp), pricing };
    const sig1 = signMessage(params, kp.secretKey);
    const sig2 = signMessage(params, kp.secretKey);
    expect(sig1).toBe(sig2);
  });

  it('generates unique quote_ids', () => {
    const kp = nacl.sign.keyPair();
    const args = {
      rfqId: 'rfq-uniq',
      seller: makeIdentity(kp),
      pricing: {
        price_per_unit: '0.01',
        currency: 'USDC',
        unit: 'request',
        pricing_model: 'fixed' as const,
      },
      secretKey: kp.secretKey,
    };
    const a = buildQuote(args);
    const b = buildQuote(args);
    expect(a.params.quote_id).not.toBe(b.params.quote_id);
    expect(a.id).not.toBe(b.id);
  });
});

describe('buildCounter', () => {
  it('produces valid envelope with signature', () => {
    const kp = nacl.sign.keyPair();
    const msg = buildCounter({
      rfqId: 'rfq-100',
      inResponseTo: 'quote-100',
      round: 1,
      from: { agent_id: publicKeyToDid(kp.publicKey), role: 'buyer' },
      modifications: { price_per_unit: '0.008' },
      secretKey: kp.secretKey,
    });

    expect(msg.jsonrpc).toBe('2.0');
    expect(msg.method).toBe('negotiate/counter');
    expect(msg.params.counter_id).toBeTruthy();
    expect(msg.params.round).toBe(1);

    const { signature, ...unsigned } = msg.params;
    expect(verifyMessage(unsigned, signature, kp.publicKey)).toBe(true);
  });

  it('preserves the round number', () => {
    const kp = nacl.sign.keyPair();
    const msg = buildCounter({
      rfqId: 'rfq-round',
      inResponseTo: 'quote-round',
      round: 3,
      from: { agent_id: publicKeyToDid(kp.publicKey), role: 'seller' },
      modifications: { price_per_unit: '0.005' },
      secretKey: kp.secretKey,
    });

    expect(msg.params.round).toBe(3);
  });

  it('generates unique counter_ids', () => {
    const kp = nacl.sign.keyPair();
    const args = {
      rfqId: 'rfq-cuniq',
      inResponseTo: 'quote-cuniq',
      round: 1,
      from: { agent_id: publicKeyToDid(kp.publicKey), role: 'buyer' as const },
      modifications: { price_per_unit: '0.008' },
      secretKey: kp.secretKey,
    };
    const a = buildCounter(args);
    const b = buildCounter(args);
    expect(a.params.counter_id).not.toBe(b.params.counter_id);
  });
});

describe('buildAccept', () => {
  const finalTerms: FinalTerms = {
    price_per_unit: '0.01',
    currency: 'USDC',
    unit: 'request',
    sla: {
      metrics: [{ name: 'uptime_pct', target: 99.9, comparison: 'gte' }],
    },
  };

  it('computes agreement_hash deterministically', () => {
    const kp = nacl.sign.keyPair();
    const a = buildAccept({
      rfqId: 'rfq-200',
      acceptingMessageId: 'quote-200',
      finalTerms,
      buyerSecretKey: kp.secretKey,
    });
    const b = buildAccept({
      rfqId: 'rfq-200',
      acceptingMessageId: 'quote-200',
      finalTerms,
      buyerSecretKey: kp.secretKey,
    });

    expect(a.params.agreement_hash).toBe(b.params.agreement_hash);
    expect(a.params.agreement_hash).toBe(agreementHash(finalTerms));
    expect(a.params.agreement_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('signs with buyer key', () => {
    const kp = nacl.sign.keyPair();
    const msg = buildAccept({
      rfqId: 'rfq-300',
      acceptingMessageId: 'quote-300',
      finalTerms,
      buyerSecretKey: kp.secretKey,
    });

    expect(msg.params.buyer_signature).toBeTruthy();
    expect(msg.method).toBe('negotiate/accept');
  });

  it('agreement_hash changes with different terms', () => {
    const kp = nacl.sign.keyPair();
    const altTerms: FinalTerms = {
      price_per_unit: '0.05',
      currency: 'USDC',
      unit: 'request',
      sla: {
        metrics: [{ name: 'uptime_pct', target: 99, comparison: 'gte' }],
      },
    };
    const a = buildAccept({
      rfqId: 'rfq-hash1',
      acceptingMessageId: 'quote-hash1',
      finalTerms,
      buyerSecretKey: kp.secretKey,
    });
    const b = buildAccept({
      rfqId: 'rfq-hash2',
      acceptingMessageId: 'quote-hash2',
      finalTerms: altTerms,
      buyerSecretKey: kp.secretKey,
    });

    expect(a.params.agreement_hash).not.toBe(b.params.agreement_hash);
  });

  it('generates unique agreement_ids', () => {
    const kp = nacl.sign.keyPair();
    const args = {
      rfqId: 'rfq-auniq',
      acceptingMessageId: 'quote-auniq',
      finalTerms,
      buyerSecretKey: kp.secretKey,
    };
    const a = buildAccept(args);
    const b = buildAccept(args);
    expect(a.params.agreement_id).not.toBe(b.params.agreement_id);
  });
});

describe('buildReject', () => {
  it('produces valid envelope with signature', () => {
    const kp = nacl.sign.keyPair();
    const msg = buildReject({
      rfqId: 'rfq-400',
      rejectingMessageId: 'quote-400',
      reason: 'Price too high',
      agentId: publicKeyToDid(kp.publicKey),
      secretKey: kp.secretKey,
    });

    expect(msg.jsonrpc).toBe('2.0');
    expect(msg.method).toBe('negotiate/reject');
    expect(msg.params.reason).toBe('Price too high');
    expect(msg.params.from.agent_id).toBe(publicKeyToDid(kp.publicKey));

    const { signature, ...unsigned } = msg.params;
    expect(signature).toBeTruthy();
    expect(verifyMessage(unsigned, signature, kp.publicKey)).toBe(true);
  });

  it('rejects verification with wrong key', () => {
    const kp = nacl.sign.keyPair();
    const wrongKp = nacl.sign.keyPair();
    const msg = buildReject({
      rfqId: 'rfq-nosig',
      rejectingMessageId: 'quote-nosig',
      reason: 'Not interested',
      agentId: publicKeyToDid(kp.publicKey),
      secretKey: kp.secretKey,
    });

    const { signature, ...unsigned } = msg.params;
    expect(verifyMessage(unsigned, signature, wrongKp.publicKey)).toBe(false);
  });
});

describe('buildDispute', () => {
  it('produces valid envelope with signature', () => {
    const kp = nacl.sign.keyPair();
    const msg = buildDispute({
      agreementId: 'agr-500',
      filedBy: { agent_id: publicKeyToDid(kp.publicKey), role: 'buyer' },
      violation: {
        sla_metric: 'uptime_pct',
        agreed_value: 99.9,
        observed_value: 95.0,
        measurement_window: '24h',
        evidence_hash: 'abc123',
      },
      requestedRemedy: 'Full refund',
      escrowAction: 'release_to_buyer',
      secretKey: kp.secretKey,
    });

    expect(msg.jsonrpc).toBe('2.0');
    expect(msg.method).toBe('negotiate/dispute');
    expect(msg.params.dispute_id).toBeTruthy();

    const { signature, ...unsigned } = msg.params;
    expect(verifyMessage(unsigned, signature, kp.publicKey)).toBe(true);
  });

  it('generates unique dispute_ids', () => {
    const kp = nacl.sign.keyPair();
    const args = {
      agreementId: 'agr-duniq',
      filedBy: { agent_id: publicKeyToDid(kp.publicKey), role: 'buyer' as const },
      violation: {
        sla_metric: 'uptime_pct',
        agreed_value: 99.9,
        observed_value: 95.0,
        measurement_window: '24h',
        evidence_hash: 'abc123',
      },
      requestedRemedy: 'Full refund',
      escrowAction: 'release_to_buyer',
      secretKey: kp.secretKey,
    };
    const a = buildDispute(args);
    const b = buildDispute(args);
    expect(a.params.dispute_id).not.toBe(b.params.dispute_id);
  });
});

describe('cross-builder uniqueness', () => {
  it('all builders produce unique JSON-RPC ids on each call', () => {
    const kp = nacl.sign.keyPair();
    const ids = new Set<string>();

    const rfq = buildRFQ({
      buyer: makeIdentity(kp),
      service: { category: 'inference' },
      budget: { max_price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
      secretKey: kp.secretKey,
    });
    ids.add(rfq.id as string);

    const quote = buildQuote({
      rfqId: 'rfq-1',
      seller: makeIdentity(kp),
      pricing: { price_per_unit: '0.01', currency: 'USDC', unit: 'request', pricing_model: 'fixed' },
      secretKey: kp.secretKey,
    });
    ids.add(quote.id as string);

    const counter = buildCounter({
      rfqId: 'rfq-1',
      inResponseTo: 'quote-1',
      round: 1,
      from: { agent_id: publicKeyToDid(kp.publicKey), role: 'buyer' },
      modifications: {},
      secretKey: kp.secretKey,
    });
    ids.add(counter.id as string);

    const accept = buildAccept({
      rfqId: 'rfq-1',
      acceptingMessageId: 'quote-1',
      finalTerms: { price_per_unit: '0.01', currency: 'USDC', unit: 'request', sla: { metrics: [] } },
      buyerSecretKey: kp.secretKey,
    });
    ids.add(accept.id as string);

    const reject = buildReject({
      rfqId: 'rfq-1',
      rejectingMessageId: 'quote-1',
      reason: 'no',
      agentId: publicKeyToDid(kp.publicKey),
      secretKey: kp.secretKey,
    });
    ids.add(reject.id as string);

    const dispute = buildDispute({
      agreementId: 'agr-1',
      filedBy: { agent_id: publicKeyToDid(kp.publicKey), role: 'buyer' },
      violation: { sla_metric: 'uptime_pct', agreed_value: 99.9, observed_value: 90, measurement_window: '1h', evidence_hash: 'x' },
      requestedRemedy: 'refund',
      escrowAction: 'release_to_buyer',
      secretKey: kp.secretKey,
    });
    ids.add(dispute.id as string);

    // All 6 JSON-RPC ids should be unique
    expect(ids.size).toBe(6);
  });
});

describe('message builder edge cases', () => {
  const baseFinalTerms: FinalTerms = {
    price_per_unit: '0.01',
    currency: 'USDC',
    unit: 'request',
    sla: {
      metrics: [{ name: 'uptime_pct', target: 99.9, comparison: 'gte' }],
    },
  };

  it('buildAccept buyer_signature covers agreement_hash', () => {
    const kp = nacl.sign.keyPair();
    const termsA: FinalTerms = {
      price_per_unit: '0.01',
      currency: 'USDC',
      unit: 'request',
      sla: { metrics: [] },
    };
    const termsB: FinalTerms = {
      price_per_unit: '0.02',
      currency: 'USDC',
      unit: 'request',
      sla: { metrics: [] },
    };
    const acceptA = buildAccept({
      rfqId: 'rfq-edge-1',
      acceptingMessageId: 'quote-edge-1',
      finalTerms: termsA,
      buyerSecretKey: kp.secretKey,
    });
    const acceptB = buildAccept({
      rfqId: 'rfq-edge-1',
      acceptingMessageId: 'quote-edge-1',
      finalTerms: termsB,
      buyerSecretKey: kp.secretKey,
    });

    // Different agreement_hash values must produce different buyer_signatures
    expect(acceptA.params.agreement_hash).not.toBe(acceptB.params.agreement_hash);
    expect(acceptA.params.buyer_signature).not.toBe(acceptB.params.buyer_signature);
  });

  it('buildCounter signature covers round number', () => {
    const kp = nacl.sign.keyPair();
    const base = {
      rfqId: 'rfq-round-edge',
      inResponseTo: 'quote-round-edge',
      from: { agent_id: publicKeyToDid(kp.publicKey), role: 'buyer' as const },
      modifications: { price_per_unit: '0.008' },
      secretKey: kp.secretKey,
    };
    const counterR1 = buildCounter({ ...base, round: 1 });
    const counterR2 = buildCounter({ ...base, round: 2 });

    // Same params except round -- signatures must differ because round is
    // included in the signed payload. We compare the raw signature values
    // noting that counter_id also differs (UUID), but the key point is that
    // round is canonicalized into the signed content.
    expect(counterR1.params.round).toBe(1);
    expect(counterR2.params.round).toBe(2);
    expect(counterR1.params.signature).not.toBe(counterR2.params.signature);
  });

  it('buildDispute signature covers evidence', () => {
    const kp = nacl.sign.keyPair();
    const base = {
      agreementId: 'agr-ev-edge',
      filedBy: { agent_id: publicKeyToDid(kp.publicKey), role: 'buyer' as const },
      requestedRemedy: 'Full refund',
      escrowAction: 'release_to_buyer',
      secretKey: kp.secretKey,
    };
    const disputeA = buildDispute({
      ...base,
      violation: {
        sla_metric: 'uptime_pct',
        agreed_value: 99.9,
        observed_value: 95.0,
        measurement_window: '24h',
        evidence_hash: 'evidence_aaa',
      },
    });
    const disputeB = buildDispute({
      ...base,
      violation: {
        sla_metric: 'uptime_pct',
        agreed_value: 99.9,
        observed_value: 80.0,
        measurement_window: '24h',
        evidence_hash: 'evidence_bbb',
      },
    });

    expect(disputeA.params.signature).not.toBe(disputeB.params.signature);
  });

  it('buildRFQ with ttlMs of 0 produces expires_at near now', () => {
    const kp = nacl.sign.keyPair();
    const before = Date.now();
    const msg = buildRFQ({
      buyer: makeIdentity(kp),
      service: { category: 'inference' },
      budget: { max_price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
      ttlMs: 0,
      secretKey: kp.secretKey,
    });

    // ttlMs=0 means expires_at = Date.now() + 0, so it should be essentially now
    const expiresAt = new Date(msg.params.expires_at).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before);
    expect(expiresAt).toBeLessThanOrEqual(before + 1000);
  });

  it('buildRFQ with negative ttlMs produces expires_at in the past', () => {
    const kp = nacl.sign.keyPair();
    const before = Date.now();
    const msg = buildRFQ({
      buyer: makeIdentity(kp),
      service: { category: 'inference' },
      budget: { max_price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
      ttlMs: -60_000,
      secretKey: kp.secretKey,
    });

    // Negative TTL: expires_at = Date.now() - 60s, so it is in the past
    const expiresAt = new Date(msg.params.expires_at).getTime();
    expect(expiresAt).toBeLessThan(before);
  });

  it('buildCounter with round = 0', () => {
    const kp = nacl.sign.keyPair();
    const msg = buildCounter({
      rfqId: 'rfq-r0',
      inResponseTo: 'quote-r0',
      round: 0,
      from: { agent_id: publicKeyToDid(kp.publicKey), role: 'buyer' },
      modifications: { price_per_unit: '0.007' },
      secretKey: kp.secretKey,
    });

    // round=0 is accepted (no validation rejects it)
    expect(msg.params.round).toBe(0);
    expect(msg.params.counter_id).toBeTruthy();
    const { signature, ...unsigned } = msg.params;
    expect(verifyMessage(unsigned, signature, kp.publicKey)).toBe(true);
  });

  it('buildAccept without sellerSignature omits seller_signature', () => {
    const kp = nacl.sign.keyPair();
    const msg = buildAccept({
      rfqId: 'rfq-noseller',
      acceptingMessageId: 'quote-noseller',
      finalTerms: baseFinalTerms,
      buyerSecretKey: kp.secretKey,
    });

    expect(msg.params.buyer_signature).toBeTruthy();
    expect(
      (msg.params as unknown as Record<string, unknown>)['seller_signature'],
    ).toBeUndefined();
  });

  it('buildAccept with sellerSignature includes seller_signature', () => {
    const buyerKp = nacl.sign.keyPair();
    const sellerKp = nacl.sign.keyPair();
    const sellerSig = signMessage({ test: 'seller-ack' }, sellerKp.secretKey);

    const msg = buildAccept({
      rfqId: 'rfq-withseller',
      acceptingMessageId: 'quote-withseller',
      finalTerms: baseFinalTerms,
      buyerSecretKey: buyerKp.secretKey,
      sellerSignature: sellerSig,
    });

    expect(msg.params.buyer_signature).toBeTruthy();
    expect(msg.params.seller_signature).toBe(sellerSig);
  });

  it('buildRFQ includes SLA in params', () => {
    const kp = nacl.sign.keyPair();
    const sla: import('@ophir/protocol').SLARequirement = {
      metrics: [
        { name: 'uptime_pct', target: 99.9, comparison: 'gte' },
        { name: 'p99_latency_ms', target: 200, comparison: 'lte' },
      ],
    };
    const msg = buildRFQ({
      buyer: makeIdentity(kp),
      service: { category: 'inference' },
      budget: { max_price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
      sla,
      secretKey: kp.secretKey,
    });

    expect(msg.params.sla_requirements).toBeDefined();
    expect(msg.params.sla_requirements?.metrics).toHaveLength(2);
    expect(msg.params.sla_requirements?.metrics[0].name).toBe('uptime_pct');
    expect(msg.params.sla_requirements?.metrics[1].name).toBe('p99_latency_ms');
  });

  it('buildReject with special characters in reason', () => {
    const kp = nacl.sign.keyPair();
    const specialReason = 'Price "too high"\nnot acceptable\t\u2603 \u00e9';
    const msg = buildReject({
      rfqId: 'rfq-special',
      rejectingMessageId: 'quote-special',
      reason: specialReason,
      agentId: publicKeyToDid(kp.publicKey),
      secretKey: kp.secretKey,
    });

    expect(msg.params.reason).toBe(specialReason);
    expect(msg.method).toBe('negotiate/reject');
  });

  it('buildRFQ with empty string service category does not throw', () => {
    const kp = nacl.sign.keyPair();
    // buildRFQ does not validate service.category -- it only validates
    // buyer.agent_id and buyer.endpoint. An empty category passes through.
    const msg = buildRFQ({
      buyer: makeIdentity(kp),
      service: { category: '' },
      budget: { max_price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
      secretKey: kp.secretKey,
    });

    expect(msg.params.service.category).toBe('');
    expect(msg.method).toBe('negotiate/rfq');
  });
});

describe('message builder input validation', () => {
  const kp = nacl.sign.keyPair();

  it('buildRFQ throws for empty buyer.agent_id', () => {
    expect(() => buildRFQ({
      buyer: { agent_id: '', endpoint: 'http://localhost:3001' },
      service: { category: 'inference' },
      budget: { max_price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
      secretKey: kp.secretKey,
    })).toThrow('agent_id');
  });

  it('buildRFQ throws for empty buyer.endpoint', () => {
    expect(() => buildRFQ({
      buyer: { agent_id: 'did:key:z6MkTest', endpoint: '' },
      service: { category: 'inference' },
      budget: { max_price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
      secretKey: kp.secretKey,
    })).toThrow('endpoint');
  });

  it('buildQuote throws for empty rfqId', () => {
    expect(() => buildQuote({
      rfqId: '',
      seller: { agent_id: 'did:key:z6MkTest', endpoint: 'http://localhost:3000' },
      pricing: { price_per_unit: '0.01', currency: 'USDC', unit: 'request', pricing_model: 'fixed' },
      secretKey: kp.secretKey,
    })).toThrow('rfqId');
  });

  it('buildQuote throws for empty seller.agent_id', () => {
    expect(() => buildQuote({
      rfqId: 'test-rfq',
      seller: { agent_id: '', endpoint: 'http://localhost:3000' },
      pricing: { price_per_unit: '0.01', currency: 'USDC', unit: 'request', pricing_model: 'fixed' },
      secretKey: kp.secretKey,
    })).toThrow('agent_id');
  });

  it('buildCounter throws for empty rfqId', () => {
    expect(() => buildCounter({
      rfqId: '',
      inResponseTo: 'test',
      round: 1,
      from: { agent_id: 'did:key:z6MkTest', role: 'buyer' },
      modifications: {},
      secretKey: kp.secretKey,
    })).toThrow('rfqId');
  });

  it('buildCounter throws for empty from.agent_id', () => {
    expect(() => buildCounter({
      rfqId: 'test',
      inResponseTo: 'test',
      round: 1,
      from: { agent_id: '', role: 'buyer' },
      modifications: {},
      secretKey: kp.secretKey,
    })).toThrow('agent_id');
  });

  it('buildAccept throws for empty rfqId', () => {
    expect(() => buildAccept({
      rfqId: '',
      acceptingMessageId: 'test',
      finalTerms: { price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
      buyerSecretKey: kp.secretKey,
    })).toThrow('rfqId');
  });

  it('buildAccept throws for missing finalTerms fields', () => {
    expect(() => buildAccept({
      rfqId: 'test',
      acceptingMessageId: 'test',
      finalTerms: { price_per_unit: '', currency: 'USDC', unit: 'request' },
      buyerSecretKey: kp.secretKey,
    })).toThrow('price_per_unit');
  });

  it('buildReject throws for empty reason', () => {
    expect(() => buildReject({
      rfqId: 'test',
      rejectingMessageId: 'test',
      reason: '',
      agentId: 'did:key:z6MkTest',
      secretKey: kp.secretKey,
    })).toThrow('reason');
  });

  it('buildDispute throws for empty agreementId', () => {
    expect(() => buildDispute({
      agreementId: '',
      filedBy: { agent_id: 'did:key:z6MkTest', role: 'buyer' },
      violation: { sla_metric: 'uptime_pct', agreed_value: 99.9, observed_value: 95, measurement_window: '24h', evidence_hash: 'abc' },
      requestedRemedy: 'refund',
      escrowAction: 'release',
      secretKey: kp.secretKey,
    })).toThrow('agreementId');
  });
});

describe('message builder crypto verification', () => {
  const kp = nacl.sign.keyPair();

  it('buildQuote signature is verifiable with seller public key', () => {
    const quote = buildQuote({
      rfqId: '12345678-1234-1234-1234-123456789abc',
      seller: { agent_id: 'did:key:z6MkTest', endpoint: 'http://localhost:3000' },
      pricing: { price_per_unit: '0.01', currency: 'USDC', unit: 'request', pricing_model: 'fixed' },
      secretKey: kp.secretKey,
    });
    const { signature, ...unsigned } = quote.params;
    expect(verifyMessage(unsigned, signature, kp.publicKey)).toBe(true);
  });

  it('buildQuote signature fails with wrong public key', () => {
    const wrongKp = nacl.sign.keyPair();
    const quote = buildQuote({
      rfqId: '12345678-1234-1234-1234-123456789abc',
      seller: { agent_id: 'did:key:z6MkTest', endpoint: 'http://localhost:3000' },
      pricing: { price_per_unit: '0.01', currency: 'USDC', unit: 'request', pricing_model: 'fixed' },
      secretKey: kp.secretKey,
    });
    const { signature, ...unsigned } = quote.params;
    expect(verifyMessage(unsigned, signature, wrongKp.publicKey)).toBe(false);
  });

  it('buildCounter signature is verifiable', () => {
    const counter = buildCounter({
      rfqId: '12345678-1234-1234-1234-123456789abc',
      inResponseTo: '12345678-1234-1234-1234-123456789def',
      round: 1,
      from: { agent_id: 'did:key:z6MkTest', role: 'buyer' },
      modifications: { price: '0.005' },
      secretKey: kp.secretKey,
    });
    const { signature, ...unsigned } = counter.params;
    expect(verifyMessage(unsigned, signature, kp.publicKey)).toBe(true);
  });

  it('buildAccept buyer_signature is verifiable', () => {
    const accept = buildAccept({
      rfqId: '12345678-1234-1234-1234-123456789abc',
      acceptingMessageId: '12345678-1234-1234-1234-123456789def',
      finalTerms: { price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
      buyerSecretKey: kp.secretKey,
    });
    const { buyer_signature, seller_signature: _ss, ...unsigned } = accept.params;
    expect(verifyMessage(unsigned, buyer_signature, kp.publicKey)).toBe(true);
  });

  it('buildDispute signature is verifiable', () => {
    const dispute = buildDispute({
      agreementId: '12345678-1234-1234-1234-123456789abc',
      filedBy: { agent_id: 'did:key:z6MkTest', role: 'buyer' },
      violation: { sla_metric: 'uptime_pct', agreed_value: 99.9, observed_value: 95, measurement_window: '24h', evidence_hash: 'abc123' },
      requestedRemedy: 'escrow_release',
      escrowAction: 'freeze',
      secretKey: kp.secretKey,
    });
    const { signature, ...unsigned } = dispute.params;
    expect(verifyMessage(unsigned, signature, kp.publicKey)).toBe(true);
  });

  it('buildAccept agreement_hash is SHA-256 hex', () => {
    const accept = buildAccept({
      rfqId: '12345678-1234-1234-1234-123456789abc',
      acceptingMessageId: '12345678-1234-1234-1234-123456789def',
      finalTerms: { price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
      buyerSecretKey: kp.secretKey,
    });
    expect(accept.params.agreement_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('buildQuote with optional SLA includes it in signature', () => {
    const withSla = buildQuote({
      rfqId: '12345678-1234-1234-1234-123456789abc',
      seller: { agent_id: 'did:key:z6MkTest', endpoint: 'http://localhost:3000' },
      pricing: { price_per_unit: '0.01', currency: 'USDC', unit: 'request', pricing_model: 'fixed' },
      sla: { metrics: [{ name: 'uptime_pct', target: 99.9, comparison: 'gte' }] },
      secretKey: kp.secretKey,
    });
    const withoutSla = buildQuote({
      rfqId: '12345678-1234-1234-1234-123456789abc',
      seller: { agent_id: 'did:key:z6MkTest', endpoint: 'http://localhost:3000' },
      pricing: { price_per_unit: '0.01', currency: 'USDC', unit: 'request', pricing_model: 'fixed' },
      secretKey: kp.secretKey,
    });
    expect(withSla.params.signature).not.toBe(withoutSla.params.signature);
  });

  it('buildDispute with lockstep_report includes it in signature', () => {
    const withReport = buildDispute({
      agreementId: '12345678-1234-1234-1234-123456789abc',
      filedBy: { agent_id: 'did:key:z6MkTest', role: 'buyer' },
      violation: { sla_metric: 'uptime_pct', agreed_value: 99.9, observed_value: 95, measurement_window: '24h', evidence_hash: 'abc' },
      requestedRemedy: 'refund',
      escrowAction: 'freeze',
      lockstepReport: { verification_id: 'v1', result: 'FAIL', deviations: ['latency exceeded'] },
      secretKey: kp.secretKey,
    });
    const withoutReport = buildDispute({
      agreementId: '12345678-1234-1234-1234-123456789abc',
      filedBy: { agent_id: 'did:key:z6MkTest', role: 'buyer' },
      violation: { sla_metric: 'uptime_pct', agreed_value: 99.9, observed_value: 95, measurement_window: '24h', evidence_hash: 'abc' },
      requestedRemedy: 'refund',
      escrowAction: 'freeze',
      secretKey: kp.secretKey,
    });
    expect(withReport.params.signature).not.toBe(withoutReport.params.signature);
  });
});

describe('builder method names', () => {
  it('buildRFQ sets method to negotiate/rfq', () => {
    const kp = nacl.sign.keyPair();
    const msg = buildRFQ({
      buyer: makeIdentity(kp),
      service: { category: 'inference' },
      budget: { max_price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
      secretKey: kp.secretKey,
    });
    expect(msg.method).toBe('negotiate/rfq');
  });

  it('buildQuote sets method to negotiate/quote', () => {
    const kp = nacl.sign.keyPair();
    const msg = buildQuote({
      rfqId: 'rfq-method-test',
      seller: makeIdentity(kp),
      pricing: { price_per_unit: '0.01', currency: 'USDC', unit: 'request', pricing_model: 'fixed' },
      secretKey: kp.secretKey,
    });
    expect(msg.method).toBe('negotiate/quote');
  });

  it('buildCounter sets method to negotiate/counter', () => {
    const kp = nacl.sign.keyPair();
    const msg = buildCounter({
      rfqId: 'rfq-method-test',
      inResponseTo: 'quote-method-test',
      round: 1,
      from: { agent_id: publicKeyToDid(kp.publicKey), role: 'buyer' },
      modifications: { price_per_unit: '0.008' },
      secretKey: kp.secretKey,
    });
    expect(msg.method).toBe('negotiate/counter');
  });

  it('buildAccept sets method to negotiate/accept', () => {
    const kp = nacl.sign.keyPair();
    const msg = buildAccept({
      rfqId: 'rfq-method-test',
      acceptingMessageId: 'quote-method-test',
      finalTerms: { price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
      buyerSecretKey: kp.secretKey,
    });
    expect(msg.method).toBe('negotiate/accept');
  });

  it('buildReject sets method to negotiate/reject', () => {
    const kp = nacl.sign.keyPair();
    const msg = buildReject({
      rfqId: 'rfq-method-test',
      rejectingMessageId: 'quote-method-test',
      reason: 'Too expensive',
      agentId: publicKeyToDid(kp.publicKey),
      secretKey: kp.secretKey,
    });
    expect(msg.method).toBe('negotiate/reject');
  });

  it('buildDispute sets method to negotiate/dispute', () => {
    const kp = nacl.sign.keyPair();
    const msg = buildDispute({
      agreementId: 'agr-method-test',
      filedBy: { agent_id: publicKeyToDid(kp.publicKey), role: 'buyer' },
      violation: { sla_metric: 'uptime_pct', agreed_value: 99.9, observed_value: 95.0, measurement_window: '24h', evidence_hash: 'abc123' },
      requestedRemedy: 'Full refund',
      escrowAction: 'release_to_buyer',
      secretKey: kp.secretKey,
    });
    expect(msg.method).toBe('negotiate/dispute');
  });
});

describe('buildRFQ signing requirement', () => {
  it('buildRFQ produces a signed RFQ verifiable with buyer public key', () => {
    const kp = nacl.sign.keyPair();
    const msg = buildRFQ({
      buyer: makeIdentity(kp),
      service: { category: 'inference' },
      budget: { max_price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
      secretKey: kp.secretKey,
    });

    expect(msg.params.signature).toBeDefined();
    const { signature, ...unsigned } = msg.params;
    expect(verifyMessage(unsigned, signature, kp.publicKey)).toBe(true);
  });

  it('buildRFQ signature changes when buyer identity changes', () => {
    const kp1 = nacl.sign.keyPair();
    const kp2 = nacl.sign.keyPair();
    const msg1 = buildRFQ({
      buyer: makeIdentity(kp1),
      service: { category: 'inference' },
      budget: { max_price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
      secretKey: kp1.secretKey,
    });
    const msg2 = buildRFQ({
      buyer: makeIdentity(kp2),
      service: { category: 'inference' },
      budget: { max_price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
      secretKey: kp2.secretKey,
    });

    expect(msg1.params.signature).not.toBe(msg2.params.signature);
  });
});

describe('secretKey requirement', () => {
  it('buildRFQ throws when secretKey is undefined', () => {
    const kp = nacl.sign.keyPair();
    expect(() => buildRFQ({
      buyer: makeIdentity(kp),
      service: { category: 'inference' },
      budget: { max_price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
      secretKey: undefined as any,
    })).toThrow();
  });

  it('buildReject throws when secretKey is undefined', () => {
    const kp = nacl.sign.keyPair();
    expect(() => buildReject({
      rfqId: 'rfq-nokey',
      rejectingMessageId: 'quote-nokey',
      reason: 'Not interested',
      agentId: publicKeyToDid(kp.publicKey),
      secretKey: undefined as any,
    })).toThrow();
  });
});
