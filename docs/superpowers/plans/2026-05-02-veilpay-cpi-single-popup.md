# VeilPay CPI Single-Popup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce Veil's public-balance pay flow from 2 Phantom popups (with reverted-simulation warnings) to 1 popup with proper "-1 SOL" balance preview, by building a custom Anchor program that CPIs into Umbra's deposit primitives within a single atomic transaction.

**Architecture:** New Anchor program `veil_pay` at `programs/veil-pay/` exposes one instruction `pay_invoice` doing two CPIs to Umbra (`CreatePublicStealthPoolDepositInputBuffer` + `DepositIntoStealthPoolFromPublicBalance`). Client wrapper at `app/src/lib/payInvoiceCpi.ts` calls existing SDK proof generation, then builds a single tx targeting our program (instead of SDK's two-tx orchestration). Behind feature flag `USE_VEIL_PAY_CPI` for instant fallback.

**Tech Stack:** Anchor 0.29+ (Rust on-chain), `solana_program` for raw CPI, `@umbra-privacy/sdk` 2.1.1 (proof generation), `@umbra-privacy/umbra-codama` (instruction builders), `@solana/web3.js` (tx construction), Next.js 14 (existing app shell).

**Spec:** `docs/superpowers/specs/2026-05-02-veilpay-cpi-single-popup-design.md`

---

## File structure

**Files to create:**
- `programs/veil-pay/Cargo.toml` — new Anchor crate manifest
- `programs/veil-pay/Xargo.toml` — Solana build config
- `programs/veil-pay/src/lib.rs` — program with `pay_invoice` instruction
- `programs/veil-pay/tests/veil_pay.ts` — Anchor TS integration test
- `app/src/lib/payInvoiceCpi.ts` — client wrapper (~250 LOC)
- `app/src/lib/__tests__/payInvoiceCpi.test.ts` — unit tests for tx construction

**Files to modify:**
- `Anchor.toml` (root) — register new `veil_pay` program in workspace
- `app/src/lib/umbra.ts:615-642` — `payInvoice` becomes feature-flag delegator
- `app/src/lib/constants.ts` — add `VEIL_PAY_PROGRAM_ID` export
- `app/.env.example` — document `NEXT_PUBLIC_VEIL_PAY_PROGRAM_ID`

**No-touch (verify behavior unchanged):**
- `app/src/app/pay/[id]/page.tsx` — uses `payInvoice` from umbra.ts unchanged
- Recipient-side scan/claim/mark_paid — protocol-unchanged

---

## Phase 0: Risk verification (TASKS 1-3 — verify CPI is allowed before investing days)

The biggest unknown: does Umbra's compiled program accept CPI from a non-Umbra caller? Static analysis says 70% likely yes. Phase 0 builds a **stripped-down VeilPay** with just the buffer-create CPI (no real proof, mock zero bytes) and deploys it to devnet to verify with real on-chain execution. If CPI is rejected → pivot to fallback (client-side composition without on-chain program). If accepted → proceed to Phase 1.

### Task 1: Initialize Anchor crate scaffold

**Files:**
- Create: `programs/veil-pay/Cargo.toml`
- Create: `programs/veil-pay/Xargo.toml`
- Create: `programs/veil-pay/src/lib.rs`
- Modify: `Anchor.toml` (workspace registration)

- [ ] **Step 1: Verify Anchor toolchain is available**

Run from `C:\Users\marci\Desktop\veil`:
```bash
anchor --version
```
Expected output: `anchor-cli 0.29.0` (or newer). If missing, install via `cargo install --git https://github.com/coral-xyz/anchor avm --locked && avm install 0.29.0 && avm use 0.29.0`.

- [ ] **Step 2: Inspect existing Anchor workspace structure**

```bash
cat Anchor.toml
ls programs/invoice-registry/
```

Note the existing pattern. The `programs/` directory holds Anchor crates, root `Anchor.toml` lists them under `[programs.localnet]`, `[programs.devnet]`, etc.

- [ ] **Step 3: Generate a fresh program keypair for veil_pay**

```bash
mkdir -p programs/veil-pay
solana-keygen new --no-bip39-passphrase --force --outfile target/deploy/veil_pay-keypair.json
solana address -k target/deploy/veil_pay-keypair.json
```

Save the printed address — this is the VeilPay program ID. Call it `VEIL_PAY_PROGRAM_ID_PLACEHOLDER` for now.

- [ ] **Step 4: Create programs/veil-pay/Cargo.toml**

Write this content (replace `VEIL_PAY_PROGRAM_ID_PLACEHOLDER` with the actual address from Step 3):

```toml
[package]
name = "veil-pay"
version = "0.1.0"
description = "Veil's CPI wrapper for Umbra deposits — single-popup private payments"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]
name = "veil_pay"

[features]
no-entrypoint = []
no-idl = []
no-log-ix-name = []
cpi = ["no-entrypoint"]
default = []

[dependencies]
anchor-lang = "0.29.0"
solana-program = "1.18.0"
```

- [ ] **Step 5: Create programs/veil-pay/Xargo.toml**

```toml
[target.bpfel-unknown-unknown.dependencies.std]
features = []
```

- [ ] **Step 6: Create minimal programs/veil-pay/src/lib.rs**

```rust
use anchor_lang::prelude::*;

declare_id!("VEIL_PAY_PROGRAM_ID_PLACEHOLDER");

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
```

Replace `VEIL_PAY_PROGRAM_ID_PLACEHOLDER` with the address from Step 3.

- [ ] **Step 7: Register program in root Anchor.toml**

Modify `Anchor.toml`. Find the `[programs.devnet]` section (or add it if missing) and add:
```toml
[programs.devnet]
invoice_registry = "54ryi8hcihut8fDSVFSbN5NbArQ5GAd1xgmGCA3hqWoo"  # existing
veil_pay = "VEIL_PAY_PROGRAM_ID_PLACEHOLDER"  # add this line
```

Also update `[programs.localnet]` if present, mirroring the same.

In the `[workspace]` section:
```toml
[workspace]
members = ["programs/*"]
```

(If `members = ["programs/invoice-registry"]` is hardcoded, change to `programs/*` to pick up the new crate.)

- [ ] **Step 8: Verify it builds**

Run from repo root:
```bash
anchor build
```

Expected: builds successfully, produces `target/deploy/veil_pay.so` and an IDL at `target/idl/veil_pay.json`.

If build fails: most likely a Cargo.toml or Anchor.toml mismatch. Compare to `programs/invoice-registry/Cargo.toml` for the working pattern.

- [ ] **Step 9: Commit**

```bash
git add programs/veil-pay/ Anchor.toml
git commit -m "scaffold: veil_pay Anchor crate with probe_create_buffer stub"
```

---

### Task 2: Implement Phase 0 CPI probe

**Files:**
- Modify: `programs/veil-pay/src/lib.rs`

The stub from Task 1 just logs. Now we add the actual CPI to Umbra's `CreatePublicStealthPoolDepositInputBuffer` with mock zero proof bytes. The goal: verify the CPI reaches Umbra's verifier (mock data will fail there, but the CALL itself succeeds = ✅ CPI works).

- [ ] **Step 1: Find Umbra's instruction discriminator**

In `app/node_modules/@umbra-privacy/umbra-codama/dist/index.cjs`, search for `getCreatePublicStealthPoolDepositInputBufferInstructionDataEncoder`. Around the function definition you'll find a byte array — the 8-byte Anchor discriminator for the instruction.

```bash
grep -n -A 30 "getCreatePublicStealthPoolDepositInputBufferInstructionDataEncoder" app/node_modules/@umbra-privacy/umbra-codama/dist/index.cjs | head -50
```

Look for a line like `getStructEncoder([['discriminator', getBytesEncoder({size:8})], ...])` followed by an `addEncoderSizePrefix` or a hardcoded bytes default. The discriminator bytes look like 8 hex pairs. Note them down.

- [ ] **Step 2: Find the buffer PDA seeds**

Search for `accounts.publicStealthPoolDepositInputBuffer.value = await kit.getProgramDerivedAddress` in the same codama file:
```bash
grep -n -B 1 -A 15 "publicStealthPoolDepositInputBuffer.value = await kit.getProgramDerivedAddress" app/node_modules/@umbra-privacy/umbra-codama/dist/index.cjs | head -60
```

The seeds are: `[<32-byte SEED constant>, <16-byte instructionSeed>, depositor.toBuffer(), <16-byte offset LE>]`. Copy the SEED constant bytes and the instructionSeed bytes into Step 4's Rust source.

- [ ] **Step 3: Find Umbra's full account list for the instruction**

In `app/node_modules/@umbra-privacy/umbra-codama/dist/index.d.ts`, search around line 16799 for `CreatePublicStealthPoolDepositInputBufferInstructionAccounts` interface. Note the order:
- depositor (signer, ro)
- feePayer (signer, rw)
- publicStealthPoolDepositInputBuffer (writable PDA)
- systemProgram (readonly)

This is the order the CPI instruction needs.

- [ ] **Step 4: Replace probe_create_buffer with real CPI**

Replace the body of `programs/veil-pay/src/lib.rs` with:

```rust
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke,
};

declare_id!("VEIL_PAY_PROGRAM_ID_PLACEHOLDER");

// Umbra program ID. Devnet for now; mainnet uses UMBRAD2ishebJTcgCLkTkNUx1v3GyoAgpTRPeWoLykh
pub const UMBRA_PROGRAM_ID: Pubkey = pubkey!("DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ");

// 8-byte Anchor discriminator for CreatePublicStealthPoolDepositInputBuffer.
// Source: @umbra-privacy/umbra-codama/dist/index.cjs (search for the encoder definition).
// REPLACE WITH ACTUAL BYTES FROM TASK 2 STEP 1
pub const CREATE_BUFFER_DISCRIMINATOR: [u8; 8] = [0; 8];

#[program]
pub mod veil_pay {
    use super::*;

    /// Phase 0 probe: CPI into Umbra's CreatePublicStealthPoolDepositInputBuffer
    /// with mock zero proof bytes. Expected to fail at Umbra's proof verification
    /// (= CPI auth layer accepted us = GO). If it fails with a CPI-rejection error
    /// (signer mismatch, cross-program-invocation denial) = NO-GO, pivot to fallback.
    pub fn probe_create_buffer(
        ctx: Context<ProbeCreateBuffer>,
        proof_account_offset: u128,
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
#[instruction(proof_account_offset: u128)]
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
```

**Replace `VEIL_PAY_PROGRAM_ID_PLACEHOLDER` and `CREATE_BUFFER_DISCRIMINATOR` with actual values from Steps 1-3.**

- [ ] **Step 5: Build**

```bash
anchor build
```

Expected: builds. If errors about `pubkey!` macro: it's only in newer anchor versions. Use `Pubkey::from_str(...).unwrap()` in a `lazy_static` block or a const helper instead.

- [ ] **Step 6: Commit**

```bash
git add programs/veil-pay/src/lib.rs
git commit -m "feat(veil-pay): Phase 0 probe — CPI to Umbra create-buffer with mock data"
```

---

### Task 3: Deploy probe to devnet and verify CPI

**Files:**
- Create: `programs/veil-pay/tests/probe.ts`

- [ ] **Step 1: Configure Anchor for devnet**

```bash
solana config set --url devnet
solana address  # confirm wallet
solana balance  # need at least 5 SOL — airdrop if needed: solana airdrop 5
```

If airdrop is rate-limited, use a faucet UI: https://faucet.solana.com

- [ ] **Step 2: Deploy veil_pay to devnet**

```bash
anchor deploy --provider.cluster devnet --program-name veil_pay
```

Expected output ends with `Deploy success`. Note the printed program ID — it should match the address from Task 1 Step 3.

If deploy fails with "insufficient funds": airdrop more SOL.

If deploy fails with "program already exists from a previous deploy": that's fine, it's an upgrade.

- [ ] **Step 3: Write probe TS test**

Create `programs/veil-pay/tests/probe.ts`:

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { VeilPay } from "../target/types/veil_pay";
import { PublicKey, SystemProgram, Keypair } from "@solana/web3.js";

describe("veil_pay Phase 0 probe", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.VeilPay as Program<VeilPay>;

  const UMBRA_PROGRAM_ID = new PublicKey(
    "DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ"
  );

  it("CPI to Umbra create-buffer reaches the verifier (proof error = GO)", async () => {
    const depositor = provider.wallet.publicKey;

    // Derive buffer PDA using Umbra's seeds. Constants from
    // @umbra-privacy/umbra-codama/dist/index.cjs.
    // REPLACE WITH ACTUAL SEED BYTES FROM TASK 2
    const SEED_CONST = Buffer.from([0]);  // 32 bytes
    const INSTRUCTION_SEED = Buffer.from([0]);  // 16 bytes
    const offsetBytes = Buffer.alloc(16, 0);

    const [bufferPda] = PublicKey.findProgramAddressSync(
      [SEED_CONST, INSTRUCTION_SEED, depositor.toBuffer(), offsetBytes],
      UMBRA_PROGRAM_ID
    );

    try {
      const tx = await program.methods
        .probeCreateBuffer(new anchor.BN(0))
        .accounts({
          depositor,
          feePayer: depositor,
          proofBuffer: bufferPda,
          systemProgram: SystemProgram.programId,
          umbraProgram: UMBRA_PROGRAM_ID,
        })
        .rpc({ commitment: "confirmed" });

      console.log("UNEXPECTED success:", tx);
    } catch (err: any) {
      console.log("\n=== PROBE RESULT ===\n");
      console.log("Error message:", err.message);
      if (err.logs) {
        console.log("\n=== Program logs ===\n");
        err.logs.forEach((l: string) => console.log(l));
      }
      console.log("\n=== INTERPRETATION ===\n");
      const logs = (err.logs || []).join("\n");
      if (logs.includes("DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ invoke")) {
        console.log("✅ GO — CPI reached Umbra. Error is from proof verification (expected with mock data).");
      } else if (logs.includes("Cross-program invocation") || logs.includes("MissingRequiredSignature")) {
        console.log("❌ NO-GO — CPI was rejected. Pivot to fallback path.");
      } else {
        console.log("⚠️  INCONCLUSIVE — investigate logs above.");
      }
    }
  });
});
```

Replace `SEED_CONST` and `INSTRUCTION_SEED` placeholder bytes with actual values from Task 2 Step 2.

- [ ] **Step 4: Run the probe**

```bash
anchor test --provider.cluster devnet --skip-local-validator --skip-deploy --skip-build
```

Read the `INTERPRETATION` line at the end:
- ✅ GO → proceed to Phase 1
- ❌ NO-GO → STOP, run the fallback decision flow at end of plan
- ⚠️ INCONCLUSIVE → paste full logs back to the user, ask for guidance

- [ ] **Step 5: Commit + decision gate**

```bash
git add programs/veil-pay/tests/probe.ts
git commit -m "test(veil-pay): Phase 0 probe verifies CPI auth layer"
```

**🚦 DECISION GATE:** Stop here and report Phase 0 result to user before continuing. If GO, proceed to Phase 1 with confirmed feasibility. If NO-GO, run the fallback path documented at the end of this plan.

---

## Phase 1: Full VeilPay program (TASKS 4-7)

Phase 0 verified the CPI auth path works. Now build the production version: real arg signature, both CPIs (create-buffer + deposit), proper account threading via `remaining_accounts`.

### Task 4: Define full pay_invoice instruction signature

**Files:**
- Modify: `programs/veil-pay/src/lib.rs`

- [ ] **Step 1: Find Umbra's deposit instruction account list**

In `app/node_modules/@umbra-privacy/umbra-codama/dist/index.d.ts`, search around line 19460 for `DepositIntoStealthPoolFromPublicBalanceInstructionAccounts`. Note the full account list (~17 accounts). This is what we'll thread via `remaining_accounts`.

- [ ] **Step 2: Find the deposit instruction discriminator**

```bash
grep -n -A 30 "getDepositIntoStealthPoolFromPublicBalanceInstructionDataEncoder" app/node_modules/@umbra-privacy/umbra-codama/dist/index.cjs | head -50
```

Note the 8-byte discriminator.

- [ ] **Step 3: Replace src/lib.rs with full implementation**

```rust
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke,
};

declare_id!("VEIL_PAY_PROGRAM_ID_PLACEHOLDER");

pub const UMBRA_PROGRAM_ID: Pubkey = pubkey!("DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ");

// REPLACE BOTH WITH ACTUAL BYTES FROM CODAMA BUNDLE
pub const CREATE_BUFFER_DISCRIMINATOR: [u8; 8] = [0; 8];
pub const DEPOSIT_DISCRIMINATOR: [u8; 8] = [0; 8];

#[program]
pub mod veil_pay {
    use super::*;

    /// Single-popup private payment via two CPIs to Umbra in one tx.
    ///
    /// Args carry the ZK proof + commitments built off-chain. All Umbra accounts
    /// (~21 total: 4 for create-buffer + 17 for deposit, with overlap) flow
    /// through `ctx.remaining_accounts` in the order documented at the top of
    /// `app/src/lib/payInvoiceCpi.ts`.
    pub fn pay_invoice(
        ctx: Context<PayInvoice>,
        create_buffer_data: Vec<u8>,    // pre-serialized instruction data (incl. discriminator)
        deposit_data: Vec<u8>,           // pre-serialized instruction data (incl. discriminator)
        create_buffer_account_count: u8, // how many of remaining_accounts go to create-buffer
    ) -> Result<()> {
        require!(create_buffer_data.len() >= 8, VeilPayError::InvalidInstructionData);
        require!(deposit_data.len() >= 8, VeilPayError::InvalidInstructionData);
        require_eq!(
            &create_buffer_data[0..8],
            &CREATE_BUFFER_DISCRIMINATOR,
            VeilPayError::DiscriminatorMismatch
        );
        require_eq!(
            &deposit_data[0..8],
            &DEPOSIT_DISCRIMINATOR,
            VeilPayError::DiscriminatorMismatch
        );

        let total_accounts = ctx.remaining_accounts.len();
        require!(
            (create_buffer_account_count as usize) < total_accounts,
            VeilPayError::AccountSliceOutOfBounds
        );

        let (create_buffer_accounts, deposit_accounts) = ctx
            .remaining_accounts
            .split_at(create_buffer_account_count as usize);

        msg!("veil_pay: CPI 1/2 — create proof buffer");
        invoke_with_accounts(
            UMBRA_PROGRAM_ID,
            create_buffer_data,
            create_buffer_accounts,
        )?;

        msg!("veil_pay: CPI 2/2 — deposit into stealth pool");
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
```

Replace placeholders with real values from Steps 1-2.

- [ ] **Step 4: Build**

```bash
anchor build
```

Expected: builds. If `pubkey!` errors: replace with `Pubkey::new_from_array([...])` using the base58-decoded bytes.

- [ ] **Step 5: Commit**

```bash
git add programs/veil-pay/src/lib.rs
git commit -m "feat(veil-pay): full pay_invoice instruction with two-CPI body"
```

---

### Task 5: Deploy veil_pay v1 to devnet

- [ ] **Step 1: Deploy upgrade**

```bash
anchor deploy --provider.cluster devnet --program-name veil_pay
```

Expected: deploy succeeds, same program ID as Phase 0 (Anchor reuses the keypair).

- [ ] **Step 2: Verify on devnet**

```bash
solana program show <PROGRAM_ID> --url devnet
```

Expected: shows program info with last-deployed slot recent.

- [ ] **Step 3: Set env var locally**

Add to `app/.env.local`:
```
NEXT_PUBLIC_VEIL_PAY_PROGRAM_ID=<PROGRAM_ID>
```

Add same line to `app/.env.example` (no real value, just key + comment):
```
# Veil's CPI wrapper for single-popup payments. Get from `solana address -k target/deploy/veil_pay-keypair.json` after deploy.
NEXT_PUBLIC_VEIL_PAY_PROGRAM_ID=
```

- [ ] **Step 4: Commit**

```bash
git add app/.env.example
git commit -m "feat: register VEIL_PAY_PROGRAM_ID env var"
```

---

### Task 6: Add VEIL_PAY_PROGRAM_ID to constants

**Files:**
- Modify: `app/src/lib/constants.ts`

- [ ] **Step 1: Find existing INVOICE_REGISTRY_PROGRAM_ID pattern**

```bash
grep -n "INVOICE_REGISTRY_PROGRAM_ID\|PROGRAM_ID" app/src/lib/constants.ts
```

- [ ] **Step 2: Add VEIL_PAY_PROGRAM_ID alongside**

In `app/src/lib/constants.ts`, after the `INVOICE_REGISTRY_PROGRAM_ID` block:

```typescript
// VeilPay CPI wrapper — see programs/veil-pay/src/lib.rs.
// Optional: when unset, payInvoice falls back to SDK's stock orchestration (2 popups).
export const VEIL_PAY_PROGRAM_ID: PublicKey | null = (() => {
  const raw = process.env.NEXT_PUBLIC_VEIL_PAY_PROGRAM_ID;
  if (!raw) return null;
  try {
    return new PublicKey(raw);
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[Veil] NEXT_PUBLIC_VEIL_PAY_PROGRAM_ID is set but not a valid Pubkey — ignoring");
    return null;
  }
})();
```

- [ ] **Step 3: Type-check**

```bash
cd app && npx tsc --noEmit
```

Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/constants.ts
git commit -m "feat(constants): expose VEIL_PAY_PROGRAM_ID with safe-null fallback"
```

---

### Task 7: Smoke-test full instruction with mock data on devnet

**Files:**
- Modify: `programs/veil-pay/tests/probe.ts`

We need to verify the full `pay_invoice` instruction shape works (errors in Umbra's verifier, not in our routing) before writing the client wrapper.

- [ ] **Step 1: Update probe test to call pay_invoice with mock data**

Replace the test body with:

```typescript
it("pay_invoice routes both CPIs in order — proof errors expected with mock data", async () => {
  const depositor = provider.wallet.publicKey;

  // Build mock instruction data: discriminator + zero filler
  const createBufferData = Buffer.concat([
    Buffer.from([/* CREATE_BUFFER_DISCRIMINATOR bytes */]),
    Buffer.alloc(256, 0),
  ]);
  const depositData = Buffer.concat([
    Buffer.from([/* DEPOSIT_DISCRIMINATOR bytes */]),
    Buffer.alloc(128, 0),
  ]);

  // Mock account list — a few zero pubkeys to test routing only.
  // Real test uses computed PDAs; for routing-shape verification, garbage is fine.
  const mockAccounts = Array.from({ length: 21 }, () =>
    Keypair.generate().publicKey
  );

  try {
    const tx = await program.methods
      .payInvoice(createBufferData, depositData, 4) // 4 accounts to create-buffer, rest to deposit
      .accounts({
        depositor,
        umbraProgram: UMBRA_PROGRAM_ID,
      })
      .remainingAccounts(
        mockAccounts.map((pubkey, i) => ({
          pubkey,
          isWritable: i % 2 === 0,
          isSigner: false,
        }))
      )
      .rpc({ commitment: "confirmed" });
    console.log("UNEXPECTED success:", tx);
  } catch (err: any) {
    console.log("=== Routing test result ===");
    if (err.logs) err.logs.forEach((l: string) => console.log(l));
    console.log("\n=== INTERPRETATION ===");
    const logs = (err.logs || []).join("\n");
    if (logs.includes("veil_pay: CPI 1/2") && logs.includes("DSuKky")) {
      console.log("✅ Routing works — got into create-buffer CPI. Mock data fails as expected.");
    } else if (logs.includes("veil_pay: CPI 1/2")) {
      console.log("⚠️ Got past our msg! but Umbra didn't run — check account list.");
    } else {
      console.log("❌ Failed before our log — instruction shape issue.");
    }
  }
});
```

- [ ] **Step 2: Run**

```bash
anchor test --provider.cluster devnet --skip-local-validator --skip-deploy --skip-build
```

Expected: ✅ Routing works message. Mock data fails Umbra's verifier (which is fine — proves CPI is reaching it).

- [ ] **Step 3: Commit**

```bash
git add programs/veil-pay/tests/probe.ts
git commit -m "test(veil-pay): verify pay_invoice routes both CPIs to Umbra"
```

---

## Phase 2: Client wrapper (TASKS 8-13)

Build `payInvoiceCpi.ts`. Use the SDK's PROOF GENERATION via the lower-level prover export, then build instructions via codama, then construct a single tx targeting VeilPay.

### Task 8: Recon the SDK pay function

**Files:**
- Create: `docs/superpowers/notes/2026-05-02-sdk-pay-function-recon.md` (recon notes for the next tasks)

- [ ] **Step 1: Read SDK pay function for the public-balance path**

Open `app/node_modules/@umbra-privacy/sdk/dist/index.cjs` and find `function getPublicBalanceToReceiverClaimableUtxoCreatorFunction` (around line 8842).

Read lines 8842 through 9347. Identify these blocks:
- Account info fetching (receiver user account, mxe, etc.)
- Master seed access via `client.masterSeed.getMasterSeed()`
- Key derivations (mvk, second viewing key, ECDH shared secret)
- Random generation (offsets, nullifiers)
- Encryption (Poseidon, AES, keystream)
- Proof input construction
- Prover call: `await deps.zkProver.prove(zkCircuitInputs)` (around line 9176)
- Two `buildAndSendTransaction` calls (around 9287 and 9309)

- [ ] **Step 2: Document findings**

Create `docs/superpowers/notes/2026-05-02-sdk-pay-function-recon.md`:

```markdown
# SDK pay function recon (lines 8842-9347 of @umbra-privacy/sdk index.cjs)

## Reusable as-is (call SDK helpers directly)
- `getPublicBalanceToReceiverClaimableUtxoCreatorFunction` — DON'T call this whole thing, but its sub-helpers are exposed
- `getCreateReceiverClaimableUtxoFromPublicBalanceProver` from `@umbra-privacy/web-zk-prover` — use directly
- `umbraCodama.getCreatePublicStealthPoolDepositInputBufferInstructionAsync` — use to build ix
- `umbraCodama.getDepositIntoStealthPoolFromPublicBalanceInstructionAsync` — use to build ix

## Need to vendor / re-derive ourselves
- masterSeed access: `client.masterSeed.getMasterSeed()` — call directly
- generationIndex random U256 — call SDK's `chunkZY3TSHMJ_cjs.generateRandomU256` if exposed, else port the kmac256 logic
- modifiedGenerationIndex via kmac256 — port if SDK doesn't expose
- proofAccountOffset derivation — port (~10 lines)
- All key derivers (`getMasterViewingKeyDeriver`, `getPoseidonPrivateKeyDeriver`, etc.) — exposed via SDK exports

## Key insight
Most of the "vendor 330 LOC" worry was overblown. The SDK exposes ALL the building blocks at the top level. Our `payInvoiceCpi.ts` just needs to ORCHESTRATE them differently:
1. Call the same key derivers + ECDH + encryption helpers SDK uses internally
2. Call the prover directly (not through the orchestrator)
3. Use codama to build the two ix shapes (we don't submit them — just need their `accounts` and `data` to forward to VeilPay)
4. Combine into one tx targeting VeilPay
```

- [ ] **Step 3: Verify which SDK helpers are actually exported**

```bash
grep -n "^exports\." app/node_modules/@umbra-privacy/sdk/dist/index.cjs | grep -iE "prove|deriv|encrypt|generate|encode" | head -30
```

Update the recon doc with the actual exported names.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/notes/
git commit -m "docs: SDK pay function recon for payInvoiceCpi.ts"
```

---

### Task 9: Implement payInvoiceCpi — proof generation

**Files:**
- Create: `app/src/lib/payInvoiceCpi.ts`

- [ ] **Step 1: Create the file scaffold**

```typescript
/**
 * payInvoiceCpi — single-popup public-balance pay path.
 *
 * Replaces the SDK's `getPublicBalanceToReceiverClaimableUtxoCreatorFunction`
 * orchestration (which does build → sign → submit twice) with a single tx
 * targeting our `veil_pay::pay_invoice` instruction. The SDK's proof-gen
 * helpers are reused as-is — only the orchestration tail is forked.
 *
 * See: docs/superpowers/specs/2026-05-02-veilpay-cpi-single-popup-design.md
 */

import { PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import type { PayInvoiceArgs, PayInvoiceResult } from "./umbra";
import { VEIL_PAY_PROGRAM_ID } from "./constants";

export class VeilPayNotConfiguredError extends Error {
  constructor() {
    super("VEIL_PAY_PROGRAM_ID env var not set — cannot use single-popup path. Falling back to SDK.");
  }
}

export async function payInvoiceCpi(args: PayInvoiceArgs): Promise<PayInvoiceResult> {
  if (!VEIL_PAY_PROGRAM_ID) throw new VeilPayNotConfiguredError();

  // Steps:
  // 1. Generate proof + commitments via SDK helpers (Task 9 Step 2)
  // 2. Build the two Umbra instructions via codama (Task 10)
  // 3. Compose into one tx targeting VeilPay (Task 11)
  // 4. Sign once, submit (Task 11)
  throw new Error("Not yet implemented — Tasks 9-11");
}
```

- [ ] **Step 2: Implement proof generation by mirroring SDK lines 8864-9176**

Read the SDK source carefully and inline-port the steps. The shape (using actual function names from the recon doc):

```typescript
import {
  // ... whatever the recon found is exported
} from "@umbra-privacy/sdk";
import { getCreateReceiverClaimableUtxoFromPublicBalanceProver } from "@umbra-privacy/web-zk-prover";

async function generateProofAndCommitments(args: PayInvoiceArgs) {
  const { client, recipientAddress, mint, amount } = args;

  // 1. Master seed (existing pattern from app/src/lib/umbra.ts)
  const masterSeed = await client.masterSeed.getMasterSeed();

  // 2. Generation index (random U256)
  // Port from SDK lines ~8870-8895
  // ... (paste verbatim from SDK source, rewriting imports)

  // 3. Key derivations
  // ... (use exposed SDK helpers from recon)

  // 4. Encryption blobs
  // ...

  // 5. Build prover inputs
  const zkProver = getCreateReceiverClaimableUtxoFromPublicBalanceProver({
    assetProvider: /* see umbra.ts proxiedAssetProvider */,
  });
  const proof = await zkProver.prove(zkCircuitInputs);

  return {
    proof,
    /* all the derived blobs */,
    /* all the account addresses needed */,
  };
}
```

This step is ~80 LOC. Take the time to map each SDK line to a TS line. **DO NOT skip the recon doc — without it, this step balloons to a day of debugging.**

- [ ] **Step 3: Type-check**

```bash
cd app && npx tsc --noEmit
```

Fix any type errors. Common: kit version drift (search for `@solana/kit` import patterns in existing umbra.ts to see how they handle it).

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/payInvoiceCpi.ts
git commit -m "feat(payInvoiceCpi): proof generation extracted from SDK orchestration"
```

---

### Task 10: Implement payInvoiceCpi — build Umbra instructions via codama

**Files:**
- Modify: `app/src/lib/payInvoiceCpi.ts`

- [ ] **Step 1: Add codama imports**

```typescript
import {
  getCreatePublicStealthPoolDepositInputBufferInstructionAsync,
  getDepositIntoStealthPoolFromPublicBalanceInstructionAsync,
} from "@umbra-privacy/umbra-codama";
```

- [ ] **Step 2: Build both instructions using the proof + commitments from Task 9**

After the `generateProofAndCommitments` call:

```typescript
const createBufferIx = await getCreatePublicStealthPoolDepositInputBufferInstructionAsync({
  depositor: createNoopSigner(client.signer.address),
  feePayer: createNoopSigner(client.signer.address),
  proofA: proof.proofA,
  proofB: proof.proofB,
  proofC: proof.proofC,
  // ... all other args from the recon
});

const depositIx = await getDepositIntoStealthPoolFromPublicBalanceInstructionAsync({
  depositor: createNoopSigner(client.signer.address),
  feePayer: createNoopSigner(client.signer.address),
  mint,
  // ... all required args
});
```

- [ ] **Step 3: Type-check**

```bash
cd app && npx tsc --noEmit
```

If kit version drift hits: try importing from `@umbra-privacy/sdk` re-exports instead of direct codama.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/payInvoiceCpi.ts
git commit -m "feat(payInvoiceCpi): build Umbra instructions via codama"
```

---

### Task 11: Implement payInvoiceCpi — compose VeilPay tx and sign once

**Files:**
- Modify: `app/src/lib/payInvoiceCpi.ts`

- [ ] **Step 1: Build the VeilPay instruction wrapping both Umbra ix**

```typescript
import { TransactionInstruction, PublicKey } from "@solana/web3.js";

// VeilPay's pay_invoice discriminator. Anchor's discriminator is sha256("global:pay_invoice")[0..8]
// Get the value by running `anchor idl fetch <VEIL_PAY_PROGRAM_ID> --provider.cluster devnet`
// then reading the `discriminator` field for the `payInvoice` instruction.
const VEIL_PAY_PAY_INVOICE_DISCRIMINATOR = Buffer.from([/* 8 bytes */]);

function buildVeilPayInstruction(
  createBufferIx: any,    // codama-built
  depositIx: any,         // codama-built
  depositorPubkey: PublicKey,
): TransactionInstruction {
  // VeilPay arg layout (matches programs/veil-pay/src/lib.rs):
  //   create_buffer_data: Vec<u8>
  //   deposit_data: Vec<u8>
  //   create_buffer_account_count: u8
  const createBufferData = serializeCodamaIx(createBufferIx);  // see helper below
  const depositData = serializeCodamaIx(depositIx);
  const createBufferAccountCount = createBufferIx.accounts.length;

  const data = Buffer.concat([
    VEIL_PAY_PAY_INVOICE_DISCRIMINATOR,
    encodeVecU8(createBufferData),  // Borsh: u32 len + bytes
    encodeVecU8(depositData),
    Buffer.from([createBufferAccountCount]),
  ]);

  return new TransactionInstruction({
    programId: VEIL_PAY_PROGRAM_ID!,
    keys: [
      { pubkey: depositorPubkey, isSigner: true, isWritable: false },
      { pubkey: new PublicKey("DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ"), isSigner: false, isWritable: false },
      // remaining_accounts: union of both Umbra ix account lists
      ...createBufferIx.accounts.map(toAccountMeta),
      ...depositIx.accounts.map(toAccountMeta),
    ],
    data,
  });
}

function encodeVecU8(bytes: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([len, Buffer.from(bytes)]);
}

function serializeCodamaIx(ix: any): Uint8Array {
  // codama instructions have `.data` as Uint8Array including discriminator
  return ix.data;
}

function toAccountMeta(codamaAccount: any) {
  return {
    pubkey: new PublicKey(codamaAccount.address),
    isSigner: codamaAccount.role === 2 || codamaAccount.role === 3,  // codama role enum
    isWritable: codamaAccount.role === 1 || codamaAccount.role === 3,
  };
}
```

- [ ] **Step 2: Build the full tx and submit**

```typescript
import { TransactionMessage, VersionedTransaction } from "@solana/web3.js";

export async function payInvoiceCpi(args: PayInvoiceArgs): Promise<PayInvoiceResult> {
  if (!VEIL_PAY_PROGRAM_ID) throw new VeilPayNotConfiguredError();

  const { proof, commitments, /* etc */ } = await generateProofAndCommitments(args);
  const createBufferIx = await /* codama call */;
  const depositIx = await /* codama call */;

  const veilPayIx = buildVeilPayInstruction(createBufferIx, depositIx, args.client.signer.publicKey);

  // Get blockhash + build versioned tx
  const blockhash = await args.client.blockhashProvider();
  const txMessage = new TransactionMessage({
    payerKey: args.client.signer.publicKey,
    recentBlockhash: blockhash.blockhash,
    instructions: [veilPayIx],
  }).compileToV0Message();

  const tx = new VersionedTransaction(txMessage);

  // Sign — ONE Phantom popup
  const signed = await args.client.signer.signTransaction(tx);

  // Submit
  const signature = await args.client.transactionForwarder.send(signed);

  return {
    createProofAccountSignature: signature, // same sig represents both CPIs now
    createUtxoSignature: signature,
    closeProofAccountSignature: undefined,
  };
}
```

- [ ] **Step 3: Get the actual VeilPay discriminator**

```bash
anchor idl fetch <VEIL_PAY_PROGRAM_ID> --provider.cluster devnet > /tmp/veil_pay_idl.json
cat /tmp/veil_pay_idl.json | jq '.instructions[] | select(.name == "payInvoice") | .discriminator'
```

Replace the placeholder bytes in Step 1.

- [ ] **Step 4: Type-check**

```bash
cd app && npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/payInvoiceCpi.ts
git commit -m "feat(payInvoiceCpi): compose single VeilPay tx, sign once, submit"
```

---

### Task 12: Wire feature flag in umbra.ts payInvoice

**Files:**
- Modify: `app/src/lib/umbra.ts:615-642`

- [ ] **Step 1: Add feature flag constant**

In `app/src/lib/umbra.ts`, near the top with other constants:

```typescript
// When true and VEIL_PAY_PROGRAM_ID is configured, public-balance pay routes
// through the single-popup CPI path instead of SDK's two-tx orchestration.
// Disable to instantly fall back to the stock SDK pay flow.
const USE_VEIL_PAY_CPI = process.env.NEXT_PUBLIC_USE_VEIL_PAY_CPI !== "false";
```

- [ ] **Step 2: Modify payInvoice to delegate when flag is on**

Replace the body of `payInvoice` (currently around lines 615-642):

```typescript
export async function payInvoice(args: PayInvoiceArgs): Promise<PayInvoiceResult> {
  if (USE_VEIL_PAY_CPI) {
    try {
      const { payInvoiceCpi, VeilPayNotConfiguredError } = await import("./payInvoiceCpi");
      return await payInvoiceCpi(args);
    } catch (err) {
      if (err instanceof Error && err.name === "VeilPayNotConfiguredError") {
        debugLog("[payInvoice] VeilPay not configured, using SDK fallback");
        // fall through to SDK orchestration below
      } else {
        throw err;
      }
    }
  }

  // SDK orchestration (existing path, kept as fallback)
  const zkProver = getCreateReceiverClaimableUtxoFromPublicBalanceProver({
    assetProvider: proxiedAssetProvider(),
  });
  const create = getPublicBalanceToReceiverClaimableUtxoCreatorFunction(
    { client: args.client },
    { zkProver } as any,
  );

  // ... rest of existing implementation unchanged
}
```

- [ ] **Step 3: Type-check**

```bash
cd app && npx tsc --noEmit
```

- [ ] **Step 4: Add NEXT_PUBLIC_USE_VEIL_PAY_CPI to .env.example**

```
# Toggle the single-popup VeilPay CPI path. Default: enabled when
# NEXT_PUBLIC_VEIL_PAY_PROGRAM_ID is set. Set to "false" to force SDK fallback.
NEXT_PUBLIC_USE_VEIL_PAY_CPI=true
```

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/umbra.ts app/.env.example
git commit -m "feat(umbra): feature-flag delegate payInvoice to VeilPay CPI path"
```

---

### Task 13: End-to-end smoke test on local + devnet

- [ ] **Step 1: Smoke test with flag OFF (regression check)**

In `app/.env.local`, set `NEXT_PUBLIC_USE_VEIL_PAY_CPI=false`.

Run dev server (`npm run dev` from `app/`). Pay an invoice. Open DevTools console.

Expected: `[Veil popup #1]`, `[Veil popup #2]` appear (existing 2-popup behavior). Existing flow unchanged. ✅

- [ ] **Step 2: Smoke test with flag ON (the new path)**

Set `NEXT_PUBLIC_USE_VEIL_PAY_CPI=true` and refresh.

Pay an invoice. Watch DevTools.

Expected:
- ONE `[Veil popup #1]` line — no #2
- Phantom popup shows "**-1 SOL**" (or whatever amount) in the balance change preview
- Phantom does NOT show "Transaction reverted during simulation"
- Tx confirms within ~5-10s
- Recipient's dashboard claims the UTXO normally

If any of these fail, capture the console output and report back before committing.

- [ ] **Step 3: Verify on Solana Explorer**

Take the tx signature from the console log. Open in Solana Explorer (devnet). Verify:
- Single tx contains TWO inner CPI calls to Umbra (`DSuKky...EpAJ`)
- Both CPI calls succeed
- SOL transfer of `amount` from depositor's wSOL ATA to Umbra's pool

- [ ] **Step 4: Commit any test artifacts**

```bash
git status
# Should be clean after smoke test (no .ts edits expected)
```

If there are artifacts (e.g., a debug log was added during testing), strip them.

---

## Phase 3: Ship (TASKS 14-15)

### Task 14: Push to GitHub for live deployment

- [ ] **Step 1: Switch to publish-snapshot branch and amend with all Phase 0-2 commits**

```bash
git checkout publish-snapshot
# Squash-merge or cherry-pick the relevant changes
# (alternatively, force-push a new orphan with the latest main state)
```

The exact branching choice depends on whether the publish-snapshot is still single-commit or has accumulated. Use the same orphan-squash pattern as previous changes — see prior commits for the exact flow.

- [ ] **Step 2: Force-push to remote main**

```bash
git push -f origin publish-snapshot:main
```

- [ ] **Step 3: Wait for Netlify build + verify**

Watch https://app.netlify.com/projects/veil-app-205/deploys for the build. Once green:

- Open https://veil-app-205.netlify.app
- Pay an invoice
- Verify single popup + correct SOL preview on the LIVE app (not just localhost)

- [ ] **Step 4: Commit local main with same content**

```bash
git checkout main
# Apply same changes if branches diverged
git push origin main  # if a remote main tracking branch exists for local; otherwise skip
```

---

### Task 15: Update README and demo script for the new flow

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add VeilPay to the README architecture section**

Insert near the architecture diagram:

> **VeilPay (`programs/veil-pay/`)** — A custom Anchor program that CPIs into Umbra's deposit primitives within a single atomic transaction. Reduces public-balance payments from 2 wallet signatures to 1, and enables Phantom's preflight to display the actual SOL outflow (the standard 2-tx flow produces a "reverted in simulation" warning because the deposit references a buffer account created in the prior tx — Phantom's preflight runs before that tx commits).

- [ ] **Step 2: Add a "Why this is technically interesting" callout**

Most hackathon Umbra integrations just call the SDK. Veil composes the primitives via on-chain CPI — this is non-trivial because it requires verifying CPI is allowed (we did via static analysis on the binary + a devnet probe), pre-building the proof off-chain, and threading ~21 accounts through `remaining_accounts` correctly.

- [ ] **Step 3: Commit and push README**

```bash
git add README.md
git commit -m "docs(README): document VeilPay single-popup CPI architecture"
# Repeat the publish-snapshot dance to push to remote
```

---

## Fallback path (if Phase 0 returns NO-GO)

If Task 3's probe shows CPI is rejected by Umbra, do NOT proceed with Tasks 4-7. Instead:

1. **Pivot architecture:** Use `@solana/web3.js` directly to build BOTH Umbra instructions client-side, then compose into ONE tx (no on-chain VeilPay program). User signs once, both instructions execute atomically inside one tx.

2. **Skip Phase 1 entirely.** Phase 2 client wrapper is unchanged in approach but doesn't reference a custom program — it just builds a multi-instruction tx targeting Umbra directly.

3. **Effort estimate:** 1 day instead of 2-3.

4. **Outcome:** Same single-popup UX, but the demo story changes from "we built a custom on-chain primitive" to "we composed Umbra's primitives client-side." Less impressive technical-execution narrative but functionally equivalent.

5. **Decision:** Report the NO-GO result + the specific Umbra error to the user. Confirm pivot before starting.

---

## Definition of done

(From the spec — re-listed here for verification when work completes)

- [ ] `programs/veil-pay/` Anchor crate builds with `anchor build`
- [ ] VeilPay deployed to devnet, program ID set in env
- [ ] `app/src/lib/payInvoiceCpi.ts` implemented and replaces SDK orchestration when flag is on
- [ ] End-to-end pay flow on the live deployment: user clicks Pay → ONE Phantom popup with "-1 SOL" preview → tx confirms → recipient dashboard claims → invoice marked paid
- [ ] Console logs show `[Veil popup #1]` only (not #2 or #3) for the public-balance pay path
- [ ] Feature flag tested in both states (`USE_VEIL_PAY_CPI=true` → new path; `false` → SDK orchestration)
- [ ] Type-check (`npx tsc --noEmit`) and existing tests (`npm test`) pass
- [ ] Live deployment updated via Netlify CI

---

## Self-review notes

**Spec coverage:** Each section of the spec is covered: architecture (Tasks 1-7), components (Tasks 1-12), data flow (Tasks 9-11), error handling (covered in Tasks 4 + 12), testing (Tasks 3, 7, 13), risks (Phase 0 gate validates the biggest risk before time investment).

**Placeholder scan:** Several inline placeholders (`/* CREATE_BUFFER_DISCRIMINATOR bytes */`, etc.) are intentional — they're values the engineer must extract from the codama bundle in dedicated steps. NOT pretending the work is done; explicitly directing them to the source.

**Type consistency:** Function/instruction names match across tasks: `pay_invoice` (Rust), `payInvoice` (TS wrapper), `payInvoiceCpi` (the new TS function). VeilPay program ID referenced consistently as `VEIL_PAY_PROGRAM_ID`.

**Scope:** Single program + single TS wrapper, ~15 tasks. Decomposes into Phase 0 (verify) + Phase 1 (program) + Phase 2 (client) + Phase 3 (ship). Each phase produces shippable progress.
