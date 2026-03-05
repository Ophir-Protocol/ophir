import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRegistryServer, computeReputationScore } from '../index.js';
import type { ReputationRow } from '../db.js';

// -- Helpers --

function makeKeypair() {
  const kp = nacl.sign.keyPair();
  const multicodec = new Uint8Array(2 + 32);
  multicodec[0] = 0xed;
  multicodec[1] = 0x01;
  multicodec.set(kp.publicKey, 2);
  const did = `did:key:z${bs58.encode(multicodec)}`;
  return { did, publicKey: kp.publicKey, secretKey: kp.secretKey };
}

function signChallenge(challenge: string, secretKey: Uint8Array): string {
  const msg = new TextEncoder().encode(challenge);
  const sig = nacl.sign.detached(msg, secretKey);
  return Buffer.from(sig).toString('base64');
}

function makeAgentCard(name: string, category = 'inference') {
  return {
    name,
    url: `https://${name.toLowerCase().replace(/\s/g, '-')}.example.com`,
    description: `${name} agent`,
    capabilities: {
      negotiation: {
        supported: true,
        endpoint: `https://${name.toLowerCase().replace(/\s/g, '-')}.example.com/negotiate`,
        services: [
          {
            category,
            description: `${category} service`,
            base_price: '0.01',
            currency: 'USD',
            unit: 'request',
          },
        ],
      },
    },
  };
}

// -- Test setup --

let baseUrl: string;
let httpServer: Server;
const registry = createRegistryServer({ port: 0, dbPath: ':memory:', staleCheckInterval: 9999 });

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    httpServer = registry.app.listen(0, () => {
      const addr = httpServer.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    httpServer.close((err) => {
      registry.db.close();
      if (err) reject(err);
      else resolve();
    });
  });
});

/** Request a challenge and return the signature + agent headers. */
async function authenticate(did: string, secretKey: Uint8Array) {
  const challengeRes = await fetch(`${baseUrl}/auth/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: did }),
  });
  const { challenge } = (await challengeRes.json()) as { challenge: string };
  const signature = signChallenge(challenge, secretKey);
  return { 'X-Agent-Id': did, 'X-Agent-Signature': signature };
}

// =============================================================================
// Database layer tests
// =============================================================================

describe('Database layer', () => {
  it('registers an agent and retrieves it', () => {
    const agentId = 'did:key:zTestDbAgent1';
    registry.db.registerAgent(agentId, 'https://a.example.com', 'Agent1', 'desc', [
      { category: 'inference', description: 'inf', base_price: '0.01', currency: 'USD', unit: 'req' },
    ], { supported: true } as any);

    const agent = registry.db.getAgent(agentId);
    expect(agent).toBeDefined();
    expect(agent!.agent_id).toBe(agentId);
    expect(agent!.name).toBe('Agent1');
    expect(agent!.status).toBe('active');
  });

  it('finds agents by category', () => {
    registry.db.registerAgent('did:key:zCatAgent1', 'https://c1.example.com', 'Cat1', '', [
      { category: 'translation', description: 't', base_price: '0.02', currency: 'USD', unit: 'req' },
    ], {} as any);

    const results = registry.db.findAgents({ category: 'translation' });
    expect(results.some((a) => a.agent_id === 'did:key:zCatAgent1')).toBe(true);

    const noResults = registry.db.findAgents({ category: 'nonexistent' });
    expect(noResults.some((a) => a.agent_id === 'did:key:zCatAgent1')).toBe(false);
  });

  it('finds agents filtered by max_price', () => {
    registry.db.registerAgent('did:key:zPriceAgent', 'https://p.example.com', 'PriceAgent', '', [
      { category: 'inference', description: 'inf', base_price: '5.00', currency: 'USD', unit: 'req' },
    ], {} as any);

    const cheap = registry.db.findAgents({ maxPrice: '1.00' });
    expect(cheap.some((a) => a.agent_id === 'did:key:zPriceAgent')).toBe(false);

    const expensive = registry.db.findAgents({ maxPrice: '10.00' });
    expect(expensive.some((a) => a.agent_id === 'did:key:zPriceAgent')).toBe(true);
  });

  it('heartbeat updates last_heartbeat', () => {
    const agentId = 'did:key:zHeartbeatAgent';
    registry.db.registerAgent(agentId, 'https://hb.example.com', 'HB', '', [], {} as any);
    const before = registry.db.getAgent(agentId)!.last_heartbeat;

    // SQLite datetime('now') has second resolution, so heartbeat should at least not fail
    const ok = registry.db.heartbeat(agentId);
    expect(ok).toBe(true);

    const after = registry.db.getAgent(agentId)!.last_heartbeat;
    expect(after).toBeDefined();
    expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
  });

  it('marks stale agents after timeout', () => {
    const agentId = 'did:key:zStaleAgent';
    registry.db.registerAgent(agentId, 'https://s.example.com', 'Stale', '', [], {} as any);

    // Backdate the heartbeat so it appears stale
    (registry.db as any).db.prepare(
      `UPDATE agents SET last_heartbeat = datetime('now', '-1 hour') WHERE agent_id = ?`
    ).run(agentId);

    const count = registry.db.markStaleAgents(30);
    expect(count).toBeGreaterThan(0);

    const agent = registry.db.getAgent(agentId);
    expect(agent!.status).toBe('stale');
  });

  it('removes an agent by setting status to removed', () => {
    const agentId = 'did:key:zRemoveAgent';
    registry.db.registerAgent(agentId, 'https://r.example.com', 'Remove', '', [], {} as any);

    const ok = registry.db.removeAgent(agentId);
    expect(ok).toBe(true);

    const agent = registry.db.getAgent(agentId);
    expect(agent!.status).toBe('removed');
  });
});

// =============================================================================
// Auth tests
// =============================================================================

describe('Auth', () => {
  it('request a challenge returns a challenge string', async () => {
    const { did } = makeKeypair();
    const res = await fetch(`${baseUrl}/auth/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: did }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { challenge: string; expires_in: number };
    expect(typeof body.challenge).toBe('string');
    expect(body.challenge.length).toBeGreaterThan(0);
    expect(body.expires_in).toBe(300);
  });

  it('valid signature passes auth', async () => {
    const { did, secretKey } = makeKeypair();
    const headers = await authenticate(did, secretKey);

    // Register via API (requires valid auth)
    const res = await fetch(`${baseUrl}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(makeAgentCard('AuthTestAgent')),
    });
    expect(res.status).toBe(201);
  });

  it('missing headers returns 401', async () => {
    const res = await fetch(`${baseUrl}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeAgentCard('NoAuth')),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Missing');
  });

  it('expired challenge returns 403', async () => {
    const { did, secretKey } = makeKeypair();
    // Create a challenge then manually expire it
    const challenge = registry.db.createChallenge(did);

    // Expire all challenges for this agent by updating expires_at in the past
    (registry.db as any).db.prepare(
      `UPDATE challenges SET expires_at = datetime('now', '-1 hour') WHERE agent_id = ?`
    ).run(did);

    const signature = signChallenge(challenge, secretKey);
    const res = await fetch(`${baseUrl}/agents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Id': did,
        'X-Agent-Signature': signature,
      },
      body: JSON.stringify(makeAgentCard('ExpiredAuth')),
    });
    expect(res.status).toBe(403);
  });

  it('wrong signature returns 403', async () => {
    const { did } = makeKeypair();
    const otherKp = makeKeypair();

    // Get a real challenge but sign with a different key
    const challengeRes = await fetch(`${baseUrl}/auth/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: did }),
    });
    const { challenge } = (await challengeRes.json()) as { challenge: string };
    const badSig = signChallenge(challenge, otherKp.secretKey);

    const res = await fetch(`${baseUrl}/agents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Id': did,
        'X-Agent-Signature': badSig,
      },
      body: JSON.stringify(makeAgentCard('WrongSig')),
    });
    expect(res.status).toBe(403);
  });
});

// =============================================================================
// API integration tests
// =============================================================================

describe('API integration', () => {
  const kp = makeKeypair();

  it('POST /agents creates agent', async () => {
    const headers = await authenticate(kp.did, kp.secretKey);
    const card = makeAgentCard('IntegrationAgent', 'inference');

    const res = await fetch(`${baseUrl}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(card),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { success: boolean; data: { agent_id: string } };
    expect(body.success).toBe(true);
    expect(body.data.agent_id).toBe(kp.did);
  });

  it('GET /agents returns registered agents', async () => {
    const res = await fetch(`${baseUrl}/agents`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { agents: any[] } };
    expect(body.success).toBe(true);
    expect(body.data.agents.length).toBeGreaterThan(0);
  });

  it('GET /agents?category=inference filters correctly', async () => {
    const res = await fetch(`${baseUrl}/agents?category=inference`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { agents: any[] } };
    const agent = body.data.agents.find((a: any) => a.agentId === kp.did);
    expect(agent).toBeDefined();
    expect(agent.services[0].category).toBe('inference');
  });

  it('GET /agents?category=nonexistent returns empty for wrong category', async () => {
    const res = await fetch(`${baseUrl}/agents?category=nonexistent_xyz`);
    const body = (await res.json()) as { success: boolean; data: { agents: any[] } };
    // Should not contain our inference agent
    expect(body.data.agents.find((a: any) => a.agentId === kp.did)).toBeUndefined();
  });

  it('POST /agents/:id/heartbeat works', async () => {
    const headers = await authenticate(kp.did, kp.secretKey);
    const res = await fetch(`${baseUrl}/agents/${encodeURIComponent(kp.did)}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { status: string } };
    expect(body.data.status).toBe('ok');
  });

  it('DELETE /agents/:id removes agent', async () => {
    // Register a fresh agent to delete
    const delKp = makeKeypair();
    const headers1 = await authenticate(delKp.did, delKp.secretKey);
    await fetch(`${baseUrl}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers1 },
      body: JSON.stringify(makeAgentCard('DeleteMe')),
    });

    const headers2 = await authenticate(delKp.did, delKp.secretKey);
    const res = await fetch(`${baseUrl}/agents/${encodeURIComponent(delKp.did)}`, {
      method: 'DELETE',
      headers: { ...headers2 },
    });
    expect(res.status).toBe(204);

    // Verify it's removed in DB
    const agent = registry.db.getAgent(delKp.did);
    expect(agent!.status).toBe('removed');
  });

  it('GET /health returns healthy status', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; agents: number; uptime: number };
    expect(body.status).toBe('healthy');
    expect(typeof body.agents).toBe('number');
    expect(typeof body.uptime).toBe('number');
  });
});

// =============================================================================
// Reputation tests
// =============================================================================

describe('Reputation', () => {
  it('computeReputationScore returns 50 for fresh agent', () => {
    const rep: ReputationRow = {
      agent_id: 'test',
      total_agreements: 0,
      completed_agreements: 0,
      disputes_won: 0,
      disputes_lost: 0,
      avg_response_time_ms: 0,
      score: 50,
    };
    expect(computeReputationScore(rep)).toBe(50);
  });

  it('computeReputationScore increases with completed agreements', () => {
    const rep: ReputationRow = {
      agent_id: 'test',
      total_agreements: 100,
      completed_agreements: 100,
      disputes_won: 0,
      disputes_lost: 0,
      avg_response_time_ms: 200,
      score: 0,
    };
    const score = computeReputationScore(rep);
    // 50 + 100*0.5 = 100
    expect(score).toBe(100);
  });

  it('computeReputationScore decreases with disputes lost', () => {
    const rep: ReputationRow = {
      agent_id: 'test',
      total_agreements: 10,
      completed_agreements: 5,
      disputes_won: 0,
      disputes_lost: 5,
      avg_response_time_ms: 300,
      score: 0,
    };
    const score = computeReputationScore(rep);
    // 50 + 5*0.5 - 5*2 = 50 + 2.5 - 10 = 42.5
    expect(score).toBe(42.5);
  });

  it('computeReputationScore penalizes slow response times', () => {
    const rep: ReputationRow = {
      agent_id: 'test',
      total_agreements: 0,
      completed_agreements: 0,
      disputes_won: 0,
      disputes_lost: 0,
      avg_response_time_ms: 1500,
      score: 0,
    };
    const score = computeReputationScore(rep);
    // 50 - (1000/100)*0.1 = 50 - 1.0 = 49
    expect(score).toBe(49);
  });

  it('reputation API: POST /reputation/:agentId reports outcome', async () => {
    // Register target agent
    const target = makeKeypair();
    const targetHeaders = await authenticate(target.did, target.secretKey);
    await fetch(`${baseUrl}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...targetHeaders },
      body: JSON.stringify(makeAgentCard('ReputationTarget')),
    });

    // Reporter is a different agent
    const reporter = makeKeypair();
    const reporterHeaders = await authenticate(reporter.did, reporter.secretKey);
    await fetch(`${baseUrl}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...reporterHeaders },
      body: JSON.stringify(makeAgentCard('ReputationReporter')),
    });

    // Report a completed agreement on the target
    const reportHeaders2 = await authenticate(reporter.did, reporter.secretKey);
    const res = await fetch(`${baseUrl}/reputation/${encodeURIComponent(target.did)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...reportHeaders2 },
      body: JSON.stringify({ outcome: 'completed', response_time_ms: 200 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: ReputationRow };
    expect(body.success).toBe(true);
    expect(body.data.completed_agreements).toBe(1);
    expect(body.data.total_agreements).toBe(1);
  });

  it('reputation API: cannot report on yourself', async () => {
    const kp = makeKeypair();
    const headers1 = await authenticate(kp.did, kp.secretKey);
    await fetch(`${baseUrl}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers1 },
      body: JSON.stringify(makeAgentCard('SelfReporter')),
    });

    const headers2 = await authenticate(kp.did, kp.secretKey);
    const res = await fetch(`${baseUrl}/reputation/${encodeURIComponent(kp.did)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers2 },
      body: JSON.stringify({ outcome: 'completed' }),
    });
    expect(res.status).toBe(403);
  });

  it('score is clamped between 0 and 100', () => {
    // Very bad agent — should clamp to 0
    const bad: ReputationRow = {
      agent_id: 'bad',
      total_agreements: 100,
      completed_agreements: 0,
      disputes_won: 0,
      disputes_lost: 50,
      avg_response_time_ms: 10000,
      score: 0,
    };
    expect(computeReputationScore(bad)).toBe(0);

    // Very good agent — should clamp to 100
    const good: ReputationRow = {
      agent_id: 'good',
      total_agreements: 500,
      completed_agreements: 500,
      disputes_won: 100,
      disputes_lost: 0,
      avg_response_time_ms: 100,
      score: 0,
    };
    expect(computeReputationScore(good)).toBe(100);
  });
});
