# Ophir Protocol Specification

Version 1.0

---

## 1. Transport

Ophir uses **JSON-RPC 2.0 over HTTPS**. Each agent exposes a single HTTP endpoint that accepts `POST` requests.

- **Content-Type:** `application/json`
- **Requests** must include `jsonrpc`, `method`, `id`, and `params` fields per the JSON-RPC 2.0 specification.
- **Responses** follow standard JSON-RPC 2.0: a `result` field on success, or an `error` field with `code`, `message`, and optional `data` on failure.

```
POST https://agent.example.com/ HTTP/1.1
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "method": "negotiate/rfq",
  "id": "msg-001",
  "params": { ... }
}
```

---

## 2. Methods

The protocol defines six methods. Each method has a fixed direction indicating which party initiates the message.

| Method | Direction | Description |
|---|---|---|
| `negotiate/rfq` | Buyer to Seller | Request for Quote -- initiates a negotiation |
| `negotiate/quote` | Seller to Buyer | Quote response with pricing and SLA offer |
| `negotiate/counter` | Either to Either | Counter-offer proposing modified terms |
| `negotiate/accept` | Buyer to Seller | Accept terms and create a dual-signed agreement |
| `negotiate/reject` | Either to Either | Terminate the negotiation |
| `negotiate/dispute` | Buyer to Seller | File an SLA violation claim |

See the [message types reference](../sdk/messages.md) for complete JSON examples of each method.

---

## 3. Agent identity

Agents are identified by `did:key` URIs that encode Ed25519 public keys.

**Format:**

```
did:key:z6Mk...
```

**Encoding:**

```
"did:key:" + base58btc( 0xed01 || 32-byte-Ed25519-public-key )
```

The `0xed01` prefix is the multicodec identifier for Ed25519 public keys. The same Ed25519 keys are compatible with Solana for signing escrow transactions.

---

## 4. Message signing

All messages that contain a `signature` field must be signed using Ed25519. The signing process uses JCS canonicalization to ensure deterministic serialization.

### 4.1 Signing process

1. **Construct the unsigned message.** Remove the `signature` field from the `params` object (or construct the params without it).
2. **Canonicalize.** Serialize the unsigned params using JSON Canonicalization Scheme (JCS, RFC 8785) via `json-stable-stringify`. This produces deterministic JSON output regardless of property insertion order.
3. **Encode.** Convert the canonical JSON string to bytes using UTF-8 encoding.
4. **Sign.** Compute an Ed25519 detached signature over the UTF-8 bytes using `nacl.sign.detached` from tweetnacl.
5. **Base64-encode.** Encode the 64-byte signature as a base64 string.

```
signature = base64( Ed25519_sign( UTF-8( JCS( unsigned_params ) ), secret_key ) )
```

There is no intermediate hashing step. The Ed25519 signature is computed directly over the canonicalized UTF-8 bytes.

### 4.2 Verification process

1. Extract and remove the `signature` field from the received `params`.
2. Canonicalize the remaining fields using JCS (RFC 8785).
3. UTF-8 encode the canonical JSON string.
4. Resolve the sender's Ed25519 public key from their `did:key` identifier.
5. Verify the base64-decoded signature against the public key and the UTF-8 bytes using `nacl.sign.detached.verify`.

### 4.3 Which messages are signed

All six message types carry Ed25519 signatures. Every message sender signs
their params so that receivers can verify authenticity and prevent forgery.

| Method | Signed | Signer |
|---|---|---|
| `negotiate/rfq` | Yes | Buyer |
| `negotiate/quote` | Yes | Seller |
| `negotiate/counter` | Yes | Sender (buyer or seller) |
| `negotiate/accept` | Yes (dual-signed: `buyer_signature` and `seller_signature`) | Both parties |
| `negotiate/reject` | Yes | Rejecting party |
| `negotiate/dispute` | Yes | Buyer |

---

## 5. Canonicalization

Ophir uses **JCS (JSON Canonicalization Scheme, RFC 8785)** for deterministic JSON serialization. The implementation uses `json-stable-stringify`, which produces JCS-compatible output.

JCS guarantees that both parties compute identical byte representations for the same logical JSON object, regardless of:
- Property insertion order
- Whitespace differences
- Numeric formatting

This is critical for signature verification and agreement hash computation.

---

## 6. Agreement hash

The `agreement_hash` in `negotiate/accept` messages is computed as:

```
agreement_hash = hex( SHA-256( JCS( final_terms ) ) )
```

Where:
1. `final_terms` is the agreed-upon `FinalTerms` object (price, currency, unit, SLA, escrow terms).
2. `JCS(final_terms)` produces the canonical JSON string using RFC 8785.
3. `SHA-256` produces a 32-byte digest.
4. `hex` encodes the digest as a lowercase hexadecimal string (64 characters).

This hash serves as a seed for the Solana escrow PDA (Program Derived Address), cryptographically binding the on-chain escrow to the negotiated terms. Any modification to the terms produces a different hash and therefore a different escrow address.

---

## 7. State machine

Each negotiation session progresses through a defined set of states.

### 7.1 States

| State | Description |
|---|---|
| `IDLE` | Initial state before any message is sent |
| `RFQ_SENT` | Buyer has broadcast an RFQ to sellers |
| `QUOTES_RECEIVED` | At least one quote has been received from a seller |
| `COUNTERING` | Active counter-offer exchange between buyer and seller |
| `ACCEPTED` | Both parties have signed the agreement |
| `ESCROWED` | USDC has been deposited into the Solana escrow vault |
| `ACTIVE` | Service delivery is in progress |
| `COMPLETED` | Service delivered successfully; escrow released to seller |
| `REJECTED` | Negotiation terminated by either party (terminal) |
| `DISPUTED` | SLA violation filed; escrow frozen |
| `RESOLVED` | Dispute settled; funds distributed according to outcome |

### 7.2 Transitions

| From | To | Trigger |
|---|---|---|
| `IDLE` | `RFQ_SENT` | Buyer sends `negotiate/rfq` |
| `RFQ_SENT` | `QUOTES_RECEIVED` | First `negotiate/quote` received |
| `QUOTES_RECEIVED` | `ACCEPTED` | Buyer sends `negotiate/accept` |
| `QUOTES_RECEIVED` | `COUNTERING` | Either party sends `negotiate/counter` |
| `COUNTERING` | `COUNTERING` | Another `negotiate/counter` (within `max_rounds`) |
| `COUNTERING` | `ACCEPTED` | Either party sends `negotiate/accept` |
| `ACCEPTED` | `ESCROWED` | Escrow deposit confirmed on-chain |
| `ACCEPTED` | `REJECTED` | Counter-sign refused or accept revoked |
| `ESCROWED` | `ACTIVE` | Service execution begins |
| `ACTIVE` | `COMPLETED` | Escrow released to seller |
| `ACTIVE` | `DISPUTED` | Buyer sends `negotiate/dispute` |
| `DISPUTED` | `RESOLVED` | Dispute settled on-chain |
| `RFQ_SENT` | `REJECTED` | `negotiate/reject` sent |
| `QUOTES_RECEIVED` | `REJECTED` | `negotiate/reject` sent |
| `COUNTERING` | `REJECTED` | `negotiate/reject` sent |

Rejection is valid from `RFQ_SENT`, `QUOTES_RECEIVED`, `COUNTERING`, and `ACCEPTED` states. The `ACCEPTED → REJECTED` transition handles the case where a seller refuses to counter-sign or a party revokes acceptance before escrow is funded. It is a terminal transition -- the session cannot be resumed after rejection.

Invalid state transitions return error code `-32001` and the session remains in its current state.

### 7.3 Diagram

```
IDLE
  |
  | negotiate/rfq
  v
RFQ_SENT -----------------------> REJECTED
  |
  | negotiate/quote
  v
QUOTES_RECEIVED ----------------> REJECTED
  |              |
  | counter      | accept
  v              v
COUNTERING ---> ACCEPTED -------> REJECTED
  |   ^            |
  |   | counter    | escrow deposit
  |   |            v
  +---+         ESCROWED
  |                |
  | reject         | service starts
  v                v
REJECTED        ACTIVE
                |      |
                |      | negotiate/dispute
                |      v
                |   DISPUTED
                |      |
                |      | settlement
                v      v
           COMPLETED  RESOLVED
```

---

## 8. Timeouts

Each message type has a default expiration. If a response is not received before the expiry, the behavior depends on the message type.

| Timeout | Default value | Behavior on expiry |
|---|---|---|
| RFQ expiry | 5 minutes (300,000 ms) | Session transitions to `REJECTED` -- no sellers responded |
| Quote expiry | 2 minutes (120,000 ms) | Individual quote becomes invalid; other quotes may still be active |
| Counter expiry | 2 minutes (120,000 ms) | Counter-offer lapses; negotiation may continue with previous terms |
| Max rounds | 5 | Counter-offers beyond this limit are rejected with `OPHIR_005` |
| Escrow timeout | Configurable (Solana slots) | Buyer may call `cancel_escrow` to reclaim deposited funds |

Timeouts are expressed as ISO 8601 timestamps in the `expires_at` field of each message.

---

## 9. Error codes

### 9.1 JSON-RPC standard errors

The `NegotiationServer` maps errors to standard JSON-RPC error codes in responses:

| Code | Meaning |
|---|---|
| `-32700` | Parse error -- request body is not valid JSON |
| `-32600` | Invalid request -- missing `jsonrpc: "2.0"` or `method` field |
| `-32601` | Method not found -- no handler registered for the requested method |
| `-32603` | Internal error -- unexpected non-Ophir exception during handler execution |
| `-32000` | Application error -- an `OphirError` was thrown; the `data.ophir_code` field contains the specific Ophir error code |

When a handler throws an `OphirError`, the response includes the Ophir error code in the `data` field:

```json
{
  "jsonrpc": "2.0",
  "id": "msg-007",
  "error": {
    "code": -32000,
    "message": "Cannot accept from state RFQ_SENT. Valid transitions: QUOTES_RECEIVED, REJECTED",
    "data": { "ophir_code": "OPHIR_004", "currentState": "RFQ_SENT", "targetState": "ACCEPTED" }
  }
}
```

### 9.2 Ophir application errors

Ophir defines typed error codes for programmatic error handling. These are returned in the `OphirError.code` field and in the JSON-RPC response's `data.ophir_code` field.

**Message validation (OPHIR_001 -- OPHIR_006)**

| Code | Name | Description |
|---|---|---|
| `OPHIR_001` | `INVALID_MESSAGE` | Message failed schema validation (missing field, wrong type) |
| `OPHIR_002` | `INVALID_SIGNATURE` | Ed25519 signature verification failed |
| `OPHIR_003` | `EXPIRED_MESSAGE` | Message has passed its `expires_at` timestamp |
| `OPHIR_004` | `INVALID_STATE_TRANSITION` | Requested action is not valid from the current state |
| `OPHIR_005` | `MAX_ROUNDS_EXCEEDED` | Counter-offer round count exceeds `max_rounds` |
| `OPHIR_006` | `DUPLICATE_MESSAGE` | Message ID already processed (replay protection) |

**Negotiation (OPHIR_100 -- OPHIR_104)**

| Code | Name | Description |
|---|---|---|
| `OPHIR_100` | `NO_MATCHING_SELLERS` | No sellers match the requested service category |
| `OPHIR_101` | `BUDGET_EXCEEDED` | Proposed price exceeds buyer's budget constraint |
| `OPHIR_102` | `SLA_REQUIREMENTS_NOT_MET` | Seller's SLA offer does not meet buyer's requirements |
| `OPHIR_103` | `QUOTE_EXPIRED` | Quote has passed its expiration timestamp |
| `OPHIR_104` | `NEGOTIATION_TIMEOUT` | Negotiation timed out waiting for a response |

**Escrow (OPHIR_200 -- OPHIR_204)**

| Code | Name | Description |
|---|---|---|
| `OPHIR_200` | `ESCROW_CREATION_FAILED` | Failed to create the Solana escrow account |
| `OPHIR_201` | `ESCROW_INSUFFICIENT_FUNDS` | Buyer's token account has insufficient USDC |
| `OPHIR_202` | `ESCROW_ALREADY_RELEASED` | Escrow has already been released |
| `OPHIR_203` | `ESCROW_TIMEOUT_NOT_REACHED` | Cannot cancel escrow before the timeout slot |
| `OPHIR_204` | `ESCROW_VERIFICATION_FAILED` | Escrow verification failed (PDA mismatch, wrong authority) |

**Dispute (OPHIR_300 -- OPHIR_301)**

| Code | Name | Description |
|---|---|---|
| `OPHIR_300` | `DISPUTE_INVALID_EVIDENCE` | Dispute evidence is invalid or insufficient |
| `OPHIR_301` | `DISPUTE_ALREADY_RESOLVED` | Dispute has already been resolved |

**Infrastructure (OPHIR_400 -- OPHIR_402)**

| Code | Name | Description |
|---|---|---|
| `OPHIR_400` | `SELLER_UNREACHABLE` | Could not reach the seller's endpoint |
| `OPHIR_401` | `SOLANA_RPC_ERROR` | Solana RPC request failed |
| `OPHIR_402` | `LOCKSTEP_UNREACHABLE` | Could not reach the Lockstep verification service |
