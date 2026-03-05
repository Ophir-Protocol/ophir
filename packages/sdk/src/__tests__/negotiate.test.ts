import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { negotiate } from '../negotiate.js';
import { SellerAgent } from '../seller.js';
import type { NegotiateResult } from '../negotiate.js';

describe('negotiate() one-liner', () => {
  let seller: SellerAgent;
  let sellerEndpoint: string;

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
    sellerEndpoint = seller.getEndpoint();
  });

  afterAll(async () => {
    await seller.close();
  });

  it('returns a NegotiateResult with quotes from a single seller', async () => {
    const result = await negotiate({
      service: 'inference',
      maxBudget: '0.01',
      sellers: [sellerEndpoint],
      timeout: 15_000,
    });

    expect(result).toBeDefined();
    expect(result.quotes).toBeInstanceOf(Array);
    expect(result.quotes.length).toBeGreaterThanOrEqual(1);
    expect(result.sellersContacted).toBe(1);
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it('returns an agreement when autoAccept is true (default)', async () => {
    const result = await negotiate({
      service: 'inference',
      maxBudget: '0.01',
      sellers: [sellerEndpoint],
      timeout: 15_000,
    });

    expect(result.agreement).toBeDefined();
    expect(result.agreement!.agreement_id).toBeDefined();
    expect(result.agreement!.agreement_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.agreement!.buyer_signature).toBeDefined();
    expect(result.acceptedQuote).toBeDefined();
    expect(result.acceptedQuote!.pricing.price_per_unit).toBe('0.0050');
  });

  it('returns quotes without agreement when autoAccept is false', async () => {
    const result = await negotiate({
      service: 'inference',
      maxBudget: '0.01',
      sellers: [sellerEndpoint],
      autoAccept: false,
      timeout: 15_000,
    });

    expect(result.quotes.length).toBeGreaterThanOrEqual(1);
    expect(result.agreement).toBeUndefined();
    expect(result.acceptedQuote).toBeUndefined();
  });

  it('returns empty quotes when no sellers are provided', async () => {
    const result = await negotiate({
      service: 'inference',
      maxBudget: '0.01',
      sellers: [],
      timeout: 5_000,
    });

    expect(result.quotes).toEqual([]);
    expect(result.sellersContacted).toBe(0);
    expect(result.agreement).toBeUndefined();
  });

  it('defaults currency to USDC', async () => {
    const result = await negotiate({
      service: 'inference',
      maxBudget: '0.01',
      sellers: [sellerEndpoint],
      timeout: 15_000,
    });

    expect(result.quotes.length).toBeGreaterThanOrEqual(1);
    expect(result.quotes[0].pricing.currency).toBe('USDC');
  });

  it('defaults unit to request', async () => {
    const result = await negotiate({
      service: 'inference',
      maxBudget: '0.01',
      sellers: [sellerEndpoint],
      timeout: 15_000,
    });

    expect(result.quotes[0].pricing.unit).toBe('request');
  });

  it('passes model as a requirement', async () => {
    const result = await negotiate({
      service: 'inference',
      model: 'llama-3-70b',
      maxBudget: '0.01',
      sellers: [sellerEndpoint],
      timeout: 15_000,
    });

    // The seller still responds because it matches the 'inference' category
    expect(result.quotes.length).toBeGreaterThanOrEqual(1);
  });

  it('ranks quotes by cheapest by default', async () => {
    // Create a second, more expensive seller
    const expensiveSeller = new SellerAgent({
      endpoint: 'http://localhost:0',
      services: [
        {
          category: 'inference',
          description: 'Premium inference',
          base_price: '0.009',
          currency: 'USDC',
          unit: 'request',
        },
      ],
    });
    await expensiveSeller.listen(0);

    try {
      const result = await negotiate({
        service: 'inference',
        maxBudget: '0.01',
        sellers: [sellerEndpoint, expensiveSeller.getEndpoint()],
        autoAccept: false,
        timeout: 15_000,
      });

      expect(result.quotes.length).toBe(2);
      const price0 = parseFloat(result.quotes[0].pricing.price_per_unit);
      const price1 = parseFloat(result.quotes[1].pricing.price_per_unit);
      expect(price0).toBeLessThanOrEqual(price1);
    } finally {
      await expensiveSeller.close();
    }
  });

  it('respects timeout with unreachable sellers', async () => {
    const start = Date.now();
    const result = await negotiate({
      service: 'inference',
      maxBudget: '0.01',
      sellers: ['http://127.0.0.1:19999'],
      timeout: 2_000,
    });
    const elapsed = Date.now() - start;

    // Should return within a reasonable margin of the timeout
    expect(elapsed).toBeLessThan(10_000);
    // No quotes from an unreachable seller
    expect(result.quotes).toEqual([]);
    expect(result.sellersContacted).toBe(1);
  });

  it('uses custom SLA when provided', async () => {
    const result = await negotiate({
      service: 'inference',
      maxBudget: '0.01',
      sellers: [sellerEndpoint],
      sla: {
        metrics: [
          { name: 'uptime_pct', target: 99.99, comparison: 'gte' },
        ],
        dispute_resolution: { method: 'manual_arbitration' },
      },
      timeout: 15_000,
    });

    expect(result.quotes.length).toBeGreaterThanOrEqual(1);
    expect(result.agreement).toBeDefined();
  });

  it('records durationMs accurately', async () => {
    const before = Date.now();
    const result = await negotiate({
      service: 'inference',
      maxBudget: '0.01',
      sellers: [sellerEndpoint],
      timeout: 15_000,
    });
    const after = Date.now();

    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.durationMs).toBeLessThanOrEqual(after - before + 50);
  });
});
