#!/usr/bin/env node
import { OpenRouterProvider } from '@ophirai/providers';
import {
  OphirRegistry,
  generateAgentIdentity,
  sign,
  MetricCollector,
} from '@ophirai/sdk';

const REGISTRY_URL = process.env.OPHIR_REGISTRY_URL ?? 'https://ophir-registry.fly.dev';
const API_KEY = process.env.OPENROUTER_API_KEY;
const PORT = parseInt(process.env.SELLER_PORT ?? '8422', 10);
const ENDPOINT = process.env.SELLER_ENDPOINT ?? `http://localhost:${PORT}`;
const HEARTBEAT_INTERVAL_MS = 60_000;

if (!API_KEY) {
  console.error('OPENROUTER_API_KEY is required');
  process.exit(1);
}

let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let provider: OpenRouterProvider | undefined;
let shuttingDown = false;

async function registerWithRegistry(
  agentId: string,
  endpoint: string,
  secretKey: Uint8Array,
  services: Array<{ category: string; description: string; base_price: string; currency: string; unit: string }>,
): Promise<OphirRegistry | null> {
  const registry = new OphirRegistry([REGISTRY_URL]);

  try {
    const challengeRes = await fetch(`${REGISTRY_URL}/auth/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId }),
    });

    if (!challengeRes.ok) {
      console.error(`Registry challenge failed: ${challengeRes.status} ${challengeRes.statusText}`);
      return null;
    }

    const { challenge } = await challengeRes.json() as { challenge: string };
    // Registry verifies by encoding the raw challenge string, not a JSON object
    const challengeBytes = new TextEncoder().encode(challenge);
    const signature = sign(challengeBytes, secretKey);

    registry.authenticate(agentId, signature);

    const card = {
      name: 'Ophir Live Seller (OpenRouter)',
      description: 'Live inference provider wrapping 100+ models via OpenRouter',
      url: endpoint,
      capabilities: {
        negotiation: {
          supported: true,
          endpoint,
          protocols: ['ophir/1.0'],
          acceptedPayments: [{ network: 'solana', token: 'USDC' }],
          negotiationStyles: ['rfq'] as string[],
          maxNegotiationRounds: 5,
          services: services.map((s) => ({
            category: s.category,
            description: s.description,
            base_price: s.base_price,
            currency: s.currency,
            unit: s.unit,
          })),
        },
      },
    };

    const result = await registry.register(card);
    if (result.success) {
      console.log(`Registered with registry as ${result.agentId}`);
      return registry;
    } else {
      console.error('Registry registration failed');
      return null;
    }
  } catch (err) {
    console.error('Registry registration error:', err instanceof Error ? err.message : err);
    return null;
  }
}

function startHeartbeat(registry: OphirRegistry, agentId: string): void {
  heartbeatTimer = setInterval(async () => {
    try {
      const ok = await registry.heartbeat(agentId);
      if (!ok) console.warn('Heartbeat failed — registry may be unreachable');
    } catch (err) {
      console.warn('Heartbeat error:', err instanceof Error ? err.message : err);
    }
  }, HEARTBEAT_INTERVAL_MS);
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nShutting down...');

  if (heartbeatTimer) clearInterval(heartbeatTimer);

  if (provider) {
    try {
      await provider.stop();
      console.log('Provider stopped');
    } catch (err) {
      console.error('Error stopping provider:', err instanceof Error ? err.message : err);
    }
  }

  process.exit(0);
}

async function main(): Promise<void> {
  console.log('Starting Ophir Live Seller (OpenRouter)...');
  console.log(`  Port: ${PORT}`);
  console.log(`  Endpoint: ${ENDPOINT}`);
  console.log(`  Registry: ${REGISTRY_URL}`);

  provider = new OpenRouterProvider({
    apiKey: API_KEY,
    port: PORT,
    endpoint: ENDPOINT,
  });

  await provider.start();
  console.log(`Live seller listening on ${provider.getEndpoint()}`);

  const agentId = provider.getAgentId();
  const metrics = new MetricCollector({ agreement_id: '', agreement_hash: '' });

  // Generate identity for registry auth (separate from the provider's internal identity)
  const identity = generateAgentIdentity(ENDPOINT);

  // Build service list from the provider's models
  const services = [
    { category: 'inference', description: 'GPT-4o via OpenRouter', base_price: '2.500000', currency: 'USDC', unit: '1M_tokens' },
    { category: 'inference', description: 'Claude Sonnet 4.6 via OpenRouter', base_price: '3.000000', currency: 'USDC', unit: '1M_tokens' },
    { category: 'inference', description: 'Llama 3 70B via OpenRouter', base_price: '0.590000', currency: 'USDC', unit: '1M_tokens' },
    { category: 'inference', description: 'Gemini Pro via OpenRouter', base_price: '0.125000', currency: 'USDC', unit: '1M_tokens' },
    { category: 'inference', description: 'Mixtral 8x7B via OpenRouter', base_price: '0.240000', currency: 'USDC', unit: '1M_tokens' },
  ];

  // Auto-register with registry
  const registry = await registerWithRegistry(
    identity.agentId,
    ENDPOINT,
    identity.keypair.secretKey,
    services,
  );

  if (registry) {
    startHeartbeat(registry, identity.agentId);
    console.log('Heartbeat loop started (every 60s)');
  } else {
    console.warn('Running without registry registration — will still accept direct RFQs');
  }

  // Track metrics for SLA monitoring
  let requestCount = 0;
  let errorCount = 0;

  const origExecute = provider.executeInference.bind(provider);
  provider.executeInference = async (params) => {
    requestCount++;
    try {
      const result = await origExecute(params);
      metrics.record('p99_latency_ms', result.latencyMs);
      metrics.record('requests_total', requestCount);
      return result;
    } catch (err) {
      errorCount++;
      metrics.record('error_count', errorCount);
      throw err;
    }
  };

  console.log(`Live seller ready — accepting RFQs as ${agentId}`);
  console.log(`  Models: ${provider.models.map((m) => m.id).join(', ')}`);
  console.log(`  Uptime tracking started`);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
