// ---------------------------------------------------------------------------
// Cross-device incoming-invoice storage.
//
// When a payer opens an invoice link (/pay/[id]#k=<base58-aes-key>) and the
// invoice decrypts successfully, we persist a lightweight record so the
// payer's dashboard Inbox can re-surface all invoices they've ever opened —
// across devices and tab sessions — without relying on localStorage.
//
// Crypto contract — identical scheme to payroll-runs-storage.ts and
// received-payments-storage.ts:
//
//   masterSig = wallet.signMessage("Veil metadata master key v1")           // cached
//   indexTag  = sha256(masterSig || "Veil incoming-invoices index v1")       // opaque
//   salt      = randomBytes(16)                                              // per upload
//   key       = sha256(masterSig || salt)                                    // per upload
//   blob      = salt || AES-GCM(key, JSON(IncomingInvoiceIndex))             // uploaded
//
// Arweave tag scheme:
//   Tag name : "Veil-Index"
//   Tag value: sha256(masterSig || "Veil incoming-invoices index v1") as hex
//
// What an outsider with the payer's PUBLIC key sees:
//   - The Arweave tx exists and carries a `Veil-Index` tag.
//   - The tag value is an opaque hash — not invertible without the master sig.
//   - They cannot list the payer's invoices nor decrypt any blob.
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

/* ─────────────────────────── public types ─────────────────────────── */

export type IncomingInvoiceEntry = {
  /** On-chain invoice PDA address (base58). */
  invoicePda: string;
  /** AES key extracted from the URL fragment #<base58> (bare key, no prefix).
   *  Stored so the payer can re-decrypt the invoice from the dashboard
   *  without needing the original URL. */
  urlFragmentKey: string;
  /** Wall-clock ms when the payer first opened the invoice link. */
  openedAt: number;
  /** Optional: Arweave URI of the encrypted invoice blob. Cached here so
   *  the dashboard can fetch metadata without querying the chain again. */
  metadataUri?: string;
};

/* ─────────────────────────── internal types ─────────────────────────── */

/** The shape persisted as one encrypted Arweave blob per payer.
 *  We store the full array so loading is a single fetch + decrypt. */
type IncomingInvoiceIndex = IncomingInvoiceEntry[];

/** The cached wrapper stored in localStorage alongside the Arweave tx id. */
interface CachedInvoiceIndex {
  entries: IncomingInvoiceEntry[];
  /** Arweave tx id of the latest index blob. Set after a successful upload
   *  so the next write can do a cheap incremental check. */
  arweaveTxId?: string;
  cachedAt: number;
}

/* ─────────────────────────── localStorage cache ─────────────────────────── */

const CACHE_KEY_PREFIX = "veil:incomingInvoices:";
const INDEX_TAG_MESSAGE = "Veil incoming-invoices index v1";
const CACHE_MAX_ENTRIES = 200;

function cacheKey(walletBase58: string): string {
  return `${CACHE_KEY_PREFIX}${walletBase58}`;
}

function safeStorage(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function loadCache(walletBase58: string): CachedInvoiceIndex {
  const storage = safeStorage();
  const empty: CachedInvoiceIndex = { entries: [], cachedAt: 0 };
  if (!storage) return empty;
  let raw: string | null;
  try {
    raw = storage.getItem(cacheKey(walletBase58));
  } catch {
    return empty;
  }
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray(parsed.entries)
    ) {
      return parsed as CachedInvoiceIndex;
    }
  } catch {
    /* malformed — fall through to empty */
  }
  return empty;
}

function writeCache(walletBase58: string, cache: CachedInvoiceIndex): void {
  const storage = safeStorage();
  if (!storage) return;
  // Dedupe by invoicePda — last write wins.
  const byPda = new Map<string, IncomingInvoiceEntry>();
  for (const e of cache.entries) byPda.set(e.invoicePda, e);
  const entries = Array.from(byPda.values())
    .sort((a, b) => b.openedAt - a.openedAt)
    .slice(0, CACHE_MAX_ENTRIES);
  const toWrite: CachedInvoiceIndex = { ...cache, entries };
  const key = cacheKey(walletBase58);
  try {
    storage.setItem(key, JSON.stringify(toWrite));
    try {
      window.dispatchEvent(new StorageEvent("storage", { key }));
    } catch {
      // jsdom / non-browser — skip silently.
    }
  } catch {
    // Quota exceeded / private browsing — local cache loss is acceptable;
    // the Arweave copy is the source of truth.
  }
}

/* ─────────────────────────── crypto helpers ─────────────────────────── */

/** Derive the opaque, wallet-specific Arweave index tag.
 *  Non-invertible without the master sig; deterministic per wallet. */
async function deriveIncomingIndexTag(masterSig: Uint8Array): Promise<string> {
  const message = new TextEncoder().encode(INDEX_TAG_MESSAGE);
  const buf = new Uint8Array(masterSig.length + message.length);
  buf.set(masterSig, 0);
  buf.set(message, masterSig.length);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return bytesToHex(new Uint8Array(hash));
}

/** Per-upload AES-GCM key. Salt is prepended to the blob so any device
 *  with the master sig can re-derive the key from the blob alone. */
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

type WalletAdapter = { signMessage?: (msg: Uint8Array) => Promise<Uint8Array> };

/**
 * Record that the payer opened an invoice. Idempotent — deduplicated by
 * `invoicePda` in both the local cache and the Arweave blob. Safe to call
 * after every successful decrypt; only the first call for a given PDA
 * triggers an Arweave upload.
 *
 * Resolves once the local cache is written. The Arweave upload runs
 * concurrently and its result is folded in once it lands — callers
 * never need to await the upload.
 */
export async function recordIncomingInvoice(args: {
  wallet: WalletAdapter;
  walletBase58: string;
  entry: IncomingInvoiceEntry;
}): Promise<void> {
  const { wallet, walletBase58, entry } = args;

  // 1. Read current cache and check for an existing record.
  const cache = loadCache(walletBase58);
  const alreadyRecorded = cache.entries.some(
    (e) => e.invoicePda === entry.invoicePda,
  );
  if (alreadyRecorded) return; // idempotent fast-path

  // 2. Write to local cache immediately so the dashboard renders right away.
  const updated: CachedInvoiceIndex = {
    entries: [entry, ...cache.entries],
    arweaveTxId: cache.arweaveTxId,
    cachedAt: Date.now(),
  };
  writeCache(walletBase58, updated);

  // 3. Fire-and-forget Arweave upload. Builds the full index (all local
  //    entries) and encrypts it as one blob. This means each new invoice
  //    replaces the previous index blob — a simple append-only log where
  //    the "latest" blob is always the source of truth.
  void (async () => {
    try {
      const masterSig = await getOrCreateMetadataMasterSig(wallet, walletBase58);
      const salt = new Uint8Array(16);
      crypto.getRandomValues(salt);
      const blobKey = await deriveKeyForBlob(masterSig, salt);

      // Re-read cache in case another tab wrote between our two reads.
      const freshCache = loadCache(walletBase58);
      const index: IncomingInvoiceIndex = freshCache.entries;
      const ciphertext = await encryptJson(index, blobKey);
      const blob = new Uint8Array(salt.length + ciphertext.length);
      blob.set(salt, 0);
      blob.set(ciphertext, salt.length);

      const indexTag = await deriveIncomingIndexTag(masterSig);
      const { id } = await uploadCiphertextWithTags(blob, [
        { name: "Veil-Index", value: indexTag },
      ]);

      // Stamp the tx id so future syncs can skip this blob cheaply.
      const post = loadCache(walletBase58);
      writeCache(walletBase58, { ...post, arweaveTxId: id, cachedAt: Date.now() });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[incoming-invoices] Arweave upload failed (local cache kept)", err);
    }
  })();
}

/**
 * Load all incoming invoice entries for the connected payer.
 *
 * Fast-path: returns local cache immediately. Then attempts an Arweave
 * sync in the background; if the sync adds entries the cache is updated
 * and a synthetic StorageEvent is dispatched so React hooks re-render.
 *
 * The async return value is the local snapshot. UI code should combine
 * this with a StorageEvent listener to pick up background-sync additions.
 */
export async function loadIncomingInvoices(args: {
  wallet: WalletAdapter;
  walletBase58: string;
}): Promise<IncomingInvoiceEntry[]> {
  const { wallet, walletBase58 } = args;
  const local = loadCache(walletBase58).entries;

  // Background Arweave sync — does not block the return value.
  void (async () => {
    if (typeof wallet?.signMessage !== "function") return;
    try {
      const masterSig = await getOrCreateMetadataMasterSig(wallet, walletBase58);
      const indexTag = await deriveIncomingIndexTag(masterSig);
      const txIds = await queryArweaveByTag("Veil-Index", indexTag, { first: 100 });

      const cache = loadCache(walletBase58);
      const knownTxId = cache.arweaveTxId;

      // The newest tx is first in the Arweave GraphQL result. If the
      // latest known tx matches the first result, nothing has changed.
      if (txIds.length === 0 || txIds[0] === knownTxId) return;

      // Fetch the most recent blob — it already contains the full index.
      const latestTxId = txIds[0];
      const blob = await fetchCiphertext(arweaveGatewayUrl(latestTxId));
      if (blob.length < 16 + 12 + 16) return; // too short to be valid

      const salt = blob.slice(0, 16);
      const ciphertext = blob.slice(16);
      const blobKey = await deriveKeyForBlob(masterSig, salt);
      const remoteIndex = (await decryptJson(ciphertext, blobKey)) as IncomingInvoiceIndex;

      if (!Array.isArray(remoteIndex)) return;

      // Merge remote entries with local — dedupe by invoicePda.
      const merged = new Map<string, IncomingInvoiceEntry>();
      for (const e of cache.entries) merged.set(e.invoicePda, e);
      for (const e of remoteIndex) {
        if (e && typeof e.invoicePda === "string") {
          // Prefer local copy (may have more recent openedAt on this device).
          if (!merged.has(e.invoicePda)) merged.set(e.invoicePda, e);
        }
      }

      const mergedEntries = Array.from(merged.values()).sort(
        (a, b) => b.openedAt - a.openedAt,
      );
      writeCache(walletBase58, {
        entries: mergedEntries,
        arweaveTxId: latestTxId,
        cachedAt: Date.now(),
      });
    } catch {
      // Best-effort — local cache stays valid.
    }
  })();

  return local;
}

/** Sync helper exposed for the section component's StorageEvent pattern.
 *  Reads the local cache synchronously — no Arweave fetch. */
export function loadCachedIncomingInvoices(
  walletBase58: string,
): IncomingInvoiceEntry[] {
  return loadCache(walletBase58).entries;
}

/** Cache key exported so the section component can subscribe to StorageEvents. */
export function incomingInvoicesCacheKey(walletBase58: string): string {
  return cacheKey(walletBase58);
}
