// ---------------------------------------------------------------------------
// Cross-device payroll-run storage.
//
// Mirrors the invoice-metadata pattern (encrypted blob on Arweave, opaque
// per-wallet tag, fast-path localStorage cache) so the dashboard's
// "Activity → Payroll runs" tab is populated from any device the user
// connects with.
//
// Crypto contract — same shape as invoice metadata, audited path:
//
//   masterSig = wallet.signMessage("Veil metadata master key v1")    // cached
//   indexTag  = sha256(masterSig || "Veil payroll-runs index v1")    // opaque
//   salt      = randomBytes(16)                                      // per upload
//   key       = sha256(masterSig || salt)                            // per upload
//   blob      = salt || AES-GCM(key, JSON(SignedPayrollPacket))      // uploaded
//
// What an outsider with the user's PUBLIC key only sees:
//   - The Arweave transaction exists.
//   - It carries a `Veil-Index` tag with an opaque hash.
//   - It is some bytes.
// They cannot:
//   - Compute the indexTag (no master sig).
//   - List the user's runs (would need indexTag to query).
//   - Decrypt any blob (would need master sig + the salt-derived key).
//
// Observable side-effects worth flagging:
//   - The TOTAL number of `Veil-Index` blobs across all wallets is visible
//     by querying Arweave for any tag named `Veil-Index`. We accept this:
//     it leaks aggregate Veil usage volume, but never per-wallet.
// ---------------------------------------------------------------------------

import {
  encryptJson,
  decryptJson,
  getOrCreateMetadataMasterSig,
} from "@/lib/encryption";
import {
  arweaveGatewayUrl,
  fetchCiphertext,
  queryArweaveByTag,
  uploadCiphertextWithTags,
} from "@/lib/arweave";
import type { SignedPayrollPacket } from "@/lib/private-payroll";

/* ─────────────────────────── localStorage cache ─────────────────────────── */

const CACHE_PREFIX = "veil:payrollRuns:";
const CACHE_MAX_ENTRIES = 100;

/** A single cached run entry. We persist the Arweave tx ID alongside the
 *  signed packet so the sync code can dedupe by ID without re-decrypting
 *  every cached entry on every reconcile. */
export interface CachedPayrollRun {
  signed: SignedPayrollPacket;
  /** Arweave transaction id of the encrypted upload. Optional because
   *  legacy local-only entries (created before this module shipped)
   *  won't have one — they'll get one the next time they're re-saved. */
  arweaveTxId?: string;
  /** Wall-clock ms when this entry was added to the cache. Used for
   *  ordering when sync brings in older runs from other devices. */
  cachedAt: number;
}

function cacheKey(walletBase58: string): string {
  return `${CACHE_PREFIX}${walletBase58}`;
}

function safeStorage(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Read the cached runs for this wallet, sorted newest → oldest by the
 * packet's createdAt timestamp. Defensive about shape because old
 * versions of this code wrote raw `SignedPayrollPacket[]` (no wrapping
 * object) — we accept both for backwards compatibility.
 */
export function loadCachedPayrollRuns(walletBase58: string): CachedPayrollRun[] {
  const storage = safeStorage();
  if (!storage) return [];
  const raw = (() => {
    try {
      return storage.getItem(cacheKey(walletBase58));
    } catch {
      return null;
    }
  })();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: CachedPayrollRun[] = [];
  for (const entry of parsed) {
    // New shape: { signed, arweaveTxId?, cachedAt }
    if (
      entry &&
      typeof entry === "object" &&
      (entry as any).signed &&
      typeof (entry as any).signed === "object"
    ) {
      const signed = (entry as any).signed as SignedPayrollPacket;
      if (isValidSignedPacket(signed)) {
        out.push({
          signed,
          arweaveTxId:
            typeof (entry as any).arweaveTxId === "string"
              ? ((entry as any).arweaveTxId as string)
              : undefined,
          cachedAt:
            typeof (entry as any).cachedAt === "number"
              ? ((entry as any).cachedAt as number)
              : Date.parse(signed.packet.createdAt) || 0,
        });
      }
      continue;
    }
    // Legacy shape: bare SignedPayrollPacket. Wrap and adopt.
    if (isValidSignedPacket(entry)) {
      out.push({
        signed: entry as SignedPayrollPacket,
        arweaveTxId: undefined,
        cachedAt: Date.parse((entry as SignedPayrollPacket).packet.createdAt) || 0,
      });
    }
  }
  return out.sort(
    (a, b) =>
      Date.parse(b.signed.packet.createdAt) - Date.parse(a.signed.packet.createdAt),
  );
}

function isValidSignedPacket(value: any): value is SignedPayrollPacket {
  return (
    !!value &&
    typeof value === "object" &&
    value.packet &&
    typeof value.packet === "object" &&
    typeof value.packet.batchId === "string" &&
    Array.isArray(value.packet.rows) &&
    typeof value.signature === "string"
  );
}

/**
 * Compatibility shim for the existing dashboard code that imports
 * loadPayrollRuns and expects `SignedPayrollPacket[]`. The dashboard
 * already has its own loader; this is exported so external callers
 * (current + future) can read the cache without re-importing the
 * dashboard module.
 */
export function loadCachedSignedPackets(walletBase58: string): SignedPayrollPacket[] {
  return loadCachedPayrollRuns(walletBase58).map((e) => e.signed);
}

/**
 * Write the cache, capped + dedup'd by batchId. Newer entries win on
 * collision (re-runs of the same batchId update the cached copy
 * rather than piling up duplicates).
 *
 * Notifies same-tab listeners via a synthetic StorageEvent so any open
 * dashboard tab can re-hydrate without a hard reload.
 */
function writeCache(walletBase58: string, runs: CachedPayrollRun[]): void {
  const storage = safeStorage();
  if (!storage) return;
  const key = cacheKey(walletBase58);
  // Dedupe by batchId — last write wins.
  const byBatch = new Map<string, CachedPayrollRun>();
  for (const r of runs) byBatch.set(r.signed.packet.batchId, r);
  const arr = Array.from(byBatch.values()).sort(
    (a, b) =>
      Date.parse(b.signed.packet.createdAt) - Date.parse(a.signed.packet.createdAt),
  );
  if (arr.length > CACHE_MAX_ENTRIES) arr.length = CACHE_MAX_ENTRIES;
  try {
    storage.setItem(key, JSON.stringify(arr));
    try {
      window.dispatchEvent(new StorageEvent("storage", { key }));
    } catch {
      // jsdom etc. — silently skip; cross-tab listeners still fire via
      // the native storage event in production.
    }
  } catch {
    // Quota exceeded / private browsing. The packet's JSON + PDF
    // downloads remain the source of truth — cache loss is recoverable.
  }
}

/* ─────────────────────────── crypto helpers ─────────────────────────── */

/**
 * Derive an opaque, wallet-specific tag value used to index payroll-run
 * uploads. Non-invertible without the master sig; deterministic per
 * wallet so cross-device discovery works.
 */
async function derivePayrollIndexTag(masterSig: Uint8Array): Promise<string> {
  const message = new TextEncoder().encode("Veil payroll-runs index v1");
  const buf = new Uint8Array(masterSig.length + message.length);
  buf.set(masterSig, 0);
  buf.set(message, masterSig.length);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return bytesToHex(new Uint8Array(hash));
}

/**
 * Per-upload encryption key. The salt is 16 random bytes prepended to
 * the ciphertext blob, so anyone with the master sig can decrypt later
 * without out-of-band coordination of the salt. New device → fetches
 * blob → reads salt off the front → derives same key.
 */
async function deriveKeyForBlob(
  masterSig: Uint8Array,
  salt: Uint8Array,
): Promise<Uint8Array> {
  const buf = new Uint8Array(masterSig.length + salt.length);
  buf.set(masterSig, 0);
  buf.set(salt, masterSig.length);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return new Uint8Array(hash);
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/* ─────────────────────────── public API ─────────────────────────── */

/**
 * Persist a freshly-signed payroll packet:
 *   1. Encrypt with a per-blob key derived from masterSig + random salt
 *   2. Upload blob (= salt || ciphertext) to Arweave with the wallet's
 *      opaque indexTag attached
 *   3. Update the localStorage cache
 *
 * Both the Arweave upload AND the cache write are best-effort and
 * isolated: a failure in (1)/(2) still cuts a cache write so the user
 * sees the run on the dashboard locally; a failure in (3) doesn't
 * undo the upload. The cache is recoverable from the Arweave copy on
 * any future sync, so we'd rather double-write than lose either side.
 */
export async function persistPayrollRun(args: {
  wallet: { signMessage?: (msg: Uint8Array) => Promise<Uint8Array> };
  walletBase58: string;
  signed: SignedPayrollPacket;
}): Promise<{ arweaveTxId: string | null; uploaded: boolean }> {
  const { wallet, walletBase58, signed } = args;

  // Always write the local cache first — that's the user's instant
  // feedback. Arweave upload is the cross-device sync layer beneath.
  const existing = loadCachedPayrollRuns(walletBase58);
  const now = Date.now();
  const localOnlyEntry: CachedPayrollRun = {
    signed,
    arweaveTxId: undefined,
    cachedAt: now,
  };
  writeCache(walletBase58, [localOnlyEntry, ...existing]);

  // Now attempt the Arweave upload. If anything throws, we leave the
  // local cache intact and surface { uploaded: false } so the caller
  // can display a quiet warning.
  try {
    const masterSig = await getOrCreateMetadataMasterSig(wallet, walletBase58);
    const salt = new Uint8Array(16);
    crypto.getRandomValues(salt);
    const key = await deriveKeyForBlob(masterSig, salt);
    const ciphertext = await encryptJson(signed, key);
    const blob = new Uint8Array(salt.length + ciphertext.length);
    blob.set(salt, 0);
    blob.set(ciphertext, salt.length);

    const indexTag = await derivePayrollIndexTag(masterSig);
    const { id } = await uploadCiphertextWithTags(blob, [
      { name: "Veil-Index", value: indexTag },
    ]);

    // Re-read cache (someone else may have written between our two
    // writes — be defensive) and stamp the Arweave tx ID into the
    // entry so future syncs don't re-fetch this same blob.
    const post = loadCachedPayrollRuns(walletBase58).map((entry) =>
      entry.signed.packet.batchId === signed.packet.batchId
        ? { ...entry, arweaveTxId: id }
        : entry,
    );
    writeCache(walletBase58, post);
    return { arweaveTxId: id, uploaded: true };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[payroll-runs] Arweave upload failed (local cache kept)", err);
    return { arweaveTxId: null, uploaded: false };
  }
}

export interface SyncResult {
  /** New entries fetched from Arweave that weren't already cached. */
  added: number;
  /** Total entries in the cache after sync. */
  total: number;
  /** Errors during decrypt/fetch — surfaced for telemetry but not fatal. */
  errors: string[];
}

/**
 * Pull payroll runs from Arweave that aren't in the local cache, decrypt
 * them, and merge into the cache. Idempotent — running it twice in a
 * row on the same device adds nothing the second time.
 *
 * Skipped silently when the wallet has no signMessage (i.e. read-only
 * adapters); the dashboard's local cache is still useful in that case.
 */
export async function syncPayrollRunsFromArweave(args: {
  wallet: { signMessage?: (msg: Uint8Array) => Promise<Uint8Array> };
  walletBase58: string;
}): Promise<SyncResult> {
  const { wallet, walletBase58 } = args;
  const errors: string[] = [];

  if (typeof wallet?.signMessage !== "function") {
    return { added: 0, total: loadCachedPayrollRuns(walletBase58).length, errors };
  }

  let masterSig: Uint8Array;
  try {
    masterSig = await getOrCreateMetadataMasterSig(wallet, walletBase58);
  } catch (err) {
    errors.push(`master-sig: ${err instanceof Error ? err.message : String(err)}`);
    return { added: 0, total: loadCachedPayrollRuns(walletBase58).length, errors };
  }

  let txIds: string[] = [];
  try {
    const indexTag = await derivePayrollIndexTag(masterSig);
    txIds = await queryArweaveByTag("Veil-Index", indexTag, { first: 100 });
  } catch (err) {
    errors.push(`graphql: ${err instanceof Error ? err.message : String(err)}`);
    return { added: 0, total: loadCachedPayrollRuns(walletBase58).length, errors };
  }

  const existing = loadCachedPayrollRuns(walletBase58);
  const knownIds = new Set(
    existing.map((e) => e.arweaveTxId).filter((id): id is string => !!id),
  );
  const knownBatchIds = new Set(existing.map((e) => e.signed.packet.batchId));
  const toFetch = txIds.filter((id) => !knownIds.has(id));

  // Fetch + decrypt with a small concurrency cap. Arweave gateways can
  // throttle; 4 in-flight is gentle and keeps the UX responsive.
  const fetched: CachedPayrollRun[] = [];
  const cap = 4;
  for (let i = 0; i < toFetch.length; i += cap) {
    const batch = toFetch.slice(i, i + cap);
    const results = await Promise.allSettled(
      batch.map(async (id) => {
        const blob = await fetchCiphertext(arweaveGatewayUrl(id));
        if (blob.length < 16 + 12 + 16) {
          throw new Error("blob too short to contain salt + AES-GCM frame");
        }
        const salt = blob.slice(0, 16);
        const ciphertext = blob.slice(16);
        const key = await deriveKeyForBlob(masterSig, salt);
        const json = (await decryptJson(ciphertext, key)) as SignedPayrollPacket;
        if (!isValidSignedPacket(json)) {
          throw new Error("decrypted blob does not match SignedPayrollPacket shape");
        }
        return { id, signed: json };
      }),
    );
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      const id = batch[j];
      if (r.status === "fulfilled") {
        const { signed } = r.value;
        // Two reasons we might skip a successfully-decrypted blob:
        //   1. We already have its batchId locally (added via this
        //      device's persistPayrollRun, no Arweave id stamped).
        //      Update that entry to record the Arweave id so future
        //      syncs skip it cheaply.
        //   2. Some other wallet is writing to the same indexTag (not
        //      possible without our master sig, but defensive).
        if (knownBatchIds.has(signed.packet.batchId)) {
          // Stamp the existing entry's arweaveTxId for future cheap dedup.
          const idx = existing.findIndex(
            (e) => e.signed.packet.batchId === signed.packet.batchId,
          );
          if (idx >= 0 && !existing[idx].arweaveTxId) {
            existing[idx] = { ...existing[idx], arweaveTxId: id };
          }
          continue;
        }
        fetched.push({
          signed,
          arweaveTxId: id,
          cachedAt: Date.now(),
        });
      } else {
        errors.push(`tx ${id}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
      }
    }
  }

  if (fetched.length > 0 || existing.some((e) => !e.arweaveTxId)) {
    writeCache(walletBase58, [...existing, ...fetched]);
  }

  return {
    added: fetched.length,
    total: loadCachedPayrollRuns(walletBase58).length,
    errors,
  };
}
