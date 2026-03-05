import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createGateway } from '../index.js';

const gateway = createGateway({ port: 0 });
let baseUrl: string;
let server: ReturnType<typeof gateway.app.listen>;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = gateway.app.listen(0, () => resolve());
  });
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe('Gateway landing page', () => {
  it('GET / returns HTML with correct title', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('html');
    const body = await res.text();
    expect(body).toContain('Ophir Inference Gateway');
    expect(body).toContain('Drop-in OpenAI replacement');
  });

  it('GET / includes code examples for Python, TypeScript, and curl', async () => {
    const res = await fetch(`${baseUrl}/`);
    const body = await res.text();
    expect(body).toContain('api.ophir.ai/v1');
    expect(body).toContain('openai');
    expect(body).toContain('curl');
  });

  it('GET / includes status indicators', async () => {
    const res = await fetch(`${baseUrl}/`);
    const body = await res.text();
    expect(body).toContain('Providers');
    expect(body).toContain('Uptime');
    expect(body).toContain('Negotiations');
  });
});

describe('Gateway /health', () => {
  it('returns status JSON with expected fields', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(data.version).toBe('0.1.0');
    expect(data.timestamp).toBeDefined();
    expect(data.uptime_seconds).toBeTypeOf('number');
    expect(data.providers).toBeDefined();
    expect(data.negotiations).toBeDefined();
  });
});

describe('Gateway /.well-known/ophir.json', () => {
  it('returns valid discovery info', async () => {
    const res = await fetch(`${baseUrl}/.well-known/ophir.json`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.gateway).toBe(true);
    expect(data.ophir_version).toBe('0.1.0');
    expect(data.capabilities.openai_compatible).toBe(true);
    expect(data.capabilities.automatic_negotiation).toBe(true);
    expect(data.supported_services).toContain('inference');
    expect(data.protocol).toBe('ophir/1.0');
  });
});

describe('Gateway /.well-known/agent.json', () => {
  it('returns valid A2A agent card', async () => {
    const res = await fetch(`${baseUrl}/.well-known/agent.json`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe('Ophir Inference Gateway');
    expect(data.version).toBe('0.1.0');
    expect(data.capabilities).toContain('inference');
    expect(data.capabilities).toContain('negotiation');
    expect(data.endpoints.chat_completions).toBe('/v1/chat/completions');
    expect(data.endpoints.models).toBe('/v1/models');
    expect(data.endpoints.health).toBe('/health');
  });
});

describe('Gateway /v1/models', () => {
  it('returns model list with auto model', async () => {
    const res = await fetch(`${baseUrl}/v1/models`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.object).toBe('list');
    expect(data.data).toBeInstanceOf(Array);
    expect(data.data.some((m: { id: string }) => m.id === 'auto')).toBe(true);
  });
});
