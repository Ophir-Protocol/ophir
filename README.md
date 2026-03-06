# Ophir

An open protocol for AI agents to autonomously discover, negotiate, and transact with each other.

AI agents collectively spend billions on API calls but operate without any commercial infrastructure. There is no standard way for one agent to find another, negotiate a price, agree on service quality, or enforce the terms of a deal. Every integration is bespoke. Every price is fixed by the provider. Every failure goes unresolved.

Ophir changes this. It defines a structured negotiation lifecycle where agents discover service providers through a shared registry, exchange signed requests for quotes, counter-offer up to five rounds, and arrive at a binding agreement. Agreements are dual-signed with Ed25519 and committed via SHA-256 hash. The protocol tracks eight SLA metrics against committed targets during execution, and if a provider fails to deliver, the buyer files an on-chain dispute backed by cryptographic evidence. Settlement happens through Solana escrow vaults denominated in USDC.

The protocol is transport-agnostic at its core but ships with a JSON-RPC 2.0 binding over HTTP. Identity is built on the `did:key` standard using Ed25519 public keys. The state machine has twelve states, from IDLE through RESOLVED, covering the full lifecycle of discovery, negotiation, margin assessment, escrow, execution, and dispute resolution.

Everything ships as TypeScript libraries you can drop into any agent framework.

## Quick Start

Add to any MCP client:

```json
{
  "mcpServers": {
    "ophir": {
      "command": "npx",
      "args": ["@ophirai/mcp-server"]
    }
  }
}
```

Your agent now has tools to discover sellers, request quotes, negotiate terms, accept agreements, monitor SLAs, and file disputes.

Or use the SDK directly:

```bash
npm install @ophirai/sdk @ophirai/protocol
```

```typescript
import { BuyerAgent } from '@ophirai/sdk';

const buyer = new BuyerAgent({ endpoint: 'http://localhost:3001' });
await buyer.listen();

const session = await buyer.requestQuotes({
  sellers: ['http://seller-a:3000'],
  service: { category: 'inference', requirements: { model: 'llama-70b' } },
  budget: { max_price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
  sla: { metrics: [
    { name: 'p99_latency_ms', target: 500, comparison: 'lte' },
    { name: 'uptime_pct', target: 99.9, comparison: 'gte' },
  ]},
});

const quotes = await buyer.waitForQuotes(session, { minQuotes: 1, timeout: 30_000 });
const best = buyer.rankQuotes(quotes, 'cheapest')[0];
const agreement = await buyer.acceptQuote(best);
```

OpenAI-compatible inference gateway:

```bash
npx @ophirai/router --port 4000
```

## How It Works

A buyer agent queries the **Registry** to find sellers offering the services it needs. Sellers register with their capabilities, pricing, and SLA commitments.

The buyer sends a signed **RFQ** (Request for Quote) specifying service requirements, budget constraints, and SLA targets. Sellers respond with signed quotes. Either party can counter-offer. After at most five rounds, both sides either accept or walk away.

On acceptance, both parties sign the final terms with **Ed25519**. The agreement hash, computed as the SHA-256 of the canonicalized terms (RFC 8785), binds the deal cryptographically.

The **Clearinghouse** then assesses each party's Probability of Delivery, a score derived from historical SLA performance across completed agreements. Agents with strong track records post as little as 5% margin instead of the full contract value. The clearinghouse also runs a multilateral netting engine that detects cycles in the obligation graph and cancels offsetting debts.

The buyer locks USDC in a **Solana PDA escrow vault**, with the deposit amount determined by the margin assessment. During execution, the SDK monitors eight SLA metrics (latency, uptime, accuracy, throughput, error rate, time to first byte, and two custom metrics) against committed targets.

If violations exceed the agreed threshold, the buyer files an on-chain **dispute** with arbiter co-signature. The escrow program splits funds according to the penalty rate defined in the agreement, automatically compensating the buyer.

## Protocol

| | |
| --- | --- |
| Transport | JSON-RPC 2.0 over HTTP |
| Identity | `did:key` with Ed25519 public keys (`0xed01` multicodec prefix) |
| Signing | Ed25519 via tweetnacl, JCS canonicalization (RFC 8785) |
| State Machine | 12 states: IDLE, RFQ_SENT, QUOTES_RECEIVED, COUNTERING, ACCEPTED, MARGIN_ASSESSED, ESCROWED, ACTIVE, COMPLETED, REJECTED, DISPUTED, RESOLVED |
| Settlement | Solana Anchor program with PDA-derived USDC escrow vaults |
| Messages | RFQ, Quote, Counter, Accept, Reject, Dispute |

All messages are signed and verified. Replay protection uses time-windowed message ID deduplication.

## Packages

| Package | Description |
| --- | --- |
| [`@ophirai/protocol`](packages/protocol) | Core types, Zod schemas, 12-state FSM, SLA metrics, error codes |
| [`@ophirai/sdk`](packages/sdk) | BuyerAgent, SellerAgent, Ed25519 signing, did:key identity, escrow |
| [`@ophirai/clearinghouse`](packages/clearinghouse) | Multilateral netting, fractional margin, Probability of Delivery scoring |
| [`@ophirai/registry`](packages/registry) | Agent discovery with rate limiting, authentication, reputation |
| [`@ophirai/mcp-server`](packages/mcp-server) | MCP tools for LLM-powered agents |
| [`@ophirai/router`](packages/router) | OpenAI-compatible inference gateway with automatic negotiation |
| [`@ophirai/providers`](packages/providers) | AI inference provider wrappers (OpenAI, Anthropic, Together, Groq, OpenRouter, Replicate) |
| [`@ophirai/openai-adapter`](packages/openai-adapter) | OpenAI function calling adapter |
| [`escrow`](packages/escrow) | Solana Anchor program for USDC escrow with arbiter disputes |

## Specifications

| Document | |
| --- | --- |
| [Protocol Specification](packages/docs/protocol/specification.md) | Full protocol reference |
| [State Machine](packages/docs/protocol/state-machine.md) | Negotiation state transitions and guards |
| [Security Model](packages/docs/concepts/security.md) | Cryptographic layers, threat model, replay protection |
| [SLA Schema](packages/docs/concepts/sla-schema.md) | Metric definitions, comparison operators, penalty calculation |
| [Escrow Lifecycle](packages/docs/concepts/escrow.md) | Deposit, release, dispute, and arbiter flows |
| [Identity](packages/docs/concepts/identity.md) | did:key derivation, key management, agent authentication |

## Development

```bash
npm install
npx turbo build
npx turbo test
```

Build order is managed by Turborepo. The `protocol` package builds first, then `sdk`, then everything else.

## License

MIT
