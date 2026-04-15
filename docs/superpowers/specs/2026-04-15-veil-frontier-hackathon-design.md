# Veil — Private Invoicing on Solana

**Design spec for Colosseum Frontier Hackathon submission**

- **Author:** Michal Marcinko (Superteam UK)
- **Date:** 2026-04-15
- **Hackathon window:** 2026-04-06 to 2026-05-11 (26 days remaining)
- **Target tracks:** Umbra ($10k), 100xDevs open ($10k), SNS Identity ($5k), Jupiter DX ($3k+bonus), Dune Analytics ($6k), main Frontier pool
- **Status:** Design approved, ready for implementation planning

---

## 1. Overview

**Veil** is a private invoicing and payment app for Solana. Businesses, freelancers, and individuals can issue invoices whose amounts are encrypted on-chain and whose payer/payee relationship is broken by a ZK mixer. Selective compliance access for auditors and tax authorities is built in from day one.

The core insight is that Solana is now processing 683K salary-sized payments per week (per public r/solana data, April 2026) and growing 20% week-over-week. Western Union is launching USDPT exclusively on Solana. Real businesses — 15-person design agencies, international contractors, cross-border suppliers — are already using USDC on Solana for payroll. But every one of those transactions is fully public on-chain: amounts, counterparties, patterns, timing. **Veil is the missing privacy layer for Solana's payroll economy.**

### 1.1 Value proposition

> Business-grade invoicing where amounts are encrypted on-chain but auditors still get selective disclosure.

### 1.2 Threat model (plainly stated)

**What Veil hides:**
- Transfer amounts (via Umbra encrypted token accounts)
- Counterparty linkage between payer and payee (via Umbra's UTXO mixer with ZK proofs)
- Invoice metadata: line items, notes, rates, terms (via AES-256-GCM client-side encryption)

**What Veil does NOT hide (honest disclosure, shown in-product):**
- The fact that an invoice existed (on-chain Anchor record is public, content is not)
- The existence of a Umbra account for the payer and payee (required for mixer use)
- The gross amounts of public ATA deposits into and withdrawals out of Umbra's shielded pools (a statistical side-channel mitigated by large anonymity sets)
- Recurring patterns that leak metadata even without amounts (this is an inherent limit of any amount-privacy system)

### 1.3 Non-goals

- Multi-user enterprise features (orgs, roles, SSO)
- Tax/jurisdiction calculation
- QuickBooks / Xero integration
- KYC or identity verification
- Dispute resolution / escrow
- Multi-chain support (Solana-only)
- Mobile native app
- Full internationalization
- Partial/milestone payments

## 2. Architecture

Six logical components communicating through well-defined interfaces:

```
┌─────────────────────────────────────────────────────────┐
│  Next.js Web App (frontend + edge API routes)           │
│  - Wallet connect (SIWS authentication)                 │
│  - Invoice creator UI                                   │
│  - Sender/Receiver dashboards                           │
│  - Public /pay/:id pay page                             │
│  - Compliance grant management                          │
└────────────┬────────────────────┬───────────────────────┘
             │                    │
             ▼                    ▼
┌────────────────────┐   ┌────────────────────────────────┐
│  Arweave (IPFS     │   │  Invoice Registry              │
│  fallback)         │   │  (Anchor program, our code)    │
│  encrypted JSON    │   │                                │
│  metadata          │   │  - hash, status, creator,      │
│                    │   │    payer, metadata URI,        │
│                    │   │    utxo_commitment cache,      │
│                    │   │    timestamps                  │
└────────────────────┘   └─────────┬──────────────────────┘
                                   │ emits events
                                   ▼
                         ┌──────────────────────┐
                         │  Helius webhook      │
                         │  (dashboard indexer) │
                         └──────────────────────┘

             ┌──────────────────────────────────┐
             │  Umbra SDK (client-side only)    │
             │                                  │
             │  @umbra-privacy/sdk              │
             │  @umbra-privacy/web-zk-prover    │
             │                                  │
             │  - Registration                  │
             │  - PublicBalanceToReceiver       │
             │    ClaimableUtxoCreator          │
             │  - Claim UTXOs via relayer       │
             │  - Compliance grant issuance     │
             │  - Balance queries               │
             └──────────────────────────────────┘

             ┌──────────────────────────────────┐
             │  SNS SDK (client-side)           │
             │                                  │
             │  Resolve @alice.sol → wallet     │
             │  for pay-by-name UX              │
             └──────────────────────────────────┘
```

### 2.1 Key design decisions

1. **Metadata off-chain, hash-anchored on-chain.** Invoice items/notes live on Arweave as AES-256-GCM ciphertext. The Anchor program stores only the sha256 hash + URI + status. Tamper-evident without paying for on-chain storage of opaque bytes.
2. **Encryption key in URL fragment.** Shareable invoice link is `https://veil.app/pay/{pda}#{base58(K)}`. Fragment never hits our server (browser native). Payer's browser decrypts locally. Same trust model as emailing a PDF.
3. **Umbra SDK is client-side only.** Our Anchor program never CPIs into Umbra. The coupling is via the UTXO's `optionalData` field (32 bytes = invoice PDA reference), not program-to-program calls. Clean boundary, simple program.
4. **Single privacy mode (mixer).** "Fast mode" (direct encrypted balance transfers) is not yet exposed in the SDK per Umbra's docs — it's "coming shortly." We use the mixer as the only mode, which is also more private and faster first-time-user UX.
5. **No traditional database for user data.** Frontend reads from on-chain state via Helius webhook or direct RPC. Zero user data on our servers.
6. **SIWS authentication.** Sign-In-With-Solana (wallet signature → session cookie). No email/password.

## 3. Data Model

### 3.1 On-chain: Invoice Registry (Anchor program)

```rust
#[account]
pub struct Invoice {
    pub version: u8,
    pub creator: Pubkey,                     // 32 — Alice
    pub payer: Option<Pubkey>,               // 33 — None for share-by-link
    pub mint: Pubkey,                        // 32 — USDC / USDT / wSOL / UMBRA
    pub metadata_hash: [u8; 32],             // 32 — sha256 of ciphertext
    pub metadata_uri: String,                // ~120 — Arweave tx ID
    pub utxo_commitment: Option<[u8; 32]>,   // 33 — populated on mark_paid
    pub status: InvoiceStatus,               // 1
    pub created_at: i64,                     // 8
    pub paid_at: Option<i64>,                // 9
    pub expires_at: Option<i64>,             // 9
    pub bump: u8,                            // 1
}

#[repr(u8)] pub enum InvoiceStatus { Pending, Paid, Cancelled, Expired }
```

- **Account size**: ~275 bytes + string overhead → rent-exempt ~0.0028 SOL (~$0.56 at $200/SOL)
- **PDA seeds**: `["invoice", creator.key().as_ref(), &nonce]` where nonce is an 8-byte unique ID per creator
- **Instructions**:
  - `create_invoice(metadata_hash, metadata_uri, payer, mint, expires_at)` — creator only
  - `mark_paid(utxo_commitment)` — called by payer after UTXO creation, or by backend sweeper
  - `cancel_invoice()` — creator only, before paid
  - `reclaim_rent()` — close terminal invoice, refund rent
- **Events emitted**: `InvoiceCreated`, `InvoicePaid`, `InvoiceCancelled`

### 3.2 Off-chain: Encrypted invoice JSON (Arweave)

Stored as AES-256-GCM ciphertext. Decrypted client-side only.

```json
{
  "version": 1,
  "invoice_id": "inv_abc123",
  "created_at": "2026-04-15T20:00:00Z",
  "creator": {
    "display_name": "Acme Design Ltd.",
    "wallet": "<creator pubkey>",
    "contact": "alice@acme.design",
    "logo_url": "..."
  },
  "payer": {
    "display_name": "Globex Corp.",
    "wallet": "<payer pubkey, optional>",
    "contact": "bob@globex.com"
  },
  "currency": {
    "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "symbol": "USDC",
    "decimals": 6
  },
  "line_items": [
    { "description": "Brand design (40h × $100)",
      "quantity": "40", "unit_price": "100000000", "total": "4000000000" }
  ],
  "subtotal": "4500000000",
  "tax": "0",
  "total": "4500000000",
  "due_date": "2026-05-15",
  "terms": "Net 30. Late fee 1.5%/month.",
  "notes": "Thanks for your business."
}
```

Amounts stored as decimal strings to avoid JS number precision loss.

### 3.3 Encryption scheme

```
1. Client generates random 256-bit key K
2. Ciphertext = AES-256-GCM(key=K, plaintext=invoice JSON)
3. Upload ciphertext to Arweave → tx_id
4. metadata_hash = sha256(ciphertext)
5. Anchor: create_invoice(metadata_uri=tx_id, metadata_hash, ...)
6. Shareable URL: https://veil.app/pay/{pda}#{base58(K)}
```

**Wallet-gated toggle** (COULD-HAVE stretch): also ECIES-wrap K to the payer's pubkey (ed25519→X25519 via `crypto_sign_ed25519_pk_to_curve25519`) and embed wrapped key in the on-chain record. Payer's wallet decrypts K directly; no URL fragment needed.

### 3.4 UTXO ↔ Invoice linkage

Umbra UTXOs carry a 32-byte `optionalData` field. On creation, the payer sets `optionalData = invoice_pda.to_bytes()`. Alice scans her received UTXOs via the Umbra indexer and filters by matching `optionalData` against her pending invoices.

**This inverts the usual "store a reference to the UTXO" pattern** — instead the UTXO stores a reference to our Anchor PDA. The `utxo_commitment` field on the Invoice PDA is a cache populated by `mark_paid`, not the primary linkage.

## 4. Core User Flows

### 4.1 Flow 1 — Alice creates her first invoice

**Pre-requisites:** Alice has a Solana wallet with ~0.1 SOL for registration + rent.

1. Alice fills invoice form (payer, line items, currency, notes, due date)
2. Alice clicks "Create Invoice"
3. If not registered: modal "Setting up your private account (one-time, ~10s)" → SDK `getUserRegistrationFunction({ client })({ confidential: true, anonymous: true })`
4. Client generates random key K
5. Client encrypts invoice JSON with K (AES-256-GCM)
6. Client uploads ciphertext to Arweave → `metadata_uri`
7. Client computes `metadata_hash = sha256(ciphertext)`
8. Client calls `create_invoice` on our Anchor program
9. Client builds shareable URL: `https://veil.app/pay/{pda}#{base58(K)}`
10. UI: success screen with copy-link + email-via-SendGrid option

**First-time cost**: ~0.10 SOL (registration) + 0.003 SOL (rent) + Arweave upload (~free). **Repeat**: just 0.003 SOL rent + Arweave.

**Critical**: Alice must be registered before she creates her first invoice, because when Bob later pays, his UTXO creation encrypts the ciphertext under her X25519 key, which only exists if she's registered.

### 4.2 Flow 2 — Bob pays (first-time user)

**Pre-requisites:** Bob has a Solana wallet + USDC in his public ATA + some SOL for fees.

1. Bob clicks Alice's link → `/pay/[pda]` page loads
2. Client extracts K from URL fragment (browser-local)
3. Client fetches Invoice PDA → `metadata_uri`, status, creator, payer
4. If status ≠ Pending, show "Already [paid/cancelled/expired]"
5. Client fetches ciphertext from Arweave
6. Client verifies `sha256(ciphertext) == metadata_hash` (tamper check)
7. Client AES-decrypts with K → renders invoice view
8. Bob clicks "Pay with Wallet" → wallet connect
9. Client checks registration state via `getUserAccountQuerierFunction`
10. **If not fully registered**: onboarding modal with 3-step progress
    - Step 1/3: Account initialization PDA
    - Step 2/3: X25519 key registration
    - Step 3/3: User commitment registration (anonymous mode)
11. Create UTXO via `getPublicBalanceToReceiverClaimableUtxoCreatorFunction`:
    ```ts
    const create = getPublicBalanceToReceiverClaimableUtxoCreatorFunction(
      { client },
      { zkProver }
    );
    const result = await create({
      destinationAddress: aliceAddress,
      mint: USDC_MINT,
      amount: invoiceTotal,
      optionalData: invoicePdaBytes, // 32-byte invoice PDA reference
    });
    ```
12. Call our `mark_paid(utxo_commitment)` with the result commitment
13. UI: "✓ Payment sent. Alice will receive this the next time she opens her dashboard."

**First-time total**: ~20-25s (registration + UTXO + mark_paid). **Repeat**: ~5-8s.

### 4.3 Flow 3 — Alice claims her payment

1. Alice opens dashboard → SIWS login
2. Client queries Helius webhook data for invoices where `creator == alice.pubkey`
3. Dashboard shows Incoming section (creator view) and Outgoing section (payer view)
4. On mount + every 30s while open: `getClaimableUtxoScannerFunction({ client })` scans Merkle trees
5. For each `result.publicReceived` UTXO, filter by `optionalData` matching Alice's pending invoices
6. Auto-claim matching UTXOs via `getReceiverClaimableUtxoToEncryptedBalanceClaimerFunction`, using `getUmbraRelayer({ apiEndpoint: "https://relayer.api.umbraprivacy.com" })` so Alice's wallet doesn't appear as fee payer
7. After claim confirms (Arcium MPC callback), invoice row shows "✓ Received {amount} USDC"
8. Amount is decrypted locally via Alice's X25519 key (Shared encryption mode)
9. Actions: "Withdraw to USDC wallet", "Export receipt for tax", "Archive"

### 4.4 Flow 4 — Alice grants compliance access to her accountant

1. Alice opens Compliance tab → "Grant viewing access"
2. Form: accountant's X25519 pubkey + scope (date range, mint filter, specific invoices)
3. Client calls `getComplianceGrantIssuerFunction`:
    ```ts
    const createGrant = getComplianceGrantIssuerFunction({ client });
    await createGrant({
      receiver: accountantX25519,
      nonce: randomBytes(32),
      // scope params TBD pending Day 1 investigation
    });
    ```
4. On-chain compliance grant PDA is created
5. Alice gets shareable URL: `https://veil.app/audit/{grant_pda}`
6. Accountant opens URL, connects their own wallet, fetches re-encrypted ciphertexts from Umbra indexer, decrypts locally with their X25519 private key, sees full invoice history within scope
7. Alice can revoke anytime by deleting the grant PDA

**Important warning shown in-product**: once a grant is created and re-encryption has occurred for a given nonce, that nonce is permanently readable by the grantee even after revocation. UI uses per-scope nonces and explains this clearly.

## 5. Umbra SDK Integration

### 5.1 Client initialization

```typescript
// src/lib/umbra.ts
import { getUmbraClient } from "@umbra-privacy/sdk";

export async function createClient(signer: WalletAdapterSigner) {
  return getUmbraClient({
    signer,
    network: process.env.NEXT_PUBLIC_SOLANA_NETWORK as "mainnet" | "devnet",
    rpcUrl: process.env.NEXT_PUBLIC_RPC_URL!,
    rpcSubscriptionsUrl: process.env.NEXT_PUBLIC_RPC_WSS_URL!,
    indexerApiEndpoint: "https://utxo-indexer.api.umbraprivacy.com",
  });
}
```

One client per authenticated session, cached in React context, re-init on wallet change. First call triggers a wallet signing prompt to derive master seed.

### 5.2 Required packages

```json
{
  "dependencies": {
    "@umbra-privacy/sdk": "PIN-EXACT-VERSION",
    "@umbra-privacy/web-zk-prover": "PIN-EXACT-VERSION"
  }
}
```

Pin exact versions, not `^`. Umbra SDK is actively finalizing per their docs ("confidential-only transfers coming shortly") — auto-upgrades are a risk.

### 5.3 Registration check + trigger

```typescript
import {
  getUserAccountQuerierFunction,
  getUserRegistrationFunction,
} from "@umbra-privacy/sdk";

async function ensureRegistered(client: UmbraClient): Promise<void> {
  const query = getUserAccountQuerierFunction({ client });
  const state = await query(client.signer.address);
  const isFullyRegistered = state.state === "exists"
    && state.data.isUserAccountX25519KeyRegistered
    && state.data.isUserCommitmentRegistered;
  if (isFullyRegistered) return;
  const register = getUserRegistrationFunction({ client });
  await register({ confidential: true, anonymous: true });
}
```

Called at Flow 1 start (Alice) and Flow 2 step 10 (Bob). Idempotent — re-call skips completed steps.

### 5.4 UTXO creation (Bob paying Alice)

```typescript
import { getPublicBalanceToReceiverClaimableUtxoCreatorFunction } from "@umbra-privacy/sdk";
import { getPublicBalanceToReceiverClaimableUtxoCreatorProver } from "@umbra-privacy/web-zk-prover";

const zkProver = getPublicBalanceToReceiverClaimableUtxoCreatorProver();
const create = getPublicBalanceToReceiverClaimableUtxoCreatorFunction(
  { client },
  { zkProver },
);

const result = await create({
  destinationAddress: aliceAddress,
  mint: USDC_MINT,
  amount: invoiceTotal,
  optionalData: invoicePdaBytes, // 32 bytes = invoice PDA
});
// result.commitment → stored in mark_paid
```

### 5.5 UTXO scan + claim (Alice receiving)

```typescript
import {
  getClaimableUtxoScannerFunction,
  getReceiverClaimableUtxoToEncryptedBalanceClaimerFunction,
  getUmbraRelayer,
} from "@umbra-privacy/sdk";
import { getReceiverClaimableUtxoToEncryptedBalanceClaimerProver } from "@umbra-privacy/web-zk-prover";

async function scanAndClaim(client: UmbraClient, pendingInvoices: Invoice[]) {
  const scan = getClaimableUtxoScannerFunction({ client });
  const result = await scan(0, 0); // tree 0, from beginning
  const pdaSet = new Set(pendingInvoices.map(i => i.pda.toString()));
  const matches = result.publicReceived.filter(utxo =>
    pdaSet.has(new PublicKey(utxo.optionalData).toString())
  );
  if (matches.length === 0) return;

  const zkProver = getReceiverClaimableUtxoToEncryptedBalanceClaimerProver();
  const relayer = getUmbraRelayer({ apiEndpoint: "https://relayer.api.umbraprivacy.com" });
  const claim = getReceiverClaimableUtxoToEncryptedBalanceClaimerFunction(
    { client },
    { zkProver, relayer },
  );
  await claim(matches);
}
```

### 5.6 Balance query (dashboard display)

```typescript
import { getEncryptedBalanceQuerierFunction } from "@umbra-privacy/sdk";

const query = getEncryptedBalanceQuerierFunction({ client });
const balance = await query({ mint: USDC_MINT }); // bigint, decrypted locally via X25519
```

Requires Shared encryption mode (set via `register({ confidential: true })`, default).

### 5.7 Compliance grant issuance

```typescript
import { getComplianceGrantIssuerFunction } from "@umbra-privacy/sdk";

const createGrant = getComplianceGrantIssuerFunction({ client });
await createGrant({
  receiver: accountantX25519PublicKey,
  nonce: crypto.getRandomValues(new Uint8Array(32)),
  // additional params from /sdk/compliance-x25519-grants TBD
});
```

## 6. Error Handling

### 6.1 Principles

- **Idempotency over retries.** Every mutation is safely retryable.
- **State reconciliation over state consistency.** Local state + on-chain state may drift; background sweeper reconciles every 5 minutes.
- **Honest error surfaces.** Show SDK error messages verbatim with a "What does this mean?" link; don't wrap in vague "Oops."
- **Form state persistence.** LocalStorage snapshots of in-progress forms survive disconnects and refreshes.

### 6.2 Failure modes (abridged)

| Flow | Failure | Recovery |
|---|---|---|
| Create invoice | Arweave upload fails | IPFS fallback (web3.storage), then retry button |
| Create invoice | Alice not registered | Inline registration modal, resume after |
| Create invoice | Anchor `create_invoice` fails | Client retries; orphaned Arweave blob is acceptable cost |
| Bob pays | Bob not registered | 3-step onboarding modal with progress |
| Bob pays | Insufficient public USDC | Clear error with required/held amounts |
| Bob pays | Alice not registered (shouldn't happen if enforced) | Error + trigger email to Alice to complete setup |
| Bob pays | UTXO creation fails (stale proof) | SDK retries with fresh proof automatically |
| Bob pays | `mark_paid` fails after UTXO creation | Background sweeper detects orphaned state and retries |
| Alice claims | Empty scan | Show "No pending payments", poll every 30s |
| Alice claims | `NullifierReuseError` | Display as already-received, no action |
| Dashboard | Webhook lag | Fallback to direct RPC poll |
| Tamper check | `metadata_hash` mismatch | Red banner, refuse decryption, block pay button |
| URL fragment missing | No `#key` in link | "Link is incomplete, ask sender for fresh one" |

### 6.3 Background sweeper

Vercel Cron or small VPS worker running every 5 minutes:

- Query Helius webhook data for `InvoiceCreated` events older than 10 minutes with `status == Pending`
- For each, check Umbra's indexer for matching UTXO (by `optionalData` = invoice PDA)
- If match found but status not updated → call `mark_paid` with commitment
- If no match after expiry window → mark `Expired`
- Handles webhook failures and mid-flow client crashes

## 7. Testing Strategy

### 7.1 Unit tests (Vitest, no network)

- Metadata encryption round-trip (encrypt → decrypt → match)
- URL fragment parsing (key extraction, invalid format)
- Tamper detection (modified ciphertext fails hash check)
- Invoice PDA derivation (deterministic from creator + nonce)
- `optionalData` encoding (PDA → 32 bytes → PDA)

### 7.2 Anchor program tests (Rust)

- `create_invoice` happy path, all field combinations
- `mark_paid` correct signer → success
- `mark_paid` wrong signer → rejects
- Duplicate `mark_paid` → idempotent no-op
- `cancel_invoice` from Pending → success
- `cancel_invoice` from Paid → rejects
- Rent / size calculations match docs

### 7.3 SDK integration tests (devnet)

- Full round-trip: register → create invoice → pay → claim → balance updates
- First-time user registration path
- Alice-not-registered edge case
- Insufficient public balance path
- `optionalData` correctly links UTXO to Invoice PDA

### 7.4 E2E tests (Playwright, two browsers)

- Alice in browser A creates invoice, copies link
- Bob in browser B pastes link, pays
- Alice sees payment appear in dashboard
- All on devnet with test wallets

### 7.5 Manual demo rehearsal

- Run the 5-minute demo script from §8 at least 10 times before recording
- Time each step, surface any slow/confusing moments
- Test 3 RPCs (Helius, QuickNode, public) to pick fastest for recording
- Record on fresh wallet each run (no "already registered" shortcuts)

### 7.6 Devnet vs mainnet

- **Weeks 1–4**: Develop entirely on devnet (`network: "devnet"` in SDK config)
- **Final demo recording**: Mainnet with ~$10 USDC of real funds for "this really works" credibility
- **Devnet reset script**: Clears test state between rehearsal runs (closes Invoice PDAs, withdraws Umbra balances)

## 8. Demo Video Script (5 minutes)

| Time | Scene | Content |
|---|---|---|
| 0:00–0:30 | Problem hook | Block explorer showing a public USDC salary payment. VO: *"This is what your payroll looks like today."* |
| 0:30–0:45 | Product intro | "Meet Veil. Private invoicing on Solana." |
| 0:45–1:45 | Flow 1 | Alice creates invoice end-to-end |
| 1:45–2:00 | Share | Alice emails Bob the link |
| 2:00–3:30 | Flow 2 | Bob pays as first-time user, registration included |
| 3:30–4:00 | Flow 3 | Alice dashboard auto-claim |
| 4:00–4:30 | Flow 4 | Compliance grant for accountant |
| 4:30–5:00 | Block explorer side-by-side | "Observers see encrypted blobs. Alice and her auditor see the full invoice." |

## 9. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Umbra SDK breaking changes mid-build | Medium | High | Pin exact versions |
| ZK prover slow in browser | Medium | High | Day 1 benchmark, pre-warm on page load |
| Devnet lacks Umbra-USDC | Medium | Medium | Fall back to wSOL/UMBRA test tokens |
| Arweave rate/cost surprises | Low | Low | IPFS fallback |
| Helius webhook unreliable (free tier) | Medium | Low | RPC poll fallback |
| Bob's registration UX feels terrible | Medium | Medium | Honest progress UI, user testing |
| Mainnet recording fails | Low | Medium | Devnet backup recording as fallback |
| Solo 26-day burnout | High | High | Rest days scheduled, stretch features deferrable |
| Judging subjectivity | Always | N/A | Stack multiple tracks |

## 10. Day 1 Investigation Items

Must be answered before implementation begins:

1. **Does devnet support Umbra-USDC?** Run quickstart with `network: "devnet"` and attempt deposit
2. **`optionalData` supported on `PublicBalanceToReceiverClaimable`?** Re-read creator parameters; if not exposed, switch to scan-by-amount-and-timing
3. **ZK prover cold-start time** — Day 1 benchmark; if >3s, implement pre-warm on page load
4. **Umbra wallet adapter compatibility** — does SDK signer work with `@solana/wallet-adapter-react` directly, or need a wrapper? Read `/sdk/wallet-adapters`
5. **Indexer API rate limits** — affects Alice's 30s polling frequency
6. **Relayer rate limits** — affects claim throughput
7. **UTXO tree fill behavior** — 1M leaves per tree, what happens next?
8. **Umbra team support channel** (X or TG) — find and bookmark for unblockers
9. **Next.js bundler compatibility** — test WebAssembly loading early
10. **Exact format of compliance grant scope parameters** — read `/sdk/compliance-x25519-grants` in full

## 11. Stretch Feature Prioritization

### MUST HAVE (core scope)
- Create invoice flow (Alice)
- Pay invoice flow (Bob) with registration onboarding
- Claim flow (Alice dashboard)
- Tamper-evident metadata encryption + URL fragment key
- Compliance grant UI (basic)
- Anchor program registry
- Demo video

### SHOULD HAVE (target aggressively)
- **SNS name resolution** (`@alice.sol` → wallet) — unlocks SNS track ($5k)
- Email notifications via SendGrid or Resend
- Multi-currency support (USDT, wSOL beyond USDC)
- Privacy explainer page with honest threat model
- Responsive mobile view

### COULD HAVE (extra time only)
- Wallet-gated metadata encryption toggle
- **Jupiter swap-to-USDC at pay time** — unlocks Jupiter DX track ($3k+)
- **Dashboard analytics panel with Dune data** — unlocks Dune track ($6k)
- CSV/PDF receipt export
- Recurring invoices (simple scheduler)
- Invoice templates (consultant, freelancer, B2B presets)

### WON'T HAVE (explicit non-goals)
See §1.3.

## 12. Track Stacking Strategy

| Track | Prize | Effort delta | Win probability (rough) |
|---|---|---|---|
| Umbra | $10k | Already core | ~75% (only 4 subs as of 2026-04-15) |
| 100xDevs open | $10k / 10 winners | Already core | ~70% |
| SNS Identity | $5k | +1 day | ~50% |
| Jupiter DX | $3k + DX bonuses | +2 days | ~40% |
| Dune Analytics | $6k | +3 days | ~30% |
| Solana Foundation UK Grant | $5-10k | +1 day proposal | ~60% |
| Main Frontier pool | $$$ | Submitted automatically | Low but real |

**Realistic aggregate expected value from core + 2 stretches (SNS + one of Jupiter/Dune):** $10k–25k across all vectors.

## 13. 26-Day Schedule

```
Day  1      Day 1 investigation items (§10), env setup, wallet adapter smoke test
Day  2–3    Anchor program scaffold + unit tests + devnet deploy
Day  4–7    Next.js app skeleton, SIWS auth, invoice creator UI, Arweave upload
Day  8–11   Umbra SDK integration: registration, UTXO creation, scan, claim
Day 12–14   Full happy-path end-to-end on devnet (create → pay → claim)
Day 15–17   Compliance grant UI, threat model explainer page
Day 18–20   SHOULD-HAVE stretches: SNS, email, mobile responsive, multi-currency
Day 21–22   Pick one COULD-HAVE (Jupiter DX report is likely best ROI)
Day 23–24   Error handling polish, sweeper worker, end-to-end test run
Day 25      Demo video rehearsal + recording on mainnet, documentation
Day 26      Submit to Colosseum main portal + Superteam Earn side tracks, buffer
```

**Critical slice**: Days 8–14. Everything hinges on the Umbra SDK integration working end-to-end. If it's not working by Day 14, scope stretch features down aggressively.

## 14. Definitions

- **ETA** — Encrypted Token Account, a Umbra on-chain account that stores a token balance encrypted via Arcium MPC
- **ATA** — Associated Token Account, Solana's standard public token account
- **Arcium MPC** — Umbra's privacy backend, a multi-party computation network that performs confidential arithmetic on encrypted balances
- **Mixer / UTXO** — Umbra's primitive for breaking on-chain linkage via a shared Indexed Merkle Tree and ZK proofs
- **Viewing key (hierarchical)** — Umbra's compliance mechanism for mixer UTXOs (Master → Mint → Year → Month → Day → etc.)
- **X25519 compliance grant** — Umbra's compliance mechanism for encrypted balance re-encryption to an auditor's key
- **SIWS** — Sign-In-With-Solana wallet authentication
- **Shielded pool** — the on-chain Umbra program account holding the actual SPL tokens backing all encrypted balances for a given mint

## 15. Appendix: Verified Umbra facts (2026-04-15)

Pulled from docs.umbraprivacy.com and sdk.umbraprivacy.com:

- SDK package: `@umbra-privacy/sdk`
- ZK prover package: `@umbra-privacy/web-zk-prover` (separate dep, required)
- TypeScript-native, Node 18+ or browser, no native deps
- **Supported mainnet tokens** (all with both confidentiality and mixer enabled):
  - USDC: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (standard SPL, no Token-2022 wrapping needed)
  - USDT: `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`
  - wSOL: `So11111111111111111111111111111111111111112`
  - UMBRA: `PRVT6TB7uss3FrUd2D9xs2zqDBsa3GbMJMwCQsgmeta`
- Protocol fee: **35 bps** using BPS_DIVISOR = 16384. Example: 1,000 USDC → 2.14 USDC fee → 997.86 received
- Relayer URL: `https://relayer.api.umbraprivacy.com`
- Indexer API: `https://utxo-indexer.api.umbraprivacy.com`
- Registration is a 3-step idempotent flow: account init → X25519 key → user commitment
- **Confidential-only transfers (direct ETA-to-ETA) are NOT YET AVAILABLE** in the SDK per the transfers docs page — only the mixer path works today
- Both sender and recipient must be fully registered for mixer operations
- Recipient X25519 key must be on-chain before a UTXO can be addressed to them
- `optionalData` is a 32-byte field supported on both creation and claim
- Registration transactions cost SOL; amounts are reasonable for user self-pay
