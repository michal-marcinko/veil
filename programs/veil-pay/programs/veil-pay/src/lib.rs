use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke,
};

declare_id!("E2G6dN7yY8VQ2dFRgkvqskdAnPhJXkdorYP6BhKvfa8m");

// Umbra program ID. Devnet for now; mainnet uses UMBRAD2ishebJTcgCLkTkNUx1v3GyoAgpTRPeWoLykh
pub const UMBRA_PROGRAM_ID: Pubkey = pubkey!("DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ");

// 8-byte Anchor discriminator for CreatePublicStealthPoolDepositInputBuffer.
// Source: @umbra-privacy/umbra-codama/dist/index.cjs line 24413
//   var CREATE_PUBLIC_STEALTH_POOL_DEPOSIT_INPUT_BUFFER_DISCRIMINATOR =
//       new Uint8Array([139, 135, 169, 216, 228, 15, 104, 98]);
// Independently verified via sha256("global:create_public_stealth_pool_deposit_input_buffer")[0..8].
pub const CREATE_BUFFER_DISCRIMINATOR: [u8; 8] = [139, 135, 169, 216, 228, 15, 104, 98];

#[program]
pub mod veil_pay {
    use super::*;

    /// Phase 0 probe: CPI into Umbra's CreatePublicStealthPoolDepositInputBuffer
    /// with mock zero proof bytes. Expected to fail at Umbra's proof verification
    /// (= CPI auth layer accepted us = GO). If it fails with a CPI-rejection error
    /// (signer mismatch, cross-program-invocation denial) = NO-GO.
    pub fn probe_create_buffer(
        ctx: Context<ProbeCreateBuffer>,
        _proof_account_offset: u128,
    ) -> Result<()> {
        msg!("veil_pay::probe_create_buffer — invoking Umbra create-buffer with mock data");

        // Build the CPI instruction manually. We can't use Anchor's CPI generator
        // because we don't have Umbra's source crate.
        let mut data = Vec::with_capacity(8 + 256);
        data.extend_from_slice(&CREATE_BUFFER_DISCRIMINATOR);
        // Umbra expects various fields here; for the probe we send mock bytes
        // that will fail proof verification but exercise the auth path.
        data.extend_from_slice(&[0u8; 256]);

        let cpi_ix = Instruction {
            program_id: UMBRA_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(ctx.accounts.depositor.key(), true),
                AccountMeta::new(ctx.accounts.fee_payer.key(), true),
                AccountMeta::new(ctx.accounts.proof_buffer.key(), false),
                AccountMeta::new_readonly(anchor_lang::solana_program::system_program::ID, false),
            ],
            data,
        };

        invoke(
            &cpi_ix,
            &[
                ctx.accounts.depositor.to_account_info(),
                ctx.accounts.fee_payer.to_account_info(),
                ctx.accounts.proof_buffer.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.umbra_program.to_account_info(),
            ],
        )?;

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(_proof_account_offset: u128)]
pub struct ProbeCreateBuffer<'info> {
    pub depositor: Signer<'info>,
    #[account(mut)]
    pub fee_payer: Signer<'info>,
    /// CHECK: This is the proof buffer PDA derived by Umbra. We pass it through
    /// for CPI but don't validate the seeds ourselves — Umbra checks.
    #[account(mut)]
    pub proof_buffer: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: Umbra program ID checked against our hardcoded const at CPI time.
    pub umbra_program: UncheckedAccount<'info>,
}
