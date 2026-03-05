# SellerAgent

The `SellerAgent` class manages sell-side negotiations in the Ophir protocol. It receives RFQs, generates or custom-crafts quotes, handles counter-offers, and manages agreements.

---

## Quick start

```typescript
import { SellerAgent } from '@ophir/sdk';

const seller = new SellerAgent({
  endpoint: 'http://localhost:3001',
  services: [{
    category: 'inference',
    description: 'GPU inference for vision models',
    base_price: '0.005',
    currency: 'USDC',
    unit: 'request',
  }],
});

await seller.listen();
// Seller is now accepting RFQs and auto-generating quotes
```

---

## Constructor

```typescript
const seller = new SellerAgent(config: SellerAgentConfig);
```

### SellerAgentConfig

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `endpoint` | `string` | Yes | -- | HTTP endpoint where this agent receives RFQs and counter-offers |
| `services` | `ServiceOffering[]` | Yes | -- | Services this seller provides, with pricing |
| `keypair` | `{ publicKey: Uint8Array; secretKey: Uint8Array }` | No | Auto-generated | Ed25519 keypair for signing and identity |
| `pricingStrategy` | `PricingStrategy` | No | `{ type: 'fixed' }` | How to calculate quote prices from base prices |
| `autoRespond` | `boolean` | No | -- | Automatically respond to RFQs with generated quotes |

### ServiceOffering

```typescript
interface ServiceOffering {
  category: string;       // e.g., 'inference', 'translation', 'code-review'
  description: string;    // Human-readable description of the service
  base_price: string;     // Base price as a decimal string, e.g., '0.005'
  currency: string;       // Payment currency, e.g., 'USDC'
  unit: string;           // Billing unit, e.g., 'request', 'word', 'image'
}
```

### PricingStrategy

| Type | Behavior |
|---|---|
| `fixed` | Quotes at exactly `base_price` |
| `competitive` | Quotes at 90% of `base_price` |
| `dynamic` | Quotes at `base_price` (extensible for demand-based pricing) |

---

## Methods

### listen

Starts the HTTP server and begins accepting incoming RFQs.

```typescript
await seller.listen(3001);
```

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `port` | `number` | No | `3000` | Port to listen on |

If the port differs from the one in `endpoint`, the endpoint URL is updated to reflect the actual bound port.

---

### close

Shuts down the HTTP server and closes all connections.

```typescript
await seller.close();
```

---

### onRFQ

Registers a custom handler for incoming RFQs. The handler receives the parsed and validated `RFQParams` and returns either a `QuoteParams` object to send a quote, or `null` to ignore the RFQ.

```typescript
seller.onRFQ(async (rfq) => {
  // Only quote for inference requests
  if (rfq.service.category !== 'inference') return null;

  // Check if budget is acceptable
  const maxPrice = parseFloat(rfq.budget.max_price_per_unit);
  if (maxPrice < 0.003) return null;

  return {
    quote_id: crypto.randomUUID(),
    rfq_id: rfq.rfq_id,
    seller: {
      agent_id: seller.getAgentId(),
      endpoint: seller.getEndpoint(),
    },
    pricing: {
      price_per_unit: '0.005',
      currency: 'USDC',
      unit: 'request',
      pricing_model: 'fixed',
    },
    sla_offered: {
      metrics: [
        { name: 'uptime_pct', target: 99.9, comparison: 'gte' },
        { name: 'p99_latency_ms', target: 300, comparison: 'lte' },
      ],
    },
    expires_at: new Date(Date.now() + 120_000).toISOString(),
    signature: '', // SDK signs automatically
  };
});
```

If no `onRFQ` handler is registered, the agent uses `generateQuote()` to produce quotes automatically based on the configured services and pricing strategy.

---

### onCounter

Registers a custom handler for incoming counter-offers. The handler receives the `CounterParams` and the `NegotiationSession`, and returns one of:

- A new `QuoteParams` object to respond with an updated quote
- `'accept'` to accept the counter-offer's terms
- `'reject'` to reject the counter-offer

```typescript
seller.onCounter(async (counter, session) => {
  const requestedPrice = parseFloat(counter.modifications.price_per_unit);

  // Accept if price is above our floor
  if (requestedPrice >= 0.004) return 'accept';

  // Reject if too low
  if (requestedPrice < 0.002) return 'reject';

  // Otherwise, respond with a compromise
  return {
    quote_id: crypto.randomUUID(),
    rfq_id: counter.rfq_id,
    seller: {
      agent_id: seller.getAgentId(),
      endpoint: seller.getEndpoint(),
    },
    pricing: {
      price_per_unit: '0.0035',
      currency: 'USDC',
      unit: 'request',
      pricing_model: 'fixed',
    },
    sla_offered: {
      metrics: [
        { name: 'uptime_pct', target: 99.9, comparison: 'gte' },
      ],
    },
    expires_at: new Date(Date.now() + 120_000).toISOString(),
    signature: '',
  };
});
```

Counter-offers from buyers are signature-verified against their `did:key` before reaching the handler. Invalid signatures are rejected with error code `OPHIR_002`.

---

### generateQuote

Automatically generates a signed quote for an RFQ based on the seller's configured services and pricing strategy. This is the default behavior when no `onRFQ` handler is registered.

```typescript
const quote = seller.generateQuote(rfq);
if (quote) {
  console.log(quote.pricing.price_per_unit);
  console.log(quote.sla_offered);
}
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `rfq` | `RFQParams` | Yes | The incoming RFQ to generate a quote for |

**Returns:** `QuoteParams | null`

Returns `null` if no configured service matches the RFQ's `service.category`.

**Default quote behavior:**

- Price is calculated from `base_price` using the configured `pricingStrategy`
- Volume discounts are included at 1,000 units (10% off) and 10,000 units (20% off)
- Default SLA: 99.9% uptime, 500ms p99 latency, 95% accuracy
- Dispute resolution: Lockstep verification with 24-hour timeout
- Quote expires after 2 minutes (the protocol default)
- The quote is signed with the seller's Ed25519 private key

---

### registerService

Adds a new service offering at runtime. The service becomes immediately available for quote generation.

```typescript
seller.registerService({
  category: 'translation',
  description: 'Real-time neural machine translation',
  base_price: '0.002',
  currency: 'USDC',
  unit: 'word',
});
```

---

### generateAgentCard

Returns an A2A-compatible Agent Card describing this seller's capabilities, services, negotiation parameters, and accepted payment methods.

```typescript
const card = seller.generateAgentCard();

console.log(card.name);                          // "Seller z6Mk..."
console.log(card.url);                           // "http://localhost:3001"
console.log(card.capabilities.negotiation);      // protocols, services, payment info
```

**Returns:** `AgentCard`

The Agent Card includes:
- Seller name and endpoint URL
- Supported protocols (`ophir/1.0`)
- Accepted payment methods (Solana USDC by default)
- All registered services with their base prices
- Maximum negotiation rounds

---

### getAgentId

Returns the agent's `did:key` identifier derived from its Ed25519 public key.

```typescript
const id = seller.getAgentId();
// "did:key:z6MknGc3ocHs3zdPiJbnaaqDi58NGb4pk1Sp9WkT8t9grpQ"
```

---

### getEndpoint

Returns the agent's HTTP endpoint URL.

```typescript
const url = seller.getEndpoint();
// "http://localhost:3001"
```

---

### getSession

Returns a single negotiation session by its RFQ ID, or `undefined` if not found.

```typescript
const session = seller.getSession('550e8400-e29b-41d4-a716-446655440000');
```

---

### getSessions

Returns all negotiation sessions tracked by this agent.

```typescript
const sessions = seller.getSessions();
```

---

## Lifecycle

When the seller agent receives a message, it follows this flow:

1. **RFQ arrives** -- Validated with Zod schema. A new `NegotiationSession` is created. The `onRFQ` handler (or `generateQuote`) is called. If a quote is returned, it is signed and sent to the buyer's endpoint.

2. **Counter arrives** -- Validated and signature-verified. The `onCounter` handler is called. Based on the return value, the seller either accepts, rejects, or responds with an updated quote.

3. **Accept arrives** -- Validated. The session transitions to `ACCEPTED` and the agreement is stored.

4. **Reject arrives** -- Validated. The session transitions to `REJECTED`.

---

## Error handling

All handlers receive validated, signature-verified messages. Errors thrown from handlers are returned to the caller as JSON-RPC errors.

```typescript
import { OphirError, OphirErrorCode } from '@ophir/protocol';

// Errors the seller may encounter:
// OPHIR_001 - Invalid message (failed schema validation)
// OPHIR_002 - Invalid signature on counter-offer
// OPHIR_004 - Invalid state transition
// OPHIR_005 - Max negotiation rounds exceeded
```

See the [protocol specification](../protocol/specification.md) for the full error code reference.
