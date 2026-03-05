# @ophir/sdk

TypeScript SDK for the Ophir Agent Negotiation Protocol. Provides `BuyerAgent` and `SellerAgent` classes with built-in cryptographic signing, identity management, escrow integration, SLA tooling, and JSON-RPC transport.

## Installation

```bash
npm install @ophir/sdk @ophir/protocol
```

## Quick start

### Buyer

```typescript
import { BuyerAgent } from '@ophir/sdk';

const buyer = new BuyerAgent({ endpoint: 'http://localhost:3002' });
await buyer.listen();

// 1. Request quotes
const session = await buyer.requestQuotes({
  sellers: ['http://localhost:3001'],
  service: { category: 'inference', requirements: { model: 'vision' } },
  budget: { max_price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
  sla: { metrics: [{ name: 'p99_latency_ms', target: 500, comparison: 'lte' }] },
});

// 2. Collect and rank quotes
const quotes = await buyer.waitForQuotes(session, { minQuotes: 1, timeout: 30_000 });
const ranked = buyer.rankQuotes(quotes, 'cheapest');

// 3. Accept the best quote
const agreement = await buyer.acceptQuote(ranked[0]);
console.log(agreement.agreement_hash);
```

### Seller

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
// Seller is now accepting RFQs and auto-generating signed quotes
```

### Custom handlers

```typescript
// Custom RFQ handler
seller.onRFQ(async (rfq) => {
  if (rfq.service.category !== 'inference') return null;
  return { /* QuoteParams */ };
});

// Custom counter-offer handler
seller.onCounter(async (counter, session) => {
  const price = parseFloat(counter.modifications.price_per_unit);
  if (price >= 0.004) return 'accept';
  if (price < 0.002) return 'reject';
  return { /* new QuoteParams */ };
});
```

## API reference

### Agents

| Export | Description |
|---|---|
| `BuyerAgent` | Buy-side agent: send RFQs, collect quotes, rank, accept, counter, dispute |
| `SellerAgent` | Sell-side agent: receive RFQs, generate quotes, handle counters |

See the full API reference for [BuyerAgent](../docs/sdk/buyer.md) and [SellerAgent](../docs/sdk/seller.md).

### Cryptography and identity

| Export | Description |
|---|---|
| `generateKeyPair()` | Generate an Ed25519 keypair |
| `generateAgentIdentity()` | Generate a keypair and derive the `did:key` identifier |
| `publicKeyToDid(publicKey)` | Convert an Ed25519 public key to a `did:key` URI |
| `didToPublicKey(did)` | Convert a `did:key` URI back to an Ed25519 public key |
| `signMessage(params, secretKey)` | JCS-canonicalize params, then Ed25519 sign; returns base64 |
| `verifyMessage(params, signature, publicKey)` | Verify a base64 Ed25519 signature against canonicalized params |
| `canonicalize(obj)` | JCS (RFC 8785) canonicalization via `json-stable-stringify` |
| `agreementHash(finalTerms)` | `SHA-256(JCS(finalTerms))` returned as a hex string |

### Escrow

| Export | Description |
|---|---|
| `EscrowManager` | Derive Solana escrow PDAs and interact with the escrow program |

### SLA utilities

| Export | Description |
|---|---|
| `SLA_TEMPLATES` | Pre-built SLA templates for common service categories |
| `compareSLAs(offered, required)` | Compare an SLA offer against requirements |
| `meetsSLARequirements(offered, required)` | Check if an offer meets all required SLA metrics |
| `slaToLockstepSpec(sla, agreement)` | Convert SLA definition to a Lockstep behavioral specification |

### Transport

| Export | Description |
|---|---|
| `JsonRpcClient` | HTTP JSON-RPC 2.0 client for sending protocol messages |
| `NegotiationServer` | HTTP JSON-RPC 2.0 server for receiving protocol messages |
| `NegotiationSession` | State machine for tracking a single negotiation lifecycle |

### Integrations

| Export | Description |
|---|---|
| `discoverAgents(endpoints)` | Discover seller agents via A2A Agent Card endpoints |
| `parseAgentCard(card)` | Parse and validate an A2A Agent Card |
| `LockstepMonitor` | Monitor SLA compliance via the Lockstep verification service |
| `agreementToX402Headers(agreement)` | Convert an Ophir agreement to x402 payment headers |
| `parseX402Response(response)` | Parse x402 payment response into Ophir types |

## Documentation

- [BuyerAgent API reference](../docs/sdk/buyer.md)
- [SellerAgent API reference](../docs/sdk/seller.md)
- [Message types](../docs/sdk/messages.md)
- [Protocol specification](../docs/protocol/specification.md)
- [State machine](../docs/protocol/state-machine.md)
