# Veil — Private Invoicing on Solana

**Private business records, verifiable accounting.** Invoice contents and amounts are encrypted by default. Payment-to-invoice correspondence is on-chain proof. Share a per-invoice receipt or a date-range compliance grant — auditors verify against chain without trusting Veil.

Built for the [Colosseum Frontier Hackathon](https://arena.colosseum.org/), April–May 2026.

---

## The problem

Crypto payments today are a privacy disaster for anyone running a business on-chain.

- **Every payroll is a public spreadsheet.** Paying employees or contractors in stablecoins exposes salaries to anyone with a block explorer — teammates see each other's comp, competitors track hiring patterns, scammers map attack surfaces. (PIVY, 2026)
- **Auditor access is all-or-nothing.** Accountants and tax teams need visibility into invoice history. Today, the choice is "hand over your full wallet" or "email CSVs monthly." Nothing in between is cryptographic.
- **There are no receipts.** Crypto payments are non-reversible, but there's also no standard receipt a payer can show a dispute process. "I paid you, you say you didn't get it" has no cryptographic answer.

## What Veil does

- **Create** - Alice issues an invoice. Metadata (amounts, memo, line items) is AES-256-GCM encrypted client-side, uploaded to Arweave, and hash-anchored to an on-chain Anchor PDA.
- **Pay** - Bob opens a shareable link, the UI wires his wallet, pays through Umbra's shielded pool in a single popup (via the VeilPay CPI wrapper). The same outer transaction creates a `PaymentIntentLock` PDA recording `(invoice, payer, locked_at)` — that lock is the on-chain proof of payment.
- **Reconcile (auto)** - Alice's dashboard scans lock PDAs every refresh. The moment a lock appears for a Pending invoice, the row flips to "Paid · settling" and a single-popup `mark_paid` auto-fires from her wallet. No receipt paste, no manual intervention. (The "More → Import receipt" recovery flow remains for off-channel payments.)
- **Run private payroll** - An employer uploads `wallet,amount,memo`, sends Umbra payments to contractors, and signs one payroll packet for receipts, auditor review, and per-row selective disclosure.
- **Audit / disclose** - Invoice compliance grants are wired through Umbra's x25519 grant primitives; payroll uses signed packets and one-row disclosure links so an accountant or recipient can verify exactly the data they were given. A public verifier at `/verify/<invoicePda>#k=<token>` attests on-chain status to anyone holding the capability link.

## Live URLs

- App: **https://veil-app-production.up.railway.app**
- Repo: **https://github.com/michal-marcinko/veil**
- Demo video: see the link submitted via Superteam Earn

**Devnet program IDs (stable):**
- Invoice registry: `54ryi8hcihut8fDSVFSbN5NbArQ5GAd1xgmGCA3hqWoo`
- VeilPay (CPI wrapper): `E2G6dN7yY8VQ2dFRgkvqskdAnPhJXkdorYP6BhKvfa8m`

**Verifier link shape:** `https://veil-app-production.up.railway.app/verify/<invoicePda>#k=<token>` where `token = base58(metadataHash[0..6])`. Without the token, the verifier renders nothing — capability-URL gate per W3C TAG.

Connect any Solana wallet on devnet with a small amount of wrapped SOL. The pay flow uses wSOL on devnet because Umbra hasn't initialized the USDC stealth pool there — see [`app/.env.example`](app/.env.example) for full notes. Mainnet supports USDC, USDT, wSOL, and UMBRA.

### Wallet compatibility

Veil works with any Solana wallet. We recommend **Solflare** for the cleanest UX on devnet because Phantom routes through Blowfish, which currently doesn't simulate unverified ZK programs on devnet — we've requested Blowfish review for our mainnet launch. Phantom still works (you'll just see a "Failed to simulate" warning before signing); Solflare uses raw RPC `simulateTransaction` and previews the transaction correctly.

## Architecture

Veil is a Next.js 14 frontend over two minimal Anchor programs (an invoice registry and a single-popup pay wrapper called VeilPay), coupled client-side to Umbra's encrypted-balance + mixer SDK. The registry stores only tamper-evident invoice state (hash of ciphertext, Arweave URI, status). Real invoice content lives encrypted on Arweave. Payments flow through Umbra UTXOs. Compliance grants are Umbra-native x25519 viewing keys scoped by mint + time range.

### Deployed program IDs (devnet)

| Program | Address |
|---|---|
| Invoice registry | `54ryi8hcihut8fDSVFSbN5NbArQ5GAd1xgmGCA3hqWoo` |
| VeilPay (CPI wrapper) | `E2G6dN7yY8VQ2dFRgkvqskdAnPhJXkdorYP6BhKvfa8m` |
| VeilPay ALT | `5MKHHKbHTZNqTtd9zTg59rWv5hbLKofj26Jv8LNMtket` |
| Umbra deposit program | `DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ` |

```
   Alice (payee)                                               Bob (payer)
        |                                                          |
        | 1. encrypt metadata (AES-256-GCM)                        |
        | 2. upload ciphertext to Arweave                          |
        | 3. create_invoice tx  ─────► Invoice PDA                 |
        |      (hash, arweave_uri, status=Pending)                 |
        |                                                          |
        |                          shareable URL ─────────────────►|
        |                                                          |
        |                                                          | 4. fetch+decrypt metadata
        |                                                          | 5. pay via VeilPay CPI
        |                                                          |    (single popup → Umbra UTXO
        |                                                          |     + PaymentIntentLock PDA)
        |                                                          |
        | 6. dashboard scans lock PDAs → row flips to "Paid · settling"
        | 7. lazy mark_paid auto-fires from creator's wallet       |
        |                          ◄──── Invoice.status = Paid     |
        |                                                          |
        | 8. issue compliance grant ─────► Auditor (Carol)         |
        |     (mint + time scope)             decrypts Alice's     |
        |                                     invoices in range    |
        |                          ─────► Public verifier (anyone) |
        |                          /verify/<pda>#k=<token>         |
        |                          renders green/yellow/red        |
        |                          from chain alone                |
```

## VeilPay program — our technical differentiator

`programs/veil-pay/` is a small Anchor program we wrote specifically to make the pay flow human-grade. It's the piece of work we are most proud of, and the reason the demo holds up under real wallet UX.

- **One Phantom/Solflare popup instead of two.** The Umbra SDK's stock deposit path requires two signatures from the payer: one for `create_buffer` (writes the encrypted blob into a buffer PDA) and one for `deposit` (consumes the buffer and posts the UTXO). VeilPay bundles both inner instructions into a single CPI under one outer ix, so the payer signs **once**. The full bundle goes through `signAllTransactions` in lockstep with the Arcium MPC queue ix, keeping the entire pay flow to one wallet popup.
- **Address Lookup Table to fit the 1232-byte cap.** Even bundled, the deposit tx has 19 unique account keys and tips over Solana's 1232-byte transaction size limit by ~250 bytes. We deploy a static ALT (program ID `5MKHHKbHTZNqTtd9zTg59rWv5hbLKofj26Jv8LNMtket`) holding 13 of those keys (the static ones — token program, system program, Umbra protocol config, fee schedule, etc.) so the message body references them as 1-byte indices. Build script: [`app/scripts/deploy-veilpay-alt.mjs`](app/scripts/deploy-veilpay-alt.mjs).
- **One-popup-per-batch payroll.** The same CPI-bundling technique scales to payroll: the employer signs one popup per recipient row, not two, which is the difference between a demoable B2B flow and an unusable one when the batch is 20 contractors.
- **Source.** The Anchor program lives at [`programs/veil-pay/programs/veil-pay/src/lib.rs`](programs/veil-pay/programs/veil-pay/src/lib.rs).

## Privacy model

We are deliberately precise about Veil's privacy claims so a reviewer or auditor can verify them. **Don't say "anonymous", "fully private payments", or "untraceable" about Veil.** Those overclaim. The honest split:

| What                                   | Private                       | Public                                          |
|----------------------------------------|-------------------------------|-------------------------------------------------|
| Invoice line items / memo / amount     | Encrypted on Arweave          |                                                 |
| Recipient's encrypted balance          | Umbra MXE                     |                                                 |
| Payment from **shielded** balance      | Amount + source invisible     | (no public deposit tx)                          |
| Payment from **public** balance        |                               | Umbra deposit tx visible — amount visible       |
| Payer ↔ invoice link                   |                               | `PaymentIntentLock` PDA records both pubkeys    |
| Recipient (creator) wallet             |                               | Always public (Invoice account `creator` field) |

**Pitch we use:** "Veil makes B2B payments private where it matters — amounts, balances, invoice contents, and payroll details stay encrypted. Payment-to-invoice reconciliation is on-chain proof, so auditors don't need to trust off-chain receipts."

**Devnet caveat (important for reviewers):**
On devnet the Umbra pool is low-volume — typically a handful of deposits per day. A determined chain analyst can map `Recipient withdraw → Pool → Specific sender deposit` in roughly 30 seconds via Solana Explorer because the anonymity set is too small to defeat timing + amount correlation. **This is a property of devnet's volume, not a Veil bug.** On mainnet, where the Umbra pool aggregates real volume across all of its users, this attack becomes practically infeasible — anonymity scales linearly with the size of the deposit set.

## How reconciliation works

Reconciliation is the question every business has after a payment lands: *did Bob's transfer correspond to my invoice #3201?* In banking it's resolved with a memo + bank statement. On Solana, we use a small on-chain primitive plus two opt-in disclosure surfaces.

**`PaymentIntentLock` PDA — the on-chain proof primitive.** When Bob pays an invoice through the VeilPay CPI wrapper, the same outer transaction creates a tiny PDA at `seeds = [b"intent_lock", invoicePda]` recording `(invoice, payer, locked_at)`. The lock IS the proof — its existence on chain is a cryptographic statement that Bob's wallet paid the invoice represented by `invoicePda`. Alice's dashboard scans the lock PDAs for her pending invoices on every refresh and:

- Renders the row as **"Paid · settling"** the moment the lock appears.
- Lazily fires `mark_paid` from the creator's wallet (single popup, idempotent — replays revert with `InvalidStatus` and cost only ~5000 lamports). On-chain status flips to `Paid` shortly after.

Settlement is the creator's act; the lock PDA is the canonical proof regardless of when the creator gets around to it. If Alice never opens her dashboard, the invoice account stays Pending — but the audit trail through the lock PDA is already complete.

**Capability-URL receipts.** Each invoice can be downloaded as a Receipt PDF that includes a QR code linking to a public verifier at `/verify/<invoicePda>#k=<token>`. The token is `base58(metadataHash[0..6])` and lives in the URL fragment, so it never reaches our server logs (per W3C TAG capability-URL guidance). The verifier renders nothing without the token — try the bare PDA without `#k=` and you get a paste-the-link form. With the token, it shows a green/yellow/red verdict from the chain alone (lock+mark_paid → green, lock only → yellow, neither → red).

**Compliance grants — the heavy-disclosure primitive.** Verifier attests on-chain state but never decrypts amounts or line items. For amount/line-item disclosure scoped to a date range or specific invoices, the creator issues a compliance grant — an Umbra-native x25519 viewing key with a time-and-mint scope. The auditor decrypts inside their browser; nothing about the grant goes through Veil's servers. Mirrors Zcash's two-tier model (full viewing key + per-payment disclosure).

## Quickstart

```bash
git clone https://github.com/michal-marcinko/veil
cd veil
npm install
cd app && cp .env.example .env.local  # fill in env vars (see below)
cd .. && npm run dev
```

Open http://localhost:3000 with any Solana wallet on devnet (Solflare recommended — see [Wallet compatibility](#wallet-compatibility) above).

### Required env vars (`app/.env.local`)

| Name | Purpose | Default |
|---|---|---|
| `NEXT_PUBLIC_SOLANA_NETWORK` | `devnet` or `mainnet` | `devnet` |
| `NEXT_PUBLIC_RPC_URL` | Solana RPC endpoint | `https://api.devnet.solana.com` |
| `NEXT_PUBLIC_RPC_WSS_URL` | Solana RPC WebSocket | `wss://api.devnet.solana.com` |
| `NEXT_PUBLIC_INVOICE_REGISTRY_PROGRAM_ID` | Invoice registry program ID | `54ryi8hcihut8fDSVFSbN5NbArQ5GAd1xgmGCA3hqWoo` |
| `NEXT_PUBLIC_VEIL_PAY_PROGRAM_ID` | VeilPay CPI wrapper program ID | `E2G6dN7yY8VQ2dFRgkvqskdAnPhJXkdorYP6BhKvfa8m` |
| `NEXT_PUBLIC_VEILPAY_ALT_ADDRESS` | Address Lookup Table for the pay tx | `5MKHHKbHTZNqTtd9zTg59rWv5hbLKofj26Jv8LNMtket` |
| `NEXT_PUBLIC_PAYMENT_MINT` | Mint used for invoices (devnet defaults to wSOL — Umbra hasn't initialized USDC's stealth pool there) | `So11111111111111111111111111111111111111112` |
| `BUNDLR_PRIVATE_KEY` | Server-side key for Arweave uploads | *(no default — required)* |
| `BUNDLR_NODE_URL` | Bundlr node URL | `https://node1.bundlr.network` |

## Features

- **A — Compliance grants, end-to-end.** Issue a time-and-mint-scoped viewing key to an auditor; revoke anytime. First hackathon demo of Umbra's x25519 compliance primitive wired into a real product flow.
- **B — Batch / payroll invoicing.** Paste a CSV, generate 20 private invoice links in one pass. One dashboard view for the whole batch. No more Gnosis Safe + Disperse.app + privacy leak.
- **C — Pay from encrypted balance ("full shielding").** When Bob already holds Umbra balance, his payment happens entirely inside the shielded pool — no public deposit leg, no amount leak to any observer.
- **D - Proof-of-payment receipts.** On successful payment, Bob receives a signed receipt artifact tied to the invoice PDA and his wallet. A public verifier page confirms the receipt signature and the invoice's paid status without revealing the amount or requiring Bob to be the `mark_paid` signer.
- **E - Inverse private payroll.** Employers can run outgoing payroll through Umbra, compare public-token payroll against Veil's opaque Umbra transactions, sign a payroll packet, and create per-recipient disclosure links.
- **Bugfixes / polish.** Dashboard BigInt fix; clickable invoice rows; deterministic wallet-signature key derivation for encrypted metadata.

## Trust model

Veil's invoice registry now uses two complementary primitives for state:

1. **`PaymentIntentLock` PDA** (Fix 2, 2026-05-06) — the canonical, payer-signed proof that this wallet paid this invoice. Created in the same transaction as the VeilPay deposit ix. No creator action required.
2. **`mark_paid` on the Invoice account** — bookkeeping. The creator can call this from their dashboard to flip on-chain `status` from Pending to Paid. With the lock PDA in place, this is now lazy: Alice's dashboard auto-fires `mark_paid` whenever it sees a lock for one of her Pending invoices on next load.

Settlement is the creator's act; on-chain status flips when the creator next opens their dashboard. The lock PDA is the canonical proof of payment — settlement is bookkeeping. The receipt-import recovery flow ("More → Import receipt") is still available for off-channel payments or auto-detection failures, but is no longer the primary path.

The public verifier at `/verify/<invoicePda>#k=<token>` checks lock + mark_paid status from the chain alone. It does NOT decrypt invoice contents — amounts and line items remain encrypted on Arweave. Amount-level audit goes through compliance grants (see [How reconciliation works](#how-reconciliation-works) above).

Outgoing payroll intentionally does not reuse the invoice PDA model. Payroll is payer-initiated: the employer sends Umbra receiver-claimable UTXOs directly to contractors, then signs a single packet covering the batch. `/payroll/packet` verifies the full packet for auditors; `/disclose/payroll` verifies one selected row for selective disclosure.

## Future work

- **CSV export of invoice history.** Today, auditor access is via Umbra-native x25519 grants; one-click CSV export for the invoice creator's own records is on the roadmap.
- **Settlement-side proofs.** Replace today's recipient-attested `mark_paid` with an Umbra-side settlement Merkle proof or a CPI hook from Umbra into the invoice registry, so the on-chain `Paid` state is provable from the deposit, not asserted by the creator.
- **Mainnet launch.** Pending Blowfish review for Phantom support and stealth-pool initialization for USDC on devnet (currently devnet only supports wSOL; mainnet supports USDC, USDT, wSOL, UMBRA).

## Links

- Live app: https://veil-app-production.up.railway.app
- Repository: https://github.com/michal-marcinko/veil
- Superteam Umbra track: https://earn.superteam.fun/listings/hackathon/build-with-umbra-side-track
- Demo video: see the link submitted via Superteam Earn

## License

MIT
