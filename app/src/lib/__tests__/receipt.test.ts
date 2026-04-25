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
