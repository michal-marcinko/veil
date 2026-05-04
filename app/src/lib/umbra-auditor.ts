// ---------------------------------------------------------------------------
// Granter-side helpers for browsing one's own encrypted invoice metadata.
//
// HISTORY: this module previously exported `encodeAuditPackage` /
// `decodeAuditPackage` / `buildAuditUrl`, which embedded Alice's 64-byte
// metadata master signature in the audit URL fragment. That was wrong:
// the master sig derives the AES key for EVERY invoice Alice has ever
// created (past and future), so a single audit link de facto handed the
// auditor unrestricted access. Even narrowing the on-chain Umbra grant
// did nothing — the URL itself was the leak.
//
// The current scoped-grant flow lives in `./auditor-links.ts`. It mints
// a fresh ephemeral AES-256-GCM key per grant, re-encrypts ONLY the in-
// scope invoices under it, uploads those to Arweave, and embeds
// `(ephemeralKey, [arweaveUris])` in the URL fragment. The master sig
// never leaves Alice's browser.
//
// What remains in this file: per-invoice decryption helpers Alice's own
// dashboard / scoped-grant generator uses to turn ciphertexts back into
// plaintext metadata. Those still need the master sig — but it's never
// transmitted, only used in-process.
// ---------------------------------------------------------------------------

import { deriveKeyFromMasterSig, decryptJson } from "./encryption";
import { fetchCiphertext } from "./arweave";
import type { InvoiceMetadata } from "./types";

function isVeilDebugEnabled(): boolean {
  return process.env.NEXT_PUBLIC_VEIL_DEBUG === "1";
}

function debugLog(message: string, details?: unknown) {
  if (!isVeilDebugEnabled()) return;
  // eslint-disable-next-line no-console
  console.log(message, details);
}

/**
 * Loads + decrypts a single invoice's metadata using the granter's master
 * signature. Resolves null on any failure (missing ciphertext, hash
 * mismatch, decrypt fail) — caller should treat absence as "this invoice
 * was created with the legacy per-PDA signMessage key and isn't decryptable
 * from this master sig".
 *
 * Used by the scoped-grant generator (`auditor-links.generateScopedGrant`)
 * indirectly (it calls these primitives), and any granter-side tooling
 * that needs to render the granter's own ciphertexts.
 */
export async function decryptInvoiceWithMasterSig(args: {
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
      debugLog("[granter] metadata hash length mismatch", {
        pda: args.invoicePda,
        expected: args.metadataHash.length,
        actual: actual.length,
      });
      return null;
    }
    for (let i = 0; i < actual.length; i++) {
      if (actual[i] !== args.metadataHash[i]) {
        debugLog("[granter] metadata hash mismatch — possible tamper", {
          pda: args.invoicePda,
        });
        return null;
      }
    }

    // Same derivation Alice's browser used at create time:
    // sha256(masterSig || "Veil invoice " || pdaBase58).
    const key = await deriveKeyFromMasterSig(args.masterSig, args.invoicePda);
    const md = (await decryptJson(ciphertext, key)) as InvoiceMetadata;
    return md;
  } catch (err) {
    debugLog("[granter] decryptInvoiceWithMasterSig failed", {
      pda: args.invoicePda,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Decrypt many invoices in parallel with the granter's master sig.
 * Returns a Map keyed by invoice PDA base58. Failures are absent from
 * the map.
 */
export async function decryptInvoicesWithMasterSig(args: {
  invoices: Array<{
    publicKey: { toBase58(): string };
    account: { metadataUri: string; metadataHash: number[] | Uint8Array };
  }>;
  masterSig: Uint8Array;
}): Promise<Map<string, InvoiceMetadata>> {
  const results = await Promise.all(
    args.invoices.map(async (inv) => {
      const pda = inv.publicKey.toBase58();
      const hash =
        inv.account.metadataHash instanceof Uint8Array
          ? inv.account.metadataHash
          : new Uint8Array(inv.account.metadataHash);
      const md = await decryptInvoiceWithMasterSig({
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
