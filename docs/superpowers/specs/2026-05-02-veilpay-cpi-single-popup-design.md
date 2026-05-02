# VeilPay — Single-Popup Private Payments via On-Chain CPI

**Date:** 2026-05-02
**Author:** Veil team (brainstormed with Claude Code)
**Status:** Design approved, ready for implementation plan

---

## Context

Veil's current public-balance pay flow (`payInvoice` in `app/src/lib/umbra.ts:615`) requires the user to sign **2 Phantom transactions** — one to create the proof-buffer PDA, then one to deposit into Umbra's stealth pool. Both popups are flagged by Phantom as *"This transaction reverted during simulation. Funds may be lost if submitted."*

The simulation reversion is a verified Anchor error 3012 (`AccountNotInitialized` on `public_stealth_pool_deposit_input_buffer`) — the deposit tx references an account that the proof-buffer tx hasn't yet committed at the moment Phantom's preflight runs. This is a **textbook two-tx race against wallet preflight**, not anything Umbra-specific.

This spec describes a fix that simultaneously achieves two demo-critical goals:
1. **One Phantom popup per payment** (down from 2)
2. **Phantom shows "-1 SOL" in the popup** (currently shows nothing because simulation fails)

## Goals

- Users sign **one** Solana transaction per public-balance private payment
- Phantom's preflight succeeds → popup displays the actual SOL outflow
- Demo story: "we composed Umbra's primitives via on-chain CPI to deliver a single-signature private payment UX"
- No protocol-level changes to Umbra
- Backward-compatible: feature-flag fallback to existing 2-popup SDK orchestration

## Non-goals

- Reducing the **shielded-balance** pay path below 2 popups. That path goes through Umbra's MPC relayer and has architectural floors (proof + queue must be sequential txs because the queue tx reads on-chain state set by proof commit). Out of scope for this spec.
- Changing scan/claim/mark_paid behavior on the recipient side
- Modifying the `invoice-registry` Anchor program
- Eliminating the rent cost of the proof buffer (~0.005 SOL per payment) — separately addressed in Phase 1 work

## Architecture

A new Anchor program **`veil_pay`** lives at `programs/veil-pay/`, sibling to existing `invoice-registry`. It exposes one public instruction:

```rust
pub fn pay_invoice(
    ctx: Context<PayInvoice>,
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    h2_hash: [u8; 32],
    linker_enc: [[u8; 64]; 2],
    keystream_commit: [[u8; 32]; 2],
    aes_data: Vec<u8>,
    optional_data: Vec<u8>,
    proof_account_offset: u128,
    transfer_amount: u64,
    fee_args: FeeSlabFields,
) -> Result<()>
```

The instruction body does two CPIs to Umbra (`DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ` on devnet, `UMBRAD2ishebJTcgCLkTkNUx1v3GyoAgpTRPeWoLykh` on mainnet):

1. `CreatePublicStealthPoolDepositInputBuffer` — writes proof + commitments into a fresh PDA-derived buffer account
2. `DepositIntoStealthPoolFromPublicBalance` — consumes the buffer, transfers `transfer_amount` from user's ATA into stealth pool, creates receiver-claimable UTXO

Because both CPIs execute inside one Solana transaction, atomicity guarantees the buffer exists when the deposit reads it. Phantom's preflight runs them in-process, sees the SOL outflow, produces a clean preview.

### Why this is feasible

Static analysis on the dumped Umbra binary (`C:\Users\marci\AppData\Local\Temp\umbra-program.so`, 4,950,408 bytes) confirmed:

- Zero references to `Sysvar1nstructions` (the standard mechanism for a Solana program to detect/reject CPI by checking the calling instruction sysvar)
- Zero references to `stack_height` or `TopLevelCaller` (the alternative CPI-rejection mechanism)
- IDL signatures show standard Anchor signer markers; no bespoke signer-source checks
- Umbra's IDL explicitly documents sponsored-tx support: `feePayer` is separable from `depositor` "to allow for sponsored transactions" (`umbra-codama/dist/index.d.ts:19510-19512`) — implies CPI-friendly by design

Confidence: ~70% from static evidence. Three runtime probe attempts on Windows hit infrastructure walls (symlink permissions, Defender vs bz2 race, missing Hyper-V VM Platform feature) — runtime confirmation deferred to in-flight integration testing on devnet. **Documented risk: the on-chain Umbra binary is closed-source and could contain a bespoke `is_signer` check static analysis missed.** Mitigation: fallback path (see Risks).

## Components

### `programs/veil-pay/` — new Anchor crate
- `programs/veil-pay/src/lib.rs` — single instruction `pay_invoice`
- `programs/veil-pay/Cargo.toml` — depends on `anchor-lang`
- Updates to root `Anchor.toml` to register the workspace + program ID

### `app/src/lib/payInvoiceCpi.ts` — new client wrapper (~200 LOC)
- Vendored fork of SDK's `getPublicBalanceToReceiverClaimableUtxoCreatorFunction` (`node_modules/@umbra-privacy/sdk/dist/index.cjs:8842-9347`)
- Reuses lines 8864-9176 verbatim: master seed access, key derivations, encryption blobs, timestamp construction, ZK proof generation
- Replaces lines 9287-9319 (the two `buildAndSendTransaction` calls) with single tx construction targeting `veil_pay::pay_invoice`
- Returns identical `PayInvoiceResult` shape as existing `payInvoice` for drop-in replacement

### `app/src/lib/umbra.ts` — minimal modification
- `payInvoice` becomes a 5-line delegator
- Behind feature flag `USE_VEIL_PAY_CPI` (default `true` in dev, controlled per env in prod)
- Falls back to existing SDK orchestration if flag is off OR if `NEXT_PUBLIC_VEIL_PAY_PROGRAM_ID` env var is missing

### `app/.env.example` — new env var
- `NEXT_PUBLIC_VEIL_PAY_PROGRAM_ID` — the deployed VeilPay program ID

## Data flow

```
User clicks Pay
  ↓
Off-chain (payInvoiceCpi):
  1. Get masterSeed from cached client.masterSeed (existing pattern)
  2. Derive nullifier, randomSecret, AES key, ECDH shared secret with recipient
     (vendored SDK lines 8875-9132)
  3. Build encryption blobs (linker_enc, keystream_commit, aes_data, h2_hash)
  4. Generate Groth16 proof via @umbra-privacy/web-zk-prover prover
  5. Compute deterministic addresses for buffer PDA + all 21 Umbra accounts
  6. Build single Solana TransactionMessage with one instruction calling
     veil_pay::pay_invoice — args + accounts via remaining_accounts
  ↓
Phantom prompts user (ONCE) → preflight succeeds → shows -1 SOL preview → user signs
  ↓
Tx submitted to Solana RPC
  ↓
On-chain (veil_pay::pay_invoice):
  1. CPI to Umbra::CreatePublicStealthPoolDepositInputBuffer
  2. CPI to Umbra::DepositIntoStealthPoolFromPublicBalance
  3. Both succeed atomically OR both fail (Solana atomicity)
  ↓
Tx confirmed → returned signature → Veil's existing scan/claim/mark_paid pipeline runs unchanged
```

## Error handling

| Failure mode | Where caught | User-facing surface |
|---|---|---|
| Master seed not loaded | Client (existing pattern) | Sign-message popup first (one-time per session) |
| ZK proof gen fails | Client | Toast: "Privacy proof generation failed — retry" |
| Insufficient wSOL in user ATA | Phantom preflight (now succeeds-then-shows-error) | Phantom standard "transaction will fail" with accurate balance preview |
| CPI rejection from Umbra | On-chain | Anchor error from VeilPay's CPI call → propagates via tx logs → existing pay-flow error handler |
| Network / RPC error | Client | Existing pay-flow error handler |
| **VeilPay program not deployed** | Client | Feature-flag fallback to SDK orchestration (2-popup) |

## Testing strategy

- **Anchor unit tests** in `programs/veil-pay/tests/` — verify instruction shape, account constraints, build cleanly. Cannot fully test CPI without local Umbra deployment (which we couldn't get working — see Risks).
- **Devnet integration smoke** — deploy VeilPay to devnet, run an end-to-end pay through the new path, verify single Phantom popup + correct SOL outflow display + tx success
- **Manual demo run** — record the pay flow with the popup count visible in DevTools console (existing `[Veil popup #N]` logs at `app/src/lib/umbra.ts:103-126`)
- **Fallback verification** — set `USE_VEIL_PAY_CPI=false`, confirm SDK orchestration still works unchanged
- **Existing test suite** — `npm test` (vitest) must still pass; recipient-side scan/claim/mark_paid behavior unchanged

## Risks

### CPI rejection at runtime (estimated probability: 30%)
Static analysis is strong evidence but not conclusive. If Umbra's compiled program has a CPI-rejection check that doesn't appear as a recognizable string in the binary (e.g., implicit through CPI-stack inspection in Rust idiom), our deposit CPI could fail.

**Mitigation:** feature-flag fallback to SDK orchestration. If devnet integration testing reveals CPI is blocked, we ship the existing 2-popup path with a documented v0.2 roadmap. No code thrown away — `payInvoiceCpi.ts` becomes deprecated until an SDK update.

**Alternative path if CPI is blocked:** client-side composition. Build both Umbra ix in one Solana tx using `@solana/web3.js` directly (no on-chain VeilPay program). Same single-popup outcome but less elegant story for judges. ~1 day pivot work, recoverable.

### Compute unit budget (estimated probability: 15%)
Umbra's deposit verifier consumes ~1.2M CU. Adding CPI overhead pushes the combined tx to ~1.4M CU — Solana's per-tx max. If actual measurement exceeds 1.4M, the tx will fail with `ComputeBudgetExceeded`.

**Mitigation:** measure CU during devnet integration test. If over budget, we can either (a) pre-create the proof buffer in a separate tx (back to 2 popups, defeats the goal) or (b) submit each CPI in its own outer tx (also defeats the goal). Both are acknowledged-failure modes — no clean recovery if we hit the cap.

### SDK orchestration extraction complexity (estimated probability: 20%)
The vendored fork of SDK lines 8864-9176 (~330 LOC of cryptography) might depend on internal SDK state we can't easily access (e.g., closure-scoped helpers not exported).

**Mitigation:** verify during early implementation. If extraction proves intractable, pivot to client-side composition (above) which doesn't require extracting from the SDK — uses `@solana/web3.js` directly to build instructions.

### Closed-source program risk
Umbra's source code is not public. We cannot fully verify what the on-chain program checks beyond what the IDL exposes. Static analysis on the binary is our best signal.

**Mitigation:** devnet integration testing is the runtime check. Plus the fallback path means worst case is "we ship 2 popups and add VeilPay in v0.2" — not "we lose the entire pay flow."

## Out of scope (future work)

- **Shielded-pay path optimization** — needs separate design; involves Umbra MPC relayer integration
- **Auto-batching of `mark_paid` after claim** — already deferred per existing roadmap
- **VeilPay-emitted events** for indexing — could add later if recipient-side reconciliation needs additional signals
- **Compute budget reduction in proof verification** — would require Umbra protocol-level work

## Definition of done

1. `programs/veil-pay/` Anchor crate builds with `anchor build`
2. VeilPay deployed to devnet, program ID set in env
3. `app/src/lib/payInvoiceCpi.ts` implemented and replaces SDK orchestration when flag is on
4. End-to-end pay flow on the live deployment: user clicks Pay → ONE Phantom popup with "-1 SOL" preview → tx confirms → recipient dashboard claims → invoice marked paid
5. Console logs show `[Veil popup #1]` only (not #2 or #3) for the public-balance pay path
6. Feature flag tested in both states (`USE_VEIL_PAY_CPI=true` → new path; `false` → SDK orchestration)
7. Type-check (`npx tsc --noEmit`) and existing tests (`npm test`) pass
8. Live deployment updated via Netlify CI

## Decision log

- **Approach selected:** Custom CPI wrapper Anchor program (over: SDK patch via patch-package; over: capturing-signer pattern). Rationale: clean engineering, our program owns orchestration, future-proof against SDK upgrades, becomes a meaningful technical execution piece for the hackathon submission.
- **Effort budget:** D — "as much as it takes" (per user). Estimated 2-3 days.
- **Confidence at design time:** 70% from static analysis; runtime confirmation deferred to integration testing on devnet.
- **Fallback:** client-side composition (build both Umbra ix in one tx via `@solana/web3.js`, no on-chain VeilPay). Recoverable in ~1 day.
