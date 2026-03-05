# @ophirai/gateway

OpenAI-compatible HTTP gateway that routes inference requests through the Ophir negotiation protocol. Point any OpenAI SDK client at this gateway and it will automatically negotiate with providers, select the best quote, and forward your request.

## Installation

```bash
npm install @ophirai/gateway
```

## Usage

### Start the gateway

```typescript
import { createGateway } from '@ophirai/gateway';

const gateway = createGateway({
  port: 8420,
  strategy: 'cheapest',
  sellers: ['http://localhost:8422'],
  maxBudget: '1.00',
});

await gateway.start();
```

### Use with any OpenAI client

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:8420/v1',
  apiKey: 'unused',
});

const response = await client.chat.completions.create({
  model: 'auto',
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8420/v1", api_key="unused")

response = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hello!"}],
)
```

```bash
curl http://localhost:8420/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "auto", "messages": [{"role": "user", "content": "Hello!"}]}'
```

## Endpoints

| Path | Description |
|------|-------------|
| `/v1/chat/completions` | Chat completions (negotiated) |
| `/v1/models` | List available models |
| `/health` | Gateway health and provider stats |
| `/.well-known/ophir.json` | Ophir discovery metadata |
| `/.well-known/agent.json` | A2A agent card |
| `/` | Landing page with status and quick-start examples |

## What is included

- **`createGateway`** -- Factory that returns an Express app with an `OphirRouter`, OpenAI-compatible API endpoints, discovery metadata, and start/stop lifecycle.
- All router configuration options (strategy, sellers, registries, SLA, budget) are passed through.
- Built-in health endpoint with provider connection counts, SLA violations, and negotiation totals.

## Configuration

Accepts all `RouterConfig` options plus:

| Option | Default | Description |
|--------|---------|-------------|
| `port` | `8420` | HTTP listen port |
| `strategy` | `'cheapest'` | Routing strategy |
| `sellers` | `[]` | Direct seller endpoints |
| `registries` | `[]` | Registry URLs for discovery |
| `maxBudget` | `'1.00'` | Max budget per request |
