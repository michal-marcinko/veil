# Veil Core MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working end-to-end private invoicing demo for the Colosseum Frontier Hackathon: create invoice → encrypted Arweave metadata → Anchor registry record → recipient pays via Umbra mixer UTXO → recipient auto-claims → compliance grant issuance. Target deadline 2026-05-11.

**Architecture:** Monorepo with (1) a minimal Anchor program (`invoice-registry`) storing tamper-evident invoice state, (2) a Next.js 14 App Router frontend that handles wallet auth, AES-256-GCM metadata encryption, Arweave upload, and all UI flows, and (3) client-side Umbra SDK integration for registration, UTXO creation from public USDC ATA, scanning, claiming, and compliance grants. No CPI from our program into Umbra — the coupling is via the UTXO `optionalData` field carrying invoice PDA bytes.

**Tech Stack:** Rust + Anchor 0.30+, Next.js 14, TypeScript 5, Tailwind CSS, `@coral-xyz/anchor`, `@solana/web3.js`, `@solana/wallet-adapter-react`, `@umbra-privacy/sdk`, `@umbra-privacy/web-zk-prover`, `@bundlr-network/client` for Arweave, Vitest for unit tests.

**Spec:** See `docs/superpowers/specs/2026-04-15-veil-frontier-hackathon-design.md` for full context.

**Scope note:** This plan covers MUST-HAVE features only. SHOULD-HAVE stretches (SNS pay-by-name, email notifications, multi-currency UI polish, privacy explainer page, mobile responsive) and COULD-HAVE stretches (Jupiter DX, Dune analytics, wallet-gated encryption, background sweeper worker) will be generated as a second plan after this one is executed end-to-end.

---

## Phase 0 — Workspace setup and Day 1 investigation

### Task 1: Workspace root scaffolding

**Files:**
- Create: `.gitignore`
- Create: `package.json`

- [ ] **Step 1: Write `.gitignore`**

Create `.gitignore`:

```
node_modules/
.next/
dist/
build/
target/
.anchor/
*.log
.env
.env.local
.env.*.local
.DS_Store
test-ledger/
.swarmhash
yarn-error.log
npm-debug.log*
.vercel/
*.tsbuildinfo
```

- [ ] **Step 2: Write workspace root `package.json`**

Create `package.json`:

```json
{
  "name": "veil-monorepo",
  "private": true,
  "version": "0.0.0",
  "workspaces": [
    "app"
  ],
  "scripts": {
    "dev": "npm --workspace app run dev",
    "build": "npm --workspace app run build",
    "test": "npm --workspace app run test",
    "anchor:build": "cd programs/invoice-registry && anchor build",
    "anchor:test": "cd programs/invoice-registry && anchor test",
    "anchor:deploy:devnet": "cd programs/invoice-registry && anchor deploy --provider.cluster devnet"
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add .gitignore package.json
git commit -m "chore: workspace root scaffolding"
```

---

### Task 2: Day 1 investigation — document findings

**Files:**
- Create: `docs/superpowers/investigation/2026-04-15-day-1-findings.md`

This task is research, not code. Produce a findings document that resolves the 10 open questions from spec §10.

- [ ] **Step 1: Create the investigation directory**

```bash
mkdir -p docs/superpowers/investigation
```

- [ ] **Step 2: Create and populate the findings doc**

Create `docs/superpowers/investigation/2026-04-15-day-1-findings.md`:

```markdown
# Day 1 Investigation Findings

Date: 2026-04-15

## 1. Devnet USDC support

Attempted: `getUmbraClient({ network: "devnet", ... })` with USDC mint.
Result: [FILL IN — SUPPORTED / NOT SUPPORTED / SUPPORTED WITH CAVEAT]
Fallback token if needed: [FILL IN — wSOL / UMBRA / ...]

## 2. optionalData on PublicBalanceToReceiverClaimable

Checked docs page: https://sdk.umbraprivacy.com/sdk/mixer/creating-utxos
Finding: [FILL IN — parameter name, byte size, whether exposed in CreateUtxoArgs]

## 3. ZK prover cold-start time (ms)

Ran: getPublicBalanceToReceiverClaimableUtxoCreatorProver() + first proof generation
Cold-start: [FILL IN] ms
Warm: [FILL IN] ms
Pre-warm strategy needed: [YES/NO]

## 4. Wallet adapter compatibility

Tested: @solana/wallet-adapter-react signer with getUmbraClient({ signer })
Works out of box: [YES/NO]
Wrapper needed: [YES/NO — if yes, sketch the wrapper]

## 5. Indexer API rate limits

Indexer: https://utxo-indexer.api.umbraprivacy.com
Documented limits: [FILL IN or "not documented — assume generous"]
Testing approach: 30s polling for Alice's dashboard

## 6. Relayer rate limits

Relayer: https://relayer.api.umbraprivacy.com
Documented limits: [FILL IN]

## 7. UTXO tree fill behavior

Tree capacity: 1,048,576 leaves (depth-20 tree)
What happens when full: [FILL IN from docs]

## 8. Umbra team support channel

X: https://x.com/UmbraPrivacy
Telegram: [FILL IN if found]
Discord: [FILL IN if found]

## 9. Next.js bundler compatibility

Tested: next build with @umbra-privacy/sdk + @umbra-privacy/web-zk-prover imports
WASM loading: [WORKS / NEEDS CONFIG]
next.config.mjs additions: [NONE / paste any config needed]

## 10. Compliance grant scope format

Page: https://sdk.umbraprivacy.com/sdk/compliance-x25519-grants
Scope params: [FILL IN — JSON schema]
```

- [ ] **Step 3: Read each section of Umbra docs that has an open question**

Open in a browser and read each of these pages end-to-end, filling in the findings above:

- `https://sdk.umbraprivacy.com/quickstart`
- `https://sdk.umbraprivacy.com/sdk/mixer/creating-utxos`
- `https://sdk.umbraprivacy.com/sdk/wallet-adapters`
- `https://sdk.umbraprivacy.com/sdk/compliance-x25519-grants`
- `https://sdk.umbraprivacy.com/sdk/mixer/fetching-utxos`
- `https://sdk.umbraprivacy.com/concepts/utxos-and-mixer`

- [ ] **Step 4: Commit findings**

```bash
git add docs/superpowers/investigation/
git commit -m "docs: Day 1 investigation findings"
```

**Blocking gate:** If finding §1 shows devnet doesn't support USDC, update the rest of this plan to use the fallback token (`wSOL` or `UMBRA`) in all subsequent tasks before proceeding. Replace the `USDC_MINT` constant in Task 14 accordingly.

---

### Task 3: Install Umbra SDK and verify imports

**Files:**
- Create: `app/package.json` (minimal, expanded in later tasks)

- [ ] **Step 1: Create the app workspace directory**

```bash
mkdir -p app
```

- [ ] **Step 2: Create minimal `app/package.json` with Umbra pinned**

Create `app/package.json`:

```json
{
  "name": "veil-app",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@umbra-privacy/sdk": "0.x",
    "@umbra-privacy/web-zk-prover": "0.x"
  }
}
```

**Important:** Before committing, replace `"0.x"` with the exact latest stable versions by running `npm view @umbra-privacy/sdk version` and `npm view @umbra-privacy/web-zk-prover version`, then pin those exact versions (no `^` or `~`). Umbra SDK is actively being finalized — pinning protects against mid-sprint breakage.

- [ ] **Step 3: Install**

```bash
cd app && npm install
```

Expected: installs without errors. If there are peer dep warnings, document them in `docs/superpowers/investigation/2026-04-15-day-1-findings.md` under a new section `## 11. Umbra SDK peer dep warnings`.

- [ ] **Step 4: Write an import smoke test**

Create `app/tests/umbra-imports.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  getUmbraClient,
  getUserRegistrationFunction,
  getUserAccountQuerierFunction,
  getPublicBalanceToReceiverClaimableUtxoCreatorFunction,
  getClaimableUtxoScannerFunction,
  getReceiverClaimableUtxoToEncryptedBalanceClaimerFunction,
  getUmbraRelayer,
  getComplianceGrantIssuerFunction,
  getEncryptedBalanceQuerierFunction,
} from "@umbra-privacy/sdk";
import {
  getPublicBalanceToReceiverClaimableUtxoCreatorProver,
  getReceiverClaimableUtxoToEncryptedBalanceClaimerProver,
} from "@umbra-privacy/web-zk-prover";

describe("Umbra SDK imports", () => {
  it("exports all functions we depend on", () => {
    expect(getUmbraClient).toBeTypeOf("function");
    expect(getUserRegistrationFunction).toBeTypeOf("function");
    expect(getUserAccountQuerierFunction).toBeTypeOf("function");
    expect(getPublicBalanceToReceiverClaimableUtxoCreatorFunction).toBeTypeOf("function");
    expect(getClaimableUtxoScannerFunction).toBeTypeOf("function");
    expect(getReceiverClaimableUtxoToEncryptedBalanceClaimerFunction).toBeTypeOf("function");
    expect(getUmbraRelayer).toBeTypeOf("function");
    expect(getComplianceGrantIssuerFunction).toBeTypeOf("function");
    expect(getEncryptedBalanceQuerierFunction).toBeTypeOf("function");
  });

  it("exports ZK provers we depend on", () => {
    expect(getPublicBalanceToReceiverClaimableUtxoCreatorProver).toBeTypeOf("function");
    expect(getReceiverClaimableUtxoToEncryptedBalanceClaimerProver).toBeTypeOf("function");
  });
});
```

- [ ] **Step 5: Add vitest as dev dep and run the test**

```bash
cd app && npm install -D vitest typescript @types/node
npx vitest run tests/umbra-imports.test.ts
```

Expected: 2 passing tests. If any import fails, the function name has moved — read `https://sdk.umbraprivacy.com/sdk/...` to find the new name and update the import + the downstream tasks that reference it.

- [ ] **Step 6: Commit**

```bash
cd .. && git add app/package.json app/package-lock.json app/tests/umbra-imports.test.ts
git commit -m "chore(app): install and pin Umbra SDK with import smoke test"
```

---

## Phase 1 — Anchor program (invoice-registry)

### Task 4: Anchor program scaffolding

**Files:**
- Create: `programs/invoice-registry/Anchor.toml`
- Create: `programs/invoice-registry/Cargo.toml`
- Create: `programs/invoice-registry/src/lib.rs` (skeleton only)
- Create: `programs/invoice-registry/tests/invoice-registry.ts` (empty)

- [ ] **Step 1: Initialize anchor workspace**

```bash
mkdir -p programs/invoice-registry && cd programs/invoice-registry && anchor init . --no-install
```

Expected: Anchor creates `Anchor.toml`, `Cargo.toml`, `programs/invoice-registry/src/lib.rs`, and `tests/invoice-registry.ts`.

If `anchor init .` refuses because the directory isn't empty, manually create the files below.

- [ ] **Step 2: Write the minimal `lib.rs` skeleton**

Replace `programs/invoice-registry/src/lib.rs` with:

```rust
use anchor_lang::prelude::*;

declare_id!("InvReg1111111111111111111111111111111111111");

#[program]
pub mod invoice_registry {
    use super::*;

    pub fn create_invoice(_ctx: Context<CreateInvoice>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct CreateInvoice<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    pub system_program: Program<'info, System>,
}
```

This is a placeholder skeleton that builds. Real state and logic come in Tasks 5–8.

- [ ] **Step 3: Build the empty program**

```bash
cd programs/invoice-registry && anchor build
```

Expected: builds cleanly. `target/idl/invoice_registry.json` and `target/types/invoice_registry.ts` should exist.

If build fails with "program id does not match", run `anchor keys sync` and commit the updated id.

- [ ] **Step 4: Commit**

```bash
cd ../.. && git add programs/ Anchor.toml
git commit -m "feat(anchor): program scaffolding"
```

---

### Task 5: Invoice state struct + test

**Files:**
- Modify: `programs/invoice-registry/src/lib.rs`

- [ ] **Step 1: Write failing Anchor test for state shape**

Replace `programs/invoice-registry/tests/invoice-registry.ts` with:

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { InvoiceRegistry } from "../target/types/invoice_registry";
import { expect } from "chai";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { randomBytes } from "crypto";

describe("invoice-registry", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.InvoiceRegistry as Program<InvoiceRegistry>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;

  function invoicePda(creator: PublicKey, nonce: Uint8Array): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("invoice"), creator.toBuffer(), Buffer.from(nonce)],
      program.programId,
    );
  }

  const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

  it("creates an invoice with pending status", async () => {
    const creator = provider.wallet.publicKey;
    const nonce = randomBytes(8);
    const [pda] = invoicePda(creator, nonce);

    const metadataHash = Array.from(randomBytes(32));
    const metadataUri = "https://arweave.net/test-tx-id";

    await program.methods
      .createInvoice(Array.from(nonce), metadataHash, metadataUri, USDC_MINT, null)
      .accounts({
        invoice: pda,
        creator,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const invoice = await program.account.invoice.fetch(pda);
    expect(invoice.creator.toBase58()).to.equal(creator.toBase58());
    expect(invoice.mint.toBase58()).to.equal(USDC_MINT.toBase58());
    expect(invoice.metadataUri).to.equal(metadataUri);
    expect(invoice.status).to.deep.equal({ pending: {} });
    expect(invoice.paidAt).to.be.null;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd programs/invoice-registry && anchor test
```

Expected: FAIL — the `createInvoice` method doesn't exist yet with that signature.

- [ ] **Step 3: Implement the Invoice state + create_invoice instruction**

Replace `programs/invoice-registry/src/lib.rs` with:

```rust
use anchor_lang::prelude::*;

declare_id!("InvReg1111111111111111111111111111111111111");

#[program]
pub mod invoice_registry {
    use super::*;

    pub fn create_invoice(
        ctx: Context<CreateInvoice>,
        nonce: [u8; 8],
        metadata_hash: [u8; 32],
        metadata_uri: String,
        mint: Pubkey,
        expires_at: Option<i64>,
    ) -> Result<()> {
        require!(metadata_uri.len() <= Invoice::MAX_URI_LEN, InvoiceError::UriTooLong);

        let invoice = &mut ctx.accounts.invoice;
        invoice.version = 1;
        invoice.creator = ctx.accounts.creator.key();
        invoice.payer = None;
        invoice.mint = mint;
        invoice.metadata_hash = metadata_hash;
        invoice.metadata_uri = metadata_uri;
        invoice.utxo_commitment = None;
        invoice.status = InvoiceStatus::Pending;
        invoice.created_at = Clock::get()?.unix_timestamp;
        invoice.paid_at = None;
        invoice.expires_at = expires_at;
        invoice.nonce = nonce;
        invoice.bump = ctx.bumps.invoice;
        Ok(())
    }
}

#[account]
pub struct Invoice {
    pub version: u8,                       // 1
    pub creator: Pubkey,                   // 32
    pub payer: Option<Pubkey>,             // 33
    pub mint: Pubkey,                      // 32
    pub metadata_hash: [u8; 32],           // 32
    pub metadata_uri: String,              // 4 + MAX_URI_LEN
    pub utxo_commitment: Option<[u8; 32]>, // 33
    pub status: InvoiceStatus,             // 1
    pub created_at: i64,                   // 8
    pub paid_at: Option<i64>,              // 9
    pub expires_at: Option<i64>,           // 9
    pub nonce: [u8; 8],                    // 8
    pub bump: u8,                          // 1
}

impl Invoice {
    pub const MAX_URI_LEN: usize = 200;
    pub const SIZE: usize = 8 // discriminator
        + 1                  // version
        + 32                 // creator
        + 33                 // payer (Option<Pubkey>)
        + 32                 // mint
        + 32                 // metadata_hash
        + 4 + Self::MAX_URI_LEN // metadata_uri
        + 33                 // utxo_commitment
        + 1                  // status
        + 8                  // created_at
        + 9                  // paid_at
        + 9                  // expires_at
        + 8                  // nonce
        + 1;                 // bump
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub enum InvoiceStatus {
    Pending,
    Paid,
    Cancelled,
    Expired,
}

#[derive(Accounts)]
#[instruction(nonce: [u8; 8])]
pub struct CreateInvoice<'info> {
    #[account(
        init,
        payer = creator,
        space = Invoice::SIZE,
        seeds = [b"invoice", creator.key().as_ref(), nonce.as_ref()],
        bump,
    )]
    pub invoice: Account<'info, Invoice>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum InvoiceError {
    #[msg("Metadata URI exceeds maximum length")]
    UriTooLong,
    #[msg("Invoice is not in a state that allows this operation")]
    InvalidStatus,
    #[msg("Only the creator can perform this action")]
    NotCreator,
    #[msg("Only the designated payer can perform this action")]
    NotPayer,
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd programs/invoice-registry && anchor test
```

Expected: PASS — invoice fetches back with the expected fields.

- [ ] **Step 5: Commit**

```bash
cd ../.. && git add programs/invoice-registry/
git commit -m "feat(anchor): Invoice state and create_invoice instruction"
```

---

### Task 6: `mark_paid` instruction

**Files:**
- Modify: `programs/invoice-registry/src/lib.rs`
- Modify: `programs/invoice-registry/tests/invoice-registry.ts`

- [ ] **Step 1: Add failing test for mark_paid**

Append to `programs/invoice-registry/tests/invoice-registry.ts` inside the describe block:

```typescript
  it("marks an invoice as paid when the payer signs", async () => {
    const creator = provider.wallet.publicKey;
    const nonce = randomBytes(8);
    const [pda] = invoicePda(creator, nonce);

    const metadataHash = Array.from(randomBytes(32));
    const utxoCommitment = Array.from(randomBytes(32));

    // Create pending invoice with no restricted payer
    await program.methods
      .createInvoice(Array.from(nonce), metadataHash, "https://arweave.net/x", USDC_MINT, null)
      .accounts({ invoice: pda, creator, systemProgram: SystemProgram.programId })
      .rpc();

    // Any signer can mark paid when payer is None
    const randomPayer = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(randomPayer.publicKey, 1e9);
    await provider.connection.confirmTransaction(airdropSig);

    await program.methods
      .markPaid(utxoCommitment)
      .accounts({ invoice: pda, payer: randomPayer.publicKey })
      .signers([randomPayer])
      .rpc();

    const invoice = await program.account.invoice.fetch(pda);
    expect(invoice.status).to.deep.equal({ paid: {} });
    expect(invoice.paidAt).to.not.be.null;
    expect(Array.from(invoice.utxoCommitment as Uint8Array)).to.deep.equal(utxoCommitment);
  });

  it("rejects mark_paid when payer is restricted and signer does not match", async () => {
    const creator = provider.wallet.publicKey;
    const nonce = randomBytes(8);
    const [pda] = invoicePda(creator, nonce);

    const designatedPayer = Keypair.generate();
    const randomSigner = Keypair.generate();
    const ad1 = await provider.connection.requestAirdrop(randomSigner.publicKey, 1e9);
    await provider.connection.confirmTransaction(ad1);

    // Create with restricted payer
    await program.methods
      .createInvoiceRestricted(
        Array.from(nonce),
        Array.from(randomBytes(32)),
        "https://arweave.net/x",
        USDC_MINT,
        null,
        designatedPayer.publicKey,
      )
      .accounts({ invoice: pda, creator, systemProgram: SystemProgram.programId })
      .rpc();

    try {
      await program.methods
        .markPaid(Array.from(randomBytes(32)))
        .accounts({ invoice: pda, payer: randomSigner.publicKey })
        .signers([randomSigner])
        .rpc();
      expect.fail("should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.match(/NotPayer/);
    }
  });
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd programs/invoice-registry && anchor test
```

Expected: FAIL — `markPaid` and `createInvoiceRestricted` don't exist.

- [ ] **Step 3: Add the instructions**

In `programs/invoice-registry/src/lib.rs`, add two new instructions inside `pub mod invoice_registry`:

```rust
    pub fn create_invoice_restricted(
        ctx: Context<CreateInvoice>,
        nonce: [u8; 8],
        metadata_hash: [u8; 32],
        metadata_uri: String,
        mint: Pubkey,
        expires_at: Option<i64>,
        payer: Pubkey,
    ) -> Result<()> {
        require!(metadata_uri.len() <= Invoice::MAX_URI_LEN, InvoiceError::UriTooLong);

        let invoice = &mut ctx.accounts.invoice;
        invoice.version = 1;
        invoice.creator = ctx.accounts.creator.key();
        invoice.payer = Some(payer);
        invoice.mint = mint;
        invoice.metadata_hash = metadata_hash;
        invoice.metadata_uri = metadata_uri;
        invoice.utxo_commitment = None;
        invoice.status = InvoiceStatus::Pending;
        invoice.created_at = Clock::get()?.unix_timestamp;
        invoice.paid_at = None;
        invoice.expires_at = expires_at;
        invoice.nonce = nonce;
        invoice.bump = ctx.bumps.invoice;
        Ok(())
    }

    pub fn mark_paid(ctx: Context<MarkPaid>, utxo_commitment: [u8; 32]) -> Result<()> {
        let invoice = &mut ctx.accounts.invoice;
        require!(invoice.status == InvoiceStatus::Pending, InvoiceError::InvalidStatus);
        if let Some(expected_payer) = invoice.payer {
            require_keys_eq!(
                ctx.accounts.payer.key(),
                expected_payer,
                InvoiceError::NotPayer
            );
        }
        invoice.status = InvoiceStatus::Paid;
        invoice.paid_at = Some(Clock::get()?.unix_timestamp);
        invoice.utxo_commitment = Some(utxo_commitment);
        Ok(())
    }
```

Then add the accounts struct at the bottom of the file (after `CreateInvoice`):

```rust
#[derive(Accounts)]
pub struct MarkPaid<'info> {
    #[account(mut)]
    pub invoice: Account<'info, Invoice>,
    pub payer: Signer<'info>,
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd programs/invoice-registry && anchor test
```

Expected: all 3 tests pass (create + mark_paid happy + mark_paid rejection).

- [ ] **Step 5: Commit**

```bash
cd ../.. && git add programs/invoice-registry/
git commit -m "feat(anchor): mark_paid instruction with payer authorization"
```

---

### Task 7: `cancel_invoice` + reclaim rent

**Files:**
- Modify: `programs/invoice-registry/src/lib.rs`
- Modify: `programs/invoice-registry/tests/invoice-registry.ts`

- [ ] **Step 1: Add failing test for cancel**

Append to the describe block:

```typescript
  it("allows creator to cancel a pending invoice", async () => {
    const creator = provider.wallet.publicKey;
    const nonce = randomBytes(8);
    const [pda] = invoicePda(creator, nonce);

    await program.methods
      .createInvoice(Array.from(nonce), Array.from(randomBytes(32)), "https://arweave.net/x", USDC_MINT, null)
      .accounts({ invoice: pda, creator, systemProgram: SystemProgram.programId })
      .rpc();

    await program.methods
      .cancelInvoice()
      .accounts({ invoice: pda, creator })
      .rpc();

    const invoice = await program.account.invoice.fetch(pda);
    expect(invoice.status).to.deep.equal({ cancelled: {} });
  });

  it("rejects cancel from non-creator", async () => {
    const creator = provider.wallet.publicKey;
    const nonce = randomBytes(8);
    const [pda] = invoicePda(creator, nonce);

    await program.methods
      .createInvoice(Array.from(nonce), Array.from(randomBytes(32)), "https://arweave.net/x", USDC_MINT, null)
      .accounts({ invoice: pda, creator, systemProgram: SystemProgram.programId })
      .rpc();

    const stranger = Keypair.generate();
    const ad = await provider.connection.requestAirdrop(stranger.publicKey, 1e9);
    await provider.connection.confirmTransaction(ad);

    try {
      await program.methods
        .cancelInvoice()
        .accounts({ invoice: pda, creator: stranger.publicKey })
        .signers([stranger])
        .rpc();
      expect.fail("should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.match(/NotCreator|ConstraintHasOne|ConstraintSeeds/);
    }
  });
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd programs/invoice-registry && anchor test
```

Expected: FAIL — `cancelInvoice` does not exist.

- [ ] **Step 3: Add the cancel instruction**

In `programs/invoice-registry/src/lib.rs`, add inside `pub mod invoice_registry`:

```rust
    pub fn cancel_invoice(ctx: Context<CancelInvoice>) -> Result<()> {
        let invoice = &mut ctx.accounts.invoice;
        require!(invoice.status == InvoiceStatus::Pending, InvoiceError::InvalidStatus);
        invoice.status = InvoiceStatus::Cancelled;
        Ok(())
    }
```

And add the accounts struct:

```rust
#[derive(Accounts)]
pub struct CancelInvoice<'info> {
    #[account(
        mut,
        has_one = creator @ InvoiceError::NotCreator,
    )]
    pub invoice: Account<'info, Invoice>,
    pub creator: Signer<'info>,
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd programs/invoice-registry && anchor test
```

Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
cd ../.. && git add programs/invoice-registry/
git commit -m "feat(anchor): cancel_invoice instruction"
```

---

### Task 8: Deploy to devnet + copy IDL into app

**Files:**
- Modify: `programs/invoice-registry/Anchor.toml`
- Create: `app/src/lib/invoice_registry.json` (copied IDL)
- Create: `app/src/lib/invoice_registry.ts` (copied types)

- [ ] **Step 1: Configure Anchor.toml for devnet**

Edit `programs/invoice-registry/Anchor.toml`:

```toml
[features]
seeds = false
skip-lint = false

[programs.devnet]
invoice_registry = "<will be replaced in step 2>"

[registry]
url = "https://api.apr.dev"

[provider]
cluster = "devnet"
wallet = "~/.config/solana/id.json"

[scripts]
test = "yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/**/*.ts"
```

- [ ] **Step 2: Generate program keypair and sync**

```bash
cd programs/invoice-registry
anchor keys list          # note the current program id
anchor keys sync          # writes it into lib.rs declare_id! and Anchor.toml
anchor build
```

Expected: program ID is now consistent between `lib.rs` and `Anchor.toml`. Record the ID — you'll need it in `app/src/lib/constants.ts` later.

- [ ] **Step 3: Deploy to devnet**

Ensure your Solana CLI wallet has some devnet SOL:

```bash
solana airdrop 2 --url https://api.devnet.solana.com
```

Then deploy:

```bash
cd programs/invoice-registry && anchor deploy --provider.cluster devnet
```

Expected: deploy succeeds, prints the program ID. If it fails with "insufficient funds", airdrop more SOL.

- [ ] **Step 4: Copy IDL and TypeScript types into the app**

```bash
mkdir -p app/src/lib
cp programs/invoice-registry/target/idl/invoice_registry.json app/src/lib/invoice_registry.json
cp programs/invoice-registry/target/types/invoice_registry.ts app/src/lib/invoice_registry.ts
```

- [ ] **Step 5: Commit**

```bash
git add programs/invoice-registry/Anchor.toml programs/invoice-registry/src/lib.rs app/src/lib/invoice_registry.json app/src/lib/invoice_registry.ts
git commit -m "feat(anchor): deploy to devnet, copy IDL into app"
```

---

## Phase 2 — Next.js scaffold, wallet, routing

### Task 9: Next.js 14 initialization

**Files:**
- Create: `app/next.config.mjs`
- Create: `app/tsconfig.json`
- Create: `app/tailwind.config.ts`
- Create: `app/postcss.config.mjs`
- Create: `app/src/app/layout.tsx`
- Create: `app/src/app/globals.css`
- Create: `app/src/app/page.tsx`
- Modify: `app/package.json`

- [ ] **Step 1: Add Next.js + React + Tailwind deps to `app/package.json`**

Replace `app/package.json` with (keep Umbra versions you pinned in Task 3):

```json
{
  "name": "veil-app",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@umbra-privacy/sdk": "PINNED",
    "@umbra-privacy/web-zk-prover": "PINNED",
    "next": "14.2.0",
    "react": "18.3.0",
    "react-dom": "18.3.0",
    "@coral-xyz/anchor": "0.30.1",
    "@solana/web3.js": "1.95.0",
    "@solana/wallet-adapter-base": "0.9.23",
    "@solana/wallet-adapter-react": "0.15.35",
    "@solana/wallet-adapter-react-ui": "0.9.35",
    "@solana/wallet-adapter-wallets": "0.19.32"
  },
  "devDependencies": {
    "@types/node": "20.0.0",
    "@types/react": "18.3.0",
    "@types/react-dom": "18.3.0",
    "autoprefixer": "10.4.0",
    "postcss": "8.4.0",
    "tailwindcss": "3.4.0",
    "typescript": "5.4.0",
    "vitest": "1.6.0",
    "@vitest/ui": "1.6.0"
  }
}
```

Replace `"PINNED"` with the actual pinned versions from Task 3.

- [ ] **Step 2: Install**

```bash
cd app && npm install
```

- [ ] **Step 3: Write `next.config.mjs`**

Create `app/next.config.mjs`:

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config) => {
    config.experiments = { ...config.experiments, asyncWebAssembly: true, topLevelAwait: true };
    config.resolve.fallback = { ...config.resolve.fallback, fs: false, crypto: false };
    return config;
  },
};
export default nextConfig;
```

- [ ] **Step 4: Write `tsconfig.json`**

Create `app/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["next-env.d.ts", "src/**/*.ts", "src/**/*.tsx", ".next/types/**/*.ts", "tests/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 5: Write `tailwind.config.ts` and `postcss.config.mjs`**

Create `app/tailwind.config.ts`:

```typescript
import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: { extend: {} },
  plugins: [],
};
export default config;
```

Create `app/postcss.config.mjs`:

```javascript
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

- [ ] **Step 6: Write layout, globals.css, and landing page**

Create `app/src/app/globals.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  background-color: #0b0f19;
  color: #e5e7eb;
}
```

Create `app/src/app/layout.tsx`:

```tsx
import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Veil — Private Invoicing on Solana",
  description: "Business-grade privacy for Solana payments.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

Create `app/src/app/page.tsx`:

```tsx
export default function LandingPage() {
  return (
    <main className="min-h-screen flex items-center justify-center p-8">
      <div className="max-w-2xl text-center">
        <h1 className="text-5xl font-bold mb-4">Veil</h1>
        <p className="text-xl text-gray-400 mb-8">Private invoicing on Solana</p>
        <div className="flex gap-4 justify-center">
          <a href="/create" className="px-6 py-3 bg-indigo-600 rounded-lg hover:bg-indigo-700">
            Create Invoice
          </a>
          <a href="/dashboard" className="px-6 py-3 border border-gray-600 rounded-lg hover:border-gray-400">
            Dashboard
          </a>
        </div>
      </div>
    </main>
  );
}
```

- [ ] **Step 7: Run dev server and verify**

```bash
cd app && npm run dev
```

Visit `http://localhost:3000`. Expected: Veil landing page renders with the two buttons. Stop the server (Ctrl+C).

- [ ] **Step 8: Commit**

```bash
cd .. && git add app/
git commit -m "feat(app): Next.js 14 scaffold with Tailwind and landing page"
```

---

### Task 10: Wallet adapter integration

**Files:**
- Create: `app/src/components/WalletProvider.tsx`
- Modify: `app/src/app/layout.tsx`
- Create: `app/src/lib/constants.ts`

- [ ] **Step 1: Create the constants module**

Create `app/src/lib/constants.ts`:

```typescript
import { PublicKey } from "@solana/web3.js";

export const NETWORK: "devnet" | "mainnet" = (process.env.NEXT_PUBLIC_SOLANA_NETWORK as any) || "devnet";
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "https://api.devnet.solana.com";
export const RPC_WSS_URL = process.env.NEXT_PUBLIC_RPC_WSS_URL || "wss://api.devnet.solana.com";

export const INVOICE_REGISTRY_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_INVOICE_REGISTRY_PROGRAM_ID || "InvReg1111111111111111111111111111111111111",
);

export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

export const UMBRA_INDEXER_API = "https://utxo-indexer.api.umbraprivacy.com";
export const UMBRA_RELAYER_API = "https://relayer.api.umbraprivacy.com";
```

**Important:** Replace the placeholder program ID in `NEXT_PUBLIC_INVOICE_REGISTRY_PROGRAM_ID` default with the actual ID you got from `anchor keys list` in Task 8. Set `NEXT_PUBLIC_INVOICE_REGISTRY_PROGRAM_ID` in `.env.local` to be explicit; the default here is just a safety net.

Create `app/.env.local`:

```
NEXT_PUBLIC_SOLANA_NETWORK=devnet
NEXT_PUBLIC_RPC_URL=https://api.devnet.solana.com
NEXT_PUBLIC_RPC_WSS_URL=wss://api.devnet.solana.com
NEXT_PUBLIC_INVOICE_REGISTRY_PROGRAM_ID=<paste your program ID from Task 8>
```

- [ ] **Step 2: Write WalletProvider component**

Create `app/src/components/WalletProvider.tsx`:

```tsx
"use client";

import { ConnectionProvider, WalletProvider as SolanaWalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import { useMemo } from "react";
import { RPC_URL } from "@/lib/constants";

import "@solana/wallet-adapter-react-ui/styles.css";

export function VeilWalletProvider({ children }: { children: React.ReactNode }) {
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    [],
  );

  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <SolanaWalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
}
```

- [ ] **Step 3: Wrap layout with the provider**

Replace `app/src/app/layout.tsx`:

```tsx
import "./globals.css";
import type { Metadata } from "next";
import { VeilWalletProvider } from "@/components/WalletProvider";

export const metadata: Metadata = {
  title: "Veil — Private Invoicing on Solana",
  description: "Business-grade privacy for Solana payments.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <VeilWalletProvider>{children}</VeilWalletProvider>
      </body>
    </html>
  );
}
```

- [ ] **Step 4: Add wallet button to landing page**

Replace `app/src/app/page.tsx`:

```tsx
"use client";

import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

export default function LandingPage() {
  return (
    <main className="min-h-screen flex items-center justify-center p-8">
      <div className="max-w-2xl text-center">
        <h1 className="text-5xl font-bold mb-4">Veil</h1>
        <p className="text-xl text-gray-400 mb-8">Private invoicing on Solana</p>
        <div className="flex gap-4 justify-center mb-6">
          <a href="/create" className="px-6 py-3 bg-indigo-600 rounded-lg hover:bg-indigo-700">
            Create Invoice
          </a>
          <a href="/dashboard" className="px-6 py-3 border border-gray-600 rounded-lg hover:border-gray-400">
            Dashboard
          </a>
        </div>
        <WalletMultiButton />
      </div>
    </main>
  );
}
```

- [ ] **Step 5: Verify**

```bash
cd app && npm run dev
```

Click the wallet button → modal opens with Phantom/Solflare options. Connect successfully. Stop the server.

- [ ] **Step 6: Commit**

```bash
cd .. && git add app/
git commit -m "feat(app): wallet adapter integration"
```

---

### Task 11: Route scaffolds for create, pay, dashboard

**Files:**
- Create: `app/src/app/create/page.tsx`
- Create: `app/src/app/pay/[id]/page.tsx`
- Create: `app/src/app/dashboard/page.tsx`

- [ ] **Step 1: Create minimal routes**

Create `app/src/app/create/page.tsx`:

```tsx
"use client";

export default function CreatePage() {
  return (
    <main className="min-h-screen p-8 max-w-2xl mx-auto">
      <h1 className="text-3xl font-bold mb-6">Create Invoice</h1>
      <p className="text-gray-400">Form goes here (Task 20)</p>
    </main>
  );
}
```

Create `app/src/app/pay/[id]/page.tsx`:

```tsx
"use client";

export default function PayPage({ params }: { params: { id: string } }) {
  return (
    <main className="min-h-screen p-8 max-w-2xl mx-auto">
      <h1 className="text-3xl font-bold mb-6">Pay Invoice</h1>
      <p className="text-gray-400">Invoice ID: {params.id}</p>
      <p className="text-gray-400">Payment view goes here (Task 21)</p>
    </main>
  );
}
```

Create `app/src/app/dashboard/page.tsx`:

```tsx
"use client";

export default function DashboardPage() {
  return (
    <main className="min-h-screen p-8 max-w-4xl mx-auto">
      <h1 className="text-3xl font-bold mb-6">Dashboard</h1>
      <p className="text-gray-400">Invoice list goes here (Task 23)</p>
    </main>
  );
}
```

- [ ] **Step 2: Verify routes work**

```bash
cd app && npm run dev
```

Visit `/create`, `/pay/test`, `/dashboard`. All three pages should render their placeholder headings. Stop the server.

- [ ] **Step 3: Commit**

```bash
cd .. && git add app/src/app/
git commit -m "feat(app): route scaffolds for create, pay, dashboard"
```

---

## Phase 3 — Metadata encryption and Arweave upload

### Task 12: AES-256-GCM encrypt/decrypt module

**Files:**
- Create: `app/src/lib/encryption.ts`
- Create: `app/tests/encryption.test.ts`

- [ ] **Step 1: Write failing test**

Create `app/tests/encryption.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { encryptJson, decryptJson, generateKey, keyToBase58, keyFromBase58 } from "@/lib/encryption";

describe("encryption", () => {
  it("round-trips a JSON payload through encrypt/decrypt with matching key", async () => {
    const payload = { invoice_id: "inv_123", total: "4500000000", note: "Thanks" };
    const key = generateKey();
    const ciphertext = await encryptJson(payload, key);
    const decrypted = await decryptJson(ciphertext, key);
    expect(decrypted).toEqual(payload);
  });

  it("fails to decrypt with a wrong key", async () => {
    const payload = { secret: "value" };
    const key = generateKey();
    const wrong = generateKey();
    const ciphertext = await encryptJson(payload, key);
    await expect(decryptJson(ciphertext, wrong)).rejects.toThrow();
  });

  it("round-trips a key through base58 encoding", () => {
    const key = generateKey();
    const encoded = keyToBase58(key);
    const decoded = keyFromBase58(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(key));
  });
});
```

- [ ] **Step 2: Add base58 dep**

```bash
cd app && npm install bs58 && cd ..
```

- [ ] **Step 3: Run test — should fail**

```bash
cd app && npx vitest run tests/encryption.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement the module**

Create `app/src/lib/encryption.ts`:

```typescript
import bs58 from "bs58";

const ALG = "AES-GCM";

export function generateKey(): Uint8Array {
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  return key;
}

export function keyToBase58(key: Uint8Array): string {
  return bs58.encode(key);
}

export function keyFromBase58(encoded: string): Uint8Array {
  const decoded = bs58.decode(encoded);
  if (decoded.length !== 32) {
    throw new Error(`Invalid key length: expected 32 bytes, got ${decoded.length}`);
  }
  return decoded;
}

async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, ALG, false, ["encrypt", "decrypt"]);
}

export async function encryptJson(payload: unknown, key: Uint8Array): Promise<Uint8Array> {
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const cryptoKey = await importKey(key);
  const ciphertext = await crypto.subtle.encrypt({ name: ALG, iv }, cryptoKey, plaintext);
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return combined;
}

export async function decryptJson(ciphertext: Uint8Array, key: Uint8Array): Promise<unknown> {
  const iv = ciphertext.slice(0, 12);
  const data = ciphertext.slice(12);
  const cryptoKey = await importKey(key);
  const plaintext = await crypto.subtle.decrypt({ name: ALG, iv }, cryptoKey, data);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hash);
}

export function extractKeyFromFragment(hash: string): Uint8Array | null {
  if (!hash || !hash.startsWith("#")) return null;
  try {
    return keyFromBase58(hash.slice(1));
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Run test — should pass**

```bash
cd app && npx vitest run tests/encryption.test.ts
```

Expected: 3 passing tests.

- [ ] **Step 6: Commit**

```bash
cd .. && git add app/
git commit -m "feat(app): AES-256-GCM encryption module for invoice metadata"
```

---

### Task 13: Arweave upload helper

**Files:**
- Create: `app/src/lib/arweave.ts`
- Create: `app/src/app/api/arweave-upload/route.ts`

We'll upload via a Next.js API route using Bundlr so we don't have to expose wallet keys client-side. The API route uses a funded Bundlr wallet from `.env.local`.

- [ ] **Step 1: Install Bundlr**

```bash
cd app && npm install @bundlr-network/client && cd ..
```

- [ ] **Step 2: Create the API route**

Create `app/src/app/api/arweave-upload/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import Bundlr from "@bundlr-network/client";

export const runtime = "nodejs"; // required for Bundlr

export async function POST(req: NextRequest) {
  const body = await req.arrayBuffer();
  const ciphertext = Buffer.from(body);

  const privateKey = process.env.BUNDLR_PRIVATE_KEY;
  if (!privateKey) {
    return NextResponse.json({ error: "Server misconfigured: BUNDLR_PRIVATE_KEY missing" }, { status: 500 });
  }

  const bundlr = new Bundlr("https://node1.bundlr.network", "solana", privateKey, {
    providerUrl: process.env.NEXT_PUBLIC_RPC_URL || "https://api.devnet.solana.com",
  });

  try {
    const tx = bundlr.createTransaction(ciphertext, {
      tags: [{ name: "Content-Type", value: "application/octet-stream" }],
    });
    await tx.sign();
    const result = await tx.upload();
    return NextResponse.json({ id: result.id, uri: `https://arweave.net/${result.id}` });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
```

- [ ] **Step 3: Create the client helper**

Create `app/src/lib/arweave.ts`:

```typescript
export async function uploadCiphertext(ciphertext: Uint8Array): Promise<{ id: string; uri: string }> {
  const res = await fetch("/api/arweave-upload", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: ciphertext,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "unknown" }));
    throw new Error(`Arweave upload failed: ${err.error}`);
  }
  return res.json();
}

export async function fetchCiphertext(uri: string): Promise<Uint8Array> {
  const res = await fetch(uri);
  if (!res.ok) {
    throw new Error(`Failed to fetch Arweave content: ${res.status}`);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}
```

- [ ] **Step 4: Document required env var**

Append to `app/.env.local`:

```
BUNDLR_PRIVATE_KEY=<base58 encoded Solana keypair with some SOL for uploads>
```

For devnet, generate a new keypair with `solana-keygen new -o bundlr-key.json --no-bip39-passphrase`, airdrop it 0.5 SOL, then paste the base58 private key.

- [ ] **Step 5: Commit**

```bash
git add app/
git commit -m "feat(app): Arweave upload via Bundlr API route"
```

---

### Task 14: Invoice metadata types and builder

**Files:**
- Create: `app/src/lib/types.ts`
- Create: `app/tests/metadata.test.ts`

- [ ] **Step 1: Write failing test**

Create `app/tests/metadata.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { buildMetadata, validateMetadata, type InvoiceMetadata } from "@/lib/types";

describe("invoice metadata", () => {
  it("builds a well-formed metadata object", () => {
    const md = buildMetadata({
      invoiceId: "inv_123",
      creatorDisplayName: "Acme",
      creatorWallet: "Alice111111111111111111111111111111111111",
      payerDisplayName: "Globex",
      payerWallet: null,
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      symbol: "USDC",
      decimals: 6,
      lineItems: [{ description: "Design", quantity: "40", unitPrice: "100000000", total: "4000000000" }],
      subtotal: "4000000000",
      tax: "0",
      total: "4000000000",
      dueDate: "2026-05-15",
      terms: "Net 30",
      notes: "Thanks",
    });

    expect(md.version).toBe(1);
    expect(md.invoice_id).toBe("inv_123");
    expect(md.line_items).toHaveLength(1);
    expect(md.total).toBe("4000000000");
  });

  it("validates a correct metadata object", () => {
    const md: InvoiceMetadata = {
      version: 1,
      invoice_id: "inv_123",
      created_at: new Date().toISOString(),
      creator: { display_name: "A", wallet: "A1", contact: null, logo_url: null },
      payer: { display_name: "B", wallet: null, contact: null },
      currency: { mint: "USDC", symbol: "USDC", decimals: 6 },
      line_items: [],
      subtotal: "0",
      tax: "0",
      total: "0",
      due_date: null,
      terms: null,
      notes: null,
    };
    expect(() => validateMetadata(md)).not.toThrow();
  });

  it("rejects metadata with mismatched totals", () => {
    const md: InvoiceMetadata = {
      version: 1,
      invoice_id: "inv_123",
      created_at: new Date().toISOString(),
      creator: { display_name: "A", wallet: "A1", contact: null, logo_url: null },
      payer: { display_name: "B", wallet: null, contact: null },
      currency: { mint: "USDC", symbol: "USDC", decimals: 6 },
      line_items: [{ description: "x", quantity: "1", unit_price: "100", total: "100" }],
      subtotal: "999", // wrong
      tax: "0",
      total: "100",
      due_date: null,
      terms: null,
      notes: null,
    };
    expect(() => validateMetadata(md)).toThrow(/subtotal/);
  });
});
```

- [ ] **Step 2: Run — should fail**

```bash
cd app && npx vitest run tests/metadata.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement types.ts**

Create `app/src/lib/types.ts`:

```typescript
export interface LineItem {
  description: string;
  quantity: string;
  unit_price: string;
  total: string;
}

export interface CreatorInfo {
  display_name: string;
  wallet: string;
  contact: string | null;
  logo_url: string | null;
}

export interface PayerInfo {
  display_name: string;
  wallet: string | null;
  contact: string | null;
}

export interface CurrencyInfo {
  mint: string;
  symbol: string;
  decimals: number;
}

export interface InvoiceMetadata {
  version: 1;
  invoice_id: string;
  created_at: string;
  creator: CreatorInfo;
  payer: PayerInfo;
  currency: CurrencyInfo;
  line_items: LineItem[];
  subtotal: string;
  tax: string;
  total: string;
  due_date: string | null;
  terms: string | null;
  notes: string | null;
}

export interface BuildMetadataArgs {
  invoiceId: string;
  creatorDisplayName: string;
  creatorWallet: string;
  creatorContact?: string | null;
  creatorLogoUrl?: string | null;
  payerDisplayName: string;
  payerWallet: string | null;
  payerContact?: string | null;
  mint: string;
  symbol: string;
  decimals: number;
  lineItems: Array<{ description: string; quantity: string; unitPrice: string; total: string }>;
  subtotal: string;
  tax: string;
  total: string;
  dueDate: string | null;
  terms: string | null;
  notes: string | null;
}

export function buildMetadata(args: BuildMetadataArgs): InvoiceMetadata {
  return {
    version: 1,
    invoice_id: args.invoiceId,
    created_at: new Date().toISOString(),
    creator: {
      display_name: args.creatorDisplayName,
      wallet: args.creatorWallet,
      contact: args.creatorContact ?? null,
      logo_url: args.creatorLogoUrl ?? null,
    },
    payer: {
      display_name: args.payerDisplayName,
      wallet: args.payerWallet,
      contact: args.payerContact ?? null,
    },
    currency: { mint: args.mint, symbol: args.symbol, decimals: args.decimals },
    line_items: args.lineItems.map((li) => ({
      description: li.description,
      quantity: li.quantity,
      unit_price: li.unitPrice,
      total: li.total,
    })),
    subtotal: args.subtotal,
    tax: args.tax,
    total: args.total,
    due_date: args.dueDate,
    terms: args.terms,
    notes: args.notes,
  };
}

export function validateMetadata(md: InvoiceMetadata): void {
  if (md.version !== 1) throw new Error("Unsupported metadata version");
  const sum = md.line_items.reduce((acc, li) => acc + BigInt(li.total), 0n);
  if (BigInt(md.subtotal) !== sum) {
    throw new Error(`subtotal ${md.subtotal} does not match sum of line items ${sum}`);
  }
  const expectedTotal = BigInt(md.subtotal) + BigInt(md.tax);
  if (BigInt(md.total) !== expectedTotal) {
    throw new Error(`total ${md.total} does not match subtotal + tax ${expectedTotal}`);
  }
}
```

- [ ] **Step 4: Run — should pass**

```bash
cd app && npx vitest run tests/metadata.test.ts
```

Expected: 3 passing tests.

- [ ] **Step 5: Commit**

```bash
cd .. && git add app/
git commit -m "feat(app): invoice metadata types and validation"
```

---

## Phase 4 — Umbra integration layer

### Task 15: Umbra client helper + registration check

**Files:**
- Create: `app/src/lib/umbra.ts`

- [ ] **Step 1: Write the module**

Create `app/src/lib/umbra.ts`:

```typescript
"use client";

import {
  getUmbraClient,
  getUserAccountQuerierFunction,
  getUserRegistrationFunction,
} from "@umbra-privacy/sdk";
import { NETWORK, RPC_URL, RPC_WSS_URL, UMBRA_INDEXER_API } from "./constants";

type UmbraClient = Awaited<ReturnType<typeof getUmbraClient>>;

let cachedClient: UmbraClient | null = null;
let cachedSignerAddress: string | null = null;

export async function getOrCreateClient(signer: any): Promise<UmbraClient> {
  if (cachedClient && cachedSignerAddress === signer.address?.toString()) {
    return cachedClient;
  }
  const client = await getUmbraClient({
    signer,
    network: NETWORK,
    rpcUrl: RPC_URL,
    rpcSubscriptionsUrl: RPC_WSS_URL,
    indexerApiEndpoint: UMBRA_INDEXER_API,
  });
  cachedClient = client;
  cachedSignerAddress = signer.address?.toString() ?? null;
  return client;
}

export function resetClient() {
  cachedClient = null;
  cachedSignerAddress = null;
}

export async function isFullyRegistered(client: UmbraClient): Promise<boolean> {
  const query = getUserAccountQuerierFunction({ client });
  const result = await query(client.signer.address);
  if (result.state !== "exists") return false;
  return (
    result.data.isUserAccountX25519KeyRegistered &&
    result.data.isUserCommitmentRegistered
  );
}

export async function ensureRegistered(
  client: UmbraClient,
  onProgress?: (step: "init" | "x25519" | "commitment", status: "pre" | "post") => void,
): Promise<void> {
  if (await isFullyRegistered(client)) return;

  const register = getUserRegistrationFunction({ client });
  await register({
    confidential: true,
    anonymous: true,
    callbacks: onProgress
      ? {
          userAccountInitialisation: {
            pre: async () => onProgress("init", "pre"),
            post: async () => onProgress("init", "post"),
          },
          registerX25519PublicKey: {
            pre: async () => onProgress("x25519", "pre"),
            post: async () => onProgress("x25519", "post"),
          },
          registerUserForAnonymousUsage: {
            pre: async () => onProgress("commitment", "pre"),
            post: async () => onProgress("commitment", "post"),
          },
        }
      : undefined,
  });
}
```

**Note:** The `signer` param type is intentionally `any` here because the wallet adapter signer shape and Umbra's expected signer shape may or may not align — confirmed in Day 1 finding §4. If a wrapper is needed, add it here.

- [ ] **Step 2: Commit**

```bash
git add app/src/lib/umbra.ts
git commit -m "feat(app): Umbra client helper with registration check"
```

---

### Task 16: Pay invoice (UTXO creation) + mark_paid Anchor call

**Files:**
- Modify: `app/src/lib/umbra.ts`
- Create: `app/src/lib/anchor.ts`

- [ ] **Step 1: Add pay function to umbra.ts**

Append to `app/src/lib/umbra.ts`:

```typescript
import {
  getPublicBalanceToReceiverClaimableUtxoCreatorFunction,
} from "@umbra-privacy/sdk";
import {
  getPublicBalanceToReceiverClaimableUtxoCreatorProver,
} from "@umbra-privacy/web-zk-prover";
import { PublicKey } from "@solana/web3.js";

export interface PayInvoiceArgs {
  client: UmbraClient;
  recipientAddress: string;   // Alice's wallet
  mint: string;               // USDC mint
  amount: bigint;             // in native units
  invoicePda: PublicKey;      // our Anchor invoice PDA (used as optionalData)
}

export interface PayInvoiceResult {
  commitment: Uint8Array;
  signature: string;
}

export async function payInvoice(args: PayInvoiceArgs): Promise<PayInvoiceResult> {
  const zkProver = getPublicBalanceToReceiverClaimableUtxoCreatorProver();
  const create = getPublicBalanceToReceiverClaimableUtxoCreatorFunction(
    { client: args.client },
    { zkProver },
  );

  const result = await create({
    destinationAddress: args.recipientAddress as any,
    mint: args.mint as any,
    amount: args.amount,
    optionalData: args.invoicePda.toBytes(),
  } as any);

  return {
    commitment: result.commitment as Uint8Array,
    signature: result.signature as string,
  };
}
```

**Note:** The `as any` casts are intentional placeholders until Day 1 finding §2 confirms the exact argument shape for `optionalData` in `CreateUtxoArgs`. After verification, tighten the types.

- [ ] **Step 2: Create the anchor.ts helper**

Create `app/src/lib/anchor.ts`:

```typescript
import { AnchorProvider, Program, web3, BN } from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import idl from "./invoice_registry.json";
import type { InvoiceRegistry } from "./invoice_registry";
import { INVOICE_REGISTRY_PROGRAM_ID, RPC_URL } from "./constants";

export function getProgram(wallet: any): Program<InvoiceRegistry> {
  const connection = new Connection(RPC_URL, "confirmed");
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  return new Program(idl as any, INVOICE_REGISTRY_PROGRAM_ID, provider);
}

export function deriveInvoicePda(creator: PublicKey, nonce: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("invoice"), creator.toBuffer(), Buffer.from(nonce)],
    INVOICE_REGISTRY_PROGRAM_ID,
  );
}

export async function createInvoiceOnChain(
  wallet: any,
  params: {
    nonce: Uint8Array;
    metadataHash: Uint8Array;
    metadataUri: string;
    mint: PublicKey;
    restrictedPayer: PublicKey | null;
    expiresAt: number | null;
  },
): Promise<PublicKey> {
  const program = getProgram(wallet);
  const [pda] = deriveInvoicePda(wallet.publicKey, params.nonce);

  const metadataHashArr = Array.from(params.metadataHash);
  const nonceArr = Array.from(params.nonce);
  const expiresAt = params.expiresAt !== null ? new BN(params.expiresAt) : null;

  if (params.restrictedPayer) {
    await program.methods
      .createInvoiceRestricted(nonceArr, metadataHashArr, params.metadataUri, params.mint, expiresAt, params.restrictedPayer)
      .accounts({ invoice: pda, creator: wallet.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
  } else {
    await program.methods
      .createInvoice(nonceArr, metadataHashArr, params.metadataUri, params.mint, expiresAt)
      .accounts({ invoice: pda, creator: wallet.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
  }

  return pda;
}

export async function markPaidOnChain(
  wallet: any,
  invoicePda: PublicKey,
  utxoCommitment: Uint8Array,
): Promise<string> {
  const program = getProgram(wallet);
  const tx = await program.methods
    .markPaid(Array.from(utxoCommitment))
    .accounts({ invoice: invoicePda, payer: wallet.publicKey })
    .rpc();
  return tx;
}

export async function fetchInvoice(wallet: any, pda: PublicKey) {
  const program = getProgram(wallet);
  return program.account.invoice.fetch(pda);
}

export async function fetchInvoicesByCreator(wallet: any, creator: PublicKey) {
  const program = getProgram(wallet);
  return program.account.invoice.all([
    { memcmp: { offset: 8 + 1, bytes: creator.toBase58() } }, // creator field starts at discriminator(8) + version(1)
  ]);
}
```

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/
git commit -m "feat(app): Umbra pay + Anchor createInvoice/markPaid helpers"
```

---

### Task 17: Scan + claim flow (Alice receives)

**Files:**
- Modify: `app/src/lib/umbra.ts`

- [ ] **Step 1: Add scan + claim functions**

Append to `app/src/lib/umbra.ts`:

```typescript
import {
  getClaimableUtxoScannerFunction,
  getReceiverClaimableUtxoToEncryptedBalanceClaimerFunction,
  getUmbraRelayer,
  getEncryptedBalanceQuerierFunction,
} from "@umbra-privacy/sdk";
import {
  getReceiverClaimableUtxoToEncryptedBalanceClaimerProver,
} from "@umbra-privacy/web-zk-prover";
import { UMBRA_RELAYER_API } from "./constants";

export async function scanClaimableUtxos(client: UmbraClient) {
  const scan = getClaimableUtxoScannerFunction({ client });
  const result = await scan(0 as any, 0 as any); // tree 0, from beginning
  return {
    received: result.received,
    publicReceived: result.publicReceived,
  };
}

export interface ClaimArgs {
  client: UmbraClient;
  utxos: any[]; // ClaimableUtxoData[]
}

export async function claimUtxos(args: ClaimArgs) {
  const zkProver = getReceiverClaimableUtxoToEncryptedBalanceClaimerProver();
  const relayer = getUmbraRelayer({ apiEndpoint: UMBRA_RELAYER_API });
  const claim = getReceiverClaimableUtxoToEncryptedBalanceClaimerFunction(
    { client: args.client },
    { zkProver, relayer },
  );
  return claim(args.utxos);
}

export async function getEncryptedBalance(
  client: UmbraClient,
  mint: string,
): Promise<bigint> {
  const query = getEncryptedBalanceQuerierFunction({ client });
  const result = await query({ mint: mint as any });
  return result as bigint;
}
```

- [ ] **Step 2: Add a helper to match UTXOs against invoice PDAs**

Continuing in `app/src/lib/umbra.ts`, append:

```typescript
export function filterUtxosByInvoicePdas(
  utxos: any[],
  pendingInvoicePdas: PublicKey[],
): any[] {
  const pdaSet = new Set(pendingInvoicePdas.map((pk) => pk.toBase58()));
  return utxos.filter((utxo) => {
    const optionalData = utxo.optionalData as Uint8Array | undefined;
    if (!optionalData || optionalData.length !== 32) return false;
    try {
      const pk = new PublicKey(optionalData);
      return pdaSet.has(pk.toBase58());
    } catch {
      return false;
    }
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/umbra.ts
git commit -m "feat(app): Umbra scan, claim, balance query, and UTXO-invoice matcher"
```

---

### Task 18: Compliance grant helper

**Files:**
- Modify: `app/src/lib/umbra.ts`

- [ ] **Step 1: Add the grant function**

Append to `app/src/lib/umbra.ts`:

```typescript
import { getComplianceGrantIssuerFunction } from "@umbra-privacy/sdk";

export interface ComplianceGrantArgs {
  client: UmbraClient;
  receiverX25519PubKey: Uint8Array;
  nonce?: Uint8Array;
}

export async function issueComplianceGrant(args: ComplianceGrantArgs) {
  const createGrant = getComplianceGrantIssuerFunction({ client: args.client });
  const nonce = args.nonce ?? crypto.getRandomValues(new Uint8Array(32));
  // exact parameter shape confirmed in Day 1 finding §10 — update if different
  return createGrant({
    receiver: args.receiverX25519PubKey as any,
    nonce: nonce as any,
  } as any);
}
```

- [ ] **Step 2: Commit**

```bash
git add app/src/lib/umbra.ts
git commit -m "feat(app): Umbra compliance grant issuance helper"
```

---

## Phase 5 — Core UI flows

### Task 19: Registration modal component

**Files:**
- Create: `app/src/components/RegistrationModal.tsx`

- [ ] **Step 1: Write the component**

Create `app/src/components/RegistrationModal.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";

export type RegistrationStep = "init" | "x25519" | "commitment";
export type StepStatus = "pending" | "in_progress" | "done";

interface Props {
  open: boolean;
  steps: Record<RegistrationStep, StepStatus>;
  onCancel?: () => void;
}

const STEP_LABELS: Record<RegistrationStep, string> = {
  init: "Creating your private account",
  x25519: "Registering your encryption key",
  commitment: "Enabling anonymous transfers",
};

export function RegistrationModal({ open, steps, onCancel }: Props) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-8 max-w-md w-full">
        <h2 className="text-2xl font-bold mb-2">Setting up your private account</h2>
        <p className="text-gray-400 mb-6 text-sm">
          One-time setup, about 10 seconds. You will be prompted to sign a message.
        </p>
        <ul className="space-y-3">
          {(["init", "x25519", "commitment"] as const).map((step) => (
            <li key={step} className="flex items-center gap-3">
              <StatusIcon status={steps[step]} />
              <span className={steps[step] === "done" ? "text-gray-500 line-through" : ""}>
                {STEP_LABELS[step]}
              </span>
            </li>
          ))}
        </ul>
        {onCancel && (
          <button
            onClick={onCancel}
            className="mt-6 text-sm text-gray-500 hover:text-gray-300"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: StepStatus }) {
  if (status === "done") return <span className="text-green-500">✓</span>;
  if (status === "in_progress") return <span className="animate-spin">○</span>;
  return <span className="text-gray-600">○</span>;
}
```

- [ ] **Step 2: Commit**

```bash
git add app/src/components/RegistrationModal.tsx
git commit -m "feat(app): RegistrationModal with 3-step progress"
```

---

### Task 20: Invoice creation form

**Files:**
- Create: `app/src/components/InvoiceForm.tsx`
- Modify: `app/src/app/create/page.tsx`

- [ ] **Step 1: Build the InvoiceForm component**

Create `app/src/components/InvoiceForm.tsx`:

```tsx
"use client";

import { useState } from "react";

export interface InvoiceFormValues {
  creatorDisplayName: string;
  payerDisplayName: string;
  payerWallet: string;
  lineItems: Array<{ description: string; quantity: string; unitPrice: string }>;
  notes: string;
  dueDate: string;
}

interface Props {
  onSubmit: (values: InvoiceFormValues) => Promise<void>;
  submitting: boolean;
}

export function InvoiceForm({ onSubmit, submitting }: Props) {
  const [values, setValues] = useState<InvoiceFormValues>({
    creatorDisplayName: "",
    payerDisplayName: "",
    payerWallet: "",
    lineItems: [{ description: "", quantity: "1", unitPrice: "" }],
    notes: "",
    dueDate: "",
  });

  function addLineItem() {
    setValues((v) => ({ ...v, lineItems: [...v.lineItems, { description: "", quantity: "1", unitPrice: "" }] }));
  }

  function updateLineItem(idx: number, field: "description" | "quantity" | "unitPrice", value: string) {
    setValues((v) => ({
      ...v,
      lineItems: v.lineItems.map((li, i) => (i === idx ? { ...li, [field]: value } : li)),
    }));
  }

  function removeLineItem(idx: number) {
    setValues((v) => ({ ...v, lineItems: v.lineItems.filter((_, i) => i !== idx) }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await onSubmit(values);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div>
        <label className="block text-sm font-medium mb-1">Your name or business</label>
        <input
          value={values.creatorDisplayName}
          onChange={(e) => setValues({ ...values, creatorDisplayName: e.target.value })}
          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded"
          required
        />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">Payer display name</label>
        <input
          value={values.payerDisplayName}
          onChange={(e) => setValues({ ...values, payerDisplayName: e.target.value })}
          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded"
          required
        />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">
          Payer wallet <span className="text-gray-500">(optional — leave empty for share-by-link)</span>
        </label>
        <input
          value={values.payerWallet}
          onChange={(e) => setValues({ ...values, payerWallet: e.target.value })}
          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded"
          placeholder="Globex wallet address"
        />
      </div>
      <div>
        <label className="block text-sm font-medium mb-2">Line items</label>
        {values.lineItems.map((li, idx) => (
          <div key={idx} className="flex gap-2 mb-2">
            <input
              value={li.description}
              onChange={(e) => updateLineItem(idx, "description", e.target.value)}
              placeholder="Description"
              className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded"
              required
            />
            <input
              value={li.quantity}
              onChange={(e) => updateLineItem(idx, "quantity", e.target.value)}
              placeholder="Qty"
              className="w-20 px-3 py-2 bg-gray-800 border border-gray-700 rounded"
              required
            />
            <input
              value={li.unitPrice}
              onChange={(e) => updateLineItem(idx, "unitPrice", e.target.value)}
              placeholder="Unit price (USDC)"
              className="w-32 px-3 py-2 bg-gray-800 border border-gray-700 rounded"
              required
            />
            {values.lineItems.length > 1 && (
              <button
                type="button"
                onClick={() => removeLineItem(idx)}
                className="px-3 text-red-400 hover:text-red-300"
              >
                ✕
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={addLineItem}
          className="text-sm text-indigo-400 hover:text-indigo-300"
        >
          + Add line item
        </button>
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">Notes</label>
        <textarea
          value={values.notes}
          onChange={(e) => setValues({ ...values, notes: e.target.value })}
          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded"
          rows={3}
        />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">Due date</label>
        <input
          type="date"
          value={values.dueDate}
          onChange={(e) => setValues({ ...values, dueDate: e.target.value })}
          className="px-3 py-2 bg-gray-800 border border-gray-700 rounded"
        />
      </div>
      <button
        type="submit"
        disabled={submitting}
        className="w-full px-6 py-3 bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
      >
        {submitting ? "Creating..." : "Create Private Invoice"}
      </button>
    </form>
  );
}
```

- [ ] **Step 2: Wire the form into the create page**

Replace `app/src/app/create/page.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import { InvoiceForm, type InvoiceFormValues } from "@/components/InvoiceForm";
import { RegistrationModal, type RegistrationStep, type StepStatus } from "@/components/RegistrationModal";
import { getOrCreateClient, ensureRegistered } from "@/lib/umbra";
import { createInvoiceOnChain } from "@/lib/anchor";
import { buildMetadata, validateMetadata } from "@/lib/types";
import { encryptJson, generateKey, keyToBase58, sha256 } from "@/lib/encryption";
import { uploadCiphertext } from "@/lib/arweave";
import { USDC_MINT } from "@/lib/constants";

export default function CreatePage() {
  const wallet = useWallet();
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [regOpen, setRegOpen] = useState(false);
  const [regSteps, setRegSteps] = useState<Record<RegistrationStep, StepStatus>>({
    init: "pending",
    x25519: "pending",
    commitment: "pending",
  });

  async function handleSubmit(values: InvoiceFormValues) {
    if (!wallet.publicKey || !wallet.signMessage) {
      setError("Connect wallet first");
      return;
    }
    setSubmitting(true);
    setError(null);

    try {
      // 1. Ensure registered
      const client = await getOrCreateClient(wallet as any);
      setRegOpen(true);
      await ensureRegistered(client, (step, status) => {
        setRegSteps((prev) => ({
          ...prev,
          [step]: status === "pre" ? "in_progress" : "done",
        }));
      });
      setRegOpen(false);

      // 2. Build + validate metadata
      const invoiceId = `inv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const subtotal = values.lineItems.reduce(
        (sum, li) => sum + BigInt(li.unitPrice) * BigInt(li.quantity),
        0n,
      );

      const md = buildMetadata({
        invoiceId,
        creatorDisplayName: values.creatorDisplayName,
        creatorWallet: wallet.publicKey.toBase58(),
        payerDisplayName: values.payerDisplayName,
        payerWallet: values.payerWallet || null,
        mint: USDC_MINT.toBase58(),
        symbol: "USDC",
        decimals: 6,
        lineItems: values.lineItems.map((li) => ({
          description: li.description,
          quantity: li.quantity,
          unitPrice: li.unitPrice,
          total: (BigInt(li.unitPrice) * BigInt(li.quantity)).toString(),
        })),
        subtotal: subtotal.toString(),
        tax: "0",
        total: subtotal.toString(),
        dueDate: values.dueDate || null,
        terms: null,
        notes: values.notes || null,
      });
      validateMetadata(md);

      // 3. Encrypt + upload
      const key = generateKey();
      const ciphertext = await encryptJson(md, key);
      const { uri } = await uploadCiphertext(ciphertext);
      const hash = await sha256(ciphertext);

      // 4. Anchor create_invoice
      const nonce = crypto.getRandomValues(new Uint8Array(8));
      const restrictedPayer = values.payerWallet ? new PublicKey(values.payerWallet) : null;
      const pda = await createInvoiceOnChain(wallet as any, {
        nonce,
        metadataHash: hash,
        metadataUri: uri,
        mint: USDC_MINT,
        restrictedPayer,
        expiresAt: null,
      });

      // 5. Build shareable URL
      const url = `${window.location.origin}/pay/${pda.toBase58()}#${keyToBase58(key)}`;
      setResult({ url });
    } catch (err: any) {
      setError(err.message ?? String(err));
      setRegOpen(false);
    } finally {
      setSubmitting(false);
    }
  }

  if (!wallet.connected) {
    return (
      <main className="min-h-screen p-8 max-w-2xl mx-auto">
        <h1 className="text-3xl font-bold mb-6">Create Invoice</h1>
        <p className="mb-4">Connect your wallet to continue.</p>
        <WalletMultiButton />
      </main>
    );
  }

  if (result) {
    return (
      <main className="min-h-screen p-8 max-w-2xl mx-auto">
        <h1 className="text-3xl font-bold mb-6">✓ Invoice Created</h1>
        <p className="mb-4">Share this link with the payer:</p>
        <div className="bg-gray-800 p-4 rounded break-all mb-4 font-mono text-sm">{result.url}</div>
        <button
          onClick={() => navigator.clipboard.writeText(result.url)}
          className="px-4 py-2 bg-indigo-600 rounded hover:bg-indigo-700"
        >
          Copy link
        </button>
      </main>
    );
  }

  return (
    <main className="min-h-screen p-8 max-w-2xl mx-auto">
      <h1 className="text-3xl font-bold mb-6">Create Invoice</h1>
      {error && (
        <div className="bg-red-900/30 border border-red-700 p-3 rounded mb-4 text-red-200">{error}</div>
      )}
      <InvoiceForm onSubmit={handleSubmit} submitting={submitting} />
      <RegistrationModal open={regOpen} steps={regSteps} />
    </main>
  );
}
```

- [ ] **Step 3: Verify compile**

```bash
cd app && npm run build
```

Expected: builds without TypeScript errors. If errors, fix them in place before committing.

- [ ] **Step 4: Commit**

```bash
cd .. && git add app/
git commit -m "feat(app): invoice creation flow end-to-end"
```

---

### Task 21: Invoice payment page (decrypt + verify + render)

**Files:**
- Create: `app/src/components/InvoiceView.tsx`
- Modify: `app/src/app/pay/[id]/page.tsx`

- [ ] **Step 1: Write the view component**

Create `app/src/components/InvoiceView.tsx`:

```tsx
"use client";

import type { InvoiceMetadata } from "@/lib/types";

export function InvoiceView({ metadata }: { metadata: InvoiceMetadata }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
      <div className="flex justify-between mb-6">
        <div>
          <div className="text-sm text-gray-500">FROM</div>
          <div className="font-bold">{metadata.creator.display_name}</div>
          {metadata.creator.contact && <div className="text-sm text-gray-400">{metadata.creator.contact}</div>}
        </div>
        <div className="text-right">
          <div className="text-sm text-gray-500">INVOICE</div>
          <div className="font-mono text-sm">{metadata.invoice_id}</div>
          <div className="text-xs text-gray-500 mt-1">{new Date(metadata.created_at).toLocaleDateString()}</div>
        </div>
      </div>

      <div className="mb-6">
        <div className="text-sm text-gray-500">BILL TO</div>
        <div className="font-bold">{metadata.payer.display_name}</div>
      </div>

      <table className="w-full mb-6">
        <thead>
          <tr className="border-b border-gray-800 text-left text-sm text-gray-500">
            <th className="pb-2">Description</th>
            <th className="pb-2 text-right">Qty</th>
            <th className="pb-2 text-right">Unit Price</th>
            <th className="pb-2 text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {metadata.line_items.map((li, i) => (
            <tr key={i} className="border-b border-gray-800/50">
              <td className="py-2">{li.description}</td>
              <td className="py-2 text-right">{li.quantity}</td>
              <td className="py-2 text-right font-mono">{formatAmount(li.unit_price, metadata.currency.decimals)}</td>
              <td className="py-2 text-right font-mono">{formatAmount(li.total, metadata.currency.decimals)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex justify-between items-center pt-4 border-t border-gray-800">
        <div className="text-gray-500">Total</div>
        <div className="text-2xl font-bold font-mono">
          {formatAmount(metadata.total, metadata.currency.decimals)} {metadata.currency.symbol}
        </div>
      </div>

      {metadata.notes && (
        <div className="mt-6 text-sm text-gray-400 italic">{metadata.notes}</div>
      )}
    </div>
  );
}

function formatAmount(units: string, decimals: number): string {
  const bn = BigInt(units);
  const divisor = BigInt(10 ** decimals);
  const whole = bn / divisor;
  const fraction = bn % divisor;
  return `${whole}.${fraction.toString().padStart(decimals, "0").slice(0, 2)}`;
}
```

- [ ] **Step 2: Wire up the pay page — decrypt + render only (pay handler comes in Task 22)**

Replace `app/src/app/pay/[id]/page.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import { InvoiceView } from "@/components/InvoiceView";
import { decryptJson, sha256, extractKeyFromFragment } from "@/lib/encryption";
import { fetchCiphertext } from "@/lib/arweave";
import { fetchInvoice } from "@/lib/anchor";
import type { InvoiceMetadata } from "@/lib/types";

export default function PayPage({ params }: { params: { id: string } }) {
  const wallet = useWallet();
  const [metadata, setMetadata] = useState<InvoiceMetadata | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const key = extractKeyFromFragment(window.location.hash);
        if (!key) {
          setError("This invoice link is incomplete. The decryption key is missing.");
          return;
        }

        // Fetch on-chain record (uses read-only provider via connected wallet or stub)
        if (!wallet.publicKey) {
          // We need any wallet to construct a provider; use a dummy read-only
          // approach: create a minimal connection and skip wallet-dependent fetches.
          // For now, require wallet to be connected to read.
          setError("Connect wallet to load invoice");
          return;
        }

        const invoicePda = new PublicKey(params.id);
        const invoice = await fetchInvoice(wallet as any, invoicePda);

        if ("paid" in (invoice.status as any)) {
          setError("This invoice has already been paid.");
          return;
        }
        if ("cancelled" in (invoice.status as any)) {
          setError("This invoice has been cancelled.");
          return;
        }

        const ciphertext = await fetchCiphertext(invoice.metadataUri);
        const computedHash = await sha256(ciphertext);
        const onChainHash = new Uint8Array(invoice.metadataHash as any);
        const hashMatches = computedHash.every((byte, i) => byte === onChainHash[i]);
        if (!hashMatches) {
          setError("This invoice has been tampered with. Do NOT pay.");
          return;
        }

        const md = (await decryptJson(ciphertext, key)) as InvoiceMetadata;
        setMetadata(md);
      } catch (err: any) {
        setError(err.message ?? String(err));
      }
    })();
  }, [params.id, wallet.publicKey]);

  if (error) {
    return (
      <main className="min-h-screen p-8 max-w-2xl mx-auto">
        <div className="bg-red-900/30 border border-red-700 p-4 rounded">{error}</div>
      </main>
    );
  }

  if (!wallet.connected) {
    return (
      <main className="min-h-screen p-8 max-w-2xl mx-auto">
        <h1 className="text-3xl font-bold mb-6">Pay Invoice</h1>
        <p className="mb-4">Connect your wallet to view and pay this invoice.</p>
        <WalletMultiButton />
      </main>
    );
  }

  if (!metadata) {
    return (
      <main className="min-h-screen p-8 max-w-2xl mx-auto">
        <p className="text-gray-400">Loading invoice...</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen p-8 max-w-2xl mx-auto">
      <InvoiceView metadata={metadata} />
      <div className="mt-6">
        <button
          disabled
          className="w-full px-6 py-3 bg-indigo-600 rounded-lg disabled:opacity-50"
        >
          Pay (enabled in Task 22)
        </button>
      </div>
      {status && <div className="mt-4 text-gray-400">{status}</div>}
    </main>
  );
}
```

- [ ] **Step 3: Verify compile**

```bash
cd app && npm run build
```

- [ ] **Step 4: Commit**

```bash
cd .. && git add app/
git commit -m "feat(app): invoice payment page renders decrypted metadata"
```

---

### Task 22: Wire up payment execution

**Files:**
- Modify: `app/src/app/pay/[id]/page.tsx`

- [ ] **Step 1: Add the pay handler**

Replace the "Pay (enabled in Task 22)" section of `app/src/app/pay/[id]/page.tsx` with a working button. Add these imports at the top:

```typescript
import { RegistrationModal, type RegistrationStep, type StepStatus } from "@/components/RegistrationModal";
import { getOrCreateClient, ensureRegistered, payInvoice } from "@/lib/umbra";
import { markPaidOnChain } from "@/lib/anchor";
import { USDC_MINT } from "@/lib/constants";
```

Inside the component, add state for registration modal + pay state:

```typescript
const [paying, setPaying] = useState(false);
const [regOpen, setRegOpen] = useState(false);
const [regSteps, setRegSteps] = useState<Record<RegistrationStep, StepStatus>>({
  init: "pending",
  x25519: "pending",
  commitment: "pending",
});
const [paid, setPaid] = useState(false);
```

Add the handler:

```typescript
async function handlePay() {
  if (!metadata || !wallet.publicKey) return;
  setPaying(true);
  setError(null);
  try {
    const client = await getOrCreateClient(wallet as any);
    setRegOpen(true);
    await ensureRegistered(client, (step, st) =>
      setRegSteps((p) => ({ ...p, [step]: st === "pre" ? "in_progress" : "done" })),
    );
    setRegOpen(false);

    const invoicePda = new PublicKey(params.id);
    const { commitment } = await payInvoice({
      client,
      recipientAddress: metadata.creator.wallet,
      mint: USDC_MINT.toBase58(),
      amount: BigInt(metadata.total),
      invoicePda,
    });

    await markPaidOnChain(wallet as any, invoicePda, commitment);
    setPaid(true);
  } catch (err: any) {
    setError(err.message ?? String(err));
    setRegOpen(false);
  } finally {
    setPaying(false);
  }
}
```

Replace the button JSX:

```tsx
{paid ? (
  <div className="mt-6 bg-green-900/30 border border-green-700 p-4 rounded">
    ✓ Payment sent. The recipient will receive this when they open their dashboard.
  </div>
) : (
  <div className="mt-6">
    <button
      onClick={handlePay}
      disabled={paying}
      className="w-full px-6 py-3 bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
    >
      {paying ? "Processing..." : `Pay ${BigInt(metadata.total) / 1_000_000n} USDC`}
    </button>
  </div>
)}
<RegistrationModal open={regOpen} steps={regSteps} />
```

- [ ] **Step 2: Verify compile**

```bash
cd app && npm run build
```

- [ ] **Step 3: Commit**

```bash
cd .. && git add app/
git commit -m "feat(app): wire up payment execution with registration + UTXO + mark_paid"
```

---

### Task 23: Dashboard with invoice list and auto-claim

**Files:**
- Create: `app/src/components/DashboardList.tsx`
- Modify: `app/src/app/dashboard/page.tsx`

- [ ] **Step 1: Write DashboardList component**

Create `app/src/components/DashboardList.tsx`:

```tsx
"use client";

interface DashboardInvoice {
  pda: string;
  creator: string;
  metadataUri: string;
  status: "Pending" | "Paid" | "Cancelled" | "Expired";
  createdAt: number;
}

export function DashboardList({
  title,
  invoices,
}: {
  title: string;
  invoices: DashboardInvoice[];
}) {
  if (invoices.length === 0) {
    return (
      <div className="mb-8">
        <h2 className="text-xl font-semibold mb-3">{title}</h2>
        <p className="text-gray-500 text-sm">No invoices yet.</p>
      </div>
    );
  }
  return (
    <div className="mb-8">
      <h2 className="text-xl font-semibold mb-3">{title}</h2>
      <div className="space-y-2">
        {invoices.map((inv) => (
          <div
            key={inv.pda}
            className="bg-gray-900 border border-gray-800 rounded p-4 flex justify-between items-center"
          >
            <div className="font-mono text-sm text-gray-400">{inv.pda.slice(0, 8)}...</div>
            <StatusBadge status={inv.status} />
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    Pending: "bg-yellow-900 text-yellow-300",
    Paid: "bg-green-900 text-green-300",
    Cancelled: "bg-gray-800 text-gray-400",
    Expired: "bg-red-900 text-red-300",
  };
  return (
    <span className={`px-2 py-1 rounded text-xs ${colors[status] ?? ""}`}>{status}</span>
  );
}
```

- [ ] **Step 2: Wire up dashboard page with fetch + auto-claim**

Replace `app/src/app/dashboard/page.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { DashboardList } from "@/components/DashboardList";
import { fetchInvoicesByCreator } from "@/lib/anchor";
import {
  getOrCreateClient,
  isFullyRegistered,
  scanClaimableUtxos,
  claimUtxos,
  filterUtxosByInvoicePdas,
  getEncryptedBalance,
} from "@/lib/umbra";
import { USDC_MINT } from "@/lib/constants";
import { PublicKey } from "@solana/web3.js";

export default function DashboardPage() {
  const wallet = useWallet();
  const [invoices, setInvoices] = useState<any[]>([]);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    if (!wallet.publicKey) return;
    setLoading(true);
    setError(null);
    try {
      // Fetch all invoices where this wallet is the creator
      const all = await fetchInvoicesByCreator(wallet as any, wallet.publicKey);
      setInvoices(all.map((a) => ({ pda: a.publicKey, account: a.account })));

      // If registered, scan and auto-claim any received UTXOs matching our paid invoices
      const client = await getOrCreateClient(wallet as any);
      if (await isFullyRegistered(client)) {
        const pending = all
          .filter((a) => "pending" in (a.account.status as any))
          .map((a) => a.publicKey);
        if (pending.length > 0) {
          const scan = await scanClaimableUtxos(client);
          const matched = filterUtxosByInvoicePdas(scan.publicReceived, pending);
          if (matched.length > 0) {
            await claimUtxos({ client, utxos: matched });
          }
        }

        const bal = await getEncryptedBalance(client, USDC_MINT.toBase58());
        setBalance(bal);
      }
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30000);
    return () => clearInterval(interval);
  }, [wallet.publicKey]);

  if (!wallet.connected) {
    return (
      <main className="min-h-screen p-8 max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold mb-6">Dashboard</h1>
        <p className="mb-4">Connect your wallet to see your invoices.</p>
        <WalletMultiButton />
      </main>
    );
  }

  const incoming = invoices.map((i) => ({
    pda: i.pda.toBase58(),
    creator: i.account.creator.toBase58(),
    metadataUri: i.account.metadataUri,
    status: Object.keys(i.account.status)[0] as any,
    createdAt: Number(i.account.createdAt),
  }));

  return (
    <main className="min-h-screen p-8 max-w-4xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <button
          onClick={refresh}
          disabled={loading}
          className="px-4 py-2 bg-gray-800 rounded hover:bg-gray-700 disabled:opacity-50"
        >
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {balance !== null && (
        <div className="mb-6 bg-gray-900 border border-gray-800 rounded p-4">
          <div className="text-sm text-gray-500">Private USDC balance</div>
          <div className="text-2xl font-mono">{(Number(balance) / 1e6).toFixed(2)} USDC</div>
        </div>
      )}

      {error && (
        <div className="bg-red-900/30 border border-red-700 p-3 rounded mb-4 text-red-200">
          {error}
        </div>
      )}

      <DashboardList title="Invoices I created" invoices={incoming} />

      <div className="mt-6">
        <a
          href="/dashboard/compliance"
          className="text-indigo-400 hover:text-indigo-300"
        >
          → Manage compliance grants
        </a>
      </div>
    </main>
  );
}
```

- [ ] **Step 3: Verify compile**

```bash
cd app && npm run build
```

- [ ] **Step 4: Commit**

```bash
cd .. && git add app/
git commit -m "feat(app): dashboard with invoice list, auto-claim, and balance display"
```

---

### Task 24: Compliance grant UI

**Files:**
- Create: `app/src/components/ComplianceGrantForm.tsx`
- Create: `app/src/app/dashboard/compliance/page.tsx`

- [ ] **Step 1: Build the form**

Create `app/src/components/ComplianceGrantForm.tsx`:

```tsx
"use client";

import { useState } from "react";

interface Props {
  onSubmit: (receiverX25519: string) => Promise<void>;
  submitting: boolean;
}

export function ComplianceGrantForm({ onSubmit, submitting }: Props) {
  const [receiver, setReceiver] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await onSubmit(receiver);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium mb-1">Auditor X25519 public key</label>
        <input
          value={receiver}
          onChange={(e) => setReceiver(e.target.value)}
          placeholder="base58 encoded X25519 public key"
          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded font-mono text-sm"
          required
        />
        <p className="text-xs text-gray-500 mt-2">
          Ask your accountant for their X25519 key. Once the grant is created, they can decrypt
          specific transactions scoped by this nonce. <strong>Warning:</strong> the nonce creates
          permanent disclosure for everything encrypted under it, even after revocation.
        </p>
      </div>
      <button
        type="submit"
        disabled={submitting}
        className="w-full px-6 py-3 bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
      >
        {submitting ? "Creating grant..." : "Grant access"}
      </button>
    </form>
  );
}
```

- [ ] **Step 2: Build the page**

Create `app/src/app/dashboard/compliance/page.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import bs58 from "bs58";
import { ComplianceGrantForm } from "@/components/ComplianceGrantForm";
import { getOrCreateClient, ensureRegistered, issueComplianceGrant } from "@/lib/umbra";

export default function CompliancePage() {
  const wallet = useWallet();
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleGrant(receiver: string) {
    setSubmitting(true);
    setError(null);
    try {
      const client = await getOrCreateClient(wallet as any);
      await ensureRegistered(client);
      const receiverBytes = bs58.decode(receiver);
      if (receiverBytes.length !== 32) {
        throw new Error("X25519 public key must be 32 bytes");
      }
      await issueComplianceGrant({ client, receiverX25519PubKey: receiverBytes });
      setResult("Grant created successfully. Share the auditor URL with your accountant.");
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (!wallet.connected) {
    return (
      <main className="min-h-screen p-8 max-w-2xl mx-auto">
        <h1 className="text-3xl font-bold mb-6">Compliance</h1>
        <p className="mb-4">Connect wallet to manage grants.</p>
        <WalletMultiButton />
      </main>
    );
  }

  return (
    <main className="min-h-screen p-8 max-w-2xl mx-auto">
      <h1 className="text-3xl font-bold mb-6">Compliance Grants</h1>
      <p className="text-gray-400 mb-6">
        Grant read-only access to your encrypted transactions to an auditor or accountant.
      </p>
      {error && (
        <div className="bg-red-900/30 border border-red-700 p-3 rounded mb-4 text-red-200">
          {error}
        </div>
      )}
      {result && (
        <div className="bg-green-900/30 border border-green-700 p-3 rounded mb-4 text-green-200">
          {result}
        </div>
      )}
      <ComplianceGrantForm onSubmit={handleGrant} submitting={submitting} />
    </main>
  );
}
```

- [ ] **Step 3: Verify compile**

```bash
cd app && npm run build
```

- [ ] **Step 4: Commit**

```bash
cd .. && git add app/
git commit -m "feat(app): compliance grant issuance UI"
```

---

## Phase 6 — End-to-end integration + demo prep

### Task 25: Devnet E2E smoke test

**Files:**
- Create: `app/tests/e2e-devnet.md`

This is a manual test procedure. Document the exact steps so you (or a reviewer) can reproduce.

- [ ] **Step 1: Write the procedure doc**

Create `app/tests/e2e-devnet.md`:

```markdown
# E2E Devnet Smoke Test

Procedure for verifying Veil end-to-end on Solana devnet. Run before final demo recording.

## Prerequisites

- Two fresh Solana keypairs (Alice and Bob)
- Each with ~2 SOL on devnet (`solana airdrop 2 --url devnet`)
- Bob's wallet also has Umbra-supported test token (USDC if supported on devnet, else wSOL/UMBRA per Day 1 finding)
- `anchor deploy` has been run and `NEXT_PUBLIC_INVOICE_REGISTRY_PROGRAM_ID` is set to the deployed program

## Steps

### Alice creates an invoice

1. Open two browser profiles, one for Alice and one for Bob
2. In Alice's browser: `npm run dev` then visit http://localhost:3000
3. Click Create Invoice, connect Alice's wallet
4. Fill form:
   - Your name: "Alice Test"
   - Payer name: "Bob Test"
   - Payer wallet: leave empty
   - Line item: "Test service", qty 1, unit price 1000000 (= 1 USDC)
5. Click Create Private Invoice
6. Expected: RegistrationModal appears, progresses through 3 steps, closes
7. Expected: success screen with share URL. Copy the URL.

### Bob pays

8. In Bob's browser: paste the URL into the address bar
9. Expected: invoice details render, showing Alice's name and 1 USDC total
10. Connect Bob's wallet
11. Click Pay
12. Expected: RegistrationModal appears for Bob (first time), progresses through 3 steps, closes
13. Expected: payment success banner "✓ Payment sent"

### Alice claims

14. In Alice's browser: visit /dashboard
15. Expected: invoice shows as Paid within 30 seconds
16. Expected: "Private USDC balance" panel shows 1 USDC (minus fees)

### Compliance grant

17. In Alice's dashboard, click "Manage compliance grants"
18. Generate a dummy X25519 key (any 32-byte base58 string) and paste it
19. Click Grant access
20. Expected: "Grant created successfully" message

## Failure modes

- If step 7 fails: check Day 1 finding §1 (devnet token support)
- If step 12 fails: check Day 1 finding §2 (optionalData support)
- If step 15 doesn't update: check UMBRA_INDEXER_API connectivity and scan logs
- If step 16 shows 0: check Day 1 finding §7 and §4 (balance query)
```

- [ ] **Step 2: Execute the procedure at least once**

Run through the procedure end-to-end on devnet. Note any failures in the same document under a "Run log" section at the bottom with timestamps.

- [ ] **Step 3: Commit**

```bash
git add app/tests/e2e-devnet.md
git commit -m "test(app): devnet E2E smoke test procedure"
```

---

### Task 26: Demo recording checklist

**Files:**
- Create: `docs/demo-checklist.md`

- [ ] **Step 1: Write the checklist**

Create `docs/demo-checklist.md`:

```markdown
# Demo Recording Checklist

## Before recording

- [ ] All 25 previous tasks committed and pushed
- [ ] E2E devnet test (Task 25) passes cleanly
- [ ] Fresh Alice wallet with 2 SOL on mainnet
- [ ] Fresh Bob wallet with 2 SOL and 2 USDC on mainnet
- [ ] `.env.local` NEXT_PUBLIC_SOLANA_NETWORK=mainnet (temporarily, for recording only)
- [ ] Dev server running on http://localhost:3000
- [ ] Two browser profiles open, one for Alice, one for Bob
- [ ] Screen recorder ready (OBS, Loom, or similar)
- [ ] Audio check: mic recording clearly, no background noise
- [ ] Rehearsed the script at least 3 times

## Recording flow (5 minutes)

Follow spec §8 exactly:

- 0:00–0:30 — Problem hook: show a public USDC salary on explorer, narrate why it's a problem
- 0:30–0:45 — "Meet Veil"
- 0:45–1:45 — Alice creates an invoice (Flow 1)
- 1:45–2:00 — Alice copies link, pastes into email
- 2:00–3:30 — Bob pays as first-time user, including registration (Flow 2)
- 3:30–4:00 — Switch to Alice's dashboard, show auto-claim + balance update (Flow 3)
- 4:00–4:30 — Alice creates a compliance grant (Flow 4)
- 4:30–5:00 — Explorer side-by-side comparison, fin

## After recording

- [ ] Review video once end-to-end
- [ ] Check audio levels don't clip
- [ ] Upload to YouTube (unlisted) or Twitter
- [ ] Embed URL in the Superteam Earn submission form
- [ ] Also embed in the Colosseum Frontier submission
- [ ] Revert `.env.local` to devnet
- [ ] Commit any last doc changes

## Submission checklist

- [ ] Colosseum main portal submission (required for side tracks to count)
- [ ] Superteam Earn side track: Umbra — paste demo URL + repo link
- [ ] Superteam Earn side track: 100xDevs — same
- [ ] Git repo pushed to GitHub (public or private-with-access depending on track rules)
- [ ] README updated with live demo link + submission info
```

- [ ] **Step 2: Commit**

```bash
git add docs/demo-checklist.md
git commit -m "docs: demo recording and submission checklist"
```

---

## Summary of deliverables after Core MVP plan execution

- ✅ Working Anchor program (invoice-registry) deployed to devnet
- ✅ Next.js 14 frontend with wallet auth
- ✅ AES-256-GCM metadata encryption + Arweave upload
- ✅ Umbra SDK integration: registration, UTXO pay, scan, claim, balance, compliance
- ✅ Four working flows: create invoice, pay invoice, dashboard with auto-claim, compliance grant
- ✅ Devnet E2E smoke test procedure
- ✅ Demo recording checklist

**Not in this plan (defer to follow-up plan after MVP works):**
- SHOULD-HAVE: SNS pay-by-name, email notifications, multi-currency UI, privacy explainer page, mobile responsive
- COULD-HAVE: Jupiter DX swap-to-USDC, Dune analytics panel, recurring invoices, wallet-gated encryption, background sweeper worker
- Polish and animation, error UI refinement, loading states
- Final mainnet demo recording (use Task 26 checklist when ready)

**Next action after all tasks complete:** Invoke `superpowers:writing-plans` again with scope "Veil stretch features + final polish" to generate the second plan covering SHOULD + one COULD + demo recording.
