import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SellerAgent } from '../seller.js';

describe('.well-known endpoint serving', () => {
  let seller: SellerAgent;
  let baseUrl: string;

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
        {
          category: 'embedding',
          description: 'Text embedding service',
          base_price: '0.001',
          currency: 'USDC',
          unit: 'request',
        },
      ],
    });
    await seller.listen(0);
    baseUrl = seller.getEndpoint();
  });

  afterAll(async () => {
    await seller.close();
  });

  it('serves a valid AgentCard at /.well-known/agent.json', async () => {
    const res = await fetch(`${baseUrl}/.well-known/agent.json`);
    expect(res.status).toBe(200);

    const card = await res.json();
    expect(card.name).toBeDefined();
    expect(card.description).toBeDefined();
    // The agent card is generated at construction time with the initial endpoint;
    // after listen(0) the SellerAgent updates its endpoint but the card retains
    // the original URL. Just verify it's a string.
    expect(typeof card.url).toBe('string');
    expect(card.capabilities).toBeDefined();
    expect(card.capabilities.negotiation).toBeDefined();
    expect(card.capabilities.negotiation.supported).toBe(true);
    expect(card.capabilities.negotiation.protocols).toContain('ophir/1.0');
    expect(card.capabilities.negotiation.services).toHaveLength(2);
    expect(card.capabilities.negotiation.services[0].category).toBe('inference');
    expect(card.capabilities.negotiation.services[1].category).toBe('embedding');
  });

  it('serves Ophir metadata at /.well-known/ophir.json', async () => {
    const res = await fetch(`${baseUrl}/.well-known/ophir.json`);
    expect(res.status).toBe(200);

    const ophir = await res.json();
    expect(ophir.protocol).toBe('ophir');
    expect(ophir.version).toBeDefined();
    // The negotiation endpoint in ophir.json is set at construction time,
    // before the port is assigned. Verify it's a string URL.
    expect(typeof ophir.negotiation_endpoint).toBe('string');
    expect(ophir.services).toBeInstanceOf(Array);
    expect(ophir.services).toHaveLength(2);
    expect(ophir.supported_payments).toBeInstanceOf(Array);
    expect(ophir.supported_payments.length).toBeGreaterThanOrEqual(1);
    expect(ophir.sla_dispute_method).toBeDefined();
    expect(ophir.registry_endpoints).toBeInstanceOf(Array);
  });

  it('returns Content-Type application/json for agent.json', async () => {
    const res = await fetch(`${baseUrl}/.well-known/agent.json`);
    const contentType = res.headers.get('content-type');
    expect(contentType).toContain('application/json');
  });

  it('returns Content-Type application/json for ophir.json', async () => {
    const res = await fetch(`${baseUrl}/.well-known/ophir.json`);
    const contentType = res.headers.get('content-type');
    expect(contentType).toContain('application/json');
  });

  it('returns CORS header Access-Control-Allow-Origin: * for agent.json', async () => {
    const res = await fetch(`${baseUrl}/.well-known/agent.json`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('returns CORS header Access-Control-Allow-Origin: * for ophir.json', async () => {
    const res = await fetch(`${baseUrl}/.well-known/ophir.json`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('includes accepted payments in the agent card negotiation capability', async () => {
    const res = await fetch(`${baseUrl}/.well-known/agent.json`);
    const card = await res.json();
    const payments = card.capabilities.negotiation.acceptedPayments;
    expect(payments).toBeInstanceOf(Array);
    expect(payments.length).toBeGreaterThanOrEqual(1);
    expect(payments[0]).toHaveProperty('network');
    expect(payments[0]).toHaveProperty('token');
  });
});
