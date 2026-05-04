"use client";

/**
 * Gift cards — celebratory "send X SOL to anyone" surface.
 *
 * Same primitives as payroll claim links (Stream D): an ephemeral Solana
 * keypair acts as a "shadow Umbra account" that the sender funds + deposits
 * into; the recipient claims by withdrawing to their own wallet. The
 * shadow's private key is encoded in the URL fragment so it never hits a
 * server.
 *
 * What this module adds on top of `payroll-claim-links.ts`:
 *
 *   - A separate URL family rooted at `/gift/<token>` (token == ephemeral
 *     public key — base58, recognisable, looks like a Solana address). The
 *     payroll path `/claim/<batchId>/<row>` is intentionally avoided so
 *     gift recipients never see "payroll" framing.
 *   - A `GiftMetadata` shape that includes a free-text message (the actual
 *     differentiator vs payroll) — base64-packed into the same fragment.
 *   - `createGift()` — a thin orchestrator that runs
 *     generate -> fund -> register -> deposit in one call, returning the
 *     finished share URL. Mirrors `sendViaClaimLink` from PayrollFlow but
 *     with gift-shaped inputs.
 *
 * Cost per gift: ~0.01 SOL. Same breakdown as payroll claim links — see
 * `SHADOW_FUNDING_LAMPORTS` in payroll-claim-links.ts.
 */

import {
  buildShadowClient,
  decodeEphemeralPrivateKey,
  depositToShadow,
  encodeEphemeralPrivateKey,
  ephemeralKeypairFromBytes,
  fundShadowAccount,
  generateEphemeralKeypair,
  registerShadowAccount,
  SHADOW_FUNDING_LAMPORTS,
  type EphemeralKeypair,
} from "./payroll-claim-links";

/** Hard cap so a malicious sender can't try to stuff KB of "message" into the
 *  URL fragment. 240 chars is roughly 2 tweets — plenty for "Happy birthday
 *  Sarah, thanks for the year" without bloating the share URL into something
 *  Slack will refuse to preview. */
export const GIFT_MESSAGE_MAX_CHARS = 240;

/** Same lamports float as payroll claim links. Re-exported so the gift UI
 *  can render the cost without importing two modules for one constant. */
export const GIFT_FUNDING_LAMPORTS = SHADOW_FUNDING_LAMPORTS;

/** Approx SOL displayed in the UI as the "you'll spend extra" cost. */
export const GIFT_FUNDING_SOL = "0.01";

/* ─────────────────────────────────────────────────────────────────────
   Metadata shape — what the URL fragment carries about a gift.
   ───────────────────────────────────────────────────────────────────── */

export interface GiftMetadata {
  /** Display amount, e.g. "0.50". */
  amount: string;
  /** Display symbol, e.g. "SOL" / "USDC". */
  symbol: string;
  /** Base58 mint address. */
  mint: string;
  /** Amount in base units (string to survive JSON roundtrip — bigint isn't
   *  JSON-encodable). */
  amountBaseUnits: string;
  /** Optional free-text message ("Happy birthday!"). Capped at
   *  GIFT_MESSAGE_MAX_CHARS chars before encoding — we never trust senders to
   *  self-limit. */
  message?: string;
  /** Optional sender display name. Falls back to "A friend" if missing on
   *  the recipient page. */
  sender?: string;
  /** Optional recipient name shown back on the share card ("To: Sarah"). */
  recipientName?: string;
}

/* ─────────────────────────────────────────────────────────────────────
   URL generation + parsing
   ───────────────────────────────────────────────────────────────────── */

export interface GenerateGiftUrlArgs {
  baseUrl: string;
  /** Base58 ephemeral pubkey — used as the URL token. */
  ephemeralAddress: string;
  /** 64-byte ephemeral secret key — encoded into the fragment as `k=…`. */
  ephemeralPrivateKey: Uint8Array;
  metadata: GiftMetadata;
}

/**
 * Build the share URL the sender hands off to the recipient. Format:
 *
 *   https://veil.app/gift/<ephemeralPubkey>#k=<priv>&m=<base64-meta>
 *
 * The path token IS the ephemeral pubkey. That's intentional:
 *   - Recipients see a Solana-shaped string in the URL — feels native to
 *     the audience that knows what a Solana address is, and looks
 *     opaque-but-not-suspicious to everyone else (a UUID is more obviously
 *     "random gibberish").
 *   - The recipient page can show the shadow address (same as the path
 *     token) without re-deriving it from the private key — useful when the
 *     fragment is dropped (e.g. URL truncated in an email).
 *   - The pubkey is public information anyway: anyone who can see the URL
 *     could derive it from the fragment. No new disclosure.
 *
 * The fragment (`#…`) is the actual secret-bearing part. Browsers MUST NOT
 * send it in HTTP requests, so even if the URL is shared via Slack/email
 * the secret material stays on the recipient's device.
 */
export function generateGiftUrl(args: GenerateGiftUrlArgs): string {
  if (!args.ephemeralAddress) throw new Error("ephemeralAddress is required");
  const k = encodeEphemeralPrivateKey(args.ephemeralPrivateKey);
  const path = `${trimTrailingSlash(args.baseUrl)}/gift/${encodeURIComponent(
    args.ephemeralAddress,
  )}`;
  const m = encodeGiftMetadata(args.metadata);
  return `${path}#k=${k}&m=${m}`;
}

/** Inverse of generateGiftUrl. Returns priv key + metadata; throws if
 *  fragment is missing the key (recipient can't claim without it). */
export function parseGiftUrlFragment(hash: string): {
  privateKey: Uint8Array;
  metadata: GiftMetadata | null;
} {
  const stripped = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(stripped);
  const k = params.get("k");
  if (!k) throw new Error("Gift URL is missing key fragment (k=...)");
  const privateKey = decodeEphemeralPrivateKey(k);

  let metadata: GiftMetadata | null = null;
  const m = params.get("m");
  if (m) {
    try {
      metadata = decodeGiftMetadata(m);
    } catch {
      // Malformed metadata is non-fatal — claim still works, the page just
      // can't pre-render the amount/message before the recipient connects.
      metadata = null;
    }
  }

  return { privateKey, metadata };
}

/** Pack metadata into URL-safe base64. Trims long messages to keep URLs sane. */
export function encodeGiftMetadata(meta: GiftMetadata): string {
  const safe: GiftMetadata = {
    ...meta,
    message:
      typeof meta.message === "string"
        ? meta.message.slice(0, GIFT_MESSAGE_MAX_CHARS)
        : undefined,
  };
  return base64UrlEncode(JSON.stringify(safe));
}

/** Inverse of encodeGiftMetadata. Throws on malformed JSON / base64. */
export function decodeGiftMetadata(encoded: string): GiftMetadata {
  const json = base64UrlDecode(encoded);
  const parsed = JSON.parse(json) as GiftMetadata;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Gift metadata is not an object");
  }
  if (typeof parsed.amount !== "string" || typeof parsed.symbol !== "string") {
    throw new Error("Gift metadata missing amount/symbol");
  }
  return parsed;
}

/* ─────────────────────────────────────────────────────────────────────
   Orchestration — the high-level `createGift` flow
   ───────────────────────────────────────────────────────────────────── */

export interface CreateGiftArgs {
  /** Wallet adapter context (publicKey + sendTransaction). */
  payerWallet: any;
  /** Sender's already-built Umbra client (signer = payerWallet). */
  payerClient: any;
  /** web3.js Connection bound to the same RPC the SDK uses. */
  connection: any;
  /** Gift amount in base units (e.g. lamports for SOL, micro-USDC for USDC). */
  amount: bigint;
  /** Mint address (base58). */
  mint: string;
  /** Display amount as the user typed it ("0.50") for the metadata blob. */
  amountDisplay: string;
  /** Display symbol ("SOL", "USDC"). */
  symbol: string;
  /** Optional gift note. Truncated to GIFT_MESSAGE_MAX_CHARS. */
  message?: string;
  /** Optional sender display name. */
  senderName?: string;
  /** Optional recipient name. */
  recipientName?: string;
  /** Origin used to build the share URL. Defaults to window.location.origin
   *  when window is available. Override in tests. */
  baseUrl?: string;
}

export interface CreateGiftResult {
  /** Share URL to hand to the recipient. */
  giftUrl: string;
  /** Ephemeral shadow address (also the URL path token). */
  shadowAddress: string;
  /** Funding tx signature — ledger anchor for the SOL float transfer. */
  fundingSignature: string;
  /** Deposit queue signature — anchor for the encrypted deposit. */
  depositSignature: string;
  /** Echo of the metadata blob baked into the share URL. */
  metadata: GiftMetadata;
}

/**
 * Run the full gift-creation pipeline:
 *
 *   1. Generate fresh ephemeral keypair (the shadow account).
 *   2. Sender pays SHADOW_FUNDING_LAMPORTS to the shadow address (one
 *      Phantom popup).
 *   3. Build an Umbra client backed by the ephemeral key + register it
 *      (no popups — funded from step 2).
 *   4. Deposit `amount` from sender's public ATA into the shadow's
 *      encrypted balance (one Phantom popup).
 *   5. Build the share URL with the ephemeral private key in the fragment.
 *
 * Result is the URL the sender posts/copies/sends. The recipient clicks it,
 * connects their wallet, and withdraws.
 *
 * Errors propagate raw — the UI is expected to surface
 *   - "wallet not connected" before calling
 *   - "insufficient SOL" by checking balance ≥ funding lamports first
 * — so this function only deals with happy-path orchestration.
 */
export async function createGift(args: CreateGiftArgs): Promise<CreateGiftResult> {
  if (!args.payerWallet?.publicKey) {
    throw new Error("Sender wallet is not connected");
  }
  if (args.amount <= 0n) {
    throw new Error("Gift amount must be greater than zero");
  }

  const baseUrl =
    args.baseUrl ??
    (typeof window !== "undefined" ? window.location.origin : "");
  if (!baseUrl) {
    throw new Error("Cannot derive baseUrl — pass one explicitly outside the browser");
  }

  const ephemeral: EphemeralKeypair = generateEphemeralKeypair();

  // Step 1: SOL float to shadow (ONE Phantom popup).
  const fundingSignature = await fundShadowAccount({
    payerWallet: args.payerWallet,
    shadowAddress: ephemeral.address,
    lamports: GIFT_FUNDING_LAMPORTS,
    connection: args.connection,
  });

  // Step 2: Umbra registration of the shadow (paid by shadow's own
  // lamports — no wallet popup).
  const shadowClient = await buildShadowClient(ephemeral.privateKey);
  await registerShadowAccount({ shadowClient });

  // Step 3: Deposit from sender's public ATA into shadow's encrypted
  // balance (ONE Phantom popup — signer is the sender's wallet).
  const deposit = await depositToShadow({
    payerClient: args.payerClient,
    shadowAddress: ephemeral.address,
    mint: args.mint,
    amount: args.amount,
  });

  const metadata: GiftMetadata = {
    amount: args.amountDisplay,
    symbol: args.symbol,
    mint: args.mint,
    amountBaseUnits: args.amount.toString(),
    message: args.message,
    sender: args.senderName,
    recipientName: args.recipientName,
  };

  const giftUrl = generateGiftUrl({
    baseUrl,
    ephemeralAddress: ephemeral.address,
    ephemeralPrivateKey: ephemeral.privateKey,
    metadata,
  });

  return {
    giftUrl,
    shadowAddress: ephemeral.address,
    fundingSignature,
    depositSignature: deposit.depositSignature,
    metadata,
  };
}

/* ─────────────────────────────────────────────────────────────────────
   Quick-share helpers — Twitter, email, copy-to-clipboard
   ───────────────────────────────────────────────────────────────────── */

export interface QuickShareTargets {
  twitter: string;
  email: string;
  /** sms: protocol — opens Messages on iOS / SMS app on Android. */
  sms: string;
}

/**
 * Build the deep-link URLs for the "share to…" row on the gift confirmation
 * card. Twitter/X intent, mailto:, sms:. Copy-to-clipboard is a separate
 * `navigator.clipboard.writeText` call in the page (no helper needed).
 *
 * The intent text intentionally does NOT inline the gift URL twice — every
 * platform handles its own URL preview. We pass a short human label first
 * and then the URL.
 */
export function buildGiftQuickShareTargets(args: {
  giftUrl: string;
  amountDisplay: string;
  symbol: string;
  recipientName?: string;
}): QuickShareTargets {
  const recipient = args.recipientName?.trim() || "you";
  const subject = `A gift for ${recipient} — ${args.amountDisplay} ${args.symbol}`;
  const body = `Sending you ${args.amountDisplay} ${args.symbol}. Claim it here: ${args.giftUrl}`;

  return {
    twitter: `https://twitter.com/intent/tweet?text=${encodeURIComponent(
      `Sent ${args.amountDisplay} ${args.symbol} via Veil — claim it here:`,
    )}&url=${encodeURIComponent(args.giftUrl)}`,
    email: `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
    sms: `sms:?&body=${encodeURIComponent(body)}`,
  };
}

/* ─────────────────────────────────────────────────────────────────────
   Recipient-side helper — derive shadow address from URL token
   ───────────────────────────────────────────────────────────────────── */

/**
 * Re-derive the shadow keypair (and hence its address) from the 64-byte
 * private key carried in the fragment. The recipient page calls this so
 * it can show the shadow address in diagnostics ("from <addr>") and as a
 * sanity check that the URL path token matches the in-fragment key.
 */
export function deriveGiftShadow(privateKey: Uint8Array): EphemeralKeypair {
  return ephemeralKeypairFromBytes(privateKey);
}

/* ─────────────────────────────────────────────────────────────────────
   Internal helpers — base64-url codec (mirrors payroll-claim-links)
   ───────────────────────────────────────────────────────────────────── */

function base64UrlEncode(s: string): string {
  // btoa expects latin1 — we walk the string via TextEncoder so unicode
  // (emoji in messages, non-ASCII names) survives the roundtrip.
  const bytes = new TextEncoder().encode(s);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}
