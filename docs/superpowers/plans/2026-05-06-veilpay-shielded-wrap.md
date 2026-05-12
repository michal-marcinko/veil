# Plan: VeilPay shielded-balance wrap

**Date**: 2026-05-06
**Demo deadline**: 2026-05-11
**Owner**: marcin
**Status**: ready to dispatch

## Goal

Bring shielded-balance invoice payments under the VeilPay CPI wrapper, mirroring the public-balance path that already works (Fix 2 deployment 2026-05-06). Outcome:

1. Shielded pay drops from **2 popups → 1 popup** (matches the payroll claim-link single-popup pattern)
2. Shielded pay acquires the on-chain `PaymentIntentLock` atomically — closes the auto-flip gap (today's bug: payer pays via shielded → recipient's invoice still says "Pending" because no lock exists)
3. Unifies the architecture: both pay paths go through VeilPay → both produce locks → both auto-reconcile → demo narrative is one story, not two

## Reconnaissance already done (use these — do not re-derive)

The Umbra ix discriminators for the shielded path, verified by reading `node_modules/@umbra-privacy/umbra-codama/dist/index.cjs`:

```
CREATE_STEALTH_POOL_DEPOSIT_INPUT_BUFFER_DISCRIMINATOR
  = [239, 89, 111, 177, 2, 224, 90, 79]
  // sha256("global:create_stealth_pool_deposit_input_buffer")[0..8]
  // Source: umbra-codama/dist/index.cjs:24603

DEPOSIT_INTO_STEALTH_POOL_FROM_SHARED_BALANCE_V11_DISCRIMINATOR
  = [22, 229, 199, 112, 193, 65, 111, 243]
  // sha256("global:deposit_into_stealth_pool_from_shared_balance_v11")[0..8]
  // Source: umbra-codama/dist/index.cjs:32051
```

**Compare with public-path (already in `programs/veil-pay/.../lib.rs`)**:
```
CREATE_BUFFER_DISCRIMINATOR     = [139, 135, 169, 216, 228, 15, 104, 98]   // PUBLIC variant
DEPOSIT_DISCRIMINATOR           = [232, 133, 25, 16, 203, 167, 3, 3]       // PUBLIC variant
```

Different ixs entirely. Cannot reuse the existing `pay_invoice` ix.

**Account counts** (from the codama instruction builder source):

- Shielded createBuffer ix: **4 accounts** — depositor, feePayer, stealthPoolDepositInputBuffer, systemProgram. Same shape as public path. Different PDA seed (32-byte prefix `[59, 75, 46, 222, 191, 204, 134, 94, 4, 7, 84, 83, 213, 76, 50, 244, 160, 195, 187, 58, 238, 230, 165, 193, 95, 194, 178, 220, 18, 225, 86, 183]` — verbatim from codama).
- Shielded deposit ix: **25 accounts** (vs 17 for public path) — adds 8 Arcium MPC accounts: `signPdaAccount`, `mxeAccount`, `mempoolAccount` (writable), `executingPool` (writable), `computationAccount` (writable, **per-tx**), `compDefAccount`, `clusterAccount` (writable), `arciumProgram`.

The remaining accounts overlap with public path: depositor, feePayer, depositorUserAccount, depositorTokenAccount, feeSchedule, feeVault, stealthPool, tokenPool, mint, protocolConfig, zeroKnowledgeVerifyingKey, clockSysvarAccount, systemProgram, plus the per-tx `stealthPoolDepositInputBuffer` and `computationData`.

### Statically-known Arcium accounts (read these from codama/SDK source, do NOT hardcode below — verify):

The codama builder hardcodes these defaults (verified at index.cjs:32172-32183):
```
poolAccount    = "G2sRWJvi3xoyh5k2gY49eG9L8YhAEWQPtNb1zb1GXTtC"  // STATIC
clockAccount   = "7EbMUTLo5DjdzbN7s8BXeZwXzEwNQb1hScfRvWg8a6ot"  // STATIC
arciumProgram  = "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"  // STATIC
systemProgram  = "11111111111111111111111111111111"               // STATIC (already ALT'd)
```

`signPdaAccount`, `mxeAccount`, `mempoolAccount`, `executingPool`, `compDefAccount`, `clusterAccount` are PDAs — derive them from the codama builder source at lines 32142-32171 onward. Each follows the standard PDA derivation pattern with hardcoded seed bytes.

## Privacy framing (no change to honest model)

This wrap doesn't introduce new on-chain leakage beyond what the public-balance path already established. The lock PDA is identical between paths (same seeds, same fields, same disclosure surface). Pitch stays the same: "private business records, verifiable accounting; payment-to-invoice link is on-chain proof, amount + balances stay encrypted."

## Workstreams

### 1. Anchor — `pay_invoice_from_shielded` ix in veil-pay (~2 hrs)

`programs/veil-pay/programs/veil-pay/src/lib.rs` — add a third `#[program]` entry point + accounts struct + new discriminator constants:

```rust
pub const CREATE_SHIELDED_BUFFER_DISCRIMINATOR: [u8; 8] =
    [239, 89, 111, 177, 2, 224, 90, 79];
pub const DEPOSIT_FROM_SHIELDED_DISCRIMINATOR: [u8; 8] =
    [22, 229, 199, 112, 193, 65, 111, 243];

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
        "veil_pay: 2/3 - create proof buffer ({} accts)",
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

#[derive(Accounts)]
pub struct PayInvoiceFromShielded<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    /// CHECK: see PayInvoice.invoice
    pub invoice: UncheckedAccount<'info>,
    /// CHECK: see PayInvoice.lock
    #[account(mut)]
    pub lock: UncheckedAccount<'info>,
    /// CHECK: must equal INVOICE_REGISTRY_PROGRAM_ID
    #[account(address = INVOICE_REGISTRY_PROGRAM_ID)]
    pub invoice_registry_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: forwarded to Umbra; must equal UMBRA_PROGRAM_ID
    #[account(address = UMBRA_PROGRAM_ID)]
    pub umbra_program: UncheckedAccount<'info>,
}
```

Reuse the existing `invoke_lock_payment_intent` and `invoke_with_accounts` helpers — no changes needed there.

### 2. Anchor tests — extend `programs/veil-pay/tests/veil-pay.ts` (~1 hr)

Add 3 tests mirroring the existing `pay_invoice` tests:
- `pay_invoice_from_shielded — happy path: locks the invoice + fires both Umbra CPIs (shielded variant)`
- `pay_invoice_from_shielded — second attempt on same invoice fails (lock PDA already exists)`
- `pay_invoice_from_shielded — restricted invoice + WRONG payer signer → NotPayer`

The mock-Umbra harness (`tests-rust/mock-umbra/`) accepts ANY discriminator and just logs — so these tests should work without changes to the mock. Use the new `CREATE_SHIELDED_BUFFER_DISCRIMINATOR` and `DEPOSIT_FROM_SHIELDED_DISCRIMINATOR` constants for the test data.

### 3. Frontend — `payInvoiceFromShieldedCpi` builder (~2 hrs)

New file or extension to `app/src/lib/payInvoiceCpi.ts`:

- Add `PAY_INVOICE_FROM_SHIELDED_DISCRIMINATOR` (compute via `sha256("global:pay_invoice_from_shielded")[0..8]` — verify against the regenerated IDL)
- Mirror `buildVeilPayInstruction` for the shielded variant. The function already has `isInvoicePay` dispatch — extend with a third case `isInvoiceShielded` that emits the new ix's account layout
- New entry point `payInvoiceFromShieldedCpi(args: PayInvoiceArgs)` that:
  1. Calls Umbra SDK's shielded-balance ZK prover (same one `payInvoiceFromShielded` uses today)
  2. Pulls the createBuffer + deposit ixs from the SDK builder (same pattern as public path uses for `getPublicBalanceToReceiverClaimableUtxoCreatorFunction`)
  3. Builds the VeilPay outer ix with `pay_invoice_from_shielded` discriminator + remaining_accounts = [createBufferAccts..., depositAccts...]
  4. Compiles to v0 message with the shielded ALT (see workstream 4)
  5. Returns the unsigned tx for the caller to sign + submit

Keep the SDK fallback path unchanged — `payInvoiceFromShielded` in `umbra.ts` will get the same try/wrap pattern as `payInvoice`:

```ts
if (USE_VEIL_PAY_CPI) {
  let payInvoiceFromShieldedCpi: any;
  let VeilPayNotConfiguredError: any;
  try {
    const mod = await import("./payInvoiceCpi");
    payInvoiceFromShieldedCpi = mod.payInvoiceFromShieldedCpi;
    VeilPayNotConfiguredError = mod.VeilPayNotConfiguredError;
  } catch (importErr) {
    debugLog("[payInvoiceFromShielded] CPI module import failed", importErr);
  }
  if (payInvoiceFromShieldedCpi) {
    try {
      return await payInvoiceFromShieldedCpi(args);
    } catch (err) {
      if (err instanceof VeilPayNotConfiguredError) {
        debugLog("[payInvoiceFromShielded] VEIL_PAY_PROGRAM_ID not set, using SDK fallback");
      } else {
        throw err;  // surface real errors — don't silently fall through
      }
    }
  }
}
// existing SDK fallback (2-popup path) remains as written
```

### 4. ALT — extend or add a new ALT for the shielded path (~1 hr)

The existing ALT (`5jBhrvhFXTgXPRrSpzajXL7dW8gasPv42Y5gBSeJSpT8`) holds 14 addresses for the public path. Two options:

**A. Extend the existing ALT** with the additional shielded-only static accounts. ALTs support up to 256 addresses, so room is fine. Same lookup table serves both paths.

**B. Deploy a separate shielded-path ALT** if you want isolation. Frontend chooses ALT based on which builder is being used.

**Recommend Option A** for simplicity. Update `app/scripts/deploy-veilpay-alt.mjs`:

Additional static accounts to ALT (verify each PDA derivation against the codama builder source before adding — these are educated guesses):

- `arciumProgram` — `Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ` (literal, no derivation)
- `arciumPoolAccount` — `G2sRWJvi3xoyh5k2gY49eG9L8YhAEWQPtNb1zb1GXTtC` (literal)
- `arciumClockAccount` — `7EbMUTLo5DjdzbN7s8BXeZwXzEwNQb1hScfRvWg8a6ot` (literal)
- `signPdaAccount` PDA — derived under arciumProgram with seed `"ArciumSignerAccount"` (visible at codama line 32147-32168 — bytes spell out the string)
- `mxeAccount`, `mempoolAccount`, `executingPool`, `compDefAccount`, `clusterAccount` — all PDAs under arciumProgram with their respective seeds. Read codama lines 32142-32400 area for the exact seeds.
- Possibly a different `feeSchedule` PDA for the `_v11` shared-balance variant (the discriminator seed in the PDA derivation will differ). Check by deriving under both discriminators and seeing which one exists on chain.
- A different `zeroKnowledgeVerifyingKey` PDA for the shielded circuit — verify by deriving with the new discriminator seed and checking on-chain.

After updating the deploy script, run it. It will create a NEW ALT (the `createLookupTable` ix always creates fresh; the existing one stays orphaned).

After deploy, update `app/.env.local`:
```
NEXT_PUBLIC_VEILPAY_ALT_ADDRESS=<new-alt-address>
```

### 5. Tx-size measurement (~30 min — do this BEFORE deploying)

The shielded deposit ix has 25 accounts vs 17 for public. The ZK proof for the shielded circuit may also be a different size. **Before redeploying anything**, build the tx in dev, log its size, and verify it's under 1232 bytes:

1. Wire the new builder
2. Use `NEXT_PUBLIC_VEIL_DEBUG=1` to enable the `[VeilPay tx-size]` log
3. Trigger a shielded pay attempt in browser dev console (don't actually submit — wallet not needed; just inspect the build)
4. Check `serializedMessageBytes + 65 <= 1232`

If the tx is over cap, evaluate:
- Are all static Arcium accounts in the ALT? (If not, add them)
- Is the verifying key PDA correct for the v11 variant? (If wrong, the on-chain check will fail; ensure correct)
- Is there room to drop `clockSysvarAccount` (Anchor 0.30+ derives clock, may not need explicit account)?

If still over cap, the wrap is not feasible without bytecode-size optimization. Document and revert to 2-popup SDK fallback for shielded.

### 6. Devnet redeploy (~30 min)

After tests pass + tx-size confirmed under cap:
- `cd programs/veil-pay && anchor build`
- Check that `target/deploy/veil_pay.so` size has grown by ~5-10KB (new ix + accounts struct)
- If existing devnet program data buffer doesn't fit: `solana program extend E2G6dN7yY8VQ2dFRgkvqskdAnPhJXkdorYP6BhKvfa8m <bytes>` (we extended by 32KB earlier; should still have ~17KB headroom — verify via `solana program show`)
- `solana program deploy --program-id E2G6dN7yY8VQ2dFRgkvqskdAnPhJXkdorYP6BhKvfa8m target/deploy/veil_pay.so` (or `anchor deploy`)
- Verify with `solana program show` that slot updated and data length grew

If a buffer-too-small error appears, run `solana program extend E2G6... 32768` first.

### 7. README update (~15 min)

Add a line under "How reconciliation works" / "Architecture":
> "Both public-balance and shielded-balance invoice payments route through VeilPay, which atomically acquires the on-chain `PaymentIntentLock` PDA before forwarding the encrypted deposit to Umbra. Single tx, single signature, single popup."

## Risks

1. **Tx-size budget** (highest risk). The shielded ix has 8 more accounts than the public path. Even with ALT, this may push past 1232 bytes. Workstream 5 measures BEFORE deploy — bail early if hopeless.

2. **Arcium computation account** is per-tx and writable. Its derivation requires inputs from the SDK builder (specifically the off-chain MPC scheduler that picks an idle compute slot). The frontend builder must extract this account from the SDK's pre-built ix; cannot derive independently.

3. **Verifying key PDA mismatch**. The shielded path uses a different ZK circuit, and Anchor checks `zeroKnowledgeVerifyingKey` matches the expected key for the ix. Wrong PDA → on-chain reject. Verify by reading codama's PDA derivation for this specific ix.

4. **`awaitComputationFinalization` async finalization**. The shielded path's MPC computation runs OFF-CHAIN after our tx is submitted. Today the SDK awaits this finalization and surfaces a callback signature. With VeilPay wrapping, the lock + queue happen atomically, but the user UI still needs to show "waiting for MPC finalization" after the tx confirms. The existing `payInvoiceFromShielded` flow already handles this — preserve the same UX (just remove the duplicate popup; keep the post-confirm progress bar).

5. **Lock-stuck-after-MPC-failure**. If the tx confirms (lock acquired), but the MPC computation fails off-chain, the user has the lock but no actual fund movement. They cannot retry the payment. Today's SDK has a similar failure mode but no lock involved — UX is cleaner (just retry). Mitigation: the lock acquisition implies "this invoice was attempted". For the demo case this won't trigger. Document as edge case; v2 adds a `cancel_payment_intent` ix to release stuck locks.

## Acceptance criteria

- [ ] `programs/veil-pay/.../lib.rs` has new `pay_invoice_from_shielded` ix; `anchor build` clean
- [ ] 3 new tests passing in `programs/veil-pay/tests/veil-pay.ts` (total: 10/10)
- [ ] `app/src/lib/payInvoiceCpi.ts` exports `payInvoiceFromShieldedCpi`
- [ ] `umbra.ts::payInvoiceFromShielded` tries CPI first, falls back to SDK on `VeilPayNotConfiguredError` only
- [ ] `tsc --noEmit` clean
- [ ] Shielded pay tx-size measured: under 1232 bytes (logged via `NEXT_PUBLIC_VEIL_DEBUG=1`)
- [ ] Devnet redeploy of veil-pay successful; new ix discoverable on chain
- [ ] ALT updated with shielded-path static accounts (or new ALT deployed)
- [ ] Live test: pay an invoice from shielded balance → 1 popup → invoice flips to "Paid · settling" on both dashboards within ~5s of confirm
- [ ] Lock PDA visible on chain after the pay (verify via `solana account <lockPda>`)

## Reporting back

Punch list (under 400 words):

1. Files modified / created with 1-line description per file
2. New constants: discriminator value for `pay_invoice_from_shielded`
3. Anchor build status; veilpay test 10/10
4. tsc + next build status
5. Tx-size measurement: serializedMessageBytes, account counts (static / ALT'd), under 1232 cap?
6. Devnet redeploy: did you deploy? tx sig? OR stopped short for user to deploy?
7. ALT update: extended existing or new ALT? new address?
8. Anything you stubbed or skipped (and why)
9. Live-test result OR "not feasible to live-test, marcin needs to verify"

## Subagent dispatch shape

Single opus subagent — workstreams 1-7 are tightly coupled (frontend depends on Anchor build; ALT depends on which accounts the builder needs). One agent owns the whole thread.

Estimated time: ~5-6 hours of focused work. If tx-size measurement (workstream 5) fails, agent stops there and reports — no point completing workstreams 6-7.
