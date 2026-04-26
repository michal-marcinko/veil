"use client";

import {
  getUmbraClient,
  getUserAccountQuerierFunction,
  getUserRegistrationFunction,
  getWebsocketTransactionForwarder,
} from "@umbra-privacy/sdk";
import {
  getUserRegistrationProver,
  getCdnZkAssetProvider,
} from "@umbra-privacy/web-zk-prover";
import { getWallets } from "@wallet-standard/app";
import {
  getTransactionEncoder,
  getTransactionDecoder,
  getSignatureFromTransaction,
} from "@solana/transactions";
import { NETWORK, RPC_URL, RPC_WSS_URL, UMBRA_INDEXER_API } from "./constants";

type UmbraClient = Awaited<ReturnType<typeof getUmbraClient>>;

// Umbra's default CDN (CloudFront) serves no CORS headers. Route all
// browser-side ZK-asset fetches through our same-origin Next.js rewrite
// (`/umbra-cdn/*` → CloudFront) configured in next.config.mjs.
function proxiedAssetProvider() {
  return getCdnZkAssetProvider({ baseUrl: "/umbra-cdn" });
}

let cachedClient: UmbraClient | null = null;
let cachedSignerAddress: string | null = null;

// Custom IUmbraSigner wrapper around a Wallet Standard account.
//
// Replaces the SDK's `createSignerFromWalletAccount` because of a bug in
// @umbra-privacy/sdk 2.1.1 (chunk-HA5FLM63.js ~line 119): after the wallet
// signs, the SDK returns the ORIGINAL `transaction.messageBytes` with only
// the new signatures merged in. When Phantom modifies the tx (e.g. injects
// a ComputeBudget / priority-fee instruction for larger txs, which it does
// automatically for CreatePublicUtxoProofAccount), the signature is over
// Phantom's modified messageBytes but the forwarded tx carries the old
// messageBytes — validator rejects with "signature verification failed".
//
// Fix: return the fully-decoded transaction (Phantom's modified
// messageBytes + its signatures) as-is. Preserves any extra props from the
// original for SDK compatibility.
function createFixedWalletStandardSigner(wallet: any, account: any) {
  const feats = wallet.features as any;
  const signTx = feats["solana:signTransaction"];
  const signMsg = feats["solana:signMessage"];
  if (!signTx) throw new Error(`Wallet "${wallet.name}" lacks solana:signTransaction`);
  if (!signMsg) throw new Error(`Wallet "${wallet.name}" lacks solana:signMessage`);

  const encoder = getTransactionEncoder();
  const decoder = getTransactionDecoder();

  return {
    address: account.address,
    async signTransaction(transaction: any) {
      const wireBytes = encoder.encode(transaction);
      const [output] = await signTx.signTransaction({ account, transaction: wireBytes });
      const decoded: any = decoder.decode(output.signedTransaction);
      return {
        ...transaction,
        messageBytes: decoded.messageBytes,
        signatures: { ...transaction.signatures, ...decoded.signatures },
      };
    },
    async signTransactions(transactions: any[]) {
      const inputs = transactions.map((tx) => ({
        account,
        transaction: encoder.encode(tx),
      }));
      const outputs = await signTx.signTransaction(...inputs);
      return transactions.map((tx, i) => {
        const decoded: any = decoder.decode(outputs[i].signedTransaction);
        return {
          ...tx,
          messageBytes: decoded.messageBytes,
          signatures: { ...tx.signatures, ...decoded.signatures },
        };
      });
    },
    async signMessage(message: Uint8Array) {
      const [output] = await signMsg.signMessage({ account, message });
      return { message, signature: output.signature, signer: account.address };
    },
  };
}

// Resolve a Wallet Standard Wallet + WalletAccount for the currently
// connected @solana/wallet-adapter-react wallet by matching publicKey.
function resolveWalletStandardSigner(walletCtx: any) {
  const connectedPubkey = walletCtx?.publicKey?.toBase58?.();
  if (!connectedPubkey) {
    throw new Error("Wallet not connected");
  }

  const wallets = getWallets().get();
  for (const w of wallets) {
    const hasSign = (w.features as any)["solana:signTransaction"];
    const hasMsg = (w.features as any)["solana:signMessage"];
    if (!hasSign || !hasMsg) continue;

    for (const account of w.accounts) {
      if (!account.chains.some((c: string) => c.startsWith("solana:"))) continue;
      if (account.address === connectedPubkey) {
        return createFixedWalletStandardSigner(w, account) as any;
      }
    }
  }

  throw new Error(
    `No Wallet Standard wallet exposes account ${connectedPubkey} with ` +
      "solana:signTransaction and solana:signMessage features. " +
      "Ensure Phantom/Solflare/Backpack is installed and connected.",
  );
}

// Phantom's wallet-standard signTransaction auto-submits the signed tx to
// the network for some transaction shapes (notably larger txs where it
// injects a ComputeBudget priority-fee instruction). When the SDK then
// calls its own sendTransaction via the transaction forwarder, the RPC
// preflight simulator rejects the second submission with
// "AlreadyProcessed". The tx is genuinely on-chain — treat that specific
// error as success and return the sig from the signed transaction.
function looksLikeAlreadyProcessed(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const causeMsg = (err as any)?.cause?.message ?? "";
  const stack = (err as any)?.stack ?? "";
  return (
    /already\s+(been\s+)?processed/i.test(msg) ||
    /already\s+(been\s+)?processed/i.test(causeMsg) ||
    /already\s+(been\s+)?processed/i.test(stack)
  );
}

function makeTolerantForwarder() {
  const base = getWebsocketTransactionForwarder({
    rpcUrl: RPC_URL,
    rpcSubscriptionsUrl: RPC_WSS_URL,
  });

  async function sendOne(tx: any, options: any) {
    try {
      const [sig] = await (base.forwardSequentially as any)([tx], options);
      return sig;
    } catch (err) {
      if (looksLikeAlreadyProcessed(err)) {
        return getSignatureFromTransaction(tx);
      }
      throw err;
    }
  }

  return {
    forwardSequentially: async (txs: readonly any[], options: any = {}) => {
      const out: any[] = [];
      for (const tx of txs) out.push(await sendOne(tx, options));
      return out;
    },
    forwardInParallel: async (txs: readonly any[], options: any = {}) => {
      return Promise.all(txs.map((tx) => sendOne(tx, options)));
    },
    fireAndForget: base.fireAndForget,
  };
}

export async function getOrCreateClient(walletCtx: any): Promise<UmbraClient> {
  const connectedAddress = walletCtx?.publicKey?.toBase58?.() ?? null;
  if (cachedClient && cachedSignerAddress === connectedAddress) {
    return cachedClient;
  }

  const signer = resolveWalletStandardSigner(walletCtx);

  const client = await getUmbraClient(
    {
      signer,
      network: NETWORK,
      rpcUrl: RPC_URL,
      rpcSubscriptionsUrl: RPC_WSS_URL,
      indexerApiEndpoint: UMBRA_INDEXER_API,
    },
    { transactionForwarder: makeTolerantForwarder() as any },
  );
  cachedClient = client;
  cachedSignerAddress = connectedAddress;
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

  const zkProver = getUserRegistrationProver({ assetProvider: proxiedAssetProvider() });
  const register = getUserRegistrationFunction({ client }, { zkProver } as any);
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
  getEncryptedBalanceToReceiverClaimableUtxoCreatorFunction,
} from "@umbra-privacy/sdk";
import {
  getCreateReceiverClaimableUtxoFromPublicBalanceProver,
  getCreateReceiverClaimableUtxoFromEncryptedBalanceProver,
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
 * established off-chain when the recipient claims and acknowledges receipt.
 */
export async function payInvoice(args: PayInvoiceArgs): Promise<PayInvoiceResult> {
  const zkProver = getCreateReceiverClaimableUtxoFromPublicBalanceProver({
    assetProvider: proxiedAssetProvider(),
  });
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

/**
 * Pay an invoice by creating a receiver-claimable UTXO funded from Bob's
 * ENCRYPTED (shielded) balance — Feature C, full shielding.
 *
 * Contrast with `payInvoice` above which funds the UTXO from Bob's PUBLIC
 * ATA. A public-balance pay leaks a deposit tx a block explorer can correlate
 * with the invoice; an encrypted-balance pay happens entirely inside the
 * mixer and emits no plaintext amount.
 *
 * The returned shape is the SAME as `PayInvoiceResult` so callers can branch
 * on availability without restructuring their result handling. Both SDK
 * creators return objects, but the encrypted variant uses `queueSignature`
 * (queue-based MPC flow) where the public variant has `createUtxoSignature`
 * — we map `queueSignature` → `createUtxoSignature` to keep `PayInvoiceResult`
 * a single shape across both pay paths.
 *
 * Preconditions:
 *   - Bob is a fully-registered Umbra user (same as public-balance pay).
 *   - Bob's encrypted balance for `mint` is >= `amount`. The caller must
 *     verify this BEFORE invoking — prefer `loadShieldedAvailability` from
 *     `./shielded-pay` for the check. If the balance is insufficient the SDK
 *     will throw inside proof generation.
 *
 * Post-call the recipient dashboard claims the incoming UTXO and invokes
 * `markPaidOnChain(wallet, pda, utxoCommitment)`.
 */
export async function payInvoiceFromShielded(args: PayInvoiceArgs): Promise<PayInvoiceResult> {
  const zkProver = getCreateReceiverClaimableUtxoFromEncryptedBalanceProver({
    assetProvider: proxiedAssetProvider(),
  });
  const create = getEncryptedBalanceToReceiverClaimableUtxoCreatorFunction(
    { client: args.client },
    { zkProver } as any,
  );

  const result = await create({
    destinationAddress: args.recipientAddress as any,
    mint: args.mint as any,
    amount: args.amount as any,
  });

  return {
    createProofAccountSignature: (result as any).createProofAccountSignature as unknown as string,
    createUtxoSignature: (result as any).queueSignature as unknown as string,
    closeProofAccountSignature: (result as any).closeProofAccountSignature as unknown as string | undefined,
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
  // The SDK's U32 type is a branded bigint (per
  // node_modules/@umbra-privacy/sdk/dist/types-*.d.ts), so passing JS
  // numbers triggers "Cannot mix BigInt and other types" inside the SDK
  // when it does internal arithmetic. Pass BigInt(0) explicitly.
  const result = await scan(BigInt(0) as any, BigInt(0) as any);
  return {
    received: result.received,
    publicReceived: result.publicReceived,
  };
}

export interface ScanSummary {
  receivedCount: number;
  publicReceivedCount: number;
  /** Total value across public-received UTXOs. Always a bigint. */
  publicReceivedTotal: bigint;
}

/**
 * Compute a plain-old-data summary over a scan result. Guarantees bigint-only
 * arithmetic — callers must never reach for `0` as an accumulator because the
 * SDK's `amount` field is a bigint.
 */
export function summarizeScan(scan: {
  received: any[];
  publicReceived: any[];
}): ScanSummary {
  let total = 0n;
  for (const utxo of scan.publicReceived) {
    const raw = (utxo as any)?.amount;
    if (raw == null) continue;
    total += typeof raw === "bigint" ? raw : BigInt(raw);
  }
  return {
    receivedCount: scan.received.length,
    publicReceivedCount: scan.publicReceived.length,
    publicReceivedTotal: total,
  };
}

export interface ClaimArgs {
  client: UmbraClient;
  utxos: any[]; // ScannedUtxoData[] — opaque to us
}

export async function claimUtxos(args: ClaimArgs) {
  const zkProver = getClaimReceiverClaimableUtxoIntoEncryptedBalanceProver({
    assetProvider: proxiedAssetProvider(),
  });
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
      const raw = result.balance;
      if (typeof raw === "bigint") return raw;
      if (typeof raw === "number") return BigInt(Math.trunc(raw));
      if (typeof raw === "string") return BigInt(raw);
      return BigInt(raw as any);
    }
  }
  return 0n;
}

// ---------------------------------------------------------------------------
// Task 18: Compliance grant issuance
// ---------------------------------------------------------------------------

import bs58 from "bs58";
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
  /** Test-only: replace the real SDK issuer with a stub returning a signature. */
  __issuerOverride?: (
    receiver: string,
    granterX25519: Uint8Array,
    receiverX25519: Uint8Array,
    nonce: bigint,
  ) => Promise<string>;
}

/**
 * Issue a compliance (viewing) grant to `receiver` so they can decrypt
 * shared ciphertexts produced by this client. Real SDK signature (as of
 * @umbra-privacy/sdk 2.0.3) is positional:
 *   createGrant(receiver, granterX25519, receiverX25519, nonce, ...)
 *   returns Promise<TransactionSignature>
 * (NOT the object-param form drafted in the plan).
 *
 * Side-effect: persists the grant to localStorage for later listing/revoke
 * (see PersistedGrant + listComplianceGrants).
 */
export async function issueComplianceGrant(args: ComplianceGrantArgs): Promise<string> {
  const nonce = args.nonce ?? BigInt(Date.now());
  const issuer = args.__issuerOverride
    ?? ((r, g, rx, n) => {
      const createGrant = getComplianceGrantIssuerFunction({ client: args.client });
      return createGrant(r as any, g as any, rx as any, n as any) as unknown as Promise<string>;
    });
  const signature = await issuer(
    args.receiverAddress,
    args.granterX25519PubKey,
    args.receiverX25519PubKey,
    nonce,
  );

  persistIssuedGrant({
    granterAddress: args.client.signer.address as unknown as string,
    receiverAddress: args.receiverAddress,
    granterX25519Base58: bs58.encode(args.granterX25519PubKey),
    receiverX25519Base58: bs58.encode(args.receiverX25519PubKey),
    nonce: nonce.toString(),
    issuedAt: Date.now(),
    signature,
  });

  return signature;
}

// ---------------------------------------------------------------------------
// listComplianceGrants — read persisted + probe on-chain status
// ---------------------------------------------------------------------------

import { getUserComplianceGrantQuerierFunction } from "@umbra-privacy/sdk";

export type GrantStatus = "active" | "revoked" | "unknown";

export interface GrantWithStatus extends PersistedGrant {
  status: GrantStatus;
}

export interface ListComplianceGrantsArgs {
  client: UmbraClient;
  /** Test-only override for the SDK querier factory result. */
  __querierOverride?: (
    granterX25519: Uint8Array,
    nonce: bigint,
    receiverX25519: Uint8Array,
  ) => Promise<{ state: "exists" | "non_existent" }>;
}

export async function listComplianceGrants(
  args: ListComplianceGrantsArgs,
): Promise<GrantWithStatus[]> {
  const granterAddress = args.client.signer.address as unknown as string;
  const persisted = readPersistedGrants(granterAddress);
  if (persisted.length === 0) return [];

  const querier = args.__querierOverride
    ?? (() => {
      const fn = getUserComplianceGrantQuerierFunction({ client: args.client });
      return (
        granterX25519: Uint8Array,
        nonce: bigint,
        receiverX25519: Uint8Array,
      ) => fn(granterX25519 as any, nonce as any, receiverX25519 as any) as unknown as Promise<{ state: "exists" | "non_existent" }>;
    })();

  const annotated = await Promise.all(
    persisted.map(async (g): Promise<GrantWithStatus> => {
      try {
        const result = await querier(
          bs58.decode(g.granterX25519Base58),
          BigInt(g.nonce),
          bs58.decode(g.receiverX25519Base58),
        );
        return { ...g, status: result.state === "exists" ? "active" : "revoked" };
      } catch {
        return { ...g, status: "unknown" };
      }
    }),
  );
  return annotated;
}

// ---------------------------------------------------------------------------
// revokeComplianceGrant — wrapper around getComplianceGrantRevokerFunction
// ---------------------------------------------------------------------------

import { getComplianceGrantRevokerFunction } from "@umbra-privacy/sdk";

export interface RevokeComplianceGrantArgs {
  client: UmbraClient;
  grant: PersistedGrant;
  __revokerOverride?: (
    receiver: string,
    granterX25519: Uint8Array,
    receiverX25519: Uint8Array,
    nonce: bigint,
  ) => Promise<string>;
}

export async function revokeComplianceGrant(
  args: RevokeComplianceGrantArgs,
): Promise<string> {
  const revoker = args.__revokerOverride
    ?? ((r, g, rx, n) => {
      const deleteGrant = getComplianceGrantRevokerFunction({ client: args.client });
      return deleteGrant(r as any, g as any, rx as any, n as any) as unknown as Promise<string>;
    });

  const signature = await revoker(
    args.grant.receiverAddress,
    bs58.decode(args.grant.granterX25519Base58),
    bs58.decode(args.grant.receiverX25519Base58),
    BigInt(args.grant.nonce),
  );

  removePersistedGrant(
    args.grant.granterAddress,
    args.grant.receiverX25519Base58,
    args.grant.nonce,
  );
  return signature;
}

// ---------------------------------------------------------------------------
// readScopedInvoice — auditor-side re-encryption wrapper
//
// Per @umbra-privacy/sdk 2.1.1, getSharedCiphertextReencryptorForUserGrantFunction
// returns a fire-and-forget handler signature; the actual MPC callback that
// surfaces plaintext lands later via the Arcium queue. End-to-end plaintext
// retrieval is a deliberate follow-up — this wrapper returns
// `{ handlerSignature, pending: true }` and the UI displays a pending state.
// ---------------------------------------------------------------------------

import { getSharedCiphertextReencryptorForUserGrantFunction } from "@umbra-privacy/sdk";

export interface ReadScopedInvoiceArgs {
  client: UmbraClient;
  /** Granter's MVK X25519 public key (32 bytes). */
  granterX25519PubKey: Uint8Array;
  /** Receiver (auditor) X25519 public key (32 bytes). */
  receiverX25519PubKey: Uint8Array;
  /** Grant nonce — must match the nonce used when the grant was created. */
  grantNonce: bigint;
  /** Input nonce — the nonce under which the invoice ciphertexts were encrypted. */
  inputNonce: bigint;
  /** 1–6 shared-mode ciphertexts (32 bytes each) to re-encrypt. */
  ciphertexts: Uint8Array[];
  __reencryptorOverride?: (
    granterX25519: Uint8Array,
    receiverX25519: Uint8Array,
    grantNonce: bigint,
    inputNonce: bigint,
    ciphertexts: Uint8Array[],
  ) => Promise<string>;
}

export interface ReadScopedInvoiceResult {
  /** Handler transaction signature — the MPC callback is still pending. */
  handlerSignature: string;
  /** Always true in this SDK version — plaintext retrieval is a follow-up. */
  pending: true;
}

export async function readScopedInvoice(
  args: ReadScopedInvoiceArgs,
): Promise<ReadScopedInvoiceResult> {
  if (args.ciphertexts.length === 0) {
    throw new Error("readScopedInvoice: need at least one ciphertext");
  }
  if (args.ciphertexts.length > 6) {
    throw new Error(
      `readScopedInvoice: SDK accepts at most 6 ciphertexts per call (got ${args.ciphertexts.length})`,
    );
  }
  const reencrypt = args.__reencryptorOverride
    ?? ((g, r, gn, inN, cts) => {
      const fn = getSharedCiphertextReencryptorForUserGrantFunction({ client: args.client });
      return fn(g as any, r as any, gn as any, inN as any, cts as any) as unknown as Promise<string>;
    });

  const handlerSignature = await reencrypt(
    args.granterX25519PubKey,
    args.receiverX25519PubKey,
    args.grantNonce,
    args.inputNonce,
    args.ciphertexts,
  );

  return { handlerSignature, pending: true };
}

// ---------------------------------------------------------------------------
// Feature A: Compliance grant registry (localStorage-backed)
//
// The Umbra SDK does NOT expose a "list my grants as granter" function. Grant
// PDAs are marker accounts (seeds: granterX25519 || nonce || receiverX25519)
// and the indexer API does not document a grants-by-granter endpoint as of
// 2026-04-21 (probed: HTTP 404). We therefore persist issued grants client-side
// keyed by the granter's wallet address; on page load we refresh status by
// probing the on-chain PDA via getUserComplianceGrantQuerierFunction.
// ---------------------------------------------------------------------------

const GRANT_STORAGE_KEY_PREFIX = "veil.grants.v1.";

export interface PersistedGrant {
  /** Granter Solana wallet (base58). */
  granterAddress: string;
  /** Receiver/auditor Solana wallet (base58). */
  receiverAddress: string;
  /** Granter's MVK X25519 public key, base58. */
  granterX25519Base58: string;
  /** Receiver's X25519 public key, base58. */
  receiverX25519Base58: string;
  /** Grant nonce, decimal string (BigInt.toString()). */
  nonce: string;
  /** Unix millis when issuance tx was confirmed. */
  issuedAt: number;
  /** Issuance transaction signature. */
  signature: string;
}

function storageKey(granterAddress: string): string {
  return `${GRANT_STORAGE_KEY_PREFIX}${granterAddress}`;
}

export function persistIssuedGrant(grant: PersistedGrant): void {
  if (typeof localStorage === "undefined") return;
  const key = storageKey(grant.granterAddress);
  const raw = localStorage.getItem(key);
  const list: PersistedGrant[] = raw ? JSON.parse(raw) : [];
  list.push(grant);
  localStorage.setItem(key, JSON.stringify(list));
}

export function readPersistedGrants(granterAddress: string): PersistedGrant[] {
  if (typeof localStorage === "undefined") return [];
  const raw = localStorage.getItem(storageKey(granterAddress));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function removePersistedGrant(
  granterAddress: string,
  receiverX25519Base58: string,
  nonce: string,
): void {
  if (typeof localStorage === "undefined") return;
  const key = storageKey(granterAddress);
  const list = readPersistedGrants(granterAddress);
  const next = list.filter(
    (g) => !(g.receiverX25519Base58 === receiverX25519Base58 && g.nonce === nonce),
  );
  localStorage.setItem(key, JSON.stringify(next));
}
