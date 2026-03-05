# Ophir: Agent Negotiation Protocol

An open protocol for AI agents to autonomously discover, negotiate, and transact with each other.

AI agents spend billions on API calls but have zero commercial infrastructure. Ophir gives agents the ability to negotiate pricing and SLAs in real time, enforce agreements with cryptographic signatures, and settle payments through on-chain escrow.

Built on JSON-RPC 2.0, Ed25519 cryptography, and Solana escrow. Ships as TypeScript libraries you can drop into any agent framework.

---

## Quick Start

There are three ways to use Ophir:

### 1. MCP Server -- one line in your agent config

Add to your MCP client configuration:

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

Your LLM agent now has tools to discover sellers, request quotes, negotiate terms, and accept agreements.

### 2. Inference Router -- drop-in OpenAI replacement

```bash
npx @ophirai/router --port 4000
```

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:4000/v1',
  apiKey: 'unused',
});

// Ophir negotiates the best price and SLA behind the scenes
const response = await client.chat.completions.create({
  model: 'llama-70b',
  messages: [{ role: 'user', content: 'Hello' }],
});
```

### 3. SDK -- programmatic negotiation

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
console.log('Agreement:', agreement.agreement_id);
await buyer.close();
```

---

## Packages

| Package | Description | Version |
| ------- | ----------- | ------- |
| [`@ophirai/protocol`](packages/protocol) | Core types, Zod schemas, state machine, SLA metrics, error codes | 0.2.0 |
| [`@ophirai/sdk`](packages/sdk) | BuyerAgent, SellerAgent, Ed25519 signing, did:key identity, escrow | 0.2.0 |
| [`@ophirai/registry`](packages/registry) | Agent discovery service with SQLite storage | 0.2.0 |
| [`@ophirai/mcp-server`](packages/mcp-server) | MCP tools for LLM-powered agents | 0.2.0 |
| [`@ophirai/providers`](packages/providers) | AI inference provider wrappers (6 providers) | 0.2.0 |
| [`@ophirai/router`](packages/router) | OpenAI-compatible inference gateway with auto-negotiation | 0.2.0 |
| [`@ophirai/openai-adapter`](packages/openai-adapter) | OpenAI function calling adapter | 0.2.0 |
| [`@ophirai/demo`](packages/demo) | Self-negotiating agent demo | 0.2.0 |
| [`escrow`](packages/escrow) | Solana Anchor program for USDC escrow | -- |
| [`@ophirai/reference-agents`](packages/reference-agents) | Example buyer/seller agents | 0.1.0 |
| [`@ophirai/docs`](packages/docs) | Protocol documentation | 0.1.0 |

---

## Architecture

```
                        ┌─────────────────────────────┐
                        │       Applications          │
                        │  MCP Server  /  Router  /   │
                        │  Reference Agents  /  Demo  │
                        └──────────┬──────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │                    │                     │
              ▼                    ▼                     ▼
   ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
   │  OpenAI Adapter  │ │    Providers     │ │    Registry      │
   │  Function calling │ │  6 AI backends   │ │  Agent discovery │
   └────────┬─────────┘ └────────┬─────────┘ └────────┬─────────┘
            │                    │                     │
            └────────────────────┼─────────────────────┘
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │    SDK (@ophirai/sdk)   │
                    │  BuyerAgent / Seller    │
                    │  Signing / Identity     │
                    │  Transport / Sessions   │
                    └───────────┬────────────┘
                                │
                                ▼
                    ┌────────────────────────┐
                    │ Protocol (@ophirai/     │
                    │          protocol)      │
                    │  Types / Schemas /      │
                    │  State Machine / SLA    │
                    └───────────┬────────────┘
                                │
                                ▼
                    ┌────────────────────────┐
                    │   Solana Escrow         │
                    │   (Anchor Program)      │
                    │  USDC vaults / PDA /    │
                    │  Dispute / Release      │
                    └────────────────────────┘
```

---

## How It Works

1. **Discover** -- Buyers query the Registry to find sellers offering the services they need. Sellers register with capabilities, pricing, and SLA commitments.

2. **Negotiate** -- The buyer sends a signed RFQ (Request for Quote) specifying service requirements, budget, and SLA targets. Sellers respond with signed quotes. Either party can counter-offer up to 5 rounds.

3. **Execute** -- Both parties sign the final terms with Ed25519. The agreement hash (SHA-256 of canonical terms) binds the deal. Optionally, the buyer locks USDC in a Solana PDA escrow vault.

4. **Monitor** -- The SDK tracks 8 SLA metrics (latency, uptime, accuracy, throughput, error rate, TTFB, custom) against committed targets during the service window.

5. **Dispute** -- If SLA violations are detected, the buyer files an on-chain dispute with evidence. The escrow splits funds according to the penalty rate, automatically compensating the buyer.

---

## Protocol

- **Transport**: JSON-RPC 2.0 over HTTP
- **Identity**: `did:key` (Ed25519 public key with `0xed01` multicodec prefix)
- **Signing**: Ed25519 via tweetnacl, JCS canonicalization (RFC 8785)
- **State Machine**: 11 states (IDLE, RFQ_SENT, QUOTES_RECEIVED, COUNTERING, ACCEPTED, ESCROWED, ACTIVE, COMPLETED, REJECTED, DISPUTED, RESOLVED)
- **Settlement**: Solana Anchor program with PDA-derived USDC escrow vaults
- **Message Types**: RFQ, Quote, Counter, Accept, Reject, Dispute

All messages are signed and verified. Agreements are dual-signed with SHA-256 hash commitment. Replay protection via time-windowed message ID deduplication.

---

## Specifications

| Spec | Description |
| ---- | ----------- |
| [Protocol Specification](packages/docs/protocol/specification.md) | Full protocol reference |
| [State Machine](packages/docs/protocol/state-machine.md) | Negotiation state transitions |
| [Registry Protocol](specs/REGISTRY.md) | Agent registry and discovery |
| [Inference Router](specs/INFERENCE-ROUTER.md) | OpenAI-compatible gateway |
| [Provider Protocol](specs/PROVIDER-PROTOCOL.md) | Provider wrapper interface |
| [Agent Discovery](specs/AGENT-DISCOVERY.md) | Agent discovery mechanisms |
| [Ophir-Ready Badge](specs/OPHIR-READY.md) | Compliance badge specification |
| [Security Model](packages/docs/concepts/security.md) | Cryptographic security layers |
| [SLA Schema](packages/docs/concepts/sla-schema.md) | SLA metric definitions |
| [Escrow Lifecycle](packages/docs/concepts/escrow.md) | Solana escrow operations |

---

## Self-Negotiating Agent Demo

The demo showcases the full negotiation lifecycle: a buyer and seller agent negotiate, counter-offer, and reach agreement -- all within a single process.

```bash
# From the repo root
npm install
npx turbo build --filter=@ophirai/demo

# Run the demo
cd packages/demo
npx tsx src/self-negotiating.ts
```

---

## Development

```bash
npm install                                              # Install all workspace dependencies
npx turbo build                                          # Build all packages
npx turbo test                                           # Run all tests
npx turbo build --filter='!escrow' --filter='!@ophirai/demo'  # Build TypeScript packages only
```

Build order is managed by Turbo: `protocol` builds first, then `sdk`, then everything else.

---

## Contributing

1. Fork the repo and create a feature branch
2. Make your changes with tests
3. Ensure `npx turbo build` and `npx turbo test` pass
4. Submit a pull request

---

## License

MIT
