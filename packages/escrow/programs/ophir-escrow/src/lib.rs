//! # Ophir Escrow Program
//!
//! A Solana Anchor program that implements a two-party escrow for negotiated
//! service agreements. A **buyer** deposits SPL tokens into a program-owned
//! vault, and a **seller** can later claim those tokens upon fulfillment, or
//! the buyer can dispute or cancel the escrow under defined conditions.
//!
//! ## Lifecycle
//!
//! ```text
//! make_escrow (buyer)
//!       |
//!       v
//!    [Active]
//!    /   |   \
//!   v    v    v
//! release  dispute  cancel
//! (seller) (buyer)  (buyer, after timeout)
//!   |        |        |
//!   v        v        v
//! [Released] [Disputed] [Cancelled]
//! ```
//!
//! ## PDA Seed Scheme
//!
//! | Account  | Seeds                                          |
//! |----------|------------------------------------------------|
//! | Escrow   | `["escrow", buyer_pubkey, agreement_hash]`     |
//! | Vault    | `["vault", escrow_pubkey]`                     |
//!
//! The escrow PDA is derived from the buyer's public key and the SHA-256 hash
//! of the canonicalized agreement terms, ensuring a unique escrow per
//! buyer-agreement pair. The vault is a token account whose authority is the
//! escrow PDA, derived from the escrow's own address.
//!
//! ## Security Model
//!
//! - **Signer checks**: Every state-changing instruction requires the
//!   appropriate party (buyer or seller) to sign the transaction.
//! - **Status guards**: All instructions that mutate an escrow enforce
//!   `status == Active` via Anchor constraints, preventing double-spend or
//!   re-entry into a settled escrow.
//! - **PDA authority**: The vault token account is owned by the escrow PDA.
//!   Token transfers out of the vault require a PDA-signed CPI, so only
//!   program instructions can move funds.
//! - **Penalty caps**: Dispute penalty amounts are bounded by
//!   `deposit_amount * penalty_rate_bps / 10_000` with checked arithmetic
//!   to prevent overflow.
//! - **Timeout enforcement**: Cancellation is gated by `Clock::slot >= timeout_slot`,
//!   giving the seller a guaranteed window to deliver before the buyer
//!   can reclaim funds.
//! - **Rent reclamation**: On cancellation the escrow account is closed and
//!   its lamports are returned to the buyer via `close = buyer`.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

declare_id!("Bcvw9tYGPu7M9hx7YRatv4GLz9Kv2BtZUckaoUgKfUFA");

// ─── Constants ───────────────────────────────────────────────────────────────────

/// Maximum penalty rate in basis points (5 000 = 50%).
/// Capped at 50% to prevent buyer rug-pulls via unilateral dispute.
const MAX_PENALTY_RATE_BPS: u16 = 5_000;

/// Divisor used to convert basis points to a fractional multiplier.
const BPS_DENOMINATOR: u128 = 10_000;

/// Minimum timeout in slots (~40 seconds at 400ms/slot).
const MIN_TIMEOUT_SLOTS: u64 = 100;

/// Maximum timeout in slots (~1 year at 400ms/slot).
const MAX_TIMEOUT_SLOTS: u64 = 78_840_000;

/// Minimum slots after creation before a dispute can be filed.
/// ~3 minutes at 400ms/slot — gives seller time to deliver or respond.
const DISPUTE_COOLDOWN_SLOTS: u64 = 450;

/// PDA seed prefix for escrow accounts.
const ESCROW_SEED: &[u8] = b"escrow";

/// PDA seed prefix for vault token accounts.
const VAULT_SEED: &[u8] = b"vault";

#[program]
pub mod ophir_escrow {
    use super::*;

    /// Creates a new escrow account for a negotiated agreement.
    ///
    /// Initializes the escrow PDA and vault token account, then transfers
    /// `deposit_amount` tokens from the buyer's token account into the vault.
    /// The escrow becomes active immediately and can be released, disputed,
    /// or cancelled after the timeout.
    ///
    /// # Arguments
    ///
    /// * `ctx`              - The [`MakeEscrow`] accounts context.
    /// * `agreement_hash`   - `[u8; 32]` SHA-256 hash of the canonicalized
    ///                        agreement terms. Used as part of the PDA seed.
    /// * `deposit_amount`   - `u64` number of tokens (in smallest unit) to
    ///                        transfer from the buyer into the vault.
    /// * `timeout_slots`    - `u64` number of slots after which the buyer may
    ///                        cancel the escrow. Added to the current slot to
    ///                        compute `timeout_slot`.
    /// * `penalty_rate_bps` - `u16` maximum penalty expressed in basis points
    ///                        (0..=10 000). Caps the penalty the buyer can
    ///                        claim during a dispute.
    ///
    /// # Errors
    ///
    /// * [`EscrowError::InvalidDeposit`]     - `deposit_amount` is zero.
    /// * [`EscrowError::InvalidTimeout`]     - `timeout_slots` is zero.
    /// * [`EscrowError::InvalidPenaltyRate`] - `penalty_rate_bps` exceeds 10 000.
    /// * [`EscrowError::ArithmeticOverflow`] - `current_slot + timeout_slots`
    ///   overflows `u64`.
    ///
    /// # Security
    ///
    /// The `buyer` must be a signer and pays for account initialization.
    /// The `seller` is an unchecked account whose pubkey is stored; it does
    /// not need to sign at creation time. The vault is initialized with
    /// the escrow PDA as its token authority so only program instructions
    /// can transfer tokens out.
    pub fn make_escrow(
        ctx: Context<MakeEscrow>,
        agreement_hash: [u8; 32],
        deposit_amount: u64,
        timeout_slots: u64,
        penalty_rate_bps: u16,
    ) -> Result<()> {
        require!(deposit_amount > 0, EscrowError::InvalidDeposit);
        require!(timeout_slots >= MIN_TIMEOUT_SLOTS, EscrowError::TimeoutTooShort);
        require!(timeout_slots <= MAX_TIMEOUT_SLOTS, EscrowError::TimeoutTooLong);
        require!(penalty_rate_bps <= MAX_PENALTY_RATE_BPS, EscrowError::InvalidPenaltyRate);
        require!(
            ctx.accounts.buyer.key() != ctx.accounts.seller.key(),
            EscrowError::BuyerCannotBeSeller
        );

        let clock = Clock::get()?;
        let escrow = &mut ctx.accounts.escrow;
        escrow.buyer = ctx.accounts.buyer.key();
        escrow.seller = ctx.accounts.seller.key();
        escrow.arbiter = ctx.accounts.arbiter.key();
        escrow.mint = ctx.accounts.mint.key();
        escrow.agreement_hash = agreement_hash;
        escrow.deposit_amount = deposit_amount;
        escrow.penalty_rate_bps = penalty_rate_bps;
        escrow.created_at = clock.unix_timestamp;
        escrow.created_slot = clock.slot;
        escrow.timeout_slot = clock.slot.checked_add(timeout_slots)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        escrow.status = EscrowStatus::Active;
        escrow.bump = ctx.bumps.escrow;

        // Transfer tokens from buyer to vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.buyer_token_account.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            deposit_amount,
        )?;

        emit!(EscrowCreated {
            buyer: ctx.accounts.buyer.key(),
            seller: ctx.accounts.seller.key(),
            arbiter: ctx.accounts.arbiter.key(),
            agreement_hash,
            deposit_amount,
        });

        Ok(())
    }

    /// Releases the escrowed funds to the seller.
    ///
    /// Transfers the entire vault balance to the seller's token account and
    /// marks the escrow as released.
    ///
    /// # Arguments
    ///
    /// * `ctx`                - The [`ReleaseEscrow`] accounts context.
    /// * `_verification_hash` - `Option<[u8; 32]>` optional SHA-256 hash of
    ///                          service-delivery proof. Logged for off-chain
    ///                          audit trails but not enforced on-chain.
    ///
    /// # Errors
    ///
    /// * [`EscrowError::InvalidSeller`]  - The signing seller does not match
    ///                                     `escrow.seller`.
    /// * [`EscrowError::EscrowNotActive`] - The escrow is not in `Active` status.
    ///
    /// # Security
    ///
    /// Only the seller stored in `escrow.seller` may sign this instruction.
    /// The constraint `escrow.seller == seller.key()` is enforced at the
    /// account-validation level so a mismatched seller cannot deserialize
    /// the escrow. The vault transfer is authorized by the escrow PDA
    /// signer seeds.
    pub fn release_escrow(
        ctx: Context<ReleaseEscrow>,
        _verification_hash: Option<[u8; 32]>,
    ) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        let vault_balance = ctx.accounts.vault.amount;

        let agreement_hash = escrow.agreement_hash;
        let buyer_key = escrow.buyer;
        let bump = escrow.bump;
        let seeds: &[&[u8]] = &[
            ESCROW_SEED,
            buyer_key.as_ref(),
            agreement_hash.as_ref(),
            &[bump],
        ];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.seller_token_account.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                &[seeds],
            ),
            vault_balance,
        )?;

        // Close vault token account to reclaim rent
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.seller.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
            },
            &[seeds],
        ))?;

        let escrow = &mut ctx.accounts.escrow;
        escrow.status = EscrowStatus::Released;

        emit!(EscrowReleased {
            agreement_hash,
            amount: vault_balance,
        });

        Ok(())
    }

    /// Resolves a dispute by splitting escrowed funds between buyer and seller.
    ///
    /// The buyer claims a penalty (capped by `penalty_rate_bps`) and the
    /// remainder is forwarded to the seller. Both transfers are skipped if
    /// their respective amounts are zero.
    ///
    /// # Arguments
    ///
    /// * `ctx`                     - The [`DisputeEscrow`] accounts context.
    /// * `violation_evidence_hash` - `[u8; 32]` SHA-256 hash of off-chain
    ///                               evidence supporting the dispute claim.
    ///                               Stored in the emitted event for
    ///                               on-chain auditability.
    /// * `penalty_amount`          - `u64` number of tokens to return to
    ///                               the buyer. Must not exceed
    ///                               `deposit_amount * penalty_rate_bps / 10_000`.
    ///
    /// # Errors
    ///
    /// * [`EscrowError::Unauthorized`]    - The signer is not the buyer.
    /// * [`EscrowError::EscrowNotActive`] - The escrow is not in `Active` status.
    /// * [`EscrowError::PenaltyExceedsMax`] - `penalty_amount` exceeds the
    ///   maximum computed from `deposit_amount` and `penalty_rate_bps`, or
    ///   the vault balance is insufficient to cover the split.
    ///
    /// # Security
    ///
    /// Only the buyer stored in `escrow.buyer` may initiate a dispute. The
    /// penalty cap is computed with `u128` checked arithmetic to prevent
    /// overflow. The seller's token account is validated against
    /// `escrow.seller` to ensure funds reach the correct recipient.
    pub fn dispute_escrow(
        ctx: Context<DisputeEscrow>,
        violation_evidence_hash: [u8; 32],
        penalty_amount: u64,
    ) -> Result<()> {
        let escrow = &ctx.accounts.escrow;

        // Enforce dispute cooldown — buyer must wait DISPUTE_COOLDOWN_SLOTS
        // after creation before filing a dispute (prevents instant rug + MEV)
        let clock = Clock::get()?;
        let earliest_dispute_slot = escrow.created_slot
            .checked_add(DISPUTE_COOLDOWN_SLOTS)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        require!(
            clock.slot >= earliest_dispute_slot,
            EscrowError::DisputeCooldownNotMet
        );

        // Validate penalty does not exceed max
        let max_penalty: u64 = (escrow.deposit_amount as u128)
            .checked_mul(escrow.penalty_rate_bps as u128)
            .and_then(|v| v.checked_div(BPS_DENOMINATOR))
            .ok_or(EscrowError::PenaltyExceedsMax)?
            .try_into()
            .map_err(|_| EscrowError::ArithmeticOverflow)?;
        require!(penalty_amount <= max_penalty, EscrowError::PenaltyExceedsMax);

        let vault_balance = ctx.accounts.vault.amount;
        let seller_amount = vault_balance
            .checked_sub(penalty_amount)
            .ok_or(EscrowError::PenaltyExceedsMax)?;

        let agreement_hash = escrow.agreement_hash;
        let buyer_key = escrow.buyer;
        let bump = escrow.bump;
        let seeds: &[&[u8]] = &[
            ESCROW_SEED,
            buyer_key.as_ref(),
            agreement_hash.as_ref(),
            &[bump],
        ];
        let signer_seeds = &[seeds];

        // Transfer penalty to buyer
        if penalty_amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.buyer_token_account.to_account_info(),
                        authority: ctx.accounts.escrow.to_account_info(),
                    },
                    signer_seeds,
                ),
                penalty_amount,
            )?;
        }

        // Transfer remaining to seller
        if seller_amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.seller_token_account.to_account_info(),
                        authority: ctx.accounts.escrow.to_account_info(),
                    },
                    signer_seeds,
                ),
                seller_amount,
            )?;
        }

        // Close vault token account to reclaim rent
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.buyer.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
            },
            signer_seeds,
        ))?;

        let escrow = &mut ctx.accounts.escrow;
        escrow.status = EscrowStatus::Disputed;

        emit!(EscrowDisputed {
            agreement_hash,
            penalty_amount,
            evidence_hash: violation_evidence_hash,
        });

        Ok(())
    }

    /// Cancels the escrow and returns all funds to the buyer.
    ///
    /// Only callable after the timeout slot has been reached. Transfers the
    /// entire vault balance back to the buyer's token account, marks the
    /// escrow as cancelled, and closes the escrow account to reclaim rent.
    ///
    /// # Arguments
    ///
    /// * `ctx` - The [`CancelEscrow`] accounts context.
    ///
    /// # Errors
    ///
    /// * [`EscrowError::Unauthorized`]      - The signer is not the buyer.
    /// * [`EscrowError::EscrowNotActive`]   - The escrow is not in `Active` status.
    /// * [`EscrowError::TimeoutNotReached`] - The current slot is less than
    ///                                        `escrow.timeout_slot`.
    ///
    /// # Security
    ///
    /// Only the buyer stored in `escrow.buyer` may cancel. The timeout
    /// check uses `Clock::get()?.slot` which is the cluster-confirmed slot,
    /// preventing premature cancellation. The escrow account is closed with
    /// `close = buyer` so the buyer reclaims rent-exempt lamports.
    pub fn cancel_escrow(ctx: Context<CancelEscrow>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        let clock = Clock::get()?;
        require!(
            clock.slot >= escrow.timeout_slot,
            EscrowError::TimeoutNotReached
        );

        let vault_balance = ctx.accounts.vault.amount;

        let agreement_hash = escrow.agreement_hash;
        let buyer_key = escrow.buyer;
        let bump = escrow.bump;
        let seeds: &[&[u8]] = &[
            ESCROW_SEED,
            buyer_key.as_ref(),
            agreement_hash.as_ref(),
            &[bump],
        ];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.buyer_token_account.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                &[seeds],
            ),
            vault_balance,
        )?;

        // Close vault token account to reclaim rent
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.buyer.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
            },
            &[seeds],
        ))?;

        let escrow = &mut ctx.accounts.escrow;
        escrow.status = EscrowStatus::Cancelled;

        emit!(EscrowCancelled {
            agreement_hash,
            refund_amount: vault_balance,
        });

        Ok(())
    }
}

// ─── Accounts ───────────────────────────────────────────────────────────────────

/// Accounts required to create a new escrow.
///
/// The buyer signs and pays for all account initialization (escrow PDA and
/// vault token account). The seller is stored as an unchecked account because
/// they do not need to co-sign escrow creation.
#[derive(Accounts)]
#[instruction(agreement_hash: [u8; 32], deposit_amount: u64)]
pub struct MakeEscrow<'info> {
    /// The buyer who deposits tokens into escrow.
    /// Must be a signer and is the payer for PDA initialization.
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// The counterparty who will receive tokens upon release.
    /// CHECK: Seller pubkey is stored in the escrow state but does not need to
    /// sign at creation time. Validated as a signer in [`ReleaseEscrow`] and
    /// as an owner match in [`DisputeEscrow`].
    pub seller: UncheckedAccount<'info>,

    /// The neutral arbiter who must co-sign disputes.
    /// CHECK: Arbiter pubkey is stored in the escrow state. Must co-sign
    /// dispute_escrow to prevent buyer unilateral fund clawback.
    pub arbiter: UncheckedAccount<'info>,

    /// The escrow PDA that holds agreement state.
    /// Seeds: `["escrow", buyer_pubkey, agreement_hash]`.
    /// Space: 8-byte discriminator + [`EscrowAccount::INIT_SPACE`].
    #[account(
        init,
        payer = buyer,
        space = 8 + EscrowAccount::INIT_SPACE,
        seeds = [ESCROW_SEED, buyer.key().as_ref(), agreement_hash.as_ref()],
        bump,
    )]
    pub escrow: Account<'info, EscrowAccount>,

    /// Token account owned by escrow PDA, holds deposited funds.
    /// Authority is set to the escrow PDA so only program instructions can
    /// transfer tokens out. Seeds: `["vault", escrow_pubkey]`.
    #[account(
        init,
        payer = buyer,
        token::mint = mint,
        token::authority = escrow,
        seeds = [VAULT_SEED, escrow.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// The buyer's associated token account from which the deposit is drawn.
    /// Validated to be owned by the buyer and to match the escrow mint.
    #[account(
        mut,
        constraint = buyer_token_account.owner == buyer.key() @ EscrowError::Unauthorized,
        constraint = buyer_token_account.mint == mint.key() @ EscrowError::InvalidMint,
    )]
    pub buyer_token_account: Account<'info, TokenAccount>,

    /// The SPL token mint for the escrowed asset (e.g. USDC).
    pub mint: Account<'info, Mint>,

    /// The Solana system program, required for account creation.
    pub system_program: Program<'info, System>,

    /// The SPL Token program, required for token account init and transfers.
    pub token_program: Program<'info, Token>,

    /// The rent sysvar, required for rent-exempt account initialization.
    pub rent: Sysvar<'info, Rent>,
}

/// Accounts required to release escrowed funds to the seller.
///
/// The seller signs this instruction to claim payment. The escrow must be
/// in `Active` status and its stored `seller` field must match the signer.
#[derive(Accounts)]
pub struct ReleaseEscrow<'info> {
    /// The seller who signs to claim payment.
    /// Must match `escrow.seller` (enforced by constraint).
    #[account(mut)]
    pub seller: Signer<'info>,

    /// The buyer account to receive rent from closed escrow.
    /// CHECK: Validated via has_one on escrow. Only receives lamports.
    #[account(mut)]
    pub buyer: UncheckedAccount<'info>,

    /// The escrow PDA. Anchor constraints enforce:
    /// - `escrow.seller == seller.key()` (seller identity)
    /// - `escrow.status == Active` (no double-release)
    /// - PDA re-derivation via seeds and bump
    /// `close = buyer` reclaims escrow rent to the buyer.
    #[account(
        mut,
        close = buyer,
        has_one = seller @ EscrowError::InvalidSeller,
        has_one = buyer @ EscrowError::Unauthorized,
        constraint = escrow.status == EscrowStatus::Active @ EscrowError::EscrowNotActive,
        seeds = [ESCROW_SEED, escrow.buyer.as_ref(), escrow.agreement_hash.as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, EscrowAccount>,

    /// The vault token account holding escrowed tokens.
    /// Authority is the escrow PDA, validated via `token::authority`.
    #[account(
        mut,
        seeds = [VAULT_SEED, escrow.key().as_ref()],
        bump,
        token::authority = escrow,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// The seller's token account to receive released tokens.
    /// Validated to be owned by the seller and to match the vault mint.
    #[account(
        mut,
        constraint = seller_token_account.owner == seller.key() @ EscrowError::InvalidSeller,
        constraint = seller_token_account.mint == vault.mint @ EscrowError::InvalidMint,
    )]
    pub seller_token_account: Account<'info, TokenAccount>,

    /// The SPL Token program.
    pub token_program: Program<'info, Token>,
}

/// Accounts required to dispute an escrow and split funds.
///
/// The buyer signs this instruction to initiate a dispute. A penalty amount
/// (capped by `penalty_rate_bps`) is returned to the buyer and the remainder
/// goes to the seller.
#[derive(Accounts)]
pub struct DisputeEscrow<'info> {
    /// The buyer who initiates the dispute.
    /// Must match `escrow.buyer` (enforced by constraint).
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// The neutral arbiter who must co-sign the dispute.
    /// Prevents buyer from unilaterally clawing back funds.
    pub arbiter: Signer<'info>,

    /// The escrow PDA. Anchor constraints enforce:
    /// - `escrow.buyer == buyer.key()` (buyer identity)
    /// - `escrow.arbiter == arbiter.key()` (arbiter identity)
    /// - `escrow.status == Active` (no double-dispute)
    /// - PDA re-derivation via seeds and bump
    #[account(
        mut,
        close = buyer,
        has_one = buyer @ EscrowError::Unauthorized,
        has_one = arbiter @ EscrowError::InvalidArbiter,
        constraint = escrow.status == EscrowStatus::Active @ EscrowError::EscrowNotActive,
        seeds = [ESCROW_SEED, buyer.key().as_ref(), escrow.agreement_hash.as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, EscrowAccount>,

    /// The vault token account holding escrowed tokens.
    /// Authority is the escrow PDA, validated via `token::authority`.
    #[account(
        mut,
        seeds = [VAULT_SEED, escrow.key().as_ref()],
        bump,
        token::authority = escrow,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// The buyer's token account to receive the penalty refund.
    /// Validated to be owned by the buyer and to match the vault mint.
    #[account(
        mut,
        constraint = buyer_token_account.owner == buyer.key() @ EscrowError::Unauthorized,
        constraint = buyer_token_account.mint == vault.mint @ EscrowError::InvalidMint,
    )]
    pub buyer_token_account: Account<'info, TokenAccount>,

    /// The seller's token account to receive the remainder after penalty.
    /// Validated against `escrow.seller` (not the signer) to ensure funds
    /// reach the correct counterparty.
    #[account(
        mut,
        constraint = seller_token_account.owner == escrow.seller @ EscrowError::InvalidSeller,
        constraint = seller_token_account.mint == vault.mint @ EscrowError::InvalidMint,
    )]
    pub seller_token_account: Account<'info, TokenAccount>,

    /// The SPL Token program.
    pub token_program: Program<'info, Token>,
}

/// Accounts required to cancel an escrow after timeout.
///
/// The buyer signs this instruction to reclaim their deposit after the
/// timeout slot has passed. The escrow account is closed and its rent-exempt
/// lamports are returned to the buyer.
#[derive(Accounts)]
pub struct CancelEscrow<'info> {
    /// The buyer who reclaims their deposit.
    /// Must match `escrow.buyer` (enforced by constraint).
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// The escrow PDA. Anchor constraints enforce:
    /// - `escrow.buyer == buyer.key()` (buyer identity)
    /// - `escrow.status == Active` (no double-cancel)
    /// - PDA re-derivation via seeds and bump
    /// The `close = buyer` directive reclaims rent to the buyer on success.
    #[account(
        mut,
        close = buyer,
        has_one = buyer @ EscrowError::Unauthorized,
        constraint = escrow.status == EscrowStatus::Active @ EscrowError::EscrowNotActive,
        seeds = [ESCROW_SEED, buyer.key().as_ref(), escrow.agreement_hash.as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, EscrowAccount>,

    /// The vault token account holding escrowed tokens.
    /// Authority is the escrow PDA, validated via `token::authority`.
    #[account(
        mut,
        seeds = [VAULT_SEED, escrow.key().as_ref()],
        bump,
        token::authority = escrow,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// The buyer's token account to receive the refund.
    /// Validated to be owned by the buyer and to match the vault mint.
    #[account(
        mut,
        constraint = buyer_token_account.owner == buyer.key() @ EscrowError::Unauthorized,
        constraint = buyer_token_account.mint == vault.mint @ EscrowError::InvalidMint,
    )]
    pub buyer_token_account: Account<'info, TokenAccount>,

    /// The SPL Token program.
    pub token_program: Program<'info, Token>,
}

// ─── State ──────────────────────────────────────────────────────────────────────

/// On-chain state for a negotiated escrow agreement.
///
/// Created as a PDA with seeds `["escrow", buyer_pubkey, agreement_hash]`.
/// Holds metadata about the agreement, deposit, penalty terms, and current
/// status. The account size is deterministic via `InitSpace` and includes an
/// 8-byte Anchor discriminator prefix.
///
/// ## Field Layout (196 bytes + 8 discriminator = 204 total)
///
/// | Field              | Type        | Size  | Description                                 |
/// |--------------------|-------------|-------|---------------------------------------------|
/// | `buyer`            | `Pubkey`    | 32    | Depositor / dispute initiator / canceller   |
/// | `seller`           | `Pubkey`    | 32    | Payment recipient on release                |
/// | `arbiter`          | `Pubkey`    | 32    | Neutral arbiter who co-signs disputes       |
/// | `mint`             | `Pubkey`    | 32    | SPL token mint for the escrowed asset       |
/// | `agreement_hash`   | `[u8; 32]`  | 32    | SHA-256 of canonicalized agreement terms    |
/// | `deposit_amount`   | `u64`       | 8     | Tokens deposited (smallest unit)            |
/// | `penalty_rate_bps` | `u16`       | 2     | Max penalty cap in basis points             |
/// | `created_at`       | `i64`       | 8     | Unix timestamp at creation                  |
/// | `created_slot`     | `u64`       | 8     | Slot at creation (for dispute cooldown)     |
/// | `timeout_slot`     | `u64`       | 8     | Slot after which cancellation is allowed    |
/// | `status`           | `EscrowStatus` | 1  | Current lifecycle state                     |
/// | `bump`             | `u8`        | 1     | PDA bump seed for signer derivation         |
#[account]
#[derive(InitSpace)]
pub struct EscrowAccount {
    /// The buyer's wallet address. This party deposits tokens, can dispute
    /// (with arbiter co-sign), and can cancel after timeout.
    pub buyer: Pubkey,

    /// The seller's wallet address. This party receives tokens on release
    /// and receives the remainder after penalty on dispute.
    pub seller: Pubkey,

    /// The neutral arbiter's wallet address. Must co-sign any dispute
    /// to prevent buyer from unilaterally clawing back funds.
    pub arbiter: Pubkey,

    /// The SPL token mint address (e.g. USDC). All token accounts in the
    /// escrow instructions must match this mint.
    pub mint: Pubkey,

    /// SHA-256 hash of the canonicalized agreement terms. Serves as a
    /// unique identifier and PDA seed component, binding the on-chain
    /// escrow to specific off-chain contract terms.
    pub agreement_hash: [u8; 32],

    /// Amount deposited in the vault, denominated in the mint's smallest
    /// unit (e.g. lamports for SOL, micro-units for USDC with 6 decimals).
    /// Must be greater than zero at creation.
    pub deposit_amount: u64,

    /// Maximum penalty rate in basis points. During a dispute the arbiter
    /// and buyer can claim at most `deposit_amount * penalty_rate_bps / 10_000`.
    /// Range: 0..=5 000 (0% to 50%).
    pub penalty_rate_bps: u16,

    /// Unix timestamp (seconds since epoch) recorded at escrow creation.
    /// Informational; not used for on-chain timeout logic.
    pub created_at: i64,

    /// Slot number when the escrow was created. Used to enforce the
    /// dispute cooldown period (DISPUTE_COOLDOWN_SLOTS).
    pub created_slot: u64,

    /// Slot number after which the buyer may cancel the escrow. Computed
    /// as `creation_slot + timeout_slots` during `make_escrow`.
    pub timeout_slot: u64,

    /// Current lifecycle status. Transitions are one-way:
    /// `Active -> Released | Disputed | Cancelled`.
    pub status: EscrowStatus,

    /// PDA bump seed. Stored for CPI signing in release/dispute/cancel
    /// instructions, avoiding recomputation of the bump on each call.
    pub bump: u8,
}

/// The lifecycle status of an escrow account.
///
/// Status transitions are enforced by Anchor constraints. Once an escrow
/// leaves the `Active` state it cannot be mutated further.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum EscrowStatus {
    /// Escrow is active and funds are locked in the vault.
    /// All state-changing instructions require this status.
    Active,
    /// Funds have been released to the seller via [`release_escrow`].
    Released,
    /// A dispute was resolved via [`dispute_escrow`]; funds were split
    /// between buyer and seller according to the penalty amount.
    Disputed,
    /// Escrow was cancelled via [`cancel_escrow`] after timeout; all
    /// funds returned to buyer and the account was closed.
    Cancelled,
}

// ─── Events ─────────────────────────────────────────────────────────────────────

/// Emitted when a new escrow is successfully created via [`make_escrow`].
#[event]
pub struct EscrowCreated {
    /// The buyer's wallet address.
    pub buyer: Pubkey,
    /// The seller's wallet address.
    pub seller: Pubkey,
    /// The arbiter's wallet address.
    pub arbiter: Pubkey,
    /// SHA-256 hash of the agreement terms (PDA seed component).
    pub agreement_hash: [u8; 32],
    /// Amount deposited into the vault.
    pub deposit_amount: u64,
}

/// Emitted when escrowed funds are released to the seller via [`release_escrow`].
#[event]
pub struct EscrowReleased {
    /// SHA-256 hash of the agreement terms.
    pub agreement_hash: [u8; 32],
    /// Total amount transferred to the seller.
    pub amount: u64,
}

/// Emitted when an escrow dispute is resolved via [`dispute_escrow`].
#[event]
pub struct EscrowDisputed {
    /// SHA-256 hash of the agreement terms.
    pub agreement_hash: [u8; 32],
    /// Penalty amount returned to the buyer.
    pub penalty_amount: u64,
    /// SHA-256 hash of the violation evidence provided by the buyer.
    pub evidence_hash: [u8; 32],
}

/// Emitted when an escrow is cancelled and funds are refunded via [`cancel_escrow`].
#[event]
pub struct EscrowCancelled {
    /// SHA-256 hash of the agreement terms.
    pub agreement_hash: [u8; 32],
    /// Total amount refunded to the buyer.
    pub refund_amount: u64,
}

// ─── Errors ─────────────────────────────────────────────────────────────────────

/// Custom error codes for the Ophir escrow program.
///
/// Error codes are serialized as `u32` values starting from 6000 (Anchor
/// convention for custom errors). Each variant includes a human-readable
/// message returned in transaction logs.
#[error_code]
pub enum EscrowError {
    /// The escrow must be in `Active` status for this operation.
    /// Returned when attempting to release, dispute, or cancel an escrow
    /// that has already been settled.
    #[msg("Escrow is not in Active status")]
    EscrowNotActive,

    /// The timeout slot has not been reached; cancellation is not yet allowed.
    /// The buyer must wait until `Clock::slot >= escrow.timeout_slot`.
    #[msg("Timeout slot has not been reached yet")]
    TimeoutNotReached,

    /// The requested penalty exceeds the maximum allowed by `penalty_rate_bps`,
    /// or the vault balance is insufficient to cover the penalty.
    #[msg("Penalty amount exceeds maximum allowed by penalty_rate_bps")]
    PenaltyExceedsMax,

    /// The `deposit_amount` parameter must be greater than zero.
    #[msg("Deposit amount must be greater than zero")]
    InvalidDeposit,

    /// The `timeout_slots` parameter must be greater than zero.
    #[msg("Timeout slots must be greater than zero")]
    InvalidTimeout,

    /// The `timeout_slots` is below the minimum (100 slots).
    #[msg("Timeout too short, minimum is 100 slots")]
    TimeoutTooShort,

    /// The `timeout_slots` exceeds the maximum (~1 year).
    #[msg("Timeout too long, maximum is 78840000 slots")]
    TimeoutTooLong,

    /// The `penalty_rate_bps` must not exceed 10 000 (100%).
    #[msg("Penalty rate must not exceed 10000 basis points")]
    InvalidPenaltyRate,

    /// The seller account provided does not match `escrow.seller`.
    #[msg("Invalid seller account")]
    InvalidSeller,

    /// The signing account does not match the expected buyer or seller
    /// for this instruction.
    #[msg("Unauthorized: signer does not match expected account")]
    Unauthorized,

    /// A token account's mint does not match the expected mint for
    /// this escrow. Ensure all token accounts use the same SPL mint.
    #[msg("Token account mint does not match escrow mint")]
    InvalidMint,

    /// An arithmetic operation overflowed. This can occur if
    /// `timeout_slots` is so large that `current_slot + timeout_slots`
    /// exceeds `u64::MAX`.
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,

    /// The buyer and seller cannot be the same account.
    #[msg("Buyer and seller cannot be the same account")]
    BuyerCannotBeSeller,

    /// The arbiter account does not match `escrow.arbiter`.
    #[msg("Invalid arbiter account")]
    InvalidArbiter,

    /// The dispute cooldown period has not elapsed since escrow creation.
    #[msg("Dispute cooldown not met, must wait 450 slots after creation")]
    DisputeCooldownNotMet,
}
