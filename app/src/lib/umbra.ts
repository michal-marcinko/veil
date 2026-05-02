"use client";

import {
  getUserAccountX25519KeypairDeriver,
  getMasterViewingKeyX25519KeypairDeriver,
  getAesDecryptor,
  getUmbraClient,
  getUserEncryptionKeyRotatorFunction,
  getUserAccountQuerierFunction,
  getUserRegistrationFunction,
  getWebsocketTransactionForwarder,
} from "@umbra-privacy/sdk";
import { x25519 } from "@noble/curves/ed25519";
import { keccak_256 } from "@noble/hashes/sha3";
import { findEncryptedUserAccountPda } from "@umbra-privacy/sdk/pda";
import { decodeEncryptedUserAccount } from "@umbra-privacy/umbra-codama";
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
import bs58 from "bs58";
import { NETWORK, RPC_URL, RPC_WSS_URL, UMBRA_INDEXER_API } from "./constants";

type UmbraClient = Awaited<ReturnType<typeof getUmbraClient>>;

// Umbra's default CDN (CloudFront) serves no CORS headers. Route all
// browser-side ZK-asset fetches through our same-origin Next.js rewrite
// (`/umbra-cdn/*` → CloudFront) configured in next.config.mjs.
function proxiedAssetProvider() {
  return getCdnZkAssetProvider({ baseUrl: "/umbra-cdn" });
}

function isVeilDebugEnabled(): boolean {
  return process.env.NEXT_PUBLIC_VEIL_DEBUG === "1";
}

function debugLog(message: string, details?: unknown) {
  if (!isVeilDebugEnabled()) return;
  // eslint-disable-next-line no-console
  console.log(message, details);
}

function bytesMatch(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((byte, i) => byte === b[i]);
}

function bytesToBase58(bytes: Uint8Array | null): string | null {
  return bytes ? bs58.encode(bytes) : null;
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

// localStorage-backed master-seed storage, scoped per wallet address.
//
// Why this exists: the SDK's default masterSeedStorage is a closure-only
// in-memory cache (see node_modules/@umbra-privacy/sdk/dist/index.js
// `getDefaultMasterSeedStorage`). Every page reload spins up a fresh
// closure, so `getMasterSeed()` falls through to the wallet-signature-based
// generator on every session. Phantom's `signMessage` is not guaranteed to
// produce identical signatures across calls — and we observed it doesn't
// (see decryption diagnostics: same wallet produced different X25519
// pubkeys across sessions, breaking ECDH symmetry between the encrypter
// and the decrypter). Persisting the seed in localStorage pins the
// derivation, so the same wallet always derives the same X25519 keypair.
//
// Seed length is 64 bytes (U512). We store it base64-encoded under
// `veil:umbra:masterSeed:<walletAddress>` so swapping wallets in the same
// browser loads the right seed (or generates a fresh one for a new wallet
// on first use). On corruption (wrong length, malformed base64, etc.) we
// fall back to "doesn't exist" so the SDK regenerates from scratch.
const MASTER_SEED_BYTE_LENGTH = 64;

function masterSeedStorageKey(walletAddress: string): string {
  return `veil:umbra:masterSeed:${walletAddress}`;
}

function createPersistentMasterSeedStorage(walletAddress: string) {
  // Capture the storage key once so a later wallet swap can't accidentally
  // load/store under the wrong namespace if the same closure gets reused.
  const key = masterSeedStorageKey(walletAddress);
  // In-memory cache. Without this, the SDK calls `load` on every internal
  // `getMasterSeed()` (which runs many times per refresh — each scan,
  // claim, balance query etc. derives keys), spamming the console and
  // hammering localStorage with redundant reads.
  let inMemoryCache: Uint8Array | null = null;

  function safeStorage(): Storage | null {
    try {
      if (typeof window === "undefined" || !window.localStorage) return null;
      return window.localStorage;
    } catch {
      return null;
    }
  }

  return {
    load: async (): Promise<{ exists: false } | { exists: true; seed: Uint8Array }> => {
      // Hot path: in-memory cache (set on first load or first store).
      // Silent — no log, no localStorage read.
      if (inMemoryCache) {
        return { exists: true, seed: inMemoryCache };
      }

      const storage = safeStorage();
      if (!storage) return { exists: false };

      let encoded: string | null;
      try {
        encoded = storage.getItem(key);
      } catch {
        return { exists: false };
      }
      if (!encoded) return { exists: false };

      // Decode + length-check. Anything off → treat as missing AND wipe the
      // bad entry so we don't keep retrying corrupt bytes every session.
      try {
        const binary = atob(encoded);
        if (binary.length !== MASTER_SEED_BYTE_LENGTH) {
          storage.removeItem(key);
          return { exists: false };
        }
        const seed = new Uint8Array(MASTER_SEED_BYTE_LENGTH);
        for (let i = 0; i < MASTER_SEED_BYTE_LENGTH; i++) {
          seed[i] = binary.charCodeAt(i);
        }
        inMemoryCache = seed;
        debugLog("[umbra master-seed] loaded persisted seed (first time this session)", {
          walletAddress,
          seedHead: bytesToBase58(seed.slice(0, 8)),
        });
        return { exists: true, seed };
      } catch {
        try {
          storage.removeItem(key);
        } catch {
          /* ignore */
        }
        return { exists: false };
      }
    },
    store: async (seed: Uint8Array): Promise<{ success: boolean }> => {
      inMemoryCache = seed;
      const storage = safeStorage();
      if (!storage) return { success: false };
      try {
        let binary = "";
        for (let i = 0; i < seed.length; i++) {
          binary += String.fromCharCode(seed[i]);
        }
        storage.setItem(key, btoa(binary));
        debugLog("[umbra master-seed] persisted new seed", {
          walletAddress,
          seedHead: bytesToBase58(seed.slice(0, 8)),
        });
        return { success: true };
      } catch {
        return { success: false };
      }
    },
  };
}

export async function getOrCreateClient(walletCtx: any): Promise<UmbraClient> {
  const connectedAddress = walletCtx?.publicKey?.toBase58?.() ?? null;
  if (cachedClient && cachedSignerAddress === connectedAddress) {
    return cachedClient;
  }

  const signer = resolveWalletStandardSigner(walletCtx);

  const masterSeedStorage = connectedAddress
    ? createPersistentMasterSeedStorage(connectedAddress)
    : undefined;

  const client = await getUmbraClient(
    {
      signer,
      network: NETWORK,
      rpcUrl: RPC_URL,
      rpcSubscriptionsUrl: RPC_WSS_URL,
      indexerApiEndpoint: UMBRA_INDEXER_API,
    },
    {
      transactionForwarder: makeTolerantForwarder() as any,
      ...(masterSeedStorage ? { masterSeedStorage: masterSeedStorage as any } : {}),
    },
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

export interface UmbraReceiverDiagnostics {
  signerAddress: string;
  userAccountPda: string | null;
  accountState: "exists" | "non_existent";
  isUserAccountX25519KeyRegistered: boolean;
  isUserCommitmentRegistered: boolean;
  derivedTokenX25519PublicKey: string | null;
  registeredTokenX25519PublicKey: string | null;
  tokenX25519Matches: boolean | null;
  derivedMasterViewingKeyX25519PublicKey: string | null;
  registeredMasterViewingKeyX25519PublicKey: string | null;
  masterViewingKeyX25519Matches: boolean | null;
}

export async function diagnoseUmbraReceiver(client: UmbraClient): Promise<UmbraReceiverDiagnostics> {
  const signerAddress = (client as any)?.signer?.address as string;
  const query = getUserAccountQuerierFunction({ client });
  const queryResult = await query(signerAddress as any);

  let userAccountPda: string | null = null;
  let registeredTokenKey: Uint8Array | null = null;
  let registeredMvkKey: Uint8Array | null = null;

  if (queryResult.state === "exists") {
    const pda = await findEncryptedUserAccountPda(
      signerAddress as any,
      (client as any).networkConfig.programId,
    );
    userAccountPda = String(pda);
    const accountMap = await (client as any).accountInfoProvider([pda], { commitment: "confirmed" });
    const maybeAccount = accountMap.get(pda);
    if (maybeAccount?.exists) {
      const decoded: any = decodeEncryptedUserAccount(maybeAccount as any);
      registeredTokenKey = new Uint8Array(
        Array.from(decoded.data.x25519PublicKeyForTokenEncryption.first),
      );
      registeredMvkKey = new Uint8Array(
        Array.from(decoded.data.x25519PublicKeyForMasterViewingKeyEncryption.first),
      );
    }
  }

  let derivedTokenKey: Uint8Array | null = null;
  let derivedMvkKey: Uint8Array | null = null;
  if (queryResult.state === "exists") {
    const deriveToken = getUserAccountX25519KeypairDeriver({ client } as any);
    const tokenKeypair = await deriveToken();
    derivedTokenKey = new Uint8Array(tokenKeypair.x25519Keypair.publicKey);

    const deriveMvk = getMasterViewingKeyX25519KeypairDeriver({ client } as any);
    const mvkKeypair = await deriveMvk();
    derivedMvkKey = new Uint8Array(mvkKeypair.x25519Keypair.publicKey);
  }

  return {
    signerAddress,
    userAccountPda,
    accountState: queryResult.state,
    isUserAccountX25519KeyRegistered:
      queryResult.state === "exists" && queryResult.data.isUserAccountX25519KeyRegistered,
    isUserCommitmentRegistered:
      queryResult.state === "exists" && queryResult.data.isUserCommitmentRegistered,
    derivedTokenX25519PublicKey: bytesToBase58(derivedTokenKey),
    registeredTokenX25519PublicKey: bytesToBase58(registeredTokenKey),
    tokenX25519Matches:
      queryResult.state === "exists" ? bytesMatch(derivedTokenKey, registeredTokenKey) : null,
    derivedMasterViewingKeyX25519PublicKey: bytesToBase58(derivedMvkKey),
    registeredMasterViewingKeyX25519PublicKey: bytesToBase58(registeredMvkKey),
    masterViewingKeyX25519Matches:
      queryResult.state === "exists" ? bytesMatch(derivedMvkKey, registeredMvkKey) : null,
  };
}

export async function repairUmbraReceiverKey(client: UmbraClient): Promise<string[]> {
  const register = getUserRegistrationFunction({ client });
  const rotate = getUserEncryptionKeyRotatorFunction(register);
  return (await rotate()) as unknown as string[];
}

/**
 * One-shot legacy-recovery: if this wallet's on-chain registered X25519
 * pubkey doesn't match the current (now-stable, persisted-seed-backed)
 * derivation, rotate the on-chain key once so the two align.
 *
 * Why this matters in the pay flow specifically:
 *   - Bob's encrypt path (sdk index.js:9077) uses his CURRENTLY-DERIVED
 *     X25519 private key for ECDH(bobPriv, alicePub).
 *   - Alice's decrypt path (sdk index.js:1067) uses Bob's REGISTERED
 *     on-chain pubkey (returned by the indexer as
 *     `depositorX25519PublicKey`) for ECDH(alicePriv, bobPubFromChain).
 *   - These produce equal shared secrets ONLY IF Bob's currently-derived
 *     priv corresponds to Bob's on-chain registered pub. If Bob registered
 *     under a previous (drifted, pre-localStorage-fix) session, his
 *     on-chain pub is stale — Alice's AES-GCM decrypt fails with
 *     "invalid ghash tag" and the UTXO is silently dropped.
 *
 * The rotate is a one-time operation: once executed, Bob's on-chain pub
 * matches his persisted-seed derivation, and every future session stays
 * aligned without further rotation.
 *
 * NOTE on shielded balances: rotating orphans any pre-existing shielded
 * UTXOs encrypted under Bob's previous key. Acceptable for the demo (Bob
 * is a fresh payer with a public-balance flow), but production should
 * drain shielded balances before calling this.
 *
 * Returns `{ rotated: false }` if keys already aligned (no on-chain tx),
 * or `{ rotated: true, signatures }` if the rotate happened.
 */
export async function ensureReceiverKeyAligned(
  client: UmbraClient,
): Promise<{ rotated: false } | { rotated: true; signatures: string[] }> {
  const diag = await diagnoseUmbraReceiver(client);
  if (diag.tokenX25519Matches !== false) {
    // `true` means aligned; `null` means no account yet (caller should
    // have run ensureRegistered first). Either way, nothing to do here.
    return { rotated: false };
  }
  debugLog("[umbra key-align] mismatch detected, rotating on-chain key", {
    derived: diag.derivedTokenX25519PublicKey,
    registered: diag.registeredTokenX25519PublicKey,
  });
  const signatures = await repairUmbraReceiverKey(client);
  return { rotated: true, signatures };
}

export async function ensureRegistered(
  client: UmbraClient,
  onProgress?: (step: "init" | "x25519" | "commitment", status: "pre" | "post") => void,
): Promise<void> {
  // CRITICAL: short-circuit when already registered.
  //
  // SDK note: `getUserRegistrationFunction` is NOT idempotent — calling
  // it on a fully-registered account ROTATES the on-chain X25519 token
  // encryption key to a fresh derivation. This breaks two things:
  //
  //   1. Encrypt-side asymmetry. The pay function (sdk index.js:9077)
  //      uses Bob's CURRENTLY-DERIVED X25519 private key for ECDH, but
  //      the receiver's decrypt (sdk index.js:1067) reads Bob's
  //      REGISTERED X25519 public key from on-chain via the indexer's
  //      depositorX25519PublicKey field. If Bob's key was rotated
  //      between encrypt time and the next page nav (which would
  //      re-rotate it again here), the registered pubkey on-chain no
  //      longer corresponds to the private key Bob used in ECDH —
  //      decryption fails with "invalid ghash tag".
  //
  //   2. Old UTXOs become unclaimable. Any UTXO encrypted under a key
  //      pre-rotation is silently lost.
  //
  // Re-registration is a deliberate operation, exposed via the explicit
  // "Repair Umbra key" button (repairUmbraReceiverKey) which uses the
  // same registration function but with user consent.
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

  debugLog("[Veil payInvoice] creating UTXO destined for:", {
    destinationAddress: args.recipientAddress,
    payerSignerAddress: (args.client as any)?.signer?.address,
    mint: args.mint,
    amount: args.amount.toString(),
  });

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
  getEncryptedBalanceToPublicBalanceDirectWithdrawerFunction,
} from "@umbra-privacy/sdk";
import {
  getClaimReceiverClaimableUtxoIntoEncryptedBalanceProver,
} from "@umbra-privacy/web-zk-prover";
import { UMBRA_RELAYER_API } from "./constants";

function writeU128Le(value: bigint, out: Uint8Array, offset: number) {
  let remaining = value;
  for (let i = 0; i < 16; i++) {
    out[offset + i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
}

function addressFromLowHigh(low: bigint | null | undefined, high: bigint | null | undefined) {
  if (low == null || high == null) return null;
  const bytes = new Uint8Array(32);
  writeU128Le(low, bytes, 0);
  writeU128Le(high, bytes, 16);
  return bs58.encode(bytes);
}

function describeIndexedUtxo(utxo: any) {
  const h1 = utxo?.h1Components;
  return {
    senderAddress: addressFromLowHigh(h1?.senderAddressLow, h1?.senderAddressHigh),
    mintAddress: addressFromLowHigh(h1?.mintAddressLow, h1?.mintAddressHigh),
    depositorX25519PublicKey: bytesToBase58(
      utxo?.depositorX25519PublicKey ? new Uint8Array(utxo.depositorX25519PublicKey) : null,
    ),
    eventType: utxo?.eventType,
    slot: utxo?.slot,
    timestamp: utxo?.timestamp,
  };
}

/**
 * Scan for claimable UTXOs sent to the current client's wallet.
 *
 * Per the Design 2026-04-16 addendum, callers should treat ALL returned
 * UTXOs as claimable — there is no UTXO-to-invoice linkage via optionalData.
 * Per-invoice "did Bob pay?" is answered by reading the Anchor PDA status,
 * not by UTXO correlation.
 */
/**
 * DIAGNOSTIC: fetch the indexer page containing Bob's most recent UTXO
 * and dump the raw runtime shape. This tells us:
 *  - whether the UTXO is actually in the indexer
 *  - what `typeof utxo.treeIndex` is at runtime (bigint vs number — the
 *    SDK's strict-inequality filter on line 1208 silently drops every
 *    UTXO if the type doesn't match BigInt(0) we pass in)
 *  - whether decryption attempts even reach Alice's UTXO
 *
 * Only logs when NEXT_PUBLIC_VEIL_DEBUG=1.
 */
export async function dumpRecentIndexerUtxos(client: UmbraClient, lookbackCount = 10) {
  if (!isVeilDebugEnabled()) return;
  try {
    const fetcher = (client as any).fetchUtxoData;
    if (!fetcher) {
      // eslint-disable-next-line no-console
      console.warn("[Veil dump] client has no fetchUtxoData");
      return;
    }
    // First fetch with cursor 0 to learn totalCount, then jump near the end.
    const peek = await fetcher(BigInt(0), BigInt(2 ** 20 - 1), 1);
    const total = (peek as any).totalCount;
    const totalNum = typeof total === "bigint" ? total : BigInt(total ?? 0);
    const startCursor = totalNum > BigInt(lookbackCount) ? totalNum - BigInt(lookbackCount) : BigInt(0);
    const tail = await fetcher(startCursor, BigInt(2 ** 20 - 1), lookbackCount + 5);
    // eslint-disable-next-line no-console
    console.log("[Veil dump] indexer tail (last items):", {
      totalCount: total,
      startCursor: startCursor.toString(),
      itemsReturned: (tail as any).items?.size ?? (tail as any).items?.length,
    });
    const items = (tail as any).items;
    const entries = items instanceof Map ? Array.from(items.entries()) : Object.entries(items ?? {});
    for (const [key, utxo] of entries.slice(-Math.min(lookbackCount, entries.length))) {
      // eslint-disable-next-line no-console
      console.log("[Veil dump] utxo", String(key), {
        treeIndex: (utxo as any).treeIndex,
        treeIndexType: typeof (utxo as any).treeIndex,
        insertionIndex: (utxo as any).insertionIndex,
        insertionIndexType: typeof (utxo as any).insertionIndex,
        absoluteIndex: (utxo as any).absoluteIndex,
        ...describeIndexedUtxo(utxo),
        depositorX25519PublicKeyLen: (utxo as any).depositorX25519PublicKey?.length,
        aesEncryptedDataLen: (utxo as any).aesEncryptedData?.length,
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[Veil dump] failed:", err);
  }
}

export async function debugDumpIndexerTail(client: UmbraClient, lookbackCount = 10) {
  await dumpRecentIndexerUtxos(client, lookbackCount);
}

// Mirrors SDK's AES domain separator constants (line ~1039 of index.js)
const AES_DOMAIN_SEPARATORS = {
  EPHEMERAL: keccak_256(
    new TextEncoder().encode("UmbraPrivacy / CreateSelfClaimableUtxoFromEncryptedBalance"),
  ).slice(0, 12),
  RECEIVER: keccak_256(
    new TextEncoder().encode("UmbraPrivacy / CreateReceiverClaimableUtxoFromEncryptedBalance"),
  ).slice(0, 12),
  PUBLIC_EPHEMERAL: keccak_256(
    new TextEncoder().encode("UmbraPrivacy / CreateSelfClaimableUtxoFromPublicBalance"),
  ).slice(0, 12),
  PUBLIC_RECEIVER: keccak_256(
    new TextEncoder().encode("UmbraPrivacy / CreateReceiverClaimableUtxoFromPublicBalance"),
  ).slice(0, 12),
} as const;

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return a.every((byte, i) => byte === b[i]);
}

function bytesPreview(b: Uint8Array | null | undefined, n = 8): string {
  if (!b) return "(null)";
  return Array.from(b.slice(0, n))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * DIAGNOSTIC: replicate the SDK's tryDecryptUtxo on a single UTXO with
 * verbose per-step logging. Tells us exactly which stage of decryption
 * silently fails.
 */
export async function manualDecryptUtxo(client: UmbraClient, utxo: any) {
  if (!isVeilDebugEnabled()) return;
  const idx = utxo?.insertionIndex?.toString?.() ?? "?";
  try {
    // Step 1: derive Alice's X25519 keypair
    const derive = getUserAccountX25519KeypairDeriver({ client } as any);
    const keypair: any = await derive();
    const alicePriv = new Uint8Array(keypair.x25519Keypair.privateKey);
    const alicePub = new Uint8Array(keypair.x25519Keypair.publicKey);
    // eslint-disable-next-line no-console
    console.log(`[manual decrypt #${idx}] context:`, describeIndexedUtxo(utxo));
    // eslint-disable-next-line no-console
    console.log(`[manual decrypt #${idx}] alice priv:${bytesPreview(alicePriv)} pub:${bytesPreview(alicePub)}`);

    // Step 2: get Bob's depositor pubkey from UTXO
    const bobPub = utxo.depositorX25519PublicKey
      ? new Uint8Array(utxo.depositorX25519PublicKey)
      : null;
    // eslint-disable-next-line no-console
    console.log(
      `[manual decrypt #${idx}] bob depositor pub len:${bobPub?.length} bytes:${bytesPreview(bobPub)}`,
    );
    if (!bobPub || bobPub.length !== 32) {
      // eslint-disable-next-line no-console
      console.error(`[manual decrypt #${idx}] ❌ bob pubkey wrong length`);
      return;
    }

    // Step 3: ECDH
    let sharedSecret: Uint8Array;
    try {
      sharedSecret = x25519.getSharedSecret(alicePriv, bobPub);
      // eslint-disable-next-line no-console
      console.log(`[manual decrypt #${idx}] ✓ ECDH ok, shared:${bytesPreview(sharedSecret)}`);
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error(`[manual decrypt #${idx}] ❌ ECDH failed:`, err?.message ?? err);
      return;
    }

    // Step 4: derive AES key
    const aesKey = keccak_256(sharedSecret).slice(0, 32);
    // eslint-disable-next-line no-console
    console.log(`[manual decrypt #${idx}] aes key:${bytesPreview(aesKey)}`);

    // Step 5: AES decrypt
    const aesDecryptor = getAesDecryptor();
    let plaintext: Uint8Array;
    try {
      plaintext = await aesDecryptor(aesKey as any, utxo.aesEncryptedData);
      // eslint-disable-next-line no-console
      console.log(
        `[manual decrypt #${idx}] ✓ AES decrypt ok, plaintext len:${plaintext.length} first16:${bytesPreview(plaintext, 16)}`,
      );
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error(
        `[manual decrypt #${idx}] ❌ AES decrypt FAILED — wrong key. ciphertext len:${utxo.aesEncryptedData?.length}`,
        err?.message ?? err,
      );
      return;
    }

    // Step 6: domain separator check
    const sep = plaintext.slice(56, 68);
    const matches = {
      EPHEMERAL: bytesEqual(sep, AES_DOMAIN_SEPARATORS.EPHEMERAL),
      RECEIVER: bytesEqual(sep, AES_DOMAIN_SEPARATORS.RECEIVER),
      PUBLIC_EPHEMERAL: bytesEqual(sep, AES_DOMAIN_SEPARATORS.PUBLIC_EPHEMERAL),
      PUBLIC_RECEIVER: bytesEqual(sep, AES_DOMAIN_SEPARATORS.PUBLIC_RECEIVER),
    };
    const matched = Object.entries(matches).find(([, v]) => v)?.[0] ?? null;
    // eslint-disable-next-line no-console
    console.log(
      `[manual decrypt #${idx}] domain separator:${bytesPreview(sep, 12)} matched:${matched ?? "❌ NONE"}`,
    );
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.error(`[manual decrypt #${idx}] outer fail:`, err);
  }
}

export async function scanClaimableUtxos(client: UmbraClient) {
  // NOTE: we removed the manualDecryptUtxo loop that sampled the tail of
  // the global indexer. That was deeply misleading — the global pool
  // contains random other devnet users' deposits whose `depositorX25519
  // PublicKey` is THEIR pub, not ours. Trying to decrypt those with our
  // private key correctly fails with "invalid ghash tag" — that error
  // never indicated a bug in our code or the SDK.
  //
  // The actual claimable scan below (`getClaimableUtxoScannerFunction`)
  // iterates the full tree and bucketizes only UTXOs whose AES decrypt
  // succeeds under our key AND whose domain separator matches one of the
  // four claim types. If that returns 0/0/0/0 it means the indexer has
  // no UTXO addressed to us in the scanned window — either the deposit
  // hasn't reached the indexer yet (sync lag) or the destination address
  // on the deposit doesn't match our wallet.
  const scan = getClaimableUtxoScannerFunction({ client });
  // treeIndex 0, startInsertionIndex 0, endInsertionIndex 1_000_000.
  // The SDK's U32 type is a branded bigint (per
  // node_modules/@umbra-privacy/sdk/dist/types-*.d.ts), so passing JS
  // numbers triggers "Cannot mix BigInt and other types" inside the SDK.
  //
  // The third arg (endInsertionIndex) is optional in the SDK; keeping it
  // explicit makes the scan window visible in our own diagnostics.
  // Pass an explicit upper bound; 1M leaves covers any
  // realistic devnet tree size.
  //
  // The SDK splits results into 4 buckets:
  //   - received          : encrypted-balance UTXOs from others
  //   - publicReceived    : public-balance UTXOs from others via public ATA
  //   - selfBurnable      : encrypted-balance UTXOs you sent yourself
  //   - publicSelfBurnable: public-balance UTXOs you sent yourself
  // Watermark-based incremental scan. The SDK exposes
  // `nextScanStartIndex` on every scan result, computed as
  // `lastSeenInsertionIndex + 1` over the entire window we just walked
  // (sdk index.js:1234). Saving it and passing it back as
  // startInsertionIndex on the next call means each subsequent scan
  // returns ONLY UTXOs newer than what we've already processed — the
  // already-claimed ones simply don't appear, so no 409 round-trips.
  //
  // Storage key is per-wallet so wallet swaps don't leak watermarks.
  // If localStorage has no entry, we start from 0 (full scan).
  const signerAddr = (client as any)?.signer?.address as string | undefined;
  const watermarkKey = signerAddr ? `veil:scanWatermark:${signerAddr}` : null;
  const startIndex = loadScanWatermark(watermarkKey);
  const result = await scan(
    BigInt(0) as any,
    startIndex as any,
    BigInt(1_000_000) as any,
  );
  // Persist the new watermark even when the scan returned nothing —
  // we still walked the indexer up to nextScanStartIndex, so we know
  // there's nothing new to look at below it. If `nextScanStartIndex`
  // is missing (older SDK shape), advance to the highest insertion
  // index we observed across all four buckets.
  const nextStart =
    (result as any)?.nextScanStartIndex ??
    highestInsertionIndex(result) + 1n;
  if (watermarkKey && typeof nextStart === "bigint" && nextStart > startIndex) {
    saveScanWatermark(watermarkKey, nextStart);
  }
  // Single compact scan log: walked range + non-empty buckets only.
  if (isVeilDebugEnabled()) {
    const buckets: string[] = [];
    if (result.received.length) buckets.push(`received=${result.received.length}`);
    if (result.publicReceived.length) buckets.push(`publicReceived=${result.publicReceived.length}`);
    if (result.selfBurnable.length) buckets.push(`selfBurnable=${result.selfBurnable.length}`);
    if (result.publicSelfBurnable.length) buckets.push(`publicSelfBurnable=${result.publicSelfBurnable.length}`);
    // eslint-disable-next-line no-console
    console.log(
      `[Veil scan] ${startIndex.toString()} → ${nextStart.toString()} ${
        buckets.length ? buckets.join(" ") : "no new claimable UTXOs"
      }`,
    );
  }
  return {
    received: result.received,
    publicReceived: result.publicReceived,
    selfBurnable: result.selfBurnable,
    publicSelfBurnable: result.publicSelfBurnable,
  };
}

function loadScanWatermark(key: string | null): bigint {
  if (!key || typeof window === "undefined") return 0n;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return 0n;
    const parsed = BigInt(raw);
    return parsed >= 0n ? parsed : 0n;
  } catch {
    return 0n;
  }
}

function saveScanWatermark(key: string, value: bigint): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value.toString());
  } catch {
    /* best-effort */
  }
}

function highestInsertionIndex(result: any): bigint {
  let max = -1n;
  for (const bucket of [
    result?.received,
    result?.publicReceived,
    result?.selfBurnable,
    result?.publicSelfBurnable,
  ]) {
    if (!Array.isArray(bucket)) continue;
    for (const u of bucket) {
      const idx = u?.insertionIndex;
      if (typeof idx === "bigint" && idx > max) max = idx;
    }
  }
  return max < 0n ? 0n : max;
}

/**
 * Resets the scan watermark for the connected wallet. The next scan will
 * start from absolute index 0 again — useful if a previous claim flow
 * crashed mid-way and Alice has unclaimed UTXOs below the watermark.
 */
export function resetScanWatermark(walletAddress: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(`veil:scanWatermark:${walletAddress}`);
  } catch {
    /* best-effort */
  }
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
  // The claimer reads fetchBatchMerkleProof FROM deps, not from the client
  // (sdk index.js:2496 — `const fetchBatchMerkleProof = deps.fetchBatchMerkleProof;`).
  // The client object exposes the function at `client.fetchBatchMerkleProof`
  // when an indexer endpoint is configured (sdk index.js:707-784); we pull it
  // off the client and forward it explicitly. Without this, the claim throws
  // "fetchBatchMerkleProof is not a function" on the first claimable UTXO.
  const fetchBatchMerkleProof = (args.client as any).fetchBatchMerkleProof;
  if (!fetchBatchMerkleProof) {
    throw new Error(
      "Umbra client has no fetchBatchMerkleProof — was indexerApiEndpoint set when getUmbraClient was called?",
    );
  }
  const claim = getReceiverClaimableUtxoToEncryptedBalanceClaimerFunction(
    { client: args.client },
    { zkProver, relayer, fetchBatchMerkleProof } as any,
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

/**
 * Move tokens from Alice's encrypted (shielded) balance back to her public
 * wallet's ATA. This is the inverse of `payInvoice`'s receiver flow — it
 * "withdraws" shielded SOL/USDC into the user's regular Solana wallet
 * where it can be spent normally.
 *
 * Mechanics:
 *   - Submits a `withdraw_from_shared_balance_into_public_balance_v11`
 *     instruction to the Umbra program (sdk index.js:10472).
 *   - The instruction queues an MPC computation; the result is returned via
 *     a callback transaction handled by Arcium's MXE cluster.
 *   - The `callbackSignature` (when present) is the on-chain confirmation
 *     that the public balance has been credited.
 *
 * Returns `{ queueSignature, callbackSignature?, callbackElapsedMs?,
 * rentClaimSignature?, rentClaimError? }` from the SDK.
 *
 * Notes:
 *   - `amount` is in base units (lamports for wSOL, micro-USDC for USDC).
 *   - Throws `EncryptedWithdrawalError` (re-exported from SDK) on validation
 *     or transaction failure. Bubble those up to the UI layer.
 *   - Protocol fee (35 bps, see https://docs.umbraprivacy.com/pricing)
 *     is deducted from the withdrawn amount on-chain — the user receives
 *     `amount - floor(amount * 35 / 16384)`.
 */
export async function withdrawShielded(
  client: UmbraClient,
  mint: string,
  amount: bigint,
): Promise<{
  queueSignature: string;
  callbackSignature?: string;
  callbackElapsedMs?: number;
}> {
  const withdraw = getEncryptedBalanceToPublicBalanceDirectWithdrawerFunction({ client });
  const destinationAddress = (client as any).signer.address as string;
  const result = await withdraw(destinationAddress as any, mint as any, amount as any);
  return {
    queueSignature: String((result as any).queueSignature),
    callbackSignature: (result as any).callbackSignature
      ? String((result as any).callbackSignature)
      : undefined,
    callbackElapsedMs: (result as any).callbackElapsedMs,
  };
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
