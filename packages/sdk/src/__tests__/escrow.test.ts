import { describe, it, expect } from 'vitest';
import { EscrowManager } from '../escrow.js';
import { PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { createHash } from 'node:crypto';

describe('EscrowManager', () => {
  describe('constructor defaults', () => {
    it('uses devnet RPC and default program ID when no config provided', () => {
      const mgr = new EscrowManager();
      expect(mgr).toBeInstanceOf(EscrowManager);
    });

    it('accepts custom rpcUrl and programId', () => {
      const mgr = new EscrowManager({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        programId: '11111111111111111111111111111111',
      });
      expect(mgr).toBeInstanceOf(EscrowManager);
    });
  });

  describe('PDA derivation', () => {
    it('deriveEscrowAddress is deterministic', () => {
      const mgr = new EscrowManager();
      const kp = nacl.sign.keyPair();
      const hash = createHash('sha256').update('test-agreement').digest();

      const addr1 = mgr.deriveEscrowAddress(kp.publicKey, hash);
      const addr2 = mgr.deriveEscrowAddress(kp.publicKey, hash);

      expect(addr1.address).toBe(addr2.address);
      expect(addr1.bump).toBe(addr2.bump);
      expect(typeof addr1.address).toBe('string');
      expect(addr1.address.length).toBeGreaterThan(0);
    });

    it('deriveVaultAddress is deterministic', () => {
      const mgr = new EscrowManager();
      const kp = nacl.sign.keyPair();
      const hash = createHash('sha256').update('test-agreement').digest();

      const { address: escrowAddr } = mgr.deriveEscrowAddress(kp.publicKey, hash);
      const escrowBytes = new PublicKey(escrowAddr).toBytes();

      const vault1 = mgr.deriveVaultAddress(escrowBytes);
      const vault2 = mgr.deriveVaultAddress(escrowBytes);

      expect(vault1.address).toBe(vault2.address);
      expect(vault1.bump).toBe(vault2.bump);
      expect(typeof vault1.address).toBe('string');
    });

    it('different buyers produce different PDAs', () => {
      const mgr = new EscrowManager();
      const kp1 = nacl.sign.keyPair();
      const kp2 = nacl.sign.keyPair();
      const hash = createHash('sha256').update('test-agreement').digest();

      const addr1 = mgr.deriveEscrowAddress(kp1.publicKey, hash);
      const addr2 = mgr.deriveEscrowAddress(kp2.publicKey, hash);

      expect(addr1.address).not.toBe(addr2.address);
    });

    it('different agreement hashes produce different PDAs', () => {
      const mgr = new EscrowManager();
      const kp = nacl.sign.keyPair();
      const hash1 = createHash('sha256').update('agreement-1').digest();
      const hash2 = createHash('sha256').update('agreement-2').digest();

      const addr1 = mgr.deriveEscrowAddress(kp.publicKey, hash1);
      const addr2 = mgr.deriveEscrowAddress(kp.publicKey, hash2);

      expect(addr1.address).not.toBe(addr2.address);
    });

    it('escrow and vault addresses differ for same keypair', () => {
      const mgr = new EscrowManager();
      const kp = nacl.sign.keyPair();
      const hash = createHash('sha256').update('test').digest();

      const { address: escrowAddr } = mgr.deriveEscrowAddress(kp.publicKey, hash);
      const { address: vaultAddr } = mgr.deriveVaultAddress(new PublicKey(escrowAddr).toBytes());

      expect(escrowAddr).not.toBe(vaultAddr);
    });

    it('PDA address is a valid base58 Solana address', () => {
      const mgr = new EscrowManager();
      const kp = nacl.sign.keyPair();
      const hash = createHash('sha256').update('validity-test').digest();

      const { address } = mgr.deriveEscrowAddress(kp.publicKey, hash);
      // Valid Solana address is 32-44 characters of base58
      expect(address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      // Must be parseable as a PublicKey
      expect(() => new PublicKey(address)).not.toThrow();
    });

    it('bump is a valid byte (0-255)', () => {
      const mgr = new EscrowManager();
      const kp = nacl.sign.keyPair();
      const hash = createHash('sha256').update('bump-test').digest();

      const { bump } = mgr.deriveEscrowAddress(kp.publicKey, hash);
      expect(bump).toBeGreaterThanOrEqual(0);
      expect(bump).toBeLessThanOrEqual(255);
      expect(Number.isInteger(bump)).toBe(true);
    });

    it('same program ID produces consistent PDA across manager instances', () => {
      const config = { programId: '11111111111111111111111111111111' };
      const mgr1 = new EscrowManager(config);
      const mgr2 = new EscrowManager(config);
      const kp = nacl.sign.keyPair();
      const hash = createHash('sha256').update('consistency').digest();

      const addr1 = mgr1.deriveEscrowAddress(kp.publicKey, hash);
      const addr2 = mgr2.deriveEscrowAddress(kp.publicKey, hash);

      expect(addr1.address).toBe(addr2.address);
      expect(addr1.bump).toBe(addr2.bump);
    });

    it('different program IDs produce different PDAs for same inputs', () => {
      const mgr1 = new EscrowManager({ programId: 'CHwqh23SpWSM6WLsd15iQcP4KSkB351S9eGcN4fQSVqy' });
      const mgr2 = new EscrowManager({ programId: '11111111111111111111111111111111' });
      const kp = nacl.sign.keyPair();
      const hash = createHash('sha256').update('program-diff').digest();

      const addr1 = mgr1.deriveEscrowAddress(kp.publicKey, hash);
      const addr2 = mgr2.deriveEscrowAddress(kp.publicKey, hash);

      expect(addr1.address).not.toBe(addr2.address);
    });
  });

  describe('input validation', () => {
    it('throws on invalid buyer public key length (too short)', () => {
      const mgr = new EscrowManager();
      const shortKey = new Uint8Array(16);
      const hash = createHash('sha256').update('test').digest();

      expect(() => mgr.deriveEscrowAddress(shortKey, hash)).toThrow(
        'Invalid buyer public key length: expected 32, got 16',
      );
    });

    it('throws on invalid buyer public key length (too long)', () => {
      const mgr = new EscrowManager();
      const longKey = new Uint8Array(64);
      const hash = createHash('sha256').update('test').digest();

      expect(() => mgr.deriveEscrowAddress(longKey, hash)).toThrow(
        'Invalid buyer public key length: expected 32, got 64',
      );
    });

    it('throws on invalid agreement hash length (too short)', () => {
      const mgr = new EscrowManager();
      const kp = nacl.sign.keyPair();
      const shortHash = new Uint8Array(16);

      expect(() => mgr.deriveEscrowAddress(kp.publicKey, shortHash)).toThrow(
        'Invalid agreement hash length: expected 32, got 16',
      );
    });

    it('throws on invalid agreement hash length (too long)', () => {
      const mgr = new EscrowManager();
      const kp = nacl.sign.keyPair();
      const longHash = new Uint8Array(64);

      expect(() => mgr.deriveEscrowAddress(kp.publicKey, longHash)).toThrow(
        'Invalid agreement hash length: expected 32, got 64',
      );
    });

    it('throws on empty buyer public key', () => {
      const mgr = new EscrowManager();
      const emptyKey = new Uint8Array(0);
      const hash = createHash('sha256').update('test').digest();

      expect(() => mgr.deriveEscrowAddress(emptyKey, hash)).toThrow(
        'Invalid buyer public key length: expected 32, got 0',
      );
    });

    it('throws on empty agreement hash', () => {
      const mgr = new EscrowManager();
      const kp = nacl.sign.keyPair();
      const emptyHash = new Uint8Array(0);

      expect(() => mgr.deriveEscrowAddress(kp.publicKey, emptyHash)).toThrow(
        'Invalid agreement hash length: expected 32, got 0',
      );
    });
  });

  describe('createEscrow input validation', () => {
    it('rejects zero deposit amount', async () => {
      const mgr = new EscrowManager();
      const buyerKp = nacl.sign.keyPair();
      const sellerKp = nacl.sign.keyPair();

      await expect(
        mgr.createEscrow({
          agreement: {
            agreement_id: 'test-id',
            rfq_id: 'rfq-id',
            accepting_message_id: 'quote-id',
            final_terms: { price_per_unit: '1', currency: 'USDC', unit: 'req' },
            agreement_hash: createHash('sha256').update('test').digest('hex'),
            buyer_signature: 'sig1',
            seller_signature: 'sig2',
          },
          buyerKeypair: buyerKp,
          sellerPublicKey: sellerKp.publicKey,
          depositAmount: 0n,
          mintAddress: 'So11111111111111111111111111111111111111112',
          buyerTokenAccount: 'So11111111111111111111111111111111111111112',
        }),
      ).rejects.toThrow('Deposit amount must be greater than zero');
    });

    it('rejects invalid seller public key length', async () => {
      const mgr = new EscrowManager();
      const buyerKp = nacl.sign.keyPair();

      await expect(
        mgr.createEscrow({
          agreement: {
            agreement_id: 'test-id',
            rfq_id: 'rfq-id',
            accepting_message_id: 'quote-id',
            final_terms: { price_per_unit: '1', currency: 'USDC', unit: 'req' },
            agreement_hash: createHash('sha256').update('test').digest('hex'),
            buyer_signature: 'sig1',
            seller_signature: 'sig2',
          },
          buyerKeypair: buyerKp,
          sellerPublicKey: new Uint8Array(16),
          depositAmount: 1000n,
          mintAddress: 'So11111111111111111111111111111111111111112',
          buyerTokenAccount: 'So11111111111111111111111111111111111111112',
        }),
      ).rejects.toThrow('Invalid seller public key length');
    });

    it('rejects penalty rate exceeding 10000 basis points', async () => {
      const mgr = new EscrowManager();
      const buyerKp = nacl.sign.keyPair();
      const sellerKp = nacl.sign.keyPair();

      await expect(
        mgr.createEscrow({
          agreement: {
            agreement_id: 'test-id',
            rfq_id: 'rfq-id',
            accepting_message_id: 'quote-id',
            final_terms: { price_per_unit: '1', currency: 'USDC', unit: 'req' },
            agreement_hash: createHash('sha256').update('test').digest('hex'),
            buyer_signature: 'sig1',
            seller_signature: 'sig2',
          },
          buyerKeypair: buyerKp,
          sellerPublicKey: sellerKp.publicKey,
          depositAmount: 1000n,
          mintAddress: 'So11111111111111111111111111111111111111112',
          buyerTokenAccount: 'So11111111111111111111111111111111111111112',
          penaltyRateBps: 15000,
        }),
      ).rejects.toThrow('exceeds maximum 10000 basis points');
    });

    it('rejects invalid agreement hash (not 64 hex chars)', async () => {
      const mgr = new EscrowManager();
      const buyerKp = nacl.sign.keyPair();
      const sellerKp = nacl.sign.keyPair();

      await expect(
        mgr.createEscrow({
          agreement: {
            agreement_id: 'test-id',
            rfq_id: 'rfq-id',
            accepting_message_id: 'quote-id',
            final_terms: { price_per_unit: '1', currency: 'USDC', unit: 'req' },
            agreement_hash: 'tooshort',
            buyer_signature: 'sig1',
            seller_signature: 'sig2',
          },
          buyerKeypair: buyerKp,
          sellerPublicKey: sellerKp.publicKey,
          depositAmount: 1000n,
          mintAddress: 'So11111111111111111111111111111111111111112',
          buyerTokenAccount: 'So11111111111111111111111111111111111111112',
        }),
      ).rejects.toThrow('Invalid agreement hash');
    });
  });

  describe('releaseEscrow input validation', () => {
    it('rejects invalid verification hash length', async () => {
      const mgr = new EscrowManager();
      const sellerKp = nacl.sign.keyPair();

      await expect(
        mgr.releaseEscrow({
          escrowAddress: '11111111111111111111111111111111',
          sellerKeypair: sellerKp,
          sellerTokenAccount: '11111111111111111111111111111111',
          verificationHash: new Uint8Array(16), // wrong length
        }),
      ).rejects.toThrow('Invalid verification hash length');
    });
  });

  describe('disputeEscrow input validation', () => {
    it('rejects invalid evidence hash length', async () => {
      const mgr = new EscrowManager();
      const buyerKp = nacl.sign.keyPair();

      await expect(
        mgr.disputeEscrow({
          escrowAddress: '11111111111111111111111111111111',
          buyerKeypair: buyerKp,
          buyerTokenAccount: '11111111111111111111111111111111',
          sellerTokenAccount: '11111111111111111111111111111111',
          evidenceHash: new Uint8Array(16), // wrong length
          penaltyAmount: 100n,
        }),
      ).rejects.toThrow('Invalid evidence hash length');
    });

    it('rejects negative penalty amount', async () => {
      const mgr = new EscrowManager();
      const buyerKp = nacl.sign.keyPair();

      await expect(
        mgr.disputeEscrow({
          escrowAddress: '11111111111111111111111111111111',
          buyerKeypair: buyerKp,
          buyerTokenAccount: '11111111111111111111111111111111',
          sellerTokenAccount: '11111111111111111111111111111111',
          evidenceHash: createHash('sha256').update('evidence').digest(),
          penaltyAmount: -1n,
        }),
      ).rejects.toThrow('Penalty amount cannot be negative');
    });
  });
});

describe('EscrowManager additional coverage', () => {
  describe('PDA determinism with known inputs', () => {
    it('same inputs always produce same escrow address', () => {
      const manager = new EscrowManager();
      const buyerKey = new Uint8Array(32).fill(1);
      const hash = new Uint8Array(32).fill(2);
      const result1 = manager.deriveEscrowAddress(buyerKey, hash);
      const result2 = manager.deriveEscrowAddress(buyerKey, hash);
      expect(result1.address).toBe(result2.address);
      expect(result1.bump).toBe(result2.bump);
    });

    it('same inputs always produce same vault address', () => {
      const manager = new EscrowManager();
      const escrowKey = new Uint8Array(32).fill(3);
      const result1 = manager.deriveVaultAddress(escrowKey);
      const result2 = manager.deriveVaultAddress(escrowKey);
      expect(result1.address).toBe(result2.address);
      expect(result1.bump).toBe(result2.bump);
    });

    it('all-zero buyer key produces valid PDA', () => {
      const manager = new EscrowManager();
      const result = manager.deriveEscrowAddress(new Uint8Array(32), new Uint8Array(32));
      expect(result.address).toBeTruthy();
      expect(typeof result.bump).toBe('number');
    });

    it('all-FF buyer key produces valid PDA', () => {
      const manager = new EscrowManager();
      const result = manager.deriveEscrowAddress(new Uint8Array(32).fill(0xFF), new Uint8Array(32).fill(0xFF));
      expect(result.address).toBeTruthy();
      expect(typeof result.bump).toBe('number');
    });
  });

  describe('escrow address uniqueness', () => {
    it('100 different buyer keys produce 100 different escrow addresses', () => {
      const manager = new EscrowManager();
      const hash = new Uint8Array(32).fill(0);
      const addresses = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const key = new Uint8Array(32);
        key[0] = i;
        addresses.add(manager.deriveEscrowAddress(key, hash).address);
      }
      expect(addresses.size).toBe(100);
    });

    it('100 different hashes produce 100 different escrow addresses', () => {
      const manager = new EscrowManager();
      const key = new Uint8Array(32).fill(0);
      const addresses = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const hash = new Uint8Array(32);
        hash[0] = i;
        addresses.add(manager.deriveEscrowAddress(key, hash).address);
      }
      expect(addresses.size).toBe(100);
    });
  });

  describe('createEscrow input validation completeness', () => {
    const validParams = {
      agreement: {
        agreement_id: 'test-agreement',
        rfq_id: 'test-rfq',
        accepting_message_id: 'quote-id',
        final_terms: { price_per_unit: '0.01', currency: 'USDC', unit: 'request' },
        agreement_hash: createHash('sha256').update('test').digest('hex'),
        buyer_signature: 'sig',
        seller_signature: 'sig',
      },
      buyerKeypair: nacl.sign.keyPair(),
      sellerPublicKey: nacl.sign.keyPair().publicKey,
      depositAmount: 1000000n,
      mintAddress: 'So11111111111111111111111111111111111111112',
      buyerTokenAccount: 'So11111111111111111111111111111111111111112',
    };

    it('rejects penaltyRateBps of exactly 10001', async () => {
      const manager = new EscrowManager();
      await expect(
        manager.createEscrow({ ...validParams, penaltyRateBps: 10001 }),
      ).rejects.toThrow('10000');
    });

    it('rejects agreement_hash that is not 64 hex chars', async () => {
      const manager = new EscrowManager();
      const badParams = {
        ...validParams,
        agreement: { ...validParams.agreement, agreement_hash: 'short' },
      };
      await expect(
        manager.createEscrow(badParams),
      ).rejects.toThrow('Invalid agreement hash');
    });
  });

  describe('disputeEscrow validation', () => {
    it('rejects zero-length evidence hash', async () => {
      const manager = new EscrowManager();
      const buyerKp = nacl.sign.keyPair();
      await expect(
        manager.disputeEscrow({
          escrowAddress: '11111111111111111111111111111111',
          buyerKeypair: buyerKp,
          buyerTokenAccount: '11111111111111111111111111111111',
          sellerTokenAccount: '11111111111111111111111111111111',
          evidenceHash: new Uint8Array(0),
          penaltyAmount: 100n,
        }),
      ).rejects.toThrow('evidence hash');
    });

    it('rejects 64-byte evidence hash (too long)', async () => {
      const manager = new EscrowManager();
      const buyerKp = nacl.sign.keyPair();
      await expect(
        manager.disputeEscrow({
          escrowAddress: '11111111111111111111111111111111',
          buyerKeypair: buyerKp,
          buyerTokenAccount: '11111111111111111111111111111111',
          sellerTokenAccount: '11111111111111111111111111111111',
          evidenceHash: new Uint8Array(64),
          penaltyAmount: 100n,
        }),
      ).rejects.toThrow('evidence hash');
    });
  });
});
