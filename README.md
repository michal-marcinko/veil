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
- **Pay** - Bob opens a shareable link, the UI wires his wallet, pays through Umbra's shielded pool in a single popup (via the VeilPay CPI wrapper), and signs a receipt intent tied to the invoice PDA. Amount is hidden on-chain; counterparty linkage is broken by the mixer.
- **Reconcile** - Alice opens her dashboard "Inbox", sees pending UTXOs encrypted to her view key, and explicitly claims each one (claim → withdraw → payslip). The invoice itself stays `Pending` until Bob pastes the payer-signed receipt blob into Alice's apply-receipt panel; only then does she submit `mark_paid`. This recipient-controlled flow is intentional: it keeps the invoice creator as the on-chain settlement authority and avoids racing the auto-claimer with Phantom's popup blocker (see [Trust model](#trust-model)).
- **Run private payroll** - An employer uploads `wallet,amount,memo`, sends Umbra payments to contractors, and signs one payroll packet for receipts, auditor review, and per-row selective disclosure.
- **Audit / disclose** - Invoice compliance grants are wired through Umbra's x25519 grant primitives; payroll uses signed packets and one-row disclosure links so an accountant or recipient can verify exactly the data they were given.

## Live demo

- App: **https://veil-app-production.up.railway.app**
- Repo: **https://github.com/michal-marcinko/veil**
- Demo video: *TBD before submission deadline (May 11, 2026)*

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
        |                                                          |    (single popup → Umbra UTXO)
        |                                                          | 6. signed receipt intent
        | 7. Inbox shows pending UTXO; Alice clicks Claim          |
        | 8. Bob shares the signed receipt blob with Alice         |
        | 9. Alice pastes the receipt → mark_paid as creator       |
        |                          ◄──── Invoice.status = Paid     |
        |                                                          |
        | 10. issue compliance grant ─────► Auditor (Carol)        |
        |     (mint + time scope)            decrypts Alice's      |
        |                                    invoices in range     |
```

## VeilPay program — our technical differentiator

`programs/veil-pay/` is a small Anchor program we wrote specifically to make the pay flow human-grade. It's the piece of work we are most proud of, and the reason the demo holds up under real wallet UX.

- **One Phantom/Solflare popup instead of two.** The Umbra SDK's stock deposit path requires two signatures from the payer: one for `create_buffer` (writes the encrypted blob into a buffer PDA) and one for `deposit` (consumes the buffer and posts the UTXO). VeilPay bundles both inner instructions into a single CPI under one outer ix, so the payer signs **once**. The full bundle goes through `signAllTransactions` in lockstep with the Arcium MPC queue ix, keeping the entire pay flow to one wallet popup.
- **Address Lookup Table to fit the 1232-byte cap.** Even bundled, the deposit tx has 19 unique account keys and tips over Solana's 1232-byte transaction size limit by ~250 bytes. We deploy a static ALT (program ID `5MKHHKbHTZNqTtd9zTg59rWv5hbLKofj26Jv8LNMtket`) holding 13 of those keys (the static ones — token program, system program, Umbra protocol config, fee schedule, etc.) so the message body references them as 1-byte indices. Build script: [`app/scripts/deploy-veilpay-alt.mjs`](app/scripts/deploy-veilpay-alt.mjs).
- **One-popup-per-batch payroll.** The same CPI-bundling technique scales to payroll: the employer signs one popup per recipient row, not two, which is the difference between a demoable B2B flow and an unusable one when the batch is 20 contractors.
- **Source.** The Anchor program lives at [`programs/veil-pay/programs/veil-pay/src/lib.rs`](programs/veil-pay/programs/veil-pay/src/lib.rs).

## Privacy model: what we hide vs what's pseudonymous

We are deliberately precise about Veil's privacy claims so a reviewer or auditor can verify them. **Don't use Veil if your threat model assumes "untraceable on devnet."** It does not.

**Hidden (cryptographic guarantees):**
- **Memos and invoice line items** — AES-256-GCM encrypted client-side under a key derived from the invoice creator's wallet signature. Stored on Arweave; only a content hash is on-chain.
- **Encrypted-balance amounts on chain** — Umbra's encrypted-balance primitives keep account balances opaque to any observer.
- **Recipient view-key identity at sender-deposit time** — the deposit tx posts a UTXO encrypted to the recipient's stealth view key. The recipient's wallet address is not in the deposit tx.

**Pseudonymous on chain (NOT hidden — visible to a determined chain analyst):**
- **Depositor wallet address** — visible in the Umbra pool deposit tx as the `H1 Sender Address` event field. Anyone watching the pool sees who deposited.
- **Withdraw amount** — when the recipient withdraws shielded funds back to their public ATA, the withdraw amount appears in their tx.

**Devnet caveat (important for reviewers):**
On devnet the Umbra pool is low-volume — typically a handful of deposits per day. A determined chain analyst can map `Recipient withdraw → Pool → Specific sender deposit` in roughly 30 seconds via Solana Explorer because the anonymity set is too small to defeat timing + amount correlation. **This is a property of devnet's volume, not a Veil bug.** On mainnet, where the Umbra pool aggregates real volume across all of its users, this attack becomes practically infeasible — anonymity scales linearly with the size of the deposit set.

**The honest claim we make:** Veil provides **off-chain metadata privacy + amount-hiding shielded-to-shielded sends + plausible deniability via batched receipts**. We do **not** claim "untraceable." That distinction matters for any business that wants to evaluate Veil against its actual threat model.

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

Veil uses a recipient-only settlement model for invoice status. Bob's pay page only creates the Umbra receiver-claimable UTXO and, when his wallet supports `signMessage`, signs a receipt intent over the invoice PDA, wallet, metadata hash, timestamp, and payment UTXO signature. Bob does not call `mark_paid`.

Alice's dashboard is the reconciliation authority. She claims the incoming UTXO from her **Inbox** (an explicit per-row click — auto-claim was removed on 2026-05-05 because it raced Phantom's popup blocker and the new section's manual claim button), then pastes Bob's signed receipt blob into the apply-receipt panel. The receipt verifier checks the ed25519 signature locally; the dashboard then submits `mark_paid` as the invoice creator. The `utxo_commitment` is derived from the stable claim signature when the SDK exposes one; if not, the app falls back to `sha256(invoicePda.toBuffer())` so the mark-paid call remains deterministic.

The public receipt verifier checks two things only: the invoice PDA is currently `Paid` on-chain, and the receipt blob was signed by the claimed payer wallet. It does not require the payer wallet to match the on-chain `mark_paid` signer, because the signer is the recipient/creator who claimed the UTXO.

Veil's invoice registry deliberately does not attempt to verify private Umbra payment contents on-chain - that would either leak data or require Umbra-side primitives outside the hackathon window. Instead, the recipient confirms receipt: only the invoice creator's wallet can mark an invoice paid, and only after their dashboard has scanned and claimed the incoming UTXO and accepted Bob's signed receipt. This matches how every business invoice works - the seller acknowledges payment. Production roadmap: Umbra-side settlement Merkle proofs or a CPI hook from Umbra into our registry.

Outgoing payroll intentionally does not reuse the invoice PDA model. Payroll is payer-initiated: the employer sends Umbra receiver-claimable UTXOs directly to contractors, then signs a single packet covering the batch. `/payroll/packet` verifies the full packet for auditors; `/disclose/payroll` verifies one selected row for selective disclosure.

## Future work

- **CSV export of invoice history.** Today, auditor access is via Umbra-native x25519 grants; one-click CSV export for the invoice creator's own records is on the roadmap.
- **Settlement-side proofs.** Replace today's recipient-attested `mark_paid` with an Umbra-side settlement Merkle proof or a CPI hook from Umbra into the invoice registry, so the on-chain `Paid` state is provable from the deposit, not asserted by the creator.
- **Mainnet launch.** Pending Blowfish review for Phantom support and stealth-pool initialization for USDC on devnet (currently devnet only supports wSOL; mainnet supports USDC, USDT, wSOL, UMBRA).

## Links

- Live app: https://veil-app-production.up.railway.app
- Repository: https://github.com/michal-marcinko/veil
- Superteam Umbra track: https://earn.superteam.fun/listings/hackathon/build-with-umbra-side-track
- Demo video: *TBD before submission deadline (May 11, 2026)*

## License

MIT
