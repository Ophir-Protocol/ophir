# @ophir/reference-agents

Five pre-configured seller agents for testing and development with the Ophir protocol. Each agent simulates a different service category with realistic pricing, SLA defaults, and custom RFQ handling.

## Installation

```bash
npm install @ophir/reference-agents
```

## Available agents

| Agent | Category | Default port | Base price | Unit | Description |
|---|---|---|---|---|---|
| `inference` | `inference` | 3001 | $0.005 | request | GPU inference for vision models |
| `data-processing` | `data-processing` | 3002 | -- | request | Batch data processing pipelines |
| `code-review` | `code-review` | 3003 | -- | request | Automated code review and analysis |
| `translation` | `translation` | 3004 | -- | word | Real-time neural machine translation |
| `image-generation` | `image-generation` | 3005 | -- | image | Image generation from text prompts |

## CLI usage

### Start a single agent

```bash
npx ophir-agents start inference
npx ophir-agents start inference --port 4001
```

### Start all agents

Starts all five agents on consecutive ports.

```bash
npx ophir-agents start-all
npx ophir-agents start-all --base-port 4001
```

### List available agents

```bash
npx ophir-agents list
```

## Programmatic usage

Each agent type has a factory function that returns a fully configured `SellerAgent` instance.

```typescript
import { createInferenceAgent } from '@ophir/reference-agents';

const agent = createInferenceAgent({ port: 3001 });
await agent.listen(3001);

console.log('Agent ID:', agent.getAgentId());
console.log('Endpoint:', agent.getEndpoint());

// The agent is now accepting RFQs and auto-generating quotes
// based on its category-specific pricing and SLA configuration.
```

### Factory functions

| Function | Returns |
|---|---|
| `createInferenceAgent(opts)` | `SellerAgent` configured for GPU inference |
| `createDataProcessingAgent(opts)` | `SellerAgent` configured for batch processing |
| `createCodeReviewAgent(opts)` | `SellerAgent` configured for code analysis |
| `createTranslationAgent(opts)` | `SellerAgent` configured for translation |
| `createImageGenerationAgent(opts)` | `SellerAgent` configured for image generation |

Each factory function accepts an options object with an optional `port` field and returns a `SellerAgent` instance with:
- Category-specific pricing and billing units
- Default SLA metrics appropriate for the service type
- Custom RFQ handlers for service-specific logic
- Volume discounts at 1,000 and 10,000 units

## Testing with reference agents

A common development workflow:

```typescript
import { BuyerAgent } from '@ophir/sdk';
import { createInferenceAgent } from '@ophir/reference-agents';

// Start the seller
const seller = createInferenceAgent({ port: 3001 });
await seller.listen(3001);

// Start the buyer and negotiate
const buyer = new BuyerAgent({ endpoint: 'http://localhost:3002' });
await buyer.listen(3002);

const session = await buyer.requestQuotes({
  sellers: ['http://localhost:3001'],
  service: { category: 'inference', requirements: { model: 'vision' } },
  budget: { max_price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
});

const quotes = await buyer.waitForQuotes(session);
const agreement = await buyer.acceptQuote(quotes[0]);

console.log('Agreement:', agreement.agreement_id);

await buyer.close();
await seller.close();
```

## Documentation

- [SellerAgent API reference](../docs/sdk/seller.md)
- [Protocol specification](../docs/protocol/specification.md)
