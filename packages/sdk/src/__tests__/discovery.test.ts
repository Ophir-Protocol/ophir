import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { discoverAgents, parseAgentCard } from '../discovery.js';
import type { AgentCard, NegotiationCapability } from '../discovery.js';

function makeCard(overrides: Partial<AgentCard> = {}): AgentCard {
  return {
    name: 'Test Agent',
    description: 'A test seller agent',
    url: 'https://agent.example.com',
    capabilities: {
      negotiation: {
        supported: true,
        endpoint: 'https://agent.example.com/negotiate',
        protocols: ['ophir/1.0'],
        acceptedPayments: [{ network: 'solana', token: 'USDC' }],
        negotiationStyles: ['rfq'],
        maxNegotiationRounds: 5,
        services: [
          {
            category: 'inference',
            description: 'LLM inference',
            base_price: '0.005',
            currency: 'USDC',
            unit: 'request',
          },
        ],
      },
    },
    ...overrides,
  };
}

describe('parseAgentCard', () => {
  it('extracts SellerInfo from a card with negotiation capability', () => {
    const card = makeCard();
    const info = parseAgentCard(card);

    expect(info).not.toBeNull();
    expect(info!.agentId).toBe('https://agent.example.com');
    expect(info!.endpoint).toBe('https://agent.example.com/negotiate');
    expect(info!.services).toHaveLength(1);
    expect(info!.services[0]).toEqual({
      category: 'inference',
      description: 'LLM inference',
      base_price: '0.005',
      currency: 'USDC',
      unit: 'request',
    });
  });

  it('returns null for cards without negotiation capability', () => {
    const card = makeCard({
      capabilities: { streaming: { supported: true } },
    });
    const info = parseAgentCard(card);
    expect(info).toBeNull();
  });

  it('returns null when negotiation.supported is false', () => {
    const card = makeCard();
    (card.capabilities.negotiation as NegotiationCapability).supported = false;
    const info = parseAgentCard(card);
    expect(info).toBeNull();
  });

  it('returns null when services array is empty', () => {
    const card = makeCard();
    (card.capabilities.negotiation as NegotiationCapability).services = [];
    const info = parseAgentCard(card);
    expect(info).toBeNull();
  });

  it('handles multiple services', () => {
    const card = makeCard();
    (card.capabilities.negotiation as NegotiationCapability).services = [
      {
        category: 'inference',
        description: 'LLM inference',
        base_price: '0.005',
        currency: 'USDC',
        unit: 'request',
      },
      {
        category: 'translation',
        description: 'Text translation',
        base_price: '0.002',
        currency: 'USDC',
        unit: 'request',
      },
    ];
    const info = parseAgentCard(card);
    expect(info).not.toBeNull();
    expect(info!.services).toHaveLength(2);
    expect(info!.services[0].category).toBe('inference');
    expect(info!.services[1].category).toBe('translation');
  });

  it('returns null when capabilities is undefined', () => {
    const card = { name: 'X', description: 'X', url: 'http://x', capabilities: {} };
    const info = parseAgentCard(card);
    expect(info).toBeNull();
  });
});

describe('discoverAgents', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('fetches /.well-known/agent.json from each endpoint', async () => {
    const card = makeCard();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(card),
    });
    vi.stubGlobal('fetch', mockFetch);

    const agents = await discoverAgents(['https://a.com', 'https://b.com']);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledWith('https://a.com/.well-known/agent.json');
    expect(mockFetch).toHaveBeenCalledWith('https://b.com/.well-known/agent.json');
    expect(agents).toHaveLength(2);
  });

  it('strips trailing slash from endpoints', async () => {
    const card = makeCard();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(card),
    });
    vi.stubGlobal('fetch', mockFetch);

    await discoverAgents(['https://a.com/']);

    expect(mockFetch).toHaveBeenCalledWith('https://a.com/.well-known/agent.json');
  });

  it('skips unreachable endpoints gracefully', async () => {
    const card = makeCard();
    const mockFetch = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(card),
      });
    vi.stubGlobal('fetch', mockFetch);

    const agents = await discoverAgents(['https://down.com', 'https://up.com']);

    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('Test Agent');
  });

  it('skips endpoints that return non-200 status', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal('fetch', mockFetch);

    const agents = await discoverAgents(['https://a.com']);
    expect(agents).toHaveLength(0);
  });

  it('filters out cards without negotiation support', async () => {
    const noNegCard: AgentCard = {
      name: 'No Neg',
      description: 'No negotiation',
      url: 'https://a.com',
      capabilities: {},
    };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(noNegCard),
    });
    vi.stubGlobal('fetch', mockFetch);

    const agents = await discoverAgents(['https://a.com']);
    expect(agents).toHaveLength(0);
  });

  it('returns empty array for empty endpoints list', async () => {
    const agents = await discoverAgents([]);
    expect(agents).toHaveLength(0);
  });

  it('handles mix of successful, failed, and unsupported endpoints', async () => {
    const goodCard = makeCard({ name: 'Good' });
    const noNegCard: AgentCard = {
      name: 'NoNeg',
      description: 'x',
      url: 'https://noneg.com',
      capabilities: {},
    };

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(goodCard) })
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(noNegCard) })
      .mockResolvedValueOnce({ ok: false, status: 500 });
    vi.stubGlobal('fetch', mockFetch);

    const agents = await discoverAgents([
      'https://good.com',
      'https://down.com',
      'https://noneg.com',
      'https://error.com',
    ]);

    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('Good');
  });
});
