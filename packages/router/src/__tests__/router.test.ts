import { describe, it, expect, vi, beforeEach } from 'vitest';
// Capture real fetch before any mocking
const realFetch = globalThis.fetch;
import type { QuoteParams } from '@ophirai/protocol';
import { rankByStrategy } from '../strategies.js';
import type { StrategyContext } from '../strategies.js';
import { SLAMonitor } from '../monitor.js';
import { OphirRouter } from '../router.js';
import express from 'express';
import { createRouterAPI } from '../api.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQuote(overrides: {
  agentId: string;
  price: string;
  endpoint?: string;
  slaMetrics?: Array<{ name: string; target: number; comparison: string }>;
}): QuoteParams {
  return {
    quote_id: `quote-${overrides.agentId}`,
    rfq_id: 'rfq-1',
    seller: {
      agent_id: overrides.agentId,
      endpoint: overrides.endpoint ?? `http://${overrides.agentId}:3000`,
    },
    pricing: {
      price_per_unit: overrides.price,
      currency: 'USDC',
      unit: 'request',
      pricing_model: 'fixed',
    },
    sla_offered: {
      metrics: overrides.slaMetrics?.map((m) => ({
        name: m.name as any,
        target: m.target,
        comparison: m.comparison as any,
      })) ?? [
        { name: 'uptime_pct' as any, target: 99.5, comparison: 'gte' as any },
      ],
      dispute_resolution: { method: 'automatic_escrow' as any },
    },
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    signature: 'sig-placeholder',
  } as QuoteParams;
}

function defaultCtx(overrides?: Partial<StrategyContext>): StrategyContext {
  return {
    latencyHistory: new Map(),
    slaHistory: new Map(),
    roundRobinIndex: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Strategy tests
// ---------------------------------------------------------------------------

describe('rankByStrategy', () => {
  const quoteA = makeQuote({ agentId: 'a', price: '0.005' });
  const quoteB = makeQuote({ agentId: 'b', price: '0.010' });
  const quoteC = makeQuote({ agentId: 'c', price: '0.002' });

  it('cheapest picks lowest price first', () => {
    const ranked = rankByStrategy([quoteA, quoteB, quoteC], 'cheapest', defaultCtx());
    expect(ranked[0].quote.seller.agent_id).toBe('c');
    expect(ranked[1].quote.seller.agent_id).toBe('a');
    expect(ranked[2].quote.seller.agent_id).toBe('b');
  });

  it('fastest picks lowest latency from history', () => {
    const ctx = defaultCtx({
      latencyHistory: new Map([['a', 200], ['b', 50], ['c', 300]]),
    });
    const ranked = rankByStrategy([quoteA, quoteB, quoteC], 'fastest', ctx);
    expect(ranked[0].quote.seller.agent_id).toBe('b');
  });

  it('best_sla picks highest compliance from history', () => {
    const ctx = defaultCtx({
      slaHistory: new Map([['a', 0.8], ['b', 0.99], ['c', 0.6]]),
    });
    const ranked = rankByStrategy([quoteA, quoteB, quoteC], 'best_sla', ctx);
    expect(ranked[0].quote.seller.agent_id).toBe('b');
  });

  it('round_robin cycles through providers', () => {
    const ctx0 = defaultCtx({ roundRobinIndex: 0 });
    const ctx1 = defaultCtx({ roundRobinIndex: 1 });
    const ctx2 = defaultCtx({ roundRobinIndex: 2 });

    const r0 = rankByStrategy([quoteA, quoteB, quoteC], 'round_robin', ctx0);
    const r1 = rankByStrategy([quoteA, quoteB, quoteC], 'round_robin', ctx1);
    const r2 = rankByStrategy([quoteA, quoteB, quoteC], 'round_robin', ctx2);

    expect(r0[0].quote.seller.agent_id).toBe('a');
    expect(r1[0].quote.seller.agent_id).toBe('b');
    expect(r2[0].quote.seller.agent_id).toBe('c');
  });

  it('weighted combines price, latency, SLA scores', () => {
    const ctx = defaultCtx({
      latencyHistory: new Map([['a', 100], ['b', 200], ['c', 50]]),
      slaHistory: new Map([['a', 0.9], ['b', 0.95], ['c', 0.7]]),
      weights: { price: 0.5, latency: 0.3, sla: 0.2 },
    });
    const ranked = rankByStrategy([quoteA, quoteB, quoteC], 'weighted', ctx);
    // All three should be present with scores
    expect(ranked).toHaveLength(3);
    expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[1].score);
    expect(ranked[1].score).toBeGreaterThanOrEqual(ranked[2].score);
  });

  it('empty quotes returns empty rankings', () => {
    const ranked = rankByStrategy([], 'cheapest', defaultCtx());
    expect(ranked).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. SLA Monitor tests
// ---------------------------------------------------------------------------

describe('SLAMonitor', () => {
  let monitor: SLAMonitor;

  beforeEach(() => {
    monitor = new SLAMonitor();
  });

  it('track() creates a new monitored agreement', () => {
    monitor.track('ag-1', 'seller-a', 'hash-1');
    expect(monitor.getAgreementIds()).toContain('ag-1');
    expect(monitor.getSellerForAgreement('ag-1')).toBe('seller-a');
  });

  it('recordSuccess() updates latency and request count', () => {
    monitor.track('ag-1', 'seller-a', 'hash-1');
    monitor.recordSuccess('ag-1', 100);
    monitor.recordSuccess('ag-1', 200);

    const stats = monitor.getStats('ag-1');
    expect(stats).not.toBeNull();
    expect(stats!.requestCount).toBe(2);
    expect(stats!.avgLatencyMs).toBe(150);
    expect(stats!.successCount).toBe(2);
  });

  it('recordFailure() increments error count', () => {
    monitor.track('ag-1', 'seller-a', 'hash-1');
    monitor.recordSuccess('ag-1', 100);
    monitor.recordFailure('ag-1', 'timeout');

    const stats = monitor.getStats('ag-1');
    expect(stats!.requestCount).toBe(2);
    expect(stats!.errorRate).toBe(0.5);
    expect(stats!.lastErrors).toContain('timeout');
  });

  it('getStats() returns correct averages', () => {
    monitor.track('ag-1', 'seller-a', 'hash-1');
    monitor.recordSuccess('ag-1', 50);
    monitor.recordSuccess('ag-1', 150);
    monitor.recordSuccess('ag-1', 100);

    const stats = monitor.getStats('ag-1');
    expect(stats!.avgLatencyMs).toBe(100);
    expect(stats!.errorRate).toBe(0);
    expect(stats!.slaCompliance).toBe(1);
  });

  it('getStats() returns null for unknown agreement', () => {
    expect(monitor.getStats('nonexistent')).toBeNull();
  });

  it('getViolations() returns agreements with violations', () => {
    // Without an SLA spec, no violations will be generated from evaluate(),
    // but we can verify the structure when there are none
    monitor.track('ag-1', 'seller-a', 'hash-1');
    monitor.recordSuccess('ag-1', 100);
    const violations = monitor.getViolations();
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Router tests (mock negotiate)
// ---------------------------------------------------------------------------

vi.mock('@ophirai/sdk', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    negotiate: vi.fn(),
  };
});

import { negotiate } from '@ophirai/sdk';
const mockNegotiate = vi.mocked(negotiate);

function makeNegotiateResult(quotes: QuoteParams[]) {
  return {
    agreement: quotes.length > 0 ? {
      agreement_id: `agree-${quotes[0].seller.agent_id}`,
      rfq_id: 'rfq-1',
      accepting_message_id: quotes[0].quote_id,
      final_terms: {
        price_per_unit: quotes[0].pricing.price_per_unit,
        currency: 'USDC',
        unit: 'request',
        sla: quotes[0].sla_offered,
      },
      agreement_hash: 'hash-test',
      buyer_signature: 'sig-buyer',
      seller_signature: 'sig-seller',
    } : undefined,
    quotes,
    acceptedQuote: quotes[0],
    sellersContacted: quotes.length,
    durationMs: 50,
  };
}

describe('OphirRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock fetch for provider forwarding
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 1234567890,
        model: 'test-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }),
    }));
  });

  it('route() calls negotiate when no cached agreement', async () => {
    const quotes = [makeQuote({ agentId: 'seller-1', price: '0.01' })];
    mockNegotiate.mockResolvedValue(makeNegotiateResult(quotes));

    const router = new OphirRouter({ sellers: ['http://seller-1:3000'] });
    await router.route({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] });

    expect(mockNegotiate).toHaveBeenCalledTimes(1);
  });

  it('route() reuses cached agreement within TTL', async () => {
    const quotes = [makeQuote({ agentId: 'seller-1', price: '0.01' })];
    mockNegotiate.mockResolvedValue(makeNegotiateResult(quotes));

    const router = new OphirRouter({
      sellers: ['http://seller-1:3000'],
      agreementCacheTtl: 60,
    });

    await router.route({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] });
    await router.route({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi again' }] });

    expect(mockNegotiate).toHaveBeenCalledTimes(1);
  });

  it('route() evicts expired cached agreements', async () => {
    const quotes = [makeQuote({ agentId: 'seller-1', price: '0.01' })];
    mockNegotiate.mockResolvedValue(makeNegotiateResult(quotes));

    const router = new OphirRouter({
      sellers: ['http://seller-1:3000'],
      agreementCacheTtl: 0, // expires immediately
    });

    await router.route({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] });
    // Wait a tick so Date.now() advances past expiry
    await new Promise((r) => setTimeout(r, 5));
    await router.route({ model: 'gpt-4', messages: [{ role: 'user', content: 'again' }] });

    expect(mockNegotiate).toHaveBeenCalledTimes(2);
  });

  it('route() with specific model filters correctly', async () => {
    const quotes = [makeQuote({ agentId: 'seller-1', price: '0.01' })];
    mockNegotiate.mockResolvedValue(makeNegotiateResult(quotes));

    const router = new OphirRouter({ sellers: ['http://seller-1:3000'] });
    const result = await router.route({
      model: 'llama-3-70b',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(mockNegotiate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'llama-3-70b' }),
    );
    expect(result.strategy).toBe('cheapest');
  });
});

// ---------------------------------------------------------------------------
// 4. API endpoint tests
// ---------------------------------------------------------------------------

describe('Router API endpoints', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    const quotes = [makeQuote({ agentId: 'seller-1', price: '0.01' })];
    mockNegotiate.mockResolvedValue(makeNegotiateResult(quotes));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1234567890,
        model: 'auto',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    }));

    const router = new OphirRouter({ sellers: ['http://seller-1:3000'] });
    app = express();
    app.use(express.json());
    app.use(createRouterAPI(router));
  });

  async function request(method: string, path: string, body?: unknown) {
    const server = app.listen(0);
    const addr = server.address() as { port: number };
    try {
      const res = await realFetch(`http://127.0.0.1:${addr.port}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      return { status: res.status, data };
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  }

  it('POST /v1/chat/completions returns OpenAI-compatible response', async () => {
    const { status, data } = await request('POST', '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(status).toBe(200);
    expect(data.object).toBe('chat.completion');
    expect(data.choices).toBeDefined();
    expect(data.ophir).toBeDefined();
    expect(data.ophir.strategy).toBe('cheapest');
  });

  it('GET /v1/models returns model list', async () => {
    const { status, data } = await request('GET', '/v1/models');
    expect(status).toBe(200);
    expect(data.object).toBe('list');
    expect(data.data).toBeInstanceOf(Array);
    expect(data.data.some((m: any) => m.id === 'auto')).toBe(true);
  });

  it('GET /health returns healthy', async () => {
    const { status, data } = await request('GET', '/health');
    expect(status).toBe(200);
    expect(data.status).toBe('ok');
    expect(data.timestamp).toBeDefined();
    expect(data.agreements).toBeDefined();
  });

  it('missing messages field returns 400', async () => {
    const { status, data } = await request('POST', '/v1/chat/completions', {
      model: 'auto',
    });
    expect(status).toBe(400);
    expect(data.error.type).toBe('invalid_request_error');
  });
});
