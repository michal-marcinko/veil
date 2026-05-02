import bs58 from "bs58";

const ALG = "AES-GCM";

export function generateKey(): Uint8Array {
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  return key;
}

/**
 * LEGACY: derive a 32-byte AES key from a wallet signature over a per-invoice
 * message. Each call hits Phantom — every new invoice means a popup.
 *
 *   sha256( wallet.signMessage("Veil invoice <invoiceId>") )
 *
 * Replaced by `getOrCreateMetadataMasterSig` + `deriveKeyFromMasterSig`, which
 * sign exactly ONE message per wallet (cached in localStorage) and HKDF-derive
 * per-invoice keys from that. We keep this function so the re-open flow at
 * `/invoice/[id]` can fall back to it for invoices created before the cached
 * master-sig flow shipped.
 */
export async function deriveKeyFromWalletSignature(
  wallet: { signMessage?: (msg: Uint8Array) => Promise<Uint8Array> },
  invoiceId: string,
): Promise<Uint8Array> {
  if (typeof wallet?.signMessage !== "function") {
    throw new Error(
      "Wallet does not expose signMessage — cannot derive invoice key.",
    );
  }
  const message = new TextEncoder().encode(`Veil invoice ${invoiceId}`);
  const signature = await wallet.signMessage(message);
  const hash = await crypto.subtle.digest("SHA-256", signature);
  return new Uint8Array(hash);
}

// ---------------------------------------------------------------------------
// Cached "metadata master signature" → per-invoice keys via HKDF.
//
// PROBLEM: the legacy `deriveKeyFromWalletSignature` triggers a wallet popup
// every time Alice creates or re-opens an invoice. With 10 invoices that's
// 10 popups. Awful UX and not necessary — the signature only needs to be
// rare-but-deterministic per wallet, not per-invoice.
//
// FIX: sign ONE fixed message once per wallet ("Veil metadata master key v1")
// and cache the 64-byte ed25519 signature in localStorage scoped by wallet
// address. Per-invoice keys are then derived deterministically by hashing
// (masterSig || invoiceId) — same security model as before (same wallet +
// same invoiceId yields the same key) but only one popup, ever.
//
// Same persistence model as the Umbra master-seed cache in `umbra.ts`.
// Storage key: `veil:metadataMasterSig:<walletAddress>`. Corruption / wrong
// length wipes the entry and falls through to a fresh sign.
// ---------------------------------------------------------------------------

const METADATA_MASTER_SIG_BYTES = 64; // ed25519 signature length
const METADATA_MASTER_MESSAGE = "Veil metadata master key v1";

function metadataMasterSigStorageKey(walletAddress: string): string {
  return `veil:metadataMasterSig:${walletAddress}`;
}

function safeLocalStorage(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function loadCachedMasterSig(walletAddress: string): Uint8Array | null {
  const storage = safeLocalStorage();
  if (!storage) return null;
  const key = metadataMasterSigStorageKey(walletAddress);
  let encoded: string | null;
  try {
    encoded = storage.getItem(key);
  } catch {
    return null;
  }
  if (!encoded) return null;
  try {
    const binary = atob(encoded);
    if (binary.length !== METADATA_MASTER_SIG_BYTES) {
      storage.removeItem(key);
      return null;
    }
    const bytes = new Uint8Array(METADATA_MASTER_SIG_BYTES);
    for (let i = 0; i < METADATA_MASTER_SIG_BYTES; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      /* ignore */
    }
    return null;
  }
}

function storeMasterSig(walletAddress: string, signature: Uint8Array): void {
  const storage = safeLocalStorage();
  if (!storage) return;
  try {
    let binary = "";
    for (let i = 0; i < signature.length; i++) {
      binary += String.fromCharCode(signature[i]);
    }
    storage.setItem(metadataMasterSigStorageKey(walletAddress), btoa(binary));
  } catch {
    /* best-effort; storage failure isn't fatal — next session re-signs */
  }
}

/**
 * Returns the cached metadata master signature for this wallet, signing a
 * fixed message once if no cache exists. ONE popup per wallet, ever.
 */
export async function getOrCreateMetadataMasterSig(
  wallet: { signMessage?: (msg: Uint8Array) => Promise<Uint8Array> },
  walletAddress: string,
): Promise<Uint8Array> {
  const cached = loadCachedMasterSig(walletAddress);
  if (cached) return cached;
  if (typeof wallet?.signMessage !== "function") {
    throw new Error(
      "Wallet does not expose signMessage — cannot derive metadata master key.",
    );
  }
  const message = new TextEncoder().encode(METADATA_MASTER_MESSAGE);
  const signature = await wallet.signMessage(message);
  if (signature.length !== METADATA_MASTER_SIG_BYTES) {
    throw new Error(
      `Unexpected signature length: ${signature.length} (expected ${METADATA_MASTER_SIG_BYTES})`,
    );
  }
  storeMasterSig(walletAddress, signature);
  return signature;
}

/**
 * Per-invoice key from cached master sig. Deterministic given (masterSig,
 * invoiceId), so re-deriving on /invoice/[id] yields the same key without
 * another popup.
 */
export async function deriveKeyFromMasterSig(
  masterSig: Uint8Array,
  invoiceId: string,
): Promise<Uint8Array> {
  const idBytes = new TextEncoder().encode(`Veil invoice ${invoiceId}`);
  const combined = new Uint8Array(masterSig.length + idBytes.length);
  combined.set(masterSig, 0);
  combined.set(idBytes, masterSig.length);
  const hash = await crypto.subtle.digest("SHA-256", combined);
  return new Uint8Array(hash);
}

export function keyToBase58(key: Uint8Array): string {
  return bs58.encode(key);
}

export function keyFromBase58(encoded: string): Uint8Array {
  const decoded = bs58.decode(encoded);
  if (decoded.length !== 32) {
    throw new Error(`Invalid key length: expected 32 bytes, got ${decoded.length}`);
  }
  return decoded;
}

async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, ALG, false, ["encrypt", "decrypt"]);
}

export async function encryptJson(payload: unknown, key: Uint8Array): Promise<Uint8Array> {
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const cryptoKey = await importKey(key);
  const ciphertext = await crypto.subtle.encrypt({ name: ALG, iv }, cryptoKey, plaintext);
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return combined;
}

export async function decryptJson(ciphertext: Uint8Array, key: Uint8Array): Promise<unknown> {
  const iv = ciphertext.slice(0, 12);
  const data = ciphertext.slice(12);
  const cryptoKey = await importKey(key);
  const plaintext = await crypto.subtle.decrypt({ name: ALG, iv }, cryptoKey, data);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hash);
}

export function extractKeyFromFragment(hash: string): Uint8Array | null {
  if (!hash || !hash.startsWith("#")) return null;
  try {
    return keyFromBase58(hash.slice(1));
  } catch {
    return null;
  }
}
