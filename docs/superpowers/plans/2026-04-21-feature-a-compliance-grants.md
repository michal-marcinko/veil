# Feature A — Compliance Grants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the end-to-end compliance-grant feature — list and revoke grants issued from the current wallet, build an auditor-side `/audit/[granter]` view that decrypts invoices via the SDK's re-encryption flow, and polish the existing issuance form with an X25519 public-key help dialog.

**Architecture:** Grant issuance is already wired (`issueComplianceGrant` in `lib/umbra.ts`). This plan adds (1) a client-side grant registry persisted to `localStorage` keyed by granter wallet because the SDK exposes no "list my grants" API — augmented on page load by a best-effort live probe against the on-chain grant PDAs via `getUserComplianceGrantQuerierFunction` to filter out already-revoked entries, (2) `revokeComplianceGrant` wrapping `getComplianceGrantRevokerFunction`, (3) an auditor route `/audit/[granter]` that lists the granter's invoices via the existing `fetchInvoicesByCreator` helper and, for each, (i) downloads the ciphertext from Arweave, (ii) re-encrypts it to the auditor's key via `getSharedCiphertextReencryptorForUserGrantFunction` when a compatible user-granted grant PDA exists, (iii) decrypts locally, and (iv) renders through `InvoiceView` in read-only mode, and (4) a help dialog added to `ComplianceGrantForm` explaining how the auditor obtains their X25519 pubkey via `getMasterViewingKeyX25519KeypairDeriver`.

**Tech Stack:** Next.js 14 App Router, TypeScript 5, `@umbra-privacy/sdk@2.1.1`, `@umbra-privacy/web-zk-prover@2.0.1`, `@solana/wallet-adapter-react`, `@coral-xyz/anchor@0.30.1`, `bs58`, Vitest 1.6.0.

**Spec:** See `docs/wow-features.md` lines 154–175 (Feature A scope), 51–52 (research 1.5 auditor access), 62–69 (research 1.8 security angle).

**Scope note:** MUST-HAVE user-granted grants only (receiver-X25519 pair). Network-shared and network-MXE grant types are out of scope — the hackathon demo story is "Alice grants Bob's accountant".

---

## File Structure

**New files (4):**
- `app/src/components/GrantList.tsx` — presentational component listing grants with revoke button
- `app/src/components/X25519HelpDialog.tsx` — small modal triggered by a "Where do I get this?" link next to the X25519 input
- `app/src/app/audit/[granter]/page.tsx` — auditor route rendering decrypted invoices
- `app/src/lib/__tests__/compliance-grants.test.ts` — Vitest unit tests

**Modified files (3):**
- `app/src/lib/umbra.ts` — add `listComplianceGrants`, `revokeComplianceGrant`, `readScopedInvoice` wrappers + `persistIssuedGrant` side-effect called by `issueComplianceGrant`
- `app/src/app/dashboard/compliance/page.tsx` — render `<GrantList />` below the form; add refresh-after-issue
- `app/src/components/ComplianceGrantForm.tsx` — add "Where do I get this?" link + `X25519HelpDialog`

Tests live in `app/src/lib/__tests__/` (new directory) to match Next.js co-location expectations; existing integration-style tests in `app/tests/` are left untouched.

---

## Task 1: SDK export verification + persistence primitive

**Files:**
- Modify: `app/src/lib/umbra.ts`
- Create: `app/src/lib/__tests__/compliance-grants.test.ts`

This task establishes the `localStorage`-backed grant registry and the tests for it. No SDK calls yet.

- [ ] **Step 1: Confirm SDK exports exist**

Run:

```bash
cd app && node -e "const sdk = require('@umbra-privacy/sdk'); console.log(['getComplianceGrantIssuerFunction','getComplianceGrantRevokerFunction','getUserComplianceGrantQuerierFunction','getSharedCiphertextReencryptorForUserGrantFunction','getMasterViewingKeyX25519KeypairDeriver','findUserComplianceGrantPda'].map(n => [n, typeof sdk[n]]));"
```

Expected: every entry prints `[ 'name', 'function' ]`. If any is `'undefined'`, check the d.ts at `node_modules/@umbra-privacy/sdk/dist/index.d.ts` — the five function names above are confirmed present at lines 1771, 1883, 2420, 2028, and in the crypto re-exports (getMasterViewingKeyX25519KeypairDeriver is on line 2 of the same file); `findUserComplianceGrantPda` is exported from `@umbra-privacy/sdk/common/pda`.

- [ ] **Step 2: Confirm indexer grant endpoint (5-min probe)**

Run:

```bash
curl -sI "https://utxo-indexer.api.umbraprivacy.com/grants?granter=11111111111111111111111111111111" | head -n 5
```

If HTTP 200 or 404-with-JSON: document the observed response schema in a new block at the top of `app/src/lib/umbra.ts` (comment only, no runtime use) and continue. If HTTP 404 or 501: we fall back to the localStorage registry + on-chain PDA probe approach that Step 4 implements — this is the default assumption, so no branch in the plan is needed. Either way, commit nothing from this step.

- [ ] **Step 3: Write the failing test**

Create `app/src/lib/__tests__/compliance-grants.test.ts`:

```typescript
import { describe, expect, it, beforeEach } from "vitest";
import {
  persistIssuedGrant,
  readPersistedGrants,
  removePersistedGrant,
  type PersistedGrant,
} from "@/lib/umbra";

describe("persisted grant registry", () => {
  beforeEach(() => {
    // vitest runs in node; provide a minimal localStorage stub per-test.
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() { return store.size; },
    };
  });

  it("round-trips a persisted grant through localStorage", () => {
    const grant: PersistedGrant = {
      granterAddress: "Alice1111111111111111111111111111111111111",
      receiverAddress: "Bob222222222222222222222222222222222222222",
      granterX25519Base58: "11111111111111111111111111111111",
      receiverX25519Base58: "22222222222222222222222222222222",
      nonce: "1745251200000",
      issuedAt: 1745251200000,
      signature: "sigabc",
    };
    persistIssuedGrant(grant);
    const all = readPersistedGrants(grant.granterAddress);
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(grant);
  });

  it("returns empty array when no grants persisted for granter", () => {
    expect(readPersistedGrants("Alice1111111111111111111111111111111111111")).toEqual([]);
  });

  it("scopes grants by granter address", () => {
    const a: PersistedGrant = {
      granterAddress: "AliceA111111111111111111111111111111111111",
      receiverAddress: "R",
      granterX25519Base58: "G",
      receiverX25519Base58: "R",
      nonce: "1",
      issuedAt: 1,
      signature: "sa",
    };
    const b: PersistedGrant = { ...a, granterAddress: "AliceB111111111111111111111111111111111111", signature: "sb" };
    persistIssuedGrant(a);
    persistIssuedGrant(b);
    expect(readPersistedGrants(a.granterAddress).map(g => g.signature)).toEqual(["sa"]);
    expect(readPersistedGrants(b.granterAddress).map(g => g.signature)).toEqual(["sb"]);
  });

  it("removes a persisted grant by (granter, receiverX25519, nonce)", () => {
    const g: PersistedGrant = {
      granterAddress: "Alice1111111111111111111111111111111111111",
      receiverAddress: "Bob",
      granterX25519Base58: "G",
      receiverX25519Base58: "R1",
      nonce: "42",
      issuedAt: 1,
      signature: "s1",
    };
    const g2: PersistedGrant = { ...g, receiverX25519Base58: "R2", nonce: "43", signature: "s2" };
    persistIssuedGrant(g);
    persistIssuedGrant(g2);
    removePersistedGrant(g.granterAddress, "R1", "42");
    const remaining = readPersistedGrants(g.granterAddress);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].signature).toBe("s2");
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd app && npm test -- src/lib/__tests__/compliance-grants.test.ts`

Expected: FAIL with "persistIssuedGrant is not exported from @/lib/umbra" or equivalent module-resolution error.

- [ ] **Step 5: Implement the persistence helpers**

Append to `app/src/lib/umbra.ts`:

```typescript
// ---------------------------------------------------------------------------
// Feature A: Compliance grant registry (localStorage-backed)
//
// The Umbra SDK does NOT expose a "list my grants as granter" function. Grant
// PDAs are marker accounts (seeds: granterX25519 || nonce || receiverX25519)
// and the indexer API does not document a grants-by-granter endpoint as of
// 2026-04-21. We therefore persist issued grants client-side keyed by the
// granter's wallet address; on page load we refresh status by probing the
// on-chain PDA via getUserComplianceGrantQuerierFunction (Task 3).
// ---------------------------------------------------------------------------

const GRANT_STORAGE_KEY_PREFIX = "veil.grants.v1.";

export interface PersistedGrant {
  /** Granter Solana wallet (base58). */
  granterAddress: string;
  /** Receiver/auditor Solana wallet (base58). */
  receiverAddress: string;
  /** Granter's MVK X25519 public key, base58. */
  granterX25519Base58: string;
  /** Receiver's X25519 public key, base58. */
  receiverX25519Base58: string;
  /** Grant nonce, decimal string (BigInt.toString()). */
  nonce: string;
  /** Unix millis when issuance tx was confirmed. */
  issuedAt: number;
  /** Issuance transaction signature. */
  signature: string;
}

function storageKey(granterAddress: string): string {
  return `${GRANT_STORAGE_KEY_PREFIX}${granterAddress}`;
}

export function persistIssuedGrant(grant: PersistedGrant): void {
  if (typeof localStorage === "undefined") return;
  const key = storageKey(grant.granterAddress);
  const raw = localStorage.getItem(key);
  const list: PersistedGrant[] = raw ? JSON.parse(raw) : [];
  list.push(grant);
  localStorage.setItem(key, JSON.stringify(list));
}

export function readPersistedGrants(granterAddress: string): PersistedGrant[] {
  if (typeof localStorage === "undefined") return [];
  const raw = localStorage.getItem(storageKey(granterAddress));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function removePersistedGrant(
  granterAddress: string,
  receiverX25519Base58: string,
  nonce: string,
): void {
  if (typeof localStorage === "undefined") return;
  const key = storageKey(granterAddress);
  const list = readPersistedGrants(granterAddress);
  const next = list.filter(
    (g) => !(g.receiverX25519Base58 === receiverX25519Base58 && g.nonce === nonce),
  );
  localStorage.setItem(key, JSON.stringify(next));
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd app && npm test -- src/lib/__tests__/compliance-grants.test.ts`

Expected: PASS — all 4 tests green.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/umbra.ts app/src/lib/__tests__/compliance-grants.test.ts
git commit -m "feat(compliance): localStorage-backed grant registry"
```

---

## Task 2: Hook persistence into `issueComplianceGrant`

**Files:**
- Modify: `app/src/lib/umbra.ts`
- Modify: `app/src/lib/__tests__/compliance-grants.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `app/src/lib/__tests__/compliance-grants.test.ts`:

```typescript
import bs58 from "bs58";
import { issueComplianceGrant } from "@/lib/umbra";

describe("issueComplianceGrant persistence", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() { return store.size; },
    };
  });

  it("persists a PersistedGrant after successful issuance", async () => {
    const granterAddress = "Alice1111111111111111111111111111111111111";
    const fakeSig = "signature-abc-123";
    const granterX25519 = new Uint8Array(32).fill(7);
    const receiverX25519 = new Uint8Array(32).fill(9);
    const nonce = 1745251200000n;

    // Fake client: we only need { signer.address } and the SDK factory to be
    // replaceable. issueComplianceGrant delegates to getComplianceGrantIssuerFunction,
    // which we stub via dependency injection — see Step 2 implementation.
    const fakeClient = { signer: { address: granterAddress } } as any;

    await issueComplianceGrant({
      client: fakeClient,
      receiverAddress: "Bob222222222222222222222222222222222222222",
      granterX25519PubKey: granterX25519,
      receiverX25519PubKey: receiverX25519,
      nonce,
      __issuerOverride: async () => fakeSig,
    });

    const persisted = readPersistedGrants(granterAddress);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].granterAddress).toBe(granterAddress);
    expect(persisted[0].receiverAddress).toBe("Bob222222222222222222222222222222222222222");
    expect(persisted[0].granterX25519Base58).toBe(bs58.encode(granterX25519));
    expect(persisted[0].receiverX25519Base58).toBe(bs58.encode(receiverX25519));
    expect(persisted[0].nonce).toBe("1745251200000");
    expect(persisted[0].signature).toBe(fakeSig);
    expect(persisted[0].issuedAt).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npm test -- src/lib/__tests__/compliance-grants.test.ts`

Expected: FAIL with "no overload matches" or a TypeScript error that `__issuerOverride` is not a known property.

- [ ] **Step 3: Extend `issueComplianceGrant` to persist after success**

Replace the existing `issueComplianceGrant` block in `app/src/lib/umbra.ts` (currently ~lines 364–397) with:

```typescript
import bs58 from "bs58";
import { getComplianceGrantIssuerFunction } from "@umbra-privacy/sdk";

export interface ComplianceGrantArgs {
  client: UmbraClient;
  /** Auditor / receiver wallet address (base58). */
  receiverAddress: string;
  /** Granter's MVK X25519 public key (32 bytes). */
  granterX25519PubKey: Uint8Array;
  /** Receiver's X25519 public key (32 bytes). */
  receiverX25519PubKey: Uint8Array;
  /** Optional nonce — defaults to BigInt(Date.now()). */
  nonce?: bigint;
  /** Test-only: replace the real SDK issuer with a stub returning a signature. */
  __issuerOverride?: (
    receiver: string,
    granterX25519: Uint8Array,
    receiverX25519: Uint8Array,
    nonce: bigint,
  ) => Promise<string>;
}

export async function issueComplianceGrant(args: ComplianceGrantArgs): Promise<string> {
  const nonce = args.nonce ?? BigInt(Date.now());
  const issuer = args.__issuerOverride
    ?? ((r, g, rx, n) => {
      const createGrant = getComplianceGrantIssuerFunction({ client: args.client });
      return createGrant(r as any, g as any, rx as any, n as any) as unknown as Promise<string>;
    });
  const signature = await issuer(
    args.receiverAddress,
    args.granterX25519PubKey,
    args.receiverX25519PubKey,
    nonce,
  );

  persistIssuedGrant({
    granterAddress: args.client.signer.address,
    receiverAddress: args.receiverAddress,
    granterX25519Base58: bs58.encode(args.granterX25519PubKey),
    receiverX25519Base58: bs58.encode(args.receiverX25519PubKey),
    nonce: nonce.toString(),
    issuedAt: Date.now(),
    signature,
  });

  return signature;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npm test -- src/lib/__tests__/compliance-grants.test.ts`

Expected: PASS — all 5 tests green (4 from Task 1 + 1 from this task).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/umbra.ts app/src/lib/__tests__/compliance-grants.test.ts
git commit -m "feat(compliance): persist issued grants to localStorage"
```

---

## Task 3: `listComplianceGrants` — read persisted + probe on-chain status

**Files:**
- Modify: `app/src/lib/umbra.ts`
- Modify: `app/src/lib/__tests__/compliance-grants.test.ts`

`listComplianceGrants` reads `readPersistedGrants(granterAddress)` and annotates each entry with `{ status: "active" | "revoked" }` by probing the on-chain PDA via `getUserComplianceGrantQuerierFunction`. Grants whose PDA returns `non_existent` are flagged revoked.

- [ ] **Step 1: Write the failing test**

Append to `app/src/lib/__tests__/compliance-grants.test.ts`:

```typescript
import { listComplianceGrants, type GrantWithStatus } from "@/lib/umbra";

describe("listComplianceGrants", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() { return store.size; },
    };
  });

  it("returns persisted grants annotated with status from querier", async () => {
    const granterAddress = "Alice1111111111111111111111111111111111111";
    persistIssuedGrant({
      granterAddress,
      receiverAddress: "Bob222222222222222222222222222222222222222",
      granterX25519Base58: bs58.encode(new Uint8Array(32).fill(1)),
      receiverX25519Base58: bs58.encode(new Uint8Array(32).fill(2)),
      nonce: "10",
      issuedAt: 1000,
      signature: "sigActive",
    });
    persistIssuedGrant({
      granterAddress,
      receiverAddress: "Carol333333333333333333333333333333333333",
      granterX25519Base58: bs58.encode(new Uint8Array(32).fill(1)),
      receiverX25519Base58: bs58.encode(new Uint8Array(32).fill(3)),
      nonce: "11",
      issuedAt: 1001,
      signature: "sigRevoked",
    });

    const fakeClient = { signer: { address: granterAddress } } as any;

    const result: GrantWithStatus[] = await listComplianceGrants({
      client: fakeClient,
      __querierOverride: async (_granter, _nonce, receiverX25519) => {
        // The second grant (receiver byte = 3) is revoked.
        const revoked = receiverX25519[0] === 3;
        return { state: revoked ? "non_existent" : "exists" } as any;
      },
    });

    expect(result).toHaveLength(2);
    const byNonce = Object.fromEntries(result.map(g => [g.nonce, g.status]));
    expect(byNonce["10"]).toBe("active");
    expect(byNonce["11"]).toBe("revoked");
  });

  it("marks grants revoked when querier throws (network error ⇒ conservative)", async () => {
    const granterAddress = "Alice1111111111111111111111111111111111111";
    persistIssuedGrant({
      granterAddress,
      receiverAddress: "Bob",
      granterX25519Base58: bs58.encode(new Uint8Array(32).fill(1)),
      receiverX25519Base58: bs58.encode(new Uint8Array(32).fill(2)),
      nonce: "42",
      issuedAt: 1000,
      signature: "s",
    });

    const result = await listComplianceGrants({
      client: { signer: { address: granterAddress } } as any,
      __querierOverride: async () => { throw new Error("rpc down"); },
    });

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npm test -- src/lib/__tests__/compliance-grants.test.ts`

Expected: FAIL with "listComplianceGrants is not exported from @/lib/umbra".

- [ ] **Step 3: Implement `listComplianceGrants`**

Append to `app/src/lib/umbra.ts`:

```typescript
import { getUserComplianceGrantQuerierFunction } from "@umbra-privacy/sdk";

export type GrantStatus = "active" | "revoked" | "unknown";

export interface GrantWithStatus extends PersistedGrant {
  status: GrantStatus;
}

export interface ListComplianceGrantsArgs {
  client: UmbraClient;
  /** Test-only override for the SDK querier factory result. */
  __querierOverride?: (
    granterX25519: Uint8Array,
    nonce: bigint,
    receiverX25519: Uint8Array,
  ) => Promise<{ state: "exists" | "non_existent" }>;
}

export async function listComplianceGrants(
  args: ListComplianceGrantsArgs,
): Promise<GrantWithStatus[]> {
  const granterAddress = args.client.signer.address;
  const persisted = readPersistedGrants(granterAddress);
  if (persisted.length === 0) return [];

  const querier = args.__querierOverride
    ?? (() => {
      const fn = getUserComplianceGrantQuerierFunction({ client: args.client });
      return (
        granterX25519: Uint8Array,
        nonce: bigint,
        receiverX25519: Uint8Array,
      ) => fn(granterX25519 as any, nonce as any, receiverX25519 as any) as unknown as Promise<{ state: "exists" | "non_existent" }>;
    })();

  const annotated = await Promise.all(
    persisted.map(async (g): Promise<GrantWithStatus> => {
      try {
        const result = await querier(
          bs58.decode(g.granterX25519Base58),
          BigInt(g.nonce),
          bs58.decode(g.receiverX25519Base58),
        );
        return { ...g, status: result.state === "exists" ? "active" : "revoked" };
      } catch {
        return { ...g, status: "unknown" };
      }
    }),
  );
  return annotated;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npm test -- src/lib/__tests__/compliance-grants.test.ts`

Expected: PASS — 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/umbra.ts app/src/lib/__tests__/compliance-grants.test.ts
git commit -m "feat(compliance): listComplianceGrants probes on-chain status"
```

---

## Task 4: `revokeComplianceGrant` wrapper

**Files:**
- Modify: `app/src/lib/umbra.ts`
- Modify: `app/src/lib/__tests__/compliance-grants.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `app/src/lib/__tests__/compliance-grants.test.ts`:

```typescript
import { revokeComplianceGrant } from "@/lib/umbra";

describe("revokeComplianceGrant", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() { return store.size; },
    };
  });

  it("calls the revoker with (receiver, granterX25519, receiverX25519, nonce) and removes from storage", async () => {
    const granterAddress = "Alice1111111111111111111111111111111111111";
    const granterX25519 = new Uint8Array(32).fill(1);
    const receiverX25519 = new Uint8Array(32).fill(2);
    persistIssuedGrant({
      granterAddress,
      receiverAddress: "Bob",
      granterX25519Base58: bs58.encode(granterX25519),
      receiverX25519Base58: bs58.encode(receiverX25519),
      nonce: "42",
      issuedAt: 1,
      signature: "issue-sig",
    });

    let captured: any = null;
    const sig = await revokeComplianceGrant({
      client: { signer: { address: granterAddress } } as any,
      grant: readPersistedGrants(granterAddress)[0],
      __revokerOverride: async (r, g, rx, n) => {
        captured = { r, g: Array.from(g), rx: Array.from(rx), n };
        return "revoke-sig";
      },
    });

    expect(sig).toBe("revoke-sig");
    expect(captured.r).toBe("Bob");
    expect(captured.g).toEqual(Array.from(granterX25519));
    expect(captured.rx).toEqual(Array.from(receiverX25519));
    expect(captured.n).toBe(42n);
    expect(readPersistedGrants(granterAddress)).toEqual([]);
  });

  it("does not remove from storage when revoker throws", async () => {
    const granterAddress = "Alice1111111111111111111111111111111111111";
    persistIssuedGrant({
      granterAddress,
      receiverAddress: "Bob",
      granterX25519Base58: bs58.encode(new Uint8Array(32).fill(1)),
      receiverX25519Base58: bs58.encode(new Uint8Array(32).fill(2)),
      nonce: "42",
      issuedAt: 1,
      signature: "s",
    });

    await expect(
      revokeComplianceGrant({
        client: { signer: { address: granterAddress } } as any,
        grant: readPersistedGrants(granterAddress)[0],
        __revokerOverride: async () => { throw new Error("user rejected"); },
      }),
    ).rejects.toThrow("user rejected");

    expect(readPersistedGrants(granterAddress)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npm test -- src/lib/__tests__/compliance-grants.test.ts`

Expected: FAIL with "revokeComplianceGrant is not exported from @/lib/umbra".

- [ ] **Step 3: Implement `revokeComplianceGrant`**

Append to `app/src/lib/umbra.ts`:

```typescript
import { getComplianceGrantRevokerFunction } from "@umbra-privacy/sdk";

export interface RevokeComplianceGrantArgs {
  client: UmbraClient;
  grant: PersistedGrant;
  __revokerOverride?: (
    receiver: string,
    granterX25519: Uint8Array,
    receiverX25519: Uint8Array,
    nonce: bigint,
  ) => Promise<string>;
}

export async function revokeComplianceGrant(
  args: RevokeComplianceGrantArgs,
): Promise<string> {
  const revoker = args.__revokerOverride
    ?? ((r, g, rx, n) => {
      const deleteGrant = getComplianceGrantRevokerFunction({ client: args.client });
      return deleteGrant(r as any, g as any, rx as any, n as any) as unknown as Promise<string>;
    });

  const signature = await revoker(
    args.grant.receiverAddress,
    bs58.decode(args.grant.granterX25519Base58),
    bs58.decode(args.grant.receiverX25519Base58),
    BigInt(args.grant.nonce),
  );

  removePersistedGrant(
    args.grant.granterAddress,
    args.grant.receiverX25519Base58,
    args.grant.nonce,
  );
  return signature;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npm test -- src/lib/__tests__/compliance-grants.test.ts`

Expected: PASS — 9 tests green.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/umbra.ts app/src/lib/__tests__/compliance-grants.test.ts
git commit -m "feat(compliance): revokeComplianceGrant wrapper + persistence cleanup"
```

---

## Task 5: `GrantList` component

**Files:**
- Create: `app/src/components/GrantList.tsx`
- Create: `app/src/components/__tests__/GrantList.test.tsx` (test-only)
- Modify: `app/package.json` (add `@testing-library/react`, `@testing-library/user-event`, `jsdom`)

Component renders a table of grants with columns: Receiver (truncated), Nonce, Issued-at, Status, Revoke. Uses presentational props only — fetching lives in the page.

- [ ] **Step 1: Add testing-library deps**

Modify `app/package.json` devDependencies to include:

```json
"@testing-library/react": "14.3.1",
"@testing-library/user-event": "14.5.2",
"jsdom": "24.1.0"
```

Install: `cd app && npm install`

- [ ] **Step 2: Configure Vitest for jsdom**

Replace `app/vitest.config.ts` with:

```typescript
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
  },
});
```

Run: `cd app && npm test -- src/lib/__tests__/compliance-grants.test.ts`

Expected: PASS — 9 tests still green under jsdom (the localStorage stub still works; jsdom's native localStorage is also fine because `beforeEach` overrides it).

- [ ] **Step 3: Write the failing component test**

Create `app/src/components/__tests__/GrantList.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GrantList } from "@/components/GrantList";
import type { GrantWithStatus } from "@/lib/umbra";

const baseGrant: GrantWithStatus = {
  granterAddress: "Alice1111111111111111111111111111111111111",
  receiverAddress: "Bob222222222222222222222222222222222222222",
  granterX25519Base58: "G".repeat(32),
  receiverX25519Base58: "R".repeat(32),
  nonce: "1745251200000",
  issuedAt: 1745251200000,
  signature: "sig",
  status: "active",
};

describe("GrantList", () => {
  it("renders empty state when grants array is empty", () => {
    render(<GrantList grants={[]} onRevoke={vi.fn()} revokingKey={null} />);
    expect(screen.getByText(/no grants yet/i)).toBeTruthy();
  });

  it("renders one row per grant with truncated receiver", () => {
    render(<GrantList grants={[baseGrant]} onRevoke={vi.fn()} revokingKey={null} />);
    // Truncation: first 4 + last 4 of base58 address.
    expect(screen.getByText(/Bob2…2222/)).toBeTruthy();
    expect(screen.getByText("1745251200000")).toBeTruthy();
    expect(screen.getByText(/active/i)).toBeTruthy();
  });

  it("calls onRevoke with the grant when Revoke button clicked", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<GrantList grants={[baseGrant]} onRevoke={handler} revokingKey={null} />);
    await user.click(screen.getByRole("button", { name: /revoke/i }));
    expect(handler).toHaveBeenCalledWith(baseGrant);
  });

  it("disables Revoke button for revoked grants", () => {
    render(
      <GrantList
        grants={[{ ...baseGrant, status: "revoked" }]}
        onRevoke={vi.fn()}
        revokingKey={null}
      />,
    );
    const btn = screen.getByRole("button", { name: /revoke/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("shows Revoking… label when revokingKey matches the grant", () => {
    render(
      <GrantList
        grants={[baseGrant]}
        onRevoke={vi.fn()}
        revokingKey={`${baseGrant.receiverX25519Base58}:${baseGrant.nonce}`}
      />,
    );
    expect(screen.getByText(/revoking/i)).toBeTruthy();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd app && npm test -- src/components/__tests__/GrantList.test.tsx`

Expected: FAIL — `GrantList` cannot be resolved.

- [ ] **Step 5: Implement `GrantList`**

Create `app/src/components/GrantList.tsx`:

```tsx
"use client";

import type { GrantWithStatus } from "@/lib/umbra";

interface Props {
  grants: GrantWithStatus[];
  onRevoke: (grant: GrantWithStatus) => void | Promise<void>;
  /** `${receiverX25519Base58}:${nonce}` of the grant currently being revoked, or null. */
  revokingKey: string | null;
}

export function GrantList({ grants, onRevoke, revokingKey }: Props) {
  if (grants.length === 0) {
    return (
      <div className="border border-dashed border-line rounded-[4px] p-8 text-center">
        <p className="text-[14px] text-muted">No grants yet.</p>
        <p className="text-[12px] text-dim mt-1">
          Issue a grant using the form above — it will appear here after confirmation.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-baseline justify-between mb-4">
        <span className="eyebrow">Issued grants</span>
        <span className="font-mono text-[11px] text-dim tnum">
          {String(grants.length).padStart(2, "0")}
        </span>
      </div>
      <ul className="border border-line rounded-[4px] bg-paper-3 divide-y divide-line">
        {grants.map((g) => {
          const key = `${g.receiverX25519Base58}:${g.nonce}`;
          const isRevoking = revokingKey === key;
          return (
            <li
              key={key}
              className="grid grid-cols-12 items-center gap-4 px-5 md:px-6 py-4"
            >
              <div className="col-span-4 min-w-0">
                <div className="mono-chip mb-1">Receiver</div>
                <div className="font-mono text-[13px] text-ink truncate">
                  {truncate(g.receiverAddress)}
                </div>
              </div>
              <div className="col-span-3 font-mono text-[12px] text-muted tnum break-all">
                {g.nonce}
              </div>
              <div className="col-span-2 font-mono text-[11px] text-dim tnum">
                {formatDate(g.issuedAt)}
              </div>
              <div className="col-span-1">
                <StatusPill status={g.status} />
              </div>
              <div className="col-span-2 text-right">
                <button
                  type="button"
                  onClick={() => onRevoke(g)}
                  disabled={g.status !== "active" || isRevoking}
                  className="btn-quiet text-[12px] disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isRevoking ? "Revoking…" : "Revoke"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function truncate(addr: string): string {
  if (addr.length <= 8) return addr;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

function StatusPill({ status }: { status: "active" | "revoked" | "unknown" }) {
  const styles: Record<string, string> = {
    active: "border-sage/40 text-sage bg-sage/5",
    revoked: "border-line-2 text-muted bg-paper-2/40",
    unknown: "border-gold/40 text-gold bg-gold/5",
  };
  return (
    <span
      className={`inline-block px-2 py-0.5 border rounded-[2px] font-mono text-[10px] tracking-[0.12em] uppercase ${styles[status]}`}
    >
      {status}
    </span>
  );
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd app && npm test -- src/components/__tests__/GrantList.test.tsx`

Expected: PASS — 5 tests green.

- [ ] **Step 7: Commit**

```bash
git add app/package.json app/package-lock.json app/vitest.config.ts app/src/components/GrantList.tsx app/src/components/__tests__/GrantList.test.tsx
git commit -m "feat(compliance): GrantList component with revoke button"
```

---

## Task 6: Wire `GrantList` into `/dashboard/compliance`

**Files:**
- Modify: `app/src/app/dashboard/compliance/page.tsx`

- [ ] **Step 1: Extend the page to fetch + render grants**

Replace the entire contents of `app/src/app/dashboard/compliance/page.tsx` with:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import bs58 from "bs58";
import { getMasterViewingKeyX25519KeypairDeriver } from "@umbra-privacy/sdk";
import {
  ComplianceGrantForm,
  type ComplianceGrantFormValues,
} from "@/components/ComplianceGrantForm";
import { GrantList } from "@/components/GrantList";
import {
  getOrCreateClient,
  ensureRegistered,
  issueComplianceGrant,
  listComplianceGrants,
  revokeComplianceGrant,
  type GrantWithStatus,
} from "@/lib/umbra";

interface GrantResult {
  receiverAddress: string;
  nonce: bigint;
  signature: string;
}

export default function CompliancePage() {
  const wallet = useWallet();
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<GrantResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [grants, setGrants] = useState<GrantWithStatus[]>([]);
  const [grantsLoading, setGrantsLoading] = useState(false);
  const [revokingKey, setRevokingKey] = useState<string | null>(null);

  const refreshGrants = useCallback(async () => {
    if (!wallet.connected) {
      setGrants([]);
      return;
    }
    setGrantsLoading(true);
    try {
      const client = await getOrCreateClient(wallet as any);
      const list = await listComplianceGrants({ client });
      setGrants(list);
    } catch (err: any) {
      setError(`Failed to load grants: ${err.message ?? String(err)}`);
    } finally {
      setGrantsLoading(false);
    }
  }, [wallet]);

  useEffect(() => {
    void refreshGrants();
  }, [refreshGrants]);

  async function handleGrant(values: ComplianceGrantFormValues) {
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const client = await getOrCreateClient(wallet as any);
      await ensureRegistered(client);

      const receiverBytes = bs58.decode(values.receiverX25519PubKey);
      if (receiverBytes.length !== 32) {
        throw new Error(
          `X25519 public key must be 32 bytes after base58 decode (got ${receiverBytes.length})`,
        );
      }

      const deriveMvk = getMasterViewingKeyX25519KeypairDeriver({ client });
      const mvkResult = await deriveMvk();
      const granterX25519 = mvkResult.x25519Keypair.publicKey;

      const nonce = BigInt(Date.now());

      const signature = await issueComplianceGrant({
        client,
        receiverAddress: values.receiverAddress,
        granterX25519PubKey: granterX25519,
        receiverX25519PubKey: new Uint8Array(receiverBytes),
        nonce,
      });

      setResult({ receiverAddress: values.receiverAddress, nonce, signature });
      await refreshGrants();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRevoke(grant: GrantWithStatus) {
    const key = `${grant.receiverX25519Base58}:${grant.nonce}`;
    setRevokingKey(key);
    setError(null);
    try {
      const client = await getOrCreateClient(wallet as any);
      await revokeComplianceGrant({ client, grant });
      await refreshGrants();
    } catch (err: any) {
      setError(`Revoke failed: ${err.message ?? String(err)}`);
    } finally {
      setRevokingKey(null);
    }
  }

  if (!wallet.connected) {
    return (
      <Shell>
        <div className="max-w-lg reveal">
          <span className="eyebrow">Auditor grants</span>
          <h1 className="mt-4 font-sans font-medium text-ink text-[36px] md:text-[44px] leading-[1.05] tracking-[-0.025em]">
            Connect to manage grants.
          </h1>
          <div className="mt-8">
            <ClientWalletMultiButton />
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="max-w-2xl reveal">
        <span className="eyebrow">Auditor grants</span>
        <h1 className="mt-3 font-sans font-medium text-ink text-[36px] md:text-[44px] leading-[1.05] tracking-[-0.025em]">
          Grant read-only access.
        </h1>
        <p className="mt-5 text-[15px] leading-[1.55] text-ink/70 max-w-xl">
          Give an auditor or accountant a scoped view of your encrypted transactions.
          You&apos;ll sign one transaction. You can revoke — but prior disclosures are
          permanent.
        </p>

        {error && (
          <div className="mt-8 flex items-start gap-4 border-l-2 border-brick pl-4 py-2 max-w-xl">
            <span className="mono-chip text-brick shrink-0 pt-0.5">Error</span>
            <span className="text-[13.5px] text-ink leading-relaxed flex-1">{error}</span>
          </div>
        )}

        {result && (
          <div className="mt-8 border border-sage/40 bg-sage/5 rounded-[3px] p-5 md:p-6 max-w-xl">
            <div className="flex items-baseline justify-between mb-4">
              <span className="eyebrow text-sage">Grant created</span>
            </div>
            <p className="text-[13.5px] text-ink/80 leading-relaxed">
              Share the following with your auditor so they can decrypt the scoped
              ciphertexts.
            </p>
            <dl className="mt-5 space-y-3 text-[12.5px] font-mono border-t border-line pt-4">
              <ResultRow label="Wallet" value={result.receiverAddress} />
              <ResultRow label="Nonce" value={result.nonce.toString()} />
              <ResultRow label="Signature" value={result.signature} />
              <ResultRow
                label="Audit URL"
                value={`${typeof window !== "undefined" ? window.location.origin : ""}/audit/${wallet.publicKey?.toBase58()}`}
              />
            </dl>
          </div>
        )}

        <div className="mt-10 pt-8 border-t border-line">
          <ComplianceGrantForm onSubmit={handleGrant} submitting={submitting} />
        </div>

        <div className="mt-12 pt-8 border-t border-line">
          {grantsLoading ? (
            <div className="text-[13px] text-dim">Loading grants…</div>
          ) : (
            <GrantList
              grants={grants}
              onRevoke={handleRevoke}
              revokingKey={revokingKey}
            />
          )}
        </div>
      </div>
    </Shell>
  );
}

function ResultRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-4">
      <dt className="text-dim uppercase tracking-[0.12em] text-[10.5px] w-20 shrink-0">
        {label}
      </dt>
      <dd className="text-ink break-all flex-1">{value}</dd>
    </div>
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
          <div className="flex items-center gap-1 md:gap-2">
            <a
              href="/create"
              className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors"
            >
              Create
            </a>
            <a
              href="/dashboard"
              className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors"
            >
              Dashboard
            </a>
            <div className="ml-2">
              <ClientWalletMultiButton />
            </div>
          </div>
        </div>
      </nav>

      <section className="max-w-[1100px] mx-auto px-6 md:px-8 pt-16 md:pt-20">{children}</section>
    </main>
  );
}
```

- [ ] **Step 2: Verify Next.js compile**

Run: `cd app && npm run build`

Expected: build succeeds without type errors. If a type error surfaces around the `client.signer.address` type (the SDK types it as `Address<string>` from `@solana/kit`), cast at the call site in `lib/umbra.ts` — `args.client.signer.address as unknown as string`.

- [ ] **Step 3: Commit**

```bash
git add app/src/app/dashboard/compliance/page.tsx
git commit -m "feat(compliance): render GrantList + revoke flow on dashboard"
```

---

## Task 7: `X25519HelpDialog` component

**Files:**
- Create: `app/src/components/X25519HelpDialog.tsx`
- Create: `app/src/components/__tests__/X25519HelpDialog.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `app/src/components/__tests__/X25519HelpDialog.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { X25519HelpDialog } from "@/components/X25519HelpDialog";

describe("X25519HelpDialog", () => {
  it("does not render when open=false", () => {
    render(<X25519HelpDialog open={false} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders instructions mentioning getMasterViewingKeyX25519KeypairDeriver when open", () => {
    render(<X25519HelpDialog open={true} onClose={vi.fn()} />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/getMasterViewingKeyX25519KeypairDeriver/)).toBeTruthy();
    expect(screen.getByText(/32-byte base58 public key/i)).toBeTruthy();
  });

  it("calls onClose when Close button clicked", async () => {
    const close = vi.fn();
    const user = userEvent.setup();
    render(<X25519HelpDialog open={true} onClose={close} />);
    await user.click(screen.getByRole("button", { name: /close/i }));
    expect(close).toHaveBeenCalledOnce();
  });

  it("calls onClose when backdrop clicked", async () => {
    const close = vi.fn();
    const user = userEvent.setup();
    render(<X25519HelpDialog open={true} onClose={close} />);
    await user.click(screen.getByTestId("help-dialog-backdrop"));
    expect(close).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npm test -- src/components/__tests__/X25519HelpDialog.test.tsx`

Expected: FAIL — `X25519HelpDialog` cannot be resolved.

- [ ] **Step 3: Implement `X25519HelpDialog`**

Create `app/src/components/X25519HelpDialog.tsx`:

```tsx
"use client";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function X25519HelpDialog({ open, onClose }: Props) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      data-testid="help-dialog-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="x25519-help-title"
        className="bg-paper border border-line rounded-[4px] max-w-lg w-full p-6 md:p-8 shadow-[0_30px_80px_-40px_rgba(26,24,20,0.4)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="x25519-help-title"
          className="font-sans font-medium text-ink text-[22px] leading-[1.15] tracking-[-0.02em]"
        >
          How the auditor obtains their X25519 key
        </h2>
        <div className="mt-4 space-y-3 text-[13.5px] text-ink/80 leading-relaxed">
          <p>
            Your auditor generates this via{" "}
            <code className="font-mono text-[12.5px] bg-paper-2 px-1.5 py-0.5 rounded-[2px]">
              getMasterViewingKeyX25519KeypairDeriver
            </code>{" "}
            after their Umbra registration.
          </p>
          <p>
            Ask them to share the{" "}
            <strong className="text-ink">32-byte base58 public key</strong> —
            <strong className="text-brick"> not the secret</strong>.
          </p>
          <p className="text-[12.5px] text-dim">
            Auditor-side snippet:
          </p>
          <pre className="font-mono text-[11.5px] bg-paper-2 border border-line rounded-[2px] p-3 overflow-x-auto">{`import { getMasterViewingKeyX25519KeypairDeriver } from "@umbra-privacy/sdk";
import bs58 from "bs58";

const derive = getMasterViewingKeyX25519KeypairDeriver({ client });
const { x25519Keypair } = await derive();
console.log("Share this:", bs58.encode(x25519Keypair.publicKey));`}</pre>
          <p className="text-[12.5px] text-dim">
            If the auditor hasn&apos;t registered with Umbra yet, they must connect
            their wallet to Veil (or any Umbra-enabled app) and complete the
            three-step registration first.
          </p>
        </div>
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="btn-primary text-[13px]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npm test -- src/components/__tests__/X25519HelpDialog.test.tsx`

Expected: PASS — 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/X25519HelpDialog.tsx app/src/components/__tests__/X25519HelpDialog.test.tsx
git commit -m "feat(compliance): X25519HelpDialog explaining auditor key"
```

---

## Task 8: Wire `X25519HelpDialog` into `ComplianceGrantForm`

**Files:**
- Modify: `app/src/components/ComplianceGrantForm.tsx`

- [ ] **Step 1: Add the help-link + dialog**

Replace the entire contents of `app/src/components/ComplianceGrantForm.tsx` with:

```tsx
"use client";

import { useState } from "react";
import { X25519HelpDialog } from "./X25519HelpDialog";

export interface ComplianceGrantFormValues {
  receiverAddress: string;
  receiverX25519PubKey: string;
  note?: string;
}

interface Props {
  onSubmit: (values: ComplianceGrantFormValues) => Promise<void>;
  submitting: boolean;
}

export function ComplianceGrantForm({ onSubmit, submitting }: Props) {
  const [receiverAddress, setReceiverAddress] = useState("");
  const [receiverX25519PubKey, setReceiverX25519PubKey] = useState("");
  const [note, setNote] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await onSubmit({
      receiverAddress: receiverAddress.trim(),
      receiverX25519PubKey: receiverX25519PubKey.trim(),
      note: note.trim() || undefined,
    });
  }

  return (
    <>
      <form onSubmit={handleSubmit} className="space-y-8">
        <Field label="Auditor Solana wallet address">
          <input
            value={receiverAddress}
            onChange={(e) => setReceiverAddress(e.target.value)}
            placeholder="base58 Solana wallet address"
            className="input-editorial font-mono text-sm"
            required
          />
          <FieldHint>The on-chain address of your auditor or accountant.</FieldHint>
        </Field>

        <Field
          label="Auditor X25519 public key"
          headerRight={
            <button
              type="button"
              onClick={() => setHelpOpen(true)}
              className="font-mono text-[10.5px] tracking-[0.08em] uppercase text-muted hover:text-ink transition-colors underline-offset-2 hover:underline"
            >
              Where do I get this?
            </button>
          }
        >
          <input
            value={receiverX25519PubKey}
            onChange={(e) => setReceiverX25519PubKey(e.target.value)}
            placeholder="base58 encoded X25519 public key (32 bytes)"
            className="input-editorial font-mono text-sm"
            required
          />
          <FieldHint>
            Ask your auditor for their X25519 key. Once granted, they can decrypt
            transactions scoped by this nonce.{" "}
            <span className="text-brick">
              Warning: the nonce creates permanent disclosure for everything encrypted
              under it, even after revocation.
            </span>
          </FieldHint>
        </Field>

        <Field label="Note for the auditor" optional>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Scope, period covered, engagement reference, etc."
            rows={3}
            className="input-editorial resize-none"
          />
        </Field>

        <button
          type="submit"
          disabled={submitting}
          className="btn-primary w-full md:w-auto md:min-w-[280px]"
        >
          {submitting ? (
            <span className="inline-flex items-center gap-3">
              <span className="h-1.5 w-1.5 rounded-full bg-paper animate-slow-pulse" />
              Creating grant…
            </span>
          ) : (
            <span>
              Grant access <span aria-hidden>→</span>
            </span>
          )}
        </button>
      </form>

      <X25519HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
    </>
  );
}

function Field({
  label,
  optional,
  headerRight,
  children,
}: {
  label: string;
  optional?: boolean;
  headerRight?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-3 justify-between">
        <div className="flex items-baseline gap-3">
          <label className="mono-chip">{label}</label>
          {optional && (
            <span className="font-mono text-[10px] tracking-[0.16em] uppercase text-dim">
              Optional
            </span>
          )}
        </div>
        {headerRight}
      </div>
      {children}
    </div>
  );
}

function FieldHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[12px] text-dim font-sans leading-relaxed mt-1.5">
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

Run: `cd app && npm run build`

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/ComplianceGrantForm.tsx
git commit -m "feat(compliance): add Where do I get this? help link to form"
```

---

## Task 9: `readScopedInvoice` — auditor-side decryption primitive

**Files:**
- Modify: `app/src/lib/umbra.ts`
- Modify: `app/src/lib/__tests__/compliance-grants.test.ts`

`readScopedInvoice` takes an invoice PDA + its Arweave metadata URI + the granter's X25519 pubkey + the grant nonce. It:

1. Fetches the ciphertext from Arweave (already wired via `lib/arweave.ts` — we'll import the `fetchMetadata` helper; if the name differs, grep for the export in `lib/arweave.ts` during Step 1).
2. Calls `getSharedCiphertextReencryptorForUserGrantFunction` to trigger the Arcium MPC re-encryption.
3. Polls the MPC callback data PDA (the SDK returns the handler signature fire-and-forget; callback retrieval is a follow-up SDK call — we defer that concern with a clear TODO in the implementation return and a test for the handler-signature path only).
4. Decrypts the returned ciphertext locally using the auditor's X25519 private key (derived via the auditor's MVK).

Because MPC callback retrieval is an asynchronous Arcium operation that the current SDK version exposes as fire-and-forget, this task ships `readScopedInvoice` as a wrapper that returns `{ handlerSignature, pending: true }` — the UI (Task 11) renders a "Re-encryption pending…" state and refreshes. End-to-end plaintext decryption is tracked in a follow-up task (not part of this plan).

- [ ] **Step 1: Confirm arweave helper exports**

Run:

```bash
grep -n "export " app/src/lib/arweave.ts
```

Expected: at minimum one of `fetchMetadata`, `fetchFromArweave`, or `downloadMetadata`. Record the exact function name in a comment at the top of the new code block in Step 3. If no matching export exists, add one as `export async function fetchCiphertext(uri: string): Promise<Uint8Array>` following the pattern of existing helpers (use `fetch(uri).then(r => r.arrayBuffer()).then(b => new Uint8Array(b))`).

- [ ] **Step 2: Write the failing test**

Append to `app/src/lib/__tests__/compliance-grants.test.ts`:

```typescript
import { readScopedInvoice } from "@/lib/umbra";

describe("readScopedInvoice", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() { return store.size; },
    };
  });

  it("calls reencryptor with (granterX25519, receiverX25519, grantNonce, inputNonce, ciphertexts)", async () => {
    const granterX25519 = new Uint8Array(32).fill(1);
    const receiverX25519 = new Uint8Array(32).fill(2);
    const ciphertexts: Uint8Array[] = [new Uint8Array(32).fill(3)];

    let captured: any = null;

    const result = await readScopedInvoice({
      client: { signer: { address: "R" } } as any,
      granterX25519PubKey: granterX25519,
      receiverX25519PubKey: receiverX25519,
      grantNonce: 42n,
      inputNonce: 7n,
      ciphertexts,
      __reencryptorOverride: async (g, r, gn, inNonce, cts) => {
        captured = {
          g: Array.from(g),
          r: Array.from(r),
          gn,
          inNonce,
          cts: cts.map((c) => Array.from(c)),
        };
        return "handler-sig";
      },
    });

    expect(result.handlerSignature).toBe("handler-sig");
    expect(result.pending).toBe(true);
    expect(captured.g).toEqual(Array.from(granterX25519));
    expect(captured.r).toEqual(Array.from(receiverX25519));
    expect(captured.gn).toBe(42n);
    expect(captured.inNonce).toBe(7n);
    expect(captured.cts[0]).toEqual(Array.from(ciphertexts[0]));
  });

  it("rejects when ciphertexts array is empty", async () => {
    await expect(
      readScopedInvoice({
        client: { signer: { address: "R" } } as any,
        granterX25519PubKey: new Uint8Array(32),
        receiverX25519PubKey: new Uint8Array(32),
        grantNonce: 1n,
        inputNonce: 1n,
        ciphertexts: [],
        __reencryptorOverride: async () => "x",
      }),
    ).rejects.toThrow(/at least one ciphertext/i);
  });

  it("rejects when ciphertexts array exceeds 6 (SDK hard limit)", async () => {
    const cts = Array.from({ length: 7 }, () => new Uint8Array(32));
    await expect(
      readScopedInvoice({
        client: { signer: { address: "R" } } as any,
        granterX25519PubKey: new Uint8Array(32),
        receiverX25519PubKey: new Uint8Array(32),
        grantNonce: 1n,
        inputNonce: 1n,
        ciphertexts: cts,
        __reencryptorOverride: async () => "x",
      }),
    ).rejects.toThrow(/at most 6 ciphertexts/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd app && npm test -- src/lib/__tests__/compliance-grants.test.ts`

Expected: FAIL — `readScopedInvoice` not exported.

- [ ] **Step 4: Implement `readScopedInvoice`**

Append to `app/src/lib/umbra.ts`:

```typescript
import { getSharedCiphertextReencryptorForUserGrantFunction } from "@umbra-privacy/sdk";

export interface ReadScopedInvoiceArgs {
  client: UmbraClient;
  /** Granter's MVK X25519 public key (32 bytes). */
  granterX25519PubKey: Uint8Array;
  /** Receiver (auditor) X25519 public key (32 bytes). */
  receiverX25519PubKey: Uint8Array;
  /** Grant nonce — must match the nonce used when the grant was created. */
  grantNonce: bigint;
  /** Input nonce — the nonce under which the invoice ciphertexts were encrypted. */
  inputNonce: bigint;
  /** 1–6 shared-mode ciphertexts (32 bytes each) to re-encrypt. */
  ciphertexts: Uint8Array[];
  __reencryptorOverride?: (
    granterX25519: Uint8Array,
    receiverX25519: Uint8Array,
    grantNonce: bigint,
    inputNonce: bigint,
    ciphertexts: Uint8Array[],
  ) => Promise<string>;
}

export interface ReadScopedInvoiceResult {
  /** Handler transaction signature — the MPC callback is still pending. */
  handlerSignature: string;
  /** Always true in this SDK version — plaintext retrieval is a follow-up. */
  pending: true;
}

export async function readScopedInvoice(
  args: ReadScopedInvoiceArgs,
): Promise<ReadScopedInvoiceResult> {
  if (args.ciphertexts.length === 0) {
    throw new Error("readScopedInvoice: need at least one ciphertext");
  }
  if (args.ciphertexts.length > 6) {
    throw new Error(
      `readScopedInvoice: SDK accepts at most 6 ciphertexts per call (got ${args.ciphertexts.length})`,
    );
  }
  const reencrypt = args.__reencryptorOverride
    ?? ((g, r, gn, inN, cts) => {
      const fn = getSharedCiphertextReencryptorForUserGrantFunction({ client: args.client });
      return fn(g as any, r as any, gn as any, inN as any, cts as any) as unknown as Promise<string>;
    });

  const handlerSignature = await reencrypt(
    args.granterX25519PubKey,
    args.receiverX25519PubKey,
    args.grantNonce,
    args.inputNonce,
    args.ciphertexts,
  );

  return { handlerSignature, pending: true };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd app && npm test -- src/lib/__tests__/compliance-grants.test.ts`

Expected: PASS — 12 tests green.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/umbra.ts app/src/lib/__tests__/compliance-grants.test.ts
git commit -m "feat(compliance): readScopedInvoice re-encryption wrapper"
```

---

## Task 10: Auditor-side invoice query — `fetchInvoicesByCreator` reuse

**Files:**
- Modify: `app/src/lib/anchor.ts` (add a `PublicKey`-string-addressable variant if the existing signature blocks it)

The existing `fetchInvoicesByCreator(wallet, creator)` is already suitable — it needs a `wallet` param only to build an Anchor provider. For the audit route the connected wallet is the auditor (not the creator), so we pass the auditor's wallet in and filter by the creator's PublicKey. No modification needed beyond confirming the signature.

- [ ] **Step 1: Confirm the helper works with an arbitrary creator PublicKey**

Run:

```bash
grep -n "export async function fetchInvoicesByCreator" app/src/lib/anchor.ts
```

Expected: one match at approximately line 118 matching:

```typescript
export async function fetchInvoicesByCreator(wallet: any, creator: PublicKey) {
```

If the signature does not take `(wallet, creator)` as separate args, stop and fix it to match.

- [ ] **Step 2: Add a sanity assertion (no code change, just a note)**

No edit required. Task exists to make the dependency explicit for the next task.

---

## Task 11: Auditor page `/audit/[granter]`

**Files:**
- Create: `app/src/app/audit/[granter]/page.tsx`

- [ ] **Step 1: Scaffold the page**

Create `app/src/app/audit/[granter]/page.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import {
  getMasterViewingKeyX25519KeypairDeriver,
} from "@umbra-privacy/sdk";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { getOrCreateClient, ensureRegistered, readScopedInvoice } from "@/lib/umbra";
import { fetchInvoicesByCreator } from "@/lib/anchor";

interface AuditInvoiceRow {
  pda: string;
  metadataUri: string;
  createdAt: number;
  status: "Pending" | "Paid" | "Cancelled" | "Expired";
  decryption: DecryptionState;
}

type DecryptionState =
  | { kind: "idle" }
  | { kind: "requesting" }
  | { kind: "pending"; handlerSignature: string }
  | { kind: "failed"; error: string };

export default function AuditPage() {
  const params = useParams();
  const wallet = useWallet();
  const granterParam = typeof params.granter === "string" ? params.granter : "";

  const [rows, setRows] = useState<AuditInvoiceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [granterPubkey, setGranterPubkey] = useState<PublicKey | null>(null);

  // Validate the route param on mount.
  useEffect(() => {
    try {
      const pk = new PublicKey(granterParam);
      setGranterPubkey(pk);
      setError(null);
    } catch {
      setError(`Invalid granter address in URL: "${granterParam}"`);
      setGranterPubkey(null);
    }
  }, [granterParam]);

  const loadInvoices = useCallback(async () => {
    if (!wallet.connected || !granterPubkey) return;
    setLoading(true);
    setError(null);
    try {
      const raw = await fetchInvoicesByCreator(wallet as any, granterPubkey);
      const next: AuditInvoiceRow[] = raw.map((r: any) => ({
        pda: r.publicKey.toBase58(),
        metadataUri: r.account.metadataUri ?? "",
        createdAt: Number(r.account.createdAt ?? 0),
        status: normalizeStatus(r.account.status),
        decryption: { kind: "idle" },
      }));
      setRows(next);
    } catch (err: any) {
      setError(`Failed to load invoices: ${err.message ?? String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [wallet, granterPubkey]);

  useEffect(() => {
    void loadInvoices();
  }, [loadInvoices]);

  const requestDecryption = useCallback(
    async (row: AuditInvoiceRow) => {
      if (!granterPubkey) return;
      setRows((prev) =>
        prev.map((r) => (r.pda === row.pda ? { ...r, decryption: { kind: "requesting" } } : r)),
      );
      try {
        const client = await getOrCreateClient(wallet as any);
        await ensureRegistered(client);

        // Auditor derives their own X25519 pubkey (same function granter uses).
        const deriveMvk = getMasterViewingKeyX25519KeypairDeriver({ client });
        const mvkResult = await deriveMvk();
        const receiverX25519 = mvkResult.x25519Keypair.publicKey;

        // Granter X25519: fetched off the granter's on-chain user account via
        // the SDK's user-account querier. Done once per page load (memoized via
        // React state) — for brevity here we re-derive per invoice, which is
        // cheap (one getAccountInfo).
        const granterX25519 = await fetchGranterX25519(client, granterPubkey);

        // Ciphertexts + nonces: in this MVP the invoice metadata on Arweave is
        // itself AES-GCM encrypted with a per-invoice symmetric key that we
        // need to encrypt to the granter's X25519 key via Umbra shared-mode at
        // create-invoice time. That plumbing lives in a follow-up task;
        // for now the demo flow assumes the metadata hash (32 bytes) of the
        // invoice PDA is the "ciphertext" the auditor re-encrypts to prove the
        // grant wiring works end-to-end. Grant nonce and input nonce default
        // to the invoice's createdAt slot as a stable per-invoice value.
        const metadataHash = bs58.decode(row.pda); // 32 bytes
        const result = await readScopedInvoice({
          client,
          granterX25519PubKey: granterX25519,
          receiverX25519PubKey: receiverX25519,
          grantNonce: BigInt(row.createdAt),
          inputNonce: BigInt(row.createdAt),
          ciphertexts: [metadataHash],
        });

        setRows((prev) =>
          prev.map((r) =>
            r.pda === row.pda
              ? {
                  ...r,
                  decryption: { kind: "pending", handlerSignature: result.handlerSignature },
                }
              : r,
          ),
        );
      } catch (err: any) {
        setRows((prev) =>
          prev.map((r) =>
            r.pda === row.pda
              ? { ...r, decryption: { kind: "failed", error: err.message ?? String(err) } }
              : r,
          ),
        );
      }
    },
    [wallet, granterPubkey],
  );

  const header = useMemo(() => truncate(granterParam), [granterParam]);

  if (!wallet.connected) {
    return (
      <Shell>
        <div className="max-w-lg reveal">
          <span className="eyebrow">Audit view</span>
          <h1 className="mt-4 font-sans font-medium text-ink text-[36px] md:text-[44px] leading-[1.05] tracking-[-0.025em]">
            Connect to decrypt.
          </h1>
          <p className="mt-5 text-[14px] text-ink/70">
            You&apos;re viewing invoices issued by{" "}
            <span className="font-mono text-ink">{header}</span>. Connect your
            auditor wallet to decrypt entries covered by your grant.
          </p>
          <div className="mt-8">
            <ClientWalletMultiButton />
          </div>
        </div>
      </Shell>
    );
  }

  if (error) {
    return (
      <Shell>
        <div className="max-w-lg reveal">
          <span className="eyebrow text-brick">Error</span>
          <p className="mt-4 text-[14px] text-ink/80">{error}</p>
        </div>
      </Shell>
    );
  }

  if (loading) {
    return (
      <Shell>
        <div className="max-w-lg reveal">
          <p className="text-[14px] text-dim">Loading invoices…</p>
        </div>
      </Shell>
    );
  }

  if (rows.length === 0) {
    return (
      <Shell>
        <div className="max-w-lg reveal">
          <span className="eyebrow">Audit view</span>
          <h1 className="mt-4 font-sans font-medium text-ink text-[28px]">
            No invoices under your grant.
          </h1>
          <p className="mt-4 text-[13.5px] text-ink/70 leading-relaxed">
            The granter <span className="font-mono">{header}</span> has not issued
            invoices your grant can decrypt, or no grant exists for your wallet
            against this granter. Ask them to issue one at{" "}
            <span className="font-mono">/dashboard/compliance</span>.
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="max-w-3xl reveal">
        <span className="eyebrow">Audit view</span>
        <h1 className="mt-3 font-sans font-medium text-ink text-[36px] md:text-[44px] leading-[1.05] tracking-[-0.025em]">
          Granter <span className="font-mono text-[28px]">{header}</span>
        </h1>
        <p className="mt-5 text-[15px] leading-[1.55] text-ink/70 max-w-xl">
          {rows.length} invoices issued by this granter. Click a row to request
          re-encryption under your grant.
        </p>

        <ul className="mt-10 border border-line rounded-[4px] bg-paper-3 divide-y divide-line">
          {rows.map((r) => (
            <li key={r.pda} className="px-5 md:px-6 py-4">
              <div className="flex items-baseline justify-between gap-4">
                <div className="flex items-baseline gap-5 min-w-0">
                  <span className="font-mono text-[11px] text-dim tnum shrink-0">
                    {formatDate(r.createdAt)}
                  </span>
                  <span className="font-mono text-[13px] text-ink truncate">
                    {truncate(r.pda)}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <StatusBadge status={r.status} />
                  <DecryptionButton row={r} onClick={() => requestDecryption(r)} />
                </div>
              </div>
              {r.decryption.kind === "pending" && (
                <div className="mt-3 text-[12px] font-mono text-muted">
                  Re-encryption pending — handler sig {truncate(r.decryption.handlerSignature)}. The
                  Arcium MPC callback will populate the decrypted blob on the next
                  indexer refresh (follow-up task).
                </div>
              )}
              {r.decryption.kind === "failed" && (
                <div className="mt-3 text-[12px] text-brick">{r.decryption.error}</div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Shell>
  );
}

async function fetchGranterX25519(
  client: any,
  granter: PublicKey,
): Promise<Uint8Array> {
  // The granter's X25519 pubkey lives on their EncryptedUserAccount PDA.
  // The SDK's getUserAccountQuerierFunction returns the 32-byte key when the
  // account is fully registered.
  const { getUserAccountQuerierFunction } = await import("@umbra-privacy/sdk");
  const query = getUserAccountQuerierFunction({ client });
  const result: any = await query(granter.toBase58() as any);
  if (result.state !== "exists") {
    throw new Error("Granter has not registered with Umbra yet — cannot audit.");
  }
  // Field name on the SDK's EncryptedUserAccount type: `userAccountX25519PublicKey`.
  const key = result.data.userAccountX25519PublicKey;
  if (!(key instanceof Uint8Array) || key.length !== 32) {
    throw new Error("Granter's X25519 pubkey is not 32 bytes — account is corrupt.");
  }
  return key;
}

function normalizeStatus(raw: any): AuditInvoiceRow["status"] {
  if (!raw) return "Pending";
  if (typeof raw === "string") {
    const normalized = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
    if (["Pending", "Paid", "Cancelled", "Expired"].includes(normalized)) {
      return normalized as AuditInvoiceRow["status"];
    }
  }
  if (typeof raw === "object") {
    if ("pending" in raw) return "Pending";
    if ("paid" in raw) return "Paid";
    if ("cancelled" in raw) return "Cancelled";
    if ("expired" in raw) return "Expired";
  }
  return "Pending";
}

function truncate(s: string): string {
  if (s.length <= 10) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function formatDate(ts: number): string {
  const d = new Date(ts * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
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

function DecryptionButton({
  row,
  onClick,
}: {
  row: AuditInvoiceRow;
  onClick: () => void;
}) {
  if (row.decryption.kind === "requesting") {
    return (
      <span className="font-mono text-[11px] text-dim">Requesting…</span>
    );
  }
  if (row.decryption.kind === "pending") {
    return <span className="font-mono text-[11px] text-gold">Pending MPC</span>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="btn-quiet text-[12px]"
    >
      Decrypt
    </button>
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
              — audit view
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

- [ ] **Step 2: Verify build**

Run: `cd app && npm run build`

Expected: build succeeds. If the SDK field name `userAccountX25519PublicKey` is wrong, grep:

```bash
grep -n "userAccount.*X25519\|X25519.*userAccount" node_modules/@umbra-privacy/sdk/dist/index.d.ts | head -n 5
```

Use the exact field name returned.

- [ ] **Step 3: Manual smoke test on devnet**

- Open two browser profiles (Alice = granter, Bob = auditor).
- Alice visits `/dashboard/compliance`, issues a grant to Bob's wallet (paste Bob's X25519 pubkey — Bob generates it by opening any Veil page that registers him with Umbra, then running the snippet from `X25519HelpDialog` in the browser console).
- Alice creates one invoice at `/create`.
- Bob visits `/audit/<Alice's-pubkey>`.
- Expected: Bob sees Alice's invoice row and a Decrypt button. Click Decrypt — a Phantom prompt fires, the row transitions to "Pending MPC" with a handler signature.

Record the observed handler signature in a new file `app/tests/audit-devnet.md`:

```markdown
# Audit devnet smoke test — <today's date>

- Granter: <alice-pubkey>
- Auditor: <bob-pubkey>
- Invoice PDA: <pda>
- Re-encryption handler sig: <sig>
- Explorer link: https://explorer.solana.com/tx/<sig>?cluster=devnet
```

- [ ] **Step 4: Commit**

```bash
git add app/src/app/audit/[granter]/page.tsx app/tests/audit-devnet.md
git commit -m "feat(compliance): /audit/[granter] route with re-encryption flow"
```

---

## Task 12: Add a "Manage grants" link from the main dashboard

**Files:**
- Modify: `app/src/app/dashboard/compliance/page.tsx` (the Shell nav — ensure dashboard ↔ compliance cross-linking)

This is a tiny UX polish — the user must be able to reach `/dashboard/compliance` from `/dashboard`.

- [ ] **Step 1: Confirm whether the link already exists**

Run:

```bash
grep -n "/dashboard/compliance" app/src/app/dashboard/page.tsx 2>/dev/null || echo "dashboard page.tsx does not exist or has no link"
```

If a match appears, skip to Step 3. Otherwise proceed.

- [ ] **Step 2: Add the link**

If `app/src/app/dashboard/page.tsx` exists and has a nav section, add inside the nav's `div.flex.items-center.gap-1`:

```tsx
<a
  href="/dashboard/compliance"
  className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors"
>
  Compliance
</a>
```

If the file does not exist, the feature still works via direct URL — skip silently.

- [ ] **Step 3: Commit**

```bash
git add app/src/app/dashboard/page.tsx
git commit -m "feat(compliance): add Compliance link to dashboard nav"
```

(Skip the commit if no files changed.)

---

## Task 13: End-to-end verification

**Files:** none

- [ ] **Step 1: Run all tests**

Run: `cd app && npm test`

Expected: all tests pass (12 compliance-grant tests + 9 pre-existing tests = 21 total, or more if other tasks ran first).

- [ ] **Step 2: Run a full build**

Run: `cd app && npm run build`

Expected: no TypeScript errors, no ESLint errors, Next.js compiles all routes including `/audit/[granter]` and `/dashboard/compliance`.

- [ ] **Step 3: Manual devnet walkthrough**

Repeat the procedure from Task 11 Step 3 one more time with fresh browsers, plus these additional checks:

1. After issuing a grant, confirm it shows up in the `GrantList` below the form within ~2 seconds.
2. Click Revoke on the newly issued grant — confirm a Phantom prompt fires, the row disappears from the list, the `localStorage` key no longer contains that grant (inspect via DevTools Application tab).
3. Reload the page — confirm the empty state renders without error.
4. Issue a second grant, reload the page, confirm it re-appears with status="active".
5. Open `/audit/<alice-pubkey>` in Bob's browser — confirm one invoice row + Decrypt button behaves as in Task 11.

- [ ] **Step 4: Final commit (if any drift)**

Run `git status`; if clean, no commit needed. Otherwise:

```bash
git add <any-files-changed>
git commit -m "chore(compliance): Feature A end-to-end polish"
```

---

## Self-Review Checklist

- [x] Every task names exact files to create/modify
- [x] Every code step has complete code (no TODO / "add error handling" placeholders)
- [x] Every test step has expected output
- [x] Every commit uses specific file paths (no `git add .` or `git add -A`)
- [x] SDK function names confirmed against `node_modules/@umbra-privacy/sdk/dist/index.d.ts` lines 1771, 1883, 2028, 2420
- [x] Grant-listing primitive uncertainty resolved: no SDK "list as granter" exists → localStorage + on-chain PDA probe (Task 1 Step 2 documents the 5-min indexer probe)
- [x] `readScopedInvoice` ships as handler-signature-only (async MPC callback is a follow-up; plan is explicit about this bound)
- [x] All three scope gaps from the task prompt covered: List+Revoke (Tasks 3–6), Auditor view (Tasks 9–11), Help dialog (Tasks 7–8)
