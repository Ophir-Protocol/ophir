import { describe, it, expect, afterEach } from 'vitest';
import {
  SellerAgent,
  BuyerAgent,
  MetricCollector,
  generateKeyPair,
  signMessage,
  buildDispute,
} from '@ophirai/sdk';
import type { RFQParams, QuoteParams, SLARequirement, ViolationEvidence } from '@ophirai/protocol';
import { DEFAULT_CONFIG } from '@ophirai/protocol';
import { randomUUID } from 'node:crypto';

// ─── Shared setup ────────────────────────────────────────────────────────────

interface ProviderProfile {
  name: string;
  model: string;
  pricePerMillion: number;
  baseLatencyMs: number;
  errorRate: number;
}

const PROVIDERS: ProviderProfile[] = [
  { name: 'Provider A', model: 'gpt-4o-mini', pricePerMillion: 0.15, baseLatencyMs: 50, errorRate: 0.05 },
  { name: 'Provider B', model: 'llama-3-70b', pricePerMillion: 0.90, baseLatencyMs: 200, errorRate: 0.01 },
  { name: 'Provider C', model: 'gpt-4o', pricePerMillion: 2.50, baseLatencyMs: 500, errorRate: 0.001 },
];

function createSeller(profile: ProviderProfile, port: number) {
  const kp = generateKeyPair();
  const pricePerUnit = (profile.pricePerMillion / 1_000_000).toFixed(10);

  const seller = new SellerAgent({
    keypair: kp,
    endpoint: `http://localhost:${port}`,
    services: [{
      category: 'inference',
      description: `${profile.model} inference service`,
      base_price: pricePerUnit,
      currency: 'USDC',
      unit: 'request',
    }],
  });

  seller.onRFQ(async (rfq: RFQParams): Promise<QuoteParams | null> => {
    const sla: SLARequirement = {
      metrics: [
        { name: 'p99_latency_ms', target: profile.baseLatencyMs * 4, comparison: 'lte' },
        { name: 'uptime_pct', target: (1 - profile.errorRate) * 100, comparison: 'gte' },
      ],
      dispute_resolution: { method: 'automatic_escrow', timeout_hours: 24 },
    };

    const unsigned = {
      quote_id: randomUUID(),
      rfq_id: rfq.rfq_id,
      seller: {
        agent_id: seller.getAgentId(),
        endpoint: seller.getEndpoint(),
      },
      pricing: {
        price_per_unit: pricePerUnit,
        currency: 'USDC',
        unit: 'request',
        pricing_model: 'fixed' as const,
      },
      sla_offered: sla,
      expires_at: new Date(Date.now() + DEFAULT_CONFIG.quote_timeout_ms).toISOString(),
    };

    const signature = signMessage(unsigned, kp.secretKey);
    return { ...unsigned, signature };
  });

  return { seller, keypair: kp };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Self-Negotiating Demo Components', () => {
  const sellers: SellerAgent[] = [];
  let buyer: BuyerAgent | undefined;

  afterEach(async () => {
    for (const s of sellers) await s.close().catch(() => {});
    sellers.length = 0;
    await buyer?.close().catch(() => {});
    buyer = undefined;
  });

  it('should create and start 3 SellerAgents on random ports', async () => {
    for (const profile of PROVIDERS) {
      const { seller } = createSeller(profile, 0);
      await seller.listen(0);
      sellers.push(seller);
    }

    expect(sellers).toHaveLength(3);
    for (const s of sellers) {
      expect(s.getAgentId()).toMatch(/^did:key:z/);
      expect(s.getEndpoint()).toMatch(/^http:\/\/localhost:\d+$/);
    }

    // All ports should be unique
    const ports = sellers.map(s => new URL(s.getEndpoint()).port);
    expect(new Set(ports).size).toBe(3);
  });

  it('should allow a BuyerAgent to discover all 3 sellers via direct endpoints', async () => {
    for (const profile of PROVIDERS) {
      const { seller } = createSeller(profile, 0);
      await seller.listen(0);
      sellers.push(seller);
    }

    const buyerKeypair = generateKeyPair();
    buyer = new BuyerAgent({ keypair: buyerKeypair, endpoint: 'http://localhost:0' });
    await buyer.listen(0);

    const sellerEndpoints = sellers.map(s => s.getEndpoint());
    expect(sellerEndpoints).toHaveLength(3);

    // Verify each seller has a well-known agent card
    for (const endpoint of sellerEndpoints) {
      const res = await fetch(`${endpoint}/.well-known/agent.json`);
      expect(res.ok).toBe(true);
      const card = await res.json();
      expect(card.capabilities.negotiation.supported).toBe(true);
      expect(card.capabilities.negotiation.services).toHaveLength(1);
      expect(card.capabilities.negotiation.services[0].category).toBe('inference');
    }
  });

  it('should negotiate and receive quotes from all 3 sellers', async () => {
    for (const profile of PROVIDERS) {
      const { seller } = createSeller(profile, 0);
      await seller.listen(0);
      sellers.push(seller);
    }

    const buyerKeypair = generateKeyPair();
    buyer = new BuyerAgent({ keypair: buyerKeypair, endpoint: 'http://localhost:0' });
    await buyer.listen(0);

    const session = await buyer.requestQuotes({
      sellers: sellers.map(s => s.getEndpoint()),
      service: { category: 'inference', requirements: { model: 'gpt-4o-mini' } },
      budget: { max_price_per_unit: '1.00', currency: 'USDC', unit: 'request' },
      sla: {
        metrics: [
          { name: 'p99_latency_ms', target: 1000, comparison: 'lte' },
          { name: 'uptime_pct', target: 99, comparison: 'gte' },
        ],
      },
    });

    const quotes = await buyer.waitForQuotes(session, {
      minQuotes: 3,
      timeout: 10_000,
    });

    expect(quotes).toHaveLength(3);
    for (const q of quotes) {
      expect(q.pricing.currency).toBe('USDC');
      expect(q.pricing.unit).toBe('request');
      expect(q.sla_offered).toBeDefined();
      expect(q.signature).toBeDefined();
    }
  });

  it('should rank quotes and accept the cheapest one', async () => {
    for (const profile of PROVIDERS) {
      const { seller } = createSeller(profile, 0);
      await seller.listen(0);
      sellers.push(seller);
    }

    const buyerKeypair = generateKeyPair();
    buyer = new BuyerAgent({ keypair: buyerKeypair, endpoint: 'http://localhost:0' });
    await buyer.listen(0);

    const session = await buyer.requestQuotes({
      sellers: sellers.map(s => s.getEndpoint()),
      service: { category: 'inference' },
      budget: { max_price_per_unit: '1.00', currency: 'USDC', unit: 'request' },
    });

    const quotes = await buyer.waitForQuotes(session, { minQuotes: 3, timeout: 10_000 });
    const ranked = buyer.rankQuotes(quotes, 'cheapest');

    // Cheapest should be Provider A ($0.15/1M)
    const cheapestPrice = parseFloat(ranked[0].pricing.price_per_unit);
    const secondPrice = parseFloat(ranked[1].pricing.price_per_unit);
    expect(cheapestPrice).toBeLessThanOrEqual(secondPrice);

    // Accept the best quote
    const agreement = await buyer.acceptQuote(ranked[0]);

    expect(agreement.agreement_id).toBeDefined();
    expect(agreement.agreement_hash).toBeDefined();
    expect(agreement.buyer_signature).toBeDefined();
    expect(agreement.seller_signature).toBeDefined();
    expect(agreement.final_terms.price_per_unit).toBe(ranked[0].pricing.price_per_unit);
    expect(agreement.final_terms.currency).toBe('USDC');
  });

  it('should detect SLA violations with MetricCollector after degradation', () => {
    const collector = new MetricCollector({
      agreement_id: 'test-agreement',
      agreement_hash: 'test-hash',
    });

    // Record 7 normal requests
    for (let i = 0; i < 7; i++) {
      collector.record('p99_latency_ms', 50 + Math.floor(Math.random() * 20));
      collector.record('error_rate_pct', 0);
    }

    // Record 3 degraded requests (high latency, errors)
    for (let i = 0; i < 3; i++) {
      collector.record('p99_latency_ms', 2500 + Math.floor(Math.random() * 1000));
      collector.record('error_rate_pct', 100);
    }

    expect(collector.getObservationCount('p99_latency_ms')).toBe(10);
    expect(collector.getObservationCount('error_rate_pct')).toBe(10);

    // Check p99 latency - should be violated (threshold 1000ms)
    const p99Agg = collector.aggregate('p99_latency_ms', 'percentile', 3600_000);
    expect(p99Agg).not.toBeNull();
    expect(p99Agg!.value).toBeGreaterThan(1000);

    // Check error rate - should be elevated
    const errorAgg = collector.aggregate('error_rate_pct', 'rolling_average', 3600_000);
    expect(errorAgg).not.toBeNull();
    expect(errorAgg!.value).toBeGreaterThan(5); // 30% errors total
  });

  it('should build a valid signed dispute message', () => {
    const buyerKeypair = generateKeyPair();

    const violationEvidence: ViolationEvidence = {
      sla_metric: 'p99_latency_ms',
      agreed_value: 1000,
      observed_value: 2800,
      measurement_window: 'PT1H',
      evidence_hash: 'sha256:abc123',
    };

    const disputeMsg = buildDispute({
      agreementId: 'test-agreement-id',
      filedBy: { agent_id: `did:key:z${Buffer.from(buyerKeypair.publicKey).toString('hex').slice(0, 40)}`, role: 'buyer' },
      violation: violationEvidence,
      requestedRemedy: 'escrow_release',
      escrowAction: 'freeze',
      secretKey: buyerKeypair.secretKey,
    });

    expect(disputeMsg.method).toBe('negotiate/dispute');
    expect(disputeMsg.params.dispute_id).toBeDefined();
    expect(disputeMsg.params.agreement_id).toBe('test-agreement-id');
    expect(disputeMsg.params.violation.sla_metric).toBe('p99_latency_ms');
    expect(disputeMsg.params.violation.observed_value).toBe(2800);
    expect(disputeMsg.params.signature).toBeDefined();
  });

  it('should properly clean up all servers on close', async () => {
    for (const profile of PROVIDERS) {
      const { seller } = createSeller(profile, 0);
      await seller.listen(0);
      sellers.push(seller);
    }

    const buyerKeypair = generateKeyPair();
    buyer = new BuyerAgent({ keypair: buyerKeypair, endpoint: 'http://localhost:0' });
    await buyer.listen(0);

    const endpoints = [buyer.getEndpoint(), ...sellers.map(s => s.getEndpoint())];

    // All endpoints should be reachable before close
    for (const ep of endpoints) {
      const res = await fetch(`${ep}/.well-known/agent.json`).catch(() => null);
      // Buyer may not have agent.json, but seller endpoints should respond
    }

    // Close everything
    for (const s of sellers) await s.close();
    sellers.length = 0;
    await buyer.close();

    // After close, endpoints should be unreachable
    for (const ep of endpoints) {
      const res = await fetch(`${ep}/.well-known/agent.json`).catch(() => null);
      expect(res).toBeNull();
    }

    buyer = undefined;
  });

  it('should complete a full negotiation lifecycle end-to-end', async () => {
    // Setup sellers
    for (const profile of PROVIDERS) {
      const { seller } = createSeller(profile, 0);
      await seller.listen(0);
      sellers.push(seller);
    }

    // Setup buyer
    const buyerKeypair = generateKeyPair();
    buyer = new BuyerAgent({ keypair: buyerKeypair, endpoint: 'http://localhost:0' });
    await buyer.listen(0);

    // 1. Negotiate
    const session = await buyer.requestQuotes({
      sellers: sellers.map(s => s.getEndpoint()),
      service: { category: 'inference' },
      budget: { max_price_per_unit: '1.00', currency: 'USDC', unit: 'request' },
    });

    const quotes = await buyer.waitForQuotes(session, { minQuotes: 3, timeout: 10_000 });
    expect(quotes.length).toBe(3);

    // 2. Accept best
    const ranked = buyer.rankQuotes(quotes, 'cheapest');
    const agreement = await buyer.acceptQuote(ranked[0]);
    expect(agreement.seller_signature).toBeDefined();

    // 3. Simulate metrics
    const collector = new MetricCollector({
      agreement_id: agreement.agreement_id,
      agreement_hash: agreement.agreement_hash,
    });

    for (let i = 0; i < 7; i++) collector.record('p99_latency_ms', 55);
    for (let i = 0; i < 3; i++) collector.record('p99_latency_ms', 3000);

    const agg = collector.aggregate('p99_latency_ms', 'percentile', 3600_000);
    expect(agg!.value).toBeGreaterThan(1000);

    // 4. Build dispute directly (seller doesn't handle dispute method in mock)
    const disputeMsg = buildDispute({
      agreementId: agreement.agreement_id,
      filedBy: { agent_id: buyer.getAgentId(), role: 'buyer' },
      violation: {
        sla_metric: 'p99_latency_ms',
        agreed_value: 1000,
        observed_value: Math.round(agg!.value),
        measurement_window: 'PT1H',
        evidence_hash: agreement.agreement_hash,
      },
      requestedRemedy: 'escrow_release',
      escrowAction: 'freeze',
      secretKey: buyerKeypair.secretKey,
    });

    expect(disputeMsg.params.dispute_id).toBeDefined();
    expect(disputeMsg.params.agreement_id).toBe(agreement.agreement_id);
    expect(disputeMsg.params.violation.observed_value).toBeGreaterThan(1000);
  });
});
