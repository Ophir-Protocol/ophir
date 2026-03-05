# Quickstart

Get two agents negotiating in 5 minutes.

This guide walks you through installing the SDK, creating a seller agent with a service offering, creating a buyer agent that requests quotes, and running a full negotiation to produce a signed agreement.

---

## Prerequisites

- **Node.js** 18 or later
- **npm**, **yarn**, or **pnpm**
- A terminal with two available ports (3001 and 3002)

No blockchain wallet or Solana setup is required for this tutorial. The SDK generates Ed25519 keypairs automatically. Escrow integration is covered in [Solana Escrow](./concepts/escrow.md).

---

## Install

```bash
npm install @ophir/sdk @ophir/protocol
```

This installs the SDK (agents, signing, SLA utilities) and the protocol package (types and validation schemas).

---

## Create a Seller

The seller agent registers a service offering and listens for incoming RFQs. When a buyer sends a request, the seller automatically evaluates it against its configuration and responds with a signed quote.

```typescript
import { SellerAgent } from '@ophir/sdk';

const seller = new SellerAgent({
  endpoint: 'http://localhost:3001',
  services: [{
    category: 'inference',
    description: 'GPU inference -- LLaMA 70B on A100',
    base_price: '0.005',
    currency: 'USDC',
    unit: 'request',
  }],
});

await seller.listen(3001);
console.log('Seller listening on http://localhost:3001');
console.log('Seller DID:', seller.getAgentId());
```

The seller generates its own `did:key` identity and Ed25519 keypair on startup. Every quote it sends will be cryptographically signed with this key. The auto-generated quotes include:

- Price calculated from `base_price` using the configured pricing strategy
- Volume discounts at 1,000 units (10% off) and 10,000 units (20% off)
- Default SLA: 99.9% uptime, 500ms p99 latency, 95% accuracy
- Lockstep verification with 24-hour dispute timeout
- 2-minute quote expiration

---

## Create a Buyer

The buyer agent sends a Request for Quote (RFQ) to one or more sellers, collects signed quotes, ranks them, and accepts the best offer.

```typescript
import { BuyerAgent } from '@ophir/sdk';

const buyer = new BuyerAgent({ endpoint: 'http://localhost:3002' });
await buyer.listen(3002);

const session = await buyer.requestQuotes({
  sellers: ['http://localhost:3001'],
  service: { category: 'inference' },
  budget: {
    max_price_per_unit: '0.01',
    currency: 'USDC',
    unit: 'request',
  },
});

console.log('RFQ sent. Session:', session.rfqId);
console.log('Session state:', session.state); // 'RFQ_SENT'
```

The RFQ includes the buyer's identity, service requirements, and budget constraints. It is delivered as a JSON-RPC 2.0 `negotiate/rfq` message to each seller endpoint. Unreachable sellers are silently skipped.

---

## Run the Negotiation

Once quotes arrive, the buyer ranks them and accepts the best one. Both sides sign the final terms, producing a binding agreement with a SHA-256 hash.

```typescript
// Wait for seller responses (default: wait for at least 1 quote, 30s timeout)
const quotes = await buyer.waitForQuotes(session);
console.log(`Received ${quotes.length} quote(s)`);

// Rank by price (cheapest first)
const ranked = buyer.rankQuotes(quotes, 'cheapest');
const best = ranked[0];

console.log(`Best offer: ${best.pricing.price_per_unit} ${best.pricing.currency}/${best.pricing.unit}`);

// Accept the best quote -- both parties sign
const agreement = await buyer.acceptQuote(best);

console.log('Agreement signed');
console.log('  Agreement ID:', agreement.agreement_id);
console.log('  Agreement hash:', agreement.agreement_hash);
console.log('  Price:', agreement.final_terms.price_per_unit, agreement.final_terms.currency);
console.log('  Buyer signature:', agreement.buyer_signature.slice(0, 20) + '...');
console.log('  Seller signature:', agreement.seller_signature?.slice(0, 20) + '...');

// Clean up
await buyer.close();
await seller.close();
```

---

## Full Runnable Script

Save this as `negotiate.ts` and run with `npx tsx negotiate.ts`:

```typescript
import { BuyerAgent, SellerAgent } from '@ophir/sdk';

async function main() {
  // 1. Start the seller
  const seller = new SellerAgent({
    endpoint: 'http://localhost:3001',
    services: [{
      category: 'inference',
      description: 'GPU inference -- LLaMA 70B on A100',
      base_price: '0.005',
      currency: 'USDC',
      unit: 'request',
    }],
  });
  await seller.listen(3001);
  console.log('Seller ready:', seller.getAgentId());

  // 2. Start the buyer and send an RFQ
  const buyer = new BuyerAgent({ endpoint: 'http://localhost:3002' });
  await buyer.listen(3002);
  console.log('Buyer ready:', buyer.getAgentId());

  const session = await buyer.requestQuotes({
    sellers: ['http://localhost:3001'],
    service: { category: 'inference' },
    budget: { max_price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
  });

  // 3. Collect and rank quotes
  const quotes = await buyer.waitForQuotes(session);
  if (quotes.length === 0) {
    console.log('No quotes received.');
    await buyer.close();
    await seller.close();
    return;
  }

  const best = buyer.rankQuotes(quotes, 'cheapest')[0];
  console.log(`Best quote: ${best.pricing.price_per_unit} USDC/request`);

  // 4. Accept the best quote
  const agreement = await buyer.acceptQuote(best);
  console.log('Agreement:', agreement.agreement_id);
  console.log('Hash:', agreement.agreement_hash);

  // 5. Clean up
  await buyer.close();
  await seller.close();
}

main().catch(console.error);
```

---

## What Just Happened

1. **Identity** -- Both agents generated Ed25519 keypairs and `did:key` identifiers on startup. No registration or central authority required.

2. **RFQ** -- The buyer broadcast a `negotiate/rfq` message specifying "inference" service with a $0.01/request budget.

3. **Quote** -- The seller evaluated the RFQ against its service configuration and responded with a signed `negotiate/quote` at $0.005/request, including SLA guarantees.

4. **Accept** -- The buyer selected the cheapest quote. Both agents signed the final terms. The SDK computed an `agreement_hash` (SHA-256 of the JCS-canonicalized terms) that uniquely identifies this agreement.

5. **Ready for escrow** -- The `agreement_hash` can now be used to create a [Solana escrow](./concepts/escrow.md), binding on-chain funds to the exact terms both parties agreed to.

---

## Adding SLA Requirements

Buyers can specify SLA requirements in the RFQ. The seller's quote must meet these requirements or the buyer can reject it.

```typescript
import { SLA_TEMPLATES, meetsSLARequirements } from '@ophir/sdk';

const session = await buyer.requestQuotes({
  sellers: ['http://localhost:3001'],
  service: { category: 'inference' },
  budget: { max_price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
  sla: {
    metrics: [
      { name: 'p99_latency_ms', target: 400, comparison: 'lte' },
      { name: 'uptime_pct', target: 99.9, comparison: 'gte' },
      { name: 'accuracy_pct', target: 96, comparison: 'gte' },
    ],
  },
});

const quotes = await buyer.waitForQuotes(session);

// Filter to quotes that meet SLA requirements
const qualifying = quotes.filter((quote) => {
  if (!quote.sla_offered) return false;
  const result = meetsSLARequirements(quote.sla_offered, session.rfq.sla_requirements!);
  return result.meets;
});

console.log(`${qualifying.length} of ${quotes.length} quotes meet SLA requirements`);
```

---

## Counter-Offers

If the buyer wants better terms, they can counter-offer instead of accepting or rejecting:

```typescript
const quotes = await buyer.waitForQuotes(session);
const best = buyer.rankQuotes(quotes, 'cheapest')[0];

// Counter with a lower price
const updatedSession = await buyer.counter(
  best,
  { price_per_unit: '0.003' },
  'Volume discount: committing to 5000+ requests',
);

console.log('Counter sent. Round:', updatedSession.currentRound);
console.log('Session state:', updatedSession.state); // 'COUNTERING'
```

On the seller side, register a handler to respond to counter-offers:

```typescript
seller.onCounter(async (counter, session) => {
  const requestedPrice = parseFloat(counter.modifications.price_per_unit as string);

  if (requestedPrice >= 0.004) return 'accept';
  if (requestedPrice < 0.002) return 'reject';

  // Compromise
  return {
    quote_id: crypto.randomUUID(),
    rfq_id: counter.rfq_id,
    seller: { agent_id: seller.getAgentId(), endpoint: seller.getEndpoint() },
    pricing: {
      price_per_unit: '0.0035',
      currency: 'USDC',
      unit: 'request',
      pricing_model: 'fixed' as const,
    },
    sla_offered: {
      metrics: [{ name: 'uptime_pct' as const, target: 99.9, comparison: 'gte' as const }],
    },
    expires_at: new Date(Date.now() + 120_000).toISOString(),
    signature: '', // SDK signs automatically
  };
});
```

---

## Error Handling

All SDK methods throw `OphirError` with typed error codes on failure:

```typescript
import { OphirError, OphirErrorCode } from '@ophir/protocol';

try {
  const agreement = await buyer.acceptQuote(quote);
} catch (err) {
  if (err instanceof OphirError) {
    switch (err.code) {
      case OphirErrorCode.INVALID_SIGNATURE:
        console.error('Seller signature is invalid -- quote may have been tampered with');
        break;
      case OphirErrorCode.INVALID_STATE_TRANSITION:
        console.error('Cannot accept from current session state');
        break;
      case OphirErrorCode.MAX_ROUNDS_EXCEEDED:
        console.error('Too many counter-offers');
        break;
      default:
        console.error(`Ophir error ${err.code}: ${err.message}`);
    }
  }
}
```

---

## Next Steps

- [**How It Works**](./concepts/how-it-works.md) -- Understand the full negotiation flow, counter-offers, and security model.
- [**SLA Schema**](./concepts/sla-schema.md) -- Add latency, uptime, and accuracy requirements to your RFQs.
- [**Solana Escrow**](./concepts/escrow.md) -- Lock USDC in escrow and enforce agreements on-chain.
- [**Identity**](./concepts/identity.md) -- Learn how `did:key` identities and Ed25519 signing work under the hood.
- [**BuyerAgent API**](./sdk/buyer.md) -- Full API reference for the buy-side agent.
- [**SellerAgent API**](./sdk/seller.md) -- Full API reference for the sell-side agent.
- [**Message Types**](./sdk/messages.md) -- JSON-RPC message formats and builder functions.
