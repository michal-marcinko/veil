# E2E Devnet Smoke Test

Procedure for verifying Veil end-to-end on Solana devnet. Run before final demo recording.

## Prerequisite checklist

- [ ] **Two funded devnet wallets** (Alice and Bob), each with **≥0.5 SOL**
  - `solana airdrop 0.5 <ALICE_PUBKEY> --url devnet`
  - `solana airdrop 0.5 <BOB_PUBKEY> --url devnet`
  - If airdrop is rate-limited, use https://faucet.solana.com (select Devnet)
- [ ] **Bob also has the payment token**
  - Preferred: ≥5 USDC-devnet (mint from the devnet USDC faucet)
  - Fallback: if Day 1 finding §1 (`docs/superpowers/investigation/2026-04-15-day-1-findings.md`) shows USDC is not live on devnet Umbra pools, use the fallback test token configured in Task 14 (`USDC_MINT` constant) — most likely wSOL (`So11111111111111111111111111111111111111112`) wrapped to ≥0.05 SOL worth
- [ ] **`app/.env.local` is fully configured**, specifically:
  - `NEXT_PUBLIC_SOLANA_NETWORK=devnet`
  - `NEXT_PUBLIC_INVOICE_REGISTRY_PROGRAM_ID=54ryi8hcihut8fDSVFSbN5NbArQ5GAd1xgmGCA3hqWoo` (deployed devnet program)
  - `BUNDLR_PRIVATE_KEY=<base58-encoded Solana secret key>` — **must be a real funded Solana keypair**, not a placeholder. Bundlr charges this wallet for Arweave uploads, so fund it with ~0.1 SOL devnet first.
- [ ] **Dev server running** at `http://localhost:3000` via `npm run dev` (from the `app/` directory)
- [ ] Two browser profiles open, one for Alice and one for Bob (Chrome profiles or Chrome + Firefox)
- [ ] Wallet extensions (Phantom / Solflare) set to **Devnet** in both browser profiles

### Pre-flight quick check

```bash
# From repo root, before opening browsers:
solana config get                         # confirm devnet cluster
solana balance <ALICE_PUBKEY> -u devnet   # ≥0.5 SOL
solana balance <BOB_PUBKEY> -u devnet     # ≥0.5 SOL
solana program show 54ryi8hcihut8fDSVFSbN5NbArQ5GAd1xgmGCA3hqWoo -u devnet  # confirms program is deployed
```

## Steps

### Alice creates an invoice

1. In Alice's browser: visit http://localhost:3000
2. Click **Create Invoice**, connect Alice's wallet
3. Fill the form:
   - Your name: `Alice Test`
   - Payer name: `Bob Test`
   - Payer wallet: leave empty
   - Line item: `Test service`, qty `1`, unit price `1000000` (= 1 USDC, or equivalent smallest-unit for the fallback token)
4. Click **Create Private Invoice**
5. Expected: `RegistrationModal` appears, progresses through its 3 steps, then closes
6. Expected: success screen with a share URL. Copy the URL.

### Bob pays

7. In Bob's browser: paste the URL into the address bar
8. Expected: invoice details render, showing Alice's name and 1 USDC total
9. Connect Bob's wallet
10. Click **Pay**
11. Expected: `RegistrationModal` appears for Bob (first-time user), progresses through 3 steps, closes
12. Expected: payment success banner `✓ Payment sent`

### Alice claims

13. In Alice's browser: visit `/dashboard`
14. Expected: invoice shows as **Paid** within 30 seconds
15. Expected: Alice's dashboard **auto-claims ALL received UTXOs** for Alice's wallet (the 2026-04-16 design addendum removed the per-invoice `filterUtxosByInvoicePdas` function — the dashboard indiscriminately claims every scannable UTXO owned by Alice, then updates the private balance panel)
16. Expected: "Private USDC balance" panel shows 1 USDC (minus Umbra fees)

### Compliance grant

17. In Alice's dashboard, click **Manage compliance grants**
18. Generate a dummy X25519 key (any 32-byte base58 string will do for smoke test) and paste it
19. Click **Grant access**
20. Expected: `Grant created successfully` message

## Known warnings to ignore

These warnings appear during `npm run dev` or browser console and are **expected / not blockers**:

- **SSR prerender wallet-context errors** — Next.js attempts to prerender wallet-connected pages server-side and throws `WalletNotConnectedError` or similar during build. The pages still hydrate correctly client-side. Safe to ignore unless a page fails to render in the browser.
- **`pino-pretty` module warning** — `Cannot find module 'pino-pretty'`. Pulled in transitively by a Solana/Umbra dep. Development-only log-prettifier; absence is harmless.
- **`bigint` native bindings warning** — `bigint: Failed to load bindings, pure JS will be used`. A dependency tries to load a native C++ bigint module and falls back to the JS implementation. Performance is slightly lower but correctness is unaffected.

## Failure modes

- If step 6 fails (invoice creation hangs at step 3 of registration): check Day 1 finding §1 — the chosen token may not have a live shielded pool on devnet. Try the fallback token.
- If step 11 fails: check Day 1 finding §2 (Umbra `optionalData` support on devnet).
- If step 14 doesn't flip to Paid within 30s: check `UMBRA_INDEXER_API` connectivity and browser-console scan logs.
- If step 16 shows 0 balance: check Day 1 findings §7 and §4 (balance query semantics). Note: because the dashboard claims ALL UTXOs (per design addendum), a zero balance likely means the scan or claim failed, not a per-invoice filter mismatch.
- If Bundlr upload fails in step 5: confirm `BUNDLR_PRIVATE_KEY` corresponds to a wallet with devnet SOL for Arweave fees.

## Run log

_Append timestamped entries here when executing the procedure._
