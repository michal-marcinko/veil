// ---------------------------------------------------------------------------
// Scoped auditor links — per-grant ephemeral key + Arweave re-encryption.
//
// PROBLEM with the prior flow (now removed):
//   The audit URL embedded Alice's *master signature* in the fragment.
//   That key derives the per-invoice AES key for EVERY invoice Alice has
//   ever created. So sharing one audit link effectively handed the auditor
//   read access to her entire history — even invoices created after the
//   "grant" or outside the agreed scope. That undercut every claim about
//   scoped/revocable viewing.
//
// FIX (this file):
//   1. Alice picks a scope client-side (mint + date range).
//   2. Her browser decrypts ONLY the in-scope invoices using her cached
//      master sig (one popup, never sent over the wire).
//   3. We mint a fresh random 32-byte AES-GCM key K, re-encrypt each
//      in-scope invoice's metadata under K, and upload those re-encrypted
//      blobs to Arweave.
//   4. We build an audit URL whose fragment carries:
//          k=<base58 K> & inv=<comma-separated arweave-uris>
//      Both pieces are needed to read; the granter's master sig never
//      leaves her browser.
//
// "Revocation" caveats — be honest about scope:
//   * Arweave is permanent. Once a re-encrypted blob is uploaded, anyone
//     who knows its URI AND has K can decrypt it forever.
//   * Practical revocation = stop sharing the URL. Since K is ephemeral
//     (one per grant) and the URI list is finite, generating a new grant
//     for the same auditor leaves the old URL dangling but does not
//     retroactively unshare invoices that were in the prior scope.
//   * What we DO guarantee: invoices outside the chosen scope are not
//     reachable from the URL — there's no URI for them in `inv` and the
//     ephemeral key K can't decrypt anything other than the blobs we
//     re-encrypted under it. That is materially stronger than the master-
//     sig-in-URL flow.
// ---------------------------------------------------------------------------

import bs58 from "bs58";
import {
  decryptJson,
  deriveKeyFromMasterSig,
  encryptJson,
  generateKey,
  keyFromBase58,
  keyToBase58,
  sha256,
} from "./encryption";
import { fetchCiphertext, uploadCiphertext } from "./arweave";
import type { InvoiceMetadata } from "./types";

const EPHEMERAL_KEY_BYTES = 32; // AES-256-GCM key length

// ---------------------------------------------------------------------------
// Fragment parsing.
//
// The URL fragment is URL-search-parameter-shaped:
//     #k=<base58>&inv=<csv-of-arweave-uris>
// We use URLSearchParams so order-independence and percent-encoding are
// handled for free. The hash is intentionally not transmitted to servers
// by browsers, so K and the URI list never hit Veil's infrastructure.
// ---------------------------------------------------------------------------

export interface ScopedAuditPayload {
  /** 32-byte AES-256-GCM ephemeral key, fresh per grant. */
  ephemeralKey: Uint8Array;
  /** Arweave URIs (one per in-scope invoice) holding ciphertext under K. */
  invoiceUris: string[];
}

/**
 * Encode the ephemeral key + URI list into a URL fragment string. Returns
 * the part *after* the leading '#' so callers can compose URLs freely.
 */
export function encodeScopedAuditFragment(payload: ScopedAuditPayload): string {
  if (payload.ephemeralKey.length !== EPHEMERAL_KEY_BYTES) {
    throw new Error(
      `encodeScopedAuditFragment: ephemeral key must be ${EPHEMERAL_KEY_BYTES} bytes, got ${payload.ephemeralKey.length}`,
    );
  }
  for (const uri of payload.invoiceUris) {
    // Reject commas in URIs — they would corrupt the CSV. Arweave's gateway
    // URIs (`https://arweave.net/<id>`) never contain commas, but we guard
    // explicitly because a malformed URI here would silently lose invoices
    // when the auditor's browser splits on `,`.
    if (uri.includes(",")) {
      throw new Error(
        `encodeScopedAuditFragment: invoice URI contains comma, which would break the CSV: ${uri}`,
      );
    }
    if (uri.length === 0) {
      throw new Error("encodeScopedAuditFragment: invoice URI is empty");
    }
  }
  const params = new URLSearchParams();
  params.set("k", keyToBase58(payload.ephemeralKey));
  params.set("inv", payload.invoiceUris.join(","));
  return params.toString();
}

/**
 * Inverse of `encodeScopedAuditFragment`. Accepts either the bare
 * fragment string or one with a leading `#`. Throws on missing/invalid
 * fields so the caller can surface "URL is missing the decryption package".
 */
export function decodeScopedAuditFragment(fragment: string): ScopedAuditPayload {
  if (typeof fragment !== "string" || fragment.length === 0) {
    throw new Error("decodeScopedAuditFragment: fragment is empty");
  }
  const trimmed = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  if (trimmed.length === 0) {
    throw new Error("decodeScopedAuditFragment: fragment is empty");
  }
  const params = new URLSearchParams(trimmed);
  const k = params.get("k");
  const inv = params.get("inv");
  if (!k) throw new Error("decodeScopedAuditFragment: missing 'k' (ephemeral key)");
  if (inv === null) {
    throw new Error("decodeScopedAuditFragment: missing 'inv' (invoice URI list)");
  }
  const ephemeralKey = keyFromBase58(k); // throws if not 32 bytes
  const invoiceUris = inv.length === 0 ? [] : inv.split(",").filter((u) => u.length > 0);
  return { ephemeralKey, invoiceUris };
}

// ---------------------------------------------------------------------------
// Granter-side: build a scoped grant URL.
// ---------------------------------------------------------------------------

/**
 * What the granter knows about each in-scope invoice when generating a
 * scoped grant. We need:
 *   - `invoicePda`: stable identity, used to re-derive the per-invoice AES
 *     key from the master sig.
 *   - `metadataUri`: where the original (master-sig-encrypted) ciphertext
 *     lives, so we can fetch + re-encrypt under the ephemeral key.
 *   - `metadataHash`: integrity check on the fetched ciphertext.
 */
export interface InScopeInvoice {
  invoicePda: string;
  metadataUri: string;
  metadataHash: Uint8Array;
}

/**
 * Re-encrypt every in-scope invoice under a fresh ephemeral key and
 * upload the results to Arweave. Returns the ephemeral key + the new
 * Arweave URIs. The caller composes the audit URL.
 *
 * On a per-invoice failure (fetch blip, hash mismatch, decrypt error)
 * the invoice is *dropped* from the result rather than aborting the
 * whole grant — better to issue a partial grant than to nothing.
 * The caller should compare `invoiceUris.length` against the input
 * length and surface a warning if they differ.
 */
export async function generateScopedGrant(args: {
  masterSig: Uint8Array;
  invoices: InScopeInvoice[];
}): Promise<ScopedAuditPayload> {
  const ephemeralKey = generateKey();

  // Process invoices serially. We could parallelize, but Arweave uploads
  // hit our own /api/arweave-upload endpoint and burst traffic risks
  // 429s. The grant generation budget is small (typically <50 invoices)
  // and serial keeps the UX honest about progress.
  const invoiceUris: string[] = [];
  for (const inv of args.invoices) {
    try {
      // 1. Fetch original ciphertext from Arweave.
      const ciphertext = await fetchCiphertext(inv.metadataUri);

      // 2. Verify it matches the on-chain commitment — refuses to re-publish
      //    tampered data under our trust label.
      const digest = await sha256(ciphertext);
      if (!constantTimeEqual(digest, inv.metadataHash)) {
        // Skip this invoice; don't poison the audit set with mismatched data.
        continue;
      }

      // 3. Decrypt with the master-sig-derived per-invoice key.
      const perInvoiceKey = await deriveKeyFromMasterSig(
        args.masterSig,
        inv.invoicePda,
      );
      const md = (await decryptJson(ciphertext, perInvoiceKey)) as InvoiceMetadata;

      // 4. Re-encrypt under the ephemeral key and upload. We embed
      //    `_invoicePda` alongside the metadata so the auditor can derive
      //    the on-chain lock PDA and surface the actual settling wallet
      //    without needing a separate side-channel. The base field set
      //    of `InvoiceMetadata` is unchanged — auditors using older code
      //    that doesn't know about `_invoicePda` simply ignore it.
      const blob: ReencryptedBlob = { ...md, _invoicePda: inv.invoicePda };
      const reencrypted = await encryptJson(blob, ephemeralKey);
      const { uri } = await uploadCiphertext(reencrypted);
      invoiceUris.push(uri);
    } catch {
      // Drop this invoice from the grant set. The caller will see the
      // length delta and can warn the user.
      continue;
    }
  }

  return { ephemeralKey, invoiceUris };
}

/**
 * Convenience wrapper: produces the full sharable URL.
 *
 * @param origin - typically `window.location.origin`
 * @param grantId - any client-side identifier (e.g. nonce.toString()) used
 *                  for the path segment; aids logging + bookmarking.
 *                  No security weight — the actual access material is
 *                  in the fragment.
 */
export function buildScopedGrantUrl(args: {
  origin: string;
  grantId: string;
  payload: ScopedAuditPayload;
}): string {
  const fragment = encodeScopedAuditFragment(args.payload);
  return `${args.origin}/audit/grant/${encodeURIComponent(args.grantId)}#${fragment}`;
}

/**
 * Same shape, but for payroll batch links: `/audit/payroll/<batchId>#k=…&inv=…`.
 */
export function buildScopedPayrollAuditUrl(args: {
  origin: string;
  batchId: string;
  payload: ScopedAuditPayload;
}): string {
  const fragment = encodeScopedAuditFragment(args.payload);
  return `${args.origin}/audit/payroll/${encodeURIComponent(args.batchId)}#${fragment}`;
}

// ---------------------------------------------------------------------------
// Auditor-side: decrypt a scoped grant using only the URL fragment.
// ---------------------------------------------------------------------------

export interface DecryptedScopedGrantEntry {
  uri: string;
  metadata: InvoiceMetadata | null;
  /**
   * Base58 invoice PDA carried inside the re-encrypted blob so the auditor
   * can derive the on-chain `PaymentIntentLock` PDA and cross-check the
   * payer wallet against what's claimed in the metadata. Null for grants
   * issued before this field was added (graceful degradation).
   */
  invoicePda: string | null;
  error: string | null;
}

/**
 * Internal wire format for the re-encrypted blob. We piggy-back the
 * invoice PDA next to the original metadata so the auditor can recover
 * it without an extra side-channel. The shape is intentionally a
 * superset of `InvoiceMetadata` (so old code paths that decode straight
 * into `InvoiceMetadata` still work — extra fields are ignored by
 * `JSON.parse` consumers that don't know about them).
 */
interface ReencryptedBlob extends InvoiceMetadata {
  _invoicePda?: string;
}

/**
 * Fetch each Arweave blob from `payload.invoiceUris`, decrypt with
 * `payload.ephemeralKey`, and return one entry per URI.
 *
 * Failures don't abort the batch — they surface as `{ metadata: null,
 * error: "…" }` so the auditor UI can still render the rows that worked.
 *
 * Note: we *can't* re-verify against an on-chain hash here. The audit
 * page chooses to display the data as delivered by the granter; the
 * trust root for the auditor is the URL itself (which the granter sent
 * over a trusted side channel) plus the on-chain Umbra grant record
 * (proving the granter explicitly authorized the share).
 */
export async function decryptScopedGrant(
  payload: ScopedAuditPayload,
): Promise<DecryptedScopedGrantEntry[]> {
  // Parallel fetches + decrypts. Each failure is isolated to its own entry.
  return Promise.all(
    payload.invoiceUris.map(async (uri): Promise<DecryptedScopedGrantEntry> => {
      try {
        const ciphertext = await fetchCiphertext(uri);
        const blob = (await decryptJson(
          ciphertext,
          payload.ephemeralKey,
        )) as ReencryptedBlob;
        // Strip the wire-only `_invoicePda` field out of the metadata
        // we hand back, so consumers of `metadata` see only the canonical
        // `InvoiceMetadata` shape.
        const { _invoicePda, ...md } = blob;
        return {
          uri,
          metadata: md as InvoiceMetadata,
          invoicePda: typeof _invoicePda === "string" && _invoicePda.length > 0 ? _invoicePda : null,
          error: null,
        };
      } catch (err) {
        return {
          uri,
          metadata: null,
          invoicePda: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
