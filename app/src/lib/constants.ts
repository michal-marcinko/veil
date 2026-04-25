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

export const UMBRA_INDEXER_API = "https://utxo-indexer.api.umbraprivacy.com";
export const UMBRA_RELAYER_API = "https://relayer.api.umbraprivacy.com";
