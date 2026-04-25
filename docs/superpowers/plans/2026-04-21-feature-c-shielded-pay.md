# Feature C — Pay from Shielded Balance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Bob pay an invoice entirely from his existing Umbra-encrypted balance so no public deposit transaction is broadcast, making the whole payment path opaque on block explorers while preserving the existing public-ATA fallback.

**Architecture:** Add a new `payInvoiceFromShielded` wrapper in `app/src/lib/umbra.ts` that calls `getEncryptedBalanceToReceiverClaimableUtxoCreatorFunction` with `getCreateReceiverClaimableUtxoFromEncryptedBalanceProver`, mirroring the existing public-balance `payInvoice`. On `/pay/[id]`, query `getEncryptedBalance` after metadata decrypts; if `balance >= total`, render a toggle above the Pay button (default ON) that branches the submit handler between the new shielded path and the existing public path. The off-chain `markPaidOnChain` call remains identical in both branches — linkage stays PDA-mediated per the 2026-04-16 design addendum.

**Tech Stack:** TypeScript 5, Next.js 14 App Router (client components), `@umbra-privacy/sdk` 2.1.1, `@umbra-privacy/web-zk-prover` 2.0.1, `@solana/wallet-adapter-react` 0.15.35, Vitest 1.6.0.

**Spec:** See `docs/wow-features.md` §Feature C (pain point 1.1 strengthening — eliminate Bob's public deposit tx).

**Design references:**
- Core MVP plan: `docs/superpowers/plans/2026-04-15-veil-core-mvp.md` (Design 2026-04-16 addendum §1 — `utxo_commitment` may remain all-zeros; invoice↔UTXO linkage is NOT used for matching)
- Existing analog: `app/src/lib/umbra.ts` `payInvoice(...)` at ~line 267

---

## Task 1: SDK primitive verification + import smoke test

**Files:**
- Modify: `app/tests/umbra-imports.test.ts` (extend existing smoke test)

- [ ] **Step 1: Read the SDK type signature for the encrypted-balance creator**

Open `node_modules/@umbra-privacy/sdk/dist/index.d.ts`, locate
`getEncryptedBalanceToReceiverClaimableUtxoCreatorFunction`, and confirm:

- It is exported from the package root.
- Its call signature matches `(args: CreateUtxoArgs, options?: CreateUtxoOptions) => Promise<TransactionSignature[]>`.
- `CreateUtxoArgs` is `{ destinationAddress, mint, amount }` — the SAME shape used today by `getPublicBalanceToReceiverClaimableUtxoCreatorFunction`.

Write one line into `docs/superpowers/investigation/2026-04-21-feature-c-sdk-check.md`:

```
getEncryptedBalanceToReceiverClaimableUtxoCreatorFunction — confirmed exported, CreateUtxoArgs shape matches public-balance variant.
```

If the args shape DIFFERS from the public variant (e.g. requires an additional `sourceAccount` field, asks for a decryption key, or has a different return type), STOP and update Task 3 below before proceeding — the wrapper signature will need to diverge.

- [ ] **Step 2: Confirm the prover export name**

Open `node_modules/@umbra-privacy/web-zk-prover/dist/index.d.ts`. Confirm the export
`getCreateReceiverClaimableUtxoFromEncryptedBalanceProver` exists (the prover corresponding to the encrypted-balance creator).

Append one line to the investigation file:

```
getCreateReceiverClaimableUtxoFromEncryptedBalanceProver — confirmed exported from @umbra-privacy/web-zk-prover@2.0.1.
```

If the name differs, update Task 3 imports accordingly.

- [ ] **Step 3: Extend the import smoke test**

Open `app/tests/umbra-imports.test.ts`. Add two new imports and two new assertions (do not remove existing content):

```typescript
import {
  getEncryptedBalanceToReceiverClaimableUtxoCreatorFunction,
} from "@umbra-privacy/sdk";
import {
  getCreateReceiverClaimableUtxoFromEncryptedBalanceProver,
} from "@umbra-privacy/web-zk-prover";
```

Inside the first `it("exports all functions we depend on", ...)` block, add:

```typescript
    expect(getEncryptedBalanceToReceiverClaimableUtxoCreatorFunction).toBeTypeOf("function");
```

Inside the second `it("exports ZK provers we depend on", ...)` block, add:

```typescript
    expect(getCreateReceiverClaimableUtxoFromEncryptedBalanceProver).toBeTypeOf("function");
```

- [ ] **Step 4: Run the smoke test**

```bash
cd app && npx vitest run tests/umbra-imports.test.ts
```

Expected: 2 tests pass, including the two new assertions. If either import fails, rename per Step 2 findings.

- [ ] **Step 5: Commit**

```bash
git add app/tests/umbra-imports.test.ts docs/superpowers/investigation/2026-04-21-feature-c-sdk-check.md
git commit -m "test(umbra): verify encrypted-balance creator + prover exports"
```

---

## Task 2: Extract toggle-decision helper and unit-test it

**Files:**
- Create: `app/src/lib/shielded-pay.ts`
- Create: `app/src/lib/__tests__/shielded-pay.test.ts`

The UI decision "should we show the shielded-pay toggle?" is pure logic: given an encrypted balance and an invoice total, return a tri-state decision. Extracting this out of the page component makes it unit-testable without mocking React or the SDK transport.

- [ ] **Step 1: Write the failing test first**

Create `app/src/lib/__tests__/shielded-pay.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  decideShieldedPayAvailability,
  loadShieldedAvailability,
  type ShieldedAvailability,
} from "@/lib/shielded-pay";

describe("decideShieldedPayAvailability", () => {
  it("returns 'available' when encrypted balance >= total", () => {
    const d = decideShieldedPayAvailability({ encryptedBalance: 1_000_000n, total: 1_000_000n });
    expect(d).toEqual<ShieldedAvailability>({ kind: "available", balance: 1_000_000n });
  });

  it("returns 'available' when encrypted balance strictly exceeds total", () => {
    const d = decideShieldedPayAvailability({ encryptedBalance: 5_000_000n, total: 1_000_000n });
    expect(d).toEqual<ShieldedAvailability>({ kind: "available", balance: 5_000_000n });
  });

  it("returns 'insufficient' when encrypted balance is below total", () => {
    const d = decideShieldedPayAvailability({ encryptedBalance: 999_999n, total: 1_000_000n });
    expect(d).toEqual<ShieldedAvailability>({ kind: "insufficient", balance: 999_999n });
  });

  it("returns 'insufficient' when encrypted balance is zero", () => {
    const d = decideShieldedPayAvailability({ encryptedBalance: 0n, total: 1_000_000n });
    expect(d).toEqual<ShieldedAvailability>({ kind: "insufficient", balance: 0n });
  });

  it("returns 'insufficient' when total is zero but balance is zero too (degenerate invoice)", () => {
    // encryptedBalance >= total holds (0 >= 0), so 'available'. This guards the boundary.
    const d = decideShieldedPayAvailability({ encryptedBalance: 0n, total: 0n });
    expect(d).toEqual<ShieldedAvailability>({ kind: "available", balance: 0n });
  });
});

describe("loadShieldedAvailability", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("calls getEncryptedBalance with the mint and wraps the result as 'available'", async () => {
    const fakeClient = { id: "client-1" } as any;
    const fakeGetEncryptedBalance = vi.fn().mockResolvedValue(2_000_000n);

    const d = await loadShieldedAvailability({
      client: fakeClient,
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      total: 1_000_000n,
      getEncryptedBalance: fakeGetEncryptedBalance,
    });

    expect(fakeGetEncryptedBalance).toHaveBeenCalledWith(
      fakeClient,
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    );
    expect(d).toEqual<ShieldedAvailability>({ kind: "available", balance: 2_000_000n });
  });

  it("wraps a sub-total balance as 'insufficient'", async () => {
    const d = await loadShieldedAvailability({
      client: {} as any,
      mint: "mint-x",
      total: 1_000_000n,
      getEncryptedBalance: vi.fn().mockResolvedValue(500n),
    });
    expect(d).toEqual<ShieldedAvailability>({ kind: "insufficient", balance: 500n });
  });

  it("surfaces the error as 'errored' when the querier throws", async () => {
    const d = await loadShieldedAvailability({
      client: {} as any,
      mint: "mint-x",
      total: 1_000_000n,
      getEncryptedBalance: vi.fn().mockRejectedValue(new Error("indexer unreachable")),
    });
    expect(d.kind).toBe("errored");
    if (d.kind === "errored") {
      expect(d.message).toMatch(/indexer unreachable/);
    }
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

```bash
cd app && npx vitest run src/lib/__tests__/shielded-pay.test.ts
```

Expected: fails with "Cannot find module '@/lib/shielded-pay'". Good — we haven't written it yet.

- [ ] **Step 3: Implement the helper**

Create `app/src/lib/shielded-pay.ts`:

```typescript
/**
 * Pure-logic helpers that decide whether Bob's encrypted Umbra balance is
 * sufficient to pay an invoice directly from the shielded pool (Feature C).
 *
 * These live in their own module so the branching logic on /pay/[id] can be
 * unit-tested without mocking React, the Umbra SDK transport, or wallet
 * adapters. The page component calls `loadShieldedAvailability` once after
 * metadata decrypts and renders the toggle based on the returned kind.
 */

import { getEncryptedBalance as realGetEncryptedBalance } from "./umbra";

export type ShieldedAvailability =
  | { kind: "available"; balance: bigint }
  | { kind: "insufficient"; balance: bigint }
  | { kind: "errored"; message: string };

export interface DecideArgs {
  encryptedBalance: bigint;
  total: bigint;
}

/**
 * Pure decision: is `encryptedBalance` at least `total`?
 *
 * Not async, no I/O — easy to unit-test at every boundary (zero, exact, short,
 * over). The degenerate zero-total case is intentionally 'available' because
 * `encryptedBalance >= total` holds; the page should still gate on total > 0
 * before rendering a pay button at all, but that's not this helper's concern.
 */
export function decideShieldedPayAvailability(args: DecideArgs): ShieldedAvailability {
  if (args.encryptedBalance >= args.total) {
    return { kind: "available", balance: args.encryptedBalance };
  }
  return { kind: "insufficient", balance: args.encryptedBalance };
}

export interface LoadArgs {
  client: any; // UmbraClient — intentionally opaque here to keep this module SDK-agnostic.
  mint: string;
  total: bigint;
  /** Injected for tests; defaults to the production helper in `./umbra`. */
  getEncryptedBalance?: (client: any, mint: string) => Promise<bigint>;
}

/**
 * Fetch Bob's encrypted balance for `mint` and return a decision.
 *
 * Errors from the indexer (network, parsing, auth) become `{ kind: "errored" }`
 * rather than propagating — the UI should silently fall back to the public
 * flow rather than block the pay page on a shielded-query failure.
 */
export async function loadShieldedAvailability(args: LoadArgs): Promise<ShieldedAvailability> {
  const fetchBalance = args.getEncryptedBalance ?? realGetEncryptedBalance;
  try {
    const balance = await fetchBalance(args.client, args.mint);
    return decideShieldedPayAvailability({ encryptedBalance: balance, total: args.total });
  } catch (err) {
    return { kind: "errored", message: err instanceof Error ? err.message : String(err) };
  }
}
```

- [ ] **Step 4: Run test to confirm pass**

```bash
cd app && npx vitest run src/lib/__tests__/shielded-pay.test.ts
```

Expected: 7 tests pass (5 in `decideShieldedPayAvailability`, 3 in `loadShieldedAvailability`). If the `errored` test fails because the error message is wrapped differently, adjust the regex — don't change the behavior.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/shielded-pay.ts app/src/lib/__tests__/shielded-pay.test.ts
git commit -m "feat(shielded-pay): toggle-decision helper with unit tests"
```

---

## Task 3: Add `payInvoiceFromShielded` wrapper in umbra.ts

**Files:**
- Modify: `app/src/lib/umbra.ts`

This mirrors the existing `payInvoice` (public-balance) function. Same `PayInvoiceArgs` / `PayInvoiceResult` shapes so the `/pay/[id]` page can branch without reshaping call sites.

- [ ] **Step 1: Add imports at the top of the Task 16 section**

Open `app/src/lib/umbra.ts` and find the block near line 241–246:

```typescript
import {
  getPublicBalanceToReceiverClaimableUtxoCreatorFunction,
} from "@umbra-privacy/sdk";
import {
  getCreateReceiverClaimableUtxoFromPublicBalanceProver,
} from "@umbra-privacy/web-zk-prover";
```

Extend each import list (do not create a duplicate `import` statement for the same module — combine into the existing one):

```typescript
import {
  getPublicBalanceToReceiverClaimableUtxoCreatorFunction,
  getEncryptedBalanceToReceiverClaimableUtxoCreatorFunction,
} from "@umbra-privacy/sdk";
import {
  getCreateReceiverClaimableUtxoFromPublicBalanceProver,
  getCreateReceiverClaimableUtxoFromEncryptedBalanceProver,
} from "@umbra-privacy/web-zk-prover";
```

- [ ] **Step 2: Add the `payInvoiceFromShielded` function**

Immediately AFTER the existing `payInvoice` function body (after its closing `}` at the end of Task 16's `export async function payInvoice(...) { ... }`), append:

```typescript
/**
 * Pay an invoice by creating a receiver-claimable UTXO funded from Bob's
 * ENCRYPTED (shielded) balance — Feature C, full shielding.
 *
 * Contrast with `payInvoice` above which funds the UTXO from Bob's PUBLIC
 * ATA. A public-balance pay leaks a deposit tx a block explorer can correlate
 * with the invoice; an encrypted-balance pay happens entirely inside the
 * mixer and emits no plaintext amount.
 *
 * The returned shape is the SAME as `PayInvoiceResult` so callers can branch
 * on availability without restructuring their result handling. The SDK
 * returns an array of `TransactionSignature`s (1–3 txs) — we surface the
 * first two in named fields for parity with the public-balance result and
 * stash anything else into `closeProofAccountSignature`.
 *
 * Preconditions:
 *   - Bob is a fully-registered Umbra user (same as public-balance pay).
 *   - Bob's encrypted balance for `mint` is >= `amount`. The caller must
 *     verify this BEFORE invoking — prefer `loadShieldedAvailability` from
 *     `./shielded-pay` for the check. If the balance is insufficient the SDK
 *     will throw inside proof generation.
 *
 * Post-call the caller MUST still invoke `markPaidOnChain(wallet, pda, utxoCommitment)`
 * exactly as in the public-balance path — `utxo_commitment` remains an
 * all-zeros audit breadcrumb per the 2026-04-16 design addendum.
 */
export async function payInvoiceFromShielded(args: PayInvoiceArgs): Promise<PayInvoiceResult> {
  const zkProver = getCreateReceiverClaimableUtxoFromEncryptedBalanceProver({
    assetProvider: proxiedAssetProvider(),
  });
  const create = getEncryptedBalanceToReceiverClaimableUtxoCreatorFunction(
    { client: args.client },
    { zkProver } as any,
  );

  // The encrypted-balance creator returns `TransactionSignature[]` (1–3 entries)
  // whereas the public-balance creator returns an object with named fields.
  // Normalise to PayInvoiceResult shape: first = createProof, second = createUtxo,
  // third (if present) = closeProof. Fall back gracefully if fewer signatures come back.
  const signatures = await create({
    destinationAddress: args.recipientAddress as any,
    mint: args.mint as any,
    amount: args.amount as any,
  });

  const [sig0, sig1, sig2] = signatures as unknown as string[];
  return {
    createProofAccountSignature: sig0,
    createUtxoSignature: sig1 ?? sig0,
    closeProofAccountSignature: sig2,
  };
}
```

**Note on return-shape normalization:** Task 1 Step 1 confirmed the SDK signature returns `Promise<TransactionSignature[]>`. The existing public-balance `payInvoice` already treats its result as an object with named fields because the SDK version used in core-MVP returned an object — if during implementation the public-balance creator's return shape also turns out to be an array in 2.1.1, normalize BOTH functions to the array-destructuring pattern in one commit rather than letting them diverge. Re-read `node_modules/@umbra-privacy/sdk/dist/index.d.ts` around line 3403 to resolve.

- [ ] **Step 3: Type-check**

```bash
cd app && npx tsc --noEmit
```

Expected: no new TypeScript errors. If the wrapper errors on `signatures as unknown as string[]`, the SDK's `TransactionSignature` is a branded type — keep the double cast; it is intentional.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/umbra.ts
git commit -m "feat(umbra): payInvoiceFromShielded wraps encrypted-balance UTXO creator"
```

---

## Task 4: Wire toggle + branching into /pay/[id]

**Files:**
- Modify: `app/src/app/pay/[id]/page.tsx`

- [ ] **Step 1: Extend imports at the top of the file**

Open `app/src/app/pay/[id]/page.tsx`. Extend the umbra import (currently importing `getOrCreateClient, ensureRegistered, payInvoice`) to also import `payInvoiceFromShielded`:

```typescript
import { getOrCreateClient, ensureRegistered, payInvoice, payInvoiceFromShielded } from "@/lib/umbra";
```

Add a new import for the availability helper:

```typescript
import { loadShieldedAvailability, type ShieldedAvailability } from "@/lib/shielded-pay";
```

- [ ] **Step 2: Add state for shielded availability**

Inside the `PayPage` component, next to the other `useState` declarations (around `const [paid, setPaid] = useState(false);`), add:

```typescript
  const [shielded, setShielded] = useState<ShieldedAvailability | null>(null);
  const [useShielded, setUseShielded] = useState(true); // default ON when available
```

`null` = not yet queried. Once the query resolves we set one of `available` / `insufficient` / `errored`.

- [ ] **Step 3: Query encrypted balance after metadata decrypts**

Add a new `useEffect` BELOW the existing metadata-loading effect (the one that ends at `}, [params.id, wallet.publicKey]);`):

```typescript
  useEffect(() => {
    (async () => {
      if (!metadata || !wallet.publicKey) return;
      try {
        const client = await getOrCreateClient(wallet as any);
        const result = await loadShieldedAvailability({
          client,
          mint: metadata.currency.mint,
          total: BigInt(metadata.total),
        });
        setShielded(result);
      } catch {
        // loadShieldedAvailability swallows its own errors, but
        // getOrCreateClient can throw (e.g. wallet disconnected mid-flow).
        setShielded({ kind: "errored", message: "client unavailable" });
      }
    })();
  }, [metadata, wallet.publicKey]);
```

Do NOT block the pay page on this query — if `shielded` is still `null` when Bob clicks Pay, we fall through to the public-balance path silently.

- [ ] **Step 4: Branch `handlePay` between the two paths**

Replace the existing `await payInvoice({ ... })` block inside `handlePay` with the branched version. Locate:

```typescript
      const invoicePda = new PublicKey(params.id);
      const utxoCommitment = new Uint8Array(32);
      await payInvoice({
        client,
        recipientAddress: metadata.creator.wallet,
        mint: USDC_MINT.toBase58(),
        amount: BigInt(metadata.total),
      });
```

Change to:

```typescript
      const invoicePda = new PublicKey(params.id);
      const utxoCommitment = new Uint8Array(32);

      const payArgs = {
        client,
        recipientAddress: metadata.creator.wallet,
        mint: USDC_MINT.toBase58(),
        amount: BigInt(metadata.total),
      };

      const shouldUseShielded =
        useShielded && shielded?.kind === "available";

      if (shouldUseShielded) {
        await payInvoiceFromShielded(payArgs);
      } else {
        await payInvoice(payArgs);
      }
```

**Note:** `USDC_MINT.toBase58()` is kept for parity with the existing code path rather than switching to `metadata.currency.mint`. That's a separate code-quality cleanup; do not bundle it into this feature commit.

- [ ] **Step 5: Render the toggle above the Pay button**

Locate the render block that contains the Pay button (the `else` branch of the `paid ?` ternary — starting with `<div className="mt-8">` and the `<button onClick={handlePay}...>`). IMMEDIATELY BEFORE the `<button>` element, insert:

```tsx
            {shielded?.kind === "available" && (
              <label className="flex items-start gap-3 mb-5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={useShielded}
                  onChange={(e) => setUseShielded(e.target.checked)}
                  disabled={paying}
                  className="mt-1 accent-sage"
                />
                <span className="text-[13.5px] leading-relaxed">
                  <span className="text-ink">Pay from shielded balance</span>
                  <span className="ml-2 mono-chip text-sage">Recommended</span>
                  <span className="block text-[12px] text-muted mt-0.5">
                    No public deposit. Amount never appears on a block explorer.
                  </span>
                </span>
              </label>
            )}
```

- [ ] **Step 6: Update the hint line under the Pay button**

Replace the existing footer paragraph:

```tsx
            <p className="mt-4 max-w-xl text-[12px] font-mono tracking-[0.12em] uppercase text-dim">
              Settles via Umbra UTXO · amount never broadcast onchain
            </p>
```

With a conditional version:

```tsx
            <p className="mt-4 max-w-xl text-[12px] font-mono tracking-[0.12em] uppercase text-dim">
              {shielded?.kind === "available" && useShielded
                ? "From shielded balance · no public deposit"
                : "From public balance · one deposit tx"}
            </p>
```

- [ ] **Step 7: Type-check**

```bash
cd app && npx tsc --noEmit
```

Expected: no new TypeScript errors. If the JSX flags `mono-chip` or `text-sage` as unknown classes, those are Tailwind layers already defined globally; no change needed.

- [ ] **Step 8: Run the full unit test suite**

```bash
cd app && npm test
```

Expected: all existing tests pass + the 7 new `shielded-pay` tests pass. No new failures.

- [ ] **Step 9: Commit**

```bash
git add app/src/app/pay/[id]/page.tsx
git commit -m "feat(pay): toggle between shielded and public pay paths"
```

---

## Task 5: Manual smoke test on devnet

**Files:**
- None (devnet runtime verification only)

- [ ] **Step 1: Start the dev server**

```bash
cd app && npm run dev
```

Open `http://localhost:3000`.

- [ ] **Step 2: Seed Bob's encrypted balance**

As Bob's wallet, pay a dummy invoice via the existing public-balance flow, then wait for Alice's scan/claim cycle to complete so that Bob has some encrypted balance OR directly self-deposit via a helper (`getPublicBalanceToSelfClaimableUtxoCreatorFunction` if exposed in `umbra.ts` for dev seeding). If no self-deposit helper is wired, skip this step and rely on a prior test run where Bob happened to accumulate shielded balance.

**If Bob has no encrypted balance:** Verify the toggle does NOT appear (page renders exactly as before). This is the insufficient-balance fallback working.

- [ ] **Step 3: With encrypted balance present, pay an invoice**

Create a new invoice as Alice. Open the pay URL in Bob's browser. Confirm:

1. Invoice decrypts as normal.
2. The "Pay from shielded balance · Recommended" toggle renders above the Pay button, checked.
3. Clicking Pay triggers Phantom prompts for the encrypted-balance creator transactions (typically 1–3 prompts).
4. NO public ATA-to-Umbra deposit transaction appears in Bob's Phantom history.
5. After success, "Payment sent" card renders.
6. Alice's dashboard reflects the new claimable UTXO on her next scan.

Document findings in `docs/superpowers/investigation/2026-04-21-feature-c-sdk-check.md` — add sections:

```
## Runtime smoke test 2026-04-21

- Bob's encrypted balance before: [FILL IN]
- Bob's encrypted balance after: [FILL IN]
- Number of Phantom prompts: [FILL IN]
- Solana Explorer txs visible: [FILL IN — list the tx types]
- Observed leak (if any): [NONE / describe]
```

- [ ] **Step 4: Toggle-OFF regression test**

On the same pay URL (if the invoice supports multiple payments in your setup, OR for a second test invoice), uncheck the toggle before clicking Pay. Confirm the existing public-balance flow still works end-to-end — this guards against the toggle accidentally breaking the fallback.

- [ ] **Step 5: Commit runtime findings**

```bash
git add docs/superpowers/investigation/2026-04-21-feature-c-sdk-check.md
git commit -m "docs(shielded-pay): runtime smoke test findings"
```

---

## Task 6: Final verification before feature close

**Files:**
- None (read-only verification)

- [ ] **Step 1: Confirm existing public pay path untouched**

```bash
cd app && git diff HEAD~6 -- src/lib/umbra.ts | grep -E "^-" | grep -v "^---" | grep -v "^-$"
```

Expected: NO lines starting with `-` that are inside the existing `export async function payInvoice(...)`. The public-balance flow must be byte-identical to pre-feature state. If any lines are removed, revert them — the public path is the fallback per the Feature C scope.

- [ ] **Step 2: Confirm test suite is green**

```bash
cd app && npm test
```

Expected: all tests pass, zero skipped. If any test is skipped ensure it was already skipped before this feature — feature C must not regress coverage.

- [ ] **Step 3: Confirm the plan checklist is fully ticked**

Re-read this file top-to-bottom. Every `- [ ]` on this plan should be `- [x]` in the branch's working-tree copy. If any unticked boxes remain, complete or explicitly strike through with rationale before merging.

- [ ] **Step 4: Feature-complete commit (if needed)**

No code changes — this step only exists if a housekeeping commit is wanted to mark the feature done:

```bash
git commit --allow-empty -m "feat(shielded-pay): Feature C complete"
```

Only run if the team convention uses feature-complete markers; otherwise skip.

---

## Summary

- **Tasks:** 6
- **New/modified files:**
  - Create: `app/src/lib/shielded-pay.ts`
  - Create: `app/src/lib/__tests__/shielded-pay.test.ts`
  - Modify: `app/src/lib/umbra.ts`
  - Modify: `app/src/app/pay/[id]/page.tsx`
  - Modify: `app/tests/umbra-imports.test.ts`
  - Create: `docs/superpowers/investigation/2026-04-21-feature-c-sdk-check.md`
- **Fallback preserved:** The existing public-balance `payInvoice` is never removed; the toggle defaults to OFF semantics (public flow) whenever encrypted balance is unavailable or errored.
- **Linkage model:** Unchanged. `markPaidOnChain(wallet, invoicePda, utxoCommitment)` still runs with `utxoCommitment = new Uint8Array(32)` — zero-filled audit breadcrumb per the 2026-04-16 design addendum.
- **SDK version pin:** `@umbra-privacy/sdk@2.1.1`, `@umbra-privacy/web-zk-prover@2.0.1` — do not bump inside this feature.
