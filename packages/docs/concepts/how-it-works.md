# How Ophir Works

Ophir follows a structured negotiation flow where buyer and seller agents exchange cryptographically signed JSON-RPC 2.0 messages to reach a binding agreement. The agreement is then optionally enforced through a Solana escrow program.

---

## Negotiation Flow

```
  Buyer                              Seller
    |                                   |
    |---- negotiate/rfq -------------->|  1. Buyer broadcasts requirements
    |                                   |
    |<--- negotiate/quote -------------|  2. Seller responds with pricing + SLA
    |                                   |
    |---- negotiate/counter --------->|  3. Either side proposes modifications
    |<--- negotiate/quote -------------|     (repeats up to max_rounds)
    |                                   |
    |---- negotiate/accept ----------->|  4. Both sign the final terms
    |                                   |
    |         [Solana Escrow]           |  5. Buyer deposits USDC into PDA vault
    |                                   |
    |         [Service Execution]       |  6. Seller delivers the service
    |                                   |
    |         [Lockstep Verification]   |  7. SLA metrics are verified
    |                                   |
    |         [Escrow Release]          |  8. Funds released (or disputed)
```

---

## Step by Step

### 1. Request for Quote (RFQ)

The buyer broadcasts what they need: service category, budget constraints, and optional SLA requirements. The RFQ includes the buyer's `did:key` identity and callback endpoint.

```json
{
  "jsonrpc": "2.0",
  "method": "negotiate/rfq",
  "id": "msg-001",
  "params": {
    "rfq_id": "550e8400-e29b-41d4-a716-446655440000",
    "buyer": {
      "agent_id": "did:key:z6MkhaXg...",
      "endpoint": "http://buyer:3002"
    },
    "service": {
      "category": "inference",
      "requirements": { "model": "llama-70b", "gpu": "a100" }
    },
    "budget": {
      "max_price_per_unit": "0.01",
      "currency": "USDC",
      "unit": "request"
    },
    "sla_requirements": {
      "metrics": [
        { "name": "p99_latency_ms", "target": 500, "comparison": "lte" },
        { "name": "uptime_pct", "target": 99.9, "comparison": "gte" }
      ]
    },
    "negotiation_style": "rfq",
    "max_rounds": 5,
    "expires_at": "2026-03-04T12:05:00Z",
    "signature": "base64-encoded-ed25519-signature..."
  }
}
```

The RFQ is sent as an HTTP POST to each seller's endpoint. Multiple sellers can receive the same RFQ, enabling competitive bidding.

### 2. Quote

Each seller evaluates the RFQ against their service offerings and responds with pricing, SLA commitments, and an Ed25519 signature over the canonicalized quote parameters.

```json
{
  "jsonrpc": "2.0",
  "method": "negotiate/quote",
  "id": "msg-002",
  "params": {
    "quote_id": "q-7f3a2b...",
    "rfq_id": "550e8400-e29b-41d4-a716-446655440000",
    "seller": {
      "agent_id": "did:key:z6MkpTHR...",
      "endpoint": "http://seller:3001"
    },
    "pricing": {
      "price_per_unit": "0.005",
      "currency": "USDC",
      "unit": "request",
      "pricing_model": "fixed"
    },
    "sla_offered": {
      "metrics": [
        { "name": "p99_latency_ms", "target": 400, "comparison": "lte" },
        { "name": "uptime_pct", "target": 99.95, "comparison": "gte" },
        { "name": "accuracy_pct", "target": 96, "comparison": "gte" }
      ],
      "dispute_resolution": {
        "method": "lockstep_verification",
        "timeout_hours": 24
      }
    },
    "expires_at": "2026-03-04T12:10:00Z",
    "signature": "base64-encoded-ed25519-signature..."
  }
}
```

The signature covers the entire `params` object (excluding the `signature` field itself), ensuring the quote cannot be tampered with in transit.

### 3. Counter-Offer

If the buyer wants better terms, they send a `negotiate/counter` message with specific modifications -- for example, a lower price or stricter SLA target. The seller can accept the counter, respond with an updated quote, or reject.

Counter-offers can go back and forth up to `max_rounds` (default: 5). Each counter carries a `round` number and a signature from the proposing party.

### 4. Accept

When both parties agree on terms, the buyer sends a `negotiate/accept` message containing:

- The **final terms**: agreed price, currency, unit, SLA, and escrow configuration
- An **agreement hash**: SHA-256 of the JCS-canonicalized final terms
- Both the **buyer's and seller's Ed25519 signatures**

The agreement hash serves as a unique, tamper-proof identifier for the negotiated contract. It is used as a seed for the on-chain escrow PDA, cryptographically binding the Solana account to the exact terms both parties signed.

### 5. Escrow

The buyer deposits USDC into a Solana PDA-controlled vault. The escrow account is derived from `["escrow", buyer_pubkey, agreement_hash]`, ensuring a 1:1 mapping between negotiated agreements and on-chain escrow accounts. See [Solana Escrow](./escrow.md) for details on the program instructions and account structure.

### 6. Execution

The seller delivers the agreed service. Performance metrics (latency, uptime, accuracy, throughput) are tracked against the SLA targets.

### 7. Verification

Lockstep behavioral verification (or another agreed method) validates that SLA metrics were met during the measurement window. The SDK's `slaToLockstepSpec()` function converts SLA terms into a Lockstep behavioral specification for automated testing.

### 8. Settlement

If the SLA was met, the seller calls `release_escrow` to claim payment. If the SLA was violated, the buyer calls `dispute_escrow` with a violation evidence hash, and penalties are automatically deducted from the vault based on the configured `penalty_rate_bps`. If the seller never delivers, the buyer calls `cancel_escrow` after the timeout slot to reclaim their deposit.

---

## Security Model

Ophir's negotiation protocol is designed to be cryptographically verifiable at every step.

### Signed Messages

All six message types (RFQ, quote, counter, accept, reject, and dispute) are cryptographically signed with Ed25519. Both buyer and seller agents verify incoming signatures against the sender's `did:key` public key before processing any message. Tampering with a message in transit -- changing the price, altering SLA targets, or modifying any field -- invalidates the signature and causes rejection.

### Signature Verification

The signing process is deterministic and uses no randomness beyond the key itself:

1. The message `params` object is canonicalized using `json-stable-stringify` (JCS, RFC 8785), producing identical byte output regardless of key insertion order.
2. The canonical JSON string is encoded as UTF-8 bytes.
3. The bytes are signed directly with Ed25519 (`tweetnacl` `nacl.sign.detached`) -- there is no intermediate hashing step.
4. The resulting 64-byte signature is base64-encoded and included in the message.

Verification reverses this process: canonicalize, encode, and verify the signature against the signer's public key.

### Agreement Hash

The `agreement_hash` is the SHA-256 digest of the JCS-canonicalized `final_terms` object. This hash:

- Uniquely identifies the agreement across both parties
- Is included in the `negotiate/accept` message signed by both buyer and seller
- Is used as a PDA seed for the Solana escrow account, binding on-chain funds to the specific negotiated terms
- Cannot be forged -- any modification to the terms produces a different hash, which would derive a different PDA

### Unified Key Model

Ophir uses Ed25519 keys for agent identity (`did:key`), message signing, and Solana transactions. Because Solana also uses Ed25519, the same keypair that signs negotiation messages can sign escrow transactions. There is no key translation, bridging, or separate wallet setup required. This eliminates an entire class of key management vulnerabilities and simplifies the trust model: one key, one identity, across the entire protocol.

---

## State Machine

The negotiation progresses through a well-defined set of states:

```
IDLE -> RFQ_SENT -> QUOTES_RECEIVED -> COUNTERING -> ACCEPTED -> ESCROWED -> ACTIVE -> COMPLETED
                                    \-> REJECTED     \-> REJECTED        \-> DISPUTED -> RESOLVED
```

| State | Description |
|---|---|
| `IDLE` | No active negotiation. |
| `RFQ_SENT` | Buyer has broadcast an RFQ. Waiting for quotes. |
| `QUOTES_RECEIVED` | One or more quotes have arrived. Buyer is evaluating. |
| `COUNTERING` | Counter-offers are being exchanged. |
| `ACCEPTED` | Both parties signed the agreement. |
| `ESCROWED` | Buyer has deposited funds into the Solana escrow. |
| `ACTIVE` | Service delivery is in progress. |
| `COMPLETED` | Service delivered, SLA met, escrow released. |
| `REJECTED` | Either party declined. Negotiation terminated. |
| `DISPUTED` | SLA violation filed. Escrow funds are being split. |
| `RESOLVED` | Dispute settled. Final state. |

---

## Further Reading

- [**SLA Schema**](./sla-schema.md) -- Define and compare quality guarantees.
- [**Solana Escrow**](./escrow.md) -- On-chain payment enforcement.
- [**Identity**](./identity.md) -- `did:key`, Ed25519, and Solana key compatibility.
