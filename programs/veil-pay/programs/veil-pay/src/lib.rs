use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke,
};
use anchor_lang::system_program::{self, Transfer};

declare_id!("E2G6dN7yY8VQ2dFRgkvqskdAnPhJXkdorYP6BhKvfa8m");

// Umbra program ID. Devnet for now; mainnet uses UMBRAD2ishebJTcgCLkTkNUx1v3GyoAgpTRPeWoLykh
pub const UMBRA_PROGRAM_ID: Pubkey = pubkey!("DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ");

// Invoice-registry program ID. We CPI into it to acquire a single-use
// payment-intent lock before each Umbra deposit, closing the
// double-pay race that existed when the on-chain deposit had no
// reference to the invoice it was paying.
pub const INVOICE_REGISTRY_PROGRAM_ID: Pubkey =
    pubkey!("54ryi8hcihut8fDSVFSbN5NbArQ5GAd1xgmGCA3hqWoo");

// 8-byte Anchor discriminator for CreatePublicStealthPoolDepositInputBuffer.
// Source: @umbra-privacy/umbra-codama/dist/index.cjs (CREATE_PUBLIC_STEALTH_POOL_DEPOSIT_INPUT_BUFFER_DISCRIMINATOR).
// Independently verified via sha256("global:create_public_stealth_pool_deposit_input_buffer")[0..8].
pub const CREATE_BUFFER_DISCRIMINATOR: [u8; 8] = [139, 135, 169, 216, 228, 15, 104, 98];

// 8-byte Anchor discriminator for DepositIntoStealthPoolFromPublicBalance.
// Source: @umbra-privacy/umbra-codama/dist/index.cjs line 31385:
//   var DEPOSIT_INTO_STEALTH_POOL_FROM_PUBLIC_BALANCE_DISCRIMINATOR =
//       new Uint8Array([232, 133, 25, 16, 203, 167, 3, 3]);
// Independently verified via sha256("global:deposit_into_stealth_pool_from_public_balance")[0..8].
pub const DEPOSIT_DISCRIMINATOR: [u8; 8] = [232, 133, 25, 16, 203, 167, 3, 3];

// 8-byte Anchor discriminator for CreateStealthPoolDepositInputBuffer (the
// SHIELDED variant of the buffer-creation step). Source:
// @umbra-privacy/umbra-codama/dist/index.cjs line 24603:
//   var CREATE_STEALTH_POOL_DEPOSIT_INPUT_BUFFER_DISCRIMINATOR =
//       new Uint8Array([239, 89, 111, 177, 2, 224, 90, 79]);
// Verified independently via
//   sha256("global:create_stealth_pool_deposit_input_buffer")[0..8].
// Different from CREATE_BUFFER_DISCRIMINATOR above — that one is the
// PUBLIC variant (`create_public_stealth_pool_deposit_input_buffer`).
pub const CREATE_SHIELDED_BUFFER_DISCRIMINATOR: [u8; 8] = [239, 89, 111, 177, 2, 224, 90, 79];

// 8-byte Anchor discriminator for DepositIntoStealthPoolFromSharedBalanceV11
// — the SHIELDED-source deposit. Source:
// @umbra-privacy/umbra-codama/dist/index.cjs line 32051:
//   var DEPOSIT_INTO_STEALTH_POOL_FROM_SHARED_BALANCE_V11_DISCRIMINATOR =
//       new Uint8Array([22, 229, 199, 112, 193, 65, 111, 243]);
// Verified independently via
//   sha256("global:deposit_into_stealth_pool_from_shared_balance_v11")[0..8].
// Different ix entirely from DEPOSIT_DISCRIMINATOR above — that one funds
// from public balance, this one consumes shielded balance via Arcium MPC.
pub const DEPOSIT_FROM_SHIELDED_DISCRIMINATOR: [u8; 8] = [22, 229, 199, 112, 193, 65, 111, 243];

// 8-byte Anchor discriminator for invoice_registry::lock_payment_intent.
// Computed as sha256("global:lock_payment_intent")[0..8]. Verified via:
//   node -e "const c=require('crypto'); console.log(JSON.stringify(Array.from(c.createHash('sha256').update('global:lock_payment_intent').digest().slice(0,8))))"
// → [96, 172, 233, 81, 188, 200, 139, 94]
pub const LOCK_PAYMENT_INTENT_DISCRIMINATOR: [u8; 8] = [96, 172, 233, 81, 188, 200, 139, 94];

#[program]
pub mod veil_pay {
    use super::*;

    /// Single-popup private payment via three CPIs to other programs in one tx:
    ///
    ///   1. invoice_registry::lock_payment_intent  — acquires the single-use
    ///      lock PDA for `invoice`. `init` constraint inside invoice-registry
    ///      rejects re-init, so a second pay attempt for the same invoice
    ///      reverts the entire enclosing transaction (including the Umbra
    ///      CPIs below). Closes the double-pay race.
    ///   2. Umbra create_buffer
    ///   3. Umbra deposit
    ///
    /// The lock PDA pays its own rent — funded from the depositor (already
    /// paying tx fees today). Args carry the ZK proof + commitments built
    /// off-chain. All Umbra accounts (~21 total: 4 for create-buffer + 17
    /// for deposit, with overlap) flow through `ctx.remaining_accounts`.
    pub fn pay_invoice(
        ctx: Context<PayInvoice>,
        create_buffer_data: Vec<u8>,
        deposit_data: Vec<u8>,
        create_buffer_account_count: u8,
    ) -> Result<()> {
        require!(create_buffer_data.len() >= 8, VeilPayError::InvalidInstructionData);
        require!(deposit_data.len() >= 8, VeilPayError::InvalidInstructionData);
        require!(
            create_buffer_data[0..8] == CREATE_BUFFER_DISCRIMINATOR,
            VeilPayError::DiscriminatorMismatch
        );
        require!(
            deposit_data[0..8] == DEPOSIT_DISCRIMINATOR,
            VeilPayError::DiscriminatorMismatch
        );

        let total_accounts = ctx.remaining_accounts.len();
        require!(
            (create_buffer_account_count as usize) <= total_accounts,
            VeilPayError::AccountSliceOutOfBounds
        );

        // 1. Lock the payment intent BEFORE any funds movement.
        //    This ensures the lock + deposit are atomic: a second pay
        //    attempt fails at the `init` constraint inside invoice-
        //    registry, reverting the entire tx (including the Umbra
        //    CPIs that follow).
        msg!("veil_pay: 1/3 - lock payment intent");
        invoke_lock_payment_intent(
            &ctx.accounts.invoice,
            &ctx.accounts.lock,
            &ctx.accounts.depositor,
            &ctx.accounts.system_program,
            &ctx.accounts.invoice_registry_program,
        )?;

        let (create_buffer_accounts, deposit_accounts) = ctx
            .remaining_accounts
            .split_at(create_buffer_account_count as usize);

        msg!(
            "veil_pay: 2/3 - create proof buffer ({} accts)",
            create_buffer_accounts.len()
        );
        invoke_with_accounts(
            UMBRA_PROGRAM_ID,
            create_buffer_data,
            create_buffer_accounts,
        )?;

        msg!(
            "veil_pay: 3/3 - deposit into stealth pool ({} accts)",
            deposit_accounts.len()
        );
        invoke_with_accounts(
            UMBRA_PROGRAM_ID,
            deposit_data,
            deposit_accounts,
        )?;

        Ok(())
    }

    /// Single-popup private payment that does NOT bind to an invoice. Used by
    /// the payroll flow where rows are bulk transfers, not invoice payments —
    /// there is nothing to lock against (no Invoice account exists for a
    /// payroll line item) so the invoice-registry CPI is skipped.
    ///
    /// Behavior is identical to the OLD `pay_invoice` (pre-Fix 2): two CPIs
    /// to Umbra (create_buffer + deposit), no lock acquisition. Kept as a
    /// separate entry point so the invoice-payment path can enforce the
    /// double-pay guard at the program level while the payroll path remains
    /// unaffected.
    pub fn pay_no_invoice(
        ctx: Context<PayNoInvoice>,
        create_buffer_data: Vec<u8>,
        deposit_data: Vec<u8>,
        create_buffer_account_count: u8,
    ) -> Result<()> {
        require!(create_buffer_data.len() >= 8, VeilPayError::InvalidInstructionData);
        require!(deposit_data.len() >= 8, VeilPayError::InvalidInstructionData);
        require!(
            create_buffer_data[0..8] == CREATE_BUFFER_DISCRIMINATOR,
            VeilPayError::DiscriminatorMismatch
        );
        require!(
            deposit_data[0..8] == DEPOSIT_DISCRIMINATOR,
            VeilPayError::DiscriminatorMismatch
        );

        let total_accounts = ctx.remaining_accounts.len();
        require!(
            (create_buffer_account_count as usize) <= total_accounts,
            VeilPayError::AccountSliceOutOfBounds
        );

        let (create_buffer_accounts, deposit_accounts) = ctx
            .remaining_accounts
            .split_at(create_buffer_account_count as usize);

        msg!(
            "veil_pay: CPI 1/2 - create proof buffer ({} accts)",
            create_buffer_accounts.len()
        );
        invoke_with_accounts(
            UMBRA_PROGRAM_ID,
            create_buffer_data,
            create_buffer_accounts,
        )?;

        msg!(
            "veil_pay: CPI 2/2 - deposit into stealth pool ({} accts)",
            deposit_accounts.len()
        );
        invoke_with_accounts(
            UMBRA_PROGRAM_ID,
            deposit_data,
            deposit_accounts,
        )?;

        Ok(())
    }

    /// Single-popup CLAIM-LINK private payroll via four operations in one tx:
    ///
    ///   1. invoice_registry::lock_payment_intent CPI     — same as pay_invoice.
    ///   2. SystemProgram::transfer (depositor → shadow)  — funds the shadow's
    ///      lamport float so its registration / deposit / withdraw txs pay
    ///      their own rent + fees.
    ///   3. Umbra create_buffer CPI                       — same as pay_invoice.
    ///   4. Umbra deposit CPI                              — same as pay_invoice,
    ///      targeting the shadow's address as the receiver.
    ///
    /// Why this exists: the previous claim-link path fired TWO Phantom popups
    /// per row (separate fund tx + VeilPay-wrapped deposit tx). Packing the
    /// SOL transfer into the same atomic tx as the deposit cuts that to one
    /// popup. Stays atomic: if the deposit CPI rejects, the SOL transfer is
    /// rolled back too.
    ///
    /// The shadow account is unchecked at the program level because Umbra's
    /// own deposit instruction validates the target address downstream — if
    /// an attacker substitutes a different address here, Umbra's own checks
    /// catch it.
    pub fn pay_invoice_with_shadow_funding(
        ctx: Context<PayInvoiceWithShadowFunding>,
        shadow_lamports: u64,
        create_buffer_data: Vec<u8>,
        deposit_data: Vec<u8>,
        create_buffer_account_count: u8,
    ) -> Result<()> {
        require!(create_buffer_data.len() >= 8, VeilPayError::InvalidInstructionData);
        require!(deposit_data.len() >= 8, VeilPayError::InvalidInstructionData);
        require!(
            create_buffer_data[0..8] == CREATE_BUFFER_DISCRIMINATOR,
            VeilPayError::DiscriminatorMismatch
        );
        require!(
            deposit_data[0..8] == DEPOSIT_DISCRIMINATOR,
            VeilPayError::DiscriminatorMismatch
        );
        require!(shadow_lamports > 0, VeilPayError::InvalidInstructionData);

        let total_accounts = ctx.remaining_accounts.len();
        require!(
            (create_buffer_account_count as usize) <= total_accounts,
            VeilPayError::AccountSliceOutOfBounds
        );

        // 1. Lock the payment intent first (same rationale as pay_invoice).
        msg!("veil_pay: 1/4 - lock payment intent");
        invoke_lock_payment_intent(
            &ctx.accounts.invoice,
            &ctx.accounts.lock,
            &ctx.accounts.depositor,
            &ctx.accounts.system_program,
            &ctx.accounts.invoice_registry_program,
        )?;

        // 2. Fund the shadow account from the depositor's SOL balance.
        //    Atomic with the deposit below — if anything later in this
        //    instruction reverts, the lamports return to the depositor.
        //
        //    Anchor 1.0 changed CpiContext::new's first parameter from
        //    `AccountInfo` to `Pubkey`. The system_program account is
        //    still required for the AccountInfo passthrough that
        //    invoke_signed eventually uses, but the CpiContext wants
        //    just the program id.
        msg!("veil_pay: 2/4 - fund shadow ({} lamports)", shadow_lamports);
        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.key(),
            Transfer {
                from: ctx.accounts.depositor.to_account_info(),
                to: ctx.accounts.shadow.to_account_info(),
            },
        );
        system_program::transfer(cpi_ctx, shadow_lamports)?;

        // 3 + 4. Re-use the same CPI logic as `pay_invoice`. The
        //        create-buffer and deposit account lists flow through
        //        remaining_accounts identically.
        let (create_buffer_accounts, deposit_accounts) = ctx
            .remaining_accounts
            .split_at(create_buffer_account_count as usize);

        msg!(
            "veil_pay: 3/4 - create proof buffer ({} accts)",
            create_buffer_accounts.len()
        );
        invoke_with_accounts(
            UMBRA_PROGRAM_ID,
            create_buffer_data,
            create_buffer_accounts,
        )?;

        msg!(
            "veil_pay: 4/4 - deposit into stealth pool ({} accts)",
            deposit_accounts.len()
        );
        invoke_with_accounts(
            UMBRA_PROGRAM_ID,
            deposit_data,
            deposit_accounts,
        )?;

        Ok(())
    }

    /// Single-popup SHIELDED-source private payment via three CPIs in one tx.
    ///
    /// Mirrors `pay_invoice` (public path) but routes the deposit through
    /// Umbra's `deposit_into_stealth_pool_from_shared_balance_v11`
    /// instruction instead of `deposit_into_stealth_pool_from_public_balance`.
    /// Funds the receiver-claimable UTXO from the depositor's already-
    /// shielded encrypted balance — no plaintext amount leaks at deposit
    /// time.
    ///
    ///   1. invoice_registry::lock_payment_intent  — same atomic lock
    ///      acquisition as the public path. Closes the double-pay race
    ///      and unifies reconciliation across both pay paths.
    ///   2. Umbra create_stealth_pool_deposit_input_buffer
    ///      (CREATE_SHIELDED_BUFFER_DISCRIMINATOR) — writes the proof
    ///      buffer for the v11 deposit.
    ///   3. Umbra deposit_into_stealth_pool_from_shared_balance_v11
    ///      (DEPOSIT_FROM_SHIELDED_DISCRIMINATOR) — queues the Arcium
    ///      MPC computation that ultimately produces the receiver-
    ///      claimable UTXO. Adds 8 Arcium accounts vs. the public path
    ///      (signPda/mxe/mempool/executingPool/computation/compDef/
    ///      cluster/arciumProgram), which propagate via remaining_accounts.
    ///
    /// Shape of args is identical to `pay_invoice` so the frontend
    /// builder's serialisation logic stays uniform across paths.
    ///
    /// Note on Arcium async finalisation: the v11 deposit ENQUEUES an
    /// off-chain MPC computation; the actual encrypted leaf is finalised
    /// asynchronously after our tx confirms. The `PaymentIntentLock`
    /// acquired in step 1 already records "this invoice was attempted",
    /// so the auto-flip-to-Paid reconciliation works whether or not we
    /// wait for MPC finalisation here. The frontend keeps the existing
    /// post-confirm progress UI (same as the legacy SDK shielded flow).
    pub fn pay_invoice_from_shielded(
        ctx: Context<PayInvoiceFromShielded>,
        create_buffer_data: Vec<u8>,
        deposit_data: Vec<u8>,
        create_buffer_account_count: u8,
    ) -> Result<()> {
        require!(create_buffer_data.len() >= 8, VeilPayError::InvalidInstructionData);
        require!(deposit_data.len() >= 8, VeilPayError::InvalidInstructionData);
        require!(
            create_buffer_data[0..8] == CREATE_SHIELDED_BUFFER_DISCRIMINATOR,
            VeilPayError::DiscriminatorMismatch
        );
        require!(
            deposit_data[0..8] == DEPOSIT_FROM_SHIELDED_DISCRIMINATOR,
            VeilPayError::DiscriminatorMismatch
        );

        let total_accounts = ctx.remaining_accounts.len();
        require!(
            (create_buffer_account_count as usize) <= total_accounts,
            VeilPayError::AccountSliceOutOfBounds
        );

        // 1. Lock the payment intent BEFORE any funds movement.
        //    Same atomic guard as `pay_invoice`: a second pay attempt for
        //    the same invoice fails at the `init` constraint inside
        //    invoice-registry and reverts the entire tx (including the
        //    Umbra CPIs that follow), even if those would have otherwise
        //    succeeded.
        msg!("veil_pay: 1/3 - lock payment intent (shielded path)");
        invoke_lock_payment_intent(
            &ctx.accounts.invoice,
            &ctx.accounts.lock,
            &ctx.accounts.depositor,
            &ctx.accounts.system_program,
            &ctx.accounts.invoice_registry_program,
        )?;

        let (create_buffer_accounts, deposit_accounts) = ctx
            .remaining_accounts
            .split_at(create_buffer_account_count as usize);

        msg!(
            "veil_pay: 2/3 - create proof buffer ({} accts, shielded)",
            create_buffer_accounts.len()
        );
        invoke_with_accounts(
            UMBRA_PROGRAM_ID,
            create_buffer_data,
            create_buffer_accounts,
        )?;

        msg!(
            "veil_pay: 3/3 - deposit from shielded balance ({} accts)",
            deposit_accounts.len()
        );
        invoke_with_accounts(
            UMBRA_PROGRAM_ID,
            deposit_data,
            deposit_accounts,
        )?;

        Ok(())
    }
}

fn invoke_with_accounts(
    program_id: Pubkey,
    data: Vec<u8>,
    accounts: &[AccountInfo],
) -> Result<()> {
    let metas: Vec<AccountMeta> = accounts
        .iter()
        .map(|a| {
            if a.is_writable {
                AccountMeta::new(a.key(), a.is_signer)
            } else {
                AccountMeta::new_readonly(a.key(), a.is_signer)
            }
        })
        .collect();

    let ix = Instruction {
        program_id,
        accounts: metas,
        data,
    };

    invoke(&ix, accounts)?;
    Ok(())
}

/// Manually build + invoke `invoice_registry::lock_payment_intent`. We
/// build the `Instruction` ourselves rather than using Anchor's typed
/// CPI so we don't have to take a workspace dep on the
/// `invoice-registry` crate (which would mean either pulling it into
/// veil-pay's Cargo.toml or maintaining a separate `cpi` build-feature
/// surface for it). Mirrors the pattern used by `invoke_with_accounts`
/// for the Umbra CPIs.
///
/// The `LockPaymentIntent` account order in invoice-registry's `Accounts`
/// derive is:
///   0. invoice          (read-only, not a signer)
///   1. lock             (writable, init payer = payer; not a signer)
///   2. payer            (writable, signer)
///   3. system_program   (read-only, not a signer — required by `init`)
fn invoke_lock_payment_intent<'info>(
    invoice: &AccountInfo<'info>,
    lock: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    invoice_registry_program: &AccountInfo<'info>,
) -> Result<()> {
    let metas = vec![
        AccountMeta::new_readonly(invoice.key(), false),
        AccountMeta::new(lock.key(), false),
        AccountMeta::new(payer.key(), true),
        AccountMeta::new_readonly(system_program.key(), false),
    ];

    let ix = Instruction {
        program_id: INVOICE_REGISTRY_PROGRAM_ID,
        accounts: metas,
        data: LOCK_PAYMENT_INTENT_DISCRIMINATOR.to_vec(),
    };

    // The CPI account list must include the program account itself plus
    // every account referenced in `metas`. Solana's runtime scans the list
    // for matching pubkeys and forwards the appropriate AccountInfos.
    invoke(
        &ix,
        &[
            invoice.clone(),
            lock.clone(),
            payer.clone(),
            system_program.clone(),
            invoice_registry_program.clone(),
        ],
    )?;
    Ok(())
}

#[derive(Accounts)]
pub struct PayInvoice<'info> {
    /// The user paying. Must sign the outer tx; signature carries through CPI
    /// to both Umbra calls AND the invoice-registry lock CPI. Marked `mut`
    /// because `lock_payment_intent` debits rent from this wallet for the
    /// new lock PDA.
    #[account(mut)]
    pub depositor: Signer<'info>,
    /// CHECK: the Invoice account being paid. Read-only here; deserialized
    /// + status-checked inside the invoice-registry CPI. We do NOT
    /// `Account<'info, Invoice>`-decode it because that would require a
    /// dep on the invoice-registry crate.
    pub invoice: UncheckedAccount<'info>,
    /// CHECK: the PaymentIntentLock PDA. `init` happens inside the
    /// invoice-registry CPI, which validates the seeds. Marked `mut`
    /// because `init` writes to it.
    #[account(mut)]
    pub lock: UncheckedAccount<'info>,
    /// CHECK: must equal INVOICE_REGISTRY_PROGRAM_ID. Forwarded as the
    /// CPI program id for the lock acquisition.
    #[account(address = INVOICE_REGISTRY_PROGRAM_ID)]
    pub invoice_registry_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: forwarded to Umbra; must equal UMBRA_PROGRAM_ID.
    #[account(address = UMBRA_PROGRAM_ID)]
    pub umbra_program: UncheckedAccount<'info>,
}

/// Account context for the no-invoice payroll path. Identical to the
/// pre-Fix-2 `PayInvoice` shape (no invoice / lock / invoice-registry
/// program — just depositor + umbra_program), so existing payroll
/// callers can be ported by switching the discriminator without
/// reshuffling accounts.
#[derive(Accounts)]
pub struct PayNoInvoice<'info> {
    /// The user paying. Must sign the outer tx; signature carries through CPI.
    pub depositor: Signer<'info>,
    /// CHECK: forwarded to Umbra; must equal UMBRA_PROGRAM_ID.
    #[account(address = UMBRA_PROGRAM_ID)]
    pub umbra_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct PayInvoiceWithShadowFunding<'info> {
    /// The user paying — debits both the shadow funding lamports AND the
    /// public-balance side of the encrypted deposit AND the lock PDA's
    /// rent. Must be `mut` because the SystemProgram::transfer CPI moves
    /// SOL out of this account.
    #[account(mut)]
    pub depositor: Signer<'info>,
    /// CHECK: see PayInvoice.invoice.
    pub invoice: UncheckedAccount<'info>,
    /// CHECK: see PayInvoice.lock.
    #[account(mut)]
    pub lock: UncheckedAccount<'info>,
    /// CHECK: must equal INVOICE_REGISTRY_PROGRAM_ID.
    #[account(address = INVOICE_REGISTRY_PROGRAM_ID)]
    pub invoice_registry_program: UncheckedAccount<'info>,
    /// CHECK: shadow address — receives the SOL transfer. Validated
    /// downstream by Umbra's deposit instruction (which expects this same
    /// address as the deposit's destination), so an attacker substituting
    /// a different address fails the deposit's own checks.
    #[account(mut)]
    pub shadow: UncheckedAccount<'info>,
    /// CHECK: forwarded to Umbra; must equal UMBRA_PROGRAM_ID.
    #[account(address = UMBRA_PROGRAM_ID)]
    pub umbra_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Account context for the SHIELDED-source pay path. Identical fixed shape
/// to `PayInvoice` because the Arcium accounts (mxe / mempool / executing
/// pool / computation / compDef / cluster / arciumProgram / signPda) flow
/// through `remaining_accounts` exactly like the rest of the Umbra account
/// list — they're forwarded as part of the deposit-CPI's account slice and
/// don't need named slots in this struct.
///
/// Keeping the named-account list small means a) the on-chain account-meta
/// table stays compact (helps tx-size), and b) we don't have to maintain a
/// parallel struct that shadows codama's account layout — any future
/// shielded-circuit Arcium-account additions land transparently in
/// remaining_accounts.
#[derive(Accounts)]
pub struct PayInvoiceFromShielded<'info> {
    /// The user paying. Must sign the outer tx; signature carries through
    /// CPI to both Umbra calls AND the invoice-registry lock CPI. Marked
    /// `mut` because `lock_payment_intent` debits rent from this wallet
    /// for the new lock PDA, AND because Umbra's v11 deposit ix lists
    /// `depositor` as writable (consumed by the encrypted-balance debit).
    #[account(mut)]
    pub depositor: Signer<'info>,
    /// CHECK: see PayInvoice.invoice.
    pub invoice: UncheckedAccount<'info>,
    /// CHECK: see PayInvoice.lock.
    #[account(mut)]
    pub lock: UncheckedAccount<'info>,
    /// CHECK: must equal INVOICE_REGISTRY_PROGRAM_ID.
    #[account(address = INVOICE_REGISTRY_PROGRAM_ID)]
    pub invoice_registry_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: forwarded to Umbra; must equal UMBRA_PROGRAM_ID.
    #[account(address = UMBRA_PROGRAM_ID)]
    pub umbra_program: UncheckedAccount<'info>,
}

#[error_code]
pub enum VeilPayError {
    #[msg("Instruction data must include the 8-byte discriminator")]
    InvalidInstructionData,
    #[msg("Instruction discriminator does not match expected Umbra instruction")]
    DiscriminatorMismatch,
    #[msg("Account slice count exceeds remaining_accounts length")]
    AccountSliceOutOfBounds,
}
