"use client";

import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import idl from "./invoice_registry.json";
import type { InvoiceRegistry } from "./invoice_registry";
import { INVOICE_REGISTRY_PROGRAM_ID, RPC_URL } from "./constants";

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
    .accountsPartial({ invoice: invoicePda, payer: wallet.publicKey })
    .transaction();
  return signAndSubmit(wallet, program.provider.connection as any, tx);
}

export async function fetchInvoice(wallet: any, pda: PublicKey) {
  const program = getProgram(wallet);
  return (program.account as any).invoice.fetch(pda);
}

export async function fetchInvoicesByCreator(wallet: any, creator: PublicKey) {
  const program = getProgram(wallet);
  // Invoice layout: discriminator(8) + version(1) + creator(32) + ...
  // Creator field starts at offset 8 + 1 = 9.
  return (program.account as any).invoice.all([
    { memcmp: { offset: 8 + 1, bytes: creator.toBase58() } },
  ]);
}
