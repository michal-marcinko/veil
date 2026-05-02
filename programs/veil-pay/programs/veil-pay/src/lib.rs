use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke,
};

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

#[error_code]
pub enum VeilPayError {
    #[msg("Instruction data must include the 8-byte discriminator")]
    InvalidInstructionData,
    #[msg("Instruction discriminator does not match expected Umbra instruction")]
    DiscriminatorMismatch,
    #[msg("Account slice count exceeds remaining_accounts length")]
    AccountSliceOutOfBounds,
}
