"use client";

import { PublicKey } from "@solana/web3.js";
import { INVOICE_REGISTRY_PROGRAM_ID } from "@/lib/constants";

/**
 * Seed for the `PaymentIntentLock` PDA — must match the Rust program's
 * `LockPaymentIntent` accounts struct in
 * `programs/invoice-registry/.../lib.rs`.
 *
 * The lock PDA is the on-chain proof that a specific payer paid a
 * specific invoice. Deriving it client-side lets us batch-fetch lock
 * accounts via `getMultipleAccountsInfo` without a separate RPC roundtrip
 * per invoice.
 */
export const LOCK_SEED = "intent_lock";

/**
 * Derive the `PaymentIntentLock` PDA for an invoice.
 *
 * Mirrors `payInvoiceCpi.ts::deriveLockPda` but exposed publicly so the
 * dashboard, verifier, and incoming-invoice section can all use the same
 * derivation without depending on the heavy CPI module.
 */
export function deriveLockPda(invoicePda: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(LOCK_SEED), invoicePda.toBuffer()],
    INVOICE_REGISTRY_PROGRAM_ID,
  );
  return pda;
}
