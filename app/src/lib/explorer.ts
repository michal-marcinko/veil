import { NETWORK } from "@/lib/constants";

/**
 * Solana Explorer cluster suffix derived from the configured NETWORK.
 *
 * On mainnet, no suffix is needed (Explorer defaults to mainnet-beta).
 * On any non-mainnet network (devnet, testnet, etc.) we append a
 * `?cluster=` query so the link works regardless of which cluster
 * the user's Solana Explorer happens to remember.
 */
export const explorerClusterSuffix: string =
  NETWORK === "mainnet" ? "" : `?cluster=${NETWORK}`;

/** Build a Solana Explorer URL for a given path (e.g. `tx/<sig>` or `address/<pda>`). */
export function explorerUrl(path: string): string {
  return `https://explorer.solana.com/${path}${explorerClusterSuffix}`;
}

/** Convenience: Explorer URL for an account/PDA address. */
export function explorerAddressUrl(address: string): string {
  return explorerUrl(`address/${address}`);
}

/** Convenience: Explorer URL for a transaction signature. */
export function explorerTxUrl(signature: string): string {
  return explorerUrl(`tx/${signature}`);
}
