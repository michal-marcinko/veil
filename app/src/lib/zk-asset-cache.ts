// ---------------------------------------------------------------------------
// Persistent IndexedDB cache for Umbra's ZK proving assets.
//
// Why this exists:
//   The SDK's default `load`/`store` hooks (web-zk-prover/dist/index.cjs:27)
//   are no-ops — every prover instance re-downloads the ~30 MB zkey from
//   the CDN on first use, every browser session, forever. With 4 distinct
//   prover types in our flows (registration, public-balance deposit,
//   encrypted-balance deposit, claim) that's 4 × 30 MB ≈ 120 MB per fresh
//   browser session — and the row-1 cold start of every payroll batch
//   waits on the relevant zkey to download mid-prove (~60-90 s).
//
// What this does:
//   Provides a (load, store) pair backed by IndexedDB. The first time
//   a prover needs an asset, it falls through to the CDN; on success
//   the SDK calls our `store` and we persist the (zkey, wasm) pair.
//   Subsequent sessions hit the cache instantly — payroll batches run
//   without a cold start.
//
// Storage layout:
//   - DB:       "veil-zk-assets"
//   - Store:    "assets" (key = `${type}::${variant ?? "default"}`)
//   - Value:    { zkey: Uint8Array, wasm: Uint8Array, savedAt: number }
//
// Failure mode:
//   Every operation is best-effort and returns a failed-but-recoverable
//   shape on error. Disabled storage (private browsing, quota, weird
//   permissions) means a slower-but-functional flow — never a thrown
//   error during proving.
//
// Versioning:
//   Not currently checked. Umbra's CDN provides asset URLs that include
//   a version, but the SDK's `load` callback only receives `{ type,
//   variant }` — no manifest version. If Umbra ships a breaking circuit
//   change we'd serve stale cached data forever. Mitigation: clear the
//   IDB via `clearZkAssetCache()` on demand (we'd add a debug button if
//   it became a real issue). Acceptable for the hackathon timeframe.
// ---------------------------------------------------------------------------

import type {
  ZkAssetData,
  ZkAssetLoadResult,
  ZkAssetStorageContext,
  ZkAssetStoreResult,
} from "@umbra-privacy/web-zk-prover";

const DB_NAME = "veil-zk-assets";
const DB_VERSION = 1;
const STORE_NAME = "assets";

interface StoredAsset {
  zkey: Uint8Array;
  wasm: Uint8Array;
  savedAt: number;
}

/* ─────────────────────────── IDB plumbing ─────────────────────────── */

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("indexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
    req.onblocked = () =>
      reject(new Error("indexedDB open blocked by another tab"));
  });
}

function cacheKey(context: ZkAssetStorageContext): string {
  // Variant is undefined for non-claim types; use "default" so the key
  // is stable. Claim variants use n1..n16 strings already.
  return `${context.type}::${context.variant ?? "default"}`;
}

function idbGet(db: IDBDatabase, key: string): Promise<StoredAsset | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result as StoredAsset | undefined);
    req.onerror = () => reject(req.error ?? new Error("idb get failed"));
  });
}

function idbPut(db: IDBDatabase, key: string, value: StoredAsset): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("idb put failed"));
  });
}

/* ─────────────────────────── Public API ─────────────────────────── */

/**
 * SDK-compatible loader. Reads from IndexedDB; returns
 * `{ exists: false }` on miss, error, or unsupported environment so
 * the SDK falls through to its CDN download.
 */
export async function loadZkAssetFromIdb(
  context: ZkAssetStorageContext,
): Promise<ZkAssetLoadResult> {
  if (typeof window === "undefined") return { exists: false };
  let db: IDBDatabase | null = null;
  try {
    db = await openDb();
    const stored = await idbGet(db, cacheKey(context));
    if (
      stored &&
      stored.zkey instanceof Uint8Array &&
      stored.wasm instanceof Uint8Array &&
      stored.zkey.byteLength > 0 &&
      stored.wasm.byteLength > 0
    ) {
      return {
        exists: true,
        data: { zkey: stored.zkey, wasm: stored.wasm },
      };
    }
    return { exists: false };
  } catch {
    return { exists: false };
  } finally {
    db?.close();
  }
}

/**
 * SDK-compatible storer. Writes (zkey, wasm) for the given prover
 * context to IndexedDB. Always returns a "successful enough" result
 * so the SDK doesn't surface a fatal error — quota / private-browsing
 * failures translate to "no cache, but proving worked" which is the
 * correct shape from the user's perspective.
 */
export async function storeZkAssetInIdb(
  data: ZkAssetData,
  context: ZkAssetStorageContext,
): Promise<ZkAssetStoreResult> {
  if (typeof window === "undefined") return { success: true };
  let db: IDBDatabase | null = null;
  try {
    db = await openDb();
    await idbPut(db, cacheKey(context), {
      zkey: data.zkey,
      wasm: data.wasm,
      savedAt: Date.now(),
    });
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    db?.close();
  }
}

/**
 * Single object that satisfies the `{ load, store }` half of `ZkProverDeps`.
 * Spread it into the prover constructor's options:
 *
 *   getUserRegistrationProver({
 *     assetProvider: proxiedAssetProvider(),
 *     ...zkAssetCache,
 *   })
 *
 * Co-located so a refactor to a different storage backend (CacheStorage,
 * OPFS, Origin Private File System) only changes this module.
 */
export const zkAssetCache = {
  load: loadZkAssetFromIdb,
  store: storeZkAssetInIdb,
} as const;

/* ─────────────────────────── Diagnostics ─────────────────────────── */

/**
 * Wipe the cache. Exposed for ad-hoc dev use (e.g. when Umbra ships a
 * circuit version bump and we need to force re-download).
 */
export async function clearZkAssetCache(): Promise<void> {
  if (typeof window === "undefined") return;
  let db: IDBDatabase | null = null;
  try {
    db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db!.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // best-effort
  } finally {
    db?.close();
  }
}
