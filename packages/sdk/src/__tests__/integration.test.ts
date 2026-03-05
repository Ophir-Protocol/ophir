import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BuyerAgent } from '../buyer.js';
import { SellerAgent } from '../seller.js';
import { generateKeyPair, didToPublicKey } from '../identity.js';
import { signMessage, verifyMessage, agreementHash } from '../signing.js';
import { buildQuote } from '../messages.js';
import { OphirError, OphirErrorCode } from '@ophir/protocol';

describe('Integration: Full negotiation flows', () => {
  describe('Test 1: Happy path — RFQ → Quote → Accept', () => {
    let seller: SellerAgent;
    let buyer: BuyerAgent;

    beforeAll(async () => {
      seller = new SellerAgent({
        endpoint: 'http://localhost:0',
        services: [
          {
            category: 'inference',
            description: 'LLM inference service',
            base_price: '0.005',
            currency: 'USDC',
            unit: 'request',
          },
        ],
      });
      await seller.listen(0);

      buyer = new BuyerAgent({
        endpoint: 'http://localhost:0',
      });
      await buyer.listen(0);

      // Auto-generate quote on RFQ
      seller.onRFQ(async (rfq) => seller.generateQuote(rfq));
    });

    afterAll(async () => {
      await buyer.close();
      await seller.close();
    });

    it('completes full negotiation flow', async () => {
      const session = await buyer.requestQuotes({
        sellers: [seller.getEndpoint()],
        service: { category: 'inference' },
        budget: {
          max_price_per_unit: '0.01',
          currency: 'USDC',
          unit: 'request',
        },
      });

      // Wait for quote with generous timeout
      const quotes = await buyer.waitForQuotes(session, { timeout: 10_000 });
      expect(quotes.length).toBeGreaterThanOrEqual(1);

      // Verify quote has correct pricing from seller's base_price
      expect(quotes[0].pricing.price_per_unit).toBe('0.0050');
      expect(quotes[0].pricing.currency).toBe('USDC');

      // Verify quote signature is valid
      const { signature, ...unsigned } = quotes[0];
      const sellerPubKey = didToPublicKey(seller.getAgentId());
      expect(verifyMessage(unsigned, signature, sellerPubKey)).toBe(true);

      // Rank and accept
      const ranked = buyer.rankQuotes(quotes, 'cheapest');
      expect(ranked.length).toBeGreaterThanOrEqual(1);

      const bestQuote = ranked[0];
      const agreement = await buyer.acceptQuote(bestQuote);

      // Verify agreement_hash is valid SHA-256 hex
      expect(agreement.agreement_hash).toMatch(/^[a-f0-9]{64}$/);

      // Recompute agreement_hash and compare
      const recomputed = agreementHash(agreement.final_terms);
      expect(agreement.agreement_hash).toBe(recomputed);

      // Verify buyer_signature is valid
      expect(agreement.buyer_signature).toBeDefined();
      const buyerPubKey = didToPublicKey(buyer.getAgentId());
      const unsignedAccept = {
        agreement_id: agreement.agreement_id,
        rfq_id: agreement.rfq_id,
        accepting_message_id: bestQuote.quote_id,
        final_terms: agreement.final_terms,
        agreement_hash: agreement.agreement_hash,
      };
      expect(
        verifyMessage(unsignedAccept, agreement.buyer_signature, buyerPubKey),
      ).toBe(true);
    });
  });

  describe('Test 2: Counter-offer flow', () => {
    let seller: SellerAgent;
    let buyer: BuyerAgent;
    let sellerKp: { publicKey: Uint8Array; secretKey: Uint8Array };

    beforeAll(async () => {
      sellerKp = generateKeyPair();
      seller = new SellerAgent({
        keypair: sellerKp,
        endpoint: 'http://localhost:0',
        services: [
          {
            category: 'inference',
            description: 'LLM inference service',
            base_price: '0.005',
            currency: 'USDC',
            unit: 'request',
          },
        ],
      });
      await seller.listen(0);

      buyer = new BuyerAgent({
        endpoint: 'http://localhost:0',
      });
      await buyer.listen(0);

      // Counter handler: accept at $0.004 (split the difference)
      seller.onCounter(async (counter, _session) => {
        const quoteMsg = buildQuote({
          rfqId: counter.rfq_id,
          seller: {
            agent_id: seller.getAgentId(),
            endpoint: seller.getEndpoint(),
          },
          pricing: {
            price_per_unit: '0.004',
            currency: 'USDC',
            unit: 'request',
            pricing_model: 'fixed',
          },
          sla: {
            metrics: [
              { name: 'uptime_pct', target: 99.9, comparison: 'gte' as const },
            ],
          },
          secretKey: sellerKp.secretKey,
        });
        return quoteMsg.params;
      });
    });

    afterAll(async () => {
      await buyer.close();
      await seller.close();
    });

    it('negotiates via counter-offer to $0.004', async () => {
      const session = await buyer.requestQuotes({
        sellers: [seller.getEndpoint()],
        service: { category: 'inference' },
        budget: {
          max_price_per_unit: '0.01',
          currency: 'USDC',
          unit: 'request',
        },
      });

      const quotes = await buyer.waitForQuotes(session, { timeout: 10_000 });
      expect(quotes.length).toBeGreaterThanOrEqual(1);

      // Original quote at $0.005
      const originalQuote = quotes[0];
      expect(originalQuote.pricing.price_per_unit).toBe('0.0050');

      // Buyer counters at $0.003
      await buyer.counter(originalQuote, { price_per_unit: '0.003' });

      // Verify session round tracking
      expect(session.counters.length).toBeGreaterThanOrEqual(1);
      expect(session.currentRound).toBeGreaterThanOrEqual(1);

      // Wait for seller's response quote
      const updatedQuotes = await buyer.waitForQuotes(session, {
        minQuotes: 2,
        timeout: 10_000,
      });
      expect(updatedQuotes.length).toBeGreaterThanOrEqual(2);

      // Seller accepts at $0.004
      const newQuote = updatedQuotes[updatedQuotes.length - 1];
      expect(newQuote.pricing.price_per_unit).toBe('0.004');

      // Verify round 2
      expect(session.currentRound).toBeGreaterThanOrEqual(1);

      // Accept the counter
      const agreement = await buyer.acceptQuote(newQuote);
      expect(agreement.final_terms.price_per_unit).toBe('0.004');
      expect(agreement.agreement_hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('Test 3: Rejection flow', () => {
    let seller: SellerAgent;
    let buyer: BuyerAgent;

    beforeAll(async () => {
      seller = new SellerAgent({
        endpoint: 'http://localhost:0',
        services: [
          {
            category: 'inference',
            description: 'LLM inference — expensive',
            base_price: '1.000',
            currency: 'USDC',
            unit: 'request',
          },
        ],
      });
      await seller.listen(0);

      buyer = new BuyerAgent({
        endpoint: 'http://localhost:0',
      });
      await buyer.listen(0);
    });

    afterAll(async () => {
      await buyer.close();
      await seller.close();
    });

    it('rejects quote above budget with reason', async () => {
      const session = await buyer.requestQuotes({
        sellers: [seller.getEndpoint()],
        service: { category: 'inference' },
        budget: {
          max_price_per_unit: '0.001',
          currency: 'USDC',
          unit: 'request',
        },
      });

      const quotes = await buyer.waitForQuotes(session, { timeout: 10_000 });
      expect(quotes.length).toBeGreaterThanOrEqual(1);

      // Quote price ($1.00) far exceeds budget ($0.001)
      expect(parseFloat(quotes[0].pricing.price_per_unit)).toBeGreaterThan(0.001);

      await buyer.reject(session, 'price_too_high');
      expect(session.state).toBe('REJECTED');
      expect(session.rejectionReason).toBe('price_too_high');
    });
  });

  describe('Test 4: Multiple sellers', () => {
    let cheapSeller: SellerAgent;
    let expensiveSeller: SellerAgent;
    let buyer: BuyerAgent;

    beforeAll(async () => {
      cheapSeller = new SellerAgent({
        endpoint: 'http://localhost:0',
        services: [
          {
            category: 'inference',
            description: 'Cheap inference',
            base_price: '0.005',
            currency: 'USDC',
            unit: 'request',
          },
        ],
      });
      await cheapSeller.listen(0);

      expensiveSeller = new SellerAgent({
        endpoint: 'http://localhost:0',
        services: [
          {
            category: 'inference',
            description: 'Premium inference',
            base_price: '0.008',
            currency: 'USDC',
            unit: 'request',
          },
        ],
      });
      await expensiveSeller.listen(0);

      buyer = new BuyerAgent({
        endpoint: 'http://localhost:0',
      });
      await buyer.listen(0);
    });

    afterAll(async () => {
      await buyer.close();
      await cheapSeller.close();
      await expensiveSeller.close();
    });

    it('ranks 2 sellers and accepts cheapest ($0.005)', async () => {
      const session = await buyer.requestQuotes({
        sellers: [cheapSeller.getEndpoint(), expensiveSeller.getEndpoint()],
        service: { category: 'inference' },
        budget: {
          max_price_per_unit: '1.00',
          currency: 'USDC',
          unit: 'request',
        },
      });

      const quotes = await buyer.waitForQuotes(session, {
        minQuotes: 2,
        timeout: 10_000,
      });
      expect(quotes).toHaveLength(2);

      const ranked = buyer.rankQuotes(quotes, 'cheapest');

      // $0.005 should be first
      const cheapPrice = parseFloat(ranked[0].pricing.price_per_unit);
      const expensivePrice = parseFloat(ranked[1].pricing.price_per_unit);
      expect(cheapPrice).toBeLessThan(expensivePrice);
      expect(cheapPrice).toBeCloseTo(0.005, 3);
      expect(expensivePrice).toBeCloseTo(0.008, 3);

      // Accept cheapest
      const agreement = await buyer.acceptQuote(ranked[0]);
      expect(agreement.final_terms.price_per_unit).toBe(ranked[0].pricing.price_per_unit);
    });
  });

  describe('Test 5: Signature verification end-to-end', () => {
    let seller: SellerAgent;
    let buyer: BuyerAgent;
    let sellerKp: { publicKey: Uint8Array; secretKey: Uint8Array };
    let buyerKp: { publicKey: Uint8Array; secretKey: Uint8Array };

    beforeAll(async () => {
      sellerKp = generateKeyPair();
      buyerKp = generateKeyPair();

      seller = new SellerAgent({
        keypair: sellerKp,
        endpoint: 'http://localhost:0',
        services: [
          {
            category: 'inference',
            description: 'Inference service',
            base_price: '0.005',
            currency: 'USDC',
            unit: 'request',
          },
        ],
      });
      await seller.listen(0);

      buyer = new BuyerAgent({
        keypair: buyerKp,
        endpoint: 'http://localhost:0',
      });
      await buyer.listen(0);
    });

    afterAll(async () => {
      await buyer.close();
      await seller.close();
    });

    it('verifies seller quote signature with their public key', async () => {
      const session = await buyer.requestQuotes({
        sellers: [seller.getEndpoint()],
        service: { category: 'inference' },
        budget: {
          max_price_per_unit: '0.01',
          currency: 'USDC',
          unit: 'request',
        },
      });

      const quotes = await buyer.waitForQuotes(session, { timeout: 10_000 });
      expect(quotes.length).toBeGreaterThanOrEqual(1);

      const quote = quotes[0];

      // Verify seller's signature on the quote
      const { signature, ...unsigned } = quote;
      const sellerPubKey = didToPublicKey(seller.getAgentId());
      expect(verifyMessage(unsigned, signature, sellerPubKey)).toBe(true);

      // Tampered params should fail
      const tampered = {
        ...unsigned,
        pricing: { ...unsigned.pricing, price_per_unit: '999.000' },
      };
      expect(verifyMessage(tampered, signature, sellerPubKey)).toBe(false);

      // Accept and verify buyer's signature
      const agreement = await buyer.acceptQuote(quote);
      const buyerPubKey = didToPublicKey(buyer.getAgentId());

      // Verify agreement_hash matches recomputed hash
      const recomputed = agreementHash(agreement.final_terms);
      expect(agreement.agreement_hash).toBe(recomputed);

      // Verify buyer_signature is valid
      const unsignedAccept = {
        agreement_id: agreement.agreement_id,
        rfq_id: agreement.rfq_id,
        accepting_message_id: quote.quote_id,
        final_terms: agreement.final_terms,
        agreement_hash: agreement.agreement_hash,
      };
      expect(
        verifyMessage(unsignedAccept, agreement.buyer_signature, buyerPubKey),
      ).toBe(true);

      // Verify with wrong key fails
      const wrongKey = generateKeyPair().publicKey;
      expect(
        verifyMessage(unsignedAccept, agreement.buyer_signature, wrongKey),
      ).toBe(false);
    });
  });

  describe('Test 6: Expired quote handling', () => {
    let seller: SellerAgent;
    let buyer: BuyerAgent;
    let sellerKp: { publicKey: Uint8Array; secretKey: Uint8Array };

    beforeAll(async () => {
      sellerKp = generateKeyPair();
      seller = new SellerAgent({
        keypair: sellerKp,
        endpoint: 'http://localhost:0',
        services: [
          {
            category: 'inference',
            description: 'Inference service',
            base_price: '0.005',
            currency: 'USDC',
            unit: 'request',
          },
        ],
      });
      await seller.listen(0);

      buyer = new BuyerAgent({
        endpoint: 'http://localhost:0',
      });
      await buyer.listen(0);

      // Custom handler that generates a quote with very short TTL (100ms)
      seller.onRFQ(async (rfq) => {
        const service = { base_price: '0.005', currency: 'USDC', unit: 'request' };
        const { v4: uuidv4 } = await import('uuid');
        const { signMessage } = await import('../signing.js');

        const unsigned = {
          quote_id: uuidv4(),
          rfq_id: rfq.rfq_id,
          seller: {
            agent_id: seller.getAgentId(),
            endpoint: seller.getEndpoint(),
          },
          pricing: {
            price_per_unit: service.base_price,
            currency: service.currency,
            unit: service.unit,
            pricing_model: 'fixed' as const,
          },
          sla_offered: {
            metrics: [
              { name: 'uptime_pct' as const, target: 99.9, comparison: 'gte' as const },
            ],
          },
          // Expires in 100ms
          expires_at: new Date(Date.now() + 100).toISOString(),
        };

        const signature = signMessage(unsigned, sellerKp.secretKey);
        return { ...unsigned, signature };
      });
    });

    afterAll(async () => {
      await buyer.close();
      await seller.close();
    });

    it('detects expired quote by checking expires_at', async () => {
      const session = await buyer.requestQuotes({
        sellers: [seller.getEndpoint()],
        service: { category: 'inference' },
        budget: {
          max_price_per_unit: '0.01',
          currency: 'USDC',
          unit: 'request',
        },
      });

      const quotes = await buyer.waitForQuotes(session, { timeout: 10_000 });
      expect(quotes.length).toBeGreaterThanOrEqual(1);

      const quote = quotes[0];
      expect(quote.expires_at).toBeDefined();

      // Wait for the quote to expire
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Verify the quote is now expired
      const expiresAt = new Date(quote.expires_at!).getTime();
      expect(Date.now()).toBeGreaterThan(expiresAt);
    });
  });

  describe('Test 7: Max rounds exceeded', () => {
    let seller: SellerAgent;
    let buyer: BuyerAgent;
    let sellerKp: { publicKey: Uint8Array; secretKey: Uint8Array };

    beforeAll(async () => {
      sellerKp = generateKeyPair();
      seller = new SellerAgent({
        keypair: sellerKp,
        endpoint: 'http://localhost:0',
        services: [
          {
            category: 'inference',
            description: 'Inference service',
            base_price: '0.010',
            currency: 'USDC',
            unit: 'request',
          },
        ],
      });
      await seller.listen(0);

      buyer = new BuyerAgent({
        endpoint: 'http://localhost:0',
      });
      await buyer.listen(0);

      // Counter handler: always respond with a new quote at a slightly lower price
      seller.onCounter(async (counter, _session) => {
        const quoteMsg = buildQuote({
          rfqId: counter.rfq_id,
          seller: {
            agent_id: seller.getAgentId(),
            endpoint: seller.getEndpoint(),
          },
          pricing: {
            price_per_unit: '0.009',
            currency: 'USDC',
            unit: 'request',
            pricing_model: 'fixed',
          },
          sla: {
            metrics: [
              { name: 'uptime_pct', target: 99.9, comparison: 'gte' as const },
            ],
          },
          secretKey: sellerKp.secretKey,
        });
        return quoteMsg.params;
      });
    });

    afterAll(async () => {
      await buyer.close();
      await seller.close();
    });

    it('throws MAX_ROUNDS_EXCEEDED after exceeding limit', async () => {
      // Request with maxRounds = 2
      const session = await buyer.requestQuotes({
        sellers: [seller.getEndpoint()],
        service: { category: 'inference' },
        budget: {
          max_price_per_unit: '0.02',
          currency: 'USDC',
          unit: 'request',
        },
        maxRounds: 2,
      });

      const quotes = await buyer.waitForQuotes(session, { timeout: 10_000 });
      expect(quotes.length).toBeGreaterThanOrEqual(1);
      const quote = quotes[0];

      // Round 1: buyer counters
      await buyer.counter(quote, { price_per_unit: '0.007' });
      expect(session.currentRound).toBe(1);

      // Wait for seller's response
      const quotes2 = await buyer.waitForQuotes(session, {
        minQuotes: 2,
        timeout: 10_000,
      });
      const newQuote = quotes2[quotes2.length - 1];

      // Round 2: buyer counters again
      await buyer.counter(newQuote, { price_per_unit: '0.006' });
      expect(session.currentRound).toBe(2);

      // Wait for seller's response
      const quotes3 = await buyer.waitForQuotes(session, {
        minQuotes: 3,
        timeout: 10_000,
      });
      const newestQuote = quotes3[quotes3.length - 1];

      // Round 3: should throw MAX_ROUNDS_EXCEEDED
      await expect(
        buyer.counter(newestQuote, { price_per_unit: '0.005' }),
      ).rejects.toThrow('exceeds max');
    });
  });

  describe('Test 8: Full flow with signature verification at every step', () => {
    let seller: SellerAgent;
    let buyer: BuyerAgent;
    let sellerKp: { publicKey: Uint8Array; secretKey: Uint8Array };
    let buyerKp: { publicKey: Uint8Array; secretKey: Uint8Array };

    beforeAll(async () => {
      sellerKp = generateKeyPair();
      buyerKp = generateKeyPair();

      seller = new SellerAgent({
        keypair: sellerKp,
        endpoint: 'http://localhost:0',
        services: [
          {
            category: 'inference',
            description: 'LLM inference service',
            base_price: '0.005',
            currency: 'USDC',
            unit: 'request',
          },
        ],
      });
      await seller.listen(0);

      buyer = new BuyerAgent({
        keypair: buyerKp,
        endpoint: 'http://localhost:0',
      });
      await buyer.listen(0);
    });

    afterAll(async () => {
      await buyer.close();
      await seller.close();
    });

    it('buyer signs RFQ → seller verifies → seller signs quote → buyer verifies → buyer signs accept → seller verifies', async () => {
      // Step 1: Buyer sends RFQ (signed by buyer) → seller receives and verifies
      const session = await buyer.requestQuotes({
        sellers: [seller.getEndpoint()],
        service: { category: 'inference' },
        budget: {
          max_price_per_unit: '0.01',
          currency: 'USDC',
          unit: 'request',
        },
      });

      // Step 2: Wait for seller's signed quote
      const quotes = await buyer.waitForQuotes(session, { timeout: 10_000 });
      expect(quotes.length).toBeGreaterThanOrEqual(1);

      const quote = quotes[0];

      // Step 3: Verify quote signature with seller's public key
      const { signature: quoteSig, ...unsignedQuote } = quote;
      const sellerPubKey = didToPublicKey(seller.getAgentId());
      expect(verifyMessage(unsignedQuote, quoteSig, sellerPubKey)).toBe(true);

      // Step 4: Buyer accepts the quote (buyer signs the accept)
      const agreement = await buyer.acceptQuote(quote);

      // Step 5: Verify buyer_signature with buyer's public key
      const buyerPubKey = didToPublicKey(buyer.getAgentId());
      const unsignedAccept = {
        agreement_id: agreement.agreement_id,
        rfq_id: agreement.rfq_id,
        accepting_message_id: quote.quote_id,
        final_terms: agreement.final_terms,
        agreement_hash: agreement.agreement_hash,
      };
      expect(
        verifyMessage(unsignedAccept, agreement.buyer_signature, buyerPubKey),
      ).toBe(true);

      // Step 6: The accept was sent to the seller via the transport inside acceptQuote.
      // Verify that the seller returned a seller_signature (counter-signature).
      expect(agreement.seller_signature).toBeDefined();

      // Step 7: Verify seller_signature with seller's public key
      expect(
        verifyMessage(unsignedAccept, agreement.seller_signature!, sellerPubKey),
      ).toBe(true);
    });
  });

  describe('Test 9: Forged quote rejected by buyer', () => {
    let seller: SellerAgent;
    let buyer: BuyerAgent;
    let sellerKp: { publicKey: Uint8Array; secretKey: Uint8Array };

    beforeAll(async () => {
      sellerKp = generateKeyPair();

      seller = new SellerAgent({
        keypair: sellerKp,
        endpoint: 'http://localhost:0',
        services: [
          {
            category: 'inference',
            description: 'LLM inference service',
            base_price: '0.005',
            currency: 'USDC',
            unit: 'request',
          },
        ],
      });
      await seller.listen(0);

      buyer = new BuyerAgent({
        endpoint: 'http://localhost:0',
      });
      await buyer.listen(0);
    });

    afterAll(async () => {
      await buyer.close();
      await seller.close();
    });

    it('buyer rejects quote signed by wrong seller key', async () => {
      // Get a real quote from the seller
      const session = await buyer.requestQuotes({
        sellers: [seller.getEndpoint()],
        service: { category: 'inference' },
        budget: {
          max_price_per_unit: '0.01',
          currency: 'USDC',
          unit: 'request',
        },
      });

      const quotes = await buyer.waitForQuotes(session, { timeout: 10_000 });
      expect(quotes.length).toBeGreaterThanOrEqual(1);

      const realQuote = quotes[0];

      // Create a forged quote: same pricing data but from a different (forged) seller
      const forgerKp = generateKeyPair();
      const { publicKeyToDid } = await import('../identity.js');
      const forgerDid = publicKeyToDid(forgerKp.publicKey);

      const { signature: _realSig, ...unsignedReal } = realQuote;
      const forgedUnsigned = {
        ...unsignedReal,
        seller: {
          agent_id: forgerDid,
          endpoint: 'http://localhost:9999',
        },
      };
      const forgedSignature = signMessage(forgedUnsigned, forgerKp.secretKey);
      const forgedQuote = { ...forgedUnsigned, signature: forgedSignature };

      // Add the forged quote directly to the session
      session.addQuote(forgedQuote);

      // acceptQuote should throw because the forged quote's seller DID
      // does not match any legitimate seller key known to the negotiation,
      // and the buyer verifies the signature against the quote's seller.agent_id.
      // The signature IS valid for the forger's key, but the buyer still calls
      // acceptQuote which sends to the forger's endpoint — that will fail.
      // However, the critical check is that acceptQuote verifies the seller
      // signature against the DID embedded in the quote. Since the forger
      // signed with their own key matching their own DID, the signature check
      // passes, but the accept send to the fake endpoint will fail.
      //
      // The real protection: if we tamper with the seller DID but keep the
      // original seller's signature, verification fails.
      const tamperedUnsigned = {
        ...unsignedReal,
        seller: {
          agent_id: forgerDid,
          endpoint: seller.getEndpoint(),
        },
      };
      // Sign with the REAL seller's key but claim to be the forger's DID
      const tamperedSignature = signMessage(tamperedUnsigned, sellerKp.secretKey);
      const tamperedQuote = { ...tamperedUnsigned, signature: tamperedSignature };

      session.addQuote(tamperedQuote);

      // acceptQuote verifies signature against seller.agent_id (forgerDid),
      // but the signature was made with sellerKp — mismatch → rejection
      await expect(buyer.acceptQuote(tamperedQuote)).rejects.toThrow(
        'seller signature is invalid',
      );
    });
  });
});
