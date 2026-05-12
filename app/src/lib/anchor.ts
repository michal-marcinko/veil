"use client";

import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import idl from "./invoice_registry.json";
import type { InvoiceRegistry } from "./invoice_registry";
import { INVOICE_REGISTRY_PROGRAM_ID, RPC_URL } from "./constants";

/**
 * Anchor returns i64 fields as BN. Coerce to a plain JS number (safe for
 * unix-seconds timestamps through 2038) so downstream code can use Number
 * arithmetic without risking a BigInt-vs-Number mix.
 */
function bnToNumber(val: any): number {
  if (val == null) return 0;
  if (typeof val === "number") return val;
  if (typeof val === "bigint") return Number(val);
  if (typeof val.toNumber === "function") return val.toNumber();
  return Number(val);
}

export interface NormalizedInvoice {
  version: number;
  creator: PublicKey;
  payer: PublicKey | null;
  mint: PublicKey;
  metadataHash: Uint8Array;
  metadataUri: string;
  utxoCommitment: Uint8Array | null;
  status: Record<string, unknown>;
  createdAt: number;
  paidAt: number | null;
  expiresAt: number | null;
  nonce: Uint8Array;
  bump: number;
}

function normalizeInvoice(raw: any): NormalizedInvoice {
  return {
    version: Number(raw.version ?? 0),
    creator: raw.creator,
    payer: raw.payer ?? null,
    mint: raw.mint,
    metadataHash: new Uint8Array(raw.metadataHash ?? []),
    metadataUri: String(raw.metadataUri ?? ""),
    utxoCommitment: raw.utxoCommitment ? new Uint8Array(raw.utxoCommitment) : null,
    status: raw.status ?? {},
    createdAt: bnToNumber(raw.createdAt),
    paidAt: raw.paidAt == null ? null : bnToNumber(raw.paidAt),
    expiresAt: raw.expiresAt == null ? null : bnToNumber(raw.expiresAt),
    nonce: new Uint8Array(raw.nonce ?? []),
    bump: Number(raw.bump ?? 0),
  };
}

// Phantom's Wallet Standard signer auto-submits signed transactions. Anchor's
// .rpc() then sends again and preflight rejects with "already processed".
// Build + sign + submit manually so we can swallow the duplicate-send error.
async function signAndSubmit(wallet: any, connection: Connection, tx: Transaction): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;

  const signed: Transaction = await wallet.signTransaction(tx);
  const sig = bs58.encode(signed.signatures[0].signature!);

  try {
    await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
  } catch (err: any) {
    const msg = (err?.message ?? String(err)).toLowerCase();
    if (!msg.includes("already been processed") && !msg.includes("already processed")) throw err;
  }

  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

/**
 * Anchor 0.30.x reads the program address from the IDL's `address` field,
 * so the `Program` constructor no longer takes a programId argument.
 * `wallet` must satisfy Anchor's `Wallet` interface:
 *   { publicKey, signTransaction, signAllTransactions }.
 */
export function getProgram(wallet: any): Program<InvoiceRegistry> {
  const connection = new Connection(RPC_URL, "confirmed");
  // @solana/web3.js version mismatch between Anchor's nested copy and ours —
  // the types differ but the runtime object is structurally identical.
  const provider = new AnchorProvider(connection as any, wallet, { commitment: "confirmed" });
  return new Program(idl as any, provider) as Program<InvoiceRegistry>;
}

export function deriveInvoicePda(creator: PublicKey, nonce: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("invoice"), creator.toBuffer(), Buffer.from(nonce)],
    INVOICE_REGISTRY_PROGRAM_ID,
  );
}

export async function createInvoiceOnChain(
  wallet: any,
  params: {
    nonce: Uint8Array;
    metadataHash: Uint8Array;
    metadataUri: string;
    mint: PublicKey;
    restrictedPayer: PublicKey | null;
    expiresAt: number | null;
  },
): Promise<PublicKey> {
  const program = getProgram(wallet);
  const [pda] = deriveInvoicePda(wallet.publicKey, params.nonce);

  const metadataHashArr = Array.from(params.metadataHash);
  const nonceArr = Array.from(params.nonce);
  const expiresAt = params.expiresAt !== null ? new BN(params.expiresAt) : null;

  const methodBuilder = params.restrictedPayer
    ? (program.methods as any).createInvoiceRestricted(
        nonceArr,
        metadataHashArr,
        params.metadataUri,
        params.mint,
        expiresAt,
        params.restrictedPayer,
      )
    : (program.methods as any).createInvoice(
        nonceArr,
        metadataHashArr,
        params.metadataUri,
        params.mint,
        expiresAt,
      );

  const tx: Transaction = await methodBuilder
    .accountsPartial({
      invoice: pda,
      creator: wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .transaction();

  await signAndSubmit(wallet, program.provider.connection as any, tx);
  return pda;
}

export async function markPaidOnChain(
  wallet: any,
  invoicePda: PublicKey,
  utxoCommitment: Uint8Array,
): Promise<string> {
  const program = getProgram(wallet);
  const tx: Transaction = await (program.methods as any)
    .markPaid(Array.from(utxoCommitment))
    .accountsPartial({ invoice: invoicePda, creator: wallet.publicKey })
    .transaction();
  return signAndSubmit(wallet, program.provider.connection as any, tx);
}

export async function fetchInvoice(wallet: any, pda: PublicKey): Promise<NormalizedInvoice> {
  const program = getProgram(wallet);
  const raw = await (program.account as any).invoice.fetch(pda);
  return normalizeInvoice(raw);
}

export async function fetchInvoicesByCreator(
  wallet: any,
  creator: PublicKey,
): Promise<Array<{ publicKey: PublicKey; account: NormalizedInvoice }>> {
  const program = getProgram(wallet);
  const all = await (program.account as any).invoice.all([
    { memcmp: { offset: 8 + 1, bytes: creator.toBase58() } },
  ]);
  return all.map((entry: any) => ({
    publicKey: entry.publicKey,
    account: normalizeInvoice(entry.account),
  }));
}

/**
 * Fetch an Invoice account without requiring a connected wallet.
 * Used by the public verifier at `/receipt/[pda]`.
 *
 * Anchor's Program constructor needs a provider, and the provider needs
 * a Wallet shim. We pass one that refuses to sign so any accidental
 * write attempt will fail loudly instead of silently succeeding.
 */
export async function fetchInvoicePublic(pda: PublicKey) {
  const connection = new Connection(RPC_URL, "confirmed");
  const readOnlyWallet = {
    publicKey: PublicKey.default, // not null — AnchorProvider checks for .toBuffer()
    signTransaction: async () => {
      throw new Error("fetchInvoicePublic: read-only provider cannot sign");
    },
    signAllTransactions: async () => {
      throw new Error("fetchInvoicePublic: read-only provider cannot sign");
    },
  };
  const provider = new AnchorProvider(connection as any, readOnlyWallet as any, {
    commitment: "confirmed",
  });
  const program = new Program(idl as any, provider) as Program<InvoiceRegistry>;
  return (program.account as any).invoice.fetch(pda);
}

/**
 * Decoded `PaymentIntentLock` account state.
 *
 * The on-chain layout is `{ invoice: Pubkey, payer: Pubkey, lockedAt: i64,
 * bump: u8 }`; consumers only care about who locked it and when, so we
 * surface those two fields in JS-friendly types. `lockedAt` is unix
 * seconds, coerced from Anchor's BN.
 */
export type LockState = { payer: PublicKey; lockedAt: number };

/**
 * Fetch one PaymentIntentLock account.
 *
 * Anchor throws when the account does not exist (the `paymentIntentLock`
 * coder rejects on AccountNotFound). We swallow that to a clean `null`
 * so callers can render "no lock yet" without a try/catch at every
 * call site. Other errors (RPC down, invalid PDA, decoder mismatch) still
 * propagate.
 */
export async function fetchLockOptional(
  wallet: any,
  lockPda: PublicKey,
): Promise<LockState | null> {
  const program = getProgram(wallet);
  try {
    const raw: any = await (program.account as any).paymentIntentLock.fetch(lockPda);
    return {
      payer: raw.payer,
      lockedAt: bnToNumber(raw.lockedAt),
    };
  } catch (err: any) {
    const msg = (err?.message ?? String(err)).toLowerCase();
    if (
      msg.includes("account does not exist") ||
      msg.includes("could not find") ||
      msg.includes("accountnotfound")
    ) {
      return null;
    }
    throw err;
  }
}

/**
 * Batch-fetch many PaymentIntentLock accounts using a single
 * `getMultipleAccountsInfo` RPC call per 100 PDAs.
 *
 * Returns a Map keyed by lockPda base58 → decoded LockState, or `null` if
 * the account does not exist (i.e. the payer has not locked the invoice
 * yet). The Map preserves insertion order for the input array, but
 * callers should look up by base58 rather than index.
 *
 * Decode failures (corrupted data, wrong discriminator) are logged and
 * mapped to `null`; we never throw on a single bad account because that
 * would brick the dashboard for unrelated invoices.
 */
export async function fetchManyLocks(
  wallet: any,
  lockPdas: PublicKey[],
): Promise<Map<string, LockState | null>> {
  const result = new Map<string, LockState | null>();
  if (lockPdas.length === 0) return result;

  const program = getProgram(wallet);
  const connection = program.provider.connection as Connection;
  const coder: any = (program.account as any).paymentIntentLock.coder.accounts;

  // getMultipleAccountsInfo caps at 100 keys per call. Walk in chunks.
  const CHUNK = 100;
  for (let i = 0; i < lockPdas.length; i += CHUNK) {
    const slice = lockPdas.slice(i, i + CHUNK);
    const infos = await connection.getMultipleAccountsInfo(slice as any, "confirmed");
    for (let j = 0; j < slice.length; j += 1) {
      const pda = slice[j];
      const info = infos[j];
      const key = pda.toBase58();
      if (info == null || info.data == null) {
        result.set(key, null);
        continue;
      }
      try {
        // Anchor 0.30 coders accept both Buffer and Uint8Array; pick the
        // canonical decode method available on this build.
        const data = Buffer.from(info.data as any);
        const decoded: any = coder.decode("paymentIntentLock", data);
        result.set(key, {
          payer: decoded.payer,
          lockedAt: bnToNumber(decoded.lockedAt),
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[Veil anchor] failed to decode lock at ${key}:`, err);
        result.set(key, null);
      }
    }
  }
  return result;
}

/**
 * Fetch the block time of a confirmed Solana transaction signature.
 * Returns unix seconds, or null if the RPC can't find the tx.
 */
export async function fetchTxBlockTime(txSig: string): Promise<number | null> {
  const connection = new Connection(RPC_URL, "confirmed");
  const decoded = bs58.decode(txSig);
  if (decoded.length !== 64) throw new Error(`Invalid tx signature length: ${decoded.length}`);
  const parsed = await connection.getTransaction(txSig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  return parsed?.blockTime ?? null;
}
