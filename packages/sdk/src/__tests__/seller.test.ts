import { describe, it, expect, afterEach } from 'vitest';
import { SellerAgent } from '../seller.js';
import type { ServiceOffering } from '../types.js';
import { verifyMessage, signMessage, agreementHash } from '../signing.js';
import { generateKeyPair, publicKeyToDid, didToPublicKey } from '../identity.js';
import type { RFQParams, QuoteParams } from '@ophir/protocol';
import type { AgentCard } from '../discovery.js';

const TEST_SERVICES: ServiceOffering[] = [
  {
    category: 'inference',
    description: 'LLM inference service',
    base_price: '0.01',
    currency: 'USDC',
    unit: 'request',
  },
  {
    category: 'translation',
    description: 'Multi-language translation',
    base_price: '0.005',
    currency: 'USDC',
    unit: 'request',
  },
];

/** Create a valid signed RFQ that passes Zod schema validation and signature verification. */
function makeValidRFQ(overrides?: Partial<RFQParams>, keypair?: { publicKey: Uint8Array; secretKey: Uint8Array }): RFQParams {
  const buyerKp = keypair ?? generateKeyPair();
  const buyerDid = publicKeyToDid(buyerKp.publicKey);
  const unsigned = {
    rfq_id: crypto.randomUUID(),
    buyer: { agent_id: buyerDid, endpoint: 'http://localhost:9999' },
    service: { category: 'inference' },
    budget: { max_price_per_unit: '1.00', currency: 'USDC', unit: 'request' },
    negotiation_style: 'rfq' as const,
    expires_at: new Date(Date.now() + 300_000).toISOString(),
    ...overrides,
  };
  // Remove any existing signature from overrides before signing
  const { signature: _existingSig, ...toSign } = unsigned as RFQParams;
  const signature = signMessage(toSign, buyerKp.secretKey);
  return { ...toSign, signature };
}

/** Send a JSON-RPC request to a local server and return the parsed response. */
async function jsonRpc(
  port: number,
  method: string,
  params: object,
): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  const res = await fetch(`http://localhost:${port}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: crypto.randomUUID() }),
  });
  return res.json();
}

describe('SellerAgent', () => {
  let agent: SellerAgent | undefined;

  afterEach(async () => {
    if (agent) {
      await agent.close();
      agent = undefined;
    }
  });

  // ── Constructor ──────────────────────────────────────────────────

  describe('constructor', () => {
    it('auto-generates keypair and DID when no keypair provided', () => {
      agent = new SellerAgent({
        endpoint: 'http://localhost:3000',
        services: TEST_SERVICES,
      });

      const agentId = agent.getAgentId();
      expect(agentId).toMatch(/^did:key:z/);

      const pubKey = didToPublicKey(agentId);
      expect(pubKey).toBeInstanceOf(Uint8Array);
      expect(pubKey.length).toBe(32);
    });

    it('DID starts with "did:key:z"', () => {
      agent = new SellerAgent({
        endpoint: 'http://localhost:3000',
        services: TEST_SERVICES,
      });
      expect(agent.getAgentId()).toMatch(/^did:key:z/);
    });

    it('uses provided keypair', () => {
      const kp = generateKeyPair();

      agent = new SellerAgent({
        keypair: kp,
        endpoint: 'http://localhost:3000',
        services: TEST_SERVICES,
      });

      const pubKey = didToPublicKey(agent.getAgentId());
      expect(Buffer.from(pubKey)).toEqual(Buffer.from(kp.publicKey));
    });

    it('defaults pricing strategy to fixed', () => {
      agent = new SellerAgent({
        endpoint: 'http://localhost:3000',
        services: TEST_SERVICES,
      });
      const quote = agent.generateQuote(makeValidRFQ());
      expect(quote).not.toBeNull();
      // Fixed strategy uses base_price directly: 0.01 → '0.0100'
      expect(quote!.pricing.price_per_unit).toBe('0.0100');
    });
  });

  // ── registerService ──────────────────────────────────────────────

  describe('registerService', () => {
    it('adds service to the offerings', () => {
      agent = new SellerAgent({
        endpoint: 'http://localhost:4000',
        services: TEST_SERVICES,
      });

      agent.registerService({
        category: 'code_review',
        description: 'AI code review',
        base_price: '0.05',
        currency: 'USDC',
        unit: 'review',
      });

      const card: AgentCard = agent.generateAgentCard();
      const neg = card.capabilities.negotiation;
      expect(neg!.services).toHaveLength(3);
      expect(neg!.services[2].category).toBe('code_review');
    });

    it('supports multiple services and quotes work for each', () => {
      agent = new SellerAgent({
        endpoint: 'http://localhost:4000',
        services: [TEST_SERVICES[0]],
      });

      agent.registerService({
        category: 'data_processing',
        description: 'Data processing',
        base_price: '0.02',
        currency: 'USDC',
        unit: 'MB',
      });

      // Quote for original service
      const q1 = agent.generateQuote(makeValidRFQ({ service: { category: 'inference' } }));
      expect(q1).not.toBeNull();
      expect(q1!.pricing.price_per_unit).toBe('0.0100');

      // Quote for newly added service
      const q2 = agent.generateQuote(makeValidRFQ({ service: { category: 'data_processing' } }));
      expect(q2).not.toBeNull();
      expect(q2!.pricing.price_per_unit).toBe('0.0200');
      expect(q2!.pricing.unit).toBe('MB');
    });
  });

  // ── generateAgentCard ────────────────────────────────────────────

  describe('generateAgentCard', () => {
    it('returns valid A2A-compatible agent card with negotiation capability', () => {
      agent = new SellerAgent({
        endpoint: 'http://localhost:3000',
        services: TEST_SERVICES,
      });

      const card: AgentCard = agent.generateAgentCard();
      const neg = card.capabilities.negotiation;

      expect(card.name).toBeDefined();
      expect(card.url).toBe('http://localhost:3000');
      expect(neg!.supported).toBe(true);
      expect(neg!.endpoint).toBe('http://localhost:3000');
      expect(neg!.protocols).toEqual(['ophir/1.0']);
      expect(neg!.acceptedPayments).toEqual([
        { network: 'solana', token: 'USDC' },
      ]);
      expect(neg!.negotiationStyles).toEqual(['rfq']);
      expect(neg!.maxNegotiationRounds).toBe(5);
    });

    it('lists all registered services', () => {
      agent = new SellerAgent({
        endpoint: 'http://localhost:3000',
        services: TEST_SERVICES,
      });

      const card: AgentCard = agent.generateAgentCard();
      const neg = card.capabilities.negotiation;
      expect(neg!.services).toHaveLength(2);
      expect(neg!.services[0].category).toBe('inference');
      expect(neg!.services[0].base_price).toBe('0.01');
      expect(neg!.services[1].category).toBe('translation');
    });
  });

  // ── generateQuote ────────────────────────────────────────────────

  describe('generateQuote', () => {
    it('produces signed quote for matching service', () => {
      agent = new SellerAgent({
        endpoint: 'http://localhost:4000',
        services: TEST_SERVICES,
      });

      const rfq = makeValidRFQ();
      const quote = agent.generateQuote(rfq);

      expect(quote).not.toBeNull();
      expect(quote!.rfq_id).toBe(rfq.rfq_id);
      expect(quote!.seller.agent_id).toBe(agent.getAgentId());
      expect(quote!.seller.endpoint).toBe('http://localhost:4000');
      expect(quote!.pricing.currency).toBe('USDC');
      expect(quote!.pricing.unit).toBe('request');
      expect(quote!.pricing.volume_discounts).toHaveLength(2);
      expect(quote!.sla_offered).toBeDefined();
      expect(quote!.signature).toBeDefined();
    });

    it('signature is verifiable with seller public key', () => {
      agent = new SellerAgent({
        endpoint: 'http://localhost:4000',
        services: TEST_SERVICES,
      });

      const quote = agent.generateQuote(makeValidRFQ())!;
      const { signature, ...unsigned } = quote;
      const pubKey = didToPublicKey(agent.getAgentId());
      expect(verifyMessage(unsigned, signature, pubKey)).toBe(true);
    });

    it('returns null for non-matching service category', () => {
      agent = new SellerAgent({
        endpoint: 'http://localhost:4000',
        services: TEST_SERVICES,
      });

      const quote = agent.generateQuote(makeValidRFQ({ service: { category: 'unknown-service' } }));
      expect(quote).toBeNull();
    });

    it('applies competitive pricing strategy (lower than base)', () => {
      agent = new SellerAgent({
        endpoint: 'http://localhost:4000',
        services: TEST_SERVICES,
        pricingStrategy: { type: 'competitive' },
      });

      const quote = agent.generateQuote(makeValidRFQ())!;
      // 0.01 * 0.9 = 0.009
      expect(quote.pricing.price_per_unit).toBe('0.0090');
      // Competitive should be strictly less than fixed base price
      expect(parseFloat(quote.pricing.price_per_unit)).toBeLessThan(0.01);
    });

    it('includes volume discounts at 1000+ and 10000+ units', () => {
      agent = new SellerAgent({
        endpoint: 'http://localhost:4000',
        services: TEST_SERVICES,
      });

      const quote = agent.generateQuote(makeValidRFQ())!;
      const discounts = quote.pricing.volume_discounts!;
      expect(discounts).toHaveLength(2);
      expect(discounts[0].min_units).toBe(1000);
      expect(discounts[1].min_units).toBe(10000);

      // 10% off at 1000+, 20% off at 10000+
      const basePrice = parseFloat(quote.pricing.price_per_unit);
      expect(parseFloat(discounts[0].price_per_unit)).toBeCloseTo(basePrice * 0.9, 4);
      expect(parseFloat(discounts[1].price_per_unit)).toBeCloseTo(basePrice * 0.8, 4);
    });
  });

  // ── listen / close ───────────────────────────────────────────────

  describe('listen and close', () => {
    it('starts server and close stops it', async () => {
      agent = new SellerAgent({
        endpoint: 'http://localhost:0',
        services: TEST_SERVICES,
      });

      await agent.listen(0);

      // Extract the actual port from the updated endpoint
      const endpoint = agent.getEndpoint();
      const port = new URL(endpoint).port;

      // Verify server is listening
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

  // ── Server handlers ──────────────────────────────────────────────

  describe('server handlers', () => {
    it('responds to negotiate/rfq with a quote', async () => {
      agent = new SellerAgent({
        endpoint: 'http://localhost:0',
        services: TEST_SERVICES,
      });
      await agent.listen(0);
      const port = parseInt(new URL(agent.getEndpoint()).port, 10);

      const rfq = makeValidRFQ();
      const res = await jsonRpc(port, 'negotiate/rfq', rfq);

      expect(res.error).toBeUndefined();
      const quote = res.result as QuoteParams;
      expect(quote.rfq_id).toBe(rfq.rfq_id);
      expect(quote.seller.agent_id).toBe(agent.getAgentId());
      expect(quote.signature).toBeDefined();

      // Session should be created
      const session = agent.getSession(rfq.rfq_id);
      expect(session).toBeDefined();
      expect(session!.state).toBe('QUOTES_RECEIVED');
    });

    it('handles negotiate/accept with valid buyer signature', async () => {
      agent = new SellerAgent({
        endpoint: 'http://localhost:0',
        services: TEST_SERVICES,
      });
      await agent.listen(0);
      const port = parseInt(new URL(agent.getEndpoint()).port, 10);

      // First send an RFQ to create a session — use the buyer DID from the RFQ
      const buyerKp = generateKeyPair();
      const buyerDid = publicKeyToDid(buyerKp.publicKey);
      const rfq = makeValidRFQ({
        buyer: { agent_id: buyerDid, endpoint: 'http://localhost:9999' },
      }, buyerKp);
      await jsonRpc(port, 'negotiate/rfq', rfq);

      // Get the quote_id from the session so accepting_message_id is valid
      const session = agent.getSession(rfq.rfq_id)!;
      const quoteId = session.quotes[0].quote_id;

      // Build a proper accept with valid agreement_hash and buyer signature
      const finalTerms = {
        price_per_unit: '0.01',
        currency: 'USDC',
        unit: 'request',
      };
      const hash = agreementHash(finalTerms);
      const unsigned = {
        agreement_id: crypto.randomUUID(),
        rfq_id: rfq.rfq_id,
        accepting_message_id: quoteId,
        final_terms: finalTerms,
        agreement_hash: hash,
      };
      const buyerSig = signMessage(unsigned, buyerKp.secretKey);
      const acceptParams = {
        ...unsigned,
        buyer_signature: buyerSig,
        seller_signature: Buffer.alloc(64).toString('base64'),
      };

      const res = await jsonRpc(port, 'negotiate/accept', acceptParams);
      expect(res.error).toBeUndefined();

      const result = res.result as { status: string; agreement_id: string; seller_signature: string };
      expect(result.status).toBe('accepted');
      expect(result.seller_signature).toBeDefined();
      expect(result.seller_signature.length).toBeGreaterThan(0);

      // Verify the seller's counter-signature is valid over the same unsigned data
      const sellerPubKey = didToPublicKey(agent!.getAgentId());
      const counterSigValid = verifyMessage(unsigned, result.seller_signature, sellerPubKey);
      expect(counterSigValid).toBe(true);

      // Session should transition to ACCEPTED
      const updatedSession = agent.getSession(rfq.rfq_id);
      expect(updatedSession!.state).toBe('ACCEPTED');

      // The agreement stored in the session should have the seller's counter-signature
      expect(updatedSession!.agreement).toBeDefined();
      expect(updatedSession!.agreement!.seller_signature).toBe(result.seller_signature);
    });

    it('seller counter-signature is verifiable by third parties', async () => {
      agent = new SellerAgent({
        endpoint: 'http://localhost:0',
        services: TEST_SERVICES,
      });
      await agent.listen(0);
      const port = parseInt(new URL(agent.getEndpoint()).port, 10);

      const buyerKp = generateKeyPair();
      const buyerDid = publicKeyToDid(buyerKp.publicKey);
      const rfq = makeValidRFQ({
        buyer: { agent_id: buyerDid, endpoint: 'http://localhost:9999' },
      }, buyerKp);
      await jsonRpc(port, 'negotiate/rfq', rfq);

      // Get the quote_id from the session
      const session = agent.getSession(rfq.rfq_id)!;
      const quoteId = session.quotes[0].quote_id;

      const finalTerms = {
        price_per_unit: '0.02',
        currency: 'USDC',
        unit: 'token',
      };
      const hash = agreementHash(finalTerms);
      const unsigned = {
        agreement_id: crypto.randomUUID(),
        rfq_id: rfq.rfq_id,
        accepting_message_id: quoteId,
        final_terms: finalTerms,
        agreement_hash: hash,
      };
      const buyerSig = signMessage(unsigned, buyerKp.secretKey);
      const acceptParams = {
        ...unsigned,
        buyer_signature: buyerSig,
        seller_signature: Buffer.alloc(64).toString('base64'),
      };

      const res = await jsonRpc(port, 'negotiate/accept', acceptParams);
      const result = res.result as { seller_signature: string };

      // A third party can verify both signatures with just the public DIDs
      const buyerPubKey = didToPublicKey(buyerDid);
      const sellerPubKey = didToPublicKey(agent!.getAgentId());

      expect(verifyMessage(unsigned, buyerSig, buyerPubKey)).toBe(true);
      expect(verifyMessage(unsigned, result.seller_signature, sellerPubKey)).toBe(true);

      // Cross-verification: buyer sig fails with seller key and vice versa
      expect(verifyMessage(unsigned, buyerSig, sellerPubKey)).toBe(false);
      expect(verifyMessage(unsigned, result.seller_signature, buyerPubKey)).toBe(false);
    });

    it('handles negotiate/reject', async () => {
      agent = new SellerAgent({
        endpoint: 'http://localhost:0',
        services: TEST_SERVICES,
      });
      await agent.listen(0);
      const port = parseInt(new URL(agent.getEndpoint()).port, 10);

      // First send an RFQ to create a session — use the same buyer keypair for rejection
      const buyerKp = generateKeyPair();
      const buyerDid = publicKeyToDid(buyerKp.publicKey);
      const rfq = makeValidRFQ({
        buyer: { agent_id: buyerDid, endpoint: 'http://localhost:9999' },
      }, buyerKp);
      await jsonRpc(port, 'negotiate/rfq', rfq);

      // Now send a signed reject from the same buyer
      const unsignedReject = {
        rfq_id: rfq.rfq_id,
        rejecting_message_id: crypto.randomUUID(),
        reason: 'Too expensive',
        from: { agent_id: buyerDid },
      };
      const rejectSig = signMessage(unsignedReject, buyerKp.secretKey);
      const rejectParams = { ...unsignedReject, signature: rejectSig };

      const res = await jsonRpc(port, 'negotiate/reject', rejectParams);
      expect(res.error).toBeUndefined();
      expect((res.result as { status: string }).status).toBe('rejected');

      // Session should transition to REJECTED
      const session = agent.getSession(rfq.rfq_id);
      expect(session!.state).toBe('REJECTED');
    });

    it('returns error for accept on unknown RFQ', async () => {
      agent = new SellerAgent({
        endpoint: 'http://localhost:0',
        services: TEST_SERVICES,
      });
      await agent.listen(0);
      const port = parseInt(new URL(agent.getEndpoint()).port, 10);

      const fakeSig = Buffer.alloc(64).toString('base64');
      const fakeHash = '0'.repeat(64);
      const res = await jsonRpc(port, 'negotiate/accept', {
        agreement_id: crypto.randomUUID(),
        rfq_id: crypto.randomUUID(),
        accepting_message_id: crypto.randomUUID(),
        final_terms: { price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
        agreement_hash: fakeHash,
        buyer_signature: fakeSig,
        seller_signature: fakeSig,
      });

      expect(res.error).toBeDefined();
      expect(res.error!.message).toContain('unknown RFQ');
    });

    it('rejects accept with mismatched agreement_hash', async () => {
      agent = new SellerAgent({
        endpoint: 'http://localhost:0',
        services: TEST_SERVICES,
      });
      await agent.listen(0);
      const port = parseInt(new URL(agent.getEndpoint()).port, 10);

      // Send an RFQ to create a session with a real buyer DID
      const buyerKp = generateKeyPair();
      const buyerDid = publicKeyToDid(buyerKp.publicKey);
      const rfq = makeValidRFQ({
        buyer: { agent_id: buyerDid, endpoint: 'http://localhost:9999' },
      }, buyerKp);
      await jsonRpc(port, 'negotiate/rfq', rfq);

      // Get the quote_id from the session
      const session = agent.getSession(rfq.rfq_id)!;
      const quoteId = session.quotes[0].quote_id;

      // Build an accept with a wrong agreement_hash
      const finalTerms = {
        price_per_unit: '0.01',
        currency: 'USDC',
        unit: 'request',
      };
      const wrongHash = 'deadbeef0000000000000000000000000000000000000000000000000000abcd';
      const unsigned = {
        agreement_id: crypto.randomUUID(),
        rfq_id: rfq.rfq_id,
        accepting_message_id: quoteId,
        final_terms: finalTerms,
        agreement_hash: wrongHash,
      };
      const buyerSig = signMessage(unsigned, buyerKp.secretKey);
      const acceptParams = {
        ...unsigned,
        buyer_signature: buyerSig,
        seller_signature: Buffer.alloc(64).toString('base64'),
      };

      const res = await jsonRpc(port, 'negotiate/accept', acceptParams);
      expect(res.error).toBeDefined();
      expect(res.error!.message).toContain('Agreement hash mismatch');
    });

    it('rejects accept with invalid buyer signature', async () => {
      agent = new SellerAgent({
        endpoint: 'http://localhost:0',
        services: TEST_SERVICES,
      });
      await agent.listen(0);
      const port = parseInt(new URL(agent.getEndpoint()).port, 10);

      // Send an RFQ to create a session with a real buyer DID
      const buyerKp = generateKeyPair();
      const buyerDid = publicKeyToDid(buyerKp.publicKey);
      const rfq = makeValidRFQ({
        buyer: { agent_id: buyerDid, endpoint: 'http://localhost:9999' },
      }, buyerKp);
      await jsonRpc(port, 'negotiate/rfq', rfq);

      // Get the quote_id from the session
      const session = agent.getSession(rfq.rfq_id)!;
      const quoteId = session.quotes[0].quote_id;

      // Build an accept with correct agreement_hash but sign with a different key
      const finalTerms = {
        price_per_unit: '0.01',
        currency: 'USDC',
        unit: 'request',
      };
      const hash = agreementHash(finalTerms);
      const unsigned = {
        agreement_id: crypto.randomUUID(),
        rfq_id: rfq.rfq_id,
        accepting_message_id: quoteId,
        final_terms: finalTerms,
        agreement_hash: hash,
      };
      // Sign with a completely different keypair (not the buyer)
      const imposterKp = generateKeyPair();
      const badSig = signMessage(unsigned, imposterKp.secretKey);
      const acceptParams = {
        ...unsigned,
        buyer_signature: badSig,
        seller_signature: Buffer.alloc(64).toString('base64'),
      };

      const res = await jsonRpc(port, 'negotiate/accept', acceptParams);
      expect(res.error).toBeDefined();
      expect(res.error!.message).toContain('Invalid buyer signature');
    });

    it('rejects accept with tampered final_terms', async () => {
      agent = new SellerAgent({
        endpoint: 'http://localhost:0',
        services: TEST_SERVICES,
      });
      await agent.listen(0);
      const port = parseInt(new URL(agent.getEndpoint()).port, 10);

      // Send an RFQ to create a session with a real buyer DID
      const buyerKp = generateKeyPair();
      const buyerDid = publicKeyToDid(buyerKp.publicKey);
      const rfq = makeValidRFQ({
        buyer: { agent_id: buyerDid, endpoint: 'http://localhost:9999' },
      }, buyerKp);
      await jsonRpc(port, 'negotiate/rfq', rfq);

      // Get the quote_id from the session
      const session = agent.getSession(rfq.rfq_id)!;
      const quoteId = session.quotes[0].quote_id;

      // Compute agreement_hash from the original terms
      const originalTerms = {
        price_per_unit: '0.01',
        currency: 'USDC',
        unit: 'request',
      };
      const hash = agreementHash(originalTerms);

      // Tamper with final_terms so they no longer match the hash
      const tamperedTerms = {
        price_per_unit: '0.001',
        currency: 'USDC',
        unit: 'request',
      };
      const unsigned = {
        agreement_id: crypto.randomUUID(),
        rfq_id: rfq.rfq_id,
        accepting_message_id: quoteId,
        final_terms: tamperedTerms,
        agreement_hash: hash,
      };
      const buyerSig = signMessage(unsigned, buyerKp.secretKey);
      const acceptParams = {
        ...unsigned,
        buyer_signature: buyerSig,
        seller_signature: Buffer.alloc(64).toString('base64'),
      };

      const res = await jsonRpc(port, 'negotiate/accept', acceptParams);
      expect(res.error).toBeDefined();
      expect(res.error!.message).toContain('Agreement hash mismatch');
    });

    it('rejects accept with unknown accepting_message_id', async () => {
      agent = new SellerAgent({
        endpoint: 'http://localhost:0',
        services: TEST_SERVICES,
      });
      await agent.listen(0);
      const port = parseInt(new URL(agent.getEndpoint()).port, 10);

      const buyerKp = generateKeyPair();
      const buyerDid = publicKeyToDid(buyerKp.publicKey);
      const rfq = makeValidRFQ({
        buyer: { agent_id: buyerDid, endpoint: 'http://localhost:9999' },
      }, buyerKp);
      await jsonRpc(port, 'negotiate/rfq', rfq);

      const finalTerms = {
        price_per_unit: '0.01',
        currency: 'USDC',
        unit: 'request',
      };
      const hash = agreementHash(finalTerms);
      // Use a random UUID that does NOT match any quote
      const unsigned = {
        agreement_id: crypto.randomUUID(),
        rfq_id: rfq.rfq_id,
        accepting_message_id: crypto.randomUUID(),
        final_terms: finalTerms,
        agreement_hash: hash,
      };
      const buyerSig = signMessage(unsigned, buyerKp.secretKey);
      const acceptParams = {
        ...unsigned,
        buyer_signature: buyerSig,
        seller_signature: Buffer.alloc(64).toString('base64'),
      };

      const res = await jsonRpc(port, 'negotiate/accept', acceptParams);
      expect(res.error).toBeDefined();
      expect(res.error!.message).toContain('does not match any quote');
    });
  });

  // ── Custom handlers ──────────────────────────────────────────────

  describe('onRFQ', () => {
    it('calls custom RFQ handler instead of generateQuote', async () => {
      agent = new SellerAgent({
        endpoint: 'http://localhost:0',
        services: TEST_SERVICES,
      });

      let handlerCalled = false;
      agent.onRFQ(async (rfq) => {
        handlerCalled = true;
        return null; // ignore the RFQ
      });

      await agent.listen(0);
      const port = parseInt(new URL(agent.getEndpoint()).port, 10);

      const rfq = makeValidRFQ();
      const res = await jsonRpc(port, 'negotiate/rfq', rfq);

      expect(handlerCalled).toBe(true);
      expect((res.result as { status: string }).status).toBe('ignored');
    });
  });

  // ── Session management ───────────────────────────────────────────

  describe('session management', () => {
    it('getSession and getSessions work', () => {
      agent = new SellerAgent({
        endpoint: 'http://localhost:4000',
        services: TEST_SERVICES,
      });

      expect(agent.getSessions()).toHaveLength(0);
      expect(agent.getSession('nonexistent')).toBeUndefined();
    });
  });

  // ── Signature verification adversarial tests ────────────────────

  describe('signature verification adversarial tests', () => {
    it('rejects RFQ with invalid signature (signed by wrong key)', async () => {
      agent = new SellerAgent({
        endpoint: 'http://localhost:0',
        services: TEST_SERVICES,
      });
      await agent.listen(0);
      const port = parseInt(new URL(agent.getEndpoint()).port, 10);

      // Buyer DID is from keypair A, but signature is made with keypair B
      const keypairA = generateKeyPair();
      const keypairB = generateKeyPair();
      const buyerDid = publicKeyToDid(keypairA.publicKey);

      const unsigned = {
        rfq_id: crypto.randomUUID(),
        buyer: { agent_id: buyerDid, endpoint: 'http://localhost:9999' },
        service: { category: 'inference' },
        budget: { max_price_per_unit: '1.00', currency: 'USDC', unit: 'request' },
        negotiation_style: 'rfq' as const,
        expires_at: new Date(Date.now() + 300_000).toISOString(),
      };
      // Sign with the wrong key (keypairB instead of keypairA)
      const signature = signMessage(unsigned, keypairB.secretKey);
      const rfq = { ...unsigned, signature };

      const res = await jsonRpc(port, 'negotiate/rfq', rfq);

      expect(res.error).toBeDefined();
      expect(res.error!.message).toContain('Invalid signature');
    });

    it('rejects RFQ with missing signature', async () => {
      agent = new SellerAgent({
        endpoint: 'http://localhost:0',
        services: TEST_SERVICES,
      });
      await agent.listen(0);
      const port = parseInt(new URL(agent.getEndpoint()).port, 10);

      const buyerKp = generateKeyPair();
      const buyerDid = publicKeyToDid(buyerKp.publicKey);

      // Send an RFQ with no signature field at all
      const rfq = {
        rfq_id: crypto.randomUUID(),
        buyer: { agent_id: buyerDid, endpoint: 'http://localhost:9999' },
        service: { category: 'inference' },
        budget: { max_price_per_unit: '1.00', currency: 'USDC', unit: 'request' },
        negotiation_style: 'rfq' as const,
        expires_at: new Date(Date.now() + 300_000).toISOString(),
      };

      const res = await jsonRpc(port, 'negotiate/rfq', rfq);

      expect(res.error).toBeDefined();
    });

    it('verifies buyer counter-offer signature', async () => {
      agent = new SellerAgent({
        endpoint: 'http://localhost:0',
        services: TEST_SERVICES,
      });

      agent.onCounter(async (_counter, _session) => {
        return 'accept';
      });

      await agent.listen(0);
      const port = parseInt(new URL(agent.getEndpoint()).port, 10);

      // Set up a session by sending a valid RFQ
      const buyerKp = generateKeyPair();
      const buyerDid = publicKeyToDid(buyerKp.publicKey);
      const rfq = makeValidRFQ({
        buyer: { agent_id: buyerDid, endpoint: 'http://localhost:9999' },
      }, buyerKp);
      const rfqRes = await jsonRpc(port, 'negotiate/rfq', rfq);
      expect(rfqRes.error).toBeUndefined();

      const quote = rfqRes.result as { quote_id?: string };

      // Send a properly signed counter from the buyer
      const unsignedCounter = {
        counter_id: crypto.randomUUID(),
        rfq_id: rfq.rfq_id,
        in_response_to: (quote as any).quote_id ?? crypto.randomUUID(),
        round: 1,
        from: { agent_id: buyerDid, role: 'buyer' as const },
        modifications: { price_per_unit: '0.008' },
        justification: 'Requesting lower price',
        expires_at: new Date(Date.now() + 300_000).toISOString(),
      };
      const counterSig = signMessage(unsignedCounter, buyerKp.secretKey);
      const counter = { ...unsignedCounter, signature: counterSig };

      const res = await jsonRpc(port, 'negotiate/counter', counter);

      expect(res.error).toBeUndefined();
    });

    it('rejects counter with invalid signature', async () => {
      agent = new SellerAgent({
        endpoint: 'http://localhost:0',
        services: TEST_SERVICES,
      });

      agent.onCounter(async (_counter, _session) => {
        return 'accept';
      });

      await agent.listen(0);
      const port = parseInt(new URL(agent.getEndpoint()).port, 10);

      // Set up a session by sending a valid RFQ
      const buyerKp = generateKeyPair();
      const buyerDid = publicKeyToDid(buyerKp.publicKey);
      const rfq = makeValidRFQ({
        buyer: { agent_id: buyerDid, endpoint: 'http://localhost:9999' },
      }, buyerKp);
      const rfqRes = await jsonRpc(port, 'negotiate/rfq', rfq);
      expect(rfqRes.error).toBeUndefined();

      const quote = rfqRes.result as { quote_id?: string };

      // Send a counter where from.agent_id is the buyer DID but signature is from a different key
      const imposterKp = generateKeyPair();
      const unsignedCounter = {
        counter_id: crypto.randomUUID(),
        rfq_id: rfq.rfq_id,
        in_response_to: (quote as any).quote_id ?? crypto.randomUUID(),
        round: 1,
        from: { agent_id: buyerDid, role: 'buyer' as const },
        modifications: { price_per_unit: '0.008' },
        justification: 'Requesting lower price',
        expires_at: new Date(Date.now() + 300_000).toISOString(),
      };
      // Sign with the imposter's key, not the buyer's
      const counterSig = signMessage(unsignedCounter, imposterKp.secretKey);
      const counter = { ...unsignedCounter, signature: counterSig };

      const res = await jsonRpc(port, 'negotiate/counter', counter);

      expect(res.error).toBeDefined();
      expect(res.error!.message).toContain('Invalid signature');
    });
  });
});
