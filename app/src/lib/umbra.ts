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

// ---------------------------------------------------------------------------
// Task 17: Scan + claim + encrypted-balance query (Alice receives)
// ---------------------------------------------------------------------------

import {
  getClaimableUtxoScannerFunction,
  getReceiverClaimableUtxoToEncryptedBalanceClaimerFunction,
  getUmbraRelayer,
  getEncryptedBalanceQuerierFunction,
} from "@umbra-privacy/sdk";
import {
  getClaimReceiverClaimableUtxoIntoEncryptedBalanceProver,
} from "@umbra-privacy/web-zk-prover";
import { UMBRA_RELAYER_API } from "./constants";

/**
 * Scan for claimable UTXOs sent to the current client's wallet.
 *
 * Per the Design 2026-04-16 addendum, callers should treat ALL returned
 * UTXOs as claimable — there is no UTXO-to-invoice linkage via optionalData.
 * Per-invoice "did Bob pay?" is answered by reading the Anchor PDA status,
 * not by UTXO correlation.
 */
export async function scanClaimableUtxos(client: UmbraClient) {
  const scan = getClaimableUtxoScannerFunction({ client });
  // treeIndex 0, startInsertionIndex 0 — scan the full current tree.
  const result = await scan(0 as any, 0 as any);
  return {
    received: result.received,
    publicReceived: result.publicReceived,
  };
}

export interface ClaimArgs {
  client: UmbraClient;
  utxos: any[]; // ScannedUtxoData[] — opaque to us
}

export async function claimUtxos(args: ClaimArgs) {
  const zkProver = getClaimReceiverClaimableUtxoIntoEncryptedBalanceProver();
  const relayer = getUmbraRelayer({ apiEndpoint: UMBRA_RELAYER_API } as any);
  const claim = getReceiverClaimableUtxoToEncryptedBalanceClaimerFunction(
    { client: args.client },
    { zkProver, relayer } as any,
  );
  return claim(args.utxos as any);
}

/**
 * Query the encrypted balance for a specific mint on the current client.
 *
 * The SDK's querier takes an array of mints and returns a Map. We unpack
 * the single-mint case here. Returns 0n when the account has no "shared"
 * state (non_existent / uninitialized / mxe all surface as 0).
 */
export async function getEncryptedBalance(
  client: UmbraClient,
  mint: string,
): Promise<bigint> {
  const query = getEncryptedBalanceQuerierFunction({ client });
  const results = await query([mint as any]);
  for (const [, result] of results as any) {
    if (result?.state === "shared") {
      return BigInt(result.balance);
    }
  }
  return 0n;
}

// ---------------------------------------------------------------------------
// Task 18: Compliance grant issuance
// ---------------------------------------------------------------------------

import { getComplianceGrantIssuerFunction } from "@umbra-privacy/sdk";

export interface ComplianceGrantArgs {
  client: UmbraClient;
  /** Auditor / receiver wallet address (base58). */
  receiverAddress: string;
  /** Granter's MVK X25519 public key (32 bytes). */
  granterX25519PubKey: Uint8Array;
  /** Receiver's X25519 public key (32 bytes). */
  receiverX25519PubKey: Uint8Array;
  /** Optional nonce — defaults to BigInt(Date.now()) per SDK example. */
  nonce?: bigint;
}

/**
 * Issue a compliance (viewing) grant to `receiver` so they can decrypt
 * shared ciphertexts produced by this client. Real SDK signature (as of
 * @umbra-privacy/sdk 2.0.3) is positional:
 *   createGrant(receiver, granterX25519, receiverX25519, nonce, ...)
 *   returns Promise<TransactionSignature>
 * (NOT the object-param form drafted in the plan).
 */
export async function issueComplianceGrant(args: ComplianceGrantArgs): Promise<string> {
  const createGrant = getComplianceGrantIssuerFunction({ client: args.client });
  const nonce = args.nonce ?? BigInt(Date.now());
  const signature = await createGrant(
    args.receiverAddress as any,
    args.granterX25519PubKey as any,
    args.receiverX25519PubKey as any,
    nonce as any,
  );
  return signature as unknown as string;
}
