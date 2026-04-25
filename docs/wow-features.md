# Veil — WOW Features & Market Research

Written 2026-04-20, 3 weeks before Colosseum Frontier submission (2026-05-11).

This doc has two parts:

1. **Research** — real pain points people have with crypto invoicing today, with citations. These are the problems Veil can credibly claim to solve.
2. **Feature specs** — four "WOW" features, each mapped to the pain points they address. Each has a scope sketch, files touched, and effort estimate.

---

## Part 1 — Crypto invoicing: what's actually broken

Everything below is sourced from current (2026) articles, competitor docs, and industry reporting. Citations at the end of each point.

### 1.1 Salaries / payments are publicly visible on-chain

> "When paying employees or contractors in stablecoins, every payment is visible to anyone who knows your wallet address. Your entire team can see what everyone else is getting paid. Competitors can track your hiring patterns, random people can analyze your cash flow. It's like running payroll on a public spreadsheet that anyone can read."
> — PIVY, *How to Run Crypto Payroll Without Exposing Everyone's Salary*

This is **the** pain point Veil is positioned to solve. Umbra's encrypted balances + mixer are designed for exactly this. We should lead every pitch with it.

### 1.2 Client education & wallet UX is the #1 adoption blocker

79% of survey respondents cited concerns about using crypto for business payments. Across multiple sources the top barrier isn't tech — it's "my client doesn't know how to use a wallet." Long wallet-address strings get mis-copied, wrong-network sends lose funds, memo/tag requirements trip people up.

> "Small operational mistakes can cost you: always specify the exact address, network, and any required memo/tag on invoices, and send a small test transaction for new clients or chains."
> — Aurpay, *Freelancer's Guide to Getting Paid in Crypto (2026)*

**Veil already solves this** via the shareable-link pattern — the payer clicks a URL, the UI handles the wallet connection and network selection. Worth emphasizing in demo.

### 1.3 No chargebacks → payer-side trust problem

> "Unlike credit and debit card transactions, there is no formalized process for disputing a cryptocurrency transaction. Pure cryptocurrency payments cannot be disputed once confirmed on the blockchain."
> — Chargebacks911, *Crypto Chargebacks: Are Crypto Payments Reversible?*

Most freelancer/B2B guides flag this as the biggest reason clients refuse to pay in crypto. Any invoice product that offers *some* form of payer protection (milestone release, ZK proof-of-payment Bob can show a third party, cancellable invoices with a grace window) differentiates hard.

### 1.4 Existing crypto invoice tools are heavyweight or have major limitations

**Request Finance** is the market leader. Per their own docs + Superfluid integration writeups, they have real gaps:

- Streaming invoices can only be denominated in the underlying Super Token — **no fiat denomination**.
- Requires wrapping ERC-20s into Super Tokens (extra UX step).
- Stream liquidation risk: if the sender's balance runs out, the stream dies unexpectedly.
- No confidentiality — amounts fully public on Polygon/Mainnet.

Sources: [Request blog on streaming limitations](https://www.theaccountantquits.com/articles/stream-payments-using-superfluid), [Superfluid–Request integration](https://medium.com/superfluid-blog/request-integrates-superfluid-to-streamline-web3-invoice-payments-2c482e7bcb7a).

### 1.5 Accounting / auditor access is painful

Every crypto payment is a taxable event in most jurisdictions, and tax/audit teams need to see detail. Current tools either share the full wallet (no privacy) or export CSVs manually (no verifiability). Nobody has "cryptographic view-only credentials scoped to Q1 2026" — that's what Umbra's compliance grants provide.

### 1.6 Recurring / payroll needs batching

Paying 20 contractors monthly = 20 separate invoice URLs, 20 separate Phantom approvals, 20 separate fee hits. Teams end up exporting to CSVs and using Gnosis Safe or Disperse.app, then losing privacy. There is a real hole for "batch private payroll in one flow."

### 1.7 Payer risk: "did the merchant even receive it?"

Without a payment receipt tied to the invoice, disputes happen: "I paid you, you say you didn't get it." Need a cryptographic artifact Bob can show without revealing amount.

### 1.8 Public salaries are a *security* problem, not just a dignity one

Deeper than "my teammates see my salary." Per PIVY's analysis:

> "Public payroll data doesn't just expose finances, it creates a roadmap for targeted social engineering."
> "Anyone can see exactly how much you pay your employees, link payment addresses back to team members, monitor your company's payroll and overall expenses."

So it's not just a vibes issue — it's an attack surface. Companies running Web3 payroll on-chain are doxing their headcount, comp bands, and vendor spend to anyone with a block explorer. Recruiters, adversaries, scammers.

### 1.9 The addressable market is bigger than "crypto-native"

9.6% of crypto-sector employees were paid in crypto by end of 2024, and >90% of those salaries were in stablecoins. That's a concrete, growing TAM — not a hypothetical. More importantly: **every single one of those payrolls is currently fully visible on-chain.** Veil is the first product to credibly offer privacy here without rolling your own stealth-address infra.

### 1.10 Accounting reconciliation is a second-order nightmare

Even once a crypto payment lands, the back-office pain is severe:

> "QuickBooks does not inherently understand wallet addresses, token swaps, or gas fees, forcing accountants to manually convert crypto values to fiat at the time of each transaction, and standard workflows force you to use temporary clearing accounts to reconcile crypto payments against traditional AP/AR invoices — doubling your manual data entry."
> — Cryptoworth, *Crypto Accounting for QuickBooks Users*

And:

> "Reconciliation is a nightmare: matching blockchain records to invoices and hunting for missing receipts."
> — Various freelancer guides

Opportunity for Veil: because we *issue* the invoice on-chain and *mark it paid* on-chain, we already own the canonical reconciliation key. Exporting a CSV with `invoice_id, payer_wallet, amount, timestamp, fiat_value_at_receipt, tx_sig` is a ~1-day feature that directly displaces "temporary clearing accounts" workflows.

### 1.11 Tax authorities require fair-market-value-at-time-of-receipt

> "Most tax authorities require crypto income to be reported at fair market value in local fiat currency at the time of receipt, which means meticulous record-keeping of exchange rates, transaction timestamps, and project details."

If Veil captures the Pyth/Switchboard price at the exact slot of `mark_paid`, every invoice self-documents its tax basis. Nobody else is doing this — Request doesn't, because they don't stamp timestamps into the invoice itself.

### 1.12 Request Finance's specific UX weakness

Direct user complaint from verified review:

> "User experience and UI designs could have been better." (Prasad K., CEO)
> "Users noted that certain steps involving chain and token selection present usability challenges."
> — GetApp verified reviews

Request has 47 reviews, 36 five-star — they're generally loved — but the specific pain point is multi-chain token selection complexity. Veil's single-chain single-mint flow is objectively simpler, and we should lean into that in copy.

### 1.13a Real-user voices from Upwork community forums

Reddit and its mirrors are all 403'd as of 2026-04, but Upwork's public community forum surfaced actual freelancer stories that Google indexed:

- **"Lost 17.7K USD because of trusting Upwork"** — freelancer sold 15,000 USDT to a client at $1,500/tx and earned $2,500 profit; Upwork later discovered the client used fraudulent cards and clawed back every dollar. Freelancer held liable.
- **"A new kind of scam… NFT/USDT/Binance"** — common variant: client offers 3× profit ($3,000 for $1,000 USDT) using the freelancer's own Payoneer card to buy USDT on Binance. The fiat-funding chargeback kills the freelancer, the USDT goes to the scammer.
- Multiple open feature requests asking Upwork to natively support USDT/USDC withdrawals; staff response: "no news."

**What this tells us for Veil's pitch:**
- Real freelancers are *already* losing 4- and 5-figure sums to crypto-adjacent scams on centralized platforms because those platforms can't offer cryptographic proof of good-faith settlement.
- An invoice whose payment is on-chain, cryptographically final, and tied to a specific PDA is not just "privacy" — it's **settlement finality that can't be reversed by a platform claim**. That's a real value prop for freelancers burned by Upwork's clawback policies.

### 1.13b Demand exists, supply doesn't (yet)

> "One in five workers have been paid in crypto, mainly through freelance or side work, though employer-led crypto payroll remains limited — only 7% of employees say their company currently offers it."
> — Digital Watch Observatory / Onchain Magazine

14% of the workforce wants to be paid in crypto and can't because their employer doesn't support it. Veil as a *self-serve* invoicing layer means a single contractor or small team can adopt it without waiting for their employer to overhaul payroll.

### 1.14 Reddit-adjacent pain points (via aggregators)

Could not scrape Reddit directly (rate-limited and auth-walled in 2026). But PainOnSocial's aggregation of r/freelance and r/Upwork threads surfaced these recurring complaints:

- Clients disappear after work delivery — "ghost payments" with no communication
- Scope creep added without compensation
- Platform payment holds exceeding 14 days after acceptance
- **Clients filing disputes at the last minute** to avoid payment
- **Account suspensions freezing pending payments** (centralized-platform risk)

Last two are directly addressed by Veil's architecture: once Bob's `mark_paid` tx confirms, no Upwork can reverse it, no PayPal freeze can block it. That's a tangible differentiator for freelancers burned by centralized intermediaries.

### 1.13 Cross-border disputes are caused by rate-at-time-of-settlement ambiguity

> "Senders may lack transparency on what rate will be applied to the payment and how much will ultimately arrive at the beneficiary, which can lead to disputes or discrepancies."

Veil's privacy angle doesn't directly solve this, but our PDA-as-canonical-record pattern does: the invoice specifies the amount in stablecoin units at issue time; settlement is the same unit. No FX slippage, no "but I thought the rate was…" arguments. Worth mentioning as a side benefit in copy.

---

## Part 2 — Four WOW features

Each feature below has:

- **Pain solved** — which research point(s) above
- **What the judge sees** — the visible demo moment
- **Scope** — what exactly gets built
- **Files touched** — rough blast radius
- **Effort** — working days (assumes current velocity)

### Feature A — Compliance grants, end-to-end

**Pain solved:** 1.5 (auditor access), 1.3 indirectly (audit trail as dispute evidence).

**What the judge sees:** Alice opens `/dashboard/compliance`, enters auditor's wallet + "January 2026, SOL only" scope, clicks Issue. Auditor (in a second browser) logs in, sees a read-only view of exactly those invoices with decrypted amounts — nothing else. Revoke button works.

**Scope:**
- Wire `getComplianceGrantIssuerFunction` into the existing `/dashboard/compliance` page. Already imported in `umbra.ts:364` but may not be wired to UI.
- Build `/audit/[granter]` route: reads grants issued *to* the connected wallet, decrypts amounts via the SDK's re-encryption flow.
- Scope selector: mint + time range (hierarchical viewing keys per `reference_umbra_sdk.md` — Year/Month/Day granularity is native to the protocol).
- Revocation: delete the grant PDA (SDK exposes `getComplianceGrantRevokerFunction`).

**Files touched:**
- `app/src/app/dashboard/compliance/page.tsx` (exists, needs wiring)
- `app/src/app/audit/[granter]/page.tsx` (new)
- `app/src/lib/umbra.ts` — grant issue/query/revoke wrappers
- `app/src/components/GrantList.tsx` (new)

**Effort:** 1.5 days. The SDK does the heavy lifting; we mainly wire UI to existing functions.

**Why this is a wow:** It's the single most underrated feature in Umbra's stack — nobody else will demo it, and it's the exact "private-by-default, transparent-on-demand" narrative the Umbra team wants to see highlighted. For judges, it's the response to "but how do companies audit this?"

---

### Feature B — Batch / payroll invoicing

**Pain solved:** 1.1 (salary visibility), 1.6 (batch UX).

**What the judge sees:** Alice opens `/payroll/new`, pastes a CSV (`wallet,amount,memo`) or adds rows inline for 20 contractors, clicks "Generate 20 invoice links." One combined dashboard shows all 20 statuses (pending/paid). Alternative — a single "pay-to-many" UTXO transaction where she pays *all* contractors at once through the Umbra mixer, one Phantom approval, one tx fee.

**Scope (ship the simpler one first):**

**Tier 1 (2 days):** 20 individual invoices generated from one form. Each gets a separate PDA + URL. Dashboard rolls them up as a "batch." Copy-all-links button.

**Tier 2 (+1 day if time):** Single-tx multi-recipient payout from Alice's encrypted balance using `getEncryptedBalanceToReceiverClaimableUtxoCreatorFunction` in a loop, bundled into one Solana transaction (Solana's tx size limit matters — realistically 5–8 recipients per tx).

**Files touched:**
- `app/src/app/payroll/new/page.tsx` (new)
- `app/src/app/payroll/[batchId]/page.tsx` (new — batch dashboard)
- `app/src/components/PayrollCsvUploader.tsx` (new)
- `app/src/lib/anchor.ts` — helper to create N invoices in a loop (or a new `create_batch` instruction if we're feeling ambitious; optional)
- `app/src/lib/types.ts` — add `batch_id` optional field to metadata

**Effort:** 2 days for Tier 1, 3 days total with Tier 2.

**Why this is a wow:** Payroll is the clearest B2B story. "Pay 20 contractors, amounts private, recipients private via the mixer, one click." Judges immediately understand the value. And PIVY's quote (research point 1.1) is literally the problem statement — we're solving exactly that.

---

### Feature C — Pay from encrypted balance ("full shielding")

**Pain solved:** Strengthens 1.1 dramatically. Today, Bob's *deposit* to Umbra is public — anyone can see "Bob sent 0.001 SOL to Umbra's program right around when invoice X was paid." With this feature, Bob's entire payment happens inside the shielded pool: no deposit tx, no amount leak.

**What the judge sees:** On the pay page, if Bob already has shielded balance, a toggle appears: "Pay from shielded balance (recommended)." Phantom prompts once instead of three times. No public tx shows amount. Dashboard balance drops by 0.001, Alice's climbs by 0.001 — and a block explorer view shows only an opaque Umbra UTXO operation.

**Scope:**
- On `/pay/[id]`, call `getEncryptedBalance` for the connected wallet.
- If balance ≥ invoice total, render the toggle (default ON when available).
- Replace the current deposit → transfer flow with `getEncryptedBalanceToReceiverClaimableUtxoCreatorFunction` (already imported per SDK export list).
- Fallback to existing public-deposit flow when shielded balance is insufficient.

**Files touched:**
- `app/src/app/pay/[id]/page.tsx`
- `app/src/lib/umbra.ts` — add `payInvoiceFromShielded` that mirrors `payInvoice` but starts from encrypted balance

**Effort:** 1.5 days.

**Why this is a wow:** It's the only feature on this list that makes the privacy claim *actually* ironclad. Without it, the demo still has a visible deposit tx that a sophisticated judge could point to and say "so you're not really private." With it, the whole payment path is opaque. This one is more of a credibility upgrade than a demo fireworks moment — but without it, a technical judge might dock points.

---

### Feature D — ZK proof-of-payment receipt

**Pain solved:** 1.3 (no chargebacks), 1.7 (payer risk).

**What the judge sees:** Bob pays. Veil generates a receipt artifact — a small signed blob (or a URL to a verifier page). Bob can share it with his accountant, landlord, or a dispute process. The verifier page, loaded in a clean browser tab, shows: "Invoice `<pda>` was marked paid by `<bob-wallet>` at `<timestamp>`. Amount verified: hidden. ✓ Valid." The blob is cryptographically tied to the invoice PDA and Bob's wallet.

**Scope:**
- On successful payment, server generates a receipt JSON: `{ invoicePda, payerPubkey, markPaidTxSig, timestamp, signature }`. Signed with a per-invoice deterministic key Bob derives from his wallet.
- `/receipt/[pda]` verifier page: takes the signed blob (from fragment or query), validates the signature against on-chain data, renders the green checkmark.
- Optional Tier 2: actual ZK proof (not just a signed receipt) that proves Bob is the payer *without* revealing his wallet. Requires circuit work — probably too much scope for 3 weeks unless you use `circomlibjs` with a very simple circuit.

**Files touched:**
- `app/src/app/receipt/[pda]/page.tsx` (new)
- `app/src/lib/anchor.ts` — `getPaymentReceipt(pda)` reads the on-chain state
- `app/src/lib/receipt.ts` (new) — signing + verification utilities

**Effort:** Tier 1 (signed receipt, no ZK) is 1 day. Tier 2 (actual ZK) is 3–5 days and probably not worth it given the compliance-grant feature already carries a ZK story.

**Why this is a wow:** Solves the "but I can't dispute!" objection directly. Also opens a B2B story: "Accountants can verify your invoice history without you handing over your wallet." Pairs naturally with compliance grants.

---

---

### Feature E (bonus) — Tax-ready exports + fiat-at-time-of-receipt

**Pain solved:** 1.10 (QuickBooks reconciliation), 1.11 (fair-market-value tax requirement).

**What the judge sees:** On the dashboard, an "Export" button. Click → downloads a CSV with columns: `invoice_id, payer_wallet, amount_native, symbol, usd_at_receipt, timestamp, mark_paid_tx_sig, arweave_uri`. Alice opens it in QuickBooks → every row is a complete journal entry. No clearing accounts, no manual rate lookup.

**Scope:**
- At `mark_paid` time, capture the Pyth SOL/USD price at that slot and store it alongside the utxo_commitment. On-chain cost: +8 bytes per invoice.
- Dashboard export endpoint that joins invoice metadata (off-chain) with paid-state (on-chain) and renders CSV.

**Files touched:**
- `programs/invoice-registry/programs/invoice-registry/src/lib.rs` — add `fiat_rate_at_paid: u64` to Invoice struct, populate in `mark_paid`
- `app/src/app/dashboard/export/route.ts` (new)
- `app/src/lib/pyth.ts` (new, small)

**Effort:** 1 day for CSV-only (without on-chain Pyth integration); 2 days if we do the on-chain Pyth capture. The off-chain-only version uses CoinGecko historical API at export time — good enough for the demo, less compelling on the "verifiable on-chain" axis.

**Why this is a wow (or isn't):** Not visually impressive in a demo video. But: the first question every B2B judge asks is "what about accounting?" Having a literal "Export to QuickBooks" button answers that. It's insurance against losing points, not a headline feature. **I'd skip this unless you have spare time after A+B+C.**

---

## Part 3 — Recommendation & order of operations

For maximum impact in 3 weeks, do this sequence:

| Day | Work | Cumulative hours |
|-----|------|--|
| 1 | Fix outstanding BigInt error on dashboard + clickable invoice rows (wallet-signature key derivation) | 8 |
| 2–3 | **Feature A — Compliance grants** | 20 |
| 4–5 | **Feature B Tier 1 — Batch invoicing** | 36 |
| 6 | **Feature C — Pay from encrypted balance** | 48 |
| 7 | **Feature D Tier 1 — Proof-of-payment receipt** (if time) | 56 |
| 8 | Demo video + README + Vercel deploy | 64 |
| 9 | Submission forms (Colosseum + Superteam/Umbra track) | 68 |
| buffer | Unknown-unknowns | ~40h remaining |

**Must-ship (cannot submit without):** A + B Tier 1 + existing pay flow polished.
**Should-ship (takes it from good to credible):** C, plus the dashboard clickable-rows fix.
**Nice-to-have (skip if behind):** D, Feature B Tier 2, mobile polish.

**Competitive framing for the video script:**
1. "Request Finance shows you everything on-chain. Veil doesn't."
2. "Payroll tools expose every salary. Veil encrypts them."
3. "Crypto has no chargebacks. Veil gives you a cryptographic receipt."
4. "Auditors need access? Grant them scoped view-only keys."

One sentence per bullet, two seconds each — that's 8 seconds of hard differentiation in the demo video.

---

## Sources

**Payroll privacy (research 1.1, 1.8, 1.9)**
- [PIVY — How to Run Crypto Payroll Without Exposing Everyone's Salary](https://pivy.me/blog/3dc66fc2-bf12-4924-95c2-7550d7dd4501)
- [Onchain Magazine — Crypto Payroll: Faster, Safer, More Impactful](https://onchain.org/magazine/crypto-payroll-faster-safer-and-more-impactful/)
- [Deel — Crypto Payroll Compliance Guide](https://www.deel.com/blog/how-to-do-crypto-payroll/)
- [Toku — Crypto Payroll Guide for Global Teams](https://www.toku.com/resources/crypto-payroll-guide)

**Freelancer adoption & UX (research 1.2)**
- [Aurpay — Freelancer's Guide to Getting Paid in Crypto 2026](https://aurpay.net/aurspace/freelancer-get-paid-crypto-stablecoins-invoicing-2026/)
- [OneSafe — Complete Guide to Crypto Invoicing for Freelancers](https://www.onesafe.io/blog/complete-guide-crypto-invoicing-freelancers)
- [CryptoProcessing — The Greatest Obstacles in Enabling Crypto Payments](https://cryptoprocessing.com/insights/the-greatest-obstacles-in-enabling-crypto-payments-and-how-to-overcome-them)

**Chargebacks / receipts / disputes (research 1.3, 1.7, 1.13)**
- [Chargebacks911 — Crypto Chargebacks: Are Crypto Payments Reversible?](https://chargebacks911.com/crypto-chargebacks/)
- [CoinRemitter — Chargebacks, Refunds, and Disputes in Crypto Payments](https://blog.coinremitter.com/understanding-chargebacks-refunds-and-disputes-in-cryptocurrency-payments/)
- [Ramp — Cross-Border Payments: Types, Costs & Challenges](https://ramp.com/blog/cross-border-payments)

**Request Finance competitor analysis (research 1.4, 1.12)**
- [Request Network — 5 Invoicing Challenges Blockchain Solves](https://request.network/en/2021/03/10/invoicing-challenges-request-blockchain/)
- [Superfluid — Request Integration for Streaming Invoices](https://medium.com/superfluid-blog/request-integrates-superfluid-to-streamline-web3-invoice-payments-2c482e7bcb7a)
- [The Accountant Quits — Streaming Payments via Superfluid (Request limitations)](https://www.theaccountantquits.com/articles/stream-payments-using-superfluid)
- [GetApp — Request Finance verified reviews (UI complaint source)](https://www.getapp.com/finance-accounting-software/a/request-finance/reviews/)
- [OneSafe — Top Request Finance Alternatives 2026](https://www.onesafe.io/blog/alternatives-to-request-finance)

**Accounting & tax (research 1.10, 1.11)**
- [Cryptoworth — Crypto Accounting Software According to Reddit](https://blog.cryptoworth.com/the-ultimate-guide-to-crypto-accounting-software-according-to-reddit-users/)
- [OnchainAccounting — Crypto Tax Questions on Reddit](https://onchainaccounting.com/articles/crypto-tax-questions-on-reddit-what-the-community-has-to-say)
- [Cryptoworth — IRS Cost Basis Compliance for Digital Assets](https://www.cryptoworth.com/blog/cost-basis-compliance-crypto)
- [Intuit QuickBooks Community — Accounting for Cryptocurrency Holdings](https://quickbooks.intuit.com/learn-support/en-us/reports-and-accounting/accounting-for-cryptocurrency-holdings-within-quickbooks/00/939998)

**Auditor access & compliance (research 1.5)**
- [Canton Network — Private Stablecoin Payments on Public Blockchain](https://www.canton.network/private-stablecoin-payments-on-public-blockchain)
- [Federal Register — FinCEN Permitted Payment Stablecoin Issuer AML/CFT Requirements](https://www.federalregister.gov/documents/2026/04/10/2026-06963/permitted-payment-stablecoin-issuer-anti-money-launderingcountering-the-financing-of-terrorism)
