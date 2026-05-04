import * as ed from "@noble/ed25519";
import bs58 from "bs58";

export interface PaymentReceipt {
  version: 1;
  invoicePda: string;      // base58 PDA of the Invoice account
  payerPubkey: string;     // base58 of the wallet that signed this receipt intent
  markPaidTxSig: string;   // base58 payment-intent or mark-paid transaction signature
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
 * Parse a receipt from arbitrary user input — accepts:
 *   - the full verifier URL (`.../receipt/<pda>#<blob>`)
 *   - just the URL fragment (with or without leading `#`)
 *   - the raw base64url blob
 *
 * Returns both the decoded SignedReceipt and the invoice PDA from the URL
 * path when present. The path PDA is returned separately so the caller can
 * cross-check it against the receipt body — `decodeReceipt` only validates
 * the blob, not the URL framing.
 */
export function parseReceiptInput(
  input: string,
): { signed: SignedReceipt; pathPda: string | null } {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Receipt input is empty.");

  let blob = trimmed;
  let pathPda: string | null = null;

  // Full URL — pull the fragment + path PDA out.
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch (err) {
      throw new Error(`Receipt URL is malformed: ${String(err)}`);
    }
    if (!url.hash || url.hash.length < 2) {
      throw new Error("Receipt URL is missing its signed blob (no `#…` fragment).");
    }
    blob = url.hash.slice(1);
    // Path is `/receipt/<pda>` — pluck the segment after `receipt`.
    const segments = url.pathname.split("/").filter(Boolean);
    const idx = segments.indexOf("receipt");
    if (idx >= 0 && segments[idx + 1]) {
      pathPda = segments[idx + 1];
    }
  } else if (trimmed.startsWith("#")) {
    blob = trimmed.slice(1);
  }

  const signed = decodeReceipt(blob);
  return { signed, pathPda };
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
    // bs58.decode returns a Buffer; @noble/ed25519 2.x's strict
    // `Uint8Array.prototype === Object.getPrototypeOf(a)` check rejects
    // Buffer instances. Coerce to a plain Uint8Array view.
    const pub = new Uint8Array(bs58.decode(signed.receipt.payerPubkey));
    if (pub.length !== 32) return false;
    const sig = new Uint8Array(bs58.decode(signed.signature));
    if (sig.length !== 64) return false;
    const msg = canonicalReceiptBytes(signed.receipt);
    return await ed.verifyAsync(sig, msg, pub);
  } catch {
    return false;
  }
}
