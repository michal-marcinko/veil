// Mock Umbra program — TEST ONLY.
//
// Stand-in for the real Umbra program (DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ)
// during local `anchor test` runs of veil-pay. The real Umbra program requires
// ZK proofs + a full bonsai/circuit setup that is impractical to deploy into
// localnet for a smoke test of veil-pay's CPI routing.
//
// Implementation notes:
//   - We use the raw `solana_program` entrypoint instead of `#[program]` from
//     Anchor on purpose: Anchor's generated dispatcher inserts a runtime
//     `DeclaredProgramIdMismatch` (error code 4100) check that fails when the
//     program is loaded at a different address than its `declare_id!` value.
//     The veil-pay test runner DOES relocate this bytecode (see
//     tests/run.cjs's surfnet_setAccount call), so an Anchor entrypoint would
//     trip the check. Solana's raw runtime does not enforce that constraint.
//   - The mock accepts any account list and inspects only the first 8 bytes
//     of instruction data, logging which discriminator was matched. The bytes
//     after the discriminator are opaque to us and are forwarded by veil-pay
//     verbatim from the test payload.
//   - We still depend on `anchor-lang` so the parent crate's build script
//     pulls us in cleanly, but no Anchor macros are used.

use anchor_lang::solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, msg, pubkey::Pubkey,
};

// Same constants as veil-pay::lib.rs — duplicated here on purpose so the mock
// stays self-contained and won't drift if veil-pay changes.
const CREATE_BUFFER_DISCRIMINATOR: [u8; 8] = [139, 135, 169, 216, 228, 15, 104, 98];
const DEPOSIT_DISCRIMINATOR: [u8; 8] = [232, 133, 25, 16, 203, 167, 3, 3];
// Shielded variants — ix 1 (create_stealth_pool_deposit_input_buffer) and
// ix 2 (deposit_into_stealth_pool_from_shared_balance_v11). VeilPay's
// pay_invoice_from_shielded enforces these on the inner ix data; the mock
// just emits the same "create_buffer hit" / "deposit hit" markers so the
// existing test assertions work uniformly across public and shielded paths.
const CREATE_SHIELDED_BUFFER_DISCRIMINATOR: [u8; 8] = [239, 89, 111, 177, 2, 224, 90, 79];
const DEPOSIT_FROM_SHIELDED_DISCRIMINATOR: [u8; 8] = [22, 229, 199, 112, 193, 65, 111, 243];

entrypoint!(process_instruction);

pub fn process_instruction(
    _program_id: &Pubkey,
    _accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.len() < 8 {
        msg!("mock_umbra: short ix ({} bytes) — accepted", data.len());
        return Ok(());
    }

    let mut disc = [0u8; 8];
    disc.copy_from_slice(&data[..8]);
    if disc == CREATE_BUFFER_DISCRIMINATOR {
        msg!("mock_umbra: create_buffer hit");
    } else if disc == DEPOSIT_DISCRIMINATOR {
        msg!("mock_umbra: deposit hit");
    } else if disc == CREATE_SHIELDED_BUFFER_DISCRIMINATOR {
        msg!("mock_umbra: create_buffer hit (shielded)");
    } else if disc == DEPOSIT_FROM_SHIELDED_DISCRIMINATOR {
        msg!("mock_umbra: deposit hit (shielded)");
    } else {
        msg!("mock_umbra: unknown discriminator — accepted");
    }
    Ok(())
}
