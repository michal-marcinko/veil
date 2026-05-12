// Round-trip + scoping tests for `auditor-links`. Verifies:
//   1. The fragment encode/decode is symmetric and rejects malformed input.
//   2. End-to-end: granter generates a scoped grant from a fake-Arweave
//      blob store; auditor decrypts using only the URL fragment payload.
//   3. The ephemeral key is fresh per call and is unable to decrypt
//      invoices that weren't included in the scope (the whole point of
//      this refactor).

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildScopedGrantUrl,
  buildScopedPayrollAuditUrl,
  decodeScopedAuditFragment,
  decryptScopedGrant,
  encodeScopedAuditFragment,
  generateScopedGrant,
  type InScopeInvoice,
} from "@/lib/auditor-links";
import {
  deriveKeyFromMasterSig,
  encryptJson,
  keyFromBase58,
  sha256,
} from "@/lib/encryption";
import type { InvoiceMetadata } from "@/lib/types";

// ---- Test scaffolding -----------------------------------------------------

function makeInvoice(idSuffix: string): InvoiceMetadata {
  return {
    version: 1,
    invoice_id: `inv_${idSuffix}`,
    created_at: "2026-04-15T00:00:00Z",
    creator: {
      display_name: "Alice",
      wallet: "Alice1111111111111111111111111111111111111",
      contact: null,
      logo_url: null,
    },
    payer: {
      display_name: `Payer ${idSuffix}`,
      wallet: null,
      contact: null,
    },
    currency: { mint: "MINT", symbol: "USDC", decimals: 6 },
    line_items: [
      { description: "work", quantity: "1", unit_price: "100", total: "100" },
    ],
    subtotal: "100",
    tax: "0",
    total: "100",
    due_date: null,
    terms: null,
    notes: null,
  };
}

const masterSig = (() => {
  const out = new Uint8Array(64);
  for (let i = 0; i < 64; i++) out[i] = (i * 17 + 5) & 0xff;
  return out;
})();

// In-memory Arweave: GETs read from the map; POSTs (uploads) push and
// return a synthetic URI. The keystone of the round-trip test.
const blobStore = new Map<string, Uint8Array>();
let uploadCounter = 0;

beforeEach(() => {
  blobStore.clear();
  uploadCounter = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (init?.method === "POST" && url.endsWith("/api/arweave-upload")) {
      // Body is a Uint8Array (BodyInit).
      const body = init.body as ArrayBuffer | Uint8Array;
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
      const id = `tx_${uploadCounter++}`;
      const uri = `https://arweave.net/${id}`;
      // Store a copy so callers can mutate the source buffer without breaking us.
      blobStore.set(uri, new Uint8Array(bytes));
      return new Response(JSON.stringify({ id, uri }), { status: 200 });
    }
    const bytes = blobStore.get(url);
    if (!bytes) {
      return new Response(null, { status: 404 });
    }
    return new Response(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      { status: 200 },
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function publishInvoiceUnderMasterSig(
  pda: string,
  uri: string,
  md: InvoiceMetadata,
): Promise<Uint8Array> {
  const key = await deriveKeyFromMasterSig(masterSig, pda);
  const ciphertext = await encryptJson(md, key);
  const hash = await sha256(ciphertext);
  blobStore.set(uri, ciphertext);
  return hash;
}

// ---- Fragment encode/decode ----------------------------------------------

describe("encodeScopedAuditFragment / decodeScopedAuditFragment", () => {
  it("round-trips a 32-byte ephemeral key + URI list", () => {
    const k = new Uint8Array(32);
    for (let i = 0; i < 32; i++) k[i] = (i * 5 + 1) & 0xff;
    const uris = [
      "https://arweave.net/abc",
      "https://arweave.net/def",
      "https://arweave.net/ghi",
    ];
    const fragment = encodeScopedAuditFragment({
      ephemeralKey: k,
      invoiceUris: uris,
    });
    expect(fragment).toContain("k=");
    expect(fragment).toContain("inv=");

    const decoded = decodeScopedAuditFragment(fragment);
    expect(decoded.ephemeralKey.length).toBe(32);
    expect(Array.from(decoded.ephemeralKey)).toEqual(Array.from(k));
    expect(decoded.invoiceUris).toEqual(uris);
  });

  it("supports a leading '#' on the fragment", () => {
    const k = new Uint8Array(32).fill(7);
    const fragment = encodeScopedAuditFragment({
      ephemeralKey: k,
      invoiceUris: ["https://arweave.net/x"],
    });
    const decoded = decodeScopedAuditFragment(`#${fragment}`);
    expect(decoded.invoiceUris).toEqual(["https://arweave.net/x"]);
  });

  it("supports a zero-invoice grant (returns empty list, not error)", () => {
    const k = new Uint8Array(32).fill(1);
    const fragment = encodeScopedAuditFragment({
      ephemeralKey: k,
      invoiceUris: [],
    });
    const decoded = decodeScopedAuditFragment(fragment);
    expect(decoded.invoiceUris).toEqual([]);
  });

  it("encode rejects wrong-length ephemeral key", () => {
    expect(() =>
      encodeScopedAuditFragment({
        ephemeralKey: new Uint8Array(16),
        invoiceUris: [],
      }),
    ).toThrow(/32 bytes/);
  });

  it("encode rejects URI containing comma", () => {
    expect(() =>
      encodeScopedAuditFragment({
        ephemeralKey: new Uint8Array(32),
        invoiceUris: ["https://arweave.net/a,b"],
      }),
    ).toThrow(/comma/);
  });

  it("decode rejects missing 'k' or 'inv'", () => {
    expect(() => decodeScopedAuditFragment("inv=https://arweave.net/x")).toThrow(/'k'/);
    const k = new Uint8Array(32).fill(1);
    const fragOnlyK = `k=${require("bs58").encode(k)}`;
    expect(() => decodeScopedAuditFragment(fragOnlyK)).toThrow(/'inv'/);
  });

  it("decode rejects empty fragment", () => {
    expect(() => decodeScopedAuditFragment("")).toThrow();
    expect(() => decodeScopedAuditFragment("#")).toThrow();
  });
});

// ---- URL builders --------------------------------------------------------

describe("buildScopedGrantUrl / buildScopedPayrollAuditUrl", () => {
  it("invoice grant URL has the right path + carries the fragment", () => {
    const k = new Uint8Array(32).fill(2);
    const url = buildScopedGrantUrl({
      origin: "https://veil.app",
      grantId: "grant_42",
      payload: { ephemeralKey: k, invoiceUris: ["https://arweave.net/abc"] },
    });
    expect(url.startsWith("https://veil.app/audit/grant/grant_42#")).toBe(true);
    const fragment = url.split("#")[1];
    const decoded = decodeScopedAuditFragment(fragment);
    expect(decoded.invoiceUris).toEqual(["https://arweave.net/abc"]);
  });

  it("payroll URL goes to /audit/payroll/<batchId>", () => {
    const k = new Uint8Array(32).fill(3);
    const url = buildScopedPayrollAuditUrl({
      origin: "https://veil.app",
      batchId: "payroll_abc_xyz",
      payload: { ephemeralKey: k, invoiceUris: [] },
    });
    expect(url.startsWith("https://veil.app/audit/payroll/payroll_abc_xyz#")).toBe(true);
  });
});

// ---- End-to-end round-trip ------------------------------------------------

describe("generateScopedGrant + decryptScopedGrant (round-trip)", () => {
  it("granter packages 2 invoices; auditor decrypts both with only the fragment", async () => {
    const pda1 = "PdaAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const pda2 = "PdaBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const md1 = makeInvoice("A");
    const md2 = makeInvoice("B");
    const hash1 = await publishInvoiceUnderMasterSig(
      pda1,
      "https://arweave.net/orig-A",
      md1,
    );
    const hash2 = await publishInvoiceUnderMasterSig(
      pda2,
      "https://arweave.net/orig-B",
      md2,
    );

    const inScope: InScopeInvoice[] = [
      { invoicePda: pda1, metadataUri: "https://arweave.net/orig-A", metadataHash: hash1 },
      { invoicePda: pda2, metadataUri: "https://arweave.net/orig-B", metadataHash: hash2 },
    ];

    const payload = await generateScopedGrant({ masterSig, invoices: inScope });
    expect(payload.ephemeralKey.length).toBe(32);
    expect(payload.invoiceUris.length).toBe(2);

    const decrypted = await decryptScopedGrant(payload);
    expect(decrypted.length).toBe(2);
    const ids = decrypted.map((d) => d.metadata?.invoice_id).sort();
    expect(ids).toEqual(["inv_A", "inv_B"]);
    expect(decrypted.every((d) => d.error === null)).toBe(true);
  });

  it("ephemeral key is fresh on every call and cannot decrypt out-of-scope invoices", async () => {
    // Setup: 3 invoices exist; only 1 is in scope.
    const pda1 = "PdaScope1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const pda2 = "PdaOutAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const pda3 = "PdaOutBxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const md1 = makeInvoice("scope1");
    const md2 = makeInvoice("outA");
    const md3 = makeInvoice("outB");
    const hash1 = await publishInvoiceUnderMasterSig(
      pda1,
      "https://arweave.net/orig-S1",
      md1,
    );
    await publishInvoiceUnderMasterSig(pda2, "https://arweave.net/orig-OA", md2);
    await publishInvoiceUnderMasterSig(pda3, "https://arweave.net/orig-OB", md3);

    const payloadA = await generateScopedGrant({
      masterSig,
      invoices: [
        { invoicePda: pda1, metadataUri: "https://arweave.net/orig-S1", metadataHash: hash1 },
      ],
    });
    const payloadB = await generateScopedGrant({
      masterSig,
      invoices: [
        { invoicePda: pda1, metadataUri: "https://arweave.net/orig-S1", metadataHash: hash1 },
      ],
    });

    // Different ephemeral keys per call.
    expect(Array.from(payloadA.ephemeralKey)).not.toEqual(Array.from(payloadB.ephemeralKey));

    // Auditor receiving payloadA cannot see invoices that weren't included
    // in the scope — there are no URIs for them and the ephemeral key
    // wouldn't decrypt the originals anyway.
    expect(payloadA.invoiceUris.length).toBe(1);
    const decrypted = await decryptScopedGrant(payloadA);
    expect(decrypted.length).toBe(1);
    expect(decrypted[0].metadata?.invoice_id).toBe("inv_scope1");

    // Sanity: even if the auditor somehow learned the URIs of out-of-scope
    // invoices, payloadA.ephemeralKey can't decrypt them — they were
    // encrypted with the per-invoice key derived from the master sig, not
    // with the ephemeral key.
    const outOfScopeAttempt = await decryptScopedGrant({
      ephemeralKey: payloadA.ephemeralKey,
      invoiceUris: ["https://arweave.net/orig-OA", "https://arweave.net/orig-OB"],
    });
    expect(outOfScopeAttempt.every((d) => d.metadata === null)).toBe(true);
    expect(outOfScopeAttempt.every((d) => d.error !== null)).toBe(true);
  });

  it("drops invoices that fail to fetch (partial grant rather than full abort)", async () => {
    const pda1 = "PdaOkayxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const pda2 = "PdaMissxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const md1 = makeInvoice("ok");
    const hash1 = await publishInvoiceUnderMasterSig(
      pda1,
      "https://arweave.net/orig-OK",
      md1,
    );

    // pda2's ciphertext URI won't be in the blob store → fetch returns 404.
    const payload = await generateScopedGrant({
      masterSig,
      invoices: [
        { invoicePda: pda1, metadataUri: "https://arweave.net/orig-OK", metadataHash: hash1 },
        {
          invoicePda: pda2,
          metadataUri: "https://arweave.net/orig-MISSING",
          metadataHash: new Uint8Array(32),
        },
      ],
    });

    expect(payload.invoiceUris.length).toBe(1);
    const decrypted = await decryptScopedGrant(payload);
    expect(decrypted.length).toBe(1);
    expect(decrypted[0].metadata?.invoice_id).toBe("inv_ok");
  });
});

// ---- Sanity: ephemeral key is base58-decodable as a 32-byte AES key ------

describe("ephemeral key shape", () => {
  it("encoded key in fragment decodes to a usable 32-byte AES-GCM key", async () => {
    const payload = await generateScopedGrant({ masterSig, invoices: [] });
    const fragment = encodeScopedAuditFragment(payload);
    const params = new URLSearchParams(fragment);
    const k = params.get("k")!;
    const decoded = keyFromBase58(k);
    expect(decoded.length).toBe(32);
  });
});
