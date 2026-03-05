# Agent Identity

Ophir uses the W3C `did:key` standard for agent identity, built on Ed25519 public keys. This provides decentralized, self-sovereign identity with no registration authority -- and is directly compatible with Solana keypairs.

---

## Overview

Every agent in the Ophir protocol is identified by a `did:key` string derived from its Ed25519 public key. This identifier appears in every JSON-RPC message the agent sends and is used to verify signatures on incoming messages.

Because Solana also uses Ed25519 keys, the same keypair that signs Ophir negotiation messages can sign Solana transactions for [escrow operations](./escrow.md). There is no key translation, bridging, or separate wallet required.

---

## `did:key` Format

A `did:key` identifier encodes an Ed25519 public key using multicodec and base58btc:

```
did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK
```

The encoding process:

1. Take the 32-byte Ed25519 public key
2. Prepend the multicodec prefix `0xed01` (Ed25519 public key indicator)
3. Encode the resulting 34 bytes with base58btc
4. Prepend the string `did:key:z`

The `z` prefix indicates base58btc encoding per the multibase specification. The `0xed01` prefix indicates an Ed25519 public key per the multicodec table. Together, these standards ensure that any compliant system can decode the public key from the DID string.

---

## Key Operations

### Generate a Keypair

Generate a raw Ed25519 keypair using `tweetnacl`:

```typescript
import { generateKeyPair, publicKeyToDid } from '@ophir/sdk';

const keypair = generateKeyPair();
// keypair.publicKey  -- 32-byte Uint8Array
// keypair.secretKey  -- 64-byte Uint8Array (includes public key as last 32 bytes)

const did = publicKeyToDid(keypair.publicKey);
// "did:key:z6Mk..."
```

### Generate a Full Agent Identity

The `generateAgentIdentity()` function creates a keypair, derives the `did:key`, and bundles it with an endpoint URL. This is the standard way to create a new agent.

```typescript
import { generateAgentIdentity } from '@ophir/sdk';

const identity = generateAgentIdentity('http://localhost:3001');
// {
//   agentId: "did:key:z6Mk...",
//   keypair: { publicKey: Uint8Array(32), secretKey: Uint8Array(64) },
//   endpoint: "http://localhost:3001"
// }
```

The `endpoint` parameter is required. It specifies the HTTP URL where the agent listens for incoming JSON-RPC messages (quotes, counters, accepts).

### Convert Between Formats

```typescript
import { publicKeyToDid, didToPublicKey } from '@ophir/sdk';

// Uint8Array -> did:key string
const did = publicKeyToDid(publicKey);

// did:key string -> Uint8Array (32-byte public key)
const pubkey = didToPublicKey(did);
```

`didToPublicKey` validates the multicodec prefix and throws an `OphirError` with code `INVALID_MESSAGE` if the input is not a valid Ed25519 `did:key`.

---

## Solana Compatibility

Ed25519 keys used by Ophir are the same curve and format used by Solana. A Solana keypair can be directly used as an Ophir agent identity:

```typescript
import { Keypair } from '@solana/web3.js';
import { publicKeyToDid } from '@ophir/sdk';

const solanaKeypair = Keypair.generate();
const agentDid = publicKeyToDid(solanaKeypair.publicKey.toBytes());
```

This means:

- The same key that signs `negotiate/quote` messages also signs `make_escrow` transactions
- No key derivation, wrapping, or bridging is needed
- Agent identity on the protocol layer is mathematically identical to wallet identity on the settlement layer
- Verification is uniform: `nacl.sign.detached.verify` works for both message signatures and (conceptually) for transaction signatures

This unified key model is a deliberate design choice. It eliminates an entire class of key management problems and ensures that the party who signs a quote is provably the same party who can claim funds from the corresponding escrow.

---

## Message Signing

All six Ophir message types (RFQs, quotes, counter-offers, accepts, rejects, and disputes) are signed using Ed25519. The signing process is deterministic and does not introduce an intermediate hashing step.

### Signing Process

1. **Canonicalize** the message `params` object using `json-stable-stringify` (JCS, RFC 8785). This produces identical JSON output regardless of key insertion order.
2. **Encode** the canonical JSON string as UTF-8 bytes using `TextEncoder`.
3. **Sign** the raw UTF-8 bytes directly with Ed25519 (`tweetnacl` `nacl.sign.detached`). There is no SHA-256 hashing of the message before signing -- Ed25519 handles this internally.
4. **Base64-encode** the resulting 64-byte signature.

### Code

```typescript
import { signMessage, verifyMessage } from '@ophir/sdk';

// Sign a message object
const signature = signMessage(quoteParams, secretKey);
// Returns: base64-encoded 64-byte Ed25519 signature

// Verify a signature
const isValid = verifyMessage(quoteParams, signature, publicKey);
// Returns: boolean (never throws on invalid input)
```

### Verification Process

Verification reverses the signing process:

1. Canonicalize the `params` object with `json-stable-stringify`
2. Encode as UTF-8 bytes
3. Decode the base64 signature to 64 bytes
4. Call `nacl.sign.detached.verify(bytes, signatureBytes, publicKey)`

If any step fails (invalid base64, wrong key length, tampered message), `verifyMessage` returns `false`. It never throws.

### Agreement Hash

The `agreement_hash` is computed separately from message signing. It is the SHA-256 digest of the JCS-canonicalized `final_terms` object:

```typescript
import { agreementHash } from '@ophir/sdk';

const hash = agreementHash(finalTerms);
// Returns: hex-encoded SHA-256 string
```

This hash serves as:
- A unique identifier for the agreement
- A PDA seed for the [Solana escrow account](./escrow.md), binding on-chain funds to the negotiated terms
- A commitment that both parties sign in the `negotiate/accept` message

---

## Security Properties

| Property | Mechanism |
|---|---|
| **Tamper detection** | Any modification to a signed message invalidates the Ed25519 signature |
| **Non-repudiation** | A valid signature proves the holder of the private key produced it |
| **Deterministic canonicalization** | JCS ensures the same object always produces the same bytes, regardless of serialization order |
| **Decentralized identity** | `did:key` requires no registry, authority, or online service |
| **Cross-layer binding** | The same Ed25519 key signs protocol messages and Solana transactions |

---

## Further Reading

- [**How It Works**](./how-it-works.md) -- See how signatures fit into the negotiation flow and security model.
- [**Solana Escrow**](./escrow.md) -- How the agreement hash becomes a PDA seed for on-chain settlement.
- [**SLA Schema**](./sla-schema.md) -- The terms that get signed and committed to.
