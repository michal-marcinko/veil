# Submission Form Copy

Ready-to-paste text content for each submission form. Copy the fenced blocks verbatim into the corresponding form fields — no need to re-draft anything.

## Colosseum Frontier Hackathon

### Project title (max 50 chars)

```
Veil — Private Invoicing on Solana
```

### One-line description (max 140 chars)

```
Business-grade payment privacy for freelancers and teams — private invoices, shielded payments, scoped auditor access.
```

### Long description (300–500 words)

```
Veil is a private invoicing app for Solana. Alice (payee) creates an invoice; its metadata — amount, memo, line items — is encrypted client-side with AES-256-GCM, uploaded to Arweave for permanence, and hash-anchored to a tamper-evident Anchor PDA on Solana. Bob (payer) opens a shareable pay URL, connects his wallet, and pays through Umbra's shielded pool: amounts are hidden on-chain via encrypted token accounts (Arcium MPC), and the counterparty graph between Alice and Bob is broken by Umbra's UTXO mixer with ZK proofs. Alice's dashboard auto-claims incoming UTXOs and marks invoices paid.

The insight we bet on is that privacy alone is not enough for real businesses. Every payroll team we talked to asked the same question: "but how do I give my accountant access?" Today, the options are "hand over your wallet" or "email CSVs." Veil uses Umbra's x25519 compliance grants to give Alice a third option: she issues a time-and-mint-scoped viewing key to her accountant; the accountant loads an audit page and sees exactly the invoices the grant covers — decrypted amounts, nothing else. Scopes are hierarchical (year / month / day, any single mint) and fully revocable. This is the "private by default, transparent on demand" story Umbra was designed for, and to our knowledge Veil is the first product to wire it into a real B2B workflow.

The scope delivered includes: Anchor program (`invoice-registry`) with create/mark-paid/grant-issue instructions; Next.js 14 frontend with Phantom wallet integration, encrypted metadata pipeline, Umbra registration, shielded-pool payment, UTXO scan+claim, and compliance grant issuance/revocation; a dedicated `/audit/<granter>` page for auditors; and a fresh-wallet smoke test that walks Alice→Bob→Carol end-to-end in under 20 minutes. Stretch features delivered include batch/payroll invoicing (paste CSV, generate 20 links), pay-from-encrypted-balance (full shielding — no public deposit leg), and proof-of-payment receipts (signed artifact Bob can show a dispute process).

Competitive positioning: Request Finance is the market leader for crypto invoicing, but every amount is fully public on Polygon/mainnet and streaming invoices can't be denominated in fiat. Veil solves the privacy gap without sacrificing compliance workflows. PIVY solves private payroll but is specific to recurring payments — we cover one-off invoices, batches, and recurring in a single flow, all private, all auditable.

Tech stack: Rust + Anchor 0.30, Next.js 14 / TypeScript 5, @umbra-privacy/sdk 2.1, @umbra-privacy/web-zk-prover 2.0, @coral-xyz/anchor, @solana/web3.js, @bundlr-network/client for Arweave. Deployed to Vercel; Anchor program on Solana devnet.
```

*(Word count: ~420. Well inside the 300–500 limit.)*

### Team

```
Michal Marcinko — full-stack builder, Superteam UK member (1st place Assembly Memo bounty, April 2026). Solo submission.
```

### Tech stack

```
Solana, Anchor 0.30, Rust, Next.js 14, TypeScript 5, Umbra Privacy SDK (shielded pool + x25519 compliance grants), @solana/web3.js, Arweave (via Bundlr), Tailwind CSS, Vercel.
```

### Track selection

- **Primary:** Privacy / Umbra side-track ($10k)
- **Secondary (auto-entered):** Main Frontier pool
- **Stretch (if form allows multi-select):** 100xDevs open track ($10k, 10 winners)

### Demo URL

```
https://veil.vercel.app
```

*(Placeholder — fill in after Vercel deploy per `docs/deploy-checklist.md`.)*

### Video URL

```
https://youtu.be/REPLACE_ME
```

*(Placeholder — fill in after video upload. Script in `docs/demo-script.md`.)*

### Repository URL

```
https://github.com/<org>/veil
```

*(Placeholder — fill in with the public repo URL at submission time.)*

---

## Superteam / Umbra side-track (separate submission if required)

### "What did you build?" (200–300 words)

```
Veil is a private invoicing product built on Umbra's encrypted-balance and mixer primitives. A payee creates an invoice whose metadata is AES-256-GCM encrypted client-side, uploaded to Arweave, and hash-anchored to an Anchor PDA. A payer opens a shareable pay URL and settles through the Umbra shielded pool — amounts are hidden, counterparty linkage is broken. The payee's dashboard auto-claims incoming UTXOs and surfaces paid/pending status per invoice.

The flagship Umbra integration is compliance grants. A payee issues a time-and-mint-scoped x25519 viewing key to her accountant; the accountant opens a dedicated audit page and sees exactly the invoices the grant covers, with amounts decrypted and everything else hidden. Grants are hierarchical (year / month / day granularity) and revocable by deleting the grant PDA. This is the "private by default, transparent on demand" pattern Umbra was designed to enable, and we believe Veil is the first hackathon submission to wire it into a production-shaped workflow rather than a demo toy.

Additional Umbra usage: the optional "pay from shielded balance" feature uses Umbra's encrypted-balance-to-claimable-UTXO flow so that a payer with existing shielded balance can settle entirely inside the pool, with no public deposit leg — no amount leak to any observer. This closes the last visible side-channel in the payment flow.
```

### "What's the privacy story?" (150–250 words)

```
Three layers of privacy, composed:

1. **Amounts hidden on-chain.** Payments flow through Umbra's encrypted token accounts (Arcium MPC). A block-explorer observer sees an opaque UTXO operation, not "Alice received 1,500 USDC from Bob."

2. **Counterparty graph broken.** Umbra's UTXO mixer with ZK proofs severs the link between payer and payee. Even a sophisticated analyst correlating timing and mint can't reconstruct "Bob paid Alice" from on-chain data alone.

3. **Metadata encrypted off-chain.** Invoice memo, line items, and other PII are AES-256-GCM encrypted client-side before touching Arweave. The Anchor PDA stores only the hash of the ciphertext and the Arweave URI — not the content. A payer decrypts using a key derived from the invoice URL fragment.

The critical compliance angle: privacy without auditor access is not a real business product. Veil uses Umbra's x25519 compliance grants to offer scoped, revocable, cryptographic view-only credentials. An accountant gets exactly the slice of invoices the grant covers — nothing more, nothing less. No "hand over your wallet," no "email a CSV monthly" compromise.

The net result is a payment flow where a sophisticated adversary with full block-explorer access learns nothing about amounts, parties, or invoice content — while the payee's own accountant can still do tax prep in a single click.
```

### "Go-to-market?" (150–250 words)

```
The initial wedge is Web3-native payroll and contractor payments — the market PIVY identifies bluntly: "When paying employees or contractors in stablecoins, every payment is visible to anyone who knows your wallet address. Your entire team can see what everyone else is getting paid. Competitors can track your hiring patterns, random people can analyze your cash flow. It's like running payroll on a public spreadsheet that anyone can read." That's a real pain, for a real audience, with a real willingness to pay — by end of 2024, 9.6% of crypto-sector employees were paid in crypto and >90% of those salaries were in stablecoins, all fully visible on-chain today.

Our go-to-market starts with freelancers and small Web3 teams (5–50 headcount) who are already running crypto payroll on Solana but can't credibly answer "but what about privacy?" to their hires. Distribution: direct outreach to Solana-native DAOs, Superteam regional chapters, and existing crypto-payroll tool users via their public contractor lists. The second expansion layer is existing Request Finance users — GetApp verified reviews flag multi-chain token selection as a specific UX complaint ("chain and token selection present usability challenges"); Veil's single-chain single-mint flow is objectively simpler.

Pricing model (post-hackathon): take 10 basis points on payment volume. Same rake as payroll providers, dramatically better privacy.
```

---

## Pre-submission checklist

Before clicking Submit on any form:

- [ ] Deploy URL filled in (`https://veil.vercel.app` — not the placeholder)
- [ ] Video URL filled in (YouTube unlisted or Loom — not the placeholder)
- [ ] Repo URL filled in and the repo is **public**
- [ ] Repo README renders correctly on GitHub (check images/badges load)
- [ ] Smoke test passes against the live deploy (see `docs/smoke-test.md`)
- [ ] One final fresh-browser test of the demo URL while reading the README aloud to a friend — do they understand what Veil is in under 60 seconds?
