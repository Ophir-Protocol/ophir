# Solana Escrow

Ophir uses a Solana Anchor program to hold USDC in escrow during service delivery, providing on-chain financial enforcement of negotiated agreements.

**Program ID:** `CHwqh23SpWSM6WLsd15iQcP4KSkB351S9eGcN4fQSVqy`

---

## Overview

When a buyer and seller agree on terms through the [negotiation flow](./how-it-works.md), the buyer deposits USDC into a Program Derived Address (PDA) controlled by the escrow program. The funds are locked until one of three things happens:

1. The seller delivers successfully and claims the funds (`release_escrow`)
2. The buyer files a dispute with evidence of SLA violation (`dispute_escrow`)
3. The timeout elapses and the buyer reclaims the deposit (`cancel_escrow`)

The escrow account is cryptographically tied to the negotiated agreement through the `agreement_hash` -- the same SHA-256 digest that both parties signed during the `negotiate/accept` step. This ensures that on-chain funds correspond to exactly one set of negotiated terms.

---

## PDA Derivation

### Escrow Account

The escrow account is deterministically derived from three seeds:

```
seeds = ["escrow", buyer_pubkey, agreement_hash]
```

This ensures:
- Each buyer-agreement pair maps to exactly one escrow account
- The escrow address can be computed by anyone with the buyer's public key and agreement hash
- No two agreements can collide into the same escrow

### Vault Token Account

A separate SPL Token account holds the actual USDC. It is owned by the escrow PDA, meaning only the program can authorize transfers out of the vault.

```
vault_seeds = ["vault", escrow_pda]
```

---

## Account Structure

The on-chain escrow account stores all metadata needed for settlement and dispute resolution:

```rust
pub struct EscrowAccount {
    pub buyer: Pubkey,              // Buyer's wallet address
    pub seller: Pubkey,             // Seller's wallet address
    pub mint: Pubkey,               // Token mint (e.g., USDC)
    pub agreement_hash: [u8; 32],   // SHA-256 of canonicalized final terms
    pub deposit_amount: u64,        // Amount deposited, in smallest token units
    pub penalty_rate_bps: u16,      // Max penalty in basis points (500 = 5%)
    pub created_at: i64,            // Unix timestamp of creation
    pub timeout_slot: u64,          // Slot after which cancellation is allowed
    pub status: EscrowStatus,       // Active | Released | Disputed | Cancelled
    pub bump: u8,                   // PDA bump seed
}
```

The `mint` field records which SPL token is held in escrow (typically USDC). The `penalty_rate_bps` caps the maximum penalty that can be claimed in a dispute -- for example, `5000` means the buyer can claim at most 50% of the deposit as a penalty.

---

## Instructions

The escrow program exposes 4 instructions:

### `make_escrow`

Creates a new escrow account and deposits tokens from the buyer's token account into the vault.

**Parameters:**
- `agreement_hash: [u8; 32]` -- SHA-256 hash of the agreed terms
- `deposit_amount: u64` -- Amount of tokens to deposit (in smallest unit, e.g., 1000000 = 1 USDC)
- `timeout_slots: u64` -- Number of Solana slots before the escrow can be cancelled (~400ms per slot; 216,000 slots is roughly 24 hours)
- `penalty_rate_bps: u16` -- Maximum penalty as basis points of deposit (e.g., 500 = 5%, max 10000 = 100%)

**Signer:** Buyer

**Accounts required:** buyer, seller, escrow PDA, vault PDA, buyer token account, mint, system program, token program, rent.

**Validation:**
- `deposit_amount` must be greater than zero
- `timeout_slots` must be greater than zero
- `penalty_rate_bps` must not exceed 10,000
- Buyer token account must have sufficient balance

### `release_escrow`

Releases the full vault balance to the seller after successful service delivery.

**Parameters:**
- `verification_hash: Option<[u8; 32]>` -- Optional Lockstep verification proof hash

**Signer:** Seller

**Accounts required:** seller, escrow PDA, vault PDA, seller token account, token program.

**Validation:**
- Escrow status must be `Active`
- Signer must match the escrow's `seller` field

### `dispute_escrow`

Files a dispute, splitting the vault between the buyer (penalty amount) and the seller (remainder).

**Parameters:**
- `violation_evidence_hash: [u8; 32]` -- SHA-256 hash of the violation evidence data
- `penalty_amount: u64` -- Amount to return to buyer as a penalty

**Signer:** Buyer

**Accounts required:** buyer, escrow PDA, vault PDA, buyer token account, seller token account, token program.

**Validation:**
- Escrow status must be `Active`
- Signer must match the escrow's `buyer` field
- `penalty_amount` must not exceed `deposit_amount * penalty_rate_bps / 10000`

The penalty calculation uses safe integer math to prevent overflow. The remainder (`vault_balance - penalty_amount`) is transferred to the seller, ensuring all funds are distributed.

### `cancel_escrow`

Returns the full vault balance to the buyer after the timeout has elapsed. This is a safety mechanism for cases where the seller never delivers.

**Signer:** Buyer (only after `timeout_slot` has passed)

**Accounts required:** buyer, escrow PDA, vault PDA, buyer token account, token program.

**Validation:**
- Escrow status must be `Active`
- Current Solana slot must be >= `timeout_slot`
- Signer must match the escrow's `buyer` field

---

## Escrow Lifecycle

```
Active  -->  Released      Seller calls release_escrow after delivery
Active  -->  Disputed      Buyer calls dispute_escrow with evidence
Active  -->  Cancelled     Buyer calls cancel_escrow after timeout
```

All three transitions are terminal. Once an escrow moves out of `Active`, no further state changes are possible. The vault is fully drained in every terminal transition.

---

## Events

The program emits Anchor events for each state transition, enabling off-chain indexing and monitoring:

| Event | Fields | Emitted by |
|---|---|---|
| `EscrowCreated` | `buyer`, `seller`, `agreement_hash`, `deposit_amount` | `make_escrow` |
| `EscrowReleased` | `agreement_hash`, `amount` | `release_escrow` |
| `EscrowDisputed` | `agreement_hash`, `penalty_amount`, `evidence_hash` | `dispute_escrow` |
| `EscrowCancelled` | `agreement_hash`, `refund_amount` | `cancel_escrow` |

Events can be consumed by off-chain services to track agreement status, trigger notifications, or update reputation scores.

---

## SDK Integration

The `EscrowManager` class in `@ophir/sdk` provides a TypeScript interface for interacting with the escrow program.

### Deriving Addresses

```typescript
import { EscrowManager } from '@ophir/sdk';

const escrow = new EscrowManager();
// Or with custom config:
// const escrow = new EscrowManager({ rpcUrl: 'https://api.mainnet-beta.solana.com' });

// Derive the escrow PDA from buyer pubkey and agreement hash
const hashBytes = Buffer.from(agreement.agreement_hash, 'hex');
const { address, bump } = escrow.deriveEscrowAddress(buyerPublicKey, hashBytes);

console.log('Escrow PDA:', address);
console.log('Bump seed:', bump);

// Derive the vault token account
const escrowPubkeyBytes = new PublicKey(address).toBytes();
const { address: vaultAddress } = escrow.deriveVaultAddress(escrowPubkeyBytes);

console.log('Vault PDA:', vaultAddress);
```

### Creating an Escrow

```typescript
const result = await escrow.createEscrow({
  agreement,
  buyerKeypair: buyer.keypair,
  sellerPublicKey: sellerPubkey,
  depositAmount: 1_000_000,      // 1 USDC (6 decimals)
  timeoutSlots: 216_000,         // ~24 hours
  penaltyRateBps: 500,           // 5% max penalty
});

console.log('Escrow:', result.escrowAddress);
console.log('Vault:', result.vaultAddress);
console.log('Tx:', result.txSignature);
```

### Releasing Funds

```typescript
const release = await escrow.releaseEscrow({
  escrowAddress: result.escrowAddress,
  sellerKeypair: seller.keypair,
  verificationHash: lockstepProofHash,  // optional
});
```

### Filing a Dispute

```typescript
const dispute = await escrow.disputeEscrow({
  escrowAddress: result.escrowAddress,
  buyerKeypair: buyer.keypair,
  evidenceHash: violationEvidenceBytes,
  penaltyAmount: 50_000,  // 0.05 USDC penalty
});
```

---

## Error Codes

The program defines the following error codes:

| Error | Description |
|---|---|
| `EscrowNotActive` | The escrow must be in `Active` status for this operation |
| `TimeoutNotReached` | The timeout slot has not been reached; cancellation is not yet allowed |
| `PenaltyExceedsMax` | The requested penalty exceeds `deposit_amount * penalty_rate_bps / 10000` |
| `InvalidDeposit` | Deposit amount must be greater than zero |
| `InvalidTimeout` | Timeout slots must be greater than zero |
| `InvalidPenaltyRate` | Penalty rate must not exceed 10,000 basis points |
| `InvalidSeller` | The seller account does not match the escrow's stored seller |
| `Unauthorized` | The signer does not match the expected account |
| `InvalidMint` | A token account's mint does not match the expected escrow mint |
| `ArithmeticOverflow` | `current_slot + timeout_slots` overflows `u64` |

---

## Further Reading

- [**How It Works**](./how-it-works.md) -- See how escrow fits into the negotiation lifecycle.
- [**SLA Schema**](./sla-schema.md) -- Define penalty structures that map to escrow enforcement.
- [**Identity**](./identity.md) -- Understand the unified Ed25519 key model for signing and transactions.
