# Ophir

Open protocol for AI agents to discover, negotiate, and transact with each other.

AI agents spend billions on API calls with no way to negotiate pricing or enforce service quality. Ophir gives agents a structured negotiation lifecycle: discover providers, request quotes, counter-offer, sign agreements with Ed25519, monitor SLA compliance, and settle through Solana escrow.

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

## Packages

| Package | Description |
| --- | --- |
| [`@ophirai/protocol`](packages/protocol) | Core types, Zod schemas, 12-state FSM, SLA metrics, error codes |
| [`@ophirai/sdk`](packages/sdk) | BuyerAgent, SellerAgent, Ed25519 signing, did:key identity, escrow |
| [`@ophirai/clearinghouse`](packages/clearinghouse) | Multilateral netting, fractional margin, PoD scoring |
| [`@ophirai/registry`](packages/registry) | Agent discovery with rate limiting, auth, reputation |
| [`@ophirai/mcp-server`](packages/mcp-server) | MCP tools for LLM-powered agents |
| [`@ophirai/router`](packages/router) | OpenAI-compatible inference gateway |
| [`@ophirai/providers`](packages/providers) | AI inference provider wrappers |
| [`@ophirai/openai-adapter`](packages/openai-adapter) | OpenAI function calling adapter |
| [`escrow`](packages/escrow) | Solana Anchor program for USDC escrow |

## How It Works

1. **Discover** &mdash; Buyers query the Registry. Sellers register with capabilities, pricing, and SLA commitments.
2. **Negotiate** &mdash; Buyer sends a signed RFQ. Sellers respond with quotes. Up to 5 counter-offer rounds.
3. **Agree** &mdash; Both parties sign with Ed25519. SHA-256 hash of canonical terms binds the deal.
4. **Margin** &mdash; Clearinghouse scores Probability of Delivery from historical SLA data. Proven agents post as little as 5% margin.
5. **Escrow** &mdash; Buyer locks USDC in a Solana PDA vault. Fractional deposit based on margin assessment.
6. **Monitor** &mdash; SDK tracks 8 SLA metrics (latency, uptime, accuracy, throughput, error rate, TTFB) against targets.
7. **Dispute** &mdash; SLA violations trigger on-chain dispute with arbiter co-sign. Escrow splits funds automatically.

## Protocol

| | |
| --- | --- |
| Transport | JSON-RPC 2.0 over HTTP |
| Identity | `did:key` (Ed25519, `0xed01` multicodec) |
| Signing | Ed25519 via tweetnacl, JCS canonicalization (RFC 8785) |
| State Machine | 12 states: IDLE through RESOLVED |
| Settlement | Solana Anchor, PDA-derived USDC vaults |
| Messages | RFQ, Quote, Counter, Accept, Reject, Dispute |

## Specifications

| Spec | |
| --- | --- |
| [Protocol Specification](packages/docs/protocol/specification.md) | Full protocol reference |
| [State Machine](packages/docs/protocol/state-machine.md) | Negotiation state transitions |
| [Security Model](packages/docs/concepts/security.md) | Cryptographic security layers |
| [SLA Schema](packages/docs/concepts/sla-schema.md) | SLA metric definitions |
| [Escrow Lifecycle](packages/docs/concepts/escrow.md) | Solana escrow operations |

## Development

```bash
npm install
npx turbo build
npx turbo test
```

Build order: `protocol` first, then `sdk`, then everything else.

## License

MIT
