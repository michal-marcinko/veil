# Plan: Shielded pay via signAllTransactions batching

**Date**: 2026-05-06
**Demo deadline**: 2026-05-11
**Owner**: marcin
**Status**: ready to dispatch

## Why this exists

The VeilPay shielded CPI wrap (`pay_invoice_from_shielded`) is shipped on chain but the tx is 234 bytes over the 1232 cap because the shielded ZK circuit's `createBuffer` carries ~880 bytes of ciphertext fields that the public-balance circuit doesn't. The wrap is dead code at runtime.

This plan replaces it with **`signAllTransactions` batching**: 3 small txs, ONE wallet popup, near-atomic enforcement, plus a recovery primitive when the second/third tx fails.

End state for the demo:

- **Public pay**: 1 popup, atomic CPI bundle (Fix 2 — already shipped + working)
- **Shielded pay**: 1 popup via `signAllTransactions`, 3 sequential txs (lock + createBuffer + deposit), auto-flip works
- **Stuck-lock recovery**: dashboard surfaces a "Release payment intent" button when a lock exists but no UTXO followed; one-click `cancel_payment_intent` releases the lock and refunds rent

This unifies the narrative: both paths produce on-chain locks atomically (or near-atomically with explicit recovery).

## Reconnaissance already done

- The codama-direct extraction logic for the shielded `createBuffer` + `deposit` ixs already lives in `app/src/lib/payInvoiceCpi.ts::payInvoiceFromShieldedCpi`. The bytes for those ixs (account lists + data) are correct — they just don't fit when bundled into a single VeilPay outer ix. Standalone, each tx fits comfortably under 1232.
- `signAllTransactions` precedent exists in `app/src/components/PayrollFlow.tsx` (the payroll path uses it for batched fund + deposit signing). Use that as the reference pattern.
- `lock_payment_intent` ix in invoice-registry already shipped + deployed (Fix 2). No changes needed there. Just call it as a standalone tx.

## Workstreams

### 1. Anchor — `cancel_payment_intent` ix in invoice-registry (~1 hr)

Add to `programs/invoice-registry/programs/invoice-registry/src/lib.rs`:

```rust
/// Release a `PaymentIntentLock` after a failed payment attempt. Refunds
/// the lock's rent to the original payer. Only the payer can call this —
/// they're the one who paid the rent and they're the only party who knows
/// whether their second/third tx in the batch actually landed.
///
/// Used when the shielded-pay batched flow has the lock tx confirm but
/// the subsequent createBuffer or deposit tx fail. Without this, the
/// invoice would be permanently locked and the payer would lose the rent.
///
/// Status check: only releasable while the invoice is still Pending.
/// Once the invoice is marked Paid (mark_paid succeeded), cancellation
/// is forbidden — by then the lock represents a real settlement and
/// removing it would let an attacker pay the invoice twice.
pub fn cancel_payment_intent(ctx: Context<CancelPaymentIntent>) -> Result<()> {
    require!(
        ctx.accounts.invoice.status == InvoiceStatus::Pending,
        InvoiceError::InvalidStatus
    );
    require!(
        ctx.accounts.lock.payer == ctx.accounts.payer.key(),
        InvoiceError::NotPayer
    );
    // close = payer in the accounts struct refunds rent automatically
    Ok(())
}

#[derive(Accounts)]
pub struct CancelPaymentIntent<'info> {
    pub invoice: Account<'info, Invoice>,
    #[account(
        mut,
        close = payer,
        seeds = [b"intent_lock", invoice.key().as_ref()],
        bump = lock.bump,
        has_one = invoice @ InvoiceError::InvalidStatus,
    )]
    pub lock: Account<'info, PaymentIntentLock>,
    #[account(mut)]
    pub payer: Signer<'info>,
}
```

Then `anchor build`, check program data buffer headroom, redeploy.

### 2. Anchor tests (~30 min)

Extend `programs/invoice-registry/tests/` (if test harness exists) OR add to `programs/veil-pay/tests/veil-pay.ts` (which already has invoice-registry mocked):

- `cancel_payment_intent — happy path: payer cancels → lock account closed, rent refunded, invoice status unchanged`
- `cancel_payment_intent — wrong payer signer → NotPayer`
- `cancel_payment_intent — invoice already Paid → InvalidStatus (cannot cancel a settled lock)`

If the existing veil-pay test harness already deploys real invoice-registry (it does — see `tests/run.cjs`), tests can be added there with minimal scaffolding.

### 3. Frontend — `payInvoiceFromShieldedBatched` (~2 hrs)

The current dead `payInvoiceFromShieldedCpi` in `app/src/lib/payInvoiceCpi.ts` already extracts the SDK's createBuffer + deposit ixs via codama-direct. **Keep that extraction logic.** Replace the "build VeilPay outer ix" step with "build 3 separate txs and sign together":

```ts
export async function payInvoiceFromShieldedBatched(
  args: PayInvoiceArgs,
): Promise<PayInvoiceResult> {
  // 1. Reuse the codama-direct extraction from the existing
  //    payInvoiceFromShieldedCpi: builds createBufferIx + depositIx
  //    by calling the Umbra SDK's shielded prover and extracting the
  //    pre-built instructions.

  // 2. Build the lock_payment_intent ix targeting the same invoice PDA.
  //    Tiny — 4 accounts + 8 bytes of discriminator data.
  const lockIx = buildLockPaymentIntentIx({
    invoicePda,
    payer: depositor,
  });

  // 3. Build 3 separate VersionedTransactions, each with the SAME
  //    blockhash (so the wallet can sign them all in one batch).
  const blockhash = await connection.getLatestBlockhash("confirmed");

  const lockTx     = buildV0Tx([lockIx],     blockhash, depositor, []);
  const createTx   = buildV0Tx([createBufferIx], blockhash, depositor, [altAccount]);
  const depositTx  = buildV0Tx([depositIx],  blockhash, depositor, [altAccount]);

  // 4. signAllTransactions in one popup. Phantom + Solflare both support.
  const signed = await wallet.signAllTransactions([lockTx, createTx, depositTx]);

  // 5. Submit sequentially. Wait for each to confirm before sending the
  //    next — that way if tx1 fails (lock-rejected, e.g. invoice paid by
  //    someone else first), we don't waste the createBuffer/deposit txs.
  let lockSig: string | null = null;
  let createSig: string | null = null;
  let depositSig: string | null = null;

  try {
    lockSig = await sendAndConfirm(connection, signed[0]);
  } catch (err) {
    // Lock failed — restricted-payer mismatch, already-paid, etc.
    // None of our pre-signed txs landed; user just sees the error.
    throw new PaymentIntentLockError(err);
  }

  try {
    createSig = await sendAndConfirm(connection, signed[1]);
    depositSig = await sendAndConfirm(connection, signed[2]);
  } catch (err) {
    // Lock confirmed but createBuffer or deposit failed.
    // Surface the stuck-lock state to the caller so the UI can prompt
    // for cancel_payment_intent recovery.
    throw new StuckLockError({
      invoicePda: invoicePda.toBase58(),
      lockSig,
      cause: err,
    });
  }

  return {
    createProofAccountSignature: createSig,
    createUtxoSignature: depositSig,
  };
}
```

Reference the payroll batched-signing pattern in `app/src/components/PayrollFlow.tsx` for the exact `signAllTransactions` wiring + per-tx confirm loop.

### 4. Frontend — wire in `umbra.ts::payInvoiceFromShielded` (~30 min)

Replace the existing try/wrap that points at the dead CPI path. New shape:

```ts
export async function payInvoiceFromShielded(args: PayInvoiceArgs): Promise<PayInvoiceResult> {
  if (USE_VEIL_PAY_CPI) {
    let payInvoiceFromShieldedBatched: any;
    let VeilPayNotConfiguredError: any;
    try {
      const mod = await import("./payInvoiceCpi");
      payInvoiceFromShieldedBatched = mod.payInvoiceFromShieldedBatched;
      VeilPayNotConfiguredError = mod.VeilPayNotConfiguredError;
    } catch (importErr) {
      debugLog("[payInvoiceFromShielded] CPI module import failed", importErr);
    }

    if (payInvoiceFromShieldedBatched) {
      try {
        return await payInvoiceFromShieldedBatched(args);
      } catch (err) {
        if (err instanceof VeilPayNotConfiguredError) {
          debugLog("[payInvoiceFromShielded] not configured, using SDK fallback");
        } else {
          throw err;  // surface real errors (incl StuckLockError)
        }
      }
    }
  }

  // Existing SDK fallback (2-popup path) stays exactly as written.
}
```

Remove or rename the dead `payInvoiceFromShieldedCpi` — either delete it or keep as v2 scaffold under a different name (`buildVeilPayShieldedCpiTx_DEAD_v1`) with a comment explaining the size constraint. Subagent's call.

### 5. Dashboard — stuck-lock recovery UI (~1 hr)

When the dashboard scans for locks (item 1 in the previous plan, already shipped via `fetchManyLocks`), distinguish three states for an invoice's row:

| Lock | Invoice status | Display              |
|------|----------------|----------------------|
| no   | Pending        | `Pending`            |
| yes  | Pending (recent — < 60s) | `Paid · settling` (existing) |
| yes  | Pending (stale — > 60s, no matching UTXO) | `Payment failed — release intent` |
| yes  | Paid           | `Paid` (existing)    |

The "stale + no matching UTXO" check needs:
- The lock's `locked_at` timestamp (already in the PaymentIntentLock account)
- A check for whether the recipient has actually received the matching UTXO. Heuristic: if the recipient's `IncomingPrivatePaymentsSection` history doesn't show a payment with matching amount + timing within 60s of `locked_at`, treat as failed.

For demo simplicity: **just use the time check** (`Date.now() - lockedAt > 60_000`). Skip UTXO matching for the hackathon. False positives are recoverable (the cancel can be triggered manually but the invoice status will eventually correct itself when the actual payment lands).

Surface a small button on the row:
```tsx
{lockStuck && wallet.publicKey?.equals(lock.payer) && (
  <button onClick={() => handleCancelIntent(invoicePda, lock)}>
    Release payment intent
  </button>
)}
```

`handleCancelIntent` builds a `cancel_payment_intent` ix tx, signs (1 popup), submits.

This UI shows ONLY to the payer of the stuck lock — the creator can't cancel someone else's lock. Visible only when the row is on the payer's dashboard (Bob's `IncomingInvoicesSection`).

### 6. Devnet redeploy (~30 min)

- `cd programs/invoice-registry && anchor build`
- Check current data buffer size vs new bytecode: `solana program show 54ryi8h...`
- If new bytecode > current data length: `solana program extend 54ryi8h... 32768` (we have ~13KB headroom currently from earlier extend; adding `cancel_payment_intent` ix probably ~5KB; should fit)
- `anchor deploy --provider.cluster devnet`
- Update `app/src/lib/invoice_registry.{ts,json}` — regenerate IDL so the new ix is callable

### 7. README addendum (~10 min)

Add a paragraph under "How reconciliation works":
> "Shielded-balance payments use a 3-tx atomic batch (lock + createBuffer + deposit), signed in one popup via `signAllTransactions`. If the lock confirms but a subsequent tx fails (rare — typically network), the dashboard surfaces a one-click 'Release payment intent' recovery so the payer can retry."

## Risks

1. **Tx-1 succeeds, tx-2 fails, lock-stuck UX**. Recovery is via `cancel_payment_intent`. If the payer never returns to the dashboard, the lock + rent stay locked forever. For hackathon, this is acceptable — the rent (~890k lamports) is the only cost and it's their own SOL. Document.

2. **Blockhash expiry across 3 sequential confirms**. With confirmed commitment, each tx confirms in 1-2s. 3 confirms ≈ 6s. Blockhash is valid for ~60s. Comfortable margin.

3. **`signAllTransactions` returns rejection if user cancels mid-popup**. Standard wallet behavior — caller surfaces the error. Same UX as today.

4. **Anchor build of invoice-registry may need program-data extend**. We extended by 32KB earlier. New ix adds ~5KB. Should fit. If not, extend before deploy.

5. **MPC finalization timing**. The deposit tx queues an Arcium MPC computation. The on-chain submission completes in 1-2s; MPC finalizes off-chain in 5-15s; the SDK awaits this and surfaces a callback signature. Preserve the existing UI's "computing on-chain" progress display — just remove the duplicate popups.

## Acceptance criteria

- [ ] `cancel_payment_intent` ix in invoice-registry, deployed to devnet
- [ ] 3 new tests (happy + wrong-payer + already-paid) — all passing
- [ ] `payInvoiceFromShieldedBatched` shipped in `payInvoiceCpi.ts`
- [ ] `umbra.ts::payInvoiceFromShielded` calls the batched path first; SDK fallback unchanged
- [ ] Dashboard surfaces "Release payment intent" button on stuck locks (lock present + invoice Pending + locked_at > 60s old + viewer is the lock's payer)
- [ ] tsc + next build clean
- [ ] All existing tests still pass: `dashboard-render` (6/6), `veilpay` (10/10 — adds 3 cancel tests if added to veil-pay harness)
- [ ] Live test: shielded pay succeeds in ONE popup; both dashboards show "Paid · settling" within 5s of confirm
- [ ] Live test (negative): force a tx-2 failure (e.g. by depleting Bob's encrypted balance between txs); dashboard surfaces recovery button; one click releases the lock

## Reporting back

Punch list (under 350 words):

1. **Files modified / created** with 1-line description per file
2. **Discriminator** for `cancel_payment_intent` (verify against regenerated IDL)
3. **Anchor build / test status** for invoice-registry
4. **Frontend tsc + dashboard-render tests**
5. **Devnet redeploy** — did you deploy invoice-registry? tx sig? OR stopped short for marcin to deploy?
6. **Live shielded-pay test result** (or "could not run because no wallet — marcin needs to verify")
7. **Anything stubbed or skipped**
8. **Next steps for marcin** — env update, browser refresh, live test sequence
