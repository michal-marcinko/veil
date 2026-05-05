use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke,
};
use anchor_lang::system_program::{self, Transfer};

declare_id!("E2G6dN7yY8VQ2dFRgkvqskdAnPhJXkdorYP6BhKvfa8m");

// Umbra program ID. Devnet for now; mainnet uses UMBRAD2ishebJTcgCLkTkNUx1v3GyoAgpTRPeWoLykh
pub const UMBRA_PROGRAM_ID: Pubkey = pubkey!("DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ");

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

#[program]
pub mod veil_pay {
    use super::*;

    /// Single-popup private payment via two CPIs to Umbra in one tx.
    ///
    /// Args carry the ZK proof + commitments built off-chain. All Umbra accounts
    /// (~21 total: 4 for create-buffer + 17 for deposit, with overlap) flow
    /// through `ctx.remaining_accounts`.
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

    /// Single-popup CLAIM-LINK private payroll via three operations in one tx:
    ///
    ///   1. SystemProgram::transfer (depositor → shadow)  — funds the shadow's
    ///      lamport float so its registration / deposit / withdraw txs pay
    ///      their own rent + fees.
    ///   2. Umbra create_buffer CPI                       — same as pay_invoice.
    ///   3. Umbra deposit CPI                              — same as pay_invoice,
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

        // 1. Fund the shadow account from the depositor's SOL balance.
        //    Atomic with the deposit below — if anything later in this
        //    instruction reverts, the lamports return to the depositor.
        //
        //    Anchor 1.0 changed CpiContext::new's first parameter from
        //    `AccountInfo` to `Pubkey`. The system_program account is
        //    still required for the AccountInfo passthrough that
        //    invoke_signed eventually uses, but the CpiContext wants
        //    just the program id.
        msg!("veil_pay: 1/3 - fund shadow ({} lamports)", shadow_lamports);
        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.key(),
            Transfer {
                from: ctx.accounts.depositor.to_account_info(),
                to: ctx.accounts.shadow.to_account_info(),
            },
        );
        system_program::transfer(cpi_ctx, shadow_lamports)?;

        // 2 + 3. Re-use the same CPI logic as `pay_invoice`. The
        //        create-buffer and deposit account lists flow through
        //        remaining_accounts identically.
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

#[derive(Accounts)]
pub struct PayInvoice<'info> {
    /// The user paying. Must sign the outer tx; signature carries through CPI.
    pub depositor: Signer<'info>,
    /// CHECK: forwarded to Umbra; must equal UMBRA_PROGRAM_ID.
    #[account(address = UMBRA_PROGRAM_ID)]
    pub umbra_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct PayInvoiceWithShadowFunding<'info> {
    /// The user paying — debits both the shadow funding lamports AND the
    /// public-balance side of the encrypted deposit. Must be `mut` because
    /// the SystemProgram::transfer CPI moves SOL out of this account.
    #[account(mut)]
    pub depositor: Signer<'info>,
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

#[error_code]
pub enum VeilPayError {
    #[msg("Instruction data must include the 8-byte discriminator")]
    InvalidInstructionData,
    #[msg("Instruction discriminator does not match expected Umbra instruction")]
    DiscriminatorMismatch,
    #[msg("Account slice count exceeds remaining_accounts length")]
    AccountSliceOutOfBounds,
}
