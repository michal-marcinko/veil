# Feature D E2E Smoke Test (devnet)

Runs end-to-end through create → pay → receipt → verify. Assumes the Core MVP
E2E in `app/tests/e2e-devnet.md` has been run at least once successfully.

## Preconditions

- `.env.local` set to `NEXT_PUBLIC_SOLANA_NETWORK=devnet`
- Alice and Bob wallets each have at least 0.1 devnet SOL
- Bob's wallet has at least 1.1 devnet USDC (invoice amount + fees)
- Dev server running: `cd app && npm run dev`

## Procedure

1. In Alice's browser at `http://localhost:3000/create`, create an invoice for 1 USDC. Copy the resulting `/pay/<pda>#<key>` link.
2. Open the link in Bob's browser. Connect Bob's wallet.
3. Click "Pay 1 USDC →". Approve the registration modal steps and the payment.
4. **Expected:** the "Payment sent." card now shows a "Receipt URL" block with a copy button.
5. Click "Copy". Expected: the status text flashes "Receipt URL copied." Paste the URL somewhere visible — it should be `http://localhost:3000/receipt/<pda>#<blob>`.
6. In Alice's browser, open `/dashboard` and wait for the UTXO claim to complete. Expected: the invoice flips to **Paid**; Alice signs the recipient-side `mark_paid`.
7. Open the copied URL in a **fresh browser tab with NO wallet connected** (open in an incognito window if Bob's wallet is auto-injecting).
8. **Expected:** the page renders "Valid receipt." with rows for Invoice, Paid by, Timestamp, Payment intent (clickable link to Solana Explorer), and Amount = "Not disclosed by receipt verifier".
9. Click the Payment intent link. Expected: Solana Explorer opens to Bob's UTXO/payment transaction and shows it as Finalized.
10. Corrupt the URL: change one character inside the `#<blob>` portion. Reload.
11. **Expected:** the page renders "Invalid receipt" with reason "Signature is invalid — this receipt was not signed by the claimed payer" (or "Malformed receipt blob" if the edit broke base64url decoding).
12. Corrupt the path instead: change one character of the PDA segment, keep the fragment intact. Reload.
13. **Expected:** the page renders "Invalid receipt" with reason "Receipt is for a different invoice than the URL path claims".

## Failure modes

- If step 4 shows no Receipt URL block but the receipt build error *does* render: `signMessage` likely isn't exposed by the wallet adapter. Confirm Phantom is the connected wallet (not a headless dev wallet) — wallet-adapter-base's SignerWalletAdapter interface declares `signMessage` as optional.
- If step 8 shows "Could not fetch invoice from chain": `NEXT_PUBLIC_RPC_URL` may be unset or the devnet RPC is rate-limited. Retry with a different RPC endpoint.
- If step 8 shows "Invoice on-chain status is not Paid": Alice's dashboard has not claimed and marked the invoice paid yet. Refresh `/dashboard`, approve any pending transaction, then retry the receipt URL.
- If step 11 shows "Valid receipt" instead of an invalid state: the canonical ordering in `canonicalReceiptBytes` is not being applied consistently between signer and verifier — reread `lib/receipt.ts` and verify both code paths go through `canonicalReceiptBytes`.

## Run log

<append dated entries here>
