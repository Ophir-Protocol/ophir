# @ophirai/providers

Provider wrappers that turn cloud AI APIs into Ophir-compatible seller agents. Each provider advertises its models, handles RFQ negotiation, and executes inference through the upstream API.

## Installation

```bash
npm install @ophirai/providers
```

## Usage

```typescript
import { OpenAIProvider } from '@ophirai/providers';

const provider = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY,
  port: 8422,
});

await provider.start();
console.log(`Seller listening on ${provider.getEndpoint()}`);

// Execute inference directly
const result = await provider.executeInference({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello' }],
  max_tokens: 256,
});

console.log(result.content);
console.log(result.usage);
console.log(result.latencyMs);
```

### Create a provider by name

```typescript
import { createProvider } from '@ophirai/providers';

const provider = createProvider('anthropic', {
  apiKey: process.env.ANTHROPIC_API_KEY,
  port: 8423,
});

await provider.start();
```

### Custom pricing overrides

```typescript
const provider = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY,
  port: 8422,
  pricing: {
    'gpt-4o': { input: 3.0, output: 12.0, unit: '1M_tokens' },
  },
});
```

### Dynamic pricing

```typescript
import { dynamicPrice } from '@ophirai/providers';

const price = dynamicPrice({
  basePrice: 2.5,
  currentLoad: 0.8,
  timeOfDay: new Date().getHours(),
});
```

## Supported providers

| Provider | Class | Models |
|----------|-------|--------|
| OpenAI | `OpenAIProvider` | GPT-4o, GPT-4, GPT-3.5-turbo |
| Anthropic | `AnthropicProvider` | Claude Opus, Sonnet, Haiku |
| Together | `TogetherProvider` | Llama, Mixtral, Qwen |
| Groq | `GroqProvider` | Llama, Mixtral (fast inference) |
| OpenRouter | `OpenRouterProvider` | 100+ models via OpenRouter |
| Replicate | `ReplicateProvider` | Open-source models on Replicate |

## What is included

- **`BaseProvider`** -- Abstract base class handling seller agent setup, RFQ responses, model catalogs, and pricing lookups.
- **Provider classes** -- One per supported API, each with built-in model lists and per-model pricing.
- **`createProvider`** -- Factory function to instantiate a provider by name.
- **`dynamicPrice`** -- Utility for load-aware and time-aware pricing adjustments.
- **`openaiCompatibleRequest`** -- Shared HTTP helper for OpenAI-compatible APIs.

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `apiKey` | env var | API key for the upstream provider |
| `baseUrl` | provider default | Custom API base URL |
| `port` | `0` (random) | Port for the seller agent |
| `endpoint` | auto-detected | Public endpoint URL |
| `registryEndpoints` | `[]` | Registries to register with |
| `pricing` | built-in | Per-model pricing overrides |
