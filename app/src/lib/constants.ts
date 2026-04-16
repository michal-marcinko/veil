import { PublicKey } from "@solana/web3.js";

export const NETWORK: "devnet" | "mainnet" = (process.env.NEXT_PUBLIC_SOLANA_NETWORK as any) || "devnet";
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "https://api.devnet.solana.com";
export const RPC_WSS_URL = process.env.NEXT_PUBLIC_RPC_WSS_URL || "wss://api.devnet.solana.com";

export const INVOICE_REGISTRY_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_INVOICE_REGISTRY_PROGRAM_ID || "54ryi8hcihut8fDSVFSbN5NbArQ5GAd1xgmGCA3hqWoo",
);

export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

export const UMBRA_INDEXER_API = "https://utxo-indexer.api.umbraprivacy.com";
export const UMBRA_RELAYER_API = "https://relayer.api.umbraprivacy.com";
