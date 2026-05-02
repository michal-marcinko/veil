import { PublicKey } from "@solana/web3.js";

export const NETWORK: "devnet" | "mainnet" = (process.env.NEXT_PUBLIC_SOLANA_NETWORK as any) || "devnet";
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "https://api.devnet.solana.com";
export const RPC_WSS_URL = process.env.NEXT_PUBLIC_RPC_WSS_URL || "wss://api.devnet.solana.com";

export const INVOICE_REGISTRY_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_INVOICE_REGISTRY_PROGRAM_ID || "54ryi8hcihut8fDSVFSbN5NbArQ5GAd1xgmGCA3hqWoo",
);

// Devnet default: Circle's devnet USDC. Override with NEXT_PUBLIC_PAYMENT_MINT
// if Umbra's shielded pool for this mint isn't live on devnet — the documented
// fallback is wSOL (So11111111111111111111111111111111111111112).
// Mainnet USDC is EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v.
export const USDC_MINT = new PublicKey(
  process.env.NEXT_PUBLIC_PAYMENT_MINT || "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
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
