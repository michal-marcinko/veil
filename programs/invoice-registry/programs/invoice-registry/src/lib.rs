use anchor_lang::prelude::*;

declare_id!("54ryi8hcihut8fDSVFSbN5NbArQ5GAd1xgmGCA3hqWoo");

#[program]
pub mod invoice_registry {
    use super::*;

    pub fn create_invoice(_ctx: Context<CreateInvoice>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct CreateInvoice<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    pub system_program: Program<'info, System>,
}
