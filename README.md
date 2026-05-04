# Veil — Private Invoicing on Solana

**Business-grade payment privacy for freelancers and teams, with selective compliance access for auditors.**

Built for the [Colosseum Frontier Hackathon](https://arena.colosseum.org/), April–May 2026.

---

## The problem

Crypto payments today are a privacy disaster for anyone running a business on-chain.

- **Every payroll is a public spreadsheet.** Paying employees or contractors in stablecoins exposes salaries to anyone with a block explorer — teammates see each other's comp, competitors track hiring patterns, scammers map attack surfaces. (PIVY, 2026)
- **Auditor access is all-or-nothing.** Accountants and tax teams need visibility into invoice history. Today, the choice is "hand over your full wallet" or "email CSVs monthly." Nothing in between is cryptographic.
- **There are no receipts.** Crypto payments are non-reversible, but there's also no standard receipt a payer can show a dispute process. "I paid you, you say you didn't get it" has no cryptographic answer.

## What Veil does

- **Create** - Alice issues an invoice. Metadata (amounts, memo, line items) is AES-256-GCM encrypted client-side, uploaded to Arweave, and hash-anchored to an on-chain Anchor PDA.
- **Pay** - Bob opens a shareable link, the UI wires his wallet, pays through Umbra's shielded pool in a single popup (via the VeilPay CPI wrapper), and can sign a receipt intent tied to the invoice PDA. Amount is hidden on-chain; counterparty linkage is broken by the mixer.
- **Reconcile** - Alice's dashboard auto-claims incoming UTXOs, then marks pending invoices paid as the recipient/creator. CSV export is one click (feature pending - see roadmap).
- **Run private payroll** - An employer uploads `wallet,amount,memo`, sends Umbra payments to contractors, and signs one payroll packet for receipts, auditor review, and per-row selective disclosure.
- **Audit / disclose** - Invoice compliance grants are wired through Umbra's x25519 grant primitives; payroll uses signed packets and one-row disclosure links so an accountant or recipient can verify exactly the data they were given.

## Live demo

- App: **https://veil-app-205.netlify.app**
- Repo: **https://github.com/michal-marcinko/veil**
- Video: *Demo video shipping with submission*

Connect any Solana wallet on devnet with a small amount of wrapped SOL. The pay flow uses wSOL on devnet because Umbra hasn't initialized the USDC stealth pool there — see [`app/.env.example`](app/.env.example) for full notes. Mainnet supports USDC, USDT, wSOL, and UMBRA.

### Wallet compatibility

Veil works with any Solana wallet. We recommend **Solflare** for the cleanest UX on devnet because Phantom routes through Blowfish, which currently doesn't simulate unverified ZK programs on devnet — we've requested Blowfish review for our mainnet launch. Phantom still works (you'll just see a "Failed to simulate" warning before signing); Solflare uses raw RPC `simulateTransaction` and previews the transaction correctly.

## Architecture

Veil is a Next.js 14 frontend over two minimal Anchor programs (an invoice registry and a single-popup pay wrapper called VeilPay), coupled client-side to Umbra's encrypted-balance + mixer SDK. The registry stores only tamper-evident invoice state (hash of ciphertext, Arweave URI, status). Real invoice content lives encrypted on Arweave. Payments flow through Umbra UTXOs. Compliance grants are Umbra-native x25519 viewing keys scoped by mint + time range.

**VeilPay** is a thin CPI wrapper at `programs/veil-pay/` that bundles Umbra's `create_buffer` + `deposit` instructions into a single transaction so the payer signs **one** Phantom/Solflare popup instead of two. Combined with an Address Lookup Table holding 13 static accounts, the pay tx fits comfortably under Solana's 1232-byte cap.

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
        |                                                          |    (single popup → Umbra UTXO)
        |                                                          | 6. signed receipt intent
        | 7. scan + auto-claim UTXO                                |
        | 8. mark_paid as creator                                  |
        |                          ◄──── Invoice.status = Paid     |
        |                                                          |
        | 9. issue compliance grant ─────► Auditor (Carol)         |
        |    (mint + time scope)            decrypts Alice's       |
        |                                   invoices in range      |
```

## Trust model

Veil uses a recipient-only settlement model for invoice status. Bob's pay page only creates the Umbra receiver-claimable UTXO and, when his wallet supports `signMessage`, signs a receipt intent over the invoice PDA, wallet, metadata hash, timestamp, and payment UTXO signature. Bob does not call `mark_paid`.

Alice's dashboard is the reconciliation authority: after a successful `claimUtxos` call, it marks pending invoices paid as the invoice creator. The `utxo_commitment` is derived from the stable claim signature when the SDK exposes one; if not, the app falls back to `sha256(invoicePda.toBuffer())` so the mark-paid call remains deterministic.

The public receipt verifier checks two things only: the invoice PDA is currently `Paid` on-chain, and the receipt blob was signed by the claimed payer wallet. It does not require the payer wallet to match the on-chain `mark_paid` signer, because the signer is now the recipient/creator who claimed the UTXO.

Veil's invoice registry deliberately does not attempt to verify private Umbra payment contents on-chain - that would either leak data or require Umbra-side primitives outside the hackathon window. Instead, the recipient confirms receipt: only the invoice creator's wallet can mark an invoice paid, and only after their dashboard has scanned and claimed the incoming UTXO. This matches how every business invoice works - the seller acknowledges payment. Production roadmap: Umbra-side settlement Merkle proofs or a CPI hook from Umbra into our registry.

Outgoing payroll intentionally does not reuse the invoice PDA model. Payroll is payer-initiated: the employer sends Umbra receiver-claimable UTXOs directly to contractors, then signs a single packet covering the batch. `/payroll/packet` verifies the full packet for auditors; `/disclose/payroll` verifies one selected row for selective disclosure.

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

## Links

- Live app: https://veil-app-205.netlify.app
- Repository: https://github.com/michal-marcinko/veil
- Superteam Umbra track: https://earn.superteam.fun/listings/hackathon/build-with-umbra-side-track
- Demo video: *Demo video shipping with submission*

## License

MIT
