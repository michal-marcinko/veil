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
