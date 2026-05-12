use anchor_lang::prelude::*;

declare_id!("54ryi8hcihut8fDSVFSbN5NbArQ5GAd1xgmGCA3hqWoo");

#[program]
pub mod invoice_registry {
    use super::*;

    pub fn create_invoice(
        ctx: Context<CreateInvoice>,
        nonce: [u8; 8],
        metadata_hash: [u8; 32],
        metadata_uri: String,
        mint: Pubkey,
        expires_at: Option<i64>,
    ) -> Result<()> {
        require!(metadata_uri.len() <= Invoice::MAX_URI_LEN, InvoiceError::UriTooLong);

        let invoice = &mut ctx.accounts.invoice;
        invoice.version = 1;
        invoice.creator = ctx.accounts.creator.key();
        invoice.payer = None;
        invoice.mint = mint;
        invoice.metadata_hash = metadata_hash;
        invoice.metadata_uri = metadata_uri;
        invoice.utxo_commitment = None;
        invoice.status = InvoiceStatus::Pending;
        invoice.created_at = Clock::get()?.unix_timestamp;
        invoice.paid_at = None;
        invoice.expires_at = expires_at;
        invoice.nonce = nonce;
        invoice.bump = ctx.bumps.invoice;
        Ok(())
    }

    pub fn create_invoice_restricted(
        ctx: Context<CreateInvoice>,
        nonce: [u8; 8],
        metadata_hash: [u8; 32],
        metadata_uri: String,
        mint: Pubkey,
        expires_at: Option<i64>,
        payer: Pubkey,
    ) -> Result<()> {
        require!(metadata_uri.len() <= Invoice::MAX_URI_LEN, InvoiceError::UriTooLong);

        let invoice = &mut ctx.accounts.invoice;
        invoice.version = 1;
        invoice.creator = ctx.accounts.creator.key();
        invoice.payer = Some(payer);
        invoice.mint = mint;
        invoice.metadata_hash = metadata_hash;
        invoice.metadata_uri = metadata_uri;
        invoice.utxo_commitment = None;
        invoice.status = InvoiceStatus::Pending;
        invoice.created_at = Clock::get()?.unix_timestamp;
        invoice.paid_at = None;
        invoice.expires_at = expires_at;
        invoice.nonce = nonce;
        invoice.bump = ctx.bumps.invoice;
        Ok(())
    }

    pub fn mark_paid(ctx: Context<MarkPaid>, utxo_commitment: [u8; 32]) -> Result<()> {
        let invoice = &mut ctx.accounts.invoice;
        require!(invoice.status == InvoiceStatus::Pending, InvoiceError::InvalidStatus);
        invoice.status = InvoiceStatus::Paid;
        invoice.paid_at = Some(Clock::get()?.unix_timestamp);
        invoice.utxo_commitment = Some(utxo_commitment);
        Ok(())
    }

    pub fn cancel_invoice(ctx: Context<CancelInvoice>) -> Result<()> {
        let invoice = &mut ctx.accounts.invoice;
        require!(invoice.status == InvoiceStatus::Pending, InvoiceError::InvalidStatus);
        invoice.status = InvoiceStatus::Cancelled;
        Ok(())
    }

    /// Acquires a single-use payment-intent lock for `invoice`. The lock is a
    /// PDA seeded by `invoice.key()` so its `init` constraint enforces
    /// one-shot semantics: a second attempt to lock the same invoice fails
    /// with `Allocate: account ... already in use` and the entire enclosing
    /// transaction (including any subsequent funds-movement CPIs) reverts.
    ///
    /// VeilPay's `pay_invoice` calls this BEFORE the Umbra deposit CPIs so
    /// the lock acquisition is atomic with the funds movement — closing the
    /// "pay twice before mark_paid lands" race that the prior architecture
    /// permitted.
    ///
    /// When `invoice.payer` is `Some(restricted)`, only that payer may
    /// acquire the lock — surfacing the previously-defined-but-unused
    /// `NotPayer` error code as a real on-chain check.
    pub fn lock_payment_intent(ctx: Context<LockPaymentIntent>) -> Result<()> {
        let invoice = &ctx.accounts.invoice;
        require!(
            invoice.status == InvoiceStatus::Pending,
            InvoiceError::InvalidStatus
        );
        if let Some(restricted) = invoice.payer {
            require!(
                ctx.accounts.payer.key() == restricted,
                InvoiceError::NotPayer
            );
        }
        let lock = &mut ctx.accounts.lock;
        lock.invoice = invoice.key();
        lock.payer = ctx.accounts.payer.key();
        lock.locked_at = Clock::get()?.unix_timestamp;
        lock.bump = ctx.bumps.lock;
        Ok(())
    }

    /// Release a `PaymentIntentLock` after a failed payment attempt. Refunds
    /// the lock's rent to the original payer. Only the payer can call this —
    /// they're the one who paid the rent and they're the only party who knows
    /// whether their second/third tx in the batch actually landed.
    ///
    /// Used when the shielded-pay batched flow has the lock tx confirm but
    /// the subsequent createBuffer or deposit tx fail. Without this, the
    /// invoice would be permanently locked and the payer would lose the rent.
    ///
    /// Status check: only releasable while the invoice is still Pending.
    /// Once the invoice is marked Paid (mark_paid succeeded), cancellation
    /// is forbidden — by then the lock represents a real settlement and
    /// removing it would let an attacker pay the invoice twice.
    pub fn cancel_payment_intent(ctx: Context<CancelPaymentIntent>) -> Result<()> {
        require!(
            ctx.accounts.invoice.status == InvoiceStatus::Pending,
            InvoiceError::InvalidStatus
        );
        // Has-one and seed checks in the Accounts struct already guarantee
        // (a) lock.invoice == invoice.key() and (b) lock.payer == payer.key().
        // close = payer in the struct refunds rent automatically.
        Ok(())
    }
}

#[account]
pub struct Invoice {
    pub version: u8,                       // 1
    pub creator: Pubkey,                   // 32
    pub payer: Option<Pubkey>,             // 33
    pub mint: Pubkey,                      // 32
    pub metadata_hash: [u8; 32],           // 32
    pub metadata_uri: String,              // 4 + MAX_URI_LEN
    pub utxo_commitment: Option<[u8; 32]>, // 33
    pub status: InvoiceStatus,             // 1
    pub created_at: i64,                   // 8
    pub paid_at: Option<i64>,              // 9
    pub expires_at: Option<i64>,           // 9
    pub nonce: [u8; 8],                    // 8
    pub bump: u8,                          // 1
}

impl Invoice {
    pub const MAX_URI_LEN: usize = 200;
    pub const SIZE: usize = 8 // discriminator
        + 1                  // version
        + 32                 // creator
        + 33                 // payer (Option<Pubkey>)
        + 32                 // mint
        + 32                 // metadata_hash
        + 4 + Self::MAX_URI_LEN // metadata_uri
        + 33                 // utxo_commitment
        + 1                  // status
        + 8                  // created_at
        + 9                  // paid_at
        + 9                  // expires_at
        + 8                  // nonce
        + 1;                 // bump
}

/// Single-use lock PDA proving "this invoice has had a payment attempt".
/// Seeded by `invoice.key()` under the invoice-registry program. The `init`
/// constraint on its derive struct gives free idempotency — re-init fails
/// with the system-program "account already in use" error, which Anchor
/// surfaces as a tx-level revert that rolls back any sibling CPIs in the
/// same transaction.
///
/// Why a separate account instead of a flag on `Invoice`? Two reasons:
///   1. Adding a field to `Invoice` would break deserialization of every
///      existing devnet invoice (constraint from the rollout).
///   2. The `init` rejection is the safety guarantee. Mutating a flag in
///      the same tx that performs the deposit CPIs would still race with
///      a second tx that reads the flag, sees Pending, and proceeds —
///      because flag-write and deposit-CPI live in the same tx but
///      flag-check happens at tx-build time off-chain.
#[account]
pub struct PaymentIntentLock {
    pub invoice: Pubkey,    // 32
    pub payer: Pubkey,      // 32
    pub locked_at: i64,     //  8
    pub bump: u8,           //  1
}

impl PaymentIntentLock {
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub enum InvoiceStatus {
    Pending,
    Paid,
    Cancelled,
    Expired,
}

#[derive(Accounts)]
#[instruction(nonce: [u8; 8])]
pub struct CreateInvoice<'info> {
    #[account(
        init,
        payer = creator,
        space = Invoice::SIZE,
        seeds = [b"invoice", creator.key().as_ref(), nonce.as_ref()],
        bump,
    )]
    pub invoice: Account<'info, Invoice>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MarkPaid<'info> {
    #[account(
        mut,
        has_one = creator @ InvoiceError::NotCreator,
    )]
    pub invoice: Account<'info, Invoice>,
    pub creator: Signer<'info>,
}

#[derive(Accounts)]
pub struct CancelInvoice<'info> {
    #[account(
        mut,
        has_one = creator @ InvoiceError::NotCreator,
    )]
    pub invoice: Account<'info, Invoice>,
    pub creator: Signer<'info>,
}

/// Account context for `lock_payment_intent`. The lock PDA is `init`-ed
/// here, paying its rent from `payer` — the same wallet that signs the
/// outer VeilPay tx (i.e. the depositor). This means the same SOL that
/// pays tx fees also pays lock rent (a few thousand lamports), keeping
/// the fee model coherent with what users see today.
///
/// Note: `invoice` is NOT marked `mut` — we only read its `status` and
/// optional `payer`. This keeps `mark_paid` and `cancel_invoice` free to
/// mutate the invoice in subsequent transactions without contention.
#[derive(Accounts)]
pub struct LockPaymentIntent<'info> {
    pub invoice: Account<'info, Invoice>,
    #[account(
        init,
        payer = payer,
        space = PaymentIntentLock::SIZE,
        seeds = [b"intent_lock", invoice.key().as_ref()],
        bump,
    )]
    pub lock: Account<'info, PaymentIntentLock>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Account context for `cancel_payment_intent`. The lock PDA is `close`-d
/// here, refunding its rent to `payer`. The `has_one = invoice` and
/// `has_one = payer` constraints (combined with the seed-bound PDA derive)
/// guarantee callers cannot release a lock for an invoice they don't own
/// the original payment intent on.
///
/// `invoice` is NOT marked `mut` — only read for status. Releasing a lock
/// does not mutate the invoice; an external mark_paid (if it ever lands)
/// will succeed even after cancellation because mark_paid only checks
/// `invoice.status == Pending`, which is unaffected here.
#[derive(Accounts)]
pub struct CancelPaymentIntent<'info> {
    pub invoice: Account<'info, Invoice>,
    #[account(
        mut,
        close = payer,
        seeds = [b"intent_lock", invoice.key().as_ref()],
        bump = lock.bump,
        has_one = invoice @ InvoiceError::InvalidStatus,
        has_one = payer @ InvoiceError::NotPayer,
    )]
    pub lock: Account<'info, PaymentIntentLock>,
    #[account(mut)]
    pub payer: Signer<'info>,
}

#[error_code]
pub enum InvoiceError {
    #[msg("Metadata URI exceeds maximum length")]
    UriTooLong,
    #[msg("Invoice is not in a state that allows this operation")]
    InvalidStatus,
    #[msg("Only the creator can perform this action")]
    NotCreator,
    #[msg("Only the designated payer can perform this action")]
    NotPayer,
}
