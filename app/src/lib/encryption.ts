import bs58 from "bs58";

const ALG = "AES-GCM";

export function generateKey(): Uint8Array {
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  return key;
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
