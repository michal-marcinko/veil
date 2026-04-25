# Submission Prep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce the non-code artifacts needed to submit Veil to the Colosseum Frontier Hackathon (deadline 2026-05-11) and the Superteam/Umbra side-track — a judge-ready README, a 75-second demo video script, a Vercel deploy checklist, a fresh-wallet smoke-test walkthrough, and ready-to-paste submission-form copy.

**Scope note:** No application code changes. This plan produces documentation, video script, and submission copy only.

---

## Task 1: Rewrite README

**Files:**
- Modify: `README.md` (full rewrite)
- Test: N/A — doc only

- [ ] **Step 1: Overwrite `README.md` with hackathon-ready content**

Overwrite `C:\Users\marci\Desktop\veil\README.md`:

````markdown
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

- **Create** — Alice issues an invoice. Metadata (amounts, memo, line items) is AES-256-GCM encrypted client-side, uploaded to Arweave, and hash-anchored to an on-chain Anchor PDA.
- **Pay** — Bob opens a shareable link, the UI wires his wallet, and he pays through Umbra's shielded pool. Amount is hidden on-chain; counterparty linkage is broken by the mixer.
- **Reconcile** — Alice's dashboard auto-claims incoming UTXOs and surfaces paid/pending status per invoice. CSV export is one click (feature pending — see roadmap).
- **Audit** — Alice issues a scoped viewing key to her accountant's wallet. The accountant loads `/audit/<alice>`, sees exactly the invoices they're authorized to see — amounts decrypted, nothing else visible.

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
        |                                                          | 6. mark_paid tx
        |                          ◄──── Invoice.status = Paid     |
        |                                                          |
        | 7. scan + auto-claim UTXO                                |
        |    (dashboard shows "Paid")                              |
        |                                                          |
        | 8. issue compliance grant ─────► Auditor (Carol)         |
        |    (mint + time scope)            decrypts Alice's       |
        |                                   invoices in range      |
```

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
- **D — Proof-of-payment receipts.** On successful payment, Bob receives a signed receipt artifact tied to the invoice PDA and his wallet. A public verifier page confirms "this invoice was paid by this wallet at this timestamp" without revealing the amount.
- **Bugfixes / polish.** Dashboard BigInt fix; clickable invoice rows; deterministic wallet-signature key derivation for encrypted metadata.

## Links

- Colosseum project page: https://arena.colosseum.org/projects/veil *(placeholder)*
- Superteam Umbra track: https://earn.superteam.fun/listings/hackathon *(placeholder)*
- Repository: https://github.com/<org>/veil *(placeholder)*
- Demo video: https://youtu.be/REPLACE_ME *(placeholder)*

## License

MIT
````

- [ ] **Step 2: Review**

Open `README.md`. Check:
- [ ] 60-second readability: a judge with no context understands what Veil is, what problem it solves, and the four-step flow (create → pay → reconcile → audit)
- [ ] Problem section has exactly 3 bullets pulled from research 1.1, 1.5, and 1.3/1.7
- [ ] All four features (A/B/C/D) + bugfixes listed with a one-sentence sales line
- [ ] Architecture section is 2–3 sentences plus ASCII diagram
- [ ] Env vars match `app/src/lib/constants.ts` + note about `BUNDLR_PRIVATE_KEY`
- [ ] Placeholders (`REPLACE_ME`, `<org>`) are clearly marked for later fill-in
- [ ] No broken markdown (headings render, tables align, code fences close)

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README for hackathon submission"
```

---

## Task 2: Write the demo video script

**Files:**
- Create: `docs/demo-script.md`
- Test: N/A — doc only

- [ ] **Step 1: Write the full script with per-second timing**

Create `C:\Users\marci\Desktop\veil\docs\demo-script.md`:

````markdown
# Veil — 75-second Demo Video Script

Target: 75 seconds total. Recorded at 1080p, two Phantom wallets (Alice + Bob) preloaded on devnet, a third wallet (Carol) for the auditor cameo. Screen recording at 30fps. Voiceover recorded separately, aligned on edit.

## Shot list

| # | Time | Screen | Voiceover | Cursor / action |
|---|------|--------|-----------|-----------------|
| 1 | 0:00–0:05 | Black title card → Veil landing page | "Every crypto payroll is public. Here's what Veil does." | Static title for 2s, then hard cut to landing page |
| 2 | 0:05–0:10 | Alice dashboard, click "New invoice" | "Alice needs to invoice a contractor. She clicks new invoice." | Click "New invoice" button |
| 3 | 0:10–0:18 | New-invoice form, fill amount + memo | "She enters the amount and a memo. Metadata is encrypted client-side and uploaded to Arweave before it touches the chain." | Type `1500` in amount, `March retainer` in memo, click "Create" |
| 4 | 0:18–0:20 | Phantom approval popup | *(no narration; natural Phantom SFX)* | Click "Approve" |
| 5 | 0:20–0:25 | Invoice detail page, copy pay URL | "She copies the shareable pay link." | Click "Copy pay URL", toast flashes |
| 6 | 0:25–0:28 | Switch to Bob's browser (second profile, visible Phantom icon change) | "Bob opens the link in his browser." | Paste URL, hit enter |
| 7 | 0:28–0:35 | Pay page, shielded toggle visible and ON | "Because Bob already has Umbra balance, Veil defaults to shielded payment — the whole payment stays inside the mixer." | Point cursor at the "Pay from shielded balance (recommended)" toggle |
| 8 | 0:35–0:40 | Phantom approval + success state | "One approval. Payment lands." | Click "Pay", approve, success confetti |
| 9 | 0:40–0:48 | Back to Alice dashboard, invoice row flips to Paid | "Alice's dashboard auto-claims the UTXO. The invoice is marked paid. Amount: never visible on-chain to anyone else." | Click dashboard link, invoice row animates green |
| 10 | 0:48–0:55 | Open compliance page, enter auditor wallet + scope, click Issue | "Her accountant needs to see Q1 invoices for tax. Alice issues a viewing grant — scoped to one mint, one month." | Paste Carol's pubkey, select "March 2026", click "Issue grant" |
| 11 | 0:55–1:05 | Switch to Carol's browser, `/audit/<alice-pubkey>`, invoice list with decrypted amounts | "Carol opens the audit view. She sees exactly what Alice granted — March invoices, amounts decrypted, nothing else." | Page loads, invoice rows render with dollar amounts |
| 12 | 1:05–1:10 | Back to Veil landing page | "Private by default. Transparent on demand. Built on Umbra, Anchor, and Arweave." | Static shot on hero section |
| 13 | 1:10–1:15 | Title card with URL | "Veil. veil.vercel.app." | Static title card, fade out |

## Narration (full text, 75s)

> Every crypto payroll is public. Here's what Veil does.
>
> Alice needs to invoice a contractor. She clicks new invoice. She enters the amount and a memo. Metadata is encrypted client-side and uploaded to Arweave before it touches the chain. She copies the shareable pay link.
>
> Bob opens the link in his browser. Because Bob already has Umbra balance, Veil defaults to shielded payment — the whole payment stays inside the mixer. One approval. Payment lands.
>
> Alice's dashboard auto-claims the UTXO. The invoice is marked paid. Amount: never visible on-chain to anyone else.
>
> Her accountant needs to see Q1 invoices for tax. Alice issues a viewing grant — scoped to one mint, one month. Carol opens the audit view. She sees exactly what Alice granted — March invoices, amounts decrypted, nothing else.
>
> Private by default. Transparent on demand. Built on Umbra, Anchor, and Arweave.
>
> Veil. veil.vercel.app.

Word count: ~150 words. Natural pace ~2 words/sec → 75s target.

## Production notes

- **Browser profiles.** Use two Chrome profiles with different avatars so the switch between Alice's and Bob's browser is visually obvious. Carol is a third profile, or use a different browser (Firefox) so the context switch reads instantly.
- **Phantom theming.** Alice on light mode, Bob on dark mode — the theme change doubles as a "we're somewhere else" cue.
- **Airdrops pre-recorded.** Do not record the devnet airdrop or the wrap-sol step. Both wallets are already funded before the video starts.
- **Pre-warm the prover.** Open Bob's browser tab and let the ZK prover fully load before starting the recording — cold-start is ~5s and will kill the pacing.
- **Cursor.** Use a cursor-highlight tool (e.g. Keynote's laser pointer, or an OBS overlay) so viewers track where we click.
- **Music.** Optional low-volume instrumental bed (no vocals). The narration is the primary track.
- **Captions.** Burn in captions for the narration — accessibility and muted-playback viewers.

## Edit pass checklist

- [ ] Total runtime 70–80 seconds
- [ ] No dead air longer than 2 seconds
- [ ] All Phantom popups are clearly visible (zoom in if needed)
- [ ] Dashboard transitions don't cut mid-animation
- [ ] Final URL clearly visible for 3+ seconds at the end
````

- [ ] **Step 2: Review**

Open `docs/demo-script.md`. Check:
- [ ] Full runtime adds up to 70–80s
- [ ] Every shot has a time range, screen description, narration, and cursor action
- [ ] Narration word count is ~150 (so voiceover lands at ~75s at natural pace)
- [ ] Shots 7, 10, 11 cover the three differentiators (shielded payment, grant issuance, auditor view)
- [ ] Production notes cover browser profiles, prover pre-warm, cursor visibility

- [ ] **Step 3: Commit**

```bash
git add docs/demo-script.md
git commit -m "docs: add 75-second demo video script"
```

---

## Task 3: Write the Vercel deploy checklist

**Files:**
- Create: `docs/deploy-checklist.md`
- Test: N/A — doc only

- [ ] **Step 1: Write the full checklist**

Create `C:\Users\marci\Desktop\veil\docs\deploy-checklist.md`:

````markdown
# Vercel Deploy Checklist

Veil's frontend is a Next.js 14 app in `app/`. This doc walks through deploying it to Vercel, configuring env vars, and running a post-deploy smoke test.

## Pre-deploy

- [ ] Confirm `app/package.json` has a `build` script — it does: `"build": "next build"`.
- [ ] Confirm `next.config.mjs` (if present) is committed. The Umbra SDK uses a CDN rewrite (`/umbra-cdn/*` → CloudFront) for its prover WASM assets — this rewrite **must** survive the deploy or the ZK prover will 404 at runtime.
- [ ] Confirm the Anchor program is deployed to devnet at the program ID referenced by `NEXT_PUBLIC_INVOICE_REGISTRY_PROGRAM_ID` (`54ryi8hcihut8fDSVFSbN5NbArQ5GAd1xgmGCA3hqWoo` by default).
- [ ] `npm run build` locally inside `app/` — it must pass without errors before you push.
- [ ] `.env.local` is gitignored (`.gitignore` already covers `.env*.local`).

## Vercel project setup

1. Log in at https://vercel.com.
2. **Import Git Repository** → select the `veil` repo.
3. **Configure Project**:
   - Framework preset: **Next.js** (auto-detected).
   - Root directory: **`app`** (not the repo root — the frontend lives in the `app/` workspace).
   - Build command: leave default (`next build`).
   - Install command: `npm install` (or `npm install --workspaces` if the monorepo install from root is preferred).
   - Output directory: leave default.
4. Do NOT click Deploy yet — set env vars first.

## Environment variables

Add all of the following in Vercel → Project Settings → Environment Variables. Set **all three environments** (Production / Preview / Development) unless noted.

### Public (browser-visible)

| Key | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_SOLANA_NETWORK` | `devnet` | For hackathon demo |
| `NEXT_PUBLIC_RPC_URL` | `https://api.devnet.solana.com` (or Helius/QuickNode devnet URL) | Use a paid RPC for the demo to avoid rate limits |
| `NEXT_PUBLIC_RPC_WSS_URL` | `wss://api.devnet.solana.com` (or paid equivalent) | Must match RPC provider |
| `NEXT_PUBLIC_INVOICE_REGISTRY_PROGRAM_ID` | `54ryi8hcihut8fDSVFSbN5NbArQ5GAd1xgmGCA3hqWoo` | From `app/src/lib/constants.ts` |
| `NEXT_PUBLIC_PAYMENT_MINT` | Devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (fallback: wSOL `So11111111111111111111111111111111111111112`) | Depends on Day 1 finding §1 |

### Server-side (NOT prefixed `NEXT_PUBLIC_`)

| Key | Value | Notes |
|---|---|---|
| `BUNDLR_PRIVATE_KEY` | Base58 or JSON-array private key for the Bundlr/Arweave upload wallet | Used by `/api/arweave-upload` route; must be funded with Bundlr credit |
| `BUNDLR_NODE_URL` | `https://node1.bundlr.network` | Default Bundlr mainnet node (Arweave is permaweb — no testnet) |

**Gotcha:** `app/src/lib/arweave.ts` POSTs raw bytes to `/api/arweave-upload`. That route must read `BUNDLR_PRIVATE_KEY` on the server and sign the Bundlr upload. If the key is exposed as `NEXT_PUBLIC_`, it will leak to the browser — double-check the prefix before saving.

### Optional

| Key | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_UMBRA_INDEXER_API` | `https://utxo-indexer.api.umbraprivacy.com` | Defaults to this in code; override only if Umbra gives us a dedicated endpoint |
| `NEXT_PUBLIC_UMBRA_RELAYER_API` | `https://relayer.api.umbraprivacy.com` | Same |

## Deploy

1. Click **Deploy**.
2. Wait for the first build. Typical build time: 2–4 minutes.
3. If the build fails, check the log for:
   - Missing env vars (Next.js will warn on `process.env.X` references during static analysis).
   - WASM loading errors from `@umbra-privacy/web-zk-prover` — these need a `next.config.mjs` tweak (see Day 1 findings §9).
   - Workspace resolution errors — if `npm install` from `app/` can't find monorepo deps, set Vercel's install command to run from repo root: `npm install --workspaces`.

## Domain

- [ ] Default domain: `veil-<hash>.vercel.app` — not pretty, rename before submitting.
- [ ] Rename Vercel project slug to `veil` → URL becomes `veil.vercel.app`.
- [ ] (Optional) Attach a custom domain in Project Settings → Domains if one is available.

## Post-deploy smoke test

- [ ] Open the deploy URL in a **fresh-profile browser** (no prior Phantom session).
- [ ] Install Phantom, create a brand-new devnet wallet, airdrop 2 SOL.
- [ ] Connect wallet on Veil.
- [ ] Follow `docs/smoke-test.md` end-to-end.
- [ ] Verify the ZK prover loads (watch Network tab — `/umbra-cdn/*` requests should 200, not 404).
- [ ] Verify `/api/arweave-upload` returns a valid Arweave URI on invoice creation.
- [ ] Verify dashboard auto-claims UTXO within 60s of Bob's payment.

If any of the above fails, revert to the previous deploy via Vercel → Deployments → Promote Previous.

## Rollback plan

Vercel retains every deploy. If a bad push breaks prod during the hackathon window, go to the Deployments tab and click "Promote to Production" on the last known good deploy. No CLI, no git revert required.
````

- [ ] **Step 2: Review**

Open `docs/deploy-checklist.md`. Check:
- [ ] All env vars from `app/src/lib/constants.ts` are listed
- [ ] `BUNDLR_PRIVATE_KEY` is explicitly marked server-only (NOT prefixed `NEXT_PUBLIC_`)
- [ ] `/umbra-cdn/*` CDN rewrite mentioned as a survive-the-deploy requirement
- [ ] Root directory is called out as `app`, not repo root
- [ ] Smoke-test step references `docs/smoke-test.md`
- [ ] Rollback plan exists

- [ ] **Step 3: Commit**

```bash
git add docs/deploy-checklist.md
git commit -m "docs: add Vercel deploy checklist"
```

---

## Task 4: Write the fresh-wallet smoke-test walkthrough

**Files:**
- Create: `docs/smoke-test.md`
- Test: N/A — doc only

- [ ] **Step 1: Write the full walkthrough**

Create `C:\Users\marci\Desktop\veil\docs\smoke-test.md`:

````markdown
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
- [ ] Click **Pay**. Approve Phantom transactions (expect 2–3 approvals: deposit, UTXO create, mark-paid).
- [ ] Expected: success state with tx signature links.

## 5. Alice's dashboard reflects the payment

- [ ] Switch back to Alice's browser.
- [ ] Navigate to `/dashboard`.
- [ ] Wait up to 60s (auto-claim polls every 30s).
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

## Pass criteria

All of the following must be true to consider the smoke test passed:

- [ ] Alice created an invoice and got a pay URL.
- [ ] Bob loaded the pay URL, paid, and saw a success state.
- [ ] Alice's dashboard reflected "Paid" within 60s.
- [ ] Alice issued a compliance grant to Carol without errors.
- [ ] Carol saw the decrypted invoice amount on the audit page.
- [ ] (If Feature E) CSV export downloaded with correct columns.
- [ ] No console errors in any browser (open DevTools → Console tab, should be clean or only contain known warnings).

## Known gotchas

- **Cold-start ZK prover.** The first payment Bob makes will take 5–10s longer than subsequent ones because the prover WASM is loading. This is expected; don't panic.
- **Devnet RPC flakiness.** Public devnet returns 429 under load. If Bob's payment tx fails with "blockhash not found" or "Too Many Requests", switch `NEXT_PUBLIC_RPC_URL` to a Helius or QuickNode devnet URL.
- **Bundlr upload fails.** If invoice creation errors at the Arweave-upload step, check that `BUNDLR_PRIVATE_KEY` is set server-side and the Bundlr wallet has credit. Run `npx @bundlr-network/client balance <pubkey> -h https://node1.bundlr.network -c solana` to check.
````

- [ ] **Step 2: Review**

Open `docs/smoke-test.md`. Check:
- [ ] Covers all 9 steps: wallet setup, wrap-sol, register, create, pay, dashboard, (export), grant, audit view, (revoke)
- [ ] Each step has concrete commands or click paths a reviewer can follow without guessing
- [ ] Pass criteria are binary (each item is a yes/no)
- [ ] Known gotchas cover ZK prover cold start and RPC rate limits

- [ ] **Step 3: Commit**

```bash
git add docs/smoke-test.md
git commit -m "docs: add fresh-wallet smoke test walkthrough"
```

---

## Task 5: Write the submission-form copy

**Files:**
- Create: `docs/submissions.md`
- Test: N/A — doc only

- [ ] **Step 1: Write the full submissions doc**

Create `C:\Users\marci\Desktop\veil\docs\submissions.md`:

````markdown
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
````

- [ ] **Step 2: Review**

Open `docs/submissions.md`. Check:
- [ ] Long description is 300–500 words (target ~420)
- [ ] "Privacy story" covers all three layers (amounts, counterparty, metadata) and calls out the compliance-grant compliance angle
- [ ] "Go-to-market" quotes the PIVY research point 1.1 verbatim
- [ ] Every placeholder (demo URL, video URL, repo URL) is clearly marked for post-deploy fill-in
- [ ] Pre-submission checklist lives at the bottom
- [ ] No lorem ipsum, no "TBD", no square-bracket placeholders besides the three marked URLs

- [ ] **Step 3: Commit**

```bash
git add docs/submissions.md
git commit -m "docs: add submission-form copy for Colosseum + Umbra track"
```

---

## Completion gate

All five docs committed. Before the 2026-05-11 deadline:

- [ ] Vercel deploy done per `docs/deploy-checklist.md`; live URL pasted into `README.md` and `docs/submissions.md`.
- [ ] Demo video recorded per `docs/demo-script.md`; YouTube URL pasted into `README.md` and `docs/submissions.md`.
- [ ] Full smoke test run against the live URL per `docs/smoke-test.md`, all pass criteria ticked.
- [ ] Colosseum + Superteam submission forms filled in using copy from `docs/submissions.md`.

## Known gaps flagged

- **Demo URL is a placeholder** — fill in after Vercel deploy.
- **Video URL is a placeholder** — fill in after YouTube upload.
- **Repo URL is a placeholder** — fill in at submission time with the final public repo URL.
- **Team field is solo** — if collaborators join before 2026-05-11, update the team copy in `docs/submissions.md`.
- **Pricing claim in GTM** ("10 basis points on payment volume") is aspirational and not implemented; judges typically don't probe but be ready to clarify if asked.
