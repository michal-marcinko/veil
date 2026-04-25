# Feature D — Proof-of-Payment Receipt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Tier 1 of Feature D from `docs/wow-features.md` — a digitally-signed (ed25519, non-ZK) proof-of-payment receipt Bob can share, plus a public verifier page that confirms the invoice is marked paid on-chain without revealing the amount.

**Architecture:** After `markPaidOnChain(...)` succeeds on `/pay/[id]`, the UI builds a canonical `PaymentReceipt` JSON, asks Bob's wallet to sign its UTF-8 bytes via `signMessage`, packs `{ receipt, signature }` into a base64url blob, and hands Bob a shareable URL of the form `/receipt/<invoicePda>#<blob>`. The verifier page at `/receipt/[pda]` reads the blob from the URL fragment, verifies the ed25519 signature against `receipt.payerPubkey` using `@noble/ed25519`, then fetches the on-chain invoice (unauthenticated read via a throwaway provider) and renders a green "Valid receipt" panel iff status is `Paid` and the on-chain `utxo_commitment` is populated. Amount is never shown — that's the privacy property.

**Tech Stack:** TypeScript 5, Next.js 14 App Router, `@noble/ed25519` (new dep, async verify), `@coral-xyz/anchor` (existing), `@solana/web3.js` (existing), `bs58` (existing), Vitest for unit tests.

**Spec:** See `docs/wow-features.md` §Feature D (research points 1.3 and 1.7). Tier 2 (actual ZK circuits) is explicitly out of scope for this plan.

---

## Task 1: Install @noble/ed25519 and confirm import

**Files:**
- Modify: `app/package.json`

- [ ] **Step 1: Install the dependency**

```bash
cd app && npm install @noble/ed25519@2.1.0
```

Expected: `@noble/ed25519` appears in `app/package.json` under `dependencies` pinned at `2.1.0` (no `^` / `~`) and `app/package-lock.json` is updated.

If `2.1.0` is not available at install time, run `npm view @noble/ed25519 version` and pin the exact latest 2.x version instead. Do not accept 3.x without re-reading the README — the sync/async verify API changed between majors.

- [ ] **Step 2: Write an import smoke test**

Create `app/tests/noble-ed25519-imports.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import * as ed from "@noble/ed25519";

describe("@noble/ed25519 import smoke test", () => {
  it("exports verifyAsync, getPublicKeyAsync, signAsync", () => {
    expect(ed.verifyAsync).toBeTypeOf("function");
    expect(ed.getPublicKeyAsync).toBeTypeOf("function");
    expect(ed.signAsync).toBeTypeOf("function");
  });

  it("round-trips a sign/verify with a real key", async () => {
    const priv = ed.utils.randomPrivateKey();
    const pub = await ed.getPublicKeyAsync(priv);
    const msg = new TextEncoder().encode("hello");
    const sig = await ed.signAsync(msg, priv);
    expect(await ed.verifyAsync(sig, msg, pub)).toBe(true);
  });
});
```

- [ ] **Step 3: Run the smoke test**

```bash
cd app && npx vitest run tests/noble-ed25519-imports.test.ts
```

Expected: 2 passing tests, 0 failures.

If `verifyAsync` is undefined, the package major version is wrong. Downgrade/upgrade to a 2.x minor (the sync API `verify` was moved behind `ed.etc.sha512Sync = ...` in 2.x; the async flavour we use here has no such config need).

- [ ] **Step 4: Commit**

```bash
cd .. && git add app/package.json app/package-lock.json app/tests/noble-ed25519-imports.test.ts
git commit -m "chore(app): install @noble/ed25519 for receipt signature verify"
```

---

## Task 2: Write `lib/receipt.ts` pure module with unit tests

**Files:**
- Create: `app/src/lib/receipt.ts`
- Create: `app/src/lib/__tests__/receipt.test.ts`

Use TDD — write the failing test first, then implement until it passes.

- [ ] **Step 1: Create the `__tests__` directory**

```bash
mkdir -p app/src/lib/__tests__
```

- [ ] **Step 2: Write the failing test file**

Create `app/src/lib/__tests__/receipt.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import * as ed from "@noble/ed25519";
import bs58 from "bs58";
import {
  buildReceipt,
  encodeReceipt,
  decodeReceipt,
  verifyReceiptSignature,
  canonicalReceiptBytes,
  type PaymentReceipt,
  type SignedReceipt,
} from "../receipt";

function fakePda(): string {
  // 32 random bytes -> base58 -> a syntactically-valid PDA string.
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return bs58.encode(b);
}

function fakeSig(): string {
  // 64 random bytes -> base58 -> a syntactically-valid tx signature.
  const b = new Uint8Array(64);
  crypto.getRandomValues(b);
  return bs58.encode(b);
}

async function signWithKey(receipt: PaymentReceipt, priv: Uint8Array): Promise<SignedReceipt> {
  const msg = canonicalReceiptBytes(receipt);
  const sig = await ed.signAsync(msg, priv);
  return { receipt, signature: bs58.encode(sig) };
}

describe("receipt module", () => {
  it("buildReceipt produces a version-1 receipt with all fields", () => {
    const payerPub = fakePda();
    const invoicePda = fakePda();
    const txSig = fakeSig();
    const invoiceHash = fakePda();
    const timestamp = 1_713_650_000;

    const r = buildReceipt({
      invoicePda,
      payerPubkey: payerPub,
      markPaidTxSig: txSig,
      timestamp,
      invoiceHash,
    });

    expect(r.version).toBe(1);
    expect(r.invoicePda).toBe(invoicePda);
    expect(r.payerPubkey).toBe(payerPub);
    expect(r.markPaidTxSig).toBe(txSig);
    expect(r.timestamp).toBe(timestamp);
    expect(r.invoiceHash).toBe(invoiceHash);
  });

  it("canonicalReceiptBytes is stable across insertion order", () => {
    const a: PaymentReceipt = {
      version: 1,
      invoicePda: "A",
      payerPubkey: "B",
      markPaidTxSig: "C",
      timestamp: 1,
      invoiceHash: "D",
    };
    const b: PaymentReceipt = {
      invoiceHash: "D",
      markPaidTxSig: "C",
      timestamp: 1,
      payerPubkey: "B",
      invoicePda: "A",
      version: 1,
    };
    const aBytes = canonicalReceiptBytes(a);
    const bBytes = canonicalReceiptBytes(b);
    expect(Array.from(aBytes)).toEqual(Array.from(bBytes));
  });

  it("encodeReceipt / decodeReceipt round-trips identically", async () => {
    const priv = ed.utils.randomPrivateKey();
    const pub = await ed.getPublicKeyAsync(priv);
    const receipt = buildReceipt({
      invoicePda: fakePda(),
      payerPubkey: bs58.encode(pub),
      markPaidTxSig: fakeSig(),
      timestamp: Math.floor(Date.now() / 1000),
      invoiceHash: fakePda(),
    });
    const signed = await signWithKey(receipt, priv);

    const blob = encodeReceipt(signed);
    const decoded = decodeReceipt(blob);

    expect(decoded.receipt).toEqual(signed.receipt);
    expect(decoded.signature).toBe(signed.signature);
  });

  it("verifyReceiptSignature returns true for a receipt signed by its payerPubkey", async () => {
    const priv = ed.utils.randomPrivateKey();
    const pub = await ed.getPublicKeyAsync(priv);
    const receipt = buildReceipt({
      invoicePda: fakePda(),
      payerPubkey: bs58.encode(pub),
      markPaidTxSig: fakeSig(),
      timestamp: Math.floor(Date.now() / 1000),
      invoiceHash: fakePda(),
    });
    const signed = await signWithKey(receipt, priv);
    expect(await verifyReceiptSignature(signed)).toBe(true);
  });

  it("verifyReceiptSignature returns false when signed by a different key", async () => {
    const priv = ed.utils.randomPrivateKey();
    const pub = await ed.getPublicKeyAsync(priv);
    const attackerPriv = ed.utils.randomPrivateKey();

    const receipt = buildReceipt({
      invoicePda: fakePda(),
      payerPubkey: bs58.encode(pub), // claims to be signed by `pub`…
      markPaidTxSig: fakeSig(),
      timestamp: Math.floor(Date.now() / 1000),
      invoiceHash: fakePda(),
    });
    // …but actually signed by attackerPriv.
    const signed = await signWithKey(receipt, attackerPriv);
    expect(await verifyReceiptSignature(signed)).toBe(false);
  });

  it("verifyReceiptSignature returns false when the receipt body is tampered after signing", async () => {
    const priv = ed.utils.randomPrivateKey();
    const pub = await ed.getPublicKeyAsync(priv);
    const receipt = buildReceipt({
      invoicePda: fakePda(),
      payerPubkey: bs58.encode(pub),
      markPaidTxSig: fakeSig(),
      timestamp: 1_713_650_000,
      invoiceHash: fakePda(),
    });
    const signed = await signWithKey(receipt, priv);

    // Tamper timestamp after signing.
    const tampered: SignedReceipt = {
      receipt: { ...signed.receipt, timestamp: 9_999_999_999 },
      signature: signed.signature,
    };
    expect(await verifyReceiptSignature(tampered)).toBe(false);
  });

  it("decodeReceipt throws on malformed blob", () => {
    expect(() => decodeReceipt("!!!not-a-valid-blob!!!")).toThrow();
  });
});
```

- [ ] **Step 3: Run the failing test**

```bash
cd app && npx vitest run src/lib/__tests__/receipt.test.ts
```

Expected: vitest fails to even resolve `../receipt` because the module does not exist yet. This is the red state of TDD — proceed to implement.

- [ ] **Step 4: Implement `lib/receipt.ts`**

Create `app/src/lib/receipt.ts`:

```typescript
import * as ed from "@noble/ed25519";
import bs58 from "bs58";

export interface PaymentReceipt {
  version: 1;
  invoicePda: string;      // base58 PDA of the Invoice account
  payerPubkey: string;     // base58 of the wallet that signed markPaid
  markPaidTxSig: string;   // base58 Solana transaction signature
  timestamp: number;       // unix seconds, from Solana block time
  invoiceHash: string;     // base58 sha256(metadata_uri || metadata_hash)
}

export interface SignedReceipt {
  receipt: PaymentReceipt;
  signature: string;       // base58 of 64-byte ed25519 signature
}

/** Minimal wallet interface — matches what @solana/wallet-adapter-react exposes. */
export interface ReceiptSigner {
  publicKey: { toBase58(): string } | null;
  signMessage?: (msg: Uint8Array) => Promise<Uint8Array>;
}

/**
 * Build a receipt from its component parts. Pure — no I/O.
 */
export function buildReceipt(args: {
  invoicePda: string;
  payerPubkey: string;
  markPaidTxSig: string;
  timestamp: number;
  invoiceHash: string;
}): PaymentReceipt {
  return {
    version: 1,
    invoicePda: args.invoicePda,
    payerPubkey: args.payerPubkey,
    markPaidTxSig: args.markPaidTxSig,
    timestamp: args.timestamp,
    invoiceHash: args.invoiceHash,
  };
}

/**
 * Canonicalise the receipt into deterministic UTF-8 bytes.
 *
 * Using JSON.stringify over the object directly is unsafe because JS object
 * key order is insertion-order — a verifier that reconstructs the receipt
 * from a different source could produce a different byte sequence. Emit keys
 * in a fixed, explicit order so signer and verifier always hash the same
 * bytes.
 */
export function canonicalReceiptBytes(r: PaymentReceipt): Uint8Array {
  const ordered = {
    version: r.version,
    invoicePda: r.invoicePda,
    payerPubkey: r.payerPubkey,
    markPaidTxSig: r.markPaidTxSig,
    timestamp: r.timestamp,
    invoiceHash: r.invoiceHash,
  };
  return new TextEncoder().encode(JSON.stringify(ordered));
}

/**
 * Ask the connected wallet to sign the canonical receipt bytes.
 * Phantom's wallet-adapter signMessage returns the raw 64-byte ed25519
 * signature — we base58-encode it for transport.
 */
export async function signReceipt(
  receipt: PaymentReceipt,
  wallet: ReceiptSigner,
): Promise<SignedReceipt> {
  if (!wallet.signMessage) {
    throw new Error("Connected wallet does not support signMessage");
  }
  if (!wallet.publicKey) {
    throw new Error("Wallet is not connected");
  }
  if (wallet.publicKey.toBase58() !== receipt.payerPubkey) {
    throw new Error(
      "payerPubkey in receipt does not match connected wallet — refusing to sign",
    );
  }
  const msg = canonicalReceiptBytes(receipt);
  const sigBytes = await wallet.signMessage(msg);
  if (sigBytes.length !== 64) {
    throw new Error(`Expected 64-byte ed25519 signature, got ${sigBytes.length}`);
  }
  return { receipt, signature: bs58.encode(sigBytes) };
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Encode a SignedReceipt for URL-fragment transport.
 * Format: base64url(JSON.stringify({ receipt, signature })).
 * Base64url is chosen over base58 because receipts are ~400 bytes and
 * base64url is ~20% more compact than base58 at that size, and is URL-safe
 * without further escaping.
 */
export function encodeReceipt(signed: SignedReceipt): string {
  const json = JSON.stringify({ receipt: signed.receipt, signature: signed.signature });
  return toBase64Url(new TextEncoder().encode(json));
}

/**
 * Parse a SignedReceipt from its URL-fragment blob. Throws on malformed input.
 */
export function decodeReceipt(blob: string): SignedReceipt {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(blob);
  } catch (err) {
    throw new Error(`Receipt blob is not valid base64url: ${String(err)}`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    throw new Error(`Receipt blob is not valid JSON: ${String(err)}`);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !parsed.receipt ||
    typeof parsed.signature !== "string" ||
    parsed.receipt.version !== 1
  ) {
    throw new Error("Receipt blob is missing required fields");
  }
  return parsed as SignedReceipt;
}

/**
 * Verify the ed25519 signature of a SignedReceipt against its payerPubkey.
 * Returns false (never throws) on any verification failure, including malformed
 * pubkey or signature bytes.
 */
export async function verifyReceiptSignature(signed: SignedReceipt): Promise<boolean> {
  try {
    const pub = bs58.decode(signed.receipt.payerPubkey);
    if (pub.length !== 32) return false;
    const sig = bs58.decode(signed.signature);
    if (sig.length !== 64) return false;
    const msg = canonicalReceiptBytes(signed.receipt);
    return await ed.verifyAsync(sig, msg, pub);
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Run the tests — expect all passing**

```bash
cd app && npx vitest run src/lib/__tests__/receipt.test.ts
```

Expected output:

```
 ✓ receipt module > buildReceipt produces a version-1 receipt with all fields
 ✓ receipt module > canonicalReceiptBytes is stable across insertion order
 ✓ receipt module > encodeReceipt / decodeReceipt round-trips identically
 ✓ receipt module > verifyReceiptSignature returns true for a receipt signed by its payerPubkey
 ✓ receipt module > verifyReceiptSignature returns false when signed by a different key
 ✓ receipt module > verifyReceiptSignature returns false when the receipt body is tampered after signing
 ✓ receipt module > decodeReceipt throws on malformed blob

Test Files  1 passed (1)
     Tests  7 passed (7)
```

If any test fails: the most likely culprit is `canonicalReceiptBytes` emitting keys in the wrong order. Do not change the test — change the implementation to match. The ordered keys listed in `canonicalReceiptBytes` are load-bearing.

- [ ] **Step 6: Commit**

```bash
cd .. && git add app/src/lib/receipt.ts app/src/lib/__tests__/receipt.test.ts
git commit -m "feat(receipt): pure signed-receipt build/encode/verify module"
```

---

## Task 3: Add `fetchInvoicePublic` to `lib/anchor.ts` for unauthenticated reads

The verifier page has no connected wallet but still needs to read the on-chain invoice. Anchor's `Program` constructor needs *some* wallet shim to construct a provider, so we build a read-only provider with `publicKey: null` and stub sign functions that throw — reads don't call them, writes would.

**Files:**
- Modify: `app/src/lib/anchor.ts`

- [ ] **Step 1: Add the helper at the bottom of `app/src/lib/anchor.ts`**

Open `app/src/lib/anchor.ts` and append (after the existing `fetchInvoicesByCreator` function, before the end of file):

```typescript
/**
 * Fetch an Invoice account without requiring a connected wallet.
 * Used by the public verifier at `/receipt/[pda]`.
 *
 * Anchor's Program constructor needs a provider, and the provider needs
 * a Wallet shim. We pass one that refuses to sign so any accidental
 * write attempt will fail loudly instead of silently succeeding.
 */
export async function fetchInvoicePublic(pda: PublicKey) {
  const connection = new Connection(RPC_URL, "confirmed");
  const readOnlyWallet = {
    publicKey: PublicKey.default, // not null — AnchorProvider checks for .toBuffer()
    signTransaction: async () => {
      throw new Error("fetchInvoicePublic: read-only provider cannot sign");
    },
    signAllTransactions: async () => {
      throw new Error("fetchInvoicePublic: read-only provider cannot sign");
    },
  };
  const provider = new AnchorProvider(connection as any, readOnlyWallet as any, {
    commitment: "confirmed",
  });
  const program = new Program(idl as any, provider) as Program<InvoiceRegistry>;
  return (program.account as any).invoice.fetch(pda);
}

/**
 * Fetch the block time of a confirmed Solana transaction signature.
 * Returns unix seconds, or null if the RPC can't find the tx.
 */
export async function fetchTxBlockTime(txSig: string): Promise<number | null> {
  const connection = new Connection(RPC_URL, "confirmed");
  const decoded = bs58.decode(txSig);
  if (decoded.length !== 64) throw new Error(`Invalid tx signature length: ${decoded.length}`);
  const parsed = await connection.getTransaction(txSig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  return parsed?.blockTime ?? null;
}
```

- [ ] **Step 2: Write a unit test for the helper (mock the RPC)**

Create `app/src/lib/__tests__/anchor-public.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { fetchInvoicePublic } from "../anchor";

describe("fetchInvoicePublic", () => {
  // This is a shape-only test — it confirms the function exists and has the
  // right signature. Real fetch is exercised in the E2E smoke test (Task 6).
  it("is an async function that accepts a PublicKey", () => {
    expect(fetchInvoicePublic).toBeTypeOf("function");
    expect(fetchInvoicePublic.constructor.name).toBe("AsyncFunction");
    // Confirm it doesn't throw synchronously when called with a valid PublicKey.
    // Network call will error but only after the sync setup returns.
    const p = fetchInvoicePublic(PublicKey.default);
    expect(p).toBeInstanceOf(Promise);
    // Swallow the rejection so vitest doesn't report an unhandled promise.
    p.catch(() => {});
  });
});
```

- [ ] **Step 3: Run the test**

```bash
cd app && npx vitest run src/lib/__tests__/anchor-public.test.ts
```

Expected: 1 passing test.

If the test file can't resolve `../anchor`, the import path is wrong — verify `app/src/lib/anchor.ts` exists.

- [ ] **Step 4: Commit**

```bash
cd .. && git add app/src/lib/anchor.ts app/src/lib/__tests__/anchor-public.test.ts
git commit -m "feat(anchor): unauthenticated fetchInvoicePublic + fetchTxBlockTime helpers"
```

---

## Task 3b: Replace placeholder utxo_commitment with sha256(Umbra signature)

**Why this task exists:** The current `pay/[id]/page.tsx` writes `new Uint8Array(32)` (all zeros) as `utxo_commitment` to `mark_paid`. Task 5's receipt verifier rejects all-zero commitments as evidence that `mark_paid` was called without a real Umbra UTXO. Without this task, every legitimate receipt would fail verification with reason "Invoice is marked paid but utxo_commitment is empty."

**Approach:** After Wave 1 lands, both `payInvoice` (public-balance) and `payInvoiceFromShielded` (shielded) return objects exposing `createUtxoSignature: string` (base58-encoded 64-byte ed25519 signature). Hashing those raw bytes with SHA-256 produces a 32-byte commitment that is deterministically tied to the actual Umbra UTXO — non-forgeable, non-zero, and self-documenting via the signature.

**Files:**
- Modify: `app/src/app/pay/[id]/page.tsx`

- [ ] **Step 1: Verify bs58 import exists**

Open `app/src/app/pay/[id]/page.tsx`. If `import bs58 from "bs58";` is not already at the top, add it. (It will be added by Task 4 Step 1 anyway — confirm the line is present before continuing this task. If absent, add it now.)

The `sha256` helper is already exported from `app/src/lib/encryption.ts`. Verify the file has `import { ..., sha256, ... } from "@/lib/encryption";` near the top — it already does as of the wave-1 baseline.

- [ ] **Step 2: Read the current pay flow**

Read the `handlePay` function in `app/src/app/pay/[id]/page.tsx`. After Wave 1, it should look approximately like (exact branching may differ — read the actual file):

```typescript
const utxoCommitment = new Uint8Array(32);
const payResult = useShielded
  ? await payInvoiceFromShielded({ client, recipientAddress: metadata.creator.wallet, mint: USDC_MINT.toBase58(), amount: BigInt(metadata.total) })
  : await payInvoice({ client, recipientAddress: metadata.creator.wallet, mint: USDC_MINT.toBase58(), amount: BigInt(metadata.total) });

await markPaidOnChain(wallet as any, invoicePda, utxoCommitment);
```

If the structure differs (e.g. no `useShielded` toggle yet, or different variable name), adapt Step 3 accordingly.

- [ ] **Step 3: Replace the placeholder with a derived commitment**

Replace the `const utxoCommitment = new Uint8Array(32);` line and the `await markPaidOnChain(...)` line. The new shape:

```typescript
const payResult = useShielded
  ? await payInvoiceFromShielded({ client, recipientAddress: metadata.creator.wallet, mint: USDC_MINT.toBase58(), amount: BigInt(metadata.total) })
  : await payInvoice({ client, recipientAddress: metadata.creator.wallet, mint: USDC_MINT.toBase58(), amount: BigInt(metadata.total) });

// Derive a real 32-byte utxo_commitment from the actual Umbra UTXO signature.
// This is non-forgeable (only the signer of the real tx can produce it) and
// guarantees the receipt verifier's "non-zero commitment" check passes.
const sigBytes = bs58.decode(payResult.createUtxoSignature);
const utxoCommitment = await sha256(sigBytes);

await markPaidOnChain(wallet as any, invoicePda, utxoCommitment);
```

Keep the previous separate `await payInvoice(...)` line removed — its result is now captured in `payResult`.

- [ ] **Step 4: Run the existing test suite to confirm nothing regressed**

```bash
cd app && npm test
```

Expected: all previously-passing tests still pass. (No new tests in this task — the change is exercised end-to-end by Task 6's devnet smoke + Task 5's verifier tests.)

- [ ] **Step 5: TypeScript check**

```bash
cd app && npx tsc --noEmit
```

Expected: zero new errors.

- [ ] **Step 6: Commit**

```bash
git add app/src/app/pay/[id]/page.tsx
git commit -m "fix(pay): derive utxo_commitment from real Umbra UTXO signature"
```

---

## Task 4: Wire receipt generation into `/pay/[id]` after successful pay

**Files:**
- Modify: `app/src/app/pay/[id]/page.tsx`

- [ ] **Step 1: Add imports at the top of the file**

Open `app/src/app/pay/[id]/page.tsx`. Below the existing `import type { InvoiceMetadata } from "@/lib/types";` line, add:

```typescript
import { buildReceipt, signReceipt, encodeReceipt, type SignedReceipt } from "@/lib/receipt";
import { fetchTxBlockTime } from "@/lib/anchor";
import bs58 from "bs58";
```

- [ ] **Step 2: Add receipt state to the component**

Find the line `const [paid, setPaid] = useState(false);` near the top of `PayPage`. Immediately below it, add:

```typescript
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null);
  const [receiptBuildError, setReceiptBuildError] = useState<string | null>(null);
```

- [ ] **Step 3: Build + sign the receipt after `markPaidOnChain` succeeds**

In `handlePay`, locate these lines:

```typescript
      await markPaidOnChain(wallet as any, invoicePda, utxoCommitment);
      setPaid(true);
```

Replace them with:

```typescript
      const markPaidSig = await markPaidOnChain(wallet as any, invoicePda, utxoCommitment);

      try {
        // Hash metadata_uri concatenated with metadata_hash for tamper-evidence.
        const invoice = await fetchInvoice(wallet as any, invoicePda);
        const uriBytes = new TextEncoder().encode(invoice.metadataUri);
        const hashBytes = new Uint8Array(invoice.metadataHash as any);
        const combined = new Uint8Array(uriBytes.length + hashBytes.length);
        combined.set(uriBytes, 0);
        combined.set(hashBytes, uriBytes.length);
        const invoiceHash = await sha256(combined);

        // Solana block time — falls back to local clock if the RPC hasn't
        // indexed the tx yet (typical within ~1s of confirmation).
        const blockTime = await fetchTxBlockTime(markPaidSig);
        const timestamp = blockTime ?? Math.floor(Date.now() / 1000);

        const receipt = buildReceipt({
          invoicePda: invoicePda.toBase58(),
          payerPubkey: wallet.publicKey!.toBase58(),
          markPaidTxSig: markPaidSig,
          timestamp,
          invoiceHash: bs58.encode(invoiceHash),
        });
        const signed: SignedReceipt = await signReceipt(receipt, wallet as any);
        const blob = encodeReceipt(signed);
        const url = `${window.location.origin}/receipt/${invoicePda.toBase58()}#${blob}`;
        setReceiptUrl(url);
      } catch (err: any) {
        // Payment already landed on-chain — receipt failure is non-fatal.
        // eslint-disable-next-line no-console
        console.error("[Veil receipt] build/sign failed:", err);
        setReceiptBuildError(err.message ?? String(err));
      }

      setPaid(true);
```

Note: `markPaidOnChain` already returns the signature string (see `app/src/lib/anchor.ts:110`). We now bind it to `markPaidSig`.

- [ ] **Step 4: Replace the "Payment sent." card with one that surfaces the receipt URL**

Find the block inside the component's JSX that renders when `paid` is true — it begins `<div className="mt-8 border border-sage/40 bg-sage/5 rounded-[3px] p-5 flex items-start gap-3">` and contains "Payment sent." Replace that entire block with:

```tsx
          <div className="mt-8 border border-sage/40 bg-sage/5 rounded-[3px] p-5">
            <div className="flex items-start gap-3">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="shrink-0 mt-0.5 text-sage">
                <path d="M3 8l3.5 3.5L13 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <div className="flex-1">
                <div className="text-[14px] text-ink font-medium">Payment sent.</div>
                <div className="text-[13px] text-muted mt-1 leading-relaxed">
                  The recipient will see it when they next open their dashboard.
                </div>
              </div>
            </div>

            {receiptUrl && (
              <div className="mt-5 pt-5 border-t border-sage/30">
                <div className="text-[12px] font-mono tracking-[0.1em] uppercase text-dim mb-2">
                  Receipt URL
                </div>
                <div className="flex items-start gap-2">
                  <input
                    readOnly
                    value={receiptUrl}
                    onFocus={(e) => e.currentTarget.select()}
                    className="flex-1 text-[12px] font-mono bg-paper border border-line rounded-[2px] px-2 py-1.5 text-ink truncate"
                  />
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(receiptUrl);
                      setStatus("Receipt URL copied.");
                    }}
                    className="text-[12px] font-mono tracking-[0.05em] uppercase px-3 py-1.5 border border-line rounded-[2px] text-ink hover:bg-line/30"
                  >
                    Copy
                  </button>
                </div>
                <div className="mt-3 text-[12px] text-muted leading-relaxed">
                  Share this link to prove you paid this invoice. The amount is hidden;
                  only the fact-of-payment is verifiable.
                </div>
              </div>
            )}

            {receiptBuildError && !receiptUrl && (
              <div className="mt-4 pt-4 border-t border-sage/30 text-[12px] text-muted leading-relaxed">
                Payment confirmed, but the receipt couldn't be signed ({receiptBuildError}).
                Your invoice is still marked paid on-chain.
              </div>
            )}
          </div>
```

- [ ] **Step 5: Run the existing unit tests to confirm no regression**

```bash
cd app && npx vitest run
```

Expected: all tests pass (encryption, metadata, umbra-imports, noble-ed25519-imports, receipt, anchor-public).

If the page fails to typecheck: confirm `import bs58 from "bs58"` is present at the top, and `sha256` is already imported from `@/lib/encryption` in the existing imports block (it is — see line 10 of the original file).

- [ ] **Step 6: Boot the dev server and hand-check the page renders**

```bash
cd app && npm run dev
```

Navigate to `http://localhost:3000/pay/<any-invoice-pda>#<key>` (use any invoice you created during core-MVP E2E). Expected: the page loads without a hydration error or missing-import crash. You don't need to actually pay — just confirm the page mounts. Kill the server with Ctrl+C when done.

- [ ] **Step 7: Commit**

```bash
git add app/src/app/pay/[id]/page.tsx
git commit -m "feat(pay): build + sign + display receipt URL after markPaid succeeds"
```

---

## Task 5: Build the `/receipt/[pda]` public verifier page

**Files:**
- Create: `app/src/app/receipt/[pda]/page.tsx`

- [ ] **Step 1: Create the receipt route directory**

```bash
mkdir -p app/src/app/receipt/[pda]
```

- [ ] **Step 2: Write the verifier page**

Create `app/src/app/receipt/[pda]/page.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import {
  decodeReceipt,
  verifyReceiptSignature,
  type SignedReceipt,
} from "@/lib/receipt";
import { fetchInvoicePublic } from "@/lib/anchor";

type VerifyState =
  | { kind: "loading" }
  | { kind: "ok"; signed: SignedReceipt }
  | { kind: "error"; reason: string };

function explorerTxUrl(sig: string): string {
  // Devnet by default — a `?cluster=devnet` query string makes the link work
  // regardless of which cluster the user's Solana Explorer remembers.
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

function formatTimestamp(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function truncate(s: string, keep = 6): string {
  if (s.length <= keep * 2 + 3) return s;
  return `${s.slice(0, keep)}…${s.slice(-keep)}`;
}

export default function ReceiptPage({ params }: { params: { pda: string } }) {
  const [state, setState] = useState<VerifyState>({ kind: "loading" });

  useEffect(() => {
    (async () => {
      try {
        // 1. Parse the blob from the URL fragment.
        const hash = window.location.hash;
        if (!hash || hash.length < 2) {
          setState({ kind: "error", reason: "Receipt link is missing its signed blob (no URL fragment)." });
          return;
        }
        let signed: SignedReceipt;
        try {
          signed = decodeReceipt(hash.slice(1));
        } catch (err: any) {
          setState({ kind: "error", reason: `Malformed receipt blob: ${err.message ?? String(err)}` });
          return;
        }

        // 2. Route param must match the receipt's invoicePda.
        if (signed.receipt.invoicePda !== params.pda) {
          setState({
            kind: "error",
            reason: "Receipt is for a different invoice than the URL path claims.",
          });
          return;
        }

        // 3. Verify the ed25519 signature.
        const sigOk = await verifyReceiptSignature(signed);
        if (!sigOk) {
          setState({ kind: "error", reason: "Signature is invalid — this receipt was not signed by the claimed payer." });
          return;
        }

        // 4. Fetch the on-chain invoice (no wallet required).
        let invoice: any;
        try {
          invoice = await fetchInvoicePublic(new PublicKey(params.pda));
        } catch (err: any) {
          setState({
            kind: "error",
            reason: `Could not fetch invoice from chain: ${err.message ?? String(err)}`,
          });
          return;
        }

        // 5. Status must be Paid.
        if (!("paid" in (invoice.status as any))) {
          setState({
            kind: "error",
            reason: "Invoice on-chain status is not Paid — receipt cannot be validated.",
          });
          return;
        }

        // 6. utxo_commitment must be non-zero (i.e. mark_paid was actually called).
        const commitment = new Uint8Array(invoice.utxoCommitment as any);
        const allZero = commitment.every((b) => b === 0);
        if (allZero) {
          setState({
            kind: "error",
            reason: "Invoice is marked paid but utxo_commitment is empty.",
          });
          return;
        }

        // 7. If the invoice is restricted to a specific payer, it must match.
        if (invoice.restrictedPayer) {
          const restricted = new PublicKey(invoice.restrictedPayer).toBase58();
          if (restricted !== signed.receipt.payerPubkey) {
            setState({
              kind: "error",
              reason: "Receipt payer does not match the invoice's restricted_payer.",
            });
            return;
          }
        }

        setState({ kind: "ok", signed });
      } catch (err: any) {
        setState({ kind: "error", reason: `Unexpected error: ${err.message ?? String(err)}` });
      }
    })();
  }, [params.pda]);

  return (
    <main className="min-h-screen relative pb-32">
      <nav className="sticky top-0 z-10 backdrop-blur-sm bg-paper/80 border-b border-line">
        <div className="max-w-[1100px] mx-auto flex items-center justify-between px-6 md:px-8 py-4">
          <a href="/" className="flex items-baseline gap-3">
            <span className="font-sans font-semibold text-[17px] tracking-[-0.02em] text-ink">
              Veil
            </span>
            <span className="hidden sm:inline font-mono text-[10.5px] tracking-[0.08em] text-muted">
              — payment receipt verifier
            </span>
          </a>
        </div>
      </nav>

      <section className="max-w-[1100px] mx-auto px-6 md:px-8 pt-16 md:pt-20">
        <div className="max-w-xl mx-auto">
          {state.kind === "loading" && (
            <div className="text-[13.5px] text-muted">Verifying receipt…</div>
          )}

          {state.kind === "error" && (
            <div>
              <div className="border-l-2 border-brick pl-5 py-3">
                <div className="mono-chip text-brick mb-2">Invalid receipt</div>
                <div className="text-[14.5px] text-ink leading-relaxed">{state.reason}</div>
              </div>
              <p className="mt-6 text-[12px] font-mono tracking-[0.1em] uppercase text-dim">
                Invoice PDA · {truncate(params.pda)}
              </p>
            </div>
          )}

          {state.kind === "ok" && (
            <div>
              <span className="eyebrow">Receipt verified</span>
              <h1 className="mt-4 font-sans font-medium text-ink text-[32px] md:text-[38px] leading-[1.05] tracking-[-0.025em]">
                Valid receipt.
              </h1>
              <p className="mt-4 text-[14.5px] text-ink/70 leading-relaxed">
                This payment was confirmed on-chain. Amount verified. Not disclosed.
              </p>

              <dl className="mt-10 border-t border-line divide-y divide-line">
                <div className="py-4 grid grid-cols-[140px_1fr] gap-4">
                  <dt className="text-[12px] font-mono tracking-[0.1em] uppercase text-dim">Invoice</dt>
                  <dd className="text-[13.5px] font-mono text-ink break-all">
                    {state.signed.receipt.invoicePda}
                  </dd>
                </div>
                <div className="py-4 grid grid-cols-[140px_1fr] gap-4">
                  <dt className="text-[12px] font-mono tracking-[0.1em] uppercase text-dim">Paid by</dt>
                  <dd className="text-[13.5px] font-mono text-ink break-all">
                    {state.signed.receipt.payerPubkey}
                  </dd>
                </div>
                <div className="py-4 grid grid-cols-[140px_1fr] gap-4">
                  <dt className="text-[12px] font-mono tracking-[0.1em] uppercase text-dim">Timestamp</dt>
                  <dd className="text-[13.5px] text-ink">
                    {formatTimestamp(state.signed.receipt.timestamp)}
                  </dd>
                </div>
                <div className="py-4 grid grid-cols-[140px_1fr] gap-4">
                  <dt className="text-[12px] font-mono tracking-[0.1em] uppercase text-dim">Transaction</dt>
                  <dd className="text-[13.5px] font-mono text-ink break-all">
                    <a
                      href={explorerTxUrl(state.signed.receipt.markPaidTxSig)}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-2 hover:text-sage"
                    >
                      {truncate(state.signed.receipt.markPaidTxSig, 10)}
                    </a>
                  </dd>
                </div>
                <div className="py-4 grid grid-cols-[140px_1fr] gap-4">
                  <dt className="text-[12px] font-mono tracking-[0.1em] uppercase text-dim">Amount</dt>
                  <dd className="text-[13.5px] text-ink italic">
                    Verified on-chain · not disclosed
                  </dd>
                </div>
              </dl>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
```

- [ ] **Step 3: Boot the dev server and manually inspect the three states**

```bash
cd app && npm run dev
```

Open each URL in turn and confirm the corresponding branch renders:

1. `http://localhost:3000/receipt/<any-pda>` — no fragment → **Invalid receipt: Receipt link is missing its signed blob**.
2. `http://localhost:3000/receipt/<any-pda>#not-base64url!!!` → **Malformed receipt blob**.
3. `http://localhost:3000/receipt/<any-pda>#AAAA` (valid base64url but invalid JSON content) → **Malformed receipt blob: Receipt blob is missing required fields** (or similar).

Leave the "ok" branch for the E2E procedure in Task 6. Kill the dev server.

- [ ] **Step 4: Run all tests to confirm no regression**

```bash
cd app && npx vitest run
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
cd .. && git add app/src/app/receipt/[pda]/page.tsx
git commit -m "feat(receipt): public /receipt/[pda] verifier page"
```

---

## Task 6: Write the E2E smoke test procedure and run it on devnet

**Files:**
- Create: `app/tests/e2e-receipt.md`

- [ ] **Step 1: Write the procedure**

Create `app/tests/e2e-receipt.md`:

```markdown
# Feature D E2E Smoke Test (devnet)

Runs end-to-end through create → pay → receipt → verify. Assumes the Core MVP
E2E in `app/tests/e2e-devnet.md` has been run at least once successfully.

## Preconditions

- `.env.local` set to `NEXT_PUBLIC_SOLANA_NETWORK=devnet`
- Alice and Bob wallets each have at least 0.1 devnet SOL
- Bob's wallet has at least 1.1 devnet USDC (invoice amount + fees)
- Dev server running: `cd app && npm run dev`

## Procedure

1. In Alice's browser at `http://localhost:3000/create`, create an invoice for 1 USDC. Copy the resulting `/pay/<pda>#<key>` link.
2. Open the link in Bob's browser. Connect Bob's wallet.
3. Click "Pay 1 USDC →". Approve the registration modal steps and the payment.
4. **Expected:** the "Payment sent." card now shows a "Receipt URL" block with a copy button.
5. Click "Copy". Expected: the status text flashes "Receipt URL copied." Paste the URL somewhere visible — it should be `http://localhost:3000/receipt/<pda>#<blob>`.
6. Open the copied URL in a **fresh browser tab with NO wallet connected** (open in an incognito window if Bob's wallet is auto-injecting).
7. **Expected:** the page renders "Valid receipt." with rows for Invoice, Paid by, Timestamp, Transaction (clickable link to Solana Explorer), and Amount = "Verified on-chain · not disclosed".
8. Click the Transaction link. Expected: Solana Explorer opens to the `mark_paid` transaction and shows it as Finalized.
9. Corrupt the URL: change one character inside the `#<blob>` portion. Reload.
10. **Expected:** the page renders "Invalid receipt" with reason "Signature is invalid — this receipt was not signed by the claimed payer" (or "Malformed receipt blob" if the edit broke base64url decoding).
11. Corrupt the path instead: change one character of the PDA segment, keep the fragment intact. Reload.
12. **Expected:** the page renders "Invalid receipt" with reason "Receipt is for a different invoice than the URL path claims".

## Failure modes

- If step 4 shows no Receipt URL block but the receipt build error *does* render: `signMessage` likely isn't exposed by the wallet adapter. Confirm Phantom is the connected wallet (not a headless dev wallet) — wallet-adapter-base's SignerWalletAdapter interface declares `signMessage` as optional.
- If step 7 shows "Could not fetch invoice from chain": `NEXT_PUBLIC_RPC_URL` may be unset or the devnet RPC is rate-limited. Retry with a different RPC endpoint.
- If step 7 shows "Invoice on-chain status is not Paid": the `markPaidOnChain` tx never confirmed. Check the Solana Explorer link on the pay page.
- If step 10 shows "Valid receipt" instead of an invalid state: the canonical ordering in `canonicalReceiptBytes` is not being applied consistently between signer and verifier — reread `lib/receipt.ts` and verify both code paths go through `canonicalReceiptBytes`.

## Run log

<append dated entries here>
```

- [ ] **Step 2: Execute the procedure end-to-end**

Run through all 12 steps on devnet. Record results under "Run log" at the bottom of the file with a timestamp. If any step fails, diagnose using the failure-modes table; fix; re-run from step 1.

- [ ] **Step 3: Commit**

```bash
git add app/tests/e2e-receipt.md
git commit -m "test(receipt): devnet E2E smoke test procedure"
```

---

## Summary of deliverables after this plan

- `@noble/ed25519` installed and import-smoke-tested
- `app/src/lib/receipt.ts` — pure build / canonicalise / sign / encode / decode / verify utilities
- `app/src/lib/__tests__/receipt.test.ts` — 7 unit tests using real ed25519 keys (no mocks)
- `app/src/lib/anchor.ts` — new `fetchInvoicePublic` and `fetchTxBlockTime` helpers for unauthenticated reads
- `app/src/app/pay/[id]/page.tsx` — builds + signs a `PaymentReceipt` after `markPaidOnChain`, surfaces a shareable receipt URL with copy button
- `app/src/app/receipt/[pda]/page.tsx` — public verifier page: parses fragment blob → verifies ed25519 sig → fetches invoice on-chain → confirms Paid + utxo_commitment set + restricted_payer matches → renders "Valid receipt" panel with no amount
- `app/tests/e2e-receipt.md` — 12-step devnet smoke procedure exercising valid, tampered-blob, and wrong-path cases

## Out of scope (explicit non-goals)

- **Tier 2 ZK proof-of-payment.** Actual zero-knowledge circuits that hide Bob's wallet address from the verifier are deferred. This plan is explicitly the non-ZK signed-blob version per `docs/wow-features.md` §Feature D.
- **Persisting receipts server-side.** Receipts travel only in URL fragments. No DB, no server-side state. Bob is responsible for saving the URL.
- **Issuer-signed counter-receipt.** Alice's "I acknowledge I received" signature is not added — Bob's signature over the on-chain-verifiable `mark_paid` tx already proves settlement finality.
- **Multi-invoice / batch receipts.** One receipt per invoice. Batch aggregation is a Feature B concern, not Feature D.
