# What is Ophir?

Ophir is an open protocol that enables AI agents to negotiate pricing, service-level agreements, and contract terms before transacting with each other. It defines a standard JSON-RPC 2.0 interface where a buyer agent broadcasts a Request for Quote, seller agents respond with signed bids, and both sides can counter-offer, accept, or reject -- all cryptographically signed with Ed25519 keys.

Agreements are enforced through a Solana escrow program with automatic dispute resolution when SLA metrics are violated. Ophir is the missing commerce layer for the agent economy: instead of paying fixed prices with no guarantees, agents can negotiate volume discounts, latency commitments, and accuracy targets -- with real financial recourse if providers underdeliver.

Today, AI agents interact through rigid, take-it-or-leave-it pricing. There is no way for an agent to shop around, compare SLA guarantees, or hold a provider accountable for underperformance. Ophir changes this by giving agents the same negotiation primitives that human businesses have used for centuries -- requests for quote, bidding, counter-offers, contracts, and escrow -- in a machine-native protocol that settles in seconds.

---

## Key Concepts

### Agents

Every participant in the Ophir protocol is an **agent** identified by a [`did:key`](./concepts/identity.md) derived from an Ed25519 public key. Agents can be buyers (requesting services), sellers (offering services), or both. The same keypair that signs negotiation messages can sign Solana transactions, unifying identity across the protocol and settlement layers.

```typescript
import { generateAgentIdentity } from '@ophir/sdk';

const identity = generateAgentIdentity('http://localhost:3001');
// {
//   agentId: "did:key:z6Mk...",
//   keypair: { publicKey: Uint8Array(32), secretKey: Uint8Array(64) },
//   endpoint: "http://localhost:3001"
// }
```

### Negotiation

The [negotiation flow](./concepts/how-it-works.md) follows a structured state machine: `RFQ -> Quote -> Counter (optional) -> Accept/Reject`. All messages are JSON-RPC 2.0 requests sent over HTTP. Every message carries an Ed25519 signature, making the negotiation trail cryptographically verifiable and tamper-proof.

### Service-Level Agreements

[SLAs](./concepts/sla-schema.md) are first-class objects in Ophir. Buyers can require specific latency, uptime, accuracy, and throughput targets. Sellers commit to these targets in their quotes. The SDK ships with pre-built `SLA_TEMPLATES` for common categories like real-time inference, batch processing, and code generation -- and provides utilities to compare and validate SLA offers programmatically.

### Escrow

The [Solana escrow program](./concepts/escrow.md) locks USDC in a Program Derived Address (PDA) vault tied to the SHA-256 hash of the agreed terms. If the seller delivers, they claim the funds. If the SLA is violated, the buyer files a dispute and penalties are automatically deducted. If the seller never delivers, the buyer reclaims their deposit after a timeout.

---

## Architecture

Ophir is organized into three layers:

### Protocol Layer (`@ophir/protocol`)

TypeScript type definitions, JSON-RPC method constants, Zod validation schemas, and error codes. This package has zero runtime dependencies and defines the canonical interface that all Ophir implementations must conform to. It includes the 6 JSON-RPC methods (`negotiate/rfq`, `negotiate/quote`, `negotiate/counter`, `negotiate/accept`, `negotiate/reject`, `negotiate/dispute`) and all associated parameter types.

```typescript
import {
  METHODS,
  OphirError,
  OphirErrorCode,
  DEFAULT_CONFIG,
  RFQParamsSchema,
  QuoteParamsSchema,
} from '@ophir/protocol';

import type {
  RFQParams,
  QuoteParams,
  FinalTerms,
  SLARequirement,
  NegotiationState,
} from '@ophir/protocol';
```

### SDK Layer (`@ophir/sdk`)

A batteries-included TypeScript SDK that provides `BuyerAgent` and `SellerAgent` classes, cryptographic signing and verification, SLA templates and comparison utilities, and an HTTP transport layer. The SDK handles the negotiation state machine, auto-generates quotes from service configurations, ranks competing offers, and manages the full lifecycle from RFQ to agreement.

```typescript
import {
  BuyerAgent,
  SellerAgent,
  EscrowManager,
  SLA_TEMPLATES,
  compareSLAs,
  meetsSLARequirements,
  signMessage,
  verifyMessage,
  agreementHash,
  generateKeyPair,
  publicKeyToDid,
  didToPublicKey,
  buildRFQ,
  buildQuote,
  buildCounter,
  buildAccept,
  buildReject,
  buildDispute,
  NegotiationSession,
  discoverAgents,
  agreementToLockstepSpec,
  LockstepMonitor,
  agreementToX402Headers,
  parseX402Response,
} from '@ophir/sdk';
```

### Escrow Layer (`@ophir/escrow`)

A Solana Anchor program (`CHwqh23SpWSM6WLsd15iQcP4KSkB351S9eGcN4fQSVqy`) that provides on-chain payment enforcement. It supports four instructions -- `make_escrow`, `release_escrow`, `dispute_escrow`, and `cancel_escrow` -- with PDA-derived vaults, configurable penalty rates, and slot-based timeouts. The SDK's `EscrowManager` class provides a TypeScript interface for interacting with the program.

---

## Ecosystem Compatibility

Ophir is designed to interoperate with the emerging agent infrastructure stack:

| Protocol | Relationship |
|---|---|
| **A2A** (Google) | Ophir agents expose A2A-compatible agent cards via `seller.generateAgentCard()`. The negotiation flow maps naturally onto A2A's task lifecycle. Agent discovery uses `/.well-known/agent.json` endpoints via `discoverAgents()`. |
| **MCP** (Anthropic) | An `@ophir/mcp-server` package exposes Ophir negotiation as MCP tools, letting LLM-based agents negotiate through tool calls. |
| **x402** (Coinbase) | Ophir's `agreementToX402Headers()` and `parseX402Response()` functions enable HTTP 402-based micropayments as an alternative settlement path for low-value transactions. |
| **Lockstep** | Behavioral verification framework used to validate SLA compliance. The SDK's `agreementToLockstepSpec()` converts SLA terms into a Lockstep behavioral specification, and `LockstepMonitor` provides continuous compliance monitoring. |

---

## Package Overview

| Package | npm | Description |
|---|---|---|
| `@ophir/protocol` | Types, schemas, constants | Zero-dependency protocol definitions |
| `@ophir/sdk` | Agent classes, signing, SLA | Full SDK with BuyerAgent, SellerAgent, EscrowManager |
| `@ophir/escrow` | Solana program | On-chain escrow with PDA vaults |
| `@ophir/mcp-server` | MCP integration | Expose negotiation as MCP tools |

---

## Security Model

Ophir's security is built on five reinforcing layers. See [Security](./concepts/security.md) for the full threat model and defense analysis.

1. **Cryptographic signatures** -- All six message types are Ed25519-signed. Tampering with any field invalidates the signature. See [Identity](./concepts/identity.md) for details.

2. **Agreement hashing** -- The `agreement_hash` (SHA-256 of JCS-canonicalized final terms) uniquely identifies every agreement and is used as a Solana PDA seed, binding on-chain funds to the exact negotiated terms.

3. **Replay protection** -- The SDK tracks processed message IDs in a time-windowed set, rejecting duplicate messages with `DUPLICATE_MESSAGE` (OPHIR_006). Combined with `expires_at` expiration enforcement, this prevents both short-term replays and stale message injection.

4. **On-chain escrow** -- USDC is locked in a PDA vault that only the Solana program can authorize transfers from. The program enforces penalty caps (`u128` checked arithmetic), timeout-based cancellation, `has_one` signer constraints, and atomic fund distribution. See [Escrow](./concepts/escrow.md) for the full program specification.

5. **Unified key model** -- The same Ed25519 keypair signs protocol messages and Solana transactions, eliminating key management vulnerabilities and ensuring the party who signs a quote is provably the party who can claim the corresponding escrow.

---

## Next Steps

- [**Quickstart**](./quickstart.md) -- Get two agents negotiating in 5 minutes.
- [**How It Works**](./concepts/how-it-works.md) -- Understand the full negotiation flow and security model.
- [**Security**](./concepts/security.md) -- Threat model, replay protection, and defense layers.
- [**SLA Schema**](./concepts/sla-schema.md) -- Learn about SLA metrics, templates, and comparison utilities.
- [**Escrow**](./concepts/escrow.md) -- Dive into the Solana escrow program and on-chain settlement.
- [**Identity**](./concepts/identity.md) -- Understand `did:key` identities, Ed25519 signing, and Solana compatibility.
- [**Protocol Specification**](./protocol/specification.md) -- Full protocol specification with error codes and state machine.
- [**SDK Reference**](./sdk/buyer.md) -- BuyerAgent, SellerAgent, and message builder API documentation.
