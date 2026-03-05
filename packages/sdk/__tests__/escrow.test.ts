import { describe, it, expect } from 'vitest';
import { PublicKey, Keypair } from '@solana/web3.js';
import { EscrowManager } from '../src/escrow.js';
import { OphirError } from '@ophirai/protocol';

const DEFAULT_PROGRAM_ID = 'CHwqh23SpWSM6WLsd15iQcP4KSkB351S9eGcN4fQSVqy';

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
  return buf;
}

describe('EscrowManager', () => {
  // ── Constructor ───────────────────────────────────────────────────

  it('constructs with defaults without error', () => {
    const mgr = new EscrowManager();
    expect(mgr).toBeInstanceOf(EscrowManager);
  });

  it('accepts custom rpcUrl and programId', () => {
    const kp = Keypair.generate();
    const mgr = new EscrowManager({
      rpcUrl: 'https://my-rpc.example.com',
      programId: kp.publicKey.toBase58(),
    });
    expect(mgr).toBeInstanceOf(EscrowManager);
  });

  // ── deriveEscrowAddress ───────────────────────────────────────────

  it('deriveEscrowAddress is deterministic (same input → same output)', () => {
    const mgr = new EscrowManager();
    const buyer = Keypair.generate().publicKey.toBytes();
    const hash = randomBytes(32);
    const a = mgr.deriveEscrowAddress(buyer, hash);
    const b = mgr.deriveEscrowAddress(buyer, hash);
    expect(a.address).toBe(b.address);
    expect(a.bump).toBe(b.bump);
  });

  it('deriveEscrowAddress returns different addresses for different inputs', () => {
    const mgr = new EscrowManager();
    const buyer = Keypair.generate().publicKey.toBytes();
    const hash1 = randomBytes(32);
    const hash2 = randomBytes(32);
    const a = mgr.deriveEscrowAddress(buyer, hash1);
    const b = mgr.deriveEscrowAddress(buyer, hash2);
    expect(a.address).not.toBe(b.address);
  });

  it('deriveEscrowAddress returns valid base58 address (32–44 chars)', () => {
    const mgr = new EscrowManager();
    const buyer = Keypair.generate().publicKey.toBytes();
    const hash = randomBytes(32);
    const { address } = mgr.deriveEscrowAddress(buyer, hash);
    expect(address.length).toBeGreaterThanOrEqual(32);
    expect(address.length).toBeLessThanOrEqual(44);
    expect(() => new PublicKey(address)).not.toThrow();
  });

  it('two different agreement hashes produce different escrow addresses', () => {
    const mgr = new EscrowManager();
    const buyer = Keypair.generate().publicKey.toBytes();
    const hashA = new Uint8Array(32).fill(0);
    const hashB = new Uint8Array(32).fill(1);
    const a = mgr.deriveEscrowAddress(buyer, hashA);
    const b = mgr.deriveEscrowAddress(buyer, hashB);
    expect(a.address).not.toBe(b.address);
  });

  it('two different buyers produce different escrow addresses', () => {
    const mgr = new EscrowManager();
    const buyer1 = Keypair.generate().publicKey.toBytes();
    const buyer2 = Keypair.generate().publicKey.toBytes();
    const hash = randomBytes(32);
    const a = mgr.deriveEscrowAddress(buyer1, hash);
    const b = mgr.deriveEscrowAddress(buyer2, hash);
    expect(a.address).not.toBe(b.address);
  });

  it('PDA derivation uses correct seeds (matches manual findProgramAddressSync)', () => {
    const mgr = new EscrowManager();
    const programId = new PublicKey(DEFAULT_PROGRAM_ID);
    const buyer = Keypair.generate().publicKey.toBytes();
    const hash = randomBytes(32);

    const { address, bump } = mgr.deriveEscrowAddress(buyer, hash);

    const [expectedPda, expectedBump] = PublicKey.findProgramAddressSync(
      [Buffer.from('escrow'), buyer, hash],
      programId,
    );
    expect(address).toBe(expectedPda.toBase58());
    expect(bump).toBe(expectedBump);
  });

  // ── deriveVaultAddress ────────────────────────────────────────────

  it('deriveVaultAddress is deterministic', () => {
    const mgr = new EscrowManager();
    const escrowKey = Keypair.generate().publicKey.toBytes();
    const a = mgr.deriveVaultAddress(escrowKey);
    const b = mgr.deriveVaultAddress(escrowKey);
    expect(a.address).toBe(b.address);
    expect(a.bump).toBe(b.bump);
  });

  it('deriveVaultAddress differs from escrow address', () => {
    const mgr = new EscrowManager();
    const buyer = Keypair.generate().publicKey.toBytes();
    const hash = randomBytes(32);
    const { address: escrowAddr } = mgr.deriveEscrowAddress(buyer, hash);
    const escrowPubkey = new PublicKey(escrowAddr);
    const { address: vaultAddr } = mgr.deriveVaultAddress(escrowPubkey.toBytes());
    expect(vaultAddr).not.toBe(escrowAddr);
  });

  it('vault address depends on escrow address', () => {
    const mgr = new EscrowManager();
    const escrow1 = Keypair.generate().publicKey.toBytes();
    const escrow2 = Keypair.generate().publicKey.toBytes();
    const v1 = mgr.deriveVaultAddress(escrow1);
    const v2 = mgr.deriveVaultAddress(escrow2);
    expect(v1.address).not.toBe(v2.address);
  });

  it('vault PDA uses correct seeds (matches manual findProgramAddressSync)', () => {
    const mgr = new EscrowManager();
    const programId = new PublicKey(DEFAULT_PROGRAM_ID);
    const escrowKey = Keypair.generate().publicKey.toBytes();

    const { address, bump } = mgr.deriveVaultAddress(escrowKey);

    const [expectedPda, expectedBump] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), escrowKey],
      programId,
    );
    expect(address).toBe(expectedPda.toBase58());
    expect(bump).toBe(expectedBump);
  });

  // ── Bump seed ────────────────────────────────────────────────────

  it('bump seed is in valid range [0, 255]', () => {
    const mgr = new EscrowManager();
    const buyer = Keypair.generate().publicKey.toBytes();
    const hash = randomBytes(32);
    const { bump: escrowBump } = mgr.deriveEscrowAddress(buyer, hash);
    const escrowPubkey = new PublicKey(mgr.deriveEscrowAddress(buyer, hash).address);
    const { bump: vaultBump } = mgr.deriveVaultAddress(escrowPubkey.toBytes());
    expect(escrowBump).toBeGreaterThanOrEqual(0);
    expect(escrowBump).toBeLessThanOrEqual(255);
    expect(vaultBump).toBeGreaterThanOrEqual(0);
    expect(vaultBump).toBeLessThanOrEqual(255);
  });

  // ── Input validation ──────────────────────────────────────────────

  it('deriveEscrowAddress throws on invalid buyer key length', () => {
    const mgr = new EscrowManager();
    const shortKey = new Uint8Array(16);
    const hash = randomBytes(32);
    expect(() => mgr.deriveEscrowAddress(shortKey, hash)).toThrow('Invalid buyer public key length');
  });

  it('deriveEscrowAddress throws on invalid agreement hash length', () => {
    const mgr = new EscrowManager();
    const buyer = Keypair.generate().publicKey.toBytes();
    const shortHash = new Uint8Array(16);
    expect(() => mgr.deriveEscrowAddress(buyer, shortHash)).toThrow('Invalid agreement hash length');
  });

  it('createEscrow throws on zero deposit amount', async () => {
    const mgr = new EscrowManager();
    const kp = Keypair.generate();
    await expect(mgr.createEscrow({
      agreement: {
        agreement_id: 'test',
        rfq_id: 'test',
        final_terms: { price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
        agreement_hash: 'a'.repeat(64),
        buyer_signature: 'sig',
        seller_signature: 'sig',
      },
      buyerKeypair: { publicKey: kp.publicKey.toBytes(), secretKey: kp.secretKey },
      sellerPublicKey: Keypair.generate().publicKey.toBytes(),
      depositAmount: 0n,
      mintAddress: Keypair.generate().publicKey.toBase58(),
      buyerTokenAccount: Keypair.generate().publicKey.toBase58(),
    })).rejects.toThrow('Deposit amount must be greater than zero');
  });

  it('createEscrow throws on invalid seller key length', async () => {
    const mgr = new EscrowManager();
    const kp = Keypair.generate();
    await expect(mgr.createEscrow({
      agreement: {
        agreement_id: 'test',
        rfq_id: 'test',
        final_terms: { price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
        agreement_hash: 'a'.repeat(64),
        buyer_signature: 'sig',
        seller_signature: 'sig',
      },
      buyerKeypair: { publicKey: kp.publicKey.toBytes(), secretKey: kp.secretKey },
      sellerPublicKey: new Uint8Array(16),
      depositAmount: 1000n,
      mintAddress: Keypair.generate().publicKey.toBase58(),
      buyerTokenAccount: Keypair.generate().publicKey.toBase58(),
    })).rejects.toThrow('Invalid seller public key length');
  });

  it('createEscrow throws on penalty rate exceeding 10000 bps', async () => {
    const mgr = new EscrowManager();
    const kp = Keypair.generate();
    await expect(mgr.createEscrow({
      agreement: {
        agreement_id: 'test',
        rfq_id: 'test',
        final_terms: { price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
        agreement_hash: 'a'.repeat(64),
        buyer_signature: 'sig',
        seller_signature: 'sig',
      },
      buyerKeypair: { publicKey: kp.publicKey.toBytes(), secretKey: kp.secretKey },
      sellerPublicKey: Keypair.generate().publicKey.toBytes(),
      depositAmount: 1000n,
      mintAddress: Keypair.generate().publicKey.toBase58(),
      buyerTokenAccount: Keypair.generate().publicKey.toBase58(),
      penaltyRateBps: 15000,
    })).rejects.toThrow('exceeds maximum 10000');
  });

  it('disputeEscrow throws on invalid evidence hash length', async () => {
    const mgr = new EscrowManager();
    const kp = Keypair.generate();
    await expect(mgr.disputeEscrow({
      escrowAddress: Keypair.generate().publicKey.toBase58(),
      buyerKeypair: { publicKey: kp.publicKey.toBytes(), secretKey: kp.secretKey },
      buyerTokenAccount: Keypair.generate().publicKey.toBase58(),
      sellerTokenAccount: Keypair.generate().publicKey.toBase58(),
      evidenceHash: new Uint8Array(16),
      penaltyAmount: 100n,
    })).rejects.toThrow('Invalid evidence hash length');
  });

  it('releaseEscrow throws on invalid verification hash length', async () => {
    const mgr = new EscrowManager();
    const kp = Keypair.generate();
    await expect(mgr.releaseEscrow({
      escrowAddress: Keypair.generate().publicKey.toBase58(),
      sellerKeypair: { publicKey: kp.publicKey.toBytes(), secretKey: kp.secretKey },
      sellerTokenAccount: Keypair.generate().publicKey.toBase58(),
      verificationHash: new Uint8Array(16),
    })).rejects.toThrow('Invalid verification hash length');
  });

  it('all errors thrown are OphirError instances', async () => {
    const mgr = new EscrowManager();
    try {
      mgr.deriveEscrowAddress(new Uint8Array(16), randomBytes(32));
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(OphirError);
    }
  });
});
