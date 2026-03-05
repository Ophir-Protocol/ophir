# @ophirai/router

Smart request routing for the Ophir protocol. Negotiates with providers, selects the best quote using configurable strategies, forwards requests, and monitors SLA compliance in real time.

## Installation

```bash
npm install @ophirai/router
```

## Usage

```typescript
import { OphirRouter } from '@ophirai/router';

const router = new OphirRouter({
  strategy: 'cheapest',
  sellers: ['http://localhost:8422'],
  maxBudget: '0.50',
  currency: 'USDC',
  sla: {
    metrics: [{ name: 'p99_latency_ms', target: 500, comparison: 'lte' }],
    dispute_resolution: { method: 'automatic_escrow' },
  },
});

const result = await router.route({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello' }],
  max_tokens: 256,
});

console.log(result.response);
console.log(result.latencyMs);
console.log(result.strategy);
```

### Routing strategies

```typescript
const router = new OphirRouter({ strategy: 'cheapest' });    // lowest price
const router = new OphirRouter({ strategy: 'fastest' });     // lowest latency
const router = new OphirRouter({ strategy: 'round_robin' }); // rotate providers
const router = new OphirRouter({ strategy: 'weighted' });    // score-weighted
const router = new OphirRouter({ strategy: 'failover' });    // SLA-aware fallback
```

### SLA monitoring

```typescript
const monitor = router.getMonitor();
const stats = monitor.getStats(agreementId);
const violations = monitor.getViolations();
```

### Run as an HTTP server

```typescript
import { createRouterServer } from '@ophirai/router';

const server = createRouterServer({ port: 8421, strategy: 'cheapest' });
await server.start();
```

## What is included

- **`OphirRouter`** -- Main router class. Negotiates, caches agreements, ranks quotes, forwards requests, and records metrics.
- **`SLAMonitor`** -- Tracks per-agreement success rates, latency, and SLA violations.
- **`rankByStrategy`** -- Pure ranking function for the five routing strategies.
- **`createRouterAPI`** -- Express middleware exposing `/v1/chat/completions` and `/v1/models`.
- **`createRouterServer`** -- Standalone HTTP server wrapping the router and API.

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `strategy` | `'cheapest'` | Routing strategy |
| `sellers` | `[]` | Direct seller endpoints |
| `registries` | `[]` | Registry URLs for discovery |
| `agreementCacheTtl` | `300` | Cache TTL in seconds |
| `maxBudget` | `'1.00'` | Max budget per request |
| `currency` | `'USDC'` | Payment currency |
| `maxRetries` | `1` | Retries before re-negotiating |
