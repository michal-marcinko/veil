import { PublicKey } from "@solana/web3.js";

export const NETWORK: "devnet" | "mainnet" = (process.env.NEXT_PUBLIC_SOLANA_NETWORK as any) || "devnet";
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "https://api.devnet.solana.com";
export const RPC_WSS_URL = process.env.NEXT_PUBLIC_RPC_WSS_URL || "wss://api.devnet.solana.com";

export const INVOICE_REGISTRY_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_INVOICE_REGISTRY_PROGRAM_ID || "54ryi8hcihut8fDSVFSbN5NbArQ5GAd1xgmGCA3hqWoo",
);

// Default mint: wSOL (So11111111111111111111111111111111111111112).
// Why not devnet USDC? Circle's devnet USDC mint
// (4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU) is NOT registered in
// Umbra's devnet stealth pool — depositing fails with Anchor error 3012
// (AccountNotInitialized on `fee_schedule`). wSOL works because its mint
// is the same address on every cluster and Umbra has it initialized on
// devnet. This default also matches `app/.env.example`.
//
// Override with NEXT_PUBLIC_PAYMENT_MINT to point at a different mint
// (e.g. mainnet USDC: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v).
export const USDC_MINT = new PublicKey(
  process.env.NEXT_PUBLIC_PAYMENT_MINT || "So11111111111111111111111111111111111111112",
);

// wSOL: 9 decimals; USDC (devnet + mainnet): 6 decimals.
const WSOL = "So11111111111111111111111111111111111111112";
export const PAYMENT_SYMBOL = USDC_MINT.toBase58() === WSOL ? "SOL" : "USDC";
export const PAYMENT_DECIMALS = USDC_MINT.toBase58() === WSOL ? 9 : 6;

// Umbra runs SEPARATE indexer + relayer endpoints per network (per
// https://github.com/umbra-defi/docs indexer/overview.mdx). Pointing the
// devnet app at the mainnet indexer hits a healthy endpoint that simply
// has zero knowledge of any devnet transaction — scan returns 0 forever.
//
// Devnet:  utxo-indexer.api-devnet.umbraprivacy.com
// Mainnet: utxo-indexer.api.umbraprivacy.com
//
// Allow override via env (NEXT_PUBLIC_UMBRA_INDEXER_API / _RELAYER_API)
// in case the URLs change before Umbra cuts a stable release.
const UMBRA_INDEXER_API_DEFAULT =
  NETWORK === "mainnet"
    ? "https://utxo-indexer.api.umbraprivacy.com"
    : "https://utxo-indexer.api-devnet.umbraprivacy.com";
const UMBRA_RELAYER_API_DEFAULT =
  NETWORK === "mainnet"
    ? "https://relayer.api.umbraprivacy.com"
    : "https://relayer.api-devnet.umbraprivacy.com";
export const UMBRA_INDEXER_API =
  process.env.NEXT_PUBLIC_UMBRA_INDEXER_API || UMBRA_INDEXER_API_DEFAULT;
export const UMBRA_RELAYER_API =
  process.env.NEXT_PUBLIC_UMBRA_RELAYER_API || UMBRA_RELAYER_API_DEFAULT;

// VeilPay CPI wrapper — see programs/veil-pay/programs/veil-pay/src/lib.rs.
// Optional: when unset, payInvoice falls back to the SDK's stock orchestration
// (2 popups). When configured, the public-balance pay path routes through the
// single-tx VeilPay program for a single Phantom popup with proper SOL preview.
export const VEIL_PAY_PROGRAM_ID: PublicKey | null = (() => {
  const raw = process.env.NEXT_PUBLIC_VEIL_PAY_PROGRAM_ID;
  if (!raw) return null;
  try {
    return new PublicKey(raw);
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[Veil] NEXT_PUBLIC_VEIL_PAY_PROGRAM_ID set but not a valid Pubkey — ignoring",
    );
    return null;
  }
})();

// Umbra deposit program ID (used by VeilPay CPI for instruction routing in
// the wrapper tx). Matches the value baked into our deployed `veil_pay`
// crate. Devnet + mainnet share the same program ID per Umbra docs.
export const UMBRA_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_UMBRA_PROGRAM_ID ||
    "DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ",
);

// Address Lookup Table for the VeilPay single-popup tx. The pay tx packs 19
// unique accounts and is ~250 bytes over the 1232-byte cap; ALT'ing 13 static
// accounts (programs, sysvars, Umbra PDAs, mint) lands the tx ~100 bytes
// under. Deploy via `cd app && node scripts/deploy-veilpay-alt.mjs`.
//
// Optional: when unset, payInvoiceCpi compiles a v0 message without ALT and
// will fail at serialize time with the same "transaction too large" error
// that motivated this work. Same null-falls-through pattern as
// VEIL_PAY_PROGRAM_ID — null means "ALT not configured", not "ALT disabled".
export const VEILPAY_ALT_ADDRESS: PublicKey | null = (() => {
  const raw = process.env.NEXT_PUBLIC_VEILPAY_ALT_ADDRESS;
  if (!raw) return null;
  try {
    return new PublicKey(raw);
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[Veil] NEXT_PUBLIC_VEILPAY_ALT_ADDRESS set but not a valid Pubkey — ignoring",
    );
    return null;
  }
})();
