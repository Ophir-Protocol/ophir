import * as anchor from "@coral-xyz/anchor";
import { Program, BN, AnchorError } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint,
  createAccount as createTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";
import { OphirEscrow } from "../target/types/ophir_escrow";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROGRAM_ID = new PublicKey(
  "Bcvw9tYGPu7M9hx7YRatv4GLz9Kv2BtZUckaoUgKfUFA"
);

function randomAgreementHash(): number[] {
  return Array.from(Keypair.generate().secretKey.slice(0, 32));
}

function deriveEscrowPda(
  buyer: PublicKey,
  agreementHash: number[]
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("escrow"),
      buyer.toBuffer(),
      Buffer.from(Uint8Array.from(agreementHash)),
    ],
    PROGRAM_ID
  );
}

function deriveVaultPda(escrow: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), escrow.toBuffer()],
    PROGRAM_ID
  );
}

async function fundAccount(
  connection: anchor.web3.Connection,
  to: PublicKey,
  sol: number = 0.05,
  payer?: Keypair
): Promise<void> {
  if (!payer) {
    const fs = await import("fs");
    const walletPath = "/home/cryptalis/Ironq_test/test-wallet.json";
    const secretKey = Uint8Array.from(
      JSON.parse(fs.readFileSync(walletPath, "utf-8"))
    );
    payer = Keypair.fromSecretKey(secretKey);
  }
  const tx = new anchor.web3.Transaction().add(
    anchor.web3.SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: to,
      lamports: Math.floor(sol * LAMPORTS_PER_SOL),
    })
  );
  await anchor.web3.sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: "confirmed",
  });
}

async function setupTestAccounts(
  provider: anchor.AnchorProvider,
  mintDecimals: number = 6,
  mintAmount: bigint = 1_000_000n
): Promise<{
  mint: PublicKey;
  buyer: Keypair;
  seller: Keypair;
  arbiter: Keypair;
  buyerTokenAccount: PublicKey;
  sellerTokenAccount: PublicKey;
}> {
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const buyer = Keypair.generate();
  const seller = Keypair.generate();
  const arbiter = Keypair.generate();

  await fundAccount(connection, buyer.publicKey, 0.1);

  const mint = await createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    mintDecimals,
    undefined,
    { commitment: "confirmed" }
  );

  const buyerTokenAccount = await createTokenAccount(
    connection,
    payer,
    mint,
    buyer.publicKey,
    undefined,
    { commitment: "confirmed" }
  );

  const sellerTokenAccount = await createTokenAccount(
    connection,
    payer,
    mint,
    seller.publicKey,
    undefined,
    { commitment: "confirmed" }
  );

  await mintTo(
    connection,
    payer,
    mint,
    buyerTokenAccount,
    payer.publicKey,
    mintAmount,
    [],
    { commitment: "confirmed" }
  );

  return { mint, buyer, seller, arbiter, buyerTokenAccount, sellerTokenAccount };
}

async function createEscrow(
  program: Program<OphirEscrow>,
  buyer: Keypair,
  seller: Keypair,
  arbiter: Keypair,
  mint: PublicKey,
  buyerTokenAccount: PublicKey,
  depositAmount: BN,
  timeoutSlots: BN,
  penaltyRateBps: number,
  agreementHash?: number[]
): Promise<{
  escrowPda: PublicKey;
  vaultPda: PublicKey;
  agreementHash: number[];
  escrowBump: number;
}> {
  const hash = agreementHash ?? randomAgreementHash();
  const [escrowPda, escrowBump] = deriveEscrowPda(buyer.publicKey, hash);
  const [vaultPda] = deriveVaultPda(escrowPda);

  await program.methods
    .makeEscrow(hash, depositAmount, timeoutSlots, penaltyRateBps)
    .accountsStrict({
      buyer: buyer.publicKey,
      seller: seller.publicKey,
      arbiter: arbiter.publicKey,
      escrow: escrowPda,
      vault: vaultPda,
      buyerTokenAccount,
      mint,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .signers([buyer])
    .rpc({ commitment: "confirmed" });

  return { escrowPda, vaultPda, agreementHash: hash, escrowBump };
}

function extractErrorCode(error: unknown): number | null {
  if (error instanceof AnchorError) {
    return error.error.errorCode.number;
  }
  const msg = String(error);
  const match = msg.match(/custom program error: 0x([0-9a-fA-F]+)/);
  if (match) {
    return parseInt(match[1], 16);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Ophir Escrow — Devnet Integration Tests (v2: Arbiter + Security)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ophirEscrow as Program<OphirEscrow>;
  const connection = provider.connection;

  // Error code constants (v2 with new errors)
  const ERR_ESCROW_NOT_ACTIVE = 6000;
  const ERR_TIMEOUT_NOT_REACHED = 6001;
  const ERR_PENALTY_EXCEEDS_MAX = 6002;
  const ERR_INVALID_DEPOSIT = 6003;
  const ERR_INVALID_TIMEOUT = 6004;
  const ERR_TIMEOUT_TOO_SHORT = 6005;
  const ERR_TIMEOUT_TOO_LONG = 6006;
  const ERR_INVALID_PENALTY_RATE = 6007;
  const ERR_INVALID_SELLER = 6008;
  const ERR_UNAUTHORIZED = 6009;
  const ERR_INVALID_MINT = 6010;
  const ERR_ARITHMETIC_OVERFLOW = 6011;
  const ERR_BUYER_CANNOT_BE_SELLER = 6012;
  const ERR_INVALID_ARBITER = 6013;
  const ERR_DISPUTE_COOLDOWN_NOT_MET = 6014;

  // =========================================================================
  // 1. HAPPY PATH — Full Lifecycle (make -> release)
  // =========================================================================
  describe("1. Happy Path — Full Lifecycle (make -> release)", () => {
    let mint: PublicKey;
    let buyer: Keypair;
    let seller: Keypair;
    let arbiter: Keypair;
    let buyerTokenAccount: PublicKey;
    let sellerTokenAccount: PublicKey;
    let escrowPda: PublicKey;
    let vaultPda: PublicKey;
    let agreementHash: number[];
    const depositAmount = new BN(500_000);
    const timeoutSlots = new BN(1_000_000);
    const penaltyRateBps = 500; // 5%

    before(async () => {
      const accounts = await setupTestAccounts(provider, 6, 1_000_000n);
      mint = accounts.mint;
      buyer = accounts.buyer;
      seller = accounts.seller;
      arbiter = accounts.arbiter;
      buyerTokenAccount = accounts.buyerTokenAccount;
      sellerTokenAccount = accounts.sellerTokenAccount;
    });

    it("make_escrow: buyer deposits tokens with arbiter", async () => {
      const result = await createEscrow(
        program, buyer, seller, arbiter, mint, buyerTokenAccount,
        depositAmount, timeoutSlots, penaltyRateBps
      );
      escrowPda = result.escrowPda;
      vaultPda = result.vaultPda;
      agreementHash = result.agreementHash;
    });

    it("verify escrow account state includes arbiter", async () => {
      const escrow = await program.account.escrowAccount.fetch(escrowPda);
      expect(escrow.buyer.toBase58()).to.equal(buyer.publicKey.toBase58());
      expect(escrow.seller.toBase58()).to.equal(seller.publicKey.toBase58());
      expect(escrow.arbiter.toBase58()).to.equal(arbiter.publicKey.toBase58());
      expect(escrow.mint.toBase58()).to.equal(mint.toBase58());
      expect(Array.from(escrow.agreementHash)).to.deep.equal(agreementHash);
      expect(escrow.depositAmount.toNumber()).to.equal(500_000);
      expect(escrow.penaltyRateBps).to.equal(500);
      expect(escrow.status).to.deep.equal({ active: {} });
      expect(escrow.createdSlot.toNumber()).to.be.greaterThan(0);
    });

    it("verify vault holds correct token balance", async () => {
      const vaultAccount = await getAccount(connection, vaultPda, "confirmed");
      expect(Number(vaultAccount.amount)).to.equal(500_000);
    });

    it("release_escrow: seller claims funds", async () => {
      await fundAccount(connection, seller.publicKey, 0.05);
      await program.methods
        .releaseEscrow(null)
        .accountsStrict({
          seller: seller.publicKey,
          buyer: buyer.publicKey,
          escrow: escrowPda,
          vault: vaultPda,
          sellerTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([seller])
        .rpc({ commitment: "confirmed" });
    });

    it("verify seller received funds and accounts closed", async () => {
      const sellerAccount = await getAccount(connection, sellerTokenAccount, "confirmed");
      expect(Number(sellerAccount.amount)).to.equal(500_000);
      const escrowInfo = await connection.getAccountInfo(escrowPda);
      expect(escrowInfo).to.be.null;
      const vaultInfo = await connection.getAccountInfo(vaultPda);
      expect(vaultInfo).to.be.null;
    });
  });

  // =========================================================================
  // 2. DISPUTE FLOW — Requires arbiter co-sign
  // =========================================================================
  describe("2. Dispute Flow (arbiter co-signed)", () => {
    let mint: PublicKey;
    let buyer: Keypair;
    let seller: Keypair;
    let arbiter: Keypair;
    let buyerTokenAccount: PublicKey;
    let sellerTokenAccount: PublicKey;
    let escrowPda: PublicKey;
    let vaultPda: PublicKey;
    const depositAmount = new BN(1_000_000);
    const timeoutSlots = new BN(1_000_000);
    const penaltyRateBps = 2000; // 20%

    before(async () => {
      const accounts = await setupTestAccounts(provider, 6, 2_000_000n);
      mint = accounts.mint;
      buyer = accounts.buyer;
      seller = accounts.seller;
      arbiter = accounts.arbiter;
      buyerTokenAccount = accounts.buyerTokenAccount;
      sellerTokenAccount = accounts.sellerTokenAccount;

      const result = await createEscrow(
        program, buyer, seller, arbiter, mint, buyerTokenAccount,
        depositAmount, timeoutSlots, penaltyRateBps
      );
      escrowPda = result.escrowPda;
      vaultPda = result.vaultPda;
    });

    it("dispute_escrow: buyer + arbiter co-sign dispute after cooldown", async () => {
      // Wait for dispute cooldown (450 slots ~ 3 min)
      await new Promise((resolve) => setTimeout(resolve, 190000));

      await fundAccount(connection, arbiter.publicKey, 0.05);

      const penaltyAmount = new BN(200_000); // max = 1M * 2000/10000 = 200K
      const evidenceHash = randomAgreementHash();

      await program.methods
        .disputeEscrow(evidenceHash, penaltyAmount)
        .accountsStrict({
          buyer: buyer.publicKey,
          arbiter: arbiter.publicKey,
          escrow: escrowPda,
          vault: vaultPda,
          buyerTokenAccount,
          sellerTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([buyer, arbiter])
        .rpc({ commitment: "confirmed" });
    });

    it("verify penalty returned to buyer", async () => {
      const buyerAccount = await getAccount(connection, buyerTokenAccount, "confirmed");
      expect(Number(buyerAccount.amount)).to.equal(1_200_000);
    });

    it("verify remainder sent to seller", async () => {
      const sellerAccount = await getAccount(connection, sellerTokenAccount, "confirmed");
      expect(Number(sellerAccount.amount)).to.equal(800_000);
    });

    it("verify accounts closed after dispute", async () => {
      const escrowInfo = await connection.getAccountInfo(escrowPda);
      expect(escrowInfo).to.be.null;
      const vaultInfo = await connection.getAccountInfo(vaultPda);
      expect(vaultInfo).to.be.null;
    });
  });

  // =========================================================================
  // 3. CANCEL FLOW (timeout)
  // =========================================================================
  describe("3. Cancel Flow (after timeout)", () => {
    let mint: PublicKey;
    let buyer: Keypair;
    let seller: Keypair;
    let arbiter: Keypair;
    let buyerTokenAccount: PublicKey;
    let escrowPda: PublicKey;
    let vaultPda: PublicKey;
    const depositAmount = new BN(500_000);
    const timeoutSlots = new BN(100); // minimum
    const penaltyRateBps = 500;

    before(async () => {
      const accounts = await setupTestAccounts(provider, 6, 1_000_000n);
      mint = accounts.mint;
      buyer = accounts.buyer;
      seller = accounts.seller;
      arbiter = accounts.arbiter;
      buyerTokenAccount = accounts.buyerTokenAccount;

      const result = await createEscrow(
        program, buyer, seller, arbiter, mint, buyerTokenAccount,
        depositAmount, timeoutSlots, penaltyRateBps
      );
      escrowPda = result.escrowPda;
      vaultPda = result.vaultPda;
    });

    it("cancel_escrow: buyer cancels after timeout", async () => {
      await new Promise((resolve) => setTimeout(resolve, 50000));

      await program.methods
        .cancelEscrow()
        .accountsStrict({
          buyer: buyer.publicKey,
          escrow: escrowPda,
          vault: vaultPda,
          buyerTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([buyer])
        .rpc({ commitment: "confirmed" });
    });

    it("verify buyer got full refund and accounts closed", async () => {
      const buyerAccount = await getAccount(connection, buyerTokenAccount, "confirmed");
      expect(Number(buyerAccount.amount)).to.equal(1_000_000);
      const escrowInfo = await connection.getAccountInfo(escrowPda);
      expect(escrowInfo).to.be.null;
      const vaultInfo = await connection.getAccountInfo(vaultPda);
      expect(vaultInfo).to.be.null;
    });
  });

  // =========================================================================
  // 4. SECURITY / NEGATIVE TESTS
  // =========================================================================
  describe("4. Security / Negative Tests", () => {
    // 4a. Dispute WITHOUT arbiter co-sign
    describe("4a. Dispute without arbiter fails", () => {
      let buyer: Keypair, seller: Keypair, arbiter: Keypair;
      let mint: PublicKey, buyerTokenAccount: PublicKey, sellerTokenAccount: PublicKey;
      let escrowPda: PublicKey, vaultPda: PublicKey;

      before(async () => {
        const accounts = await setupTestAccounts(provider, 6, 1_000_000n);
        mint = accounts.mint; buyer = accounts.buyer;
        seller = accounts.seller; arbiter = accounts.arbiter;
        buyerTokenAccount = accounts.buyerTokenAccount;
        sellerTokenAccount = accounts.sellerTokenAccount;

        const result = await createEscrow(
          program, buyer, seller, arbiter, mint, buyerTokenAccount,
          new BN(100_000), new BN(1_000_000), 500
        );
        escrowPda = result.escrowPda;
        vaultPda = result.vaultPda;
      });

      it("should fail when wrong arbiter tries to co-sign dispute", async () => {
        const fakeArbiter = Keypair.generate();
        await fundAccount(connection, fakeArbiter.publicKey, 0.05);

        // Wait for cooldown
        await new Promise((resolve) => setTimeout(resolve, 190000));

        try {
          await program.methods
            .disputeEscrow(randomAgreementHash(), new BN(5000))
            .accountsStrict({
              buyer: buyer.publicKey,
              arbiter: fakeArbiter.publicKey,
              escrow: escrowPda,
              vault: vaultPda,
              buyerTokenAccount,
              sellerTokenAccount,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([buyer, fakeArbiter])
            .rpc({ commitment: "confirmed" });
          expect.fail("Should have thrown an error");
        } catch (err) {
          const code = extractErrorCode(err);
          if (code !== null) {
            expect(code).to.equal(ERR_INVALID_ARBITER);
          }
        }
      });
    });

    // 4b. Dispute before cooldown
    describe("4b. Dispute before cooldown fails", () => {
      let buyer: Keypair, seller: Keypair, arbiter: Keypair;
      let mint: PublicKey, buyerTokenAccount: PublicKey, sellerTokenAccount: PublicKey;
      let escrowPda: PublicKey, vaultPda: PublicKey;

      before(async () => {
        const accounts = await setupTestAccounts(provider, 6, 1_000_000n);
        mint = accounts.mint; buyer = accounts.buyer;
        seller = accounts.seller; arbiter = accounts.arbiter;
        buyerTokenAccount = accounts.buyerTokenAccount;
        sellerTokenAccount = accounts.sellerTokenAccount;
        await fundAccount(connection, arbiter.publicKey, 0.05);

        const result = await createEscrow(
          program, buyer, seller, arbiter, mint, buyerTokenAccount,
          new BN(100_000), new BN(1_000_000), 500
        );
        escrowPda = result.escrowPda;
        vaultPda = result.vaultPda;
      });

      it("should fail with DisputeCooldownNotMet", async () => {
        // Try immediately — cooldown is 450 slots (~3 min)
        try {
          await program.methods
            .disputeEscrow(randomAgreementHash(), new BN(5000))
            .accountsStrict({
              buyer: buyer.publicKey,
              arbiter: arbiter.publicKey,
              escrow: escrowPda,
              vault: vaultPda,
              buyerTokenAccount,
              sellerTokenAccount,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([buyer, arbiter])
            .rpc({ commitment: "confirmed" });
          expect.fail("Should have thrown an error");
        } catch (err) {
          const code = extractErrorCode(err);
          expect(code).to.equal(ERR_DISPUTE_COOLDOWN_NOT_MET);
        }
      });
    });

    // 4c. Buyer == Seller (self-dealing)
    describe("4c. Buyer cannot be seller", () => {
      it("should fail with BuyerCannotBeSeller", async () => {
        const accounts = await setupTestAccounts(provider, 6, 1_000_000n);
        const agreementHash = randomAgreementHash();
        const [escrowPda] = deriveEscrowPda(accounts.buyer.publicKey, agreementHash);
        const [vaultPda] = deriveVaultPda(escrowPda);

        try {
          await program.methods
            .makeEscrow(agreementHash, new BN(100_000), new BN(1000), 500)
            .accountsStrict({
              buyer: accounts.buyer.publicKey,
              seller: accounts.buyer.publicKey, // same as buyer!
              arbiter: accounts.arbiter.publicKey,
              escrow: escrowPda,
              vault: vaultPda,
              buyerTokenAccount: accounts.buyerTokenAccount,
              mint: accounts.mint,
              systemProgram: SystemProgram.programId,
              tokenProgram: TOKEN_PROGRAM_ID,
              rent: SYSVAR_RENT_PUBKEY,
            })
            .signers([accounts.buyer])
            .rpc({ commitment: "confirmed" });
          expect.fail("Should have thrown an error");
        } catch (err) {
          const code = extractErrorCode(err);
          expect(code).to.equal(ERR_BUYER_CANNOT_BE_SELLER);
        }
      });
    });

    // 4d. Penalty rate > 5000 (50%)
    describe("4d. Penalty rate capped at 50%", () => {
      it("should fail with InvalidPenaltyRate for > 5000 bps", async () => {
        const accounts = await setupTestAccounts(provider, 6, 1_000_000n);
        const agreementHash = randomAgreementHash();
        const [escrowPda] = deriveEscrowPda(accounts.buyer.publicKey, agreementHash);
        const [vaultPda] = deriveVaultPda(escrowPda);

        try {
          await program.methods
            .makeEscrow(agreementHash, new BN(100_000), new BN(1000), 5001)
            .accountsStrict({
              buyer: accounts.buyer.publicKey,
              seller: accounts.seller.publicKey,
              arbiter: accounts.arbiter.publicKey,
              escrow: escrowPda,
              vault: vaultPda,
              buyerTokenAccount: accounts.buyerTokenAccount,
              mint: accounts.mint,
              systemProgram: SystemProgram.programId,
              tokenProgram: TOKEN_PROGRAM_ID,
              rent: SYSVAR_RENT_PUBKEY,
            })
            .signers([accounts.buyer])
            .rpc({ commitment: "confirmed" });
          expect.fail("Should have thrown an error");
        } catch (err) {
          const code = extractErrorCode(err);
          expect(code).to.equal(ERR_INVALID_PENALTY_RATE);
        }
      });
    });

    // 4e. Release by wrong seller
    describe("4e. Release by wrong seller fails", () => {
      let buyer: Keypair, seller: Keypair, arbiter: Keypair, mint: PublicKey;
      let buyerTokenAccount: PublicKey, sellerTokenAccount: PublicKey;
      let escrowPda: PublicKey, vaultPda: PublicKey;

      before(async () => {
        const accounts = await setupTestAccounts(provider, 6, 1_000_000n);
        mint = accounts.mint; buyer = accounts.buyer;
        seller = accounts.seller; arbiter = accounts.arbiter;
        buyerTokenAccount = accounts.buyerTokenAccount;
        sellerTokenAccount = accounts.sellerTokenAccount;

        const result = await createEscrow(
          program, buyer, seller, arbiter, mint, buyerTokenAccount,
          new BN(100_000), new BN(1_000_000), 500
        );
        escrowPda = result.escrowPda;
        vaultPda = result.vaultPda;
      });

      it("should fail when wrong seller tries to release", async () => {
        const wrongSeller = Keypair.generate();
        await fundAccount(connection, wrongSeller.publicKey, 0.05);
        const payer = (provider.wallet as anchor.Wallet).payer;
        const wrongSellerTokenAccount = await createTokenAccount(
          connection, payer, mint, wrongSeller.publicKey, undefined,
          { commitment: "confirmed" }
        );

        try {
          await program.methods
            .releaseEscrow(null)
            .accountsStrict({
              seller: wrongSeller.publicKey,
              buyer: buyer.publicKey,
              escrow: escrowPda,
              vault: vaultPda,
              sellerTokenAccount: wrongSellerTokenAccount,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([wrongSeller])
            .rpc({ commitment: "confirmed" });
          expect.fail("Should have thrown an error");
        } catch (err) {
          expect(err).to.exist;
        }
      });
    });

    // 4f. Cancel before timeout
    describe("4f. Cancel before timeout fails", () => {
      let buyer: Keypair, seller: Keypair, arbiter: Keypair;
      let buyerTokenAccount: PublicKey, escrowPda: PublicKey, vaultPda: PublicKey;

      before(async () => {
        const accounts = await setupTestAccounts(provider, 6, 1_000_000n);
        buyer = accounts.buyer; seller = accounts.seller; arbiter = accounts.arbiter;
        buyerTokenAccount = accounts.buyerTokenAccount;

        const result = await createEscrow(
          program, buyer, seller, arbiter, accounts.mint, buyerTokenAccount,
          new BN(100_000), new BN(1_000_000), 500
        );
        escrowPda = result.escrowPda;
        vaultPda = result.vaultPda;
      });

      it("should fail with TimeoutNotReached", async () => {
        try {
          await program.methods
            .cancelEscrow()
            .accountsStrict({
              buyer: buyer.publicKey,
              escrow: escrowPda,
              vault: vaultPda,
              buyerTokenAccount,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([buyer])
            .rpc({ commitment: "confirmed" });
          expect.fail("Should have thrown an error");
        } catch (err) {
          const code = extractErrorCode(err);
          expect(code).to.equal(ERR_TIMEOUT_NOT_REACHED);
        }
      });
    });

    // 4g. Zero deposit
    describe("4g. Zero deposit fails", () => {
      it("should fail with InvalidDeposit", async () => {
        const accounts = await setupTestAccounts(provider, 6, 1_000_000n);
        const agreementHash = randomAgreementHash();
        const [escrowPda] = deriveEscrowPda(accounts.buyer.publicKey, agreementHash);
        const [vaultPda] = deriveVaultPda(escrowPda);

        try {
          await program.methods
            .makeEscrow(agreementHash, new BN(0), new BN(1000), 500)
            .accountsStrict({
              buyer: accounts.buyer.publicKey,
              seller: accounts.seller.publicKey,
              arbiter: accounts.arbiter.publicKey,
              escrow: escrowPda,
              vault: vaultPda,
              buyerTokenAccount: accounts.buyerTokenAccount,
              mint: accounts.mint,
              systemProgram: SystemProgram.programId,
              tokenProgram: TOKEN_PROGRAM_ID,
              rent: SYSVAR_RENT_PUBKEY,
            })
            .signers([accounts.buyer])
            .rpc({ commitment: "confirmed" });
          expect.fail("Should have thrown an error");
        } catch (err) {
          const code = extractErrorCode(err);
          expect(code).to.equal(ERR_INVALID_DEPOSIT);
        }
      });
    });

    // 4h. Penalty exceeding max
    describe("4h. Penalty exceeding max fails", () => {
      let buyer: Keypair, seller: Keypair, arbiter: Keypair;
      let buyerTokenAccount: PublicKey, sellerTokenAccount: PublicKey;
      let escrowPda: PublicKey, vaultPda: PublicKey;

      before(async () => {
        const accounts = await setupTestAccounts(provider, 6, 1_000_000n);
        buyer = accounts.buyer; seller = accounts.seller; arbiter = accounts.arbiter;
        buyerTokenAccount = accounts.buyerTokenAccount;
        sellerTokenAccount = accounts.sellerTokenAccount;
        await fundAccount(connection, arbiter.publicKey, 0.05);

        const result = await createEscrow(
          program, buyer, seller, arbiter, accounts.mint, buyerTokenAccount,
          new BN(1_000_000), new BN(1_000_000), 500 // 5% => max 50K
        );
        escrowPda = result.escrowPda;
        vaultPda = result.vaultPda;
      });

      it("should fail with PenaltyExceedsMax", async () => {
        // Wait for cooldown
        await new Promise((resolve) => setTimeout(resolve, 190000));

        try {
          await program.methods
            .disputeEscrow(randomAgreementHash(), new BN(100_000)) // 100K > 50K
            .accountsStrict({
              buyer: buyer.publicKey,
              arbiter: arbiter.publicKey,
              escrow: escrowPda,
              vault: vaultPda,
              buyerTokenAccount,
              sellerTokenAccount,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([buyer, arbiter])
            .rpc({ commitment: "confirmed" });
          expect.fail("Should have thrown an error");
        } catch (err) {
          const code = extractErrorCode(err);
          expect(code).to.equal(ERR_PENALTY_EXCEEDS_MAX);
        }
      });
    });

    // 4i. Timeout bounds
    describe("4i. Timeout bounds enforcement", () => {
      it("should fail with TimeoutTooShort for < 100", async () => {
        const accounts = await setupTestAccounts(provider, 6, 1_000_000n);
        const agreementHash = randomAgreementHash();
        const [escrowPda] = deriveEscrowPda(accounts.buyer.publicKey, agreementHash);
        const [vaultPda] = deriveVaultPda(escrowPda);

        try {
          await program.methods
            .makeEscrow(agreementHash, new BN(100_000), new BN(50), 500)
            .accountsStrict({
              buyer: accounts.buyer.publicKey,
              seller: accounts.seller.publicKey,
              arbiter: accounts.arbiter.publicKey,
              escrow: escrowPda,
              vault: vaultPda,
              buyerTokenAccount: accounts.buyerTokenAccount,
              mint: accounts.mint,
              systemProgram: SystemProgram.programId,
              tokenProgram: TOKEN_PROGRAM_ID,
              rent: SYSVAR_RENT_PUBKEY,
            })
            .signers([accounts.buyer])
            .rpc({ commitment: "confirmed" });
          expect.fail("Should have thrown an error");
        } catch (err) {
          const code = extractErrorCode(err);
          expect(code).to.equal(ERR_TIMEOUT_TOO_SHORT);
        }
      });
    });
  });

  // =========================================================================
  // 5. EDGE CASES
  // =========================================================================
  describe("5. Edge Cases", () => {
    // 5a. Max penalty rate at new cap (50%)
    describe("5a. Max penalty rate at 50% cap", () => {
      it("create escrow with 5000 bps (50%) succeeds", async () => {
        const accounts = await setupTestAccounts(provider, 6, 1_000_000n);
        const result = await createEscrow(
          program, accounts.buyer, accounts.seller, accounts.arbiter,
          accounts.mint, accounts.buyerTokenAccount,
          new BN(100_000), new BN(1_000_000), 5000 // 50% max
        );
        const escrow = await program.account.escrowAccount.fetch(result.escrowPda);
        expect(escrow.penaltyRateBps).to.equal(5000);
      });
    });

    // 5b. Dispute with zero penalty
    describe("5b. Dispute with zero penalty", () => {
      let buyer: Keypair, seller: Keypair, arbiter: Keypair;
      let buyerTokenAccount: PublicKey, sellerTokenAccount: PublicKey;
      let escrowPda: PublicKey, vaultPda: PublicKey;

      before(async () => {
        const accounts = await setupTestAccounts(provider, 6, 1_000_000n);
        buyer = accounts.buyer; seller = accounts.seller; arbiter = accounts.arbiter;
        buyerTokenAccount = accounts.buyerTokenAccount;
        sellerTokenAccount = accounts.sellerTokenAccount;
        await fundAccount(connection, arbiter.publicKey, 0.05);

        const result = await createEscrow(
          program, buyer, seller, arbiter, accounts.mint, buyerTokenAccount,
          new BN(500_000), new BN(1_000_000), 1000
        );
        escrowPda = result.escrowPda;
        vaultPda = result.vaultPda;
      });

      it("dispute with zero penalty sends all to seller", async () => {
        // Wait for cooldown
        await new Promise((resolve) => setTimeout(resolve, 190000));

        await program.methods
          .disputeEscrow(randomAgreementHash(), new BN(0))
          .accountsStrict({
            buyer: buyer.publicKey,
            arbiter: arbiter.publicKey,
            escrow: escrowPda,
            vault: vaultPda,
            buyerTokenAccount,
            sellerTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([buyer, arbiter])
          .rpc({ commitment: "confirmed" });

        const sellerAccount = await getAccount(connection, sellerTokenAccount, "confirmed");
        expect(Number(sellerAccount.amount)).to.equal(500_000);
      });
    });

    // 5c. Release with verification hash
    describe("5c. Release with verification hash", () => {
      let buyer: Keypair, seller: Keypair, arbiter: Keypair;
      let sellerTokenAccount: PublicKey;
      let escrowPda: PublicKey, vaultPda: PublicKey;

      before(async () => {
        const accounts = await setupTestAccounts(provider, 6, 1_000_000n);
        buyer = accounts.buyer; seller = accounts.seller; arbiter = accounts.arbiter;
        sellerTokenAccount = accounts.sellerTokenAccount;
        await fundAccount(connection, seller.publicKey, 0.05);

        const result = await createEscrow(
          program, buyer, seller, arbiter, accounts.mint, accounts.buyerTokenAccount,
          new BN(100_000), new BN(1_000_000), 500
        );
        escrowPda = result.escrowPda;
        vaultPda = result.vaultPda;
      });

      it("release with verification hash succeeds", async () => {
        await program.methods
          .releaseEscrow(randomAgreementHash())
          .accountsStrict({
            seller: seller.publicKey,
            buyer: buyer.publicKey,
            escrow: escrowPda,
            vault: vaultPda,
            sellerTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([seller])
          .rpc({ commitment: "confirmed" });

        const sellerAccount = await getAccount(connection, sellerTokenAccount, "confirmed");
        expect(Number(sellerAccount.amount)).to.equal(100_000);
      });
    });

    // 5d. Minimum timeout boundary
    describe("5d. Minimum timeout boundary", () => {
      it("create escrow with exactly 100 timeout_slots succeeds", async () => {
        const accounts = await setupTestAccounts(provider, 6, 1_000_000n);
        const result = await createEscrow(
          program, accounts.buyer, accounts.seller, accounts.arbiter,
          accounts.mint, accounts.buyerTokenAccount,
          new BN(100_000), new BN(100), 500
        );
        const escrow = await program.account.escrowAccount.fetch(result.escrowPda);
        expect(escrow.status).to.deep.equal({ active: {} });
      });
    });
  });
});
