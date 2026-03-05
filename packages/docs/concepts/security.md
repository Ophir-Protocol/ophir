# Security Model

Ophir's security model addresses the unique threat landscape of autonomous agent commerce: agents that negotiate on behalf of users, exchange binding financial commitments, and settle payments on-chain — all without human oversight at the message level.

This document covers the protocol's security architecture, threat model, and the specific defenses implemented across the protocol, SDK, and escrow layers.

---

## Threat Model

Ophir assumes the following adversary capabilities:

| Threat | Description | Layer |
|---|---|---|
| **Message forgery** | An attacker crafts a message (e.g., a fake quote with low pricing) and sends it to a buyer, impersonating a legitimate seller | Protocol |
| **Message tampering** | An intermediary modifies a message in transit (e.g., changing the price in a quote after the seller signed it) | Protocol |
| **Replay attacks** | An attacker captures a legitimate signed message and re-sends it to trigger duplicate processing (e.g., replaying an RFQ to generate duplicate quotes, or replaying an accept to create duplicate agreements) | SDK |
| **Identity spoofing** | An attacker claims a `did:key` identity they do not control, attempting to receive funds or impersonate a counterparty | Protocol |
| **Agreement substitution** | An attacker modifies the `final_terms` after signing, attempting to bind the counterparty to different terms than agreed | Protocol |
| **Escrow theft** | An unauthorized party attempts to release, dispute, or cancel an escrow they are not a party to | Escrow |
| **Premature cancellation** | A buyer attempts to reclaim escrowed funds before the seller has had time to deliver | Escrow |
| **Penalty abuse** | A buyer files a dispute with an inflated penalty amount exceeding the agreed rate | Escrow |
| **Overflow attacks** | Arithmetic operations in penalty calculation or timeout computation overflow, producing incorrect results | Escrow |

---

## Defense Layers

### 1. Ed25519 Message Signing

All six Ophir message types carry an Ed25519 signature computed over the JCS-canonicalized (RFC 8785) unsigned params. The signature field is excluded before canonicalization.

**Signing:**
```
signature = base64( Ed25519_sign( UTF-8( JCS( params \ {signature} ) ), secret_key ) )
```

**Verification:**
1. Extract and remove the `signature` field
2. Canonicalize remaining fields with `json-stable-stringify` (JCS)
3. Encode as UTF-8 bytes
4. Verify with `nacl.sign.detached.verify`

There is no intermediate hashing step — Ed25519 handles internal hashing (SHA-512).

**Defenses:** Forgery prevention, tampering detection, non-repudiation.

### 2. JCS Canonicalization (RFC 8785)

JSON key ordering is nondeterministic, so signing raw JSON would produce different signatures for semantically identical messages. Ophir canonicalizes all payloads with `json-stable-stringify` before signing, guaranteeing deterministic byte sequences.

**Defenses:** Ensures signing and verification are consistent across implementations, regardless of JSON serialization order.

### 3. `did:key` Identity (W3C DID)

Each agent's identity is a `did:key:z6Mk...` string derived from its Ed25519 public key:

```
did:key:z + base58btc( 0xed01 || 32-byte-public-key )
```

The identity is self-resolving — no registry, certificate authority, or DNS lookup is required. The public key can be extracted from the DID and used directly for signature verification.

**Defenses:** Identity spoofing prevention. An attacker cannot claim a `did:key` without possessing the corresponding private key, because they cannot produce valid signatures that verify against that public key.

### 4. Dual-Signed Agreement Hash

When both parties agree on terms, the `negotiate/accept` message contains:
- A `final_terms` object with the agreed price, currency, SLA, and escrow configuration
- An `agreement_hash`: SHA-256 of the JCS-canonicalized `final_terms`
- A `buyer_signature`: Ed25519 signature over the unsigned accept params
- A `seller_signature`: Ed25519 counter-signature over the same unsigned accept params

Both parties independently verify the `agreement_hash` matches the `final_terms`. The hash is then used as a Solana PDA seed, cryptographically binding on-chain funds to the exact negotiated terms.

**Defenses:** Agreement substitution prevention. Any modification to the terms produces a different hash, which derives a different escrow PDA. Neither party can alter terms after signing without detection.

### 5. Replay Protection

The SDK implements message deduplication in both `BuyerAgent` and `SellerAgent`. Each agent tracks processed message IDs (quote_id, counter_id, rfq_id, agreement_id) in a time-windowed set. Messages with previously-seen IDs are rejected with `DUPLICATE_MESSAGE` (OPHIR_006).

The replay window defaults to 10 minutes (`DEFAULT_CONFIG.replay_protection_window_ms`), which exceeds the maximum message TTL. Entries are evicted when the set exceeds a size threshold, preventing memory exhaustion from long-running agents.

Combined with `expires_at` timestamp validation (messages past their expiry are rejected with `EXPIRED_MESSAGE`), this provides two-layer replay defense:
1. **Short-term:** Deduplication rejects exact replays within the window
2. **Long-term:** Expiration rejects replays of old messages after the window

**Defenses:** Duplicate processing prevention, replay attack mitigation.

### 6. Expiration Enforcement

All timed messages (RFQs, quotes, counters) include an `expires_at` ISO 8601 timestamp. Both `BuyerAgent` and `SellerAgent` handlers check this field before processing:

- Expired quotes are rejected with `EXPIRED_MESSAGE` (OPHIR_003)
- Expired RFQs are rejected with `EXPIRED_MESSAGE` (OPHIR_003)
- Expired counter-offers are rejected with `EXPIRED_MESSAGE` (OPHIR_003)

The protocol-layer Zod schema (`futureDateTime`) validates that `expires_at` is in the future at message creation time.

**Defenses:** Stale message rejection, bounds the replay window.

### 7. Accepting-Message-ID Verification

When a seller receives a `negotiate/accept`, it verifies that the `accepting_message_id` references a quote the seller actually sent in this session. This prevents:
- Accepting a quote from a different seller
- Accepting a quote from a different negotiation session
- Fabricating an acceptance for a quote that was never sent

**Defenses:** Cross-session binding attacks, quote attribution attacks.

### 8. Solana Escrow Enforcement

The on-chain escrow program provides the final enforcement layer:

| Mechanism | Defense |
|---|---|
| **PDA derivation** `["escrow", buyer_pubkey, agreement_hash]` | One escrow per buyer-agreement pair; collision-resistant |
| **`has_one` constraints** | Only the stored buyer/seller can execute their respective instructions |
| **`Active` status guard** | All mutating instructions require `status == Active`, preventing double-spend |
| **Penalty cap** `deposit * penalty_rate_bps / 10000` | Buyers cannot claim more than the agreed penalty rate |
| **`u128` checked arithmetic** | Penalty calculation uses widened integers with `checked_mul`/`checked_div` to prevent overflow |
| **`checked_sub`** | Seller remainder is computed with overflow protection |
| **`checked_add`** | Timeout slot computation prevents `u64` overflow |
| **Timeout gate** `Clock::slot >= timeout_slot` | Buyers cannot cancel before the agreed timeout window |
| **PDA-owned vault** | Only program instructions can transfer tokens from the vault |
| **Mint validation** | Token accounts must match the escrow's stored mint |
| **`close = buyer`** | On cancellation, rent-exempt lamports are reclaimed to the buyer |

---

## Key Length Validation

The SDK validates key lengths at all entry points:

| Key type | Expected length | Validated in |
|---|---|---|
| Ed25519 public key | 32 bytes | `sign()`, `verify()`, `publicKeyToDid()`, `didToPublicKey()`, `deriveEscrowAddress()` |
| Ed25519 secret key | 64 bytes | `sign()`, `signMessage()`, `buildRFQ()`, `buildQuote()`, all message builders |
| Ed25519 signature | 64 bytes (base64) | `verify()`, Zod `base64Signature` validator |
| SHA-256 hash | 32 bytes / 64 hex chars | `agreementHash()`, Zod `sha256HexString` validator, `deriveEscrowAddress()` |

Invalid key lengths are rejected immediately — `sign()` throws `INVALID_SIGNATURE`, `verify()` returns `false`, and `publicKeyToDid()` throws `INVALID_MESSAGE`.

---

## Signature Scope

Each message type has a clearly defined signature scope:

| Message | Signed fields | Excluded fields | Signer |
|---|---|---|---|
| RFQ | All `params` except `signature` | `signature` | Buyer |
| Quote | All `params` except `signature` | `signature` | Seller |
| Counter | All `params` except `signature` | `signature` | Sender |
| Accept | All `params` except `buyer_signature` and `seller_signature` | Both signature fields | Both parties (dual-sign) |
| Reject | All `params` except `signature` | `signature` | Rejecting party |
| Dispute | All `params` except `signature` | `signature` | Buyer |

The accept message uses dual signatures: the buyer signs first (producing `buyer_signature`), then the seller counter-signs the same unsigned payload (producing `seller_signature`). Both signatures cover the identical canonical bytes.

---

## Unified Key Model

Ophir uses Ed25519 keys for three purposes:
1. **Agent identity** (`did:key`)
2. **Message signing** (protocol layer)
3. **Solana transactions** (settlement layer)

Because Solana also uses Ed25519, the same keypair signs negotiation messages and escrow transactions. There is no key translation, bridging, or separate wallet. This eliminates key management vulnerabilities and ensures the party who signs a quote is provably the same party who can claim funds from the corresponding escrow.

---

## Further Reading

- [**Identity**](./identity.md) — `did:key` format, key generation, and Solana compatibility.
- [**How It Works**](./how-it-works.md) — Full negotiation flow with security at each step.
- [**Escrow**](./escrow.md) — On-chain account structure, constraints, and error codes.
- [**Protocol Specification**](../protocol/specification.md) — Signing process, canonicalization, and state machine.
