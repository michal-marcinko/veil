// The legacy `encodeAuditPackage`/`decodeAuditPackage`/`buildAuditUrl`
// surface (master-sig embedded in URL fragment) was removed in favour of
// the scoped-grant flow in `auditor-links.ts`. Tests for that flow live
// in `auditor-links.test.ts`.
//
// What remains here: granter-side helpers (`decryptInvoiceWithMasterSig`,
// `decryptInvoicesWithMasterSig`) that turn the granter's own ciphertexts
// back into plaintext. We exercise them through the public `encryptJson`
// pipeline so we get a true round-trip without any Arweave I/O.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  decryptInvoiceWithMasterSig,
  decryptInvoicesWithMasterSig,
} from "@/lib/umbra-auditor";
import {
  deriveKeyFromMasterSig,
  encryptJson,
  sha256,
} from "@/lib/encryption";
import type { InvoiceMetadata } from "@/lib/types";

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
    line_items: [{ description: "work", quantity: "1", unit_price: "100", total: "100" }],
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
  for (let i = 0; i < 64; i++) out[i] = (i * 13 + 7) & 0xff;
  return out;
})();

// `decryptInvoiceWithMasterSig` calls `fetchCiphertext` from `./arweave`
// which goes over fetch(). We intercept fetch() in jsdom and serve a map
// of URI → bytes so the round-trip happens entirely in-process.
const blobStore = new Map<string, Uint8Array>();

beforeEach(() => {
  blobStore.clear();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const bytes = blobStore.get(url);
    if (!bytes) {
      return new Response(null, { status: 404 });
    }
    return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), {
      status: 200,
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function publishInvoice(
  pda: string,
  uri: string,
  md: InvoiceMetadata,
): Promise<{ ciphertext: Uint8Array; hash: Uint8Array }> {
  const key = await deriveKeyFromMasterSig(masterSig, pda);
  const ciphertext = await encryptJson(md, key);
  const hash = await sha256(ciphertext);
  blobStore.set(uri, ciphertext);
  return { ciphertext, hash };
}

describe("decryptInvoiceWithMasterSig", () => {
  it("decrypts a single invoice given the master sig + on-chain hash", async () => {
    const pda = "Pda1111111111111111111111111111111111111111";
    const uri = "https://arweave.net/blob-1";
    const md = makeInvoice("1");
    const { hash } = await publishInvoice(pda, uri, md);

    const decrypted = await decryptInvoiceWithMasterSig({
      invoicePda: pda,
      metadataUri: uri,
      metadataHash: hash,
      masterSig,
    });
    expect(decrypted).not.toBeNull();
    expect(decrypted?.invoice_id).toBe("inv_1");
    expect(decrypted?.payer.display_name).toBe("Payer 1");
  });

  it("returns null when the on-chain hash doesn't match (tamper guard)", async () => {
    const pda = "Pda2222222222222222222222222222222222222222";
    const uri = "https://arweave.net/blob-2";
    const md = makeInvoice("2");
    await publishInvoice(pda, uri, md);

    const wrongHash = new Uint8Array(32).fill(0xff);
    const decrypted = await decryptInvoiceWithMasterSig({
      invoicePda: pda,
      metadataUri: uri,
      metadataHash: wrongHash,
      masterSig,
    });
    expect(decrypted).toBeNull();
  });

  it("returns null when the metadataUri is empty", async () => {
    const decrypted = await decryptInvoiceWithMasterSig({
      invoicePda: "any",
      metadataUri: "",
      metadataHash: new Uint8Array(32),
      masterSig,
    });
    expect(decrypted).toBeNull();
  });
});

describe("decryptInvoicesWithMasterSig", () => {
  it("decrypts multiple invoices in parallel and skips failures", async () => {
    const pda1 = "PdaAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const pda2 = "PdaBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const uri1 = "https://arweave.net/blob-A";
    const uri2 = "https://arweave.net/blob-B";
    const md1 = makeInvoice("A");
    const md2 = makeInvoice("B");
    const { hash: hash1 } = await publishInvoice(pda1, uri1, md1);
    await publishInvoice(pda2, uri2, md2);
    // Force pda2 to fail by giving it a wrong hash.
    const wrongHash = new Uint8Array(32).fill(0xab);

    const result = await decryptInvoicesWithMasterSig({
      invoices: [
        {
          publicKey: { toBase58: () => pda1 },
          account: { metadataUri: uri1, metadataHash: hash1 },
        },
        {
          publicKey: { toBase58: () => pda2 },
          account: { metadataUri: uri2, metadataHash: wrongHash },
        },
      ],
      masterSig,
    });
    expect(result.size).toBe(1);
    expect(result.get(pda1)?.invoice_id).toBe("inv_A");
    expect(result.has(pda2)).toBe(false);
  });
});
