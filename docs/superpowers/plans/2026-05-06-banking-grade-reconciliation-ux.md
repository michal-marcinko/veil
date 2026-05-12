# Plan: Banking-grade reconciliation UX

**Date**: 2026-05-06
**Demo deadline**: 2026-05-11
**Owner**: marcin
**Status**: ready to dispatch

## Goal

Move Veil's Activity surface from "protocol mechanics" to "fintech reconciliation" — every invoice and payroll action automatically mirrors to both parties' dashboards, manual receipt paste demoted to a recovery fallback, and every row exports a heavy PDF with the full on-chain audit trail embedded.

## Privacy framing (must own this honestly)

Fix 2 (deployed 2026-05-06) added `PaymentIntentLock` PDA. The PDFs + verifier route in this plan **do not add new privacy compromise** beyond Fix 2 — they surface existing on-chain public data more conveniently for the audit use case. Five hardening patterns (below) reduce accidental exposure to the level appropriate for a B2B accounting product.

### Hardening patterns adopted (research-grounded)

Drawn from [Zcash viewing keys / payment disclosures](https://electriccoin.co/blog/explaining-viewing-keys-2/), [W3C TAG capability URL guidance](https://www.w3.org/2001/tag/doc/capability-urls/), and [W3C VC selective disclosure](https://w3c.github.io/vc-data-model/):

1. **Tiered PDFs** — default is "Invoice PDF" with no audit footer (same disclosure surface as paper). User opts in to "Receipt PDF" with audit footer when sharing with auditors.
2. **Capability-URL gate the verifier** — `/verify/<pda>#k=<token>` where token is `base58(metadataHash[0..6])` embedded in the QR. Without it, the verifier renders nothing. Per W3C TAG, the fragment never reaches the server, so it's never logged.
3. **NoIndex + no-cache** on the verifier route — prevents accidental search-engine indexing (the documented leak vector for capability URLs).
4. **Server access-log redaction** — middleware strips invoice PDAs from `/verify/[pda]` log entries.
5. **Compliance grant remains the heavy-disclosure primitive** — verifier attests on-chain state; compliance grant decrypts amounts/line items for chosen scope. Mirrors Zcash's two-tier model (full viewing key + payment disclosure).

### The honest privacy table

| What                                  | Public                                          | Private                       |
|---------------------------------------|-------------------------------------------------|-------------------------------|
| Invoice line items / memo / amount    |                                                 | Encrypted on Arweave          |
| Recipient's encrypted balance         |                                                 | Umbra MXE                     |
| Payment from **shielded** balance     | (no public deposit tx)                          | Amount + source invisible     |
| Payment from **public** balance       | Umbra deposit tx visible — amount visible       |                               |
| Payer ↔ invoice link                  | `PaymentIntentLock` PDA records both pubkeys    |                               |
| Recipient (creator) wallet            | Always public (Invoice account `creator` field) |                               |

**Pitch to use**: "Veil makes B2B payments private where it matters — amounts, balances, invoice contents, and payroll details stay encrypted. Payment-to-invoice reconciliation is on-chain proof, so auditors don't need to trust off-chain receipts."

**Do not say**: "anonymous", "fully private payments", "untraceable". Those overclaim and Codex's review surfaced this.

## Workstreams

### 1. Auto-render Paid from `PaymentIntentLock` — both sides (~2.5 hrs)

**Approach**: frontend-only. The lock IS the proof. Render based on its existence; lazy-fire `mark_paid` from creator's dashboard when she next loads it.

Rationale for not modifying `mark_paid` to accept the lock as evidence: would require another Anchor change + redeploy + buffer extension. Frontend-only achieves the same UX outcome with zero on-chain risk before May 11.

**Files**:
- `app/src/lib/lock-derivation.ts` (new)
  - `export function deriveLockPda(invoicePda: PublicKey): PublicKey`
  - `export const LOCK_SEED = Buffer.from("intent_lock")`
- `app/src/lib/anchor.ts`
  - `export async function fetchLockOptional(connection, lockPda): Promise<{ payer: PublicKey; lockedAt: number } | null>` — returns null on `account does not exist`
  - `export async function fetchManyLocks(connection, lockPdas[]): Promise<Map<base58, lock|null>>` — uses `getMultipleAccountsInfo` for batch
- `app/src/app/dashboard/page.tsx`
  - For each pending invoice, fetch lock in parallel batch
  - If lock exists → render row as `Paid · settlement pending` (or `Paid · just now` if `mark_paid` succeeded after)
  - Background: if creator and lock exists and status still Pending on chain → fire `mark_paid` lazily, idempotent (silently swallow `InvalidStatus` from a race)
- `app/src/components/IncomingInvoicesSection.tsx`
  - Same lock-fetch per row; render Paid badge when lock exists OR status is Paid

**Edge cases**:
- Lock present but invoice account stale-cached → re-fetch on stale
- Multiple dashboard tabs open → both fire mark_paid → second reverts on `InvalidStatus`. Cost = one wasted tx fee. Acceptable.
- Creator never opens dashboard → mark_paid never fires; on-chain status stays Pending. UI says "Paid · settlement pending" forever. **Document as expected behavior**: settlement is the creator's act. Audit trail is complete via lock anyway.

### 2. Bob's Activity flips paid invoices (~1 hr)

`app/src/components/IncomingInvoicesSection.tsx`:
- Today: shows opened invoices regardless of payment status
- Add per-row: fetch on-chain Invoice + lock
- Render badges:
  - `Awaiting payment` (no lock, status Pending) — Bob hasn't paid yet
  - `Paid · settling` (lock exists, status Pending) — Bob paid, Alice hasn't run mark_paid
  - `Paid` (status Paid) — fully settled
- Sort: awaiting-payment first, then paid (most-recent-first within group)

### 3. Heavy PDF — invoice / receipt / payslip (~3 hrs)

**Tiered output modes** (privacy hardening based on research — see Privacy section below):

- **Invoice PDF (default download)**: human-readable line items + total + creator. NO on-chain refs, NO payer wallet, NO tx sigs. Same disclosure surface as a paper invoice.
- **Receipt PDF (opt-in)**: invoice contents + audit footer with PDAs / tx sigs / payer / QR. UI surfaces this as a checkbox: "Include audit details (for accountants)". Default OFF; user explicitly chooses when sharing with auditors.

**Common audit footer component** (`app/src/lib/pdf/AuditFooter.tsx`):
- `Invoice PDA: <base58>`
- `Network: Devnet/Mainnet` + `Slot: <num>` + `Created at: <iso>`
- `Status: Pending|Paid` + `Last verified: <iso>`
- For paid: `Payment lock PDA`, `Payer wallet`, `Locked at`, `Payment tx sig`, `Mark-paid tx sig` (if fired)
- For payslip: `Payroll run ID`, `Claim-link UTXO commitment`, `Claim tx sig` (if claimed)
- `Document signature: <base64 sig over canonical fields>` — creator's signMessage over invoice fields, embedded for tamper-detection
- QR code (vector via `qrcode-svg`) linking to a **capability URL**: `https://<host>/verify/<invoicePda>#k=<token>` where `token = base58(metadataHash[0..6])`. The token is the verification capability — without it, the verifier route refuses.

**Templates** (use `@react-pdf/renderer`, already installed):
- `app/src/lib/pdf/invoicePdf.tsx` — pre-payment invoice (creator + payer downloadable)
- `app/src/lib/pdf/receiptPdf.tsx` — post-payment receipt (extends invoice + adds payment audit block when audit-mode enabled)
- `app/src/lib/payslipPdf.tsx` — extend existing template with optional `<AuditFooter />`

**Verifier route** with capability-URL gate:
- `app/src/app/verify/[pda]/page.tsx` (new)
- Reads `#k=<token>` from URL fragment client-side. Fragment never reaches the server (per W3C TAG capability URL guidance).
- Without token: renders empty "Paste a Veil verification link" form
- With valid token (matches first 6 bytes of on-chain `metadataHash` for that PDA): fetches on-chain Invoice + lock + recent txs and renders:
  - Green check + "Verified · paid by <wallet truncated> on <date>" if lock + mark_paid
  - Yellow check + "Verified · payment received, settlement pending" if lock only
  - Red X + "Not paid" if no lock and status Pending
  - Explorer links to all referenced txs
- Adds `<meta name="robots" content="noindex, nofollow">` to prevent search-engine indexing
- Sets `Cache-Control: no-store` on the response so CDNs don't cache verdicts
- The route does NOT decrypt invoice contents — only attests on-chain state. Amount / line-item audit goes through the compliance-grant primitive.

**Server-log hardening** (privacy item 4 — see Privacy section):
- Add Next.js middleware at `app/src/middleware.ts` that maps `/verify/[pda]` log paths to `/verify/[redacted]` for access logs. Functionality unchanged; logs no longer record which invoice PDAs were verified.

### 4. Per-payroll-run drill-in (~2 hrs)

New route: `app/src/app/dashboard/payroll/[batchId]/page.tsx`

- Loads run from `payroll-runs-storage` (keyed by batchId)
- Fetches each recipient's claim status:
  - For each row: derive their claim-link UTXO commitment → check if it's still in the queue (pending) or has been claimed (claimed-event) → check on-chain claim tx if any
- Renders table:
  - Recipient name (from packet) | Wallet (truncated, copy button) | Amount | Status (`Sent` | `Claimed` | `Pending`) | Actions: Download payslip PDF, Send compliance grant
- Page header: total amount, claim rate (3/4 claimed), Run ID, sent date
- Page-level action: `Send compliance grant for full run` (scopes to all rows in this batch)

**Wire from Sent feed**: clicking a payroll row in `dashboard/page.tsx` Sent tab → navigate to `/dashboard/payroll/[batchId]`.

### 5. Per-row compliance grant entrypoint (~1 hr)

Today: `/dashboard/compliance` requires manual invoice picking.

Add: row-level overflow `…` menu on each invoice row + payroll row → "Send compliance grant for this <invoice|run>".
- New component `app/src/components/RowOverflowMenu.tsx` — shared by InvoiceRow + payroll-run row + payslip row
- Items: `Download PDF`, `Send compliance grant`, `View on explorer`
- The grant entry passes `?seed=<pda>` to `/dashboard/compliance`
- `compliance/page.tsx` reads `seed` on mount → pre-selects that single PDA in the picker → user just clicks "Generate"

### 6. Hide receipt paste under "More → Import receipt" (~30 min)

`app/src/app/dashboard/page.tsx`:
- Move the "Open the apply-receipt panel" button from the primary FilterBar toolbar to a `More ▾` overflow menu in the Sent tab header
- Slide-over panel itself stays unchanged — same `<SlideOverPanel>`, same Apply-receipt button
- Add explanatory note inside the panel:
  > "Recovery flow. Most invoices auto-settle when the on-chain payment lock is detected — no manual import needed. Use this if you received a payment outside the invoice link or if auto-detection failed."

### 7. Copy polish (~30 min)

Replace throughout app where it appears:
- "Apply payer receipt" → "Import receipt" (in the now-hidden panel)
- Status labels: render with separator + relative time (`Paid · 2h ago`, not `InvoiceStatus::Paid`)
- "Pending claims" → "Payments to claim"
- Toast/banner copy on auto-flip: "Invoice marked paid — verified on-chain"

Confirm no regressions to Subagent A's earlier copy work (2026-05-04 redesign).

### 8. README + privacy language update (~45 min)

Update `README.md` with:
- The privacy table from the top of this plan
- Section: "How reconciliation works"
  - Explains `PaymentIntentLock` as the on-chain proof
  - "What auditors get: a verifiable URL + the receipt PDF; no need to trust off-chain receipts"
  - Section: "Privacy boundary"
  - Explicit: "Veil is not Tornado. Payer-to-invoice linkage is public. Amount is private (when paid from shielded balance) or visible (when paid from public balance)."
- Section: "Live URLs"
  - Devnet program IDs (already current)
  - Railway demo URL
  - Verifier example: `/verify/<invoicePda>`

## Subagent dispatch

Two subagents in parallel — no file collisions.

### Subagent A (opus) — workstreams 1, 2, 6, 7, 8
- Frontend lock-scanning + lazy mark_paid (item 1)
- Bob's invoice paid-flip (item 2)
- Hide receipt paste (item 6)
- Copy polish (item 7)
- README + privacy (item 8)
- **Owns**: `dashboard/page.tsx`, `IncomingInvoicesSection.tsx`, `IncomingPrivatePaymentsSection.tsx`, `anchor.ts`, `lock-derivation.ts` (new), `README.md`
- **Estimated**: ~5 hrs
- **Acceptance**: tsc + dashboard-render tests still pass; manual smoke: paying an invoice → Alice's dashboard shows Paid on next refresh without any interaction

### Subagent B (opus) — workstreams 3, 4, 5
- Heavy PDFs (invoice + receipt + payslip with audit footer + QR)
- Public verifier route `/verify/[pda]`
- Payroll drill-in `/dashboard/payroll/[batchId]`
- Row-level overflow menu + compliance grant pre-fill
- **Owns**: new files under `app/src/lib/pdf/`, `app/src/app/verify/[pda]/`, `app/src/app/dashboard/payroll/[batchId]/`, `app/src/components/RowOverflowMenu.tsx`, additions to `compliance/page.tsx` for seed param, extend `payslipPdf.tsx`
- **Estimated**: ~6 hrs
- **Acceptance**: tsc clean; manual smoke: download an invoice PDF, scan its QR → opens verifier and renders correct verdict; click "Send compliance grant" from a row → compliance page opens pre-selected with that PDA

### Integration contract between A and B

InvoiceRow already exists. Subagent A renders rows in dashboard/page.tsx. Subagent B adds `<RowOverflowMenu />` as a sibling. To avoid collision, agree:
- A leaves space for B by adding a `slot="actions"` div in each row (empty during A's work)
- B's overflow menu portals into that slot

Or simpler: B owns `<RowOverflowMenu />` as a self-contained component imported by A's render code — A just calls `<RowOverflowMenu invoicePda={inv.pda} />` at the right place. B should ship the component first (or stub it with no-ops) so A can import it without breaking.

**Recommendation**: B ships `<RowOverflowMenu />` as a stub first (renders empty `…` button), then both work in parallel; B fills in the menu items in their own pass.

## Acceptance criteria

- [ ] Alice creates invoice → her Activity shows Pending row; she can `Download PDF` (heavy with audit footer + QR) + `Send compliance grant`
- [ ] Bob opens link → his Inbox shows row in `Awaiting payment`; he can `Download PDF` + `Pay`
- [ ] Bob pays → both dashboards show `Paid · settling` within one refresh; no manual receipt step required
- [ ] Both can download Receipt PDF post-payment with full audit trail (PDAs + tx sigs + QR linking to verifier)
- [ ] Anyone can open `/verify/<invoicePda>` and see green/yellow/red verdict from on-chain state alone
- [ ] Alice runs payroll → row in Sent; click → drill-in shows per-recipient status; can `Download payslip PDF` per-row + `Send compliance grant for run`
- [ ] Each employee sees payslip in Inbox with `Download PDF` + `Send compliance grant`
- [ ] Receipt-paste only accessible via `More → Import receipt` with recovery copy
- [ ] README accurately describes privacy split (no "anonymous" overclaim)
- [ ] All existing tests still pass: `dashboard-render` (6/6), `veilpay` (7/7)
- [ ] tsc + `next build` clean
- [ ] Demo flow recordable end-to-end in <5 minutes

## Risks

1. **Lock-fetch performance** — fetching N lock PDAs per dashboard load. `getMultipleAccountsInfo` handles up to 100 in one RPC call. For typical usage (<50 invoices) one batched call. Mitigation: cap dashboard to 100 most-recent invoices for lock-fetch; older ones load lazily on scroll.

2. **mark_paid race** — multiple tabs / refresh storms fire duplicate mark_paid txs. Second reverts with `InvalidStatus`. Cost = ~5000 lamports per duplicate. Acceptable.

3. **PDF size** — heavy PDFs with QR + multiple TX refs typically 200-400KB. Not a download constraint. Generation time ~1-2s on first-render; cache result in memory per session.

4. **Payroll drill-in scan cost** — each recipient's claim status check is 1-2 RPC calls. For 10-person payroll, ~20 calls. Should be <2s. Mitigation: parallelize all per-recipient fetches.

5. **Verifier route doesn't decrypt** — by design (no key access). Audit-grade verdict is "did this happen on chain" not "what was the amount." Amount verification flows through compliance grants. Document explicitly in `/verify/[pda]` page so users don't expect line-item proof there.

6. **Privacy regression talking point** — readers of the README may infer Veil is "less private than v1". Counter: lead with the audit/reconciliation framing, not the privacy framing. The product story is "private B2B accounting", not "anonymous payments".

## Out of scope (deferred to v2)

- Shadow-signer mode for anonymous-payer use (~3-4 hrs + breaks restricted invoices without ZK delegation)
- Modifying `mark_paid` to accept the lock as evidence (would let any wallet flip status; not needed for hackathon)
- Multi-mint support across the row UI (today USDC only)
- Bulk PDF export (zip of all invoices in a date range)
- Email-out of receipt PDFs

## Order of execution

1. **Subagent B ships `<RowOverflowMenu />` stub** (~10 min) — unblocks Subagent A
2. **Subagent A + Subagent B run in parallel** — A: 1, 2 (~3.5 hrs), then 6, 7, 8 (~1.5 hrs); B: 3 (~3 hrs), then 4, 5 (~3 hrs)
3. **Integration review pass** via `superpowers:code-reviewer` — focus: does the auto-flip actually work end-to-end, does the verifier render correctly, are the PDF audit footers complete
4. **e2e smoke** by marcin: pay an invoice → verify auto-flip; download receipt PDF → scan QR → verify route renders green; run payroll → drill in → download payslip
5. **README + privacy update** lands last so the framing matches what's actually shipped

Total: ~11 hrs of focused work. Demo-ready by 2026-05-09 with 2-day buffer for video + final polish.
