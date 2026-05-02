// ---------------------------------------------------------------------------
// Auditor-side decryption helpers for the Alice-attested audit package.
//
// The on-chain compliance grant (`issueComplianceGrant` in `./umbra.ts`) only
// proves AUTHORIZATION — it does not, on its own, give Carol the AES key
// needed to decrypt invoice metadata stored on Arweave. Per-invoice keys are
// derived from Alice's wallet-scoped 64-byte ed25519 master signature
// (`getOrCreateMetadataMasterSig`), which never leaves Alice's browser.
//
// To actually let Carol see the data, Alice generates an audit URL that
// embeds the master signature in the URL fragment (so it never hits the
// server) and shares it with Carol over a trusted side-channel (Signal,
// encrypted email, …). Carol pastes the URL; this module decodes the
// fragment, fetches each ciphertext from Arweave, derives the per-invoice
// key with the same algorithm Alice used, and decrypts.
//
// Same fragment-as-key model the pay-link flow uses (`extractKeyFromFragment`
// in `./encryption.ts`) — the difference is that pay links embed a 32-byte
// AES key for one invoice, whereas audit links embed a 64-byte master sig
// that derives keys for ALL of Alice's invoices.
// ---------------------------------------------------------------------------

import bs58 from "bs58";
import { deriveKeyFromMasterSig, decryptJson } from "./encryption";
import { fetchCiphertext } from "./arweave";
import type { InvoiceMetadata } from "./types";

const MASTER_SIG_BYTES = 64; // ed25519 signature length

function isVeilDebugEnabled(): boolean {
  return process.env.NEXT_PUBLIC_VEIL_DEBUG === "1";
}

function debugLog(message: string, details?: unknown) {
  if (!isVeilDebugEnabled()) return;
  // eslint-disable-next-line no-console
  console.log(message, details);
}

/**
 * Encode the metadata master sig as a base58-only URL fragment payload.
 * 64-byte masterSig → base58 string. Mirrors the pay link's `keyToBase58`,
 * but for a 64-byte signature instead of a 32-byte AES key.
 */
export function encodeAuditPackage(masterSig: Uint8Array): string {
  if (masterSig.length !== MASTER_SIG_BYTES) {
    throw new Error(
      `Invalid masterSig length: expected ${MASTER_SIG_BYTES} bytes, got ${masterSig.length}`,
    );
  }
  return bs58.encode(masterSig);
}

/**
 * Inverse of `encodeAuditPackage`. Throws on length/format mismatch.
 * Accepts either a bare base58 string or a leading `#` (URL fragment).
 */
export function decodeAuditPackage(fragment: string): Uint8Array {
  if (typeof fragment !== "string" || fragment.length === 0) {
    throw new Error("decodeAuditPackage: fragment is empty");
  }
  const trimmed = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  if (trimmed.length === 0) {
    throw new Error("decodeAuditPackage: fragment is empty");
  }
  const decoded = bs58.decode(trimmed);
  if (decoded.length !== MASTER_SIG_BYTES) {
    throw new Error(
      `decodeAuditPackage: expected ${MASTER_SIG_BYTES} bytes, got ${decoded.length}`,
    );
  }
  return decoded;
}

/**
 * Build the final audit URL Alice copies to share with Carol out-of-band.
 * The masterSig lives in the URL fragment, which browsers don't transmit
 * to servers — so the decryption material never hits Veil's infrastructure.
 */
export function buildAuditUrl(opts: {
  origin: string;
  granterWallet: string;
  masterSig: Uint8Array;
}): string {
  const fragment = encodeAuditPackage(opts.masterSig);
  return `${opts.origin}/audit/${opts.granterWallet}#${fragment}`;
}

/**
 * Loads + decrypts a single invoice's metadata for the audit view.
 * Resolves null on any failure (missing ciphertext, hash mismatch, decrypt
 * fail) — caller should treat absence as "this invoice was created with
 * the legacy per-PDA signMessage key and isn't decryptable from this
 * audit package" and surface "—" in the UI.
 */
export async function decryptInvoiceForAudit(args: {
  invoicePda: string;
  metadataUri: string;
  metadataHash: Uint8Array;
  masterSig: Uint8Array;
}): Promise<InvoiceMetadata | null> {
  try {
    if (!args.metadataUri) return null;
    const ciphertext = await fetchCiphertext(args.metadataUri);

    // Tamper check — Arweave content must hash to the on-chain commitment.
    const digest = await crypto.subtle.digest("SHA-256", ciphertext);
    const actual = new Uint8Array(digest);
    if (actual.length !== args.metadataHash.length) {
      debugLog("[audit] metadata hash length mismatch", {
        pda: args.invoicePda,
        expected: args.metadataHash.length,
        actual: actual.length,
      });
      return null;
    }
    for (let i = 0; i < actual.length; i++) {
      if (actual[i] !== args.metadataHash[i]) {
        debugLog("[audit] metadata hash mismatch — possible tamper", {
          pda: args.invoicePda,
        });
        return null;
      }
    }

    // Same derivation Alice's browser used: sha256(masterSig || "Veil
    // invoice " || pdaBase58). Reuses `deriveKeyFromMasterSig` to keep the
    // algorithm in lockstep.
    const key = await deriveKeyFromMasterSig(args.masterSig, args.invoicePda);
    const md = (await decryptJson(ciphertext, key)) as InvoiceMetadata;
    return md;
  } catch (err) {
    debugLog("[audit] decryptInvoiceForAudit failed", {
      pda: args.invoicePda,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Decrypt all decryptable invoices in parallel. Returns a Map keyed by
 * invoice PDA base58. Failures are absent from the map — the audit UI
 * should fall back to "—" for those rows.
 */
export async function decryptInvoicesForAudit(args: {
  invoices: Array<{
    publicKey: { toBase58(): string };
    account: { metadataUri: string; metadataHash: number[] | Uint8Array };
  }>;
  masterSig: Uint8Array;
}): Promise<Map<string, InvoiceMetadata>> {
  const results = await Promise.all(
    args.invoices.map(async (inv) => {
      const pda = inv.publicKey.toBase58();
      const hash = inv.account.metadataHash instanceof Uint8Array
        ? inv.account.metadataHash
        : new Uint8Array(inv.account.metadataHash);
      const md = await decryptInvoiceForAudit({
        invoicePda: pda,
        metadataUri: inv.account.metadataUri,
        metadataHash: hash,
        masterSig: args.masterSig,
      });
      return { pda, md };
    }),
  );
  const out = new Map<string, InvoiceMetadata>();
  for (const { pda, md } of results) {
    if (md) out.set(pda, md);
  }
  return out;
}
