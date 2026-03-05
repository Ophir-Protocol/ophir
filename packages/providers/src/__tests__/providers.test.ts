import { describe, it, expect, afterAll } from 'vitest';
import {
  BaseProvider,
  OpenAIProvider,
  AnthropicProvider,
  TogetherProvider,
  GroqProvider,
  OpenRouterProvider,
  ReplicateProvider,
  createProvider,
  PROVIDERS,
  dynamicPrice,
} from '../index.js';
import type { ProviderConfig } from '../index.js';

/* ------------------------------------------------------------------ */
/*  1. BaseProvider tests                                              */
/* ------------------------------------------------------------------ */
describe('BaseProvider', () => {
  it('buildServiceOfferings() creates offerings from models', () => {
    const provider = new OpenAIProvider();
    // Access protected method via the public offerings on the SellerAgent card
    const offerings = (provider as any).buildServiceOfferings();
    expect(offerings.length).toBe(4); // gpt-4o, gpt-4o-mini, gpt-3.5-turbo, embedding
    for (const o of offerings) {
      expect(o).toHaveProperty('category');
      expect(o).toHaveProperty('description');
      expect(o).toHaveProperty('base_price');
      expect(o).toHaveProperty('currency', 'USDC');
      expect(o).toHaveProperty('unit', '1M_tokens');
      expect(o).toHaveProperty('capacity', 100);
    }
  });

  it('getPrice() returns default model price', () => {
    const provider = new OpenAIProvider();
    const inputPrice = (provider as any).getPrice('gpt-4o', 'input');
    const outputPrice = (provider as any).getPrice('gpt-4o', 'output');
    expect(inputPrice).toBe(2.5);
    expect(outputPrice).toBe(10.0);
  });

  it('getPrice() respects pricing overrides', () => {
    const provider = new OpenAIProvider({
      pricing: { 'gpt-4o': { input: 1.0, output: 5.0, unit: '1M_tokens' } },
    });
    expect((provider as any).getPrice('gpt-4o', 'input')).toBe(1.0);
    expect((provider as any).getPrice('gpt-4o', 'output')).toBe(5.0);
  });

  it('getPrice() returns 0 for unknown model', () => {
    const provider = new OpenAIProvider();
    expect((provider as any).getPrice('nonexistent-model', 'input')).toBe(0);
  });

  it('start()/stop() lifecycle works with SellerAgent', async () => {
    const provider = new OpenAIProvider({ port: 0 });
    await provider.start();
    const endpoint = provider.getEndpoint();
    expect(endpoint).toMatch(/http:\/\/localhost:\d+/);
    await provider.stop();
  });

  it('getAgentId() returns a did:key', () => {
    const provider = new OpenAIProvider();
    expect(provider.getAgentId()).toMatch(/^did:key:z/);
  });
});

/* ------------------------------------------------------------------ */
/*  2. Individual provider tests                                       */
/* ------------------------------------------------------------------ */
const providerSpecs: Array<{
  name: string;
  ProviderClass: new (config?: ProviderConfig) => BaseProvider;
  expectedName: string;
  minModels: number;
}> = [
  { name: 'OpenAIProvider', ProviderClass: OpenAIProvider, expectedName: 'openai', minModels: 4 },
  { name: 'AnthropicProvider', ProviderClass: AnthropicProvider, expectedName: 'anthropic', minModels: 2 },
  { name: 'TogetherProvider', ProviderClass: TogetherProvider, expectedName: 'together', minModels: 4 },
  { name: 'GroqProvider', ProviderClass: GroqProvider, expectedName: 'groq', minModels: 4 },
  { name: 'OpenRouterProvider', ProviderClass: OpenRouterProvider, expectedName: 'openrouter', minModels: 5 },
  { name: 'ReplicateProvider', ProviderClass: ReplicateProvider, expectedName: 'replicate', minModels: 3 },
];

describe.each(providerSpecs)('$name', ({ ProviderClass, expectedName, minModels }) => {
  const provider = new ProviderClass();

  it('extends BaseProvider', () => {
    expect(provider).toBeInstanceOf(BaseProvider);
  });

  it(`has correct provider name "${expectedName}"`, () => {
    expect((provider as any).name).toBe(expectedName);
  });

  it('has a non-empty model catalog', () => {
    const models = (provider as any).models as any[];
    expect(models.length).toBeGreaterThanOrEqual(minModels);
  });

  it('all models have category, positive prices, and id/name', () => {
    const models = (provider as any).models as any[];
    for (const m of models) {
      expect(m.id).toBeTruthy();
      expect(m.name).toBeTruthy();
      expect(m.category).toBeTruthy();
      expect(m.inputPrice).toBeGreaterThanOrEqual(0);
      // outputPrice can be 0 for embedding models
      expect(m.outputPrice).toBeGreaterThanOrEqual(0);
      // At least one of input or output must be positive
      expect(m.inputPrice + m.outputPrice).toBeGreaterThan(0);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  3. Factory tests                                                   */
/* ------------------------------------------------------------------ */
describe('createProvider factory', () => {
  it('creates OpenAIProvider', () => {
    const p = createProvider('openai', {});
    expect(p).toBeInstanceOf(OpenAIProvider);
  });

  it('creates AnthropicProvider', () => {
    const p = createProvider('anthropic', {});
    expect(p).toBeInstanceOf(AnthropicProvider);
  });

  it('creates TogetherProvider', () => {
    const p = createProvider('together', {});
    expect(p).toBeInstanceOf(TogetherProvider);
  });

  it('creates GroqProvider', () => {
    const p = createProvider('groq', {});
    expect(p).toBeInstanceOf(GroqProvider);
  });

  it('creates OpenRouterProvider', () => {
    const p = createProvider('openrouter', {});
    expect(p).toBeInstanceOf(OpenRouterProvider);
  });

  it('creates ReplicateProvider', () => {
    const p = createProvider('replicate', {});
    expect(p).toBeInstanceOf(ReplicateProvider);
  });

  it('PROVIDERS map contains all 6 providers', () => {
    expect(Object.keys(PROVIDERS)).toHaveLength(6);
    expect(Object.keys(PROVIDERS).sort()).toEqual(
      ['anthropic', 'groq', 'openai', 'openrouter', 'replicate', 'together'],
    );
  });
});

/* ------------------------------------------------------------------ */
/*  4. Dynamic pricing tests                                           */
/* ------------------------------------------------------------------ */
describe('dynamicPrice', () => {
  it('high load increases price', () => {
    const result = dynamicPrice(1.0, { currentLoad: 0.9, demandMultiplier: 1, timeOfDay: 12 });
    expect(result).toBeGreaterThan(1.0);
  });

  it('low load decreases price', () => {
    const result = dynamicPrice(1.0, { currentLoad: 0.1, demandMultiplier: 1, timeOfDay: 12 });
    expect(result).toBeLessThan(1.0);
  });

  it('no context returns base price', () => {
    expect(dynamicPrice(1.0, undefined)).toBe(1.0);
  });

  it('off-peak hours (UTC 0-8) reduce price', () => {
    const peak = dynamicPrice(1.0, { currentLoad: 0.5, demandMultiplier: 1, timeOfDay: 12 });
    const offPeak = dynamicPrice(1.0, { currentLoad: 0.5, demandMultiplier: 1, timeOfDay: 4 });
    expect(offPeak).toBeLessThan(peak);
  });

  it('maximum load (1.0) gives 1.5x multiplier', () => {
    const result = dynamicPrice(1.0, { currentLoad: 1.0, demandMultiplier: 1, timeOfDay: 12 });
    expect(result).toBeCloseTo(1.5, 5);
  });

  it('zero load gives 0.8x multiplier', () => {
    const result = dynamicPrice(1.0, { currentLoad: 0.0, demandMultiplier: 1, timeOfDay: 12 });
    expect(result).toBeCloseTo(0.8, 5);
  });

  it('demand multiplier scales linearly', () => {
    const base = dynamicPrice(1.0, { currentLoad: 0.5, demandMultiplier: 1, timeOfDay: 12 });
    const doubled = dynamicPrice(1.0, { currentLoad: 0.5, demandMultiplier: 2, timeOfDay: 12 });
    expect(doubled).toBeCloseTo(base * 2, 5);
  });
});

/* ------------------------------------------------------------------ */
/*  5. SellerAgent integration tests                                   */
/* ------------------------------------------------------------------ */
describe('SellerAgent integration', () => {
  let provider: OpenAIProvider;

  afterAll(async () => {
    try { await provider?.stop(); } catch { /* already stopped */ }
  });

  it('started provider has a reachable .well-known/agent.json', async () => {
    provider = new OpenAIProvider({ port: 0 });
    await provider.start();
    const endpoint = provider.getEndpoint();

    const res = await fetch(`${endpoint}/.well-known/agent.json`);
    expect(res.ok).toBe(true);
    const card = await res.json();

    expect(card).toHaveProperty('name');
    expect(card).toHaveProperty('url');
    expect(card.capabilities.negotiation.supported).toBe(true);
    expect(card.capabilities.negotiation.services.length).toBeGreaterThan(0);
  });

  it('agent card lists services matching the provider models', async () => {
    // provider is still running from the previous test
    const endpoint = provider.getEndpoint();
    const res = await fetch(`${endpoint}/.well-known/agent.json`);
    const card = await res.json();

    const services = card.capabilities.negotiation.services;
    // OpenAI has 4 models → 4 services
    expect(services.length).toBe(4);
    const categories = services.map((s: any) => s.category);
    expect(categories).toContain('inference');
    expect(categories).toContain('embedding');
  });

  it('agent card contains a valid url', async () => {
    const endpoint = provider.getEndpoint();
    const res = await fetch(`${endpoint}/.well-known/agent.json`);
    const card = await res.json();
    expect(card.url).toMatch(/^http:\/\/localhost:\d+/);
  });
});
