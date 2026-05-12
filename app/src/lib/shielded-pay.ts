/**
 * Pure-logic helpers that decide whether Bob's encrypted Umbra balance is
 * sufficient to pay an invoice directly from the shielded pool (Feature C).
 *
 * These live in their own module so the branching logic on /pay/[id] can be
 * unit-tested without mocking React, the Umbra SDK transport, or wallet
 * adapters. The page component calls `loadShieldedAvailability` once after
 * metadata decrypts and renders the toggle based on the returned kind.
 */

import { getEncryptedBalance as realGetEncryptedBalance } from "./umbra";

export type ShieldedAvailability =
  | { kind: "available"; balance: bigint }
  | { kind: "insufficient"; balance: bigint }
  | { kind: "errored"; message: string };

export interface DecideArgs {
  encryptedBalance: bigint;
  total: bigint;
}

/**
 * Pure decision: is `encryptedBalance` at least `total`?
 *
 * Not async, no I/O — easy to unit-test at every boundary (zero, exact, short,
 * over). The degenerate zero-total case is intentionally 'available' because
 * `encryptedBalance >= total` holds; the page should still gate on total > 0
 * before rendering a pay button at all, but that's not this helper's concern.
 */
export function decideShieldedPayAvailability(args: DecideArgs): ShieldedAvailability {
  if (args.encryptedBalance >= args.total) {
    return { kind: "available", balance: args.encryptedBalance };
  }
  return { kind: "insufficient", balance: args.encryptedBalance };
}

export interface LoadArgs {
  client: any; // UmbraClient — intentionally opaque here to keep this module SDK-agnostic.
  mint: string;
  total: bigint;
  /** Injected for tests; defaults to the production helper in `./umbra`. */
  getEncryptedBalance?: (client: any, mint: string) => Promise<bigint>;
}

/**
 * Fetch Bob's encrypted balance for `mint` and return a decision.
 *
 * Errors from the indexer (network, parsing, auth) become `{ kind: "errored" }`
 * rather than propagating — the UI should silently fall back to the public
 * flow rather than block the pay page on a shielded-query failure.
 */
export async function loadShieldedAvailability(args: LoadArgs): Promise<ShieldedAvailability> {
  const fetchBalance = args.getEncryptedBalance ?? realGetEncryptedBalance;
  try {
    const balance = await fetchBalance(args.client, args.mint);
    return decideShieldedPayAvailability({ encryptedBalance: balance, total: args.total });
  } catch (err) {
    return { kind: "errored", message: err instanceof Error ? err.message : String(err) };
  }
}
