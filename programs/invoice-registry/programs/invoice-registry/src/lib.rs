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
