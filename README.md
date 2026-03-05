# Ophir — Agent Negotiation Protocol

**The missing commerce layer for the agent economy.**

AI agents spend billions on API calls but have zero commercial infrastructure. Every provider charges a fixed price — no volume discounts, no latency guarantees, no accuracy commitments. When quality degrades, agents have no recourse. There's no way to negotiate, no way to enforce terms, and no way to dispute violations.

Ophir is an open protocol that lets AI agents negotiate pricing, SLAs, and payment terms in real time — then enforces those agreements with cryptographic signatures and on-chain escrow. One agent says "I need inference at $0.01/request with p99 < 500ms" and another responds with a signed quote. They negotiate, commit to terms with dual Ed25519 signatures, and lock payment in Solana escrow. If the SLA is violated, the buyer disputes on-chain and recovers funds automatically.

Built on JSON-RPC 2.0, Ed25519 cryptography, and Solana escrow. Ships as TypeScript libraries you can drop into any agent framework.

---

## Why Ophir Exists

```
WITHOUT OPHIR                          WITH OPHIR
──────────────────────────────         ──────────────────────────────
Price:     $0.010/req (fixed)          Price:     $0.004/req (negotiated)
SLA:       None                        SLA:       p99 < 300ms, 99.95% uptime
Guarantee: None                        Guarantee: Escrow-backed, disputable
Recourse:  None                        Recourse:  Automatic penalty via escrow
Identity:  API key (shared secret)     Identity:  did:key (Ed25519, verifiable)
Trust:     "Trust us"                  Trust:     Every message cryptographically signed
```

Three capabilities no agent platform provides today:

1. **Structured negotiation** — Agents exchange signed RFQs, quotes, and counter-offers using an 11-state machine that converges on mutually acceptable terms. Up to 5 rounds of counter-offers before commitment.

2. **Enforceable SLAs** — Eight standard metrics (`uptime_pct`, `p50_latency_ms`, `p99_latency_ms`, `accuracy_pct`, `throughput_rpm`, `error_rate_pct`, `time_to_first_byte_ms`, and `custom`) with configurable targets, measurement windows, and penalty structures. Violations trigger on-chain disputes.

3. **Cryptographic accountability** — Every message is Ed25519-signed with `did:key` identity. Agreements are dual-signed (buyer + seller) and SHA-256 hash-committed. Payments are held in Solana PDA escrow until terms are met or disputes are resolved.

---

## Quick Start

```bash
npm install @ophir/sdk @ophir/protocol
```

No blockchain wallet or Solana setup required for negotiation. Escrow is optional and only needed for payment enforcement.

### Buyer — negotiate and accept a quote

```typescript
import { BuyerAgent } from '@ophir/sdk';

// Create a buyer agent — keypair is auto-generated, identity is did:key
const buyer = new BuyerAgent({ endpoint: 'http://localhost:3001' });
await buyer.listen();

// Send an RFQ to sellers with budget and SLA requirements
const session = await buyer.requestQuotes({
  sellers: ['http://seller-a:3000', 'http://seller-b:3000'],
  service: { category: 'inference', requirements: { model: 'llama-70b' } },
  budget: { max_price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
  sla: { metrics: [
    { name: 'p99_latency_ms', target: 500, comparison: 'lte' },
    { name: 'uptime_pct', target: 99.9, comparison: 'gte' },
  ]},
});

// Wait for quotes, rank by price, accept the best one
const quotes = await buyer.waitForQuotes(session, { minQuotes: 1, timeout: 30_000 });
const best = buyer.rankQuotes(quotes, 'cheapest')[0];
const agreement = await buyer.acceptQuote(best);

// Agreement is dual-signed: buyer_signature + seller counter-signature
console.log('Agreement ID:', agreement.agreement_id);
console.log('Hash:', agreement.agreement_hash);         // SHA-256 of final terms
console.log('Buyer sig:', agreement.buyer_signature);    // Ed25519 base64
console.log('Seller sig:', agreement.seller_signature);  // Ed25519 counter-signature
await buyer.close();
```

### Seller — serve quotes automatically

```typescript
import { SellerAgent } from '@ophir/sdk';

// Create a seller agent with service offerings and pricing
const seller = new SellerAgent({
  endpoint: 'http://localhost:3000',
  services: [{
    category: 'inference',
    description: 'LLaMA 70B on 8xA100',
    base_price: '0.005',
    currency: 'USDC',
    unit: 'request',
  }],
  pricingStrategy: { type: 'competitive' },  // auto-undercut by 10%
});

await seller.listen();
// Seller is now live. Incoming RFQs are matched against registered
// services, signed with Ed25519, and returned as quotes automatically.

// Optional: customize quote generation or counter-offer handling
seller.onRFQ(async (rfq) => {
  // Buyer's signature on the RFQ has already been verified by the SDK
  return seller.generateQuote(rfq);  // returns signed QuoteParams or null
});

seller.onCounter(async (counter, session) => {
  if (session.currentRound >= 3) return 'accept';
  return 'reject';  // or return a new QuoteParams to continue negotiating
});
```

---

## Protocol Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│                      Application Layer                            │
│        BuyerAgent  /  SellerAgent  /  LLM Tool Agents             │
└───────────────────────────────────────────────────────────────────┘
            │                  │                  │
            ▼                  ▼                  ▼
┌───────────────────────────────────────────────────────────────────┐
│                   SDK Layer  (@ophir/sdk)                          │
│  Signing  │  Identity  │  Transport  │  Negotiation  │  SLA       │
│  Ed25519     did:key      JSON-RPC     StateMachine    Templates  │
└───────────────────────────────────────────────────────────────────┘
            │                  │                  │
            ▼                  ▼                  ▼
┌───────────────────────────────────────────────────────────────────┐
│              Protocol Layer  (@ophir/protocol)                    │
│  TypeScript interfaces + Zod schemas for all 6 message types      │
│  State machine (11 states)  │  Error codes  │  SLA metrics        │
└───────────────────────────────────────────────────────────────────┘
            │
            ▼
┌───────────────────────────────────────────────────────────────────┐
│            Settlement Layer  (Solana Anchor program)              │
│  make_escrow  │  release_escrow  │  dispute_escrow  │  cancel     │
│  PDA vaults      USDC tokens       penalty_rate_bps    timeout    │
└───────────────────────────────────────────────────────────────────┘
```

### Protocol Layer (`@ophir/protocol`)

Zero-logic foundation. TypeScript interfaces with JSDoc on every field, strict Zod validation schemas for runtime enforcement, JSON-RPC method constants, SLA metric definitions, negotiation state machine with transition rules, error codes with descriptions, and protocol defaults. No runtime dependencies beyond Zod.

### SDK Layer (`@ophir/sdk`)

The developer interface. BuyerAgent and SellerAgent classes handle the full negotiation lifecycle. Ed25519 signing with `tweetnacl.sign.detached`, `json-stable-stringify` canonicalization (JCS/RFC 8785), `did:key` identity management with `0xed01` multicodec prefix. JSON-RPC transport, NegotiationSession state machine enforcing all 11 states, EscrowManager for Solana PDA operations, and integration helpers for A2A/MCP/x402/Lockstep.

**Every received message is signature-verified before processing.** The BuyerAgent verifies seller signatures on quotes, counter-offers, and accepts. The SellerAgent verifies buyer signatures on RFQs, counter-offers, accepts, and rejects. Forged or tampered messages are rejected with `INVALID_SIGNATURE`.

### Settlement Layer (`escrow`)

Solana Anchor program implementing USDC escrow vaults. PDA derived deterministically from `["escrow", buyer_pubkey, agreement_hash]`. Uses `has_one` constraints for authorization, `u128` checked arithmetic for overflow-safe penalty calculation, and emits events for all state transitions.

---

## Security Model

Ophir's security is built on five reinforcing layers:

**1. Ed25519 Message Signing** — All six message types (RFQ, Quote, Counter, Accept, Reject, Dispute) carry an Ed25519 signature computed over the JCS-canonicalized payload. Recipients verify signatures before processing. Forged or tampered messages fail verification and are rejected with `INVALID_SIGNATURE`. Key lengths are validated: 32 bytes for public keys, 64 bytes for secret keys.

**2. JCS Canonicalization (RFC 8785)** — JSON key ordering is nondeterministic, so signing raw JSON would produce different signatures for semantically identical messages. Ophir canonicalizes all payloads with `json-stable-stringify` before signing, guaranteeing deterministic byte sequences for both signing and verification.

**3. did:key Identity (W3C DID)** — Each agent's identity is a `did:key:z6Mk...` string derived from its Ed25519 public key using the multicodec prefix `0xed01` and base58-btc encoding. No external registry — the identifier is self-resolving and compatible with Solana keypairs.

**4. Dual-Signed Agreement Hash (SHA-256)** — Both parties commit to a SHA-256 hash of the JCS-canonicalized final terms. The buyer signs first; the seller counter-signs the same canonical payload. This `agreement_hash` binds the off-chain negotiation to the on-chain escrow PDA. The hash is verified independently by both agents, and the seller validates that the `accepting_message_id` references a quote it actually sent. Terms cannot be altered after agreement without detection.

**5. Replay Protection** — Both `BuyerAgent` and `SellerAgent` track processed message IDs in a time-windowed set, rejecting duplicates with `DUPLICATE_MESSAGE` (OPHIR_006). Combined with `expires_at` timestamp enforcement on all timed messages, this prevents both immediate replays and stale message injection. The replay window (default: 10 minutes) exceeds the maximum message TTL, ensuring no valid message can be replayed after its ID expires from the deduplication set.

---

## Negotiation State Machine

11 states with enforced transitions:

```
                                         ┌──────────┐
                                         │ REJECTED │
                                         └──────────┘
                                              ▲
                                              │ reject()
                                              │
┌──────┐    ┌──────────┐    ┌─────────────────┐    ┌────────────┐
│ IDLE │ ─▶ │ RFQ_SENT │ ─▶ │ QUOTES_RECEIVED │ ─▶ │ COUNTERING │ ◀─┐
└──────┘    └──────────┘    └─────────────────┘    └────────────┘    │
                                    │                    │           │
                                    │ accept()           │ accept()  │ counter()
                                    ▼                    ▼           │
                              ┌──────────┐    ┌──────────┐    ┌─────┘
                              │ ACCEPTED │ ─▶ │ ESCROWED │ ─▶ │ ACTIVE │ ─▶ ┌───────────┐
                              └──────────┘    └──────────┘    └────────┘    │ COMPLETED │
                                                                  │        └───────────┘
                                                                  │ dispute()
                                                                  ▼
                                                              ┌──────────┐    ┌──────────┐
                                                              │ DISPUTED │ ─▶ │ RESOLVED │
                                                              └──────────┘    └──────────┘
```

Terminal states: `COMPLETED`, `REJECTED`, `RESOLVED`. Invalid transitions throw `OphirError` with code `INVALID_STATE_TRANSITION`. Counter-offers are bounded by `maxRounds` (default: 5).

The state machine is defined canonically in `@ophir/protocol` (`VALID_TRANSITIONS`, `isValidTransition()`, `isTerminalState()`, `getValidNextStates()`) and enforced by the SDK's `NegotiationSession` class.

---

## Escrow Lifecycle (Solana PDA)

After acceptance, the buyer locks USDC in a Solana PDA vault:

1. **Create** (`make_escrow`) — Derives PDA from seeds `["escrow", buyer_pubkey, agreement_hash]`, initializes the escrow account, and transfers USDC into a PDA-controlled vault. Records `penalty_rate_bps` and `timeout_slot`.

2. **Release** (`release_escrow`) — Transfers the vault balance to the seller. Requires `has_one` seller constraint and `Active` status. Called after successful service delivery.

3. **Dispute** (`dispute_escrow`) — Splits funds using `penalty_rate_bps`. Calculates penalty with `u128` checked arithmetic (`deposit * rate / 10000`), sends penalty to buyer, remainder to seller. Requires `has_one` buyer constraint and SHA-256 evidence hash. Only callable while `Active`.

4. **Cancel** (`cancel_escrow`) — Returns all funds to the buyer. Only allowed after `timeout_slot` has passed (prevents premature withdrawal). Requires `has_one` buyer constraint and `Active` status.

All instructions emit events: `EscrowCreated`, `EscrowReleased`, `EscrowDisputed`, `EscrowCancelled`.

---

## JSON-RPC Protocol Reference

### Methods

| Method | Direction | Description |
| ------ | --------- | ----------- |
| `negotiate/rfq` | Buyer → Seller | Broadcast a Request for Quote with service requirements, budget, and SLA terms |
| `negotiate/quote` | Seller → Buyer | Respond with signed pricing, SLA commitments, and optional escrow requirement |
| `negotiate/counter` | Either → Either | Propose modified terms (price, SLA, escrow) with justification |
| `negotiate/accept` | Buyer → Seller | Finalize agreement with dual Ed25519 signatures and SHA-256 agreement hash |
| `negotiate/reject` | Either → Either | Decline the negotiation with a human-readable reason |
| `negotiate/dispute` | Buyer → Seller | File an SLA violation claim with evidence hash and requested escrow action |

### Message Format (JSON-RPC 2.0)

Every message is a standard JSON-RPC 2.0 request with typed `params`:

```json
{
  "jsonrpc": "2.0",
  "method": "negotiate/rfq",
  "id": "msg-001",
  "params": {
    "rfq_id": "550e8400-e29b-41d4-a716-446655440000",
    "buyer": {
      "agent_id": "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
      "endpoint": "http://buyer.example.com:3001"
    },
    "service": { "category": "inference", "requirements": { "model": "llama-70b" } },
    "budget": { "max_price_per_unit": "0.01", "currency": "USDC", "unit": "request" },
    "sla_requirements": {
      "metrics": [
        { "name": "p99_latency_ms", "target": 500, "comparison": "lte" },
        { "name": "uptime_pct", "target": 99.9, "comparison": "gte" }
      ]
    },
    "negotiation_style": "rfq",
    "expires_at": "2026-03-05T12:00:00.000Z",
    "signature": "base64-encoded-ed25519-signature..."
  }
}
```

### SLA Metrics

| Metric | Unit | Description |
| ------ | ---- | ----------- |
| `uptime_pct` | Percentage | Service availability over measurement window |
| `p50_latency_ms` | Milliseconds | Median response latency |
| `p99_latency_ms` | Milliseconds | 99th percentile response latency |
| `accuracy_pct` | Percentage | Correctness rate for inference or classification |
| `throughput_rpm` | Requests/min | Sustained throughput capacity |
| `error_rate_pct` | Percentage | Fraction of requests returning errors |
| `time_to_first_byte_ms` | Milliseconds | Time until first response byte (streaming) |
| `custom` | User-defined | Extension point for domain-specific metrics (requires `custom_name`) |

---

## Ecosystem Compatibility

Ophir composes with the emerging agent infrastructure stack:

| Standard | Integration | Description |
| -------- | ----------- | ----------- |
| **A2A** (Agent-to-Agent) | `generateAgentCard()` | Sellers publish A2A-compatible Agent Cards advertising services, pricing, and negotiation capabilities |
| **MCP** (Model Context Protocol) | `@ophir/mcp-server` | Wraps the negotiation lifecycle as MCP tools for LLM-powered agents |
| **x402** | `agreementToX402Headers()` | Converts agreements to x402 payment headers for HTTP-native payment flows |
| **Lockstep** | `slaToLockstepSpec()` | Converts SLA terms to Lockstep behavioral verification specs for continuous compliance monitoring |

---

## Packages

| Package | Path | Description |
| ------- | ---- | ----------- |
| `@ophir/protocol` | `packages/protocol` | Types, strict Zod schemas, state machine, JSON-RPC methods, error codes, SLA metrics, defaults |
| `@ophir/sdk` | `packages/sdk` | BuyerAgent, SellerAgent, Ed25519 signing, did:key identity, JSON-RPC transport, NegotiationSession, EscrowManager |
| `escrow` | `packages/escrow` | Solana Anchor program — USDC escrow with create, release, dispute, cancel |
| `@ophir/mcp-server` | `packages/mcp-server` | MCP tool server for LLM-based agents |
| `@ophir/reference-agents` | `packages/reference-agents` | Five mock seller agents for testing and demos |
| `@ophir/demo` | `packages/demo` | End-to-end negotiation demo with real JSON-RPC communication |
| `docs` | `packages/docs` | Protocol specification and architecture documentation |

---

## Development

```bash
npm install                              # Install dependencies (npm workspaces)
npx turbo build                          # Build all packages
npx turbo test                           # Run all tests (800+ across protocol + SDK)
cd packages/protocol && npx tsc --noEmit # Type-check protocol
cd packages/sdk && npx tsc --noEmit      # Type-check SDK
```

---

## License

MIT
