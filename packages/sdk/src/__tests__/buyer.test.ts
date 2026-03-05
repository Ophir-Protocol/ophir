import { describe, it, expect, afterEach } from 'vitest';
import { BuyerAgent } from '../buyer.js';
import { generateKeyPair, publicKeyToDid, didToPublicKey } from '../identity.js';
import { signMessage, verifyMessage, agreementHash } from '../signing.js';
import { buildCounter } from '../messages.js';
import { NegotiationSession } from '../negotiation.js';
import type { QuoteParams, CounterParams, RFQParams } from '@ophir/protocol';

/** Create a valid signed RFQ for constructing NegotiationSession directly. */
function makeRFQ(overrides?: Partial<RFQParams>): RFQParams {
  const buyerKp = generateKeyPair();
  const buyerDid = publicKeyToDid(buyerKp.publicKey);
  const unsigned = {
    rfq_id: crypto.randomUUID(),
    buyer: { agent_id: buyerDid, endpoint: 'http://localhost:3001' },
    service: { category: 'inference' },
    budget: { max_price_per_unit: '1.00', currency: 'USDC', unit: 'request' },
    negotiation_style: 'rfq' as const,
    expires_at: new Date(Date.now() + 300_000).toISOString(),
    ...overrides,
  };
  const { signature: _existingSig, ...toSign } = unsigned as RFQParams;
  const signature = signMessage(toSign, buyerKp.secretKey);
  return { ...toSign, signature };
}

/** Create a QuoteParams with sensible defaults, optionally signed with a real key. */
function makeQuote(overrides: Partial<QuoteParams> & { rfq_id: string }): QuoteParams {
  return {
    quote_id: `quote-${Math.random().toString(36).slice(2, 8)}`,
    rfq_id: overrides.rfq_id,
    seller: overrides.seller ?? {
      agent_id: 'did:key:zSeller1',
      endpoint: 'http://localhost:9000',
    },
    pricing: overrides.pricing ?? {
      price_per_unit: '0.01',
      currency: 'USDC',
      unit: 'request',
      pricing_model: 'fixed',
    },
    sla_offered: overrides.sla_offered,
    expires_at: overrides.expires_at ?? new Date(Date.now() + 120_000).toISOString(),
    signature: overrides.signature ?? 'fake-sig',
  };
}

/** Create a properly signed quote from a real keypair. */
function makeSignedQuote(
  rfqId: string,
  sellerKp: { publicKey: Uint8Array; secretKey: Uint8Array },
  overrides?: Partial<QuoteParams>,
): QuoteParams {
  const sellerDid = publicKeyToDid(sellerKp.publicKey);
  const unsigned = {
    quote_id: crypto.randomUUID(),
    rfq_id: rfqId,
    seller: {
      agent_id: sellerDid,
      endpoint: 'http://localhost:9000',
    },
    pricing: overrides?.pricing ?? {
      price_per_unit: '0.01',
      currency: 'USDC',
      unit: 'request',
      pricing_model: 'fixed' as const,
    },
    sla_offered: overrides?.sla_offered,
    expires_at: overrides?.expires_at ?? new Date(Date.now() + 120_000).toISOString(),
  };
  const signature = signMessage(unsigned, sellerKp.secretKey);
  return { ...unsigned, signature };
}

describe('BuyerAgent', () => {
  let agent: BuyerAgent | undefined;

  afterEach(async () => {
    if (agent) {
      await agent.close();
      agent = undefined;
    }
  });

  // ── Constructor ──────────────────────────────────────────────────

  describe('constructor', () => {
    it('auto-generates keypair and DID when no keypair provided', () => {
      agent = new BuyerAgent({ endpoint: 'http://localhost:3001' });

      const agentId = agent.getAgentId();
      expect(agentId).toMatch(/^did:key:z/);

      const pubKey = didToPublicKey(agentId);
      expect(pubKey).toBeInstanceOf(Uint8Array);
      expect(pubKey.length).toBe(32);
    });

    it('uses provided keypair and derives correct DID', () => {
      const kp = generateKeyPair();
      agent = new BuyerAgent({ keypair: kp, endpoint: 'http://localhost:3001' });

      const pubKey = didToPublicKey(agent.getAgentId());
      expect(Buffer.from(pubKey)).toEqual(Buffer.from(kp.publicKey));
    });

    it('stores endpoint correctly', () => {
      agent = new BuyerAgent({ endpoint: 'http://localhost:5555' });
      expect(agent.getEndpoint()).toBe('http://localhost:5555');
    });
  });

  // ── rankQuotes ───────────────────────────────────────────────────

  describe('rankQuotes', () => {
    const rfqId = 'rfq-rank-test';

    const cheapQuote = makeQuote({
      rfq_id: rfqId,
      pricing: { price_per_unit: '0.005', currency: 'USDC', unit: 'request', pricing_model: 'fixed' },
      sla_offered: {
        metrics: [
          { name: 'p99_latency_ms', target: 1000, comparison: 'lte' },
          { name: 'uptime_pct', target: 99.0, comparison: 'gte' },
        ],
      },
    });

    const midQuote = makeQuote({
      rfq_id: rfqId,
      pricing: { price_per_unit: '0.010', currency: 'USDC', unit: 'request', pricing_model: 'fixed' },
      sla_offered: {
        metrics: [
          { name: 'p99_latency_ms', target: 200, comparison: 'lte' },
          { name: 'uptime_pct', target: 99.9, comparison: 'gte' },
        ],
      },
    });

    const expensiveQuote = makeQuote({
      rfq_id: rfqId,
      pricing: { price_per_unit: '0.050', currency: 'USDC', unit: 'request', pricing_model: 'fixed' },
      sla_offered: {
        metrics: [
          { name: 'p99_latency_ms', target: 50, comparison: 'lte' },
          { name: 'uptime_pct', target: 99.99, comparison: 'gte' },
          { name: 'accuracy_pct', target: 99.5, comparison: 'gte' },
        ],
      },
    });

    it('sorts by cheapest by default', () => {
      agent = new BuyerAgent({ endpoint: 'http://localhost:3001' });
      const ranked = agent.rankQuotes([expensiveQuote, cheapQuote, midQuote]);

      expect(ranked[0].pricing.price_per_unit).toBe('0.005');
      expect(ranked[1].pricing.price_per_unit).toBe('0.010');
      expect(ranked[2].pricing.price_per_unit).toBe('0.050');
    });

    it('sorts by cheapest handles string prices correctly', () => {
      agent = new BuyerAgent({ endpoint: 'http://localhost:3001' });
      const q1 = makeQuote({
        rfq_id: rfqId,
        pricing: { price_per_unit: '10.00', currency: 'USDC', unit: 'request', pricing_model: 'fixed' },
      });
      const q2 = makeQuote({
        rfq_id: rfqId,
        pricing: { price_per_unit: '2.50', currency: 'USDC', unit: 'request', pricing_model: 'fixed' },
      });
      const q3 = makeQuote({
        rfq_id: rfqId,
        pricing: { price_per_unit: '0.0001', currency: 'USDC', unit: 'request', pricing_model: 'fixed' },
      });

      // Ensure numeric comparison, not lexicographic ("10.00" < "2.50" lexicographically)
      const ranked = agent.rankQuotes([q1, q2, q3], 'cheapest');
      expect(ranked[0].pricing.price_per_unit).toBe('0.0001');
      expect(ranked[1].pricing.price_per_unit).toBe('2.50');
      expect(ranked[2].pricing.price_per_unit).toBe('10.00');
    });

    it('sorts by fastest (p99 latency)', () => {
      agent = new BuyerAgent({ endpoint: 'http://localhost:3001' });
      const ranked = agent.rankQuotes([cheapQuote, midQuote, expensiveQuote], 'fastest');

      // p99: expensive=50, mid=200, cheap=1000
      expect(ranked[0].pricing.price_per_unit).toBe('0.050');
      expect(ranked[1].pricing.price_per_unit).toBe('0.010');
      expect(ranked[2].pricing.price_per_unit).toBe('0.005');
    });

    it('sorts by best_sla (more metrics = higher score)', () => {
      agent = new BuyerAgent({ endpoint: 'http://localhost:3001' });
      const ranked = agent.rankQuotes([cheapQuote, midQuote, expensiveQuote], 'best_sla');

      // expensiveQuote has best metrics: lowest latency, highest uptime, plus accuracy
      expect(ranked[0].pricing.price_per_unit).toBe('0.050');
    });

    it('sorts with custom ranking function', () => {
      agent = new BuyerAgent({ endpoint: 'http://localhost:3001' });
      // Sort by price descending
      const ranked = agent.rankQuotes(
        [cheapQuote, midQuote, expensiveQuote],
        (a, b) => parseFloat(b.pricing.price_per_unit) - parseFloat(a.pricing.price_per_unit),
      );

      expect(ranked[0].pricing.price_per_unit).toBe('0.050');
      expect(ranked[2].pricing.price_per_unit).toBe('0.005');
    });

    it('returns empty array for empty input', () => {
      agent = new BuyerAgent({ endpoint: 'http://localhost:3001' });
      const ranked = agent.rankQuotes([]);
      expect(ranked).toEqual([]);
    });

    it('handles quotes with no SLA in fastest ranking', () => {
      agent = new BuyerAgent({ endpoint: 'http://localhost:3001' });
      const noSlaQuote = makeQuote({
        rfq_id: rfqId,
        pricing: { price_per_unit: '0.001', currency: 'USDC', unit: 'request', pricing_model: 'fixed' },
      });
      const ranked = agent.rankQuotes([noSlaQuote, expensiveQuote], 'fastest');
      // expensiveQuote has p99=50, noSlaQuote has no SLA so Infinity
      expect(ranked[0].pricing.price_per_unit).toBe('0.050');
      expect(ranked[1].pricing.price_per_unit).toBe('0.001');
    });

    it('does not modify original array', () => {
      agent = new BuyerAgent({ endpoint: 'http://localhost:3001' });
      const original = [expensiveQuote, cheapQuote, midQuote];
      const originalCopy = [...original];
      const ranked = agent.rankQuotes(original);

      // The returned array should be sorted (cheapest first)
      expect(ranked[0].pricing.price_per_unit).toBe('0.005');

      // The original array must be untouched
      expect(original).toEqual(originalCopy);
      expect(original[0]).toBe(expensiveQuote);
      expect(ranked).not.toBe(original);
    });

    it('single quote returns array with that quote', () => {
      agent = new BuyerAgent({ endpoint: 'http://localhost:3001' });
      const ranked = agent.rankQuotes([midQuote]);
      expect(ranked).toHaveLength(1);
      expect(ranked[0]).toBe(midQuote);
    });
  });

  // ── requestQuotes ────────────────────────────────────────────────

  describe('requestQuotes', () => {
    it('creates a session with correct state RFQ_SENT', async () => {
      agent = new BuyerAgent({ endpoint: 'http://localhost:3001' });

      const session = await agent.requestQuotes({
        sellers: ['http://localhost:19999'],
        service: { category: 'inference', description: 'LLM inference' },
        budget: { max_price_per_unit: '0.10', currency: 'USDC', unit: 'request' },
      });

      expect(session).toBeDefined();
      expect(session.rfqId).toBeDefined();
      expect(session.state).toBe('RFQ_SENT');
      expect(session.rfq.buyer.agent_id).toBe(agent.getAgentId());
      expect(session.rfq.service.category).toBe('inference');
    });

    it('sets session state to RFQ_SENT even if seller is unreachable', async () => {
      agent = new BuyerAgent({ endpoint: 'http://localhost:3001' });

      const session = await agent.requestQuotes({
        sellers: ['http://localhost:19999', 'http://localhost:19998'],
        service: { category: 'inference' },
        budget: { max_price_per_unit: '0.10', currency: 'USDC', unit: 'request' },
      });

      expect(session.state).toBe('RFQ_SENT');
      expect(agent.getSession(session.rfqId)).toBe(session);
    });

    it('accepts SellerInfo objects as sellers', async () => {
      agent = new BuyerAgent({ endpoint: 'http://localhost:3001' });

      const session = await agent.requestQuotes({
        sellers: [
          { agentId: 'did:key:zSeller1', endpoint: 'http://localhost:19998', services: [] },
        ],
        service: { category: 'translation' },
        budget: { max_price_per_unit: '0.05', currency: 'USDC', unit: 'request' },
      });

      expect(session.state).toBe('RFQ_SENT');
      expect(session.rfq.service.category).toBe('translation');
    });

    it('includes SLA requirements in RFQ', async () => {
      agent = new BuyerAgent({ endpoint: 'http://localhost:3001' });

      const session = await agent.requestQuotes({
        sellers: ['http://localhost:19999'],
        service: { category: 'inference' },
        budget: { max_price_per_unit: '0.10', currency: 'USDC', unit: 'request' },
        sla: {
          metrics: [
            { name: 'uptime_pct', target: 99.9, comparison: 'gte' },
            { name: 'p99_latency_ms', target: 500, comparison: 'lte' },
          ],
          dispute_resolution: { method: 'lockstep_verification', timeout_hours: 24 },
        },
      });

      expect(session.rfq.sla_requirements).toBeDefined();
      expect(session.rfq.sla_requirements!.metrics).toHaveLength(2);
    });
  });

  // ── acceptQuote ──────────────────────────────────────────────────

  describe('acceptQuote', () => {
    it('computes valid agreement_hash from final terms', async () => {
      const buyerKp = generateKeyPair();
      const sellerKp = generateKeyPair();
      agent = new BuyerAgent({ keypair: buyerKp, endpoint: 'http://localhost:3001' });

      const session = await agent.requestQuotes({
        sellers: ['http://localhost:19999'],
        service: { category: 'inference' },
        budget: { max_price_per_unit: '1.00', currency: 'USDC', unit: 'request' },
      });

      const quote = makeSignedQuote(session.rfqId, sellerKp, {
        pricing: { price_per_unit: '0.05', currency: 'USDC', unit: 'request', pricing_model: 'fixed' },
        sla_offered: { metrics: [{ name: 'uptime_pct', target: 99.9, comparison: 'gte' }] },
      });
      session.addQuote(quote);

      const agreement = await agent.acceptQuote(quote);

      const expectedHash = agreementHash(agreement.final_terms);
      expect(agreement.agreement_hash).toBe(expectedHash);
      expect(agreement.agreement_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('signs with buyer key and signature is verifiable', async () => {
      const buyerKp = generateKeyPair();
      const sellerKp = generateKeyPair();
      agent = new BuyerAgent({ keypair: buyerKp, endpoint: 'http://localhost:3001' });

      const session = await agent.requestQuotes({
        sellers: ['http://localhost:19999'],
        service: { category: 'inference' },
        budget: { max_price_per_unit: '1.00', currency: 'USDC', unit: 'request' },
      });

      const quote = makeSignedQuote(session.rfqId, sellerKp, {
        pricing: { price_per_unit: '0.05', currency: 'USDC', unit: 'request', pricing_model: 'fixed' },
      });
      session.addQuote(quote);

      const agreement = await agent.acceptQuote(quote);

      expect(agreement.buyer_signature).toBeDefined();
      expect(agreement.buyer_signature.length).toBeGreaterThan(0);
      expect(agreement.agreement_id).toBeDefined();
      expect(agreement.rfq_id).toBe(session.rfqId);
      expect(agreement.final_terms.price_per_unit).toBe('0.05');
      expect(agreement.final_terms.currency).toBe('USDC');
    });

    it('transitions session to ACCEPTED', async () => {
      const buyerKp = generateKeyPair();
      const sellerKp = generateKeyPair();
      agent = new BuyerAgent({ keypair: buyerKp, endpoint: 'http://localhost:3001' });

      const session = await agent.requestQuotes({
        sellers: ['http://localhost:19999'],
        service: { category: 'inference' },
        budget: { max_price_per_unit: '1.00', currency: 'USDC', unit: 'request' },
      });

      const quote = makeSignedQuote(session.rfqId, sellerKp);
      session.addQuote(quote);

      await agent.acceptQuote(quote);

      expect(session.state).toBe('ACCEPTED');
      expect(session.agreement).toBeDefined();
    });

    it('rejects quote with invalid seller signature', async () => {
      const buyerKp = generateKeyPair();
      const sellerKp = generateKeyPair();
      agent = new BuyerAgent({ keypair: buyerKp, endpoint: 'http://localhost:3001' });

      const session = await agent.requestQuotes({
        sellers: ['http://localhost:19999'],
        service: { category: 'inference' },
        budget: { max_price_per_unit: '1.00', currency: 'USDC', unit: 'request' },
      });

      const quote = makeSignedQuote(session.rfqId, sellerKp);
      // Tamper with quote data after signing — signature won't match
      const tamperedQuote = { ...quote, pricing: { ...quote.pricing, price_per_unit: '999.00' } };
      session.addQuote(tamperedQuote);

      await expect(agent.acceptQuote(tamperedQuote)).rejects.toThrow('seller signature is invalid');
    });

    it('rejects quote signed by wrong keypair', async () => {
      const buyerKp = generateKeyPair();
      const signerKp = generateKeyPair();
      const imposterKp = generateKeyPair();
      agent = new BuyerAgent({ keypair: buyerKp, endpoint: 'http://localhost:3001' });

      const session = await agent.requestQuotes({
        sellers: ['http://localhost:19999'],
        service: { category: 'inference' },
        budget: { max_price_per_unit: '1.00', currency: 'USDC', unit: 'request' },
      });

      // Sign with signerKp but claim the seller DID belongs to imposterKp
      const quote = makeSignedQuote(session.rfqId, signerKp);
      const wrongDidQuote: QuoteParams = {
        ...quote,
        seller: {
          agent_id: publicKeyToDid(imposterKp.publicKey),
          endpoint: 'http://localhost:9000',
        },
      };
      session.addQuote(wrongDidQuote);

      await expect(agent.acceptQuote(wrongDidQuote)).rejects.toThrow('seller signature is invalid');
    });
  });

  // ── signature verification ─────────────────────────────────────

  describe('signature verification', () => {
    it('verifies seller signature on incoming quotes via handler', async () => {
      const buyerKp = generateKeyPair();
      agent = new BuyerAgent({ keypair: buyerKp, endpoint: 'http://localhost:0' });

      const session = await agent.requestQuotes({
        sellers: ['http://localhost:19999'],
        service: { category: 'inference' },
        budget: { max_price_per_unit: '1.00', currency: 'USDC', unit: 'request' },
      });

      await agent.listen(0);
      const port = new URL(agent.getEndpoint()).port;

      // Build a quote with a bad signature
      const sellerKp = generateKeyPair();
      const sellerDid = publicKeyToDid(sellerKp.publicKey);
      const badQuote: QuoteParams = {
        quote_id: crypto.randomUUID(),
        rfq_id: session.rfqId,
        seller: { agent_id: sellerDid, endpoint: 'http://localhost:9000' },
        pricing: { price_per_unit: '0.01', currency: 'USDC', unit: 'request', pricing_model: 'fixed' },
        expires_at: new Date(Date.now() + 120_000).toISOString(),
        signature: Buffer.alloc(64, 0xff).toString('base64'), // valid format, wrong key
      };

      const response = await fetch(`http://localhost:${port}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'negotiate/quote',
          params: badQuote,
          id: 'sig-test-1',
        }),
      });

      const json = await response.json();
      expect(json.error).toBeDefined();
      expect(json.error.message).toContain('Invalid signature');

      // The quote should NOT have been added to the session
      expect(session.quotes).toHaveLength(0);
    });

    it('verifies counter-party signature on incoming counters', async () => {
      const buyerKp = generateKeyPair();
      agent = new BuyerAgent({ keypair: buyerKp, endpoint: 'http://localhost:0' });

      const session = await agent.requestQuotes({
        sellers: ['http://localhost:19999'],
        service: { category: 'inference' },
        budget: { max_price_per_unit: '1.00', currency: 'USDC', unit: 'request' },
      });

      // Add a quote so session is in a state that can receive counters
      const sellerKp = generateKeyPair();
      const quote = makeSignedQuote(session.rfqId, sellerKp);
      session.addQuote(quote);

      await agent.listen(0);
      const port = new URL(agent.getEndpoint()).port;

      // Build a counter claiming to be from the known seller but signed by the wrong key.
      // This gets past the "known seller" check but fails signature verification.
      const wrongSignerKp = generateKeyPair();

      const counterMsg = buildCounter({
        rfqId: session.rfqId,
        inResponseTo: quote.quote_id,
        round: 1,
        from: { agent_id: publicKeyToDid(sellerKp.publicKey), role: 'seller' },
        modifications: { price_per_unit: '0.02' },
        secretKey: wrongSignerKp.secretKey, // signed by the wrong key
      });

      const response = await fetch(`http://localhost:${port}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'negotiate/counter',
          params: counterMsg.params,
          id: 'sig-test-2',
        }),
      });

      const json = await response.json();
      expect(json.error).toBeDefined();
      expect(json.error.message).toContain('Invalid signature');
    });
  });

  // ── counter ──────────────────────────────────────────────────────

  describe('counter', () => {
    it('creates counter with correct round number', async () => {
      const buyerKp = generateKeyPair();
      agent = new BuyerAgent({ keypair: buyerKp, endpoint: 'http://localhost:3001' });

      const session = await agent.requestQuotes({
        sellers: ['http://localhost:19999'],
        service: { category: 'inference' },
        budget: { max_price_per_unit: '1.00', currency: 'USDC', unit: 'request' },
      });

      const quote = makeQuote({
        rfq_id: session.rfqId,
        pricing: { price_per_unit: '0.10', currency: 'USDC', unit: 'request', pricing_model: 'fixed' },
      });
      session.addQuote(quote);

      const updatedSession = await agent.counter(
        quote,
        { price_per_unit: '0.07' },
        'Price too high',
      );

      expect(updatedSession.state).toBe('COUNTERING');
      expect(updatedSession.currentRound).toBe(1);
      expect(updatedSession.counters).toHaveLength(1);
      expect(updatedSession.counters[0].round).toBe(1);
      expect(updatedSession.counters[0].from.role).toBe('buyer');
    });

    it('throws for unknown session', async () => {
      agent = new BuyerAgent({ endpoint: 'http://localhost:3001' });

      const quote = makeQuote({ rfq_id: 'unknown-rfq' });

      await expect(
        agent.counter(quote, { price: '0.01' }),
      ).rejects.toThrow(/No active session/);
    });
  });

  // ── reject ───────────────────────────────────────────────────────

  describe('reject', () => {
    it('transitions session to REJECTED', async () => {
      agent = new BuyerAgent({ endpoint: 'http://localhost:3001' });

      const session = await agent.requestQuotes({
        sellers: ['http://localhost:19999'],
        service: { category: 'inference' },
        budget: { max_price_per_unit: '1.00', currency: 'USDC', unit: 'request' },
      });

      await agent.reject(session, 'Too expensive');

      expect(session.state).toBe('REJECTED');
      expect(session.rejectionReason).toBe('Too expensive');
    });

    it('uses default reason when none provided', async () => {
      agent = new BuyerAgent({ endpoint: 'http://localhost:3001' });

      const session = await agent.requestQuotes({
        sellers: ['http://localhost:19999'],
        service: { category: 'inference' },
        budget: { max_price_per_unit: '1.00', currency: 'USDC', unit: 'request' },
      });

      await agent.reject(session);

      expect(session.state).toBe('REJECTED');
      expect(session.rejectionReason).toBe('Rejected by buyer');
    });
  });

  // ── listen / close ───────────────────────────────────────────────

  describe('listen and close', () => {
    it('starts server and close stops it', async () => {
      agent = new BuyerAgent({ endpoint: 'http://localhost:0' });

      await agent.listen(0);

      const endpoint = agent.getEndpoint();
      const port = new URL(endpoint).port;

      // Verify server is listening by sending a request
      const response = await fetch(`http://localhost:${port}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'negotiate/unknown',
          params: {},
          id: 'test-1',
        }),
      });
      expect(response.ok).toBe(true);
      const json = await response.json();
      expect(json.error.message).toContain('Method not found');

      await agent.close();
      agent = undefined;

      // After close, server should not respond
      await expect(
        fetch(`http://localhost:${port}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'test', params: {}, id: 'test-2' }),
        }),
      ).rejects.toThrow();
    });
  });

  // ── Session management ───────────────────────────────────────────

  describe('session management', () => {
    it('getSession returns undefined for unknown rfqId', () => {
      agent = new BuyerAgent({ endpoint: 'http://localhost:3001' });
      expect(agent.getSession('nonexistent')).toBeUndefined();
    });

    it('getSessions returns empty array initially', () => {
      agent = new BuyerAgent({ endpoint: 'http://localhost:3001' });
      expect(agent.getSessions()).toHaveLength(0);
    });

    it('multiple sessions can exist simultaneously', async () => {
      agent = new BuyerAgent({ endpoint: 'http://localhost:3001' });

      const session1 = await agent.requestQuotes({
        sellers: ['http://localhost:19999'],
        service: { category: 'inference' },
        budget: { max_price_per_unit: '1.00', currency: 'USDC', unit: 'request' },
      });

      const session2 = await agent.requestQuotes({
        sellers: ['http://localhost:19998'],
        service: { category: 'translation' },
        budget: { max_price_per_unit: '0.50', currency: 'USDC', unit: 'request' },
      });

      const session3 = await agent.requestQuotes({
        sellers: ['http://localhost:19997'],
        service: { category: 'data_processing' },
        budget: { max_price_per_unit: '0.25', currency: 'USDC', unit: 'request' },
      });

      expect(agent.getSessions()).toHaveLength(3);
      expect(agent.getSession(session1.rfqId)).toBe(session1);
      expect(agent.getSession(session2.rfqId)).toBe(session2);
      expect(agent.getSession(session3.rfqId)).toBe(session3);

      // Each session is independent
      expect(session1.rfq.service.category).toBe('inference');
      expect(session2.rfq.service.category).toBe('translation');
      expect(session3.rfq.service.category).toBe('data_processing');
    });
  });

  // ── discover ─────────────────────────────────────────────────────

  describe('discover', () => {
    it('returns empty array (stub)', async () => {
      agent = new BuyerAgent({ endpoint: 'http://localhost:3001' });
      const sellers = await agent.discover({ category: 'inference' });
      expect(sellers).toEqual([]);
    });
  });

  // ── buyer signing verification ──────────────────────────────────

  describe('buyer signing verification', () => {
    it('buyer signs RFQ with its own key', async () => {
      const buyerKp = generateKeyPair();
      agent = new BuyerAgent({ keypair: buyerKp, endpoint: 'http://localhost:3001' });

      const session = await agent.requestQuotes({
        sellers: ['http://localhost:19999'],
        service: { category: 'inference' },
        budget: { max_price_per_unit: '1.00', currency: 'USDC', unit: 'request' },
      });

      expect(session.rfq.signature).toBeDefined();

      // Strip the signature field to get the unsigned params
      const { signature, ...unsigned } = session.rfq;
      const isValid = verifyMessage(unsigned, signature!, buyerKp.publicKey);
      expect(isValid).toBe(true);
    });

    it('buyer signs reject with its own key', async () => {
      const buyerKp = generateKeyPair();
      agent = new BuyerAgent({ keypair: buyerKp, endpoint: 'http://localhost:3001' });

      const session = await agent.requestQuotes({
        sellers: ['http://localhost:19999'],
        service: { category: 'inference' },
        budget: { max_price_per_unit: '1.00', currency: 'USDC', unit: 'request' },
      });

      expect(session.state).toBe('RFQ_SENT');

      await agent.reject(session, 'too expensive');

      expect(session.state).toBe('REJECTED');
      expect(session.rejectionReason).toBe('too expensive');
    });

    it('buyer verifies seller quote signature before accepting', async () => {
      const buyerKp = generateKeyPair();
      const sellerKp = generateKeyPair();
      agent = new BuyerAgent({ keypair: buyerKp, endpoint: 'http://localhost:3001' });

      const session = await agent.requestQuotes({
        sellers: ['http://localhost:19999'],
        service: { category: 'inference' },
        budget: { max_price_per_unit: '1.00', currency: 'USDC', unit: 'request' },
      });

      const quote = makeSignedQuote(session.rfqId, sellerKp, {
        pricing: { price_per_unit: '0.05', currency: 'USDC', unit: 'request', pricing_model: 'fixed' },
      });
      session.addQuote(quote);

      const agreement = await agent.acceptQuote(quote);

      expect(agreement).toBeDefined();
      expect(agreement.rfq_id).toBe(session.rfqId);
      expect(session.state).toBe('ACCEPTED');
    });

    it('buyer rejects quote with invalid signature from imposter key', async () => {
      const buyerKp = generateKeyPair();
      const realSellerKp = generateKeyPair();
      const imposterKp = generateKeyPair();
      agent = new BuyerAgent({ keypair: buyerKp, endpoint: 'http://localhost:3001' });

      const session = await agent.requestQuotes({
        sellers: ['http://localhost:19999'],
        service: { category: 'inference' },
        budget: { max_price_per_unit: '1.00', currency: 'USDC', unit: 'request' },
      });

      // Create a quote claiming to be from realSeller but signed by imposter
      const sellerDid = publicKeyToDid(realSellerKp.publicKey);
      const unsigned = {
        quote_id: crypto.randomUUID(),
        rfq_id: session.rfqId,
        seller: { agent_id: sellerDid, endpoint: 'http://localhost:9000' },
        pricing: { price_per_unit: '0.05', currency: 'USDC', unit: 'request', pricing_model: 'fixed' as const },
        expires_at: new Date(Date.now() + 120_000).toISOString(),
      };
      const badSig = signMessage(unsigned, imposterKp.secretKey);
      const badQuote: QuoteParams = { ...unsigned, signature: badSig };
      session.addQuote(badQuote);

      // This quote has an invalid signature — signed by wrong key
      await expect(agent.acceptQuote(badQuote)).rejects.toThrow('seller signature is invalid');
    });

    it('buyer rejects quote with forged seller DID', async () => {
      const buyerKp = generateKeyPair();
      const signerKp = generateKeyPair();
      const forgedKp = generateKeyPair();
      agent = new BuyerAgent({ keypair: buyerKp, endpoint: 'http://localhost:3001' });

      const session = await agent.requestQuotes({
        sellers: ['http://localhost:19999'],
        service: { category: 'inference' },
        budget: { max_price_per_unit: '1.00', currency: 'USDC', unit: 'request' },
      });

      // Sign with signerKp but set seller.agent_id to forgedKp's DID
      const quote = makeSignedQuote(session.rfqId, signerKp);
      const forgedQuote: QuoteParams = {
        ...quote,
        seller: {
          agent_id: publicKeyToDid(forgedKp.publicKey),
          endpoint: 'http://localhost:9000',
        },
      };
      session.addQuote(forgedQuote);

      await expect(agent.acceptQuote(forgedQuote)).rejects.toThrow('seller signature is invalid');
    });
  });
});
