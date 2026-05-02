# Fresh-Wallet Smoke Test

End-to-end manual test an implementer or reviewer can run against a freshly deployed Veil to verify nothing is broken before submission. Expected runtime: 15–20 minutes.

## Prereqs

- Chrome (or Brave/Firefox) with three separate profiles: **Alice**, **Bob**, **Carol**.
- Phantom extension installed in each profile.
- Devnet RPC responsive (if using public devnet, run `solana cluster-version --url https://api.devnet.solana.com` to confirm).
- Veil deployed at a public URL (or `npm run dev` locally on localhost:3000).

## 1. Create fresh wallets

For each profile (Alice, Bob, Carol):

- [ ] Open Phantom → "Create a new wallet" → save the seed phrase to a scratchpad (these are throwaway devnet wallets).
- [ ] Settings → Developer settings → change network to **Devnet**.
- [ ] Copy the pubkey.
- [ ] In a terminal: `solana airdrop 2 <pubkey> --url https://api.devnet.solana.com`. Repeat if rate-limited; use https://faucet.solana.com as fallback.

You now have three wallets each holding 2 devnet SOL.

## 2. Wrap SOL for Bob (payer)

If `NEXT_PUBLIC_PAYMENT_MINT` is wSOL (per Day 1 fallback), Bob needs wrapped SOL to pay. If it's USDC, skip to step 3 and mint devnet USDC via https://faucet.circle.com.

- [ ] In Bob's browser, from the Veil root:
  ```bash
  npm run wrap-sol -- --wallet <bob-pubkey-keypair-path> --amount 1
  ```
  (The exact command depends on the wrap script — if missing, use `spl-token wrap 1 --url devnet` after `solana config set --keypair <bob-keypair>`.)
- [ ] Confirm Bob's wSOL ATA is funded: `spl-token balance So11111111111111111111111111111111111111112 --url devnet`.

## 3. Alice registers and creates an invoice

- [ ] Open Veil in Alice's browser. Connect Phantom.
- [ ] If prompted, click "Register with Umbra" — this signs a message and derives Alice's Umbra keypair. Approve in Phantom.
- [ ] Click **New invoice**.
- [ ] Fill in:
  - Amount: `1.5` (in payment-mint units — 1.5 USDC or 1.5 SOL depending on mint)
  - Memo: `March retainer`
  - Line item (if UI has it): `Design work — March 2026`
- [ ] Click **Create**. Approve the Phantom transaction.
- [ ] Expected: invoice detail page loads with status **Pending** and a **Copy pay URL** button.
- [ ] Click Copy pay URL. Paste into a scratchpad.

## 4. Bob pays the invoice

- [ ] Switch to Bob's browser.
- [ ] Paste the pay URL into the address bar. Hit enter.
- [ ] Connect Phantom → approve.
- [ ] If prompted, click "Register with Umbra". Approve in Phantom.
- [ ] Expected: pay page loads with Alice's memo, amount, and a **Pay** button.
- [ ] If a "Pay from shielded balance" toggle is visible (Feature C landed), leave it OFF for this first run (we want to exercise the public-deposit → UTXO flow).
- [ ] Click **Pay**. Approve Phantom transactions (expect payment approvals only; Bob should not approve a `mark_paid` transaction).
- [ ] Expected: success state with a receipt URL. The receipt may not verify as paid until Alice claims and marks the invoice paid.

## 5. Alice's dashboard reflects the payment

- [ ] Switch back to Alice's browser.
- [ ] Navigate to `/dashboard`.
- [ ] Wait up to 60s (auto-claim polls every 30s and calls `mark_paid` as Alice after a successful claim).
- [ ] Expected: the invoice row flips to **Paid**. A green checkmark or "Paid" badge is visible.
- [ ] Click the invoice row — the detail page shows `status=Paid`, `paid_at=<timestamp>`, `utxo_commitment=<bytes>`.

## 6. (Optional, Feature E) Export CSV

If Feature E (tax-ready export) is implemented:

- [ ] On the dashboard, click **Export CSV**.
- [ ] Expected: browser downloads `veil-invoices-<timestamp>.csv`.
- [ ] Open in a spreadsheet — confirm columns: `invoice_id, payer_wallet, amount_native, symbol, usd_at_receipt, timestamp, mark_paid_tx_sig, arweave_uri`.

If Feature E is not implemented, skip.

## 7. Alice issues a compliance grant to Carol

- [ ] In Alice's browser, navigate to `/dashboard/compliance`.
- [ ] Paste Carol's pubkey into the "Auditor wallet" field.
- [ ] Set scope:
  - Mint: same mint as the invoice (USDC or wSOL)
  - Time range: **March 2026** (or whatever month the test was run in)
- [ ] Click **Issue grant**. Approve Phantom.
- [ ] Expected: the grant appears in a list on the same page with status **Active**.

## 8. Carol views the audit page

- [ ] Switch to Carol's browser.
- [ ] Navigate to `<veil-url>/audit/<alice-pubkey>`.
- [ ] Connect Phantom as Carol.
- [ ] Expected: the invoice Alice created is visible in Carol's list, with the amount **decrypted and readable**. Invoices outside the scope (other mints, other months) are NOT visible.

## 9. Revocation (optional)

- [ ] Switch back to Alice's browser.
- [ ] On `/dashboard/compliance`, click **Revoke** on the grant to Carol.
- [ ] Approve Phantom.
- [ ] Switch to Carol's browser → reload `/audit/<alice-pubkey>`.
- [ ] Expected: invoice amounts are no longer decryptable (either a "grant revoked" message or redacted amounts).

## 10. Private payroll WOW path

- [ ] Open `/payroll/outgoing` in Alice's browser.
- [ ] Paste a CSV with two contractor wallets, small amounts, and memos.
- [ ] Select **Auto** funding mode.
- [ ] Click **Run private payroll** and approve the Umbra transactions.
- [ ] Expected: each row shows `paid`, an explorer transaction link, and the page shows the public-vs-Veil explorer comparison.
- [ ] Click **Sign receipt packet** and approve the one message signature.
- [ ] Expected: a JSON packet downloads and a `/payroll/packet#...` verifier link is available.
- [ ] Copy one row's disclosure link and open it in a clean tab.
- [ ] Expected: `/disclose/payroll#...` verifies the employer signature and shows only that selected payroll row.

## Pass criteria

All of the following must be true to consider the smoke test passed:

- [ ] Alice created an invoice and got a pay URL.
- [ ] Bob loaded the pay URL, paid, and saw a success state.
- [ ] Alice's dashboard reflected "Paid" within 60s.
- [ ] Alice issued a compliance grant to Carol without errors.
- [ ] Carol reached the invoice audit page and saw the grant/re-encryption state, or used the signed payroll packet for full amount disclosure.
- [ ] Private payroll produced at least one paid Umbra tx and a signed packet verifier link.
- [ ] A single-row payroll disclosure link verified successfully.
- [ ] (If Feature E) CSV export downloaded with correct columns.
- [ ] No console errors in any browser (open DevTools → Console tab, should be clean or only contain known warnings).

## Known gotchas

- **Cold-start ZK prover.** The first payment Bob makes will take 5–10s longer than subsequent ones because the prover WASM is loading. This is expected; don't panic.
- **Devnet RPC flakiness.** Public devnet returns 429 under load. If Bob's payment tx fails with "blockhash not found" or "Too Many Requests", switch `NEXT_PUBLIC_RPC_URL` to a Helius or QuickNode devnet URL.
- **Bundlr upload fails.** If invoice creation errors at the Arweave-upload step, check that `BUNDLR_PRIVATE_KEY` is set server-side and the Bundlr wallet has credit. Run `npx @bundlr-network/client balance <pubkey> -h https://node1.bundlr.network -c solana` to check.
