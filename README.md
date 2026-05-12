<p align="center">
  <img src="veil-icon.svg" alt="Veil" width="120" />
</p>

<h1 align="center">Veil</h1>

<p align="center"><strong>Private B2B payroll and invoicing on Solana, built on the <a href="https://sdk.umbraprivacy.com/introduction">Umbra SDK</a>.</strong></p>

[Live demo](https://veil-app-production.up.railway.app) · [Roadmap](docs/roadmap.md) · [Umbra Side Track on Superteam Earn](https://earn.superteam.fun/listings/hackathon/build-with-umbra-side-track)

![Solana devnet](https://img.shields.io/badge/solana-devnet-9945FF) ![Umbra SDK](https://img.shields.io/badge/umbra--sdk-2.1.1-1B1B1F) ![Anchor 1.0](https://img.shields.io/badge/anchor-1.0-blueviolet) ![Next.js 14](https://img.shields.io/badge/next.js-14-000) ![License MIT](https://img.shields.io/badge/license-MIT-green)

---

## The problem

> A twelve-person remote startup pays its contractors in USDC. Every salary lands on chain. The CTO can see what the new senior hire is making. Competitors track hiring patterns from the company wallet. A determined attacker maps the team's wallets and shows up at the contractor's door asking nicely (the [CertiK 2026 Wrench Attacks Overview](https://www.certik.com/blog/2026-wrench-attacks-overview) calls this the economically rational attack as wallet security improves).

Veil makes the financially sensitive parts of B2B billing private (amounts, balances, line items, payroll details) while making payment-to-invoice reconciliation trustlessly auditable on chain. No off-chain receipts the recipient can lose or forge.

## How it works

- **Create.** Alice issues an invoice. Line items + amount are AES-256-GCM-encrypted client-side, uploaded to Arweave, hash-anchored to an Anchor PDA. Only the URL fragment carries the decryption key.
- **Pay.** Bob opens the link, signs once. Behind that single popup, Veil bundles two Umbra ixs (`createStealthPoolDepositInputBuffer` + `depositIntoStealthPoolFromSharedBalanceV11`) and acquires a `PaymentIntentLock` PDA atomically via CPI into our invoice registry. One signature, one transaction, one on-chain proof.
- **Reconcile.** The dashboard scans for lock PDAs on every refresh. Lock found = invoice flips to "Paid · settling" + `mark_paid` lazy-fires from the creator. No receipt paste. No reconciliation tool. The lock IS the receipt.

## Live URLs

| | |
|---|---|
| App | https://veil-app-production.up.railway.app |
| Repo | https://github.com/michal-marcinko/veil |
| Demo video | submitted via Superteam Earn |
| Verifier example | `/verify/<invoicePda>#k=<token>` (anyone can attest) |

**Devnet programs (stable):**

| Program | Address |
|---|---|
| Invoice registry | `54ryi8hcihut8fDSVFSbN5NbArQ5GAd1xgmGCA3hqWoo` |
| VeilPay (CPI wrapper) | `E2G6dN7yY8VQ2dFRgkvqskdAnPhJXkdorYP6BhKvfa8m` |
| VeilPay ALT | `5jBhrvhFXTgXPRrSpzajXL7dW8gasPv42Y5gBSeJSpT8` |
| Umbra deposit (devnet) | `DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ` |

## Architecture

```
   Alice (creator)                                            Bob (payer)
        │                                                          │
        │ 1. AES-256-GCM encrypt metadata                          │
        │ 2. upload ciphertext → Arweave                           │
        │ 3. create_invoice tx ──► Invoice PDA                     │
        │    (hash, arweave_uri, status=Pending)                   │
        │                                                          │
        │      shareable URL  ────────────────────────────────────►│
        │                                                          │
        │                                                          │ 4. fetch + decrypt
        │                                                          │ 5. VeilPay CPI (1 popup):
        │                                                          │      • lock_payment_intent
        │                                                          │      • create_buffer (Umbra)
        │                                                          │      • deposit (Umbra)
        │                                                          │
        │ 6. dashboard scans lock PDAs → "Paid · settling"         │
        │ 7. lazy mark_paid fires from Alice's wallet              │
        │     Invoice.status = Paid                                │
        │                                                          │
        │ 8. compliance grant ──► Auditor (Carol)                  │
        │    (mint + time scope, x25519 viewing key)               │
        │                                                          │
        │ 9. /verify/<pda>#k=<token>  → anyone, no decryption      │
```

Two Anchor programs (`programs/invoice-registry/` and `programs/veil-pay/`). Next.js 14 frontend. Umbra SDK 2.1.1 client-side. Arweave for encrypted metadata. ALT to keep the bundled pay tx under Solana's 1232-byte cap.

## Why VeilPay matters

Most Umbra integrations pay in two popups. Ours does it in one.

The Umbra deposit flow ships as two transactions: one to create a proof-input buffer PDA, one to consume the buffer and post the UTXO. Each is signed independently by the wallet. That's two popups, and Solana doesn't natively bundle them because together they exceed the 1232-byte transaction-size cap.

`programs/veil-pay/programs/veil-pay/src/lib.rs` wraps both ixs in a single outer CPI plus our own `lock_payment_intent` CPI into the invoice registry. The bundled tx is too big without an ALT, so we deploy a 14-address Address Lookup Table (`scripts/deploy-veilpay-alt.mjs`) holding the static accounts. The result: one popup, one transaction, atomic acquisition of the on-chain proof.

The same wrapper powers payroll batches via `pay_invoice_with_shadow_funding`. A 20-recipient payroll is one popup, not twenty.

## How Veil scores on the judging rubric

| Criterion | How we hit it |
|---|---|
| **Core Umbra SDK integration** | The pay flow goes through `getPublicBalanceToReceiverClaimableUtxoCreatorFunction` and `getEncryptedBalanceToReceiverClaimableUtxoCreatorFunction` for the two payment paths. Master-seed derivation via `getOrCreateClient`. UTXO scanning via `getClaimableUtxoScannerFunction`. Without Umbra there is no Veil — every payment is an Umbra deposit. |
| **Innovation** | `PaymentIntentLock` on-chain primitive. The lock PDA is the trustless receipt: no off-chain artifact, no creator action required, atomic with the encrypted deposit. New B2B reconciliation primitive that doesn't exist in any other Umbra integration. |
| **Technical execution** | One popup pay flow via CPI bundling + ALT. 13 Anchor tests passing on devnet. Two on-chain programs deployed, both upgradeable. Capability-URL verifier route with W3C TAG-grade gating. End-to-end shielded path verified with Arcium MPC finalization. |
| **Product / commercial potential** | B2B contractor payment market is ~$1.5T/yr (Deel TAM). Today's on-chain offerings (Request, Superfluid) trade off privacy for verifiability. Veil keeps both. |
| **Impact** | Salary privacy is a security primitive ([CertiK Wrench Attacks Overview](https://www.certik.com/blog/2026-wrench-attacks-overview)), not a luxury. Public payroll is a literal kidnapping map. |
| **Usability** | One popup per payment. One popup per batch payroll. The auditor opens a link and reads the CSV; no wallet connection required. The verifier is one QR scan from any receipt PDF. |
| **Completeness** | Devnet live, video shipped, two programs deployed, both pay paths verified end-to-end, compliance grants working both for invoices and payroll batches. See [Roadmap](docs/roadmap.md) for what's deliberately deferred. |

## Privacy model

Veil is not anonymous and we don't claim it is. The honest split:

| What | Private | Public |
|---|---|---|
| Invoice line items, amount, memo | Encrypted on Arweave | |
| Recipient encrypted balance | Umbra MXE | |
| Pay from shielded balance | Amount + source invisible | (no public deposit tx) |
| Pay from public balance | | Umbra deposit tx amount visible |
| Payer ↔ invoice link | | `PaymentIntentLock` PDA records both pubkeys |
| Recipient wallet | | Always public (Invoice.creator) |

The lock PDA leaks the payer↔invoice association on purpose. That tradeoff is what makes reconciliation trustless without forcing an off-chain receipt protocol. For B2B billing it's the right call. For anonymous payments it isn't.

**Devnet caveat:** the Umbra pool on devnet sees ~10 deposits/day. A chain analyst can defeat the mixer in ~30s on amount + timing alone. Mainnet pools see real volume; the anonymity set scales linearly. This is a property of devnet traffic, not a Veil bug.

## Quickstart

```bash
git clone https://github.com/michal-marcinko/veil
cd veil && npm install
cp app/.env.example app/.env.local       # devnet defaults work as-is
npm run dev
```

Open `http://localhost:3000` with any Solana wallet. Solflare gives the cleanest devnet UX (Phantom routes through Blowfish which doesn't simulate ZK programs cleanly on devnet). Get a small amount of wSOL on devnet via `solana airdrop` + the wrap-sol helper in the create flow.

## Stack

| Layer | Choice |
|---|---|
| Frontend | Next.js 14 (app router), TypeScript, Tailwind |
| Solana programs | Anchor 1.0-rc.5, Rust |
| Privacy | Umbra SDK 2.1.1, Arcium MPC |
| Encrypted storage | Arweave via Bundlr |
| Signing | `@solana/wallet-adapter-react`, `signAllTransactions` batching |
| Tests | Vitest (frontend), surfpool harness with mock-Umbra (programs) |

## Roadmap

What's deliberately deferred and why: see [`docs/roadmap.md`](docs/roadmap.md). Highlights:

- Mainnet launch (pending Blowfish review for Phantom support)
- Shielded-pay wrapped inside VeilPay (today it's a 3-tx `signAllTransactions` batch; v2 wraps it in one ix)
- Payroll-batch audit grants surfaced in the same compliance picker as invoices (shipped 2026-05-12)
- Settlement-side proofs replacing creator-attested `mark_paid` with an Umbra Merkle proof

## License

MIT.
