import { describe, it, expect, vi } from 'vitest';
import { OPHIR_TOOLS, handleOphirFunctionCall } from '../index.js';

// Mock the SDK functions so tests don't hit real endpoints
vi.mock('@ophirai/sdk', () => ({
  negotiate: vi.fn().mockResolvedValue({
    quotes: [
      {
        rfq_id: 'rfq-1',
        seller: { agent_id: 'did:key:seller1', endpoint: 'http://seller1:3000' },
        pricing: { price: '0.008', currency: 'USDC', unit: 'request' },
      },
    ],
    agreement: {
      agreement_id: 'agr-1',
      rfq_id: 'rfq-1',
      final_terms: { price: '0.008', currency: 'USDC', unit: 'request' },
    },
    acceptedQuote: {
      rfq_id: 'rfq-1',
      seller: { agent_id: 'did:key:seller1', endpoint: 'http://seller1:3000' },
      pricing: { price: '0.008', currency: 'USDC', unit: 'request' },
    },
    sellersContacted: 2,
    durationMs: 1234,
  }),
  autoDiscover: vi.fn().mockResolvedValue([
    {
      agentId: 'did:key:agent1',
      endpoint: 'http://agent1:3000',
      services: [
        { category: 'inference', description: 'LLM inference', base_price: '0.01', currency: 'USDC', unit: 'request' },
      ],
      reputation: { score: 0.95, total_agreements: 100, disputes_won: 2, disputes_lost: 0 },
    },
  ]),
}));

describe('OPHIR_TOOLS', () => {
  it('exports an array of tools with correct structure', () => {
    expect(Array.isArray(OPHIR_TOOLS)).toBe(true);
    expect(OPHIR_TOOLS.length).toBe(2);
    for (const tool of OPHIR_TOOLS) {
      expect(tool.type).toBe('function');
      expect(tool.function).toBeDefined();
      expect(typeof tool.function.name).toBe('string');
      expect(typeof tool.function.description).toBe('string');
      expect(tool.function.parameters).toBeDefined();
    }
  });

  it('includes ophir_negotiate with required parameters', () => {
    const negotiate = OPHIR_TOOLS.find((t) => t.function.name === 'ophir_negotiate');
    expect(negotiate).toBeDefined();
    const params = negotiate!.function.parameters as Record<string, unknown>;
    expect(params.required).toEqual(['service', 'max_budget']);
    const props = (params as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty('service');
    expect(props).toHaveProperty('max_budget');
    expect(props).toHaveProperty('currency');
    expect(props).toHaveProperty('sla_requirements');
    expect(props).toHaveProperty('auto_accept');
  });

  it('includes ophir_list_services with optional category', () => {
    const listServices = OPHIR_TOOLS.find((t) => t.function.name === 'ophir_list_services');
    expect(listServices).toBeDefined();
    const params = listServices!.function.parameters as { properties: Record<string, unknown> };
    expect(params.properties).toHaveProperty('category');
  });
});

describe('handleOphirFunctionCall', () => {
  it('handles ophir_negotiate and returns JSON string', async () => {
    const result = await handleOphirFunctionCall('ophir_negotiate', {
      service: 'inference',
      max_budget: '0.01',
    });
    const parsed = JSON.parse(result);
    expect(parsed.sellersContacted).toBe(2);
    expect(parsed.quotes).toHaveLength(1);
    expect(parsed.agreement).toBeDefined();
    expect(parsed.agreement.agreement_id).toBe('agr-1');
  });

  it('passes SLA requirements and model through to negotiate', async () => {
    const { negotiate } = await import('@ophirai/sdk');
    const mockNegotiate = vi.mocked(negotiate);
    mockNegotiate.mockClear();

    await handleOphirFunctionCall('ophir_negotiate', {
      service: 'inference',
      model: 'llama-3-70b',
      max_budget: '0.02',
      currency: 'USDC',
      sla_requirements: { uptime_pct: 99.9, max_latency_ms: 200 },
      auto_accept: false,
    });

    expect(mockNegotiate).toHaveBeenCalledWith(
      expect.objectContaining({
        service: 'inference',
        model: 'llama-3-70b',
        maxBudget: '0.02',
        currency: 'USDC',
        autoAccept: false,
        sla: {
          metrics: [
            { name: 'uptime_pct', target: 99.9, comparison: 'gte' },
            { name: 'p99_latency_ms', target: 200, comparison: 'lte' },
          ],
          dispute_resolution: { method: 'automatic_escrow' },
        },
      }),
    );
  });

  it('handles ophir_list_services and returns providers', async () => {
    const result = await handleOphirFunctionCall('ophir_list_services', {
      category: 'inference',
    });
    const parsed = JSON.parse(result);
    expect(parsed.providers).toHaveLength(1);
    expect(parsed.providers[0].agentId).toBe('did:key:agent1');
    expect(parsed.providers[0].services[0].category).toBe('inference');
  });

  it('handles ophir_list_services without category', async () => {
    const { autoDiscover } = await import('@ophirai/sdk');
    const mockDiscover = vi.mocked(autoDiscover);
    mockDiscover.mockClear();

    await handleOphirFunctionCall('ophir_list_services', {});

    expect(mockDiscover).toHaveBeenCalledWith('');
  });

  it('throws on unknown function name', async () => {
    await expect(
      handleOphirFunctionCall('ophir_unknown', {}),
    ).rejects.toThrow('Unknown Ophir function: ophir_unknown');
  });
});
