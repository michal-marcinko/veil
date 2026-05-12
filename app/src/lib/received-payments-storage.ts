// ---------------------------------------------------------------------------
// Cross-device received-payment storage (Phase B).
//
// The recipient-side mirror of `payroll-runs-storage.ts`. When a recipient
// successfully claims a private payment (mixer or sweep path), we persist a
// `ReceivedPayment` record so the dashboard's "Received private payments"
// section can show their history across devices.
//
// Crypto contract — same shape and key derivation as the payroll-run
// storage path; the recipient is just the other side of the same tunnel:
//
//   masterSig = wallet.signMessage("Veil metadata master key v1")    // cached
//   indexTag  = sha256(masterSig || "Veil received-payments index v1") // opaque
//   salt      = randomBytes(16)                                      // per upload
//   key       = sha256(masterSig || salt)                            // per upload
//   blob      = salt || AES-GCM(key, JSON(ReceivedPayment))          // uploaded
//
// The indexTag is DIFFERENT from the payroll-runs tag (different message
// suffix) so a wallet that both sends and receives doesn't conflate the
// two histories — the dashboard renders them as separate sections.
//
// Threat model (matches payroll-runs-storage.ts):
//   - Outsider with the user's PUBLIC key can see Arweave tx exists but
//     cannot compute the indexTag, list the user's history, or decrypt.
//   - The aggregate count of `Veil-Index`-tagged blobs is observable
//     across all wallets — accepted; leaks usage volume, never per-wallet.
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

/* ─────────────────────────── data shape ─────────────────────────── */

/**
 * A single completed claim. Both the mixer-based path
 * (`claimToRecipient`) and the legacy sweep path (`withdrawFromShadow`)
 * produce records of this shape — the `mode` field disambiguates so the
 * UI can label rows correctly and the PDF can explain the privacy
 * difference. Path-specific signatures are optional accordingly.
 */
export interface ReceivedPayment {
  /** Originating payroll batch the row belongs to. */
  batchId: string;
  /** Row index inside that batch. */
  rowIndex: number;
  /** Sender's wallet (base58). May be the shadow address if metadata is
   *  unavailable; the UI is responsible for choosing what to display. */
  senderWallet: string;
  /** Sender's display name from the claim-link metadata, if any.
   *  Empty string when the sender opted not to disclose. */
  senderDisplayName: string;
  /** Amount in base units (string to survive JSON / bigint roundtrip). */
  amount: string;
  /** Pre-formatted display amount, e.g. "0.10". Cached so the row can
   *  render without re-deriving from base units + decimals. */
  amountDisplay: string;
  /** Token symbol (e.g. "USDC", "SOL"). */
  symbol: string;
  /** Mint address (base58). */
  mint: string;
  /** Optional human memo from the row metadata. Null when absent. */
  memo: string | null;
  /** Final tx signature seen by the recipient — withdraw on the mixer
   *  path, sweep on the legacy path. Acts as the "claim confirmed" anchor. */
  claimSignature: string;
  /** Recipient-side withdraw signature on the mixer path. Mirrors the
   *  ClaimToRecipientResult shape so we can show "Withdraw" links in the
   *  payslip without losing the queue → callback distinction. */
  withdrawSignature?: string;
  /** Shadow→pool re-encrypt signature on the mixer path. Privacy hop
   *  anchor — viewers correlating the explorer link will see the mixer
   *  did its job. */
  reencryptSignature?: string;
  /** Shadow→recipient sweep signature on the legacy path. Mutually
   *  exclusive with `reencryptSignature` — `mode` is the source of truth. */
  sweepSignature?: string;
  /** Which code path produced this record. Drives the payslip's "Mode"
   *  label and the privacy footnote. */
  mode: "mixer" | "sweep";
  /** ISO timestamp the claim completed (recipient-side wallclock). */
  receivedAt: string;
}

/* ─────────────────────────── localStorage cache ─────────────────────────── */

const CACHE_PREFIX = "veil:receivedPayments:";
const CACHE_MAX_ENTRIES = 200;
const INDEX_TAG_MESSAGE = "Veil received-payments index v1";

/** Cache wrapper — mirrors `CachedPayrollRun`. `arweaveTxId` is stamped
 *  after a successful upload so future syncs dedupe cheaply. */
export interface CachedReceivedPayment {
  payment: ReceivedPayment;
  arweaveTxId?: string;
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

function isValidPayment(value: any): value is ReceivedPayment {
  return (
    !!value &&
    typeof value === "object" &&
    typeof value.batchId === "string" &&
    typeof value.rowIndex === "number" &&
    typeof value.senderWallet === "string" &&
    typeof value.amount === "string" &&
    typeof value.amountDisplay === "string" &&
    typeof value.symbol === "string" &&
    typeof value.mint === "string" &&
    typeof value.claimSignature === "string" &&
    (value.mode === "mixer" || value.mode === "sweep") &&
    typeof value.receivedAt === "string"
  );
}

/**
 * Read the cached received payments for this wallet, sorted newest →
 * oldest. Defensive about shape — drops entries that don't look right
 * rather than throwing, so a single bad localStorage write doesn't take
 * out the whole list.
 */
export function loadCachedReceivedPayments(
  walletBase58: string,
): CachedReceivedPayment[] {
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

  const out: CachedReceivedPayment[] = [];
  for (const entry of parsed) {
    if (
      entry &&
      typeof entry === "object" &&
      (entry as any).payment &&
      isValidPayment((entry as any).payment)
    ) {
      out.push({
        payment: (entry as any).payment as ReceivedPayment,
        arweaveTxId:
          typeof (entry as any).arweaveTxId === "string"
            ? ((entry as any).arweaveTxId as string)
            : undefined,
        cachedAt:
          typeof (entry as any).cachedAt === "number"
            ? ((entry as any).cachedAt as number)
            : Date.parse((entry as any).payment.receivedAt) || 0,
      });
    }
  }
  return out.sort(
    (a, b) =>
      Date.parse(b.payment.receivedAt) - Date.parse(a.payment.receivedAt),
  );
}

/**
 * Convenience flat-list reader for the dashboard. Mirrors
 * `loadCachedSignedPackets`. Returns the un-wrapped `ReceivedPayment[]`
 * already sorted newest-first.
 */
export function loadCachedReceivedPaymentsFlat(
  walletBase58: string,
): ReceivedPayment[] {
  return loadCachedReceivedPayments(walletBase58).map((e) => e.payment);
}

/**
 * Stable key for dedupe between local + Arweave-fetched copies. Two
 * records of "the same" payment will share batchId + rowIndex; we use
 * those as the natural primary key.
 */
function paymentDedupeKey(p: ReceivedPayment): string {
  return `${p.batchId}::${p.rowIndex}`;
}

function writeCache(
  walletBase58: string,
  entries: CachedReceivedPayment[],
): void {
  const storage = safeStorage();
  if (!storage) return;
  const key = cacheKey(walletBase58);
  // Dedupe by (batchId, rowIndex) — newer write wins on collision so a
  // re-claim (rare; should not happen) updates the cached copy rather
  // than appending a duplicate.
  const byKey = new Map<string, CachedReceivedPayment>();
  for (const e of entries) byKey.set(paymentDedupeKey(e.payment), e);
  const arr = Array.from(byKey.values()).sort(
    (a, b) =>
      Date.parse(b.payment.receivedAt) - Date.parse(a.payment.receivedAt),
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
    // Quota exceeded / private browsing — accept the loss; the Arweave
    // copy is the source of truth and a later sync will repopulate.
  }
}

/** Wipe the local cache for one wallet. Debug / dev only — not wired
 *  into the UI. Safe to call when localStorage is unavailable. */
export function clearReceivedPayments(walletBase58: string): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.removeItem(cacheKey(walletBase58));
    try {
      window.dispatchEvent(
        new StorageEvent("storage", { key: cacheKey(walletBase58) }),
      );
    } catch {
      /* ignore */
    }
  } catch {
    /* ignore */
  }
}

/* ─────────────────────────── crypto helpers ─────────────────────────── */

/**
 * Derive an opaque, wallet-specific tag value. Same shape as the payroll
 * runs version but with a different message suffix so the indexes
 * don't collide on a wallet that both sends and receives.
 */
async function deriveReceivedIndexTag(masterSig: Uint8Array): Promise<string> {
  const message = new TextEncoder().encode(INDEX_TAG_MESSAGE);
  const buf = new Uint8Array(masterSig.length + message.length);
  buf.set(masterSig, 0);
  buf.set(message, masterSig.length);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return bytesToHex(new Uint8Array(hash));
}

/** Per-blob AES-GCM key. Same construction as payroll-runs-storage.ts. */
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

export interface PersistReceivedPaymentArgs {
  wallet: { signMessage?: (msg: Uint8Array) => Promise<Uint8Array> };
  walletBase58: string;
  payment: ReceivedPayment;
}

/**
 * Persist a freshly-claimed payment:
 *   1. Write the local cache immediately so the dashboard renders right
 *      away (no spinner).
 *   2. Fire-and-forget the Arweave upload in the background. A failure
 *      there does NOT roll back the cache write — the row still shows
 *      up locally and the next sync from another device will pick it up
 *      via the local copy whenever the user revisits this device.
 *
 * Returns a promise that resolves when the local write is done; the
 * background Arweave upload is awaited internally and its result
 * folded into the cache (stamping the tx id) on success.
 */
export async function persistReceivedPayment(
  args: PersistReceivedPaymentArgs,
): Promise<{ arweaveTxId: string | null; uploaded: boolean }> {
  const { wallet, walletBase58, payment } = args;

  const existing = loadCachedReceivedPayments(walletBase58);
  const now = Date.now();
  const localOnlyEntry: CachedReceivedPayment = {
    payment,
    arweaveTxId: undefined,
    cachedAt: now,
  };
  writeCache(walletBase58, [localOnlyEntry, ...existing]);

  // Fire-and-forget pattern — the caller doesn't need to await this for
  // the UI to update, but we still return a promise so tests can wait
  // on it explicitly.
  try {
    const masterSig = await getOrCreateMetadataMasterSig(wallet, walletBase58);
    const salt = new Uint8Array(16);
    crypto.getRandomValues(salt);
    const key = await deriveKeyForBlob(masterSig, salt);
    const ciphertext = await encryptJson(payment, key);
    const blob = new Uint8Array(salt.length + ciphertext.length);
    blob.set(salt, 0);
    blob.set(ciphertext, salt.length);

    const indexTag = await deriveReceivedIndexTag(masterSig);
    const { id } = await uploadCiphertextWithTags(blob, [
      { name: "Veil-Index", value: indexTag },
    ]);

    // Re-read cache and stamp the tx id onto the matching entry.
    const post = loadCachedReceivedPayments(walletBase58).map((entry) =>
      paymentDedupeKey(entry.payment) === paymentDedupeKey(payment)
        ? { ...entry, arweaveTxId: id }
        : entry,
    );
    writeCache(walletBase58, post);
    return { arweaveTxId: id, uploaded: true };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[received-payments] Arweave upload failed (local cache kept)",
      err,
    );
    return { arweaveTxId: null, uploaded: false };
  }
}

export interface ReceivedSyncResult {
  /** New entries fetched from Arweave that weren't already cached. */
  added: number;
  /** Total entries in the cache after sync. */
  total: number;
  errors: string[];
}

/**
 * Pull received-payment records from Arweave that aren't in the local
 * cache, decrypt them, and merge into the cache. Idempotent — running
 * it twice in a row on the same device adds nothing the second time.
 *
 * Skipped silently when the wallet has no signMessage (read-only
 * adapters); the dashboard's local cache is still useful in that case.
 */
export async function syncReceivedPaymentsFromArweave(args: {
  wallet: { signMessage?: (msg: Uint8Array) => Promise<Uint8Array> };
  walletBase58: string;
}): Promise<ReceivedSyncResult> {
  const { wallet, walletBase58 } = args;
  const errors: string[] = [];

  if (typeof wallet?.signMessage !== "function") {
    return {
      added: 0,
      total: loadCachedReceivedPayments(walletBase58).length,
      errors,
    };
  }

  let masterSig: Uint8Array;
  try {
    masterSig = await getOrCreateMetadataMasterSig(wallet, walletBase58);
  } catch (err) {
    errors.push(`master-sig: ${err instanceof Error ? err.message : String(err)}`);
    return {
      added: 0,
      total: loadCachedReceivedPayments(walletBase58).length,
      errors,
    };
  }

  let txIds: string[] = [];
  try {
    const indexTag = await deriveReceivedIndexTag(masterSig);
    txIds = await queryArweaveByTag("Veil-Index", indexTag, { first: 200 });
  } catch (err) {
    errors.push(`graphql: ${err instanceof Error ? err.message : String(err)}`);
    return {
      added: 0,
      total: loadCachedReceivedPayments(walletBase58).length,
      errors,
    };
  }

  const existing = loadCachedReceivedPayments(walletBase58);
  const knownIds = new Set(
    existing.map((e) => e.arweaveTxId).filter((id): id is string => !!id),
  );
  const knownDedupeKeys = new Set(
    existing.map((e) => paymentDedupeKey(e.payment)),
  );
  const toFetch = txIds.filter((id) => !knownIds.has(id));

  // Same gentle concurrency cap as payroll-runs sync (4 in flight).
  const fetched: CachedReceivedPayment[] = [];
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
        const json = (await decryptJson(ciphertext, key)) as ReceivedPayment;
        if (!isValidPayment(json)) {
          throw new Error(
            "decrypted blob does not match ReceivedPayment shape",
          );
        }
        return { id, payment: json };
      }),
    );
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      const id = batch[j];
      if (r.status === "fulfilled") {
        const { payment } = r.value;
        if (knownDedupeKeys.has(paymentDedupeKey(payment))) {
          // We already have this row locally — stamp the existing
          // entry's arweaveTxId for cheap future dedup.
          const idx = existing.findIndex(
            (e) => paymentDedupeKey(e.payment) === paymentDedupeKey(payment),
          );
          if (idx >= 0 && !existing[idx].arweaveTxId) {
            existing[idx] = { ...existing[idx], arweaveTxId: id };
          }
          continue;
        }
        fetched.push({
          payment,
          arweaveTxId: id,
          cachedAt: Date.now(),
        });
      } else {
        errors.push(
          `tx ${id}: ${
            r.reason instanceof Error ? r.reason.message : String(r.reason)
          }`,
        );
      }
    }
  }

  if (fetched.length > 0 || existing.some((e) => !e.arweaveTxId)) {
    writeCache(walletBase58, [...existing, ...fetched]);
  }

  return {
    added: fetched.length,
    total: loadCachedReceivedPayments(walletBase58).length,
    errors,
  };
}

/**
 * Two-stage hook helper — local cache fast-path, then Arweave merge in
 * the background. Mirrors the dashboard's payroll-runs hydration
 * pattern: callers render whatever the synchronous return gives them
 * immediately, and pass an `onSync` callback to re-render once the
 * background reconcile completes.
 *
 * Returns the local snapshot synchronously. If an `onSync` callback is
 * provided, it fires once with the post-sync flat list when the merge
 * lands. A failure during sync is swallowed — `onSync` simply isn't
 * called, and the local cache stays valid.
 */
export function loadReceivedPayments(args: {
  wallet: { signMessage?: (msg: Uint8Array) => Promise<Uint8Array> };
  walletBase58: string;
  /** Fired once when the Arweave sync finishes adding ≥1 new row. */
  onSync?: (payments: ReceivedPayment[]) => void;
}): ReceivedPayment[] {
  const { wallet, walletBase58, onSync } = args;
  const local = loadCachedReceivedPaymentsFlat(walletBase58);
  if (onSync) {
    // Fire-and-forget. We deliberately don't return the promise from
    // this function so callers never accidentally block on Arweave.
    void (async () => {
      try {
        const result = await syncReceivedPaymentsFromArweave({
          wallet,
          walletBase58,
        });
        if (result.added > 0) {
          onSync(loadCachedReceivedPaymentsFlat(walletBase58));
        }
      } catch {
        // Best effort — silently skip the second-stage update.
      }
    })();
  }
  return local;
}
