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
