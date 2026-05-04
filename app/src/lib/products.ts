/**
 * Products / payment links — Stripe-style reusable URLs for accepting
 * private payments via Umbra.
 *
 * Architecture (decided 2026-05-04):
 *   - Product metadata is stored on Arweave as PUBLIC plaintext JSON. We
 *     reuse the existing `uploadCiphertext` helper from `./arweave`
 *     (despite the misleading name, it just uploads bytes — there's no
 *     encryption obligation in the helper itself).
 *   - The product URL embeds the Arweave tx id: `/buy/<arweaveTxId>`.
 *   - Each merchant keeps a local cache of THEIR products in localStorage
 *     under `veil:products:<walletBase58>`. The cache is for management
 *     UX only — Arweave is the canonical source of truth. A wiped cache
 *     on a new browser still lets the merchant access any product they
 *     remember the URL for.
 *   - Customer payment goes directly to `merchant.wallet` via the
 *     existing Umbra `payInvoice` flow (no invoice PDA, no on-chain
 *     anchoring per-product). Each purchase shows up on the merchant's
 *     dashboard as an incoming UTXO.
 */
import { uploadCiphertext, fetchCiphertext } from "./arweave";

/** Current product spec version. Bump on breaking JSON shape changes. */
export const PRODUCT_SPEC_VERSION = 1 as const;

export interface ProductSpec {
  version: typeof PRODUCT_SPEC_VERSION;
  /** Display name. Required, 1..120 chars after trim. */
  name: string;
  /** Optional long-form description. Up to 2000 chars after trim. */
  description?: string;
  /** Price in mint base units, encoded as a decimal string for JSON safety. */
  amountBaseUnits: string;
  /** SPL mint base58. */
  mint: string;
  /** Mint decimals (e.g. 6 for USDC, 9 for SOL). */
  decimals: number;
  /** Display symbol e.g. "SOL", "USDC". */
  symbol: string;
  /** Merchant's Solana wallet base58 — the recipient of every purchase. */
  ownerWallet: string;
  /** Optional product image URL. We DO NOT host it — link to wherever it lives. */
  imageUrl?: string;
  /** Unix milliseconds (Date.now()) at upload time. */
  createdAt: number;
}

/**
 * Per-merchant local entry for the dashboard list. Carries enough metadata
 * to render the row + link without a network round-trip; the full spec is
 * always re-fetched from Arweave when the customer (or merchant preview)
 * opens the product page.
 */
export interface ProductCacheEntry {
  /** Stable id — currently same as `arweaveTxId`. Kept separate so a
   *  future migration could move to a different identifier (e.g. content
   *  hash) without breaking older entries. */
  id: string;
  arweaveTxId: string;
  name: string;
  amountBaseUnits: string;
  symbol: string;
  decimals: number;
  /** Unix ms — set when the product was created OR when imported. */
  createdAt: number;
}

const STORAGE_KEY_PREFIX = "veil:products:";

function storageKey(walletBase58: string): string {
  return `${STORAGE_KEY_PREFIX}${walletBase58}`;
}

const NAME_MIN = 1;
const NAME_MAX = 120;
const DESCRIPTION_MAX = 2000;
const IMAGE_URL_MAX = 2048;

const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const NON_NEGATIVE_DIGITS_RE = /^\d+$/;

/**
 * Validate a partial spec coming from the form OR from Arweave (where it
 * may have been crafted by anyone). Throws with a human-readable message
 * on the first violation; otherwise returns the input narrowed to
 * `ProductSpec`.
 */
export function validateProductSpec(input: unknown): ProductSpec {
  if (!input || typeof input !== "object") {
    throw new Error("Product spec must be an object.");
  }
  const obj = input as Record<string, unknown>;

  if (obj.version !== PRODUCT_SPEC_VERSION) {
    throw new Error(
      `Unsupported product spec version: ${String(obj.version)} (expected ${PRODUCT_SPEC_VERSION}).`,
    );
  }

  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (name.length < NAME_MIN) throw new Error("Product name is required.");
  if (name.length > NAME_MAX) {
    throw new Error(`Product name must be ${NAME_MAX} characters or fewer.`);
  }

  let description: string | undefined;
  if (obj.description != null) {
    if (typeof obj.description !== "string") {
      throw new Error("Description must be a string.");
    }
    const trimmed = obj.description.trim();
    if (trimmed.length > DESCRIPTION_MAX) {
      throw new Error(`Description must be ${DESCRIPTION_MAX} characters or fewer.`);
    }
    description = trimmed.length === 0 ? undefined : trimmed;
  }

  if (typeof obj.amountBaseUnits !== "string") {
    throw new Error("amountBaseUnits must be a decimal string.");
  }
  if (!NON_NEGATIVE_DIGITS_RE.test(obj.amountBaseUnits)) {
    throw new Error("amountBaseUnits must be a non-negative integer string.");
  }
  // Reject zero-priced products — there's no shareable purchase flow for
  // them and it's almost certainly a form bug.
  if (BigInt(obj.amountBaseUnits) === 0n) {
    throw new Error("Price must be greater than zero.");
  }

  if (typeof obj.mint !== "string" || !PUBKEY_RE.test(obj.mint)) {
    throw new Error("Mint must be a valid base58 public key.");
  }

  if (
    typeof obj.decimals !== "number" ||
    !Number.isInteger(obj.decimals) ||
    obj.decimals < 0 ||
    obj.decimals > 18
  ) {
    throw new Error("Decimals must be an integer between 0 and 18.");
  }

  if (typeof obj.symbol !== "string" || obj.symbol.trim().length === 0) {
    throw new Error("Symbol is required.");
  }
  const symbol = obj.symbol.trim();
  if (symbol.length > 12) {
    throw new Error("Symbol must be 12 characters or fewer.");
  }

  if (typeof obj.ownerWallet !== "string" || !PUBKEY_RE.test(obj.ownerWallet)) {
    throw new Error("Owner wallet must be a valid base58 public key.");
  }

  let imageUrl: string | undefined;
  if (obj.imageUrl != null) {
    if (typeof obj.imageUrl !== "string") {
      throw new Error("Image URL must be a string.");
    }
    const trimmed = obj.imageUrl.trim();
    if (trimmed.length === 0) {
      imageUrl = undefined;
    } else {
      if (trimmed.length > IMAGE_URL_MAX) {
        throw new Error(`Image URL must be ${IMAGE_URL_MAX} characters or fewer.`);
      }
      // Reject anything that isn't http(s):// — javascript: et al would be
      // an XSS vector when rendered as <img src>.
      if (!/^https?:\/\//i.test(trimmed)) {
        throw new Error("Image URL must start with http:// or https://.");
      }
      imageUrl = trimmed;
    }
  }

  if (
    typeof obj.createdAt !== "number" ||
    !Number.isFinite(obj.createdAt) ||
    obj.createdAt <= 0
  ) {
    throw new Error("createdAt must be a positive unix-ms number.");
  }

  return {
    version: PRODUCT_SPEC_VERSION,
    name,
    ...(description !== undefined ? { description } : {}),
    amountBaseUnits: obj.amountBaseUnits,
    mint: obj.mint,
    decimals: obj.decimals,
    symbol,
    ownerWallet: obj.ownerWallet,
    ...(imageUrl !== undefined ? { imageUrl } : {}),
    createdAt: obj.createdAt,
  };
}

/**
 * Build a ProductSpec from a form submission. Performs the same validation
 * as `validateProductSpec` and stamps `createdAt` to now.
 */
export interface BuildProductSpecArgs {
  name: string;
  description?: string;
  amountBaseUnits: bigint;
  mint: string;
  decimals: number;
  symbol: string;
  ownerWallet: string;
  imageUrl?: string;
}

export function buildProductSpec(args: BuildProductSpecArgs): ProductSpec {
  const candidate: ProductSpec = {
    version: PRODUCT_SPEC_VERSION,
    name: args.name,
    ...(args.description ? { description: args.description } : {}),
    amountBaseUnits: args.amountBaseUnits.toString(),
    mint: args.mint,
    decimals: args.decimals,
    symbol: args.symbol,
    ownerWallet: args.ownerWallet,
    ...(args.imageUrl ? { imageUrl: args.imageUrl } : {}),
    createdAt: Date.now(),
  };
  return validateProductSpec(candidate);
}

/**
 * Encode a ProductSpec to bytes ready for Arweave upload. Plain UTF-8 JSON.
 */
export function encodeProductSpec(spec: ProductSpec): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(spec));
}

/**
 * Decode bytes from Arweave back into a validated ProductSpec.
 */
export function decodeProductSpec(bytes: Uint8Array): ProductSpec {
  const json = new TextDecoder().decode(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err: any) {
    throw new Error(`Product spec is not valid JSON: ${err?.message ?? err}`);
  }
  return validateProductSpec(parsed);
}

/**
 * Extract the Arweave transaction id from a URI returned by the upload
 * helper. The helper returns `https://arweave.net/<txId>` (or sometimes
 * `arweave.net/<txId>` without scheme — we tolerate both).
 *
 * Returns `null` if the URI doesn't fit the expected shape — callers
 * should treat that as a programmer error.
 */
export function extractArweaveTxId(uri: string): string | null {
  if (!uri) return null;
  // Strip a leading scheme + host. Anything left whose first path segment
  // is a valid Arweave tx id (43 chars, base64url alphabet) is what we want.
  const match = uri.match(/(?:https?:\/\/)?[^/]+\/([A-Za-z0-9_-]{43})(?:[/?#]|$)/);
  return match ? match[1] : null;
}

/** Result of `uploadProductSpec`. */
export interface UploadProductSpecResult {
  arweaveTxId: string;
  uri: string;
}

/**
 * Encode + upload a product spec to Arweave. Returns the tx id (which the
 * caller embeds in the share URL as `/buy/<arweaveTxId>`) plus the full
 * URI for downstream display.
 *
 * Throws if the upload fails OR the helper returns a URI we can't parse.
 */
export async function uploadProductSpec(spec: ProductSpec): Promise<UploadProductSpecResult> {
  const bytes = encodeProductSpec(spec);
  const { uri } = await uploadCiphertext(bytes);
  const arweaveTxId = extractArweaveTxId(uri);
  if (!arweaveTxId) {
    throw new Error(
      `Arweave upload returned an unparseable URI: ${uri}. Cannot derive product id.`,
    );
  }
  return { arweaveTxId, uri };
}

/**
 * Fetch + decode a product spec by Arweave tx id. Verifies the bytes
 * round-trip into a valid ProductSpec; throws with a readable message on
 * bad JSON, missing fields, or shape violations.
 */
export async function fetchProductSpec(arweaveTxId: string): Promise<ProductSpec> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(arweaveTxId)) {
    throw new Error("Invalid Arweave transaction id format.");
  }
  const uri = `https://arweave.net/${arweaveTxId}`;
  const bytes = await fetchCiphertext(uri);
  return decodeProductSpec(bytes);
}

/**
 * Public URL for the customer-facing checkout page. Centralised so all
 * call-sites stay in sync (and so tests can verify the shape).
 */
export function buildProductUrl(origin: string, arweaveTxId: string): string {
  // Origin may or may not have a trailing slash — strip any to be safe.
  const trimmed = origin.replace(/\/+$/, "");
  return `${trimmed}/buy/${arweaveTxId}`;
}

// ---------------------------------------------------------------------------
// localStorage cache (per-wallet)
// ---------------------------------------------------------------------------

function safeStorage(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function isCacheEntry(v: unknown): v is ProductCacheEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.arweaveTxId === "string" &&
    typeof e.name === "string" &&
    typeof e.amountBaseUnits === "string" &&
    typeof e.symbol === "string" &&
    typeof e.decimals === "number" &&
    typeof e.createdAt === "number"
  );
}

/** Read the current list of cached products for a wallet. Never throws. */
export function readProductsCache(walletBase58: string): ProductCacheEntry[] {
  const storage = safeStorage();
  if (!storage) return [];
  const raw = storage.getItem(storageKey(walletBase58));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCacheEntry);
  } catch {
    return [];
  }
}

/**
 * Persist the entire list of cached products for a wallet. Best-effort:
 * silently no-ops in environments without localStorage (SSR, tests).
 */
export function writeProductsCache(
  walletBase58: string,
  entries: ProductCacheEntry[],
): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(storageKey(walletBase58), JSON.stringify(entries));
  } catch {
    /* quota / disabled storage — acceptable, Arweave is the source of truth */
  }
}

/**
 * Add a product to the cache, deduplicating by `arweaveTxId`. The newer
 * entry wins so re-running create with the same tx id refreshes the row.
 * Entries are kept sorted by createdAt DESC so the dashboard list reads
 * newest-first without resorting.
 */
export function addProductToCache(
  walletBase58: string,
  entry: ProductCacheEntry,
): ProductCacheEntry[] {
  const existing = readProductsCache(walletBase58);
  const filtered = existing.filter((e) => e.arweaveTxId !== entry.arweaveTxId);
  const next = [entry, ...filtered].sort((a, b) => b.createdAt - a.createdAt);
  writeProductsCache(walletBase58, next);
  return next;
}

/**
 * Remove a product from the cache by `arweaveTxId`. Returns the new list.
 * The Arweave object remains forever (it's permanent); this only hides
 * the row from the merchant's dashboard. If they share the URL the
 * customer can still pay.
 */
export function removeProductFromCache(
  walletBase58: string,
  arweaveTxId: string,
): ProductCacheEntry[] {
  const existing = readProductsCache(walletBase58);
  const next = existing.filter((e) => e.arweaveTxId !== arweaveTxId);
  if (next.length !== existing.length) {
    writeProductsCache(walletBase58, next);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * Format a base-units amount with the mint's decimals into a display string.
 * Trailing-zero fraction digits are trimmed but at least 2 are kept (so
 * "1.00 SOL" rather than "1 SOL"). Pure function; no locale.
 */
export function formatProductAmount(
  baseUnits: string | bigint,
  decimals: number,
): string {
  const n = typeof baseUnits === "bigint" ? baseUnits : BigInt(baseUnits);
  if (decimals === 0) return n.toString();
  const divisor = 10n ** BigInt(decimals);
  const whole = n / divisor;
  const fraction = (n % divisor).toString().padStart(decimals, "0");
  // Keep at least 2 fractional digits, then strip extra trailing zeros.
  const minKeep = Math.min(2, decimals);
  let trimmed = fraction;
  while (trimmed.length > minKeep && trimmed.endsWith("0")) {
    trimmed = trimmed.slice(0, -1);
  }
  return `${whole.toString()}.${trimmed}`;
}

/**
 * Parse a user-entered amount (e.g. "1.5") into base units given decimals.
 * Returns `null` on any malformed input. Caller is responsible for
 * surfacing a helpful error message.
 */
export function parseAmountToBaseUnits(
  value: string,
  decimals: number,
): bigint | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(new RegExp(`^(\\d+)(?:\\.(\\d{0,${decimals}}))?$`));
  if (!match) return null;
  const whole = BigInt(match[1]);
  const fraction = (match[2] ?? "").padEnd(decimals, "0").slice(0, decimals);
  return whole * 10n ** BigInt(decimals) + BigInt(fraction);
}
