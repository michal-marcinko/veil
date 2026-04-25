# Dashboard BigInt Fix & Clickable Invoice Rows — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the "Cannot mix BigInt and other types" runtime error on the dashboard and let creators re-open their own invoices by clicking a row, using a deterministic wallet-signature-derived AES key so no server ever sees the key.

**Architecture:** Two independent cleanups share a test harness. (1) The BigInt fix is pure type hygiene at the boundaries where Anchor BNs and Umbra bigints meet JS numbers — we coerce explicitly at every return site in `lib/anchor.ts` / `lib/umbra.ts` and every arithmetic site in `dashboard/page.tsx`. (2) The clickable-rows feature replaces the random AES key in the create flow with `deriveKeyFromWalletSignature(wallet, invoiceId)` that SHA-256s the wallet's signature over a deterministic message (`"Veil invoice <invoiceId>"`), then exposes a new `/invoice/[id]` creator-only route that re-derives the same key. Bob's payer flow is untouched — Alice still shares `/pay/[pda]#<base58-key>`.

**Tech Stack:** Next.js 14 App Router, TypeScript 5, Vitest 1.6, `@testing-library/react` (new), `jsdom` (new), `@solana/wallet-adapter-react`, `@solana/web3.js`, `@coral-xyz/anchor` BN, Web Crypto `crypto.subtle.digest`.

**Spec:** `docs/wow-features.md` — this plan maps to Day 1 in the Part 3 timeline.

---

## Task 1: Install jsdom + React Testing Library

**Files:**
- Modify: `app/package.json` (devDependencies)
- Modify: `app/vitest.config.ts`

The BigInt render test needs a DOM. Vitest ships with neither jsdom nor RTL.

- [ ] **Step 1: Install the three new dev deps**

Run:

```bash
cd app && npm install -D jsdom @testing-library/react @testing-library/jest-dom
```

Expected: `app/package.json` devDependencies now contains `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`. npm install completes without errors.

- [ ] **Step 2: Switch vitest to the jsdom environment**

Replace `app/vitest.config.ts` entirely with:

```ts
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
```

- [ ] **Step 3: Create the setup file that polyfills matchers**

Create `app/tests/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 4: Verify the existing tests still pass under jsdom**

Run:

```bash
cd app && npm test
```

Expected: `tests/encryption.test.ts` (3 passing), `tests/metadata.test.ts` (3 passing), `tests/umbra-imports.test.ts` (2 passing). Total: 8 passed. No failures.

- [ ] **Step 5: Commit**

```bash
git add app/package.json app/package-lock.json app/vitest.config.ts app/tests/setup.ts
git commit -m "chore(app): add jsdom + @testing-library/react for component tests"
```

---

## Task 2: Failing dashboard render test that reproduces the BigInt error

**Files:**
- Create: `app/src/app/__tests__/dashboard-render.test.tsx`

This test mocks `fetchInvoicesByCreator`, `getOrCreateClient`, `isFullyRegistered`, `scanClaimableUtxos`, `claimUtxos`, `getEncryptedBalance` so we can render the dashboard without a wallet or an RPC, and assert the happy path renders without throwing. It uses typed mocks matching the real return shapes (Anchor BN for `createdAt`, bigint for balance).

- [ ] **Step 1: Create the test file**

Create `app/src/app/__tests__/dashboard-render.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => ({
    connected: true,
    publicKey: new PublicKey("11111111111111111111111111111112"),
    signMessage: vi.fn(),
    signTransaction: vi.fn(),
  }),
}));

vi.mock("@/components/ClientWalletMultiButton", () => ({
  ClientWalletMultiButton: () => null,
}));

vi.mock("@/lib/anchor", () => ({
  fetchInvoicesByCreator: vi.fn(async () => [
    {
      publicKey: new PublicKey("11111111111111111111111111111113"),
      account: {
        version: 1,
        creator: new PublicKey("11111111111111111111111111111112"),
        payer: null,
        mint: new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
        metadataHash: new Uint8Array(32),
        metadataUri: "https://arweave.net/abc",
        utxoCommitment: null,
        status: { pending: {} },
        createdAt: new BN(1713657600), // 2026-04-21 as i64 BN
        paidAt: null,
        expiresAt: null,
        nonce: new Uint8Array(8),
        bump: 255,
      },
    },
  ]),
}));

vi.mock("@/lib/umbra", () => ({
  getOrCreateClient: vi.fn(async () => ({ signer: { address: "fake" } })),
  isFullyRegistered: vi.fn(async () => true),
  scanClaimableUtxos: vi.fn(async () => ({ received: [], publicReceived: [] })),
  claimUtxos: vi.fn(async () => undefined),
  getEncryptedBalance: vi.fn(async () => 1_500_000n), // 1.5 USDC in micros as bigint
}));

import DashboardPage from "@/app/dashboard/page";

describe("Dashboard page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the happy path without throwing BigInt/number mixing errors", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByText(/Your invoices/i)).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText(/Private USDC balance/i)).toBeInTheDocument();
    });

    // No red error banner — there should be no element containing the exact
    // substring "Cannot mix BigInt".
    const banners = screen.queryAllByText(/Cannot mix BigInt/i);
    expect(banners).toHaveLength(0);

    const calls = errorSpy.mock.calls.map((c) => String(c[0] ?? ""));
    const mixingErrors = calls.filter((m) => /Cannot mix BigInt/i.test(m));
    expect(mixingErrors).toEqual([]);

    errorSpy.mockRestore();
  });

  it("renders the row date without throwing when createdAt is an anchor BN", async () => {
    render(<DashboardPage />);
    await waitFor(() => {
      // 1713657600 → 2024-04-20 (or similar) — assert *some* YYYY-MM-DD string
      // appears in a row, which can only happen if Number(BN) conversion worked.
      const dateRe = /\d{4}-\d{2}-\d{2}/;
      expect(screen.getByText(dateRe)).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run:

```bash
cd app && npm test -- src/app/__tests__/dashboard-render.test.tsx
```

Expected: FAIL. Either:
- a "Cannot mix BigInt and other types" TypeError surfaces in `console.error` → second `expect(mixingErrors).toEqual([])` fails, OR
- `Number(i.account.createdAt)` where `createdAt` is a BN returns `NaN` and `formatDate` renders `"—"` → the `/\d{4}-\d{2}-\d{2}/` assertion fails.

Either failure mode proves the bug is real and located somewhere between `fetchInvoicesByCreator` → `page.tsx` → `DashboardList`.

- [ ] **Step 3: Commit the failing test**

```bash
git add app/src/app/__tests__/dashboard-render.test.tsx
git commit -m "test: failing render test for dashboard BigInt mixing bug"
```

---

## Task 3: Audit conversions in `lib/anchor.ts` — BN-safe `fetchInvoice` / `fetchInvoicesByCreator`

**Files:**
- Modify: `app/src/lib/anchor.ts`

Anchor returns `i64` fields as `BN`. The dashboard does `Number(i.account.createdAt)` which silently returns `NaN` when passed a BN (BN's valueOf throws in strict mode in some toolchains, returns NaN in others). Fix at the boundary: coerce every BN field to `number` (safe for i64 timestamps through 2038, which is acceptable for a hackathon demo and matches what the existing code already tries to do).

- [ ] **Step 1: Add a BN-normalizing helper at the top of `lib/anchor.ts`**

In `app/src/lib/anchor.ts`, immediately after the imports (after line 8 `import { INVOICE_REGISTRY_PROGRAM_ID, RPC_URL } from "./constants";`) add:

```ts
/**
 * Anchor returns i64 fields as BN. Coerce to a plain JS number (safe for
 * unix-seconds timestamps through 2038) so downstream code can use Number
 * arithmetic without risking a BigInt-vs-Number mix.
 */
function bnToNumber(val: any): number {
  if (val == null) return 0;
  if (typeof val === "number") return val;
  if (typeof val === "bigint") return Number(val);
  if (typeof val.toNumber === "function") return val.toNumber();
  return Number(val);
}

export interface NormalizedInvoice {
  version: number;
  creator: PublicKey;
  payer: PublicKey | null;
  mint: PublicKey;
  metadataHash: Uint8Array;
  metadataUri: string;
  utxoCommitment: Uint8Array | null;
  status: Record<string, unknown>;
  createdAt: number;
  paidAt: number | null;
  expiresAt: number | null;
  nonce: Uint8Array;
  bump: number;
}

function normalizeInvoice(raw: any): NormalizedInvoice {
  return {
    version: Number(raw.version ?? 0),
    creator: raw.creator,
    payer: raw.payer ?? null,
    mint: raw.mint,
    metadataHash: new Uint8Array(raw.metadataHash ?? []),
    metadataUri: String(raw.metadataUri ?? ""),
    utxoCommitment: raw.utxoCommitment ? new Uint8Array(raw.utxoCommitment) : null,
    status: raw.status ?? {},
    createdAt: bnToNumber(raw.createdAt),
    paidAt: raw.paidAt == null ? null : bnToNumber(raw.paidAt),
    expiresAt: raw.expiresAt == null ? null : bnToNumber(raw.expiresAt),
    nonce: new Uint8Array(raw.nonce ?? []),
    bump: Number(raw.bump ?? 0),
  };
}
```

- [ ] **Step 2: Route `fetchInvoice` and `fetchInvoicesByCreator` through the normalizer**

Replace the two existing functions at the bottom of `app/src/lib/anchor.ts` (lines 113-125) with:

```ts
export async function fetchInvoice(wallet: any, pda: PublicKey): Promise<NormalizedInvoice> {
  const program = getProgram(wallet);
  const raw = await (program.account as any).invoice.fetch(pda);
  return normalizeInvoice(raw);
}

export async function fetchInvoicesByCreator(
  wallet: any,
  creator: PublicKey,
): Promise<Array<{ publicKey: PublicKey; account: NormalizedInvoice }>> {
  const program = getProgram(wallet);
  const all = await (program.account as any).invoice.all([
    { memcmp: { offset: 8 + 1, bytes: creator.toBase58() } },
  ]);
  return all.map((entry: any) => ({
    publicKey: entry.publicKey,
    account: normalizeInvoice(entry.account),
  }));
}
```

- [ ] **Step 3: Run the dashboard test — it should now pass the `createdAt` date assertion**

Run:

```bash
cd app && npm test -- src/app/__tests__/dashboard-render.test.tsx
```

Expected: the second test (`renders the row date without throwing when createdAt is an anchor BN`) now PASSES because `normalizeInvoice` turns the BN into a number before it reaches the component. The first test may still fail if any other BigInt site lurks — Task 4 addresses that.

- [ ] **Step 4: Run the full suite to confirm no regression**

Run:

```bash
cd app && npm test
```

Expected: `tests/encryption.test.ts` (3), `tests/metadata.test.ts` (3), `tests/umbra-imports.test.ts` (2), dashboard test (1 of 2 passing). No new failures in the existing suites.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/anchor.ts
git commit -m "fix(anchor): normalize BN fields to number at the fetch boundary"
```

---

## Task 4: Audit conversions in `lib/umbra.ts` — `scanClaimableUtxos` summary stays bigint-only

**Files:**
- Modify: `app/src/lib/umbra.ts`

The Umbra SDK returns UTXO amounts as bigints. If any code path sums them with a JS number (e.g., `scan.publicReceived.length > 0` is fine, but `scan.publicReceived.reduce((s, u) => s + u.amount, 0)` would throw). Audit the two call sites and the `getEncryptedBalance` return. The current `getEncryptedBalance` already returns `BigInt(result.balance)` — leave it. But add an explicit `scanSummary` helper with a typed `totalAmount: bigint` so future callers never reach for `0` as the accumulator.

- [ ] **Step 1: Add `ScanSummary` helper + type after `scanClaimableUtxos`**

In `app/src/lib/umbra.ts`, after the `scanClaimableUtxos` function (which ends around line 320), add:

```ts
export interface ScanSummary {
  receivedCount: number;
  publicReceivedCount: number;
  /** Total value across public-received UTXOs. Always a bigint. */
  publicReceivedTotal: bigint;
}

/**
 * Compute a plain-old-data summary over a scan result. Guarantees bigint-only
 * arithmetic — callers must never reach for `0` as an accumulator because the
 * SDK's `amount` field is a bigint.
 */
export function summarizeScan(scan: {
  received: any[];
  publicReceived: any[];
}): ScanSummary {
  let total = 0n;
  for (const utxo of scan.publicReceived) {
    const raw = (utxo as any)?.amount;
    if (raw == null) continue;
    total += typeof raw === "bigint" ? raw : BigInt(raw);
  }
  return {
    receivedCount: scan.received.length,
    publicReceivedCount: scan.publicReceived.length,
    publicReceivedTotal: total,
  };
}
```

- [ ] **Step 2: Harden `getEncryptedBalance` against non-bigint `result.balance`**

Replace the body of `getEncryptedBalance` (lines 346-358) with:

```ts
export async function getEncryptedBalance(
  client: UmbraClient,
  mint: string,
): Promise<bigint> {
  const query = getEncryptedBalanceQuerierFunction({ client });
  const results = await query([mint as any]);
  for (const [, result] of results as any) {
    if (result?.state === "shared") {
      const raw = result.balance;
      if (typeof raw === "bigint") return raw;
      if (typeof raw === "number") return BigInt(Math.trunc(raw));
      if (typeof raw === "string") return BigInt(raw);
      return BigInt(raw as any);
    }
  }
  return 0n;
}
```

- [ ] **Step 3: Run the existing umbra-imports test — should still pass**

Run:

```bash
cd app && npm test -- tests/umbra-imports.test.ts
```

Expected: PASS (2). No regressions from the additions.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/umbra.ts
git commit -m "fix(umbra): bigint-safe scan summary and encrypted-balance coercion"
```

---

## Task 5: Fix the dashboard component's BigInt arithmetic site

**Files:**
- Modify: `app/src/app/dashboard/page.tsx:128` (the balance-display line)

The expression `Number(balance) / 10 ** PAYMENT_DECIMALS` is fine as-is because `Number(balance)` coerces first, then all operands are numbers. But lossy — 1.5 million micros → 1.5 USDC is safe, whereas billions of micros would lose precision. Replace with a string-integer divide that's both precision-safe and bigint-pure.

- [ ] **Step 1: Replace the balance-display expression**

In `app/src/app/dashboard/page.tsx`, replace the line currently reading:

```tsx
{(Number(balance) / 10 ** PAYMENT_DECIMALS).toFixed(Math.min(4, PAYMENT_DECIMALS))}
```

with:

```tsx
{formatBigintAmount(balance, PAYMENT_DECIMALS)}
```

- [ ] **Step 2: Add the helper at the bottom of `app/src/app/dashboard/page.tsx`**

Immediately before the closing of the file (after the `Shell` function, at the very end), add:

```tsx
function formatBigintAmount(amount: bigint | null, decimals: number): string {
  if (amount == null) return "0";
  const divisor = 10n ** BigInt(decimals);
  const whole = amount / divisor;
  const frac = amount % divisor;
  const display = Math.min(4, decimals);
  const padded = frac.toString().padStart(decimals, "0").slice(0, display);
  return `${whole.toString()}.${padded}`;
}
```

- [ ] **Step 3: Also replace `Number(i.account.createdAt)` in the map**

In `app/src/app/dashboard/page.tsx`, replace the line currently reading:

```tsx
createdAt: Number(i.account.createdAt),
```

with:

```tsx
createdAt: i.account.createdAt, // already a number after normalizeInvoice in Task 3
```

(The `NormalizedInvoice.createdAt` field from Task 3 is already typed as `number`, so no coercion is needed — TypeScript will flag any regression.)

- [ ] **Step 4: Run the dashboard render test — both assertions should now pass**

Run:

```bash
cd app && npm test -- src/app/__tests__/dashboard-render.test.tsx
```

Expected: PASS (2/2). No "Cannot mix BigInt" messages in `console.error` and the row date renders as `YYYY-MM-DD`.

- [ ] **Step 5: Commit**

```bash
git add app/src/app/dashboard/page.tsx
git commit -m "fix(dashboard): precision-safe bigint formatter and BN-free row mapper"
```

---

## Task 6: Failing unit test for `deriveKeyFromWalletSignature`

**Files:**
- Create: `app/src/lib/__tests__/encryption.test.ts`

Introduce the new test directory the user specified. This test spec-drives the signature-based key derivation: same wallet + same invoiceId must always produce the same 32-byte AES key; different invoiceIds must produce different keys.

- [ ] **Step 1: Create the test file**

Create `app/src/lib/__tests__/encryption.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { deriveKeyFromWalletSignature } from "@/lib/encryption";

function fakeWallet(signMessageImpl: (msg: Uint8Array) => Promise<Uint8Array>) {
  return { signMessage: signMessageImpl };
}

describe("deriveKeyFromWalletSignature", () => {
  it("returns a 32-byte key", async () => {
    const wallet = fakeWallet(async () => new Uint8Array(64).fill(7));
    const key = await deriveKeyFromWalletSignature(wallet as any, "inv_abc");
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
  });

  it("is deterministic — same signature + invoiceId → same key", async () => {
    const sig = new Uint8Array(64).fill(3);
    const wallet = fakeWallet(async () => sig);
    const k1 = await deriveKeyFromWalletSignature(wallet as any, "inv_abc");
    const k2 = await deriveKeyFromWalletSignature(wallet as any, "inv_abc");
    expect(Array.from(k1)).toEqual(Array.from(k2));
  });

  it("different invoiceIds → different keys (wallet signs different messages)", async () => {
    const signMessage = vi.fn(async (msg: Uint8Array) => {
      // Fake signature = SHA-256 of the message bytes, truncated/padded to 64.
      const buf = await crypto.subtle.digest("SHA-256", msg);
      const out = new Uint8Array(64);
      out.set(new Uint8Array(buf), 0);
      out.set(new Uint8Array(buf), 32);
      return out;
    });
    const wallet = fakeWallet(signMessage);
    const k1 = await deriveKeyFromWalletSignature(wallet as any, "inv_abc");
    const k2 = await deriveKeyFromWalletSignature(wallet as any, "inv_def");
    expect(Array.from(k1)).not.toEqual(Array.from(k2));

    expect(signMessage).toHaveBeenCalledTimes(2);
    const msg1 = new TextDecoder().decode(signMessage.mock.calls[0][0]);
    const msg2 = new TextDecoder().decode(signMessage.mock.calls[1][0]);
    expect(msg1).toBe("Veil invoice inv_abc");
    expect(msg2).toBe("Veil invoice inv_def");
  });

  it("throws a readable error when wallet.signMessage is missing", async () => {
    await expect(
      deriveKeyFromWalletSignature({} as any, "inv_abc"),
    ).rejects.toThrow(/signMessage/);
  });
});
```

- [ ] **Step 2: Run the test — it MUST fail because `deriveKeyFromWalletSignature` doesn't exist**

Run:

```bash
cd app && npm test -- src/lib/__tests__/encryption.test.ts
```

Expected: FAIL at module-load time with "export 'deriveKeyFromWalletSignature' (imported as 'deriveKeyFromWalletSignature') was not found in '@/lib/encryption'".

- [ ] **Step 3: Commit the failing test**

```bash
git add app/src/lib/__tests__/encryption.test.ts
git commit -m "test: failing spec for deriveKeyFromWalletSignature"
```

---

## Task 7: Implement `deriveKeyFromWalletSignature`

**Files:**
- Modify: `app/src/lib/encryption.ts`

Add the new helper. Message is literal `"Veil invoice <invoiceId>"`; derivation is SHA-256 over the raw signature bytes.

- [ ] **Step 1: Append the helper to `app/src/lib/encryption.ts`**

Add these two additions:

After line 9 (the existing `generateKey` function), add the new export:

```ts
/**
 * Derive a 32-byte AES key deterministically from a wallet signature over
 * a stable, per-invoice message. The key is:
 *
 *   sha256( wallet.signMessage("Veil invoice <invoiceId>") )
 *
 * Property: same wallet + same invoiceId always yields the same key, so
 * the creator can re-open her own invoice after closing the tab. The key
 * never exists on-chain and never leaves the creator's machine.
 */
export async function deriveKeyFromWalletSignature(
  wallet: { signMessage?: (msg: Uint8Array) => Promise<Uint8Array> },
  invoiceId: string,
): Promise<Uint8Array> {
  if (typeof wallet?.signMessage !== "function") {
    throw new Error(
      "Wallet does not expose signMessage — cannot derive invoice key.",
    );
  }
  const message = new TextEncoder().encode(`Veil invoice ${invoiceId}`);
  const signature = await wallet.signMessage(message);
  const hash = await crypto.subtle.digest("SHA-256", signature);
  return new Uint8Array(hash);
}
```

- [ ] **Step 2: Run the test — all four cases should pass**

Run:

```bash
cd app && npm test -- src/lib/__tests__/encryption.test.ts
```

Expected: PASS (4).

- [ ] **Step 3: Run the full suite — no regressions in the existing encryption.test.ts**

Run:

```bash
cd app && npm test
```

Expected: all previously-passing tests still pass. Dashboard render (2), encryption derivation (4), existing encryption (3), existing metadata (3), umbra imports (2). Total: 14 passed.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/encryption.ts
git commit -m "feat(encryption): deriveKeyFromWalletSignature for deterministic invoice keys"
```

---

## Task 8: Switch the create flow to use `deriveKeyFromWalletSignature`

**Files:**
- Modify: `app/src/app/create/page.tsx`

The create page currently generates a random key per invoice. Replace that with the new helper, keyed on `invoiceId`. The shareable URL still carries the key in the fragment for Bob; Alice can now re-derive it herself.

- [ ] **Step 1: Update the import in `app/src/app/create/page.tsx`**

Replace the existing line 16:

```tsx
import { encryptJson, generateKey, keyToBase58, sha256 } from "@/lib/encryption";
```

with:

```tsx
import { encryptJson, deriveKeyFromWalletSignature, keyToBase58, sha256 } from "@/lib/encryption";
```

- [ ] **Step 2: Replace the key-generation call**

In `app/src/app/create/page.tsx`, replace the line currently reading:

```tsx
const key = generateKey();
```

with:

```tsx
const key = await deriveKeyFromWalletSignature(wallet as any, invoiceId);
```

The `wallet.signMessage` null-check at the top of `handleSubmit` (line 34) already guards against a wallet that can't sign messages, so no additional guard is needed.

- [ ] **Step 3: Run the full test suite**

Run:

```bash
cd app && npm test
```

Expected: all 14 tests continue to pass. Nothing tests `create/page.tsx` directly yet, but the encryption round-trip tests confirm the key is still AES-compatible.

- [ ] **Step 4: Commit**

```bash
git add app/src/app/create/page.tsx
git commit -m "feat(create): derive invoice key from wallet signature instead of random bytes"
```

---

## Task 9: New `/invoice/[id]` creator-only view

**Files:**
- Create: `app/src/app/invoice/[id]/page.tsx`

This page mirrors `/pay/[id]/page.tsx` but (a) derives the decryption key from the connected wallet's signature instead of reading it from the URL fragment, and (b) only works if the connected wallet is the invoice's `creator`.

- [ ] **Step 1: Create the new route directory and file**

Run:

```bash
mkdir -p app/src/app/invoice/\[id\]
```

Create `app/src/app/invoice/[id]/page.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { PublicKey } from "@solana/web3.js";
import { InvoiceView } from "@/components/InvoiceView";
import { decryptJson, sha256, deriveKeyFromWalletSignature } from "@/lib/encryption";
import { fetchCiphertext } from "@/lib/arweave";
import { fetchInvoice } from "@/lib/anchor";
import type { InvoiceMetadata } from "@/lib/types";

export default function InvoiceCreatorPage({ params }: { params: { id: string } }) {
  const wallet = useWallet();
  const [metadata, setMetadata] = useState<InvoiceMetadata | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("idle");

  useEffect(() => {
    (async () => {
      try {
        setError(null);
        if (!wallet.publicKey) return;

        setStatus("Loading invoice from chain…");
        const invoicePda = new PublicKey(params.id);
        const invoice = await fetchInvoice(wallet as any, invoicePda);

        if (invoice.creator.toBase58() !== wallet.publicKey.toBase58()) {
          setError(
            "This invoice was created by a different wallet. Only the original creator can re-open it this way.",
          );
          setStatus("idle");
          return;
        }

        setStatus("Awaiting wallet signature to derive decryption key…");
        const key = await deriveKeyFromWalletSignature(wallet as any, invoice.metadataUri);
        // Note: we re-derive using metadataUri as a deterministic per-invoice
        // id-surrogate that's visible on-chain. This is equivalent to using
        // the Anchor `invoice_id` field (kept inside the encrypted metadata)
        // because metadataUri uniquely identifies this invoice PDA.
        //
        // BUT: the create flow signs over `"Veil invoice <invoiceId>"` where
        // `invoiceId` is the metadata's `invoice_id` — we must match that.
        // So: fetch ciphertext first, decrypt, then re-derive using the true
        // invoiceId and re-check.

        setStatus("Fetching encrypted metadata…");
        const ciphertext = await fetchCiphertext(invoice.metadataUri);
        const computedHash = await sha256(ciphertext);
        const onChainHash = new Uint8Array(invoice.metadataHash as any);
        const hashMatches = computedHash.every((b, i) => b === onChainHash[i]);
        if (!hashMatches) {
          setError("This invoice has been tampered with. Do NOT trust its contents.");
          setStatus("idle");
          return;
        }

        setStatus("Decrypting…");
        const md = (await decryptJson(ciphertext, key)) as InvoiceMetadata;
        setMetadata(md);
        setStatus("done");
      } catch (err: any) {
        // eslint-disable-next-line no-console
        console.error("[Veil invoice re-open] failed:", err);
        setError(err.message ?? String(err));
        setStatus("idle");
      }
    })();
  }, [params.id, wallet.publicKey]);

  if (error) {
    return (
      <Shell>
        <div className="max-w-2xl mx-auto reveal">
          <div className="flex items-start gap-4 border-l-2 border-brick pl-5 py-3">
            <span className="mono-chip text-brick shrink-0 pt-0.5">Error</span>
            <span className="text-[14.5px] text-ink leading-relaxed flex-1">{error}</span>
          </div>
          <div className="mt-6">
            <a href="/dashboard" className="btn-quiet">
              ← Back to dashboard
            </a>
          </div>
        </div>
      </Shell>
    );
  }

  if (!wallet.connected) {
    return (
      <Shell>
        <div className="max-w-lg mx-auto reveal">
          <span className="eyebrow">Invoice</span>
          <h1 className="mt-4 font-sans font-medium text-ink text-[36px] md:text-[44px] leading-[1.05] tracking-[-0.025em]">
            Connect the creator wallet to view this invoice.
          </h1>
          <p className="mt-5 text-[15px] leading-[1.55] text-ink/70 max-w-md">
            Only the wallet that created this invoice can re-derive its decryption key.
          </p>
          <div className="mt-8">
            <ClientWalletMultiButton />
          </div>
        </div>
      </Shell>
    );
  }

  if (!metadata) {
    return (
      <Shell>
        <div className="max-w-2xl mx-auto reveal">
          <p className="text-[13.5px] text-muted">{status}</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="max-w-2xl mx-auto reveal">
        <InvoiceView metadata={metadata} />
        <div className="mt-6">
          <a href="/dashboard" className="btn-quiet">
            ← Back to dashboard
          </a>
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen relative pb-32">
      <nav className="sticky top-0 z-10 backdrop-blur-sm bg-paper/80 border-b border-line">
        <div className="max-w-[1100px] mx-auto flex items-center justify-between px-6 md:px-8 py-4">
          <a href="/" className="flex items-baseline gap-3">
            <span className="font-sans font-semibold text-[17px] tracking-[-0.02em] text-ink">
              Veil
            </span>
            <span className="hidden sm:inline font-mono text-[10.5px] tracking-[0.08em] text-muted">
              — private invoicing
            </span>
          </a>
          <ClientWalletMultiButton />
        </div>
      </nav>

      <section className="max-w-[1100px] mx-auto px-6 md:px-8 pt-16 md:pt-20">{children}</section>
    </main>
  );
}
```

- [ ] **Step 2: Build the app to confirm the new route compiles**

Run:

```bash
cd app && npx next build
```

Expected: build succeeds. In the "Route (app)" table emitted at the end you should see a new entry like `ƒ /invoice/[id]`.

- [ ] **Step 3: Commit**

```bash
git add app/src/app/invoice/[id]/page.tsx
git commit -m "feat(invoice): creator-only re-open route using derived wallet signature key"
```

---

## Task 10: Fix the `deriveKeyFromWalletSignature` call site mismatch between create and re-open

**Files:**
- Modify: `app/src/app/invoice/[id]/page.tsx`

Task 9 noted a subtlety in a comment: the create flow signs over `"Veil invoice <invoiceId>"` where `invoiceId` is the metadata's `invoice_id`, but the re-open page doesn't know the `invoiceId` until after it has decrypted — a chicken-and-egg problem. Fix by standardizing on the invoice PDA (always known up front) as the deterministic identifier for both flows.

- [ ] **Step 1: Change the create flow to sign over the PDA, not `invoiceId`**

In `app/src/app/create/page.tsx`, the current call order is:

```tsx
const invoiceId = `inv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
// ... build metadata ...
const key = await deriveKeyFromWalletSignature(wallet as any, invoiceId);  // from Task 8
// ... createInvoiceOnChain returns pda ...
```

Re-order so that the PDA is computed first (which requires only the nonce), then used as the signing message. Replace the handler's body from the `const invoiceId = ...` line through the `const url = ...` line with:

```tsx
      const invoiceId = `inv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const subtotal = parsedItems.reduce((sum, li) => sum + li.totalMicros, 0n);

      const nonce = crypto.getRandomValues(new Uint8Array(8));
      const { deriveInvoicePda } = await import("@/lib/anchor");
      const [pda] = deriveInvoicePda(wallet.publicKey, nonce);

      const md = buildMetadata({
        invoiceId,
        creatorDisplayName: values.creatorDisplayName,
        creatorWallet: wallet.publicKey.toBase58(),
        payerDisplayName: values.payerDisplayName,
        payerWallet: values.payerWallet || null,
        mint: USDC_MINT.toBase58(),
        symbol: PAYMENT_SYMBOL,
        decimals: PAYMENT_DECIMALS,
        lineItems: parsedItems.map((li) => ({
          description: li.description,
          quantity: li.quantity,
          unitPrice: li.unitPriceMicros.toString(),
          total: li.totalMicros.toString(),
        })),
        subtotal: subtotal.toString(),
        tax: "0",
        total: subtotal.toString(),
        dueDate: values.dueDate || null,
        terms: null,
        notes: values.notes || null,
      });
      validateMetadata(md);

      // Sign over the PDA (always knowable off-chain from wallet + nonce),
      // so the re-open flow can re-derive the same key without needing to
      // first decrypt the metadata.
      const key = await deriveKeyFromWalletSignature(wallet as any, pda.toBase58());
      const ciphertext = await encryptJson(md, key);
      const { uri } = await uploadCiphertext(ciphertext);
      const hash = await sha256(ciphertext);

      const restrictedPayer = values.payerWallet ? new PublicKey(values.payerWallet) : null;
      await createInvoiceOnChain(wallet as any, {
        nonce,
        metadataHash: hash,
        metadataUri: uri,
        mint: USDC_MINT,
        restrictedPayer,
        expiresAt: null,
      });

      const url = `${window.location.origin}/pay/${pda.toBase58()}#${keyToBase58(key)}`;
      setResult({ url });
```

Note this also removes a dead intermediate (`pda` was previously the return value of `createInvoiceOnChain`; now it's computed up front and we ignore the return value by not binding it).

- [ ] **Step 2: Rewrite the re-open flow to derive the key from the PDA directly**

In `app/src/app/invoice/[id]/page.tsx`, replace the whole `useEffect` body (the async IIFE) with the simpler version:

```tsx
  useEffect(() => {
    (async () => {
      try {
        setError(null);
        if (!wallet.publicKey) return;

        setStatus("Loading invoice from chain…");
        const invoicePda = new PublicKey(params.id);
        const invoice = await fetchInvoice(wallet as any, invoicePda);

        if (invoice.creator.toBase58() !== wallet.publicKey.toBase58()) {
          setError(
            "This invoice was created by a different wallet. Only the original creator can re-open it this way.",
          );
          setStatus("idle");
          return;
        }

        setStatus("Awaiting wallet signature to derive decryption key…");
        const key = await deriveKeyFromWalletSignature(wallet as any, invoicePda.toBase58());

        setStatus("Fetching encrypted metadata…");
        const ciphertext = await fetchCiphertext(invoice.metadataUri);
        const computedHash = await sha256(ciphertext);
        const onChainHash = new Uint8Array(invoice.metadataHash as any);
        const hashMatches = computedHash.every((b, i) => b === onChainHash[i]);
        if (!hashMatches) {
          setError("This invoice has been tampered with. Do NOT trust its contents.");
          setStatus("idle");
          return;
        }

        setStatus("Decrypting…");
        const md = (await decryptJson(ciphertext, key)) as InvoiceMetadata;
        setMetadata(md);
        setStatus("done");
      } catch (err: any) {
        // eslint-disable-next-line no-console
        console.error("[Veil invoice re-open] failed:", err);
        setError(err.message ?? String(err));
        setStatus("idle");
      }
    })();
  }, [params.id, wallet.publicKey]);
```

- [ ] **Step 3: Full build to confirm the route compiles**

Run:

```bash
cd app && npx next build
```

Expected: build succeeds. Both `/create` and `/invoice/[id]` routes in the output.

- [ ] **Step 4: Full test suite**

Run:

```bash
cd app && npm test
```

Expected: 14 passed. No regressions.

- [ ] **Step 5: Commit**

```bash
git add app/src/app/create/page.tsx app/src/app/invoice/[id]/page.tsx
git commit -m "feat(invoice): sign key derivation over PDA so re-open matches create"
```

---

## Task 11: Wrap dashboard rows in a Link to `/invoice/[pda]`

**Files:**
- Modify: `app/src/components/DashboardList.tsx`

Each row becomes a clickable Link. Use Next.js `Link` from `next/link` so client-side navigation works. Preserve the current layout exactly — just wrap the existing `<li>` content.

- [ ] **Step 1: Import Next's Link and wrap each row**

Replace the entire contents of `app/src/components/DashboardList.tsx` with:

```tsx
"use client";

import Link from "next/link";

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
      <div>
        <div className="flex items-baseline justify-between mb-4">
          <span className="eyebrow">{title}</span>
          <span className="font-mono text-[11px] text-dim tnum">0</span>
        </div>
        <div className="border border-dashed border-line rounded-[4px] p-10 text-center">
          <p className="text-[14px] text-muted">No invoices yet.</p>
          <a href="/create" className="mt-3 inline-block btn-quiet">
            Create your first invoice →
          </a>
        </div>
      </div>
    );
  }
  return (
    <div>
      <div className="flex items-baseline justify-between mb-4">
        <span className="eyebrow">{title}</span>
        <span className="font-mono text-[11px] text-dim tnum">
          {String(invoices.length).padStart(2, "0")}
        </span>
      </div>
      <ul className="border border-line rounded-[4px] bg-paper-3 divide-y divide-line">
        {invoices.map((inv) => (
          <li key={inv.pda}>
            <Link
              href={`/invoice/${inv.pda}`}
              className="flex items-center justify-between gap-6 px-5 md:px-6 py-4 hover:bg-paper-2/40 transition-colors cursor-pointer"
              aria-label={`Open invoice ${inv.pda}`}
            >
              <div className="flex items-baseline gap-5 min-w-0">
                <span className="font-mono text-[11px] text-dim tnum shrink-0">
                  {formatDate(inv.createdAt)}
                </span>
                <span className="font-mono text-[13px] text-ink truncate">
                  {inv.pda.slice(0, 8)}…{inv.pda.slice(-4)}
                </span>
              </div>
              <StatusBadge status={inv.status} />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    Pending: "border-gold/40 text-gold bg-gold/5",
    Paid: "border-sage/40 text-sage bg-sage/5",
    Cancelled: "border-line-2 text-muted bg-paper-2/40",
    Expired: "border-brick/40 text-brick bg-brick/5",
  };
  return (
    <span
      className={`inline-block px-2.5 py-1 border rounded-[2px] font-mono text-[10.5px] tracking-[0.12em] uppercase ${styles[status] ?? ""}`}
    >
      {status}
    </span>
  );
}

function formatDate(ts: number): string {
  const d = new Date(ts * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}
```

- [ ] **Step 2: Extend the dashboard render test to assert links render**

Append the following test block to `app/src/app/__tests__/dashboard-render.test.tsx`, inside the existing `describe("Dashboard page", …)`, just before the closing `});`:

```tsx
  it("renders each invoice row as a link to /invoice/[pda]", async () => {
    render(<DashboardPage />);
    await waitFor(() => {
      const link = screen.getByRole("link", {
        name: /Open invoice 11111111111111111111111111111113/i,
      });
      expect(link).toHaveAttribute("href", "/invoice/11111111111111111111111111111113");
    });
  });
```

- [ ] **Step 3: Run the dashboard render test — now 3 passing**

Run:

```bash
cd app && npm test -- src/app/__tests__/dashboard-render.test.tsx
```

Expected: PASS (3). The new assertion confirms the `<Link>` renders with the right href.

- [ ] **Step 4: Run the full suite**

Run:

```bash
cd app && npm test
```

Expected: 15 tests total passing. No regressions in `tests/*` or `src/lib/__tests__/encryption.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/DashboardList.tsx app/src/app/__tests__/dashboard-render.test.tsx
git commit -m "feat(dashboard): clickable rows linking to /invoice/[pda]"
```

---

## Task 12: Manual end-to-end verification in dev mode

**Files:** (none — this is a runbook)

Verify both fixes with a real wallet against devnet.

- [ ] **Step 1: Start the dev server**

Run:

```bash
cd app && npm run dev
```

Expected: server listens on http://localhost:3000.

- [ ] **Step 2: Create an invoice as Alice**

Open http://localhost:3000/create in a browser with Phantom (devnet mode) connected as Alice:
- Fill in a dummy line item (description "Test", qty 1, rate 1.00).
- Click Create.
- Phantom prompts for THREE signatures: (a) the Umbra registration (if not already registered), (b) the `deriveKeyFromWalletSignature` message-sign prompt reading exactly `"Veil invoice <pda>"`, (c) the `createInvoiceOnChain` transaction.
- Accept all three.

Expected: success screen shows a shareable link like `http://localhost:3000/pay/<pda>#<base58-key>`.

- [ ] **Step 3: Visit the dashboard and confirm no red error banner**

Open http://localhost:3000/dashboard as the same Alice wallet.

Expected:
- The encrypted balance card renders without any `"Cannot mix BigInt"` error.
- The invoice just created appears as a row.
- No red error banner with prefix `Invoice list:`, `Balance:`, or `Umbra:`.

- [ ] **Step 4: Click the invoice row**

Click anywhere on the row.

Expected:
- Browser navigates to `/invoice/<pda>`.
- Phantom pops up asking to sign the message `"Veil invoice <pda>"` (the same pda that was signed during create).
- After signing, the decrypted InvoiceView renders with the dummy line item.

- [ ] **Step 5: Connect a different wallet and try to open the invoice**

Disconnect Alice, connect Bob in Phantom (different account), and navigate directly to `http://localhost:3000/invoice/<pda>`.

Expected: the page renders the error banner "This invoice was created by a different wallet. Only the original creator can re-open it this way." No Phantom signature prompt appears.

- [ ] **Step 6: Commit nothing (this is a verification-only task)**

No commit. Record outcomes in a short comment on the PR description or hackathon log.

---

## Summary

12 tasks, 4 new test files (technically 2 new test files + 2 existing tests that still count after the new suite runs through them), 6 files modified, 2 files created. Estimated execution: 6–8 working hours end-to-end including the final manual QA.
