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
- **Pay** - Bob opens a shareable link, the UI wires his wallet, pays through Umbra's shielded pool, and can sign a receipt intent tied to the invoice PDA. Amount is hidden on-chain; counterparty linkage is broken by the mixer.
- **Reconcile** - Alice's dashboard auto-claims incoming UTXOs, then marks pending invoices paid as the recipient/creator. CSV export is one click (feature pending - see roadmap).
- **Audit** - Alice issues a scoped viewing key to her accountant's wallet. The accountant loads `/audit/<alice>`, sees exactly the invoices they're authorized to see - amounts decrypted, nothing else visible.

## Live demo

- App: **https://veil.vercel.app** *(placeholder — replaces after Vercel deploy)*
- Video: **https://youtu.be/REPLACE_ME** *(placeholder — replaces after video upload)*

## Architecture

Veil is a Next.js 14 frontend over a minimal Anchor registry program, coupled client-side to Umbra's encrypted-balance + mixer SDK. The program stores only tamper-evident invoice state (hash of ciphertext, Arweave URI, status). Real invoice content lives encrypted on Arweave. Payments flow through Umbra UTXOs. Compliance grants are Umbra-native x25519 viewing keys scoped by mint + time range.

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
        |                                                          | 5. pay via Umbra UTXO
        |                                                          |    (shielded pool)
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

## Quickstart

```bash
git clone https://github.com/<org>/veil
cd veil
npm install
cd app && cp .env.example .env.local  # fill in env vars (see below)
cd .. && npm run dev
```

Open http://localhost:3000 with Phantom on devnet.

### Required env vars (`app/.env.local`)

| Name | Purpose | Default |
|---|---|---|
| `NEXT_PUBLIC_SOLANA_NETWORK` | `devnet` or `mainnet` | `devnet` |
| `NEXT_PUBLIC_RPC_URL` | Solana RPC endpoint | `https://api.devnet.solana.com` |
| `NEXT_PUBLIC_RPC_WSS_URL` | Solana RPC WebSocket | `wss://api.devnet.solana.com` |
| `NEXT_PUBLIC_INVOICE_REGISTRY_PROGRAM_ID` | Deployed Anchor program ID | `54ryi8hcihut8fDSVFSbN5NbArQ5GAd1xgmGCA3hqWoo` |
| `NEXT_PUBLIC_PAYMENT_MINT` | Mint used for invoices | Devnet USDC or wSOL |
| `BUNDLR_PRIVATE_KEY` | Server-side key for Arweave uploads | *(no default — required)* |
| `BUNDLR_NODE_URL` | Bundlr node URL | `https://node1.bundlr.network` |

## Features

- **A — Compliance grants, end-to-end.** Issue a time-and-mint-scoped viewing key to an auditor; revoke anytime. First hackathon demo of Umbra's x25519 compliance primitive wired into a real product flow.
- **B — Batch / payroll invoicing.** Paste a CSV, generate 20 private invoice links in one pass. One dashboard view for the whole batch. No more Gnosis Safe + Disperse.app + privacy leak.
- **C — Pay from encrypted balance ("full shielding").** When Bob already holds Umbra balance, his payment happens entirely inside the shielded pool — no public deposit leg, no amount leak to any observer.
- **D - Proof-of-payment receipts.** On successful payment, Bob receives a signed receipt artifact tied to the invoice PDA and his wallet. A public verifier page confirms the receipt signature and the invoice's paid status without revealing the amount or requiring Bob to be the `mark_paid` signer.
- **Bugfixes / polish.** Dashboard BigInt fix; clickable invoice rows; deterministic wallet-signature key derivation for encrypted metadata.

## Links

- Colosseum project page: https://arena.colosseum.org/projects/veil *(placeholder)*
- Superteam Umbra track: https://earn.superteam.fun/listings/hackathon *(placeholder)*
- Repository: https://github.com/<org>/veil *(placeholder)*
- Demo video: https://youtu.be/REPLACE_ME *(placeholder)*

## License

MIT
