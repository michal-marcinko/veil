"use client";

import {
  getUmbraClient,
  getUserAccountQuerierFunction,
  getUserRegistrationFunction,
} from "@umbra-privacy/sdk";
import { NETWORK, RPC_URL, RPC_WSS_URL, UMBRA_INDEXER_API } from "./constants";

type UmbraClient = Awaited<ReturnType<typeof getUmbraClient>>;

let cachedClient: UmbraClient | null = null;
let cachedSignerAddress: string | null = null;

export async function getOrCreateClient(signer: any): Promise<UmbraClient> {
  if (cachedClient && cachedSignerAddress === signer.address?.toString()) {
    return cachedClient;
  }
  const client = await getUmbraClient({
    signer,
    network: NETWORK,
    rpcUrl: RPC_URL,
    rpcSubscriptionsUrl: RPC_WSS_URL,
    indexerApiEndpoint: UMBRA_INDEXER_API,
  });
  cachedClient = client;
  cachedSignerAddress = signer.address?.toString() ?? null;
  return client;
}

export function resetClient() {
  cachedClient = null;
  cachedSignerAddress = null;
}

export async function isFullyRegistered(client: UmbraClient): Promise<boolean> {
  const query = getUserAccountQuerierFunction({ client });
  const result = await query(client.signer.address);
  if (result.state !== "exists") return false;
  return (
    result.data.isUserAccountX25519KeyRegistered &&
    result.data.isUserCommitmentRegistered
  );
}

export async function ensureRegistered(
  client: UmbraClient,
  onProgress?: (step: "init" | "x25519" | "commitment", status: "pre" | "post") => void,
): Promise<void> {
  if (await isFullyRegistered(client)) return;

  const register = getUserRegistrationFunction({ client });
  await register({
    confidential: true,
    anonymous: true,
    callbacks: onProgress
      ? {
          userAccountInitialisation: {
            pre: async () => onProgress("init", "pre"),
            post: async () => onProgress("init", "post"),
          },
          registerX25519PublicKey: {
            pre: async () => onProgress("x25519", "pre"),
            post: async () => onProgress("x25519", "post"),
          },
          registerUserForAnonymousUsage: {
            pre: async () => onProgress("commitment", "pre"),
            post: async () => onProgress("commitment", "post"),
          },
        }
      : undefined,
  });
}

// ---------------------------------------------------------------------------
// Task 16: Pay invoice (public-balance → receiver-claimable UTXO creation)
// ---------------------------------------------------------------------------

import {
  getPublicBalanceToReceiverClaimableUtxoCreatorFunction,
} from "@umbra-privacy/sdk";
import {
  getCreateReceiverClaimableUtxoFromPublicBalanceProver,
} from "@umbra-privacy/web-zk-prover";

export interface PayInvoiceArgs {
  client: UmbraClient;
  recipientAddress: string;   // Alice's wallet (payee)
  mint: string;               // USDC mint
  amount: bigint;             // in native units
}

export interface PayInvoiceResult {
  createProofAccountSignature: string;
  createUtxoSignature: string;
  closeProofAccountSignature?: string;
}

/**
 * Pay an invoice by creating a receiver-claimable UTXO funded from Bob's
 * public ATA. Per the Design 2026-04-16 addendum, optionalData is NOT
 * exposed on `CreateUtxoArgs` — the linkage between UTXO and invoice is
 * established off-chain (Bob calls `markPaidOnChain` separately).
 */
export async function payInvoice(args: PayInvoiceArgs): Promise<PayInvoiceResult> {
  const zkProver = getCreateReceiverClaimableUtxoFromPublicBalanceProver();
  const create = getPublicBalanceToReceiverClaimableUtxoCreatorFunction(
    { client: args.client },
    { zkProver } as any,
  );

  const result = await create({
    destinationAddress: args.recipientAddress as any,
    mint: args.mint as any,
    amount: args.amount as any,
  });

  return {
    createProofAccountSignature: result.createProofAccountSignature as unknown as string,
    createUtxoSignature: result.createUtxoSignature as unknown as string,
    closeProofAccountSignature: result.closeProofAccountSignature as unknown as string | undefined,
  };
}
