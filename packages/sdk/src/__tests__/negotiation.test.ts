import { describe, it, expect, beforeEach } from 'vitest';
import { NegotiationSession } from '../negotiation.js';
import { OphirErrorCode, OphirError } from '@ophirai/protocol';
import type { RFQParams, QuoteParams, CounterParams } from '@ophirai/protocol';
import type { MarginAssessment } from '@ophirai/clearinghouse';
import type { Agreement } from '../types.js';

function makeRFQ(overrides?: Partial<RFQParams>): RFQParams {
  return {
    rfq_id: 'rfq-001',
    buyer: { agent_id: 'did:key:z6MkTest', endpoint: 'http://localhost:3000' },
    service: { category: 'inference' },
    budget: { max_price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
    negotiation_style: 'rfq',
    expires_at: new Date(Date.now() + 300_000).toISOString(),
    signature: 'sig-placeholder',
    ...overrides,
  };
}

function makeQuote(overrides?: Partial<QuoteParams>): QuoteParams {
  return {
    quote_id: 'quote-001',
    rfq_id: 'rfq-001',
    seller: { agent_id: 'did:key:z6MkSeller', endpoint: 'http://localhost:4000' },
    pricing: { price_per_unit: '0.008', currency: 'USDC', unit: 'request', pricing_model: 'fixed' },
    expires_at: new Date(Date.now() + 120_000).toISOString(),
    signature: 'sig-placeholder',
    ...overrides,
  };
}

function makeCounter(round: number): CounterParams {
  return {
    counter_id: `counter-${round}`,
    rfq_id: 'rfq-001',
    in_response_to: 'quote-001',
    round,
    from: { agent_id: 'did:key:z6MkTest', role: 'buyer' },
    modifications: { price_per_unit: '0.007' },
    expires_at: new Date(Date.now() + 120_000).toISOString(),
    signature: 'sig-placeholder',
  };
}

function makeAgreement(): Agreement {
  return {
    agreement_id: 'agree-001',
    rfq_id: 'rfq-001',
    accepting_message_id: 'quote-001',
    final_terms: { price_per_unit: '0.008', currency: 'USDC', unit: 'request' },
    agreement_hash: 'abcd1234',
    buyer_signature: 'buyer-sig',
    seller_signature: 'seller-sig',
  };
}

function makeMarginAssessment(overrides?: Partial<MarginAssessment>): MarginAssessment {
  return {
    agreement_id: 'agree-001',
    buyer_id: 'did:key:z6MkTest',
    seller_id: 'did:key:z6MkSeller',
    buyer_pod: { agent_id: 'did:key:z6MkTest', score: 0.9, margin_rate: 0.1, confidence: 0.8, sample_size: 10, last_updated: new Date().toISOString() },
    seller_pod: { agent_id: 'did:key:z6MkSeller', score: 0.85, margin_rate: 0.15, confidence: 0.7, sample_size: 8, last_updated: new Date().toISOString() },
    required_margin_rate: 0.12,
    required_deposit: 0.001,
    full_deposit: 0.008,
    savings: 0.007,
    ...overrides,
  };
}

describe('NegotiationSession', () => {
  let session: NegotiationSession;

  beforeEach(() => {
    session = new NegotiationSession(makeRFQ());
  });

  describe('initial state', () => {
    it('starts in RFQ_SENT state', () => {
      expect(session.state).toBe('RFQ_SENT');
    });

    it('initializes with rfq data', () => {
      expect(session.rfqId).toBe('rfq-001');
      expect(session.currentRound).toBe(0);
      expect(session.maxRounds).toBe(5);
      expect(session.quotes).toEqual([]);
      expect(session.counters).toEqual([]);
    });

    it('respects custom maxRounds', () => {
      const s = new NegotiationSession(makeRFQ(), 3);
      expect(s.maxRounds).toBe(3);
    });

    it('uses rfq.max_rounds as fallback', () => {
      const s = new NegotiationSession(makeRFQ({ max_rounds: 7 }));
      expect(s.maxRounds).toBe(7);
    });
  });

  describe('valid transitions', () => {
    it('RFQ_SENT → QUOTES_RECEIVED via addQuote', () => {
      session.addQuote(makeQuote());
      expect(session.state).toBe('QUOTES_RECEIVED');
      expect(session.quotes).toHaveLength(1);
    });

    it('QUOTES_RECEIVED → QUOTES_RECEIVED via addQuote (multiple quotes)', () => {
      session.addQuote(makeQuote());
      session.addQuote(makeQuote({ quote_id: 'quote-002' }));
      expect(session.state).toBe('QUOTES_RECEIVED');
      expect(session.quotes).toHaveLength(2);
    });

    it('QUOTES_RECEIVED → COUNTERING via addCounter', () => {
      session.addQuote(makeQuote());
      session.addCounter(makeCounter(1));
      expect(session.state).toBe('COUNTERING');
      expect(session.currentRound).toBe(1);
    });

    it('COUNTERING + addQuote accumulates seller response without changing state', () => {
      session.addQuote(makeQuote());
      session.addCounter(makeCounter(1));
      expect(session.state).toBe('COUNTERING');
      session.addQuote(makeQuote({ quote_id: 'response-quote' }));
      expect(session.state).toBe('COUNTERING');
      expect(session.quotes).toHaveLength(2);
    });

    it('COUNTERING → COUNTERING via addCounter', () => {
      session.addQuote(makeQuote());
      session.addCounter(makeCounter(1));
      session.addCounter(makeCounter(2));
      expect(session.state).toBe('COUNTERING');
      expect(session.currentRound).toBe(2);
    });

    it('QUOTES_RECEIVED → ACCEPTED via accept', () => {
      session.addQuote(makeQuote());
      session.accept(makeAgreement());
      expect(session.state).toBe('ACCEPTED');
      expect(session.agreement).toBeDefined();
    });

    it('COUNTERING → ACCEPTED via accept', () => {
      session.addQuote(makeQuote());
      session.addCounter(makeCounter(1));
      session.accept(makeAgreement());
      expect(session.state).toBe('ACCEPTED');
    });

    it('ACCEPTED → MARGIN_ASSESSED via marginAssessed', () => {
      session.addQuote(makeQuote());
      session.accept(makeAgreement());
      session.marginAssessed(makeMarginAssessment());
      expect(session.state).toBe('MARGIN_ASSESSED');
    });

    it('MARGIN_ASSESSED → ESCROWED via escrowFunded', () => {
      session.addQuote(makeQuote());
      session.accept(makeAgreement());
      session.marginAssessed(makeMarginAssessment());
      session.escrowFunded('escrow-address-123');
      expect(session.state).toBe('ESCROWED');
    });

    it('ESCROWED → ACTIVE via activate', () => {
      session.addQuote(makeQuote());
      session.accept(makeAgreement());
      session.marginAssessed(makeMarginAssessment());
      session.escrowFunded('escrow-address-123');
      session.activate();
      expect(session.state).toBe('ACTIVE');
    });

    it('ACTIVE → COMPLETED via complete', () => {
      session.addQuote(makeQuote());
      session.accept(makeAgreement());
      session.marginAssessed(makeMarginAssessment());
      session.escrowFunded('escrow-address-123');
      session.activate();
      session.complete();
      expect(session.state).toBe('COMPLETED');
    });

    it('ACTIVE → DISPUTED via dispute', () => {
      session.addQuote(makeQuote());
      session.accept(makeAgreement());
      session.marginAssessed(makeMarginAssessment());
      session.escrowFunded('escrow-address-123');
      session.activate();
      session.dispute();
      expect(session.state).toBe('DISPUTED');
    });

    it('DISPUTED → RESOLVED via resolve', () => {
      session.addQuote(makeQuote());
      session.accept(makeAgreement());
      session.marginAssessed(makeMarginAssessment());
      session.escrowFunded('escrow-address-123');
      session.activate();
      session.dispute();
      session.resolve();
      expect(session.state).toBe('RESOLVED');
    });

    it('reject from RFQ_SENT', () => {
      session.reject('no budget');
      expect(session.state).toBe('REJECTED');
    });

    it('reject from QUOTES_RECEIVED', () => {
      session.addQuote(makeQuote());
      session.reject('too expensive');
      expect(session.state).toBe('REJECTED');
    });

    it('reject from COUNTERING', () => {
      session.addQuote(makeQuote());
      session.addCounter(makeCounter(1));
      session.reject('cannot agree');
      expect(session.state).toBe('REJECTED');
    });

    it('full happy path: RFQ → quote → accept → margin → escrow → active → complete', () => {
      session.addQuote(makeQuote());
      session.accept(makeAgreement());
      session.marginAssessed(makeMarginAssessment());
      session.escrowFunded('escrow-addr');
      session.activate();
      session.complete();
      expect(session.state).toBe('COMPLETED');
    });
  });

  describe('invalid transitions', () => {
    it('cannot addQuote from ACCEPTED', () => {
      session.addQuote(makeQuote());
      session.accept(makeAgreement());
      expect(() => session.addQuote(makeQuote())).toThrow();
      try {
        session.addQuote(makeQuote());
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(OphirError);
        const err = e as OphirError;
        expect(err.code).toBe(OphirErrorCode.INVALID_STATE_TRANSITION);
      }
    });

    it('cannot addCounter from RFQ_SENT', () => {
      expect(() => session.addCounter(makeCounter(1))).toThrow();
    });

    it('cannot accept from RFQ_SENT', () => {
      expect(() => session.accept(makeAgreement())).toThrow();
    });

    it('cannot escrowFunded from QUOTES_RECEIVED', () => {
      session.addQuote(makeQuote());
      expect(() => session.escrowFunded('addr')).toThrow();
    });

    it('cannot escrowFunded from ACCEPTED (must go through MARGIN_ASSESSED)', () => {
      session.addQuote(makeQuote());
      session.accept(makeAgreement());
      expect(() => session.escrowFunded('addr')).toThrow();
    });

    it('cannot activate from ACCEPTED', () => {
      session.addQuote(makeQuote());
      session.accept(makeAgreement());
      expect(() => session.activate()).toThrow();
    });

    it('cannot complete from ESCROWED', () => {
      session.addQuote(makeQuote());
      session.accept(makeAgreement());
      session.marginAssessed(makeMarginAssessment());
      session.escrowFunded('addr');
      expect(() => session.complete()).toThrow();
    });

    it('cannot dispute from COMPLETED', () => {
      session.addQuote(makeQuote());
      session.accept(makeAgreement());
      session.marginAssessed(makeMarginAssessment());
      session.escrowFunded('addr');
      session.activate();
      session.complete();
      expect(() => session.dispute()).toThrow();
    });

    it('cannot resolve from ACTIVE', () => {
      session.addQuote(makeQuote());
      session.accept(makeAgreement());
      session.marginAssessed(makeMarginAssessment());
      session.escrowFunded('addr');
      session.activate();
      expect(() => session.resolve()).toThrow();
    });

    it('can reject from ACCEPTED (counter-sign refused)', () => {
      session.addQuote(makeQuote());
      session.accept(makeAgreement());
      // Protocol allows ACCEPTED → REJECTED (e.g., seller refuses to counter-sign)
      session.reject('counter-sign refused');
      expect(session.state).toBe('REJECTED');
    });

    it('cannot accept from REJECTED', () => {
      session.reject('not interested');
      expect(() => session.accept(makeAgreement())).toThrow();
      try {
        session.accept(makeAgreement());
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(OphirError);
        const err = e as OphirError;
        expect(err.code).toBe(OphirErrorCode.INVALID_STATE_TRANSITION);
      }
    });

    it('cannot escrowFunded from RFQ_SENT', () => {
      expect(() => session.escrowFunded('addr')).toThrow();
      try {
        session.escrowFunded('addr');
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(OphirError);
        const err = e as OphirError;
        expect(err.code).toBe(OphirErrorCode.INVALID_STATE_TRANSITION);
      }
    });

    it('throws OphirError with INVALID_STATE_TRANSITION code', () => {
      try {
        session.addCounter(makeCounter(1));
        expect.unreachable('should have thrown');
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(OphirError);
        const err = e as OphirError;
        expect(err.code).toBe(OphirErrorCode.INVALID_STATE_TRANSITION);
        expect(err.data!.currentState).toBe('RFQ_SENT');
      }
    });
  });

  describe('round tracking', () => {
    it('increments round on each counter', () => {
      session.addQuote(makeQuote());
      expect(session.currentRound).toBe(0);
      session.addCounter(makeCounter(1));
      expect(session.currentRound).toBe(1);
      session.addCounter(makeCounter(2));
      expect(session.currentRound).toBe(2);
    });

    it('throws MAX_ROUNDS_EXCEEDED when limit reached', () => {
      const s = new NegotiationSession(makeRFQ(), 2);
      s.addQuote(makeQuote());
      s.addCounter(makeCounter(1));
      s.addCounter(makeCounter(2));
      try {
        s.addCounter(makeCounter(3));
        expect.unreachable('should have thrown');
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(OphirError);
        const err = e as OphirError;
        expect(err.code).toBe(OphirErrorCode.MAX_ROUNDS_EXCEEDED);
      }
    });
  });

  describe('expiration', () => {
    it('returns false for states without timeouts', () => {
      session.addQuote(makeQuote());
      session.accept(makeAgreement());
      expect(session.isExpired()).toBe(false);
    });

    it('returns false when within timeout', () => {
      expect(session.isExpired()).toBe(false);
    });

    it('returns true when past timeout', () => {
      // Manually backdate updatedAt
      session.updatedAt = new Date(Date.now() - 6 * 60 * 1000); // 6 min ago
      expect(session.isExpired()).toBe(true); // RFQ_SENT timeout is 5 min
    });
  });

  describe('serialization', () => {
    it('serializes to JSON with all fields', () => {
      session.addQuote(makeQuote());
      session.addCounter(makeCounter(1));
      const json: Record<string, unknown> = session.toJSON();

      expect(json['rfqId']).toBe('rfq-001');
      expect(json['state']).toBe('COUNTERING');
      expect((json['quotes'] as unknown[]).length).toBe(1);
      expect((json['counters'] as unknown[]).length).toBe(1);
      expect(json['currentRound']).toBe(1);
      expect(json['maxRounds']).toBe(5);
      expect(json['createdAt']).toBeDefined();
      expect(json['updatedAt']).toBeDefined();
    });

    it('includes agreement when accepted', () => {
      session.addQuote(makeQuote());
      session.accept(makeAgreement());
      const json: Record<string, unknown> = session.toJSON();
      expect((json['agreement'] as Record<string, unknown>)['agreement_id']).toBe('agree-001');
    });

    it('serializes dates as ISO strings', () => {
      const json: Record<string, unknown> = session.toJSON();
      expect(json['createdAt'] as string).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(json['updatedAt'] as string).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('edge cases', () => {
    it('addQuote with mismatched rfq_id is accepted (no rfq_id validation)', () => {
      const mismatchedQuote = makeQuote({ rfq_id: 'rfq-999', quote_id: 'quote-mismatch' });
      session.addQuote(mismatchedQuote);
      expect(session.state).toBe('QUOTES_RECEIVED');
      expect(session.quotes).toHaveLength(1);
      expect(session.quotes[0].rfq_id).toBe('rfq-999');
    });

    it('duplicate quote IDs are both stored (no deduplication)', () => {
      session.addQuote(makeQuote({ quote_id: 'quote-dup' }));
      session.addQuote(makeQuote({ quote_id: 'quote-dup' }));
      expect(session.quotes).toHaveLength(2);
      expect(session.quotes[0].quote_id).toBe('quote-dup');
      expect(session.quotes[1].quote_id).toBe('quote-dup');
    });

    it('accept with mismatched rfq_id in agreement is accepted (no rfq_id validation)', () => {
      session.addQuote(makeQuote());
      const mismatchedAgreement = makeAgreement();
      mismatchedAgreement.rfq_id = 'rfq-wrong';
      session.accept(mismatchedAgreement);
      expect(session.state).toBe('ACCEPTED');
      expect(session.agreement!.rfq_id).toBe('rfq-wrong');
    });

    it('double reject throws on the second call', () => {
      session.reject('first rejection');
      expect(session.state).toBe('REJECTED');
      expect(session.rejectionReason).toBe('first rejection');
      try {
        session.reject('second rejection');
        expect.unreachable('should have thrown');
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(OphirError);
        const err = e as OphirError;
        expect(err.code).toBe(OphirErrorCode.INVALID_STATE_TRANSITION);
        expect(err.data!.currentState).toBe('REJECTED');
      }
      // reason should remain from first reject
      expect(session.rejectionReason).toBe('first rejection');
    });

    it('maxRounds = 1 allows 1 counter then rejects the 2nd', () => {
      const s = new NegotiationSession(makeRFQ(), 1);
      s.addQuote(makeQuote());
      s.addCounter(makeCounter(1));
      expect(s.currentRound).toBe(1);
      expect(s.state).toBe('COUNTERING');
      try {
        s.addCounter(makeCounter(2));
        expect.unreachable('should have thrown');
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(OphirError);
        const err = e as OphirError;
        expect(err.code).toBe(OphirErrorCode.MAX_ROUNDS_EXCEEDED);
      }
    });

    it('updatedAt changes on state transitions', async () => {
      const initialUpdatedAt = session.updatedAt.getTime();
      // small delay to ensure timestamp differs
      await new Promise((r) => setTimeout(r, 10));

      session.addQuote(makeQuote());
      const afterQuote = session.updatedAt.getTime();
      expect(afterQuote).toBeGreaterThan(initialUpdatedAt);

      await new Promise((r) => setTimeout(r, 10));

      session.addCounter(makeCounter(1));
      const afterCounter = session.updatedAt.getTime();
      expect(afterCounter).toBeGreaterThan(afterQuote);

      await new Promise((r) => setTimeout(r, 10));

      session.accept(makeAgreement());
      const afterAccept = session.updatedAt.getTime();
      expect(afterAccept).toBeGreaterThan(afterCounter);
    });

    it('escrowFunded stores address accessible via toJSON', () => {
      session.addQuote(makeQuote());
      session.accept(makeAgreement());
      session.marginAssessed(makeMarginAssessment());
      session.escrowFunded('0xDeadBeef1234');
      const json: Record<string, unknown> = session.toJSON();
      expect(json['escrowAddress']).toBe('0xDeadBeef1234');
    });

    it('toJSON on COMPLETED session includes full lifecycle data', () => {
      session.addQuote(makeQuote());
      session.accept(makeAgreement());
      session.marginAssessed(makeMarginAssessment());
      session.escrowFunded('escrow-addr-final');
      session.activate();
      session.complete();

      const json: Record<string, unknown> = session.toJSON();
      expect(json['state']).toBe('COMPLETED');
      expect(json['rfqId']).toBe('rfq-001');
      expect((json['quotes'] as unknown[]).length).toBe(1);
      expect(json['agreement']).toBeDefined();
      expect((json['agreement'] as Record<string, unknown>)['agreement_id']).toBe('agree-001');
      expect(json['escrowAddress']).toBe('escrow-addr-final');
      expect(json['rejectionReason']).toBeUndefined();
      expect(json['createdAt']).toBeDefined();
      expect(json['updatedAt']).toBeDefined();
    });

    it('toJSON on RESOLVED session includes dispute lifecycle data', () => {
      session.addQuote(makeQuote());
      session.accept(makeAgreement());
      session.marginAssessed(makeMarginAssessment());
      session.escrowFunded('escrow-addr-dispute');
      session.activate();
      session.dispute();
      session.resolve();

      const json: Record<string, unknown> = session.toJSON();
      expect(json['state']).toBe('RESOLVED');
      expect(json['rfqId']).toBe('rfq-001');
      expect(json['agreement']).toBeDefined();
      expect(json['escrowAddress']).toBe('escrow-addr-dispute');
      expect(json['currentRound']).toBe(0);
    });

    it('reject from initial RFQ_SENT state (no quotes received)', () => {
      // There is no IDLE state; RFQ_SENT is the initial state.
      // Rejecting before any quotes is valid.
      expect(session.state).toBe('RFQ_SENT');
      session.reject('changed my mind');
      expect(session.state).toBe('REJECTED');
      expect(session.rejectionReason).toBe('changed my mind');
      expect(session.quotes).toEqual([]);
      expect(session.counters).toEqual([]);
      expect(session.agreement).toBeUndefined();
    });
  });
});

describe('NegotiationSession additional coverage', () => {
  // Helper to create a valid RFQ
  function makeRFQ(overrides?: Partial<RFQParams>): RFQParams {
    return {
      rfq_id: 'test-rfq-' + Math.random().toString(36).slice(2),
      buyer: { agent_id: 'did:key:z6MkTest', endpoint: 'http://localhost:3001' },
      service: { category: 'inference' },
      budget: { max_price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
      negotiation_style: 'rfq',
      expires_at: new Date(Date.now() + 300000).toISOString(),
      signature: 'sig-placeholder',
      ...overrides,
    };
  }

  describe('state machine completeness', () => {
    it('cannot addQuote from ACCEPTED state', () => {
      const session = new NegotiationSession(makeRFQ());
      // Need to get to ACCEPTED: add quote, then accept
      const quote = { quote_id: 'q1', rfq_id: session.rfqId, seller: { agent_id: 'did:key:z6MkSeller', endpoint: 'http://localhost:3000' }, pricing: { price_per_unit: '0.01', currency: 'USDC', unit: 'request', pricing_model: 'fixed' as const }, expires_at: new Date(Date.now() + 60000).toISOString(), signature: 'sig' };
      session.addQuote(quote as any);
      session.accept({ agreement_id: 'a1', rfq_id: session.rfqId, accepting_message_id: 'quote-001', final_terms: { price_per_unit: '0.01', currency: 'USDC', unit: 'request' }, agreement_hash: 'h', buyer_signature: 'bs', seller_signature: 'ss' });
      expect(() => session.addQuote(quote as any)).toThrow('ACCEPTED');
    });

    it('cannot addCounter from ACCEPTED state', () => {
      const session = new NegotiationSession(makeRFQ());
      const quote = { quote_id: 'q1', rfq_id: session.rfqId, seller: { agent_id: 'did:key:z6MkSeller', endpoint: 'http://localhost:3000' }, pricing: { price_per_unit: '0.01', currency: 'USDC', unit: 'request', pricing_model: 'fixed' as const }, expires_at: new Date(Date.now() + 60000).toISOString(), signature: 'sig' };
      session.addQuote(quote as any);
      session.accept({ agreement_id: 'a1', rfq_id: session.rfqId, accepting_message_id: 'quote-001', final_terms: { price_per_unit: '0.01', currency: 'USDC', unit: 'request' }, agreement_hash: 'h', buyer_signature: 'bs', seller_signature: 'ss' });
      expect(() => session.addCounter({ counter_id: 'c1', rfq_id: session.rfqId, in_response_to: 'q1', round: 1, from: { agent_id: 'did:key:z6MkTest', role: 'buyer' }, modifications: {}, expires_at: new Date(Date.now() + 60000).toISOString(), signature: 'sig' } as any)).toThrow('ACCEPTED');
    });

    it('cannot accept from REJECTED state', () => {
      const session = new NegotiationSession(makeRFQ());
      session.reject('no thanks');
      expect(() => session.accept({ agreement_id: 'a1', rfq_id: session.rfqId, accepting_message_id: 'quote-001', final_terms: { price_per_unit: '0.01', currency: 'USDC', unit: 'request' }, agreement_hash: 'h', buyer_signature: 'bs', seller_signature: 'ss' })).toThrow('REJECTED');
    });

    it('cannot escrowFunded from QUOTES_RECEIVED state', () => {
      const session = new NegotiationSession(makeRFQ());
      const quote = { quote_id: 'q1', rfq_id: session.rfqId, seller: { agent_id: 'did:key:z6MkSeller', endpoint: 'http://localhost:3000' }, pricing: { price_per_unit: '0.01', currency: 'USDC', unit: 'request', pricing_model: 'fixed' as const }, expires_at: new Date(Date.now() + 60000).toISOString(), signature: 'sig' };
      session.addQuote(quote as any);
      expect(() => session.escrowFunded('addr')).toThrow('QUOTES_RECEIVED');
    });

    it('cannot activate from ACCEPTED state (must be ESCROWED)', () => {
      const session = new NegotiationSession(makeRFQ());
      const quote = { quote_id: 'q1', rfq_id: session.rfqId, seller: { agent_id: 'did:key:z6MkSeller', endpoint: 'http://localhost:3000' }, pricing: { price_per_unit: '0.01', currency: 'USDC', unit: 'request', pricing_model: 'fixed' as const }, expires_at: new Date(Date.now() + 60000).toISOString(), signature: 'sig' };
      session.addQuote(quote as any);
      session.accept({ agreement_id: 'a1', rfq_id: session.rfqId, accepting_message_id: 'quote-001', final_terms: { price_per_unit: '0.01', currency: 'USDC', unit: 'request' }, agreement_hash: 'h', buyer_signature: 'bs', seller_signature: 'ss' });
      expect(() => session.activate()).toThrow('ACCEPTED');
    });

    it('cannot complete from ESCROWED state (must be ACTIVE)', () => {
      const session = new NegotiationSession(makeRFQ());
      const quote = { quote_id: 'q1', rfq_id: session.rfqId, seller: { agent_id: 'did:key:z6MkSeller', endpoint: 'http://localhost:3000' }, pricing: { price_per_unit: '0.01', currency: 'USDC', unit: 'request', pricing_model: 'fixed' as const }, expires_at: new Date(Date.now() + 60000).toISOString(), signature: 'sig' };
      session.addQuote(quote as any);
      session.accept({ agreement_id: 'a1', rfq_id: session.rfqId, accepting_message_id: 'quote-001', final_terms: { price_per_unit: '0.01', currency: 'USDC', unit: 'request' }, agreement_hash: 'h', buyer_signature: 'bs', seller_signature: 'ss' });
      session.marginAssessed(makeMarginAssessment());
      session.escrowFunded('addr');
      expect(() => session.complete()).toThrow('ESCROWED');
    });

    it('cannot dispute from COMPLETED state', () => {
      const session = new NegotiationSession(makeRFQ());
      const quote = { quote_id: 'q1', rfq_id: session.rfqId, seller: { agent_id: 'did:key:z6MkSeller', endpoint: 'http://localhost:3000' }, pricing: { price_per_unit: '0.01', currency: 'USDC', unit: 'request', pricing_model: 'fixed' as const }, expires_at: new Date(Date.now() + 60000).toISOString(), signature: 'sig' };
      session.addQuote(quote as any);
      session.accept({ agreement_id: 'a1', rfq_id: session.rfqId, accepting_message_id: 'quote-001', final_terms: { price_per_unit: '0.01', currency: 'USDC', unit: 'request' }, agreement_hash: 'h', buyer_signature: 'bs', seller_signature: 'ss' });
      session.marginAssessed(makeMarginAssessment());
      session.escrowFunded('addr');
      session.activate();
      session.complete();
      expect(() => session.dispute()).toThrow('COMPLETED');
    });

    it('cannot resolve from ACTIVE state (must be DISPUTED)', () => {
      const session = new NegotiationSession(makeRFQ());
      const quote = { quote_id: 'q1', rfq_id: session.rfqId, seller: { agent_id: 'did:key:z6MkSeller', endpoint: 'http://localhost:3000' }, pricing: { price_per_unit: '0.01', currency: 'USDC', unit: 'request', pricing_model: 'fixed' as const }, expires_at: new Date(Date.now() + 60000).toISOString(), signature: 'sig' };
      session.addQuote(quote as any);
      session.accept({ agreement_id: 'a1', rfq_id: session.rfqId, accepting_message_id: 'quote-001', final_terms: { price_per_unit: '0.01', currency: 'USDC', unit: 'request' }, agreement_hash: 'h', buyer_signature: 'bs', seller_signature: 'ss' });
      session.marginAssessed(makeMarginAssessment());
      session.escrowFunded('addr');
      session.activate();
      expect(() => session.resolve()).toThrow('ACTIVE');
    });

    it('full lifecycle: RFQ_SENT -> QUOTES_RECEIVED -> ACCEPTED -> MARGIN_ASSESSED -> ESCROWED -> ACTIVE -> DISPUTED -> RESOLVED', () => {
      const session = new NegotiationSession(makeRFQ());
      expect(session.state).toBe('RFQ_SENT');

      const quote = { quote_id: 'q1', rfq_id: session.rfqId, seller: { agent_id: 'did:key:z6MkSeller', endpoint: 'http://localhost:3000' }, pricing: { price_per_unit: '0.01', currency: 'USDC', unit: 'request', pricing_model: 'fixed' as const }, expires_at: new Date(Date.now() + 60000).toISOString(), signature: 'sig' };
      session.addQuote(quote as any);
      expect(session.state).toBe('QUOTES_RECEIVED');

      session.accept({ agreement_id: 'a1', rfq_id: session.rfqId, accepting_message_id: 'quote-001', final_terms: { price_per_unit: '0.01', currency: 'USDC', unit: 'request' }, agreement_hash: 'h', buyer_signature: 'bs', seller_signature: 'ss' });
      expect(session.state).toBe('ACCEPTED');

      session.marginAssessed(makeMarginAssessment());
      expect(session.state).toBe('MARGIN_ASSESSED');

      session.escrowFunded('escrow-address');
      expect(session.state).toBe('ESCROWED');

      session.activate();
      expect(session.state).toBe('ACTIVE');

      session.dispute();
      expect(session.state).toBe('DISPUTED');

      session.resolve();
      expect(session.state).toBe('RESOLVED');
    });

    it('full lifecycle: RFQ_SENT -> QUOTES_RECEIVED -> ACCEPTED -> MARGIN_ASSESSED -> ESCROWED -> ACTIVE -> COMPLETED', () => {
      const session = new NegotiationSession(makeRFQ());
      const quote = { quote_id: 'q1', rfq_id: session.rfqId, seller: { agent_id: 'did:key:z6MkSeller', endpoint: 'http://localhost:3000' }, pricing: { price_per_unit: '0.01', currency: 'USDC', unit: 'request', pricing_model: 'fixed' as const }, expires_at: new Date(Date.now() + 60000).toISOString(), signature: 'sig' };
      session.addQuote(quote as any);
      session.accept({ agreement_id: 'a1', rfq_id: session.rfqId, accepting_message_id: 'quote-001', final_terms: { price_per_unit: '0.01', currency: 'USDC', unit: 'request' }, agreement_hash: 'h', buyer_signature: 'bs', seller_signature: 'ss' });
      session.marginAssessed(makeMarginAssessment());
      session.escrowFunded('escrow-address');
      session.activate();
      session.complete();
      expect(session.state).toBe('COMPLETED');
    });
  });

  describe('error code verification', () => {
    it('invalid transition throws OphirError with INVALID_STATE_TRANSITION code', () => {
      const session = new NegotiationSession(makeRFQ());
      try {
        session.complete();
        expect.fail('should have thrown');
      } catch (e: unknown) {
        const err = e as { code: string; data: Record<string, unknown> };
        expect(err.code).toBe('OPHIR_004');
        expect(err.data).toHaveProperty('currentState', 'RFQ_SENT');
        expect(err.data).toHaveProperty('targetState');
      }
    });

    it('max rounds exceeded throws OphirError with MAX_ROUNDS_EXCEEDED code', () => {
      const session = new NegotiationSession(makeRFQ(), 1);
      const quote = { quote_id: 'q1', rfq_id: session.rfqId, seller: { agent_id: 'did:key:z6MkSeller', endpoint: 'http://localhost:3000' }, pricing: { price_per_unit: '0.01', currency: 'USDC', unit: 'request', pricing_model: 'fixed' as const }, expires_at: new Date(Date.now() + 60000).toISOString(), signature: 'sig' };
      session.addQuote(quote as any);
      session.addCounter({ counter_id: 'c1', rfq_id: session.rfqId, in_response_to: 'q1', round: 1, from: { agent_id: 'did:key:z6MkTest', role: 'buyer' }, modifications: {}, expires_at: new Date(Date.now() + 60000).toISOString(), signature: 'sig' } as any);
      try {
        session.addCounter({ counter_id: 'c2', rfq_id: session.rfqId, in_response_to: 'q1', round: 2, from: { agent_id: 'did:key:z6MkTest', role: 'buyer' }, modifications: {}, expires_at: new Date(Date.now() + 60000).toISOString(), signature: 'sig' } as any);
        expect.fail('should have thrown');
      } catch (e: unknown) {
        const err = e as { code: string };
        expect(err.code).toBe('OPHIR_005');
      }
    });
  });

  describe('getEscrowAddress', () => {
    it('returns undefined before escrow is funded', () => {
      const session = new NegotiationSession(makeRFQ());
      expect(session.getEscrowAddress()).toBeUndefined();
    });

    it('returns address after escrow is funded', () => {
      const session = new NegotiationSession(makeRFQ());
      const quote = { quote_id: 'q1', rfq_id: session.rfqId, seller: { agent_id: 'did:key:z6MkSeller', endpoint: 'http://localhost:3000' }, pricing: { price_per_unit: '0.01', currency: 'USDC', unit: 'request', pricing_model: 'fixed' as const }, expires_at: new Date(Date.now() + 60000).toISOString(), signature: 'sig' };
      session.addQuote(quote as any);
      session.accept({ agreement_id: 'a1', rfq_id: session.rfqId, accepting_message_id: 'quote-001', final_terms: { price_per_unit: '0.01', currency: 'USDC', unit: 'request' }, agreement_hash: 'h', buyer_signature: 'bs', seller_signature: 'ss' });
      session.marginAssessed(makeMarginAssessment());
      session.escrowFunded('3xj4Y7qnPETiQwNmfUZgk5GsrFMz1Yk8LgMpRbJ7EfP');
      expect(session.getEscrowAddress()).toBe('3xj4Y7qnPETiQwNmfUZgk5GsrFMz1Yk8LgMpRbJ7EfP');
    });
  });

  describe('isTerminal', () => {
    it('returns false for non-terminal states', () => {
      const session = new NegotiationSession(makeRFQ());
      expect(session.isTerminal()).toBe(false); // RFQ_SENT
      session.addQuote(makeQuote());
      expect(session.isTerminal()).toBe(false); // QUOTES_RECEIVED
    });

    it('returns true for REJECTED', () => {
      const session = new NegotiationSession(makeRFQ());
      session.reject('no thanks');
      expect(session.isTerminal()).toBe(true);
    });

    it('returns true for COMPLETED', () => {
      const session = new NegotiationSession(makeRFQ());
      session.addQuote(makeQuote());
      session.accept(makeAgreement());
      session.marginAssessed(makeMarginAssessment());
      session.escrowFunded('addr');
      session.activate();
      session.complete();
      expect(session.isTerminal()).toBe(true);
    });

    it('returns true for RESOLVED', () => {
      const session = new NegotiationSession(makeRFQ());
      session.addQuote(makeQuote());
      session.accept(makeAgreement());
      session.marginAssessed(makeMarginAssessment());
      session.escrowFunded('addr');
      session.activate();
      session.dispute();
      session.resolve();
      expect(session.isTerminal()).toBe(true);
    });
  });

  describe('getValidNextStates', () => {
    it('returns valid next states from RFQ_SENT', () => {
      const session = new NegotiationSession(makeRFQ());
      const next = session.getValidNextStates();
      expect(next).toContain('QUOTES_RECEIVED');
      expect(next).toContain('REJECTED');
      expect(next).not.toContain('ACCEPTED');
    });

    it('returns empty array from terminal state', () => {
      const session = new NegotiationSession(makeRFQ());
      session.reject('done');
      expect(session.getValidNextStates()).toHaveLength(0);
    });

    it('returns correct transitions from ACTIVE', () => {
      const session = new NegotiationSession(makeRFQ());
      session.addQuote(makeQuote());
      session.accept(makeAgreement());
      session.marginAssessed(makeMarginAssessment());
      session.escrowFunded('addr');
      session.activate();
      const next = session.getValidNextStates();
      expect(next).toContain('COMPLETED');
      expect(next).toContain('DISPUTED');
      expect(next).toHaveLength(2);
    });
  });
});
