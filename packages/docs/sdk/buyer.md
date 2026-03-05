# BuyerAgent

The `BuyerAgent` class manages buy-side negotiations in the Ophir protocol. It handles the full lifecycle: broadcasting RFQs, collecting and ranking quotes, counter-offering, accepting agreements, and filing disputes.

---

## Quick start

```typescript
import { BuyerAgent } from '@ophir/sdk';

const buyer = new BuyerAgent({ endpoint: 'http://localhost:3002' });
await buyer.listen();

// Request quotes from sellers
const session = await buyer.requestQuotes({
  sellers: ['http://localhost:3001'],
  service: { category: 'inference', requirements: { model: 'vision' } },
  budget: { max_price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
});

// Wait, rank, and accept the best quote
const quotes = await buyer.waitForQuotes(session);
const best = buyer.rankQuotes(quotes, 'cheapest')[0];
const agreement = await buyer.acceptQuote(best);

console.log(agreement.agreement_id);
console.log(agreement.agreement_hash);
```

---

## Constructor

```typescript
const buyer = new BuyerAgent(config: BuyerAgentConfig);
```

### BuyerAgentConfig

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `endpoint` | `string` | Yes | -- | HTTP endpoint where this agent receives callbacks (quotes, counters) |
| `keypair` | `{ publicKey: Uint8Array; secretKey: Uint8Array }` | No | Auto-generated | Ed25519 keypair for signing and identity |
| `escrowConfig` | `EscrowConfig` | No | -- | Solana escrow program configuration |
| `lockstepEndpoint` | `string` | No | -- | Lockstep SLA verification service endpoint |

If no `keypair` is provided, the agent generates a fresh Ed25519 keypair on construction. The agent's `did:key` identity is derived from the public key.

---

## Methods

### requestQuotes

Broadcasts an RFQ to one or more sellers. Returns a `NegotiationSession` that tracks the lifecycle of this negotiation.

```typescript
const session = await buyer.requestQuotes({
  sellers: ['http://seller-a:3001', 'http://seller-b:3002'],
  service: {
    category: 'inference',
    requirements: { model: 'vision', min_accuracy: 0.95 },
  },
  budget: {
    max_price_per_unit: '0.01',
    currency: 'USDC',
    unit: 'request',
    total_budget: '100.00',
  },
  sla: {
    metrics: [
      { name: 'p99_latency_ms', target: 500, comparison: 'lte' },
      { name: 'uptime_pct', target: 99.9, comparison: 'gte' },
    ],
  },
  maxRounds: 5,
  timeout: 300_000,
});
```

**Parameters**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sellers` | `string[] \| SellerInfo[]` | Yes | -- | Seller endpoint URLs or `SellerInfo` objects |
| `service` | `ServiceRequirement` | Yes | -- | Service category and capability requirements |
| `budget` | `BudgetConstraint` | Yes | -- | Maximum price per unit, currency, and optional total budget |
| `sla` | `SLARequirement` | No | -- | Desired SLA metrics with targets and comparison operators |
| `maxRounds` | `number` | No | `5` | Maximum counter-offer rounds before the negotiation terminates |
| `timeout` | `number` | No | `300000` | RFQ time-to-live in milliseconds |

**Returns:** `NegotiationSession`

The RFQ is sent to all sellers concurrently. Unreachable sellers are silently skipped. The session begins in `RFQ_SENT` state.

---

### waitForQuotes

Blocks until the required number of quotes arrive or the timeout expires.

```typescript
const quotes = await buyer.waitForQuotes(session, {
  minQuotes: 3,
  timeout: 30_000,
});
```

**Parameters**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `session` | `NegotiationSession` | Yes | -- | The session returned by `requestQuotes` |
| `options.minQuotes` | `number` | No | `1` | Minimum number of quotes to collect before resolving |
| `options.timeout` | `number` | No | `30000` | Maximum wait time in milliseconds |

**Returns:** `QuoteParams[]`

If fewer than `minQuotes` arrive before the timeout, the method resolves with whatever quotes have been received (which may be an empty array).

All incoming quotes are signature-verified against the seller's `did:key` before being added to the session. Quotes with invalid signatures are rejected with error code `OPHIR_002`.

---

### rankQuotes

Sorts quotes by a built-in or custom ranking strategy. Returns a new sorted array without modifying the original.

```typescript
// Built-in strategies
const cheapest = buyer.rankQuotes(quotes, 'cheapest');
const fastest = buyer.rankQuotes(quotes, 'fastest');
const bestSla = buyer.rankQuotes(quotes, 'best_sla');

// Custom comparator
const custom = buyer.rankQuotes(quotes, (a, b) => {
  return parseFloat(a.pricing.price_per_unit) - parseFloat(b.pricing.price_per_unit);
});
```

**Parameters**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `quotes` | `QuoteParams[]` | Yes | -- | Array of quotes to rank |
| `strategy` | `'cheapest' \| 'fastest' \| 'best_sla' \| (a, b) => number` | No | `'cheapest'` | Ranking strategy |

**Returns:** `QuoteParams[]` (sorted copy)

**Built-in strategies**

| Strategy | Sort order |
|---|---|
| `cheapest` | Lowest `price_per_unit` first |
| `fastest` | Lowest `p99_latency_ms` SLA target first |
| `best_sla` | Composite score: uptime, accuracy, inverse latency, throughput, inverse error rate |

---

### acceptQuote

Accepts a quote and creates a signed agreement. The agreement hash is computed as `SHA-256(JCS(final_terms))` and the buyer's Ed25519 signature is attached.

```typescript
const agreement = await buyer.acceptQuote(quote);

console.log(agreement.agreement_id);     // UUID
console.log(agreement.agreement_hash);    // hex SHA-256 of canonicalized terms
console.log(agreement.buyer_signature);   // base64 Ed25519 signature
console.log(agreement.seller_signature);  // from the original quote
console.log(agreement.final_terms);       // negotiated price, SLA, escrow
```

**Parameters**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `quote` | `QuoteParams` | Yes | The quote to accept |

**Returns:** `Agreement`

```typescript
interface Agreement {
  agreement_id: string;
  rfq_id: string;
  final_terms: FinalTerms;
  agreement_hash: string;
  buyer_signature: string;
  seller_signature: string;
}
```

The accept message is sent to the seller's endpoint. If the seller is unreachable, the agreement is still valid locally.

---

### counter

Sends a counter-offer proposing modified terms for a quote. Increments the negotiation round.

```typescript
const session = await buyer.counter(
  quote,
  { price_per_unit: '0.003' },
  'Volume discount: 5000+ requests committed',
);
```

**Parameters**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `quote` | `QuoteParams` | Yes | The quote being countered |
| `modifications` | `Record<string, unknown>` | Yes | Fields to modify (e.g., `price_per_unit`, SLA targets) |
| `justification` | `string` | No | Human-readable reason for the counter-offer |

**Returns:** `NegotiationSession`

Throws `OPHIR_004` (invalid state transition) if no active session exists for the quote's RFQ ID. Throws `OPHIR_005` if the counter would exceed `maxRounds`.

---

### reject

Rejects all quotes in a session and notifies all sellers who submitted quotes.

```typescript
await buyer.reject(session, 'Better offer found elsewhere');
```

**Parameters**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | `NegotiationSession` | Yes | The session to reject |
| `reason` | `string` | No | Human-readable rejection reason (default: `'Rejected by buyer'`) |

**Returns:** `void`

The session transitions to `REJECTED` state. This is terminal -- the session cannot be resumed.

---

### dispute

Files an SLA violation dispute against a seller for an active agreement.

```typescript
const result = await buyer.dispute(agreement, {
  sla_metric: 'p99_latency_ms',
  agreed_value: 300,
  observed_value: 1200,
  measurement_window: '2026-03-04T00:00:00Z/2026-03-04T01:00:00Z',
  evidence_hash: 'a1b2c3d4e5f6...',
});

console.log(result.dispute_id);  // UUID
console.log(result.outcome);     // 'pending'
```

**Parameters**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `agreement` | `Agreement` | Yes | The agreement with the SLA violation |
| `violation` | `ViolationEvidence` | Yes | Evidence of the SLA breach |

**ViolationEvidence fields**

| Field | Type | Required | Description |
|---|---|---|---|
| `sla_metric` | `string` | Yes | Name of the violated SLA metric |
| `agreed_value` | `number` | Yes | The value specified in the agreement |
| `observed_value` | `number` | Yes | The measured value that violates the SLA |
| `measurement_window` | `string` | Yes | ISO 8601 interval (e.g., `start/end`) |
| `evidence_hash` | `string` | No | SHA-256 hash of the evidence data |

**Returns:** `DisputeResult`

```typescript
interface DisputeResult {
  dispute_id: string;
  outcome: 'pending' | 'buyer_wins' | 'seller_wins';
}
```

---

### listen

Starts the HTTP server for receiving callbacks from sellers (quotes, counters, accept acknowledgments).

```typescript
await buyer.listen(3002);
```

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `port` | `number` | No | `3001` | Port to listen on |

If the port differs from the one in `endpoint`, the endpoint URL is updated to reflect the actual bound port.

---

### close

Shuts down the HTTP server and closes all connections.

```typescript
await buyer.close();
```

---

### getAgentId

Returns the agent's `did:key` identifier derived from its Ed25519 public key.

```typescript
const id = buyer.getAgentId();
// "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"
```

---

### getEndpoint

Returns the agent's HTTP endpoint URL.

```typescript
const url = buyer.getEndpoint();
// "http://localhost:3002"
```

---

### getSession

Returns a single negotiation session by its RFQ ID, or `undefined` if not found.

```typescript
const session = buyer.getSession('550e8400-e29b-41d4-a716-446655440000');
```

---

### getSessions

Returns all negotiation sessions tracked by this agent.

```typescript
const sessions = buyer.getSessions();
```

---

## Error handling

All methods throw `OphirError` with typed error codes on failure.

```typescript
import { OphirError, OphirErrorCode } from '@ophir/protocol';

try {
  await buyer.counter(quote, { price_per_unit: '0.001' });
} catch (err) {
  if (err instanceof OphirError) {
    switch (err.code) {
      case OphirErrorCode.INVALID_STATE_TRANSITION:
        // No active session for this RFQ
        break;
      case OphirErrorCode.MAX_ROUNDS_EXCEEDED:
        // Too many counter-offers
        break;
    }
  }
}
```

See the [protocol specification](../protocol/specification.md) for the full error code reference.
