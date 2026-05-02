use anchor_lang::prelude::*;

declare_id!("E2G6dN7yY8VQ2dFRgkvqskdAnPhJXkdorYP6BhKvfa8m");

#[program]
pub mod veil_pay {
    use super::*;

    /// Stripped-down stub for Phase 0. Just CPIs to Umbra's create-buffer
    /// to verify CPI is accepted by Umbra's auth layer. Real implementation
    /// in Phase 1 will add the deposit CPI and full arg threading.
    pub fn probe_create_buffer(_ctx: Context<ProbeCreateBuffer>) -> Result<()> {
        msg!("veil_pay::probe_create_buffer — Phase 0 stub");
        Ok(())
    }
}

#[derive(Accounts)]
pub struct ProbeCreateBuffer<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
}
