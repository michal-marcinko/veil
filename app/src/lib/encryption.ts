import bs58 from "bs58";

const ALG = "AES-GCM";

export function generateKey(): Uint8Array {
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  return key;
}

/**
 * Derive a 32-byte AES key deterministically from a wallet signature over
 * a stable, per-invoice message. The key is:
 *
 *   sha256( wallet.signMessage("Veil invoice <invoiceId>") )
 *
 * Property: same wallet + same invoiceId always yields the same key, so
 * the creator can re-open her own invoice after closing the tab. The key
 * never exists on-chain and never leaves the creator's machine.
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
