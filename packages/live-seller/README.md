# @ophirai/live-seller

Production-ready seller agent that wraps OpenRouter's 100+ models and plugs into the Ophir network. Auto-registers with the registry, sends heartbeats, tracks SLA metrics, and handles graceful shutdown.

## Installation

```bash
npm install @ophirai/live-seller
```

## Usage

### Run directly

```bash
OPENROUTER_API_KEY=sk-or-... npx @ophirai/live-seller
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENROUTER_API_KEY` | (required) | OpenRouter API key |
| `SELLER_PORT` | `8422` | Port for the seller agent |
| `SELLER_ENDPOINT` | `http://localhost:$SELLER_PORT` | Public endpoint URL |
| `OPHIR_REGISTRY_URL` | `https://ophir-registry.fly.dev` | Registry to register with |

### Run programmatically

```typescript
import { OpenRouterProvider } from '@ophirai/providers';

const provider = new OpenRouterProvider({
  apiKey: process.env.OPENROUTER_API_KEY,
  port: 8422,
  endpoint: 'https://my-seller.example.com',
});

await provider.start();
```

## What it does

1. Starts an `OpenRouterProvider` seller agent on the configured port
2. Generates an Ed25519 identity and authenticates with the registry via challenge-response
3. Registers an agent card advertising inference services with per-model pricing
4. Sends heartbeats every 60 seconds to stay discoverable
5. Wraps `executeInference` to record latency and error metrics for SLA tracking
6. Handles `SIGTERM` and `SIGINT` for clean shutdown

## Advertised models

| Model | Base price (per 1M tokens) |
|-------|---------------------------|
| GPT-4o | $2.50 |
| Claude Sonnet 4.6 | $3.00 |
| Llama 3 70B | $0.59 |
| Gemini Pro | $0.125 |
| Mixtral 8x7B | $0.24 |

Plus all other models available through the underlying `OpenRouterProvider` catalog.

## What is included

- **CLI entry point** -- Run with `npx` or as a standalone process.
- **Auto-registration** -- Authenticates and registers with the Ophir registry on startup.
- **Heartbeat loop** -- Keeps the agent marked as active in the registry.
- **SLA metric collection** -- Records `p99_latency_ms`, `requests_total`, and `error_count`.
- **Graceful shutdown** -- Stops the provider and clears heartbeat timers on process signals.
