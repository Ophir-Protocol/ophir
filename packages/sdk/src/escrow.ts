import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { createHash } from 'node:crypto';
import { OphirError, OphirErrorCode, DEFAULT_CONFIG, ESCROW_PROGRAM_ID } from '@ophirai/protocol';
import type { Agreement } from './types.js';

const DEFAULT_RPC_URL = DEFAULT_CONFIG.solana_rpc;
const DEFAULT_PROGRAM_ID = ESCROW_PROGRAM_ID;
const DEFAULT_TIMEOUT_SLOTS = 216_000; // ~24h at 400ms slots
const DEFAULT_PENALTY_RATE_BPS = 500; // 5%
const SPL_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

/** Escrow account status as stored on-chain. */
export type EscrowStatus = 'Active' | 'Released' | 'Disputed' | 'Cancelled';

/** Numeric status discriminant matching the Anchor program's EscrowStatus enum. */
const ESCROW_STATUS_MAP: Record<number, EscrowStatus> = {
  0: 'Active',
  1: 'Released',
  2: 'Disputed',
  3: 'Cancelled',
};

/** On-chain escrow account data. */
export interface EscrowAccountData {
  buyer: string;
  seller: string;
  mint: string;
  agreementHash: string;
  depositAmount: bigint;
  penaltyRateBps: number;
  createdAt: number;
  timeoutSlot: bigint;
  status: EscrowStatus;
  bump: number;
}

/**
 * Compute the Anchor instruction discriminator for a given instruction name.
 * Anchor uses sha256("global:<name>")[0..8] as the 8-byte discriminator.
 */
function anchorDiscriminator(name: string): Buffer {
  const hash = createHash('sha256').update(`global:${name}`).digest();
  return Buffer.from(hash.subarray(0, 8));
}

/** Anchor discriminators for each escrow instruction. */
const DISCRIMINATORS = {
  makeEscrow: anchorDiscriminator('make_escrow'),
  releaseEscrow: anchorDiscriminator('release_escrow'),
  disputeEscrow: anchorDiscriminator('dispute_escrow'),
  cancelEscrow: anchorDiscriminator('cancel_escrow'),
} as const;

/** Anchor account discriminator for EscrowAccount (sha256("account:EscrowAccount")[0..8]). */
const ACCOUNT_DISCRIMINATOR = createHash('sha256')
  .update('account:EscrowAccount')
  .digest()
  .subarray(0, 8);

/** Size of the EscrowAccount: 8 (discriminator) + 32*3 + 32 + 8 + 2 + 8 + 8 + 1 + 1 = 164 bytes. */
const ESCROW_ACCOUNT_SIZE = 8 + 32 + 32 + 32 + 32 + 8 + 2 + 8 + 8 + 1 + 1;

/**
 * Serialize make_escrow instruction data in Borsh format.
 * Layout: discriminator(8) + agreement_hash(32) + deposit_amount(u64) + timeout_slots(u64) + penalty_rate_bps(u16)
 */
function serializeMakeEscrow(
  agreementHash: Uint8Array,
  depositAmount: bigint,
  timeoutSlots: bigint,
  penaltyRateBps: number,
): Buffer {
  const buf = Buffer.alloc(8 + 32 + 8 + 8 + 2);
  let offset = 0;

  DISCRIMINATORS.makeEscrow.copy(buf, offset);
  offset += 8;

  Buffer.from(agreementHash).copy(buf, offset);
  offset += 32;

  buf.writeBigUInt64LE(depositAmount, offset);
  offset += 8;

  buf.writeBigUInt64LE(timeoutSlots, offset);
  offset += 8;

  buf.writeUInt16LE(penaltyRateBps, offset);

  return buf;
}

/**
 * Serialize release_escrow instruction data in Borsh format.
 * Layout: discriminator(8) + option_flag(1) + [verification_hash(32) if Some]
 */
function serializeReleaseEscrow(verificationHash?: Uint8Array): Buffer {
  if (verificationHash) {
    const buf = Buffer.alloc(8 + 1 + 32);
    DISCRIMINATORS.releaseEscrow.copy(buf, 0);
    buf.writeUInt8(1, 8); // Some
    Buffer.from(verificationHash).copy(buf, 9);
    return buf;
  }
  const buf = Buffer.alloc(8 + 1);
  DISCRIMINATORS.releaseEscrow.copy(buf, 0);
  buf.writeUInt8(0, 8); // None
  return buf;
}

/**
 * Serialize dispute_escrow instruction data in Borsh format.
 * Layout: discriminator(8) + violation_evidence_hash(32) + penalty_amount(u64)
 */
function serializeDisputeEscrow(evidenceHash: Uint8Array, penaltyAmount: bigint): Buffer {
  const buf = Buffer.alloc(8 + 32 + 8);
  DISCRIMINATORS.disputeEscrow.copy(buf, 0);
  Buffer.from(evidenceHash).copy(buf, 8);
  buf.writeBigUInt64LE(penaltyAmount, 40);
  return buf;
}

/**
 * Serialize cancel_escrow instruction data in Borsh format.
 * Layout: discriminator(8) only — no additional args.
 */
function serializeCancelEscrow(): Buffer {
  const buf = Buffer.alloc(8);
  DISCRIMINATORS.cancelEscrow.copy(buf, 0);
  return buf;
}

/**
 * Deserialize on-chain EscrowAccount data from raw account bytes.
 *
 * Layout (after 8-byte Anchor discriminator):
 *   buyer: Pubkey(32) + seller: Pubkey(32) + mint: Pubkey(32) +
 *   agreement_hash: [u8;32](32) + deposit_amount: u64(8) +
 *   penalty_rate_bps: u16(2) + created_at: i64(8) + timeout_slot: u64(8) +
 *   status: u8(1) + bump: u8(1)
 */
function deserializeEscrowAccount(data: Buffer): EscrowAccountData {
  if (data.length < ESCROW_ACCOUNT_SIZE) {
    throw new OphirError(
      OphirErrorCode.SOLANA_RPC_ERROR,
      `Invalid escrow account data: expected at least ${ESCROW_ACCOUNT_SIZE} bytes, got ${data.length}`,
    );
  }

  // Verify Anchor discriminator
  const disc = data.subarray(0, 8);
  if (!disc.equals(Buffer.from(ACCOUNT_DISCRIMINATOR))) {
    throw new OphirError(
      OphirErrorCode.SOLANA_RPC_ERROR,
      'Invalid escrow account discriminator — account does not belong to the Ophir escrow program',
    );
  }

  let offset = 8;

  const buyer = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
  offset += 32;

  const seller = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
  offset += 32;

  const mint = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
  offset += 32;

  const agreementHash = Buffer.from(data.subarray(offset, offset + 32)).toString('hex');
  offset += 32;

  const depositAmount = data.readBigUInt64LE(offset);
  offset += 8;

  const penaltyRateBps = data.readUInt16LE(offset);
  offset += 2;

  const createdAt = Number(data.readBigInt64LE(offset));
  offset += 8;

  const timeoutSlot = data.readBigUInt64LE(offset);
  offset += 8;

  const statusByte = data.readUInt8(offset);
  offset += 1;

  const bump = data.readUInt8(offset);

  const status = ESCROW_STATUS_MAP[statusByte];
  if (!status) {
    throw new OphirError(
      OphirErrorCode.SOLANA_RPC_ERROR,
      `Unknown escrow status byte: ${statusByte}`,
    );
  }

  return {
    buyer,
    seller,
    mint,
    agreementHash,
    depositAmount,
    penaltyRateBps,
    createdAt,
    timeoutSlot,
    status,
    bump,
  };
}

/**
 * Manages Solana escrow PDAs for agreement payments and dispute resolution.
 *
 * Derives deterministic PDA addresses from buyer pubkey and agreement hash,
 * ensuring collision-resistant escrow accounts tied to specific agreements.
 * Builds and submits Solana transactions for all escrow lifecycle operations.
 */
export class EscrowManager {
  private rpcUrl: string;
  private programId: PublicKey;

  constructor(config?: { rpcUrl?: string; programId?: string }) {
    this.rpcUrl = config?.rpcUrl ?? DEFAULT_RPC_URL;
    this.programId = new PublicKey(config?.programId ?? DEFAULT_PROGRAM_ID);
  }

  /**
   * Derive the deterministic escrow PDA address from buyer pubkey and agreement hash.
   * Seeds: ["escrow", buyer_pubkey, agreement_hash]
   *
   * @param buyerPublicKey - 32-byte Ed25519 public key of the buyer
   * @param agreementHash - SHA-256 hash of the canonicalized agreement terms (32 bytes)
   * @returns The base58-encoded PDA address and its bump seed
   * @throws {OphirError} INVALID_MESSAGE if buyerPublicKey is not 32 bytes
   */
  deriveEscrowAddress(
    buyerPublicKey: Uint8Array,
    agreementHash: Uint8Array,
  ): { address: string; bump: number } {
    if (buyerPublicKey.length !== 32) {
      throw new OphirError(
        OphirErrorCode.INVALID_MESSAGE,
        `Invalid buyer public key length: expected 32, got ${buyerPublicKey.length}`,
      );
    }
    if (agreementHash.length !== 32) {
      throw new OphirError(
        OphirErrorCode.INVALID_MESSAGE,
        `Invalid agreement hash length: expected 32, got ${agreementHash.length}`,
      );
    }
    const [pda, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from('escrow'), buyerPublicKey, agreementHash],
      this.programId,
    );
    return { address: pda.toBase58(), bump };
  }

  /**
   * Derive the vault token account PDA from an escrow address.
   * Seeds: ["vault", escrow_pubkey]
   *
   * @param escrowPublicKey - 32-byte public key of the escrow PDA
   * @returns The base58-encoded vault PDA address and its bump seed
   */
  deriveVaultAddress(escrowPublicKey: Uint8Array): { address: string; bump: number } {
    const [pda, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), escrowPublicKey],
      this.programId,
    );
    return { address: pda.toBase58(), bump };
  }

  /**
   * Create an escrow account and deposit tokens into the PDA-controlled vault.
   *
   * Builds a `make_escrow` instruction with the buyer's token account as the
   * funding source, initializes the escrow PDA and vault, and submits the
   * transaction to the Solana network.
   *
   * @param params.agreement - The signed agreement containing the hash to escrow
   * @param params.buyerKeypair - Buyer's Ed25519 keypair (signs the transaction)
   * @param params.sellerPublicKey - Seller's 32-byte public key
   * @param params.depositAmount - Amount in smallest token units (e.g., USDC has 6 decimals)
   * @param params.mintAddress - SPL token mint address (e.g., USDC mint)
   * @param params.buyerTokenAccount - Buyer's associated token account address
   * @param params.timeoutSlots - Slots before escrow can be cancelled (default: ~24h)
   * @param params.penaltyRateBps - Max penalty in basis points (default: 500 = 5%)
   * @returns The escrow PDA address, vault address, and transaction signature
   * @throws {OphirError} ESCROW_CREATION_FAILED if the transaction fails
   * @throws {OphirError} INVALID_MESSAGE if inputs are invalid
   */
  async createEscrow(params: {
    agreement: Agreement;
    buyerKeypair: { publicKey: Uint8Array; secretKey: Uint8Array };
    sellerPublicKey: Uint8Array;
    depositAmount: bigint;
    mintAddress: string;
    buyerTokenAccount: string;
    timeoutSlots?: number;
    penaltyRateBps?: number;
  }): Promise<{ escrowAddress: string; vaultAddress: string; txSignature: string }> {
    if (params.depositAmount <= 0n) {
      throw new OphirError(
        OphirErrorCode.ESCROW_CREATION_FAILED,
        'Deposit amount must be greater than zero',
      );
    }
    if (params.sellerPublicKey.length !== 32) {
      throw new OphirError(
        OphirErrorCode.INVALID_MESSAGE,
        `Invalid seller public key length: expected 32, got ${params.sellerPublicKey.length}`,
      );
    }

    const timeoutSlots = params.timeoutSlots ?? DEFAULT_TIMEOUT_SLOTS;
    const penaltyRateBps = params.penaltyRateBps ?? DEFAULT_PENALTY_RATE_BPS;

    if (penaltyRateBps > 10000) {
      throw new OphirError(
        OphirErrorCode.ESCROW_CREATION_FAILED,
        `Penalty rate ${penaltyRateBps} exceeds maximum 10000 basis points`,
      );
    }

    const hashBytes = Buffer.from(params.agreement.agreement_hash, 'hex');
    if (hashBytes.length !== 32) {
      throw new OphirError(
        OphirErrorCode.INVALID_MESSAGE,
        `Invalid agreement hash: expected 64 hex chars (32 bytes), got ${params.agreement.agreement_hash.length} chars`,
      );
    }

    const buyerPubkey = new PublicKey(params.buyerKeypair.publicKey);
    const sellerPubkey = new PublicKey(params.sellerPublicKey);
    const mintPubkey = new PublicKey(params.mintAddress);
    const buyerTokenPubkey = new PublicKey(params.buyerTokenAccount);

    const { address: escrowAddress, bump: _escrowBump } = this.deriveEscrowAddress(
      params.buyerKeypair.publicKey,
      hashBytes,
    );
    const escrowPubkey = new PublicKey(escrowAddress);

    const { address: vaultAddress } = this.deriveVaultAddress(escrowPubkey.toBytes());
    const vaultPubkey = new PublicKey(vaultAddress);

    const instructionData = serializeMakeEscrow(
      hashBytes,
      params.depositAmount,
      BigInt(timeoutSlots),
      penaltyRateBps,
    );

    const instruction = new TransactionInstruction({
      keys: [
        { pubkey: buyerPubkey, isSigner: true, isWritable: true },
        { pubkey: sellerPubkey, isSigner: false, isWritable: false },
        { pubkey: escrowPubkey, isSigner: false, isWritable: true },
        { pubkey: vaultPubkey, isSigner: false, isWritable: true },
        { pubkey: buyerTokenPubkey, isSigner: false, isWritable: true },
        { pubkey: mintPubkey, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      programId: this.programId,
      data: instructionData,
    });

    const connection = new Connection(this.rpcUrl, 'confirmed');
    const buyerSigner = Keypair.fromSecretKey(params.buyerKeypair.secretKey);
    const transaction = new Transaction().add(instruction);

    try {
      const txSignature = await sendAndConfirmTransaction(connection, transaction, [buyerSigner]);
      return { escrowAddress, vaultAddress, txSignature };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new OphirError(
        OphirErrorCode.ESCROW_CREATION_FAILED,
        `Failed to create escrow: ${message}`,
        { escrowAddress, vaultAddress },
      );
    }
  }

  /**
   * Release escrowed funds to the seller after successful job completion.
   *
   * Only the seller can call this instruction. Transfers the entire vault
   * balance to the seller's token account and marks the escrow as Released.
   *
   * @param params.escrowAddress - Base58-encoded escrow PDA address
   * @param params.sellerKeypair - Seller's Ed25519 keypair (must match escrow.seller)
   * @param params.sellerTokenAccount - Seller's token account to receive funds
   * @param params.verificationHash - Optional 32-byte proof of service delivery
   * @returns The transaction signature
   * @throws {OphirError} ESCROW_ALREADY_RELEASED if the escrow is not Active
   */
  async releaseEscrow(params: {
    escrowAddress: string;
    sellerKeypair: { publicKey: Uint8Array; secretKey: Uint8Array };
    sellerTokenAccount: string;
    verificationHash?: Uint8Array;
  }): Promise<{ txSignature: string }> {
    if (params.verificationHash && params.verificationHash.length !== 32) {
      throw new OphirError(
        OphirErrorCode.INVALID_MESSAGE,
        `Invalid verification hash length: expected 32, got ${params.verificationHash.length}`,
      );
    }

    const escrowPubkey = new PublicKey(params.escrowAddress);
    const sellerPubkey = new PublicKey(params.sellerKeypair.publicKey);
    const sellerTokenPubkey = new PublicKey(params.sellerTokenAccount);

    const { address: vaultAddress } = this.deriveVaultAddress(escrowPubkey.toBytes());
    const vaultPubkey = new PublicKey(vaultAddress);

    const instructionData = serializeReleaseEscrow(params.verificationHash);

    const instruction = new TransactionInstruction({
      keys: [
        { pubkey: sellerPubkey, isSigner: true, isWritable: true },
        { pubkey: escrowPubkey, isSigner: false, isWritable: true },
        { pubkey: vaultPubkey, isSigner: false, isWritable: true },
        { pubkey: sellerTokenPubkey, isSigner: false, isWritable: true },
        { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      programId: this.programId,
      data: instructionData,
    });

    const connection = new Connection(this.rpcUrl, 'confirmed');
    const sellerSigner = Keypair.fromSecretKey(params.sellerKeypair.secretKey);
    const transaction = new Transaction().add(instruction);

    try {
      const txSignature = await sendAndConfirmTransaction(connection, transaction, [sellerSigner]);
      return { txSignature };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new OphirError(
        OphirErrorCode.ESCROW_ALREADY_RELEASED,
        `Failed to release escrow: ${message}`,
        { escrowAddress: params.escrowAddress },
      );
    }
  }

  /**
   * File an on-chain dispute, splitting funds between buyer (penalty) and seller (remainder).
   *
   * Only the buyer can initiate a dispute. The penalty amount must not exceed
   * `deposit_amount * penalty_rate_bps / 10000`. The penalty is returned to
   * the buyer and the remainder goes to the seller.
   *
   * @param params.escrowAddress - Base58-encoded escrow PDA address
   * @param params.buyerKeypair - Buyer's Ed25519 keypair (must match escrow.buyer)
   * @param params.buyerTokenAccount - Buyer's token account for penalty refund
   * @param params.sellerTokenAccount - Seller's token account for remainder
   * @param params.evidenceHash - 32-byte SHA-256 hash of the violation evidence
   * @param params.penaltyAmount - Penalty in smallest token units
   * @returns The transaction signature
   * @throws {OphirError} ESCROW_VERIFICATION_FAILED if penalty exceeds max allowed
   */
  async disputeEscrow(params: {
    escrowAddress: string;
    buyerKeypair: { publicKey: Uint8Array; secretKey: Uint8Array };
    buyerTokenAccount: string;
    sellerTokenAccount: string;
    evidenceHash: Uint8Array;
    penaltyAmount: bigint;
  }): Promise<{ txSignature: string }> {
    if (params.evidenceHash.length !== 32) {
      throw new OphirError(
        OphirErrorCode.DISPUTE_INVALID_EVIDENCE,
        `Invalid evidence hash length: expected 32, got ${params.evidenceHash.length}`,
      );
    }
    if (params.penaltyAmount < 0n) {
      throw new OphirError(
        OphirErrorCode.ESCROW_VERIFICATION_FAILED,
        'Penalty amount cannot be negative',
      );
    }

    const escrowPubkey = new PublicKey(params.escrowAddress);
    const buyerPubkey = new PublicKey(params.buyerKeypair.publicKey);
    const buyerTokenPubkey = new PublicKey(params.buyerTokenAccount);
    const sellerTokenPubkey = new PublicKey(params.sellerTokenAccount);

    const { address: vaultAddress } = this.deriveVaultAddress(escrowPubkey.toBytes());
    const vaultPubkey = new PublicKey(vaultAddress);

    const instructionData = serializeDisputeEscrow(params.evidenceHash, params.penaltyAmount);

    const instruction = new TransactionInstruction({
      keys: [
        { pubkey: buyerPubkey, isSigner: true, isWritable: true },
        { pubkey: escrowPubkey, isSigner: false, isWritable: true },
        { pubkey: vaultPubkey, isSigner: false, isWritable: true },
        { pubkey: buyerTokenPubkey, isSigner: false, isWritable: true },
        { pubkey: sellerTokenPubkey, isSigner: false, isWritable: true },
        { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      programId: this.programId,
      data: instructionData,
    });

    const connection = new Connection(this.rpcUrl, 'confirmed');
    const buyerSigner = Keypair.fromSecretKey(params.buyerKeypair.secretKey);
    const transaction = new Transaction().add(instruction);

    try {
      const txSignature = await sendAndConfirmTransaction(connection, transaction, [buyerSigner]);
      return { txSignature };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new OphirError(
        OphirErrorCode.ESCROW_VERIFICATION_FAILED,
        `Failed to dispute escrow: ${message}`,
        { escrowAddress: params.escrowAddress },
      );
    }
  }

  /**
   * Cancel an escrow after the timeout slot has passed, returning all funds to the buyer.
   *
   * Only the buyer can cancel, and only after the escrow's timeout_slot has been reached.
   * Transfers the entire vault balance back to the buyer's token account.
   *
   * @param params.escrowAddress - Base58-encoded escrow PDA address
   * @param params.buyerKeypair - Buyer's Ed25519 keypair (must match escrow.buyer)
   * @param params.buyerTokenAccount - Buyer's token account for refund
   * @returns The transaction signature
   * @throws {OphirError} ESCROW_TIMEOUT_NOT_REACHED if timeout has not elapsed
   */
  async cancelEscrow(params: {
    escrowAddress: string;
    buyerKeypair: { publicKey: Uint8Array; secretKey: Uint8Array };
    buyerTokenAccount: string;
  }): Promise<{ txSignature: string }> {
    const escrowPubkey = new PublicKey(params.escrowAddress);
    const buyerPubkey = new PublicKey(params.buyerKeypair.publicKey);
    const buyerTokenPubkey = new PublicKey(params.buyerTokenAccount);

    const { address: vaultAddress } = this.deriveVaultAddress(escrowPubkey.toBytes());
    const vaultPubkey = new PublicKey(vaultAddress);

    const instructionData = serializeCancelEscrow();

    const instruction = new TransactionInstruction({
      keys: [
        { pubkey: buyerPubkey, isSigner: true, isWritable: true },
        { pubkey: escrowPubkey, isSigner: false, isWritable: true },
        { pubkey: vaultPubkey, isSigner: false, isWritable: true },
        { pubkey: buyerTokenPubkey, isSigner: false, isWritable: true },
        { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      programId: this.programId,
      data: instructionData,
    });

    const connection = new Connection(this.rpcUrl, 'confirmed');
    const buyerSigner = Keypair.fromSecretKey(params.buyerKeypair.secretKey);
    const transaction = new Transaction().add(instruction);

    try {
      const txSignature = await sendAndConfirmTransaction(connection, transaction, [buyerSigner]);
      return { txSignature };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new OphirError(
        OphirErrorCode.ESCROW_TIMEOUT_NOT_REACHED,
        `Failed to cancel escrow: ${message}`,
        { escrowAddress: params.escrowAddress },
      );
    }
  }

  /**
   * Fetch and deserialize escrow account data from Solana.
   *
   * Connects to the configured Solana RPC endpoint, fetches the raw account
   * data at the given address, and deserializes it into a typed EscrowAccountData.
   *
   * @param escrowAddress - Base58-encoded escrow PDA address
   * @returns The deserialized escrow account data
   * @throws {OphirError} SOLANA_RPC_ERROR if the account doesn't exist or deserialization fails
   */
  async getEscrowStatus(escrowAddress: string): Promise<EscrowAccountData> {
    const connection = new Connection(this.rpcUrl, 'confirmed');
    const pubkey = new PublicKey(escrowAddress);

    let accountInfo;
    try {
      accountInfo = await connection.getAccountInfo(pubkey);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new OphirError(
        OphirErrorCode.SOLANA_RPC_ERROR,
        `Failed to fetch escrow account: ${message}`,
        { escrowAddress },
      );
    }

    if (!accountInfo) {
      throw new OphirError(
        OphirErrorCode.SOLANA_RPC_ERROR,
        `Escrow account not found at address: ${escrowAddress}`,
        { escrowAddress },
      );
    }

    if (!accountInfo.owner.equals(this.programId)) {
      throw new OphirError(
        OphirErrorCode.SOLANA_RPC_ERROR,
        `Account at ${escrowAddress} is not owned by the Ophir escrow program`,
        { escrowAddress, owner: accountInfo.owner.toBase58() },
      );
    }

    return deserializeEscrowAccount(Buffer.from(accountInfo.data));
  }
}
