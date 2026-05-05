"use client";

/**
 * Payroll claim links — onboarding for unregistered Umbra recipients.
 *
 * Problem: when payroll tries to send Umbra payments to recipients who
 * have not yet registered with the Umbra protocol (no on-chain user
 * account PDA, no X25519 key registered, etc.), the SDK throws. That
 * makes mass payroll impossible — every employee would have to register
 * proactively before the employer could pay them. For a finance team
 * onboarding a contractor, that's a deal-breaker.
 *
 * Solution: claim-link pattern. For each unregistered recipient row:
 *
 *   1. Sender (Alice) generates a fresh ephemeral Solana keypair in the
 *      browser. Call it the "shadow account".
 *   2. Alice transfers a small SOL float to the shadow address (rent +
 *      tx fees ≈ 0.01 SOL).
 *   3. Alice registers the shadow with Umbra using the ephemeral key as
 *      the signer. The shadow is now a fully-functional Umbra user.
 *   4. Alice deposits the recipient's payout into the shadow's encrypted
 *      balance (signer = shadow because deposits debit the signer's ATA;
 *      the shadow has the funds because Alice transferred them in step 2,
 *      see depositToShadow for the actual flow).
 *   5. Alice generates a claim URL containing the ephemeral private key
 *      in the URL fragment (browser-only, never sent to a server).
 *   6. Recipient (Bob) clicks the URL. The claim page reads the private
 *      key from the fragment, builds an Umbra client signed by the
 *      shadow keypair, and calls
 *      `getEncryptedBalanceToPublicBalanceDirectWithdrawerFunction` with
 *      `destinationAddress = Bob's wallet`. Withdrawal lands directly in
 *      Bob's public ATA — no Umbra registration required on Bob's side.
 *
 * Cost per unregistered recipient: ~0.01 SOL (≈ $0.20 at SOL=$20):
 *   - Shadow rent for Umbra user account PDA + ETA: ~0.005 SOL
 *   - Tx fees for register (3 sub-txs) + deposit + withdraw: ~0.003 SOL
 *   - Buffer: ~0.002 SOL
 *
 * On the wire, NOTHING about the shadow account betrays which row it
 * belongs to. Anyone watching the chain sees a brand-new Solana account
 * register with Umbra and then immediately withdraw to a different
 * wallet — perfectly normal Umbra usage.
 *
 * Bail-out: if the SDK ever stops accepting an arbitrary keypair as
 * `signer` to `getUmbraClient`, this whole pattern is dead. Verified
 * with @umbra-privacy/sdk 2.1.1 — `createSignerFromPrivateKeyBytes`
 * returns a valid IUmbraSigner from a 32-byte private key.
 */

import {
  getUmbraClient,
  getUserAccountQuerierFunction,
  getUserRegistrationFunction,
  getPublicBalanceToEncryptedBalanceDirectDepositorFunction,
  getEncryptedBalanceToPublicBalanceDirectWithdrawerFunction,
  getNetworkEncryptionToSharedEncryptionConverterFunction,
  getEncryptedBalanceQuerierFunction,
  getEncryptedBalanceToReceiverClaimableUtxoCreatorFunction,
  createSignerFromPrivateKeyBytes,
  getWebsocketTransactionForwarder,
} from "@umbra-privacy/sdk";
import { findEncryptedUserAccountPda } from "@umbra-privacy/sdk/pda";
import { getEncryptedUserAccountDecoder } from "@umbra-privacy/umbra-codama";
import { getCreateReceiverClaimableUtxoFromEncryptedBalanceProver } from "@umbra-privacy/web-zk-prover";
import {
  claimUtxos,
  getEncryptedBalance,
  scanClaimableUtxos,
  withdrawShielded,
} from "./umbra";
import {
  getMasterViewingKeyDeriver,
  getMasterViewingKeyBlindingFactorDeriver,
  getPoseidonPrivateKeyDeriver,
  getPoseidonBlindingFactorDeriver,
  getUserAccountX25519KeypairDeriver,
  getUserCommitmentGeneratorFunction,
} from "@umbra-privacy/sdk/crypto";
import {
  getUserRegistrationProver,
  getCdnZkAssetProvider,
} from "@umbra-privacy/web-zk-prover";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import {
  NETWORK,
  RPC_URL,
  RPC_WSS_URL,
  UMBRA_INDEXER_API,
  UMBRA_PROGRAM_ID,
} from "./constants";

type UmbraClient = Awaited<ReturnType<typeof getUmbraClient>>;

/**
 * Estimated SOL float (lamports) Alice transfers into the shadow account
 * so the shadow has enough lamports to cover its own rent + tx fees for
 * register → deposit → withdraw.
 *
 * Original 2026-04 mainnet measurements (still documented for context):
 *   - User account PDA rent: ≈ 0.0026 SOL
 *   - ETA (encrypted token account) rent: ≈ 0.0021 SOL
 *   - 3 register sub-tx fees: ≈ 0.0001 SOL
 *   - 1 deposit tx fee + Arcium compute: ≈ 0.0007 SOL
 *   - 1 withdraw tx fee + Arcium compute: ≈ 0.0008 SOL
 *   - 50 % safety margin → 0.01 SOL
 *
 * 2026-05-04 update — bumped from 0.01 → 0.02 SOL.
 * Devnet payroll runs were failing on the very first registration tx
 * with `RegistrationError [transaction-send]: Transaction results in an
 * account (0) with insufficient funds for rent` — i.e. after the tx
 * runs, the SHADOW account itself drops below the rent-exempt minimum
 * (~890k lamports).
 *
 * 2026-05-05 update — bumped from 0.02 → 0.04 SOL.
 * Recipient claim was failing with `Custom program error: #1` from the
 * Arcium `QueueComputation` CPI inside the Umbra withdraw ix. Program
 * logs revealed the actual cost breakdown for the WITHDRAW step (the
 * "0.0008 SOL" estimate above was off by 13×):
 *   - 2 ATAs created by the Umbra withdraw ix internally:   ~ 0.00408 SOL
 *     (one per CPI'd `ATokenGPv...Create`; both pay 165-byte rent)
 *   - Tx fee:                                                ~ 0.000005 SOL
 *   - Arcium QueueComputation lamport escrow:                ~ 0.0067 SOL
 *     (the "Transfer: insufficient lamports … need 6695520" log line)
 *   - Total withdraw cost:                                  ~ 0.0108 SOL
 *
 * Plus the recipient ATA pre-create from `ensureRecipientAtaExists`
 * adds another ~0.00204 SOL. Plus the previously-measured register +
 * deposit costs (~0.0067 SOL) plus the shadow's own rent-exempt floor
 * (~0.00089 SOL).
 *
 * Sum: ≈ 0.020 SOL of strict requirement. With a 100% safety margin
 * for priority-fee pressure + protocol upgrades, 0.04 SOL = 40 M lamports
 * is the new floor.
 *
 * Cost to the sender: 0.04 SOL × N unregistered recipients. A 100-row
 * batch with all-unregistered recipients costs Alice 4 SOL extra. Still
 * cheap relative to typical Solana batch sizes; the alternative —
 * recipient pays via a popup — breaks the "no wallet popups on claim"
 * promise.
 *
 * Reflected in PayrollFlow's "extra setup per recipient" display
 * automatically — no string updates needed elsewhere when this
 * constant changes.
 */
export const SHADOW_FUNDING_LAMPORTS = 40_000_000n; // 0.04 SOL

/** Same proxied CDN trick as umbra.ts — avoids CORS on Umbra's CloudFront. */
function proxiedAssetProvider() {
  return getCdnZkAssetProvider({ baseUrl: "/umbra-cdn" });
}

// IndexedDB-backed (load, store) hooks. Spread alongside assetProvider
// when constructing any prover so the heavy zkey/wasm pair persists
// across sessions. Same instance the umbra.ts module uses.
import { zkAssetCache } from "./zk-asset-cache";

/**
 * Warm the browser's HTTP cache with Umbra's ZK proving assets so the
 * first claim-link row in a payroll batch doesn't pay the cold-start
 * cost. Empirically: row 1 register costs ~86s when the WASM/zkey are
 * downloaded mid-prove; row 2 costs ~10s once they're cached. Calling
 * this on mount of the payroll compose form lets the user's typing
 * time absorb the download instead of staring at the publishing modal.
 *
 * Pre-warmed asset types:
 *   - `userRegistration`                     — registration of unregistered
 *                                              recipients (claim-link path)
 *   - `createDepositWithPublicAmount`        — claim-link deposit step
 *   - `createDepositWithConfidentialAmount`  — direct shielded send
 *                                              (payInvoiceFromShielded). Without
 *                                              this, the first shielded row in a
 *                                              batch eats ~118s of asset download
 *                                              mid-prove (verified empirically
 *                                              2026-05-04).
 *   - `claimDepositIntoConfidentialAmount`   — recipient claim page's pre-
 *                                              withdraw scan+claim step. Pre-
 *                                              warming here helps the SENDER's
 *                                              dashboard claim flow too — that
 *                                              dashboard hydrates pending UTXOs
 *                                              from incoming sends.
 *
 * Best-effort: any failure (offline, CDN hiccup, manifest 404) is
 * silently swallowed — the row will still work, just not warm.
 *
 * Module-level guard prevents double-fetching across tabs / re-mounts:
 * once a load resolves successfully we skip subsequent calls.
 */
let prewarmPromise: Promise<void> | null = null;
export function prewarmZkAssets(): Promise<void> {
  if (prewarmPromise) return prewarmPromise;
  prewarmPromise = (async () => {
    if (typeof window === "undefined") return;
    try {
      const provider = proxiedAssetProvider();
      const types: Array<
        | "userRegistration"
        | "createDepositWithPublicAmount"
        | "createDepositWithConfidentialAmount"
        | "claimDepositIntoConfidentialAmount"
      > = [
        "userRegistration",
        "createDepositWithPublicAmount",
        "createDepositWithConfidentialAmount",
        "claimDepositIntoConfidentialAmount",
      ];

      // Resolve all manifest entries first — this is one small JSON
      // fetch. Then fan out the heavy zkey/wasm downloads.
      const urlSets = await Promise.all(
        types.map(async (t) => {
          try {
            return await provider.getAssetUrls(t);
          } catch {
            return null;
          }
        }),
      );

      // Each pair is two GET requests. We use `force-cache` so the
      // browser stores them; subsequent fetch() calls (and the SDK's
      // own xhr/fetch via snarkjs) hit the cache. `keepalive` lets
      // the request finish even if the user navigates quickly.
      const fetches: Promise<unknown>[] = [];
      for (const set of urlSets) {
        if (!set) continue;
        if (set.zkeyUrl) {
          fetches.push(
            fetch(set.zkeyUrl, { cache: "force-cache", keepalive: true }).catch(
              () => undefined,
            ),
          );
        }
        if (set.wasmUrl) {
          fetches.push(
            fetch(set.wasmUrl, { cache: "force-cache", keepalive: true }).catch(
              () => undefined,
            ),
          );
        }
      }
      await Promise.allSettled(fetches);
    } catch {
      // Reset so a subsequent attempt can try again. The ground-truth
      // SDK call still works without warming.
      prewarmPromise = null;
    }
  })();
  return prewarmPromise;
}

/* ─────────────────────────────────────────────────────────────────────
   1. Ephemeral keypair generation
   ───────────────────────────────────────────────────────────────────── */

export interface EphemeralKeypair {
  /** 32-byte ed25519 private key (for SDK + URL fragment). */
  privateKey: Uint8Array;
  /** 32-byte public key. */
  publicKey: Uint8Array;
  /** Base58-encoded public key (Solana address). */
  address: string;
}

/**
 * Generate a fresh Solana keypair entirely client-side. The private key
 * is the ONLY secret in the whole flow — losing it means the funds in
 * the shadow account are unrecoverable. We surface it both as bytes
 * (for SDK calls) and embedded in the claim URL fragment (for handoff
 * to the recipient). It is never sent to a server.
 *
 * Pure function — depends only on the platform's CSPRNG, no on-chain
 * state. Trivial to call from a test (or replace with a deterministic
 * keypair under test by passing your own to the consumers).
 */
export function generateEphemeralKeypair(): EphemeralKeypair {
  const kp = Keypair.generate();
  // web3.js secretKey is the standard Ed25519 64-byte format
  // (private || public). The Umbra SDK's createSignerFromPrivateKeyBytes
  // wants the 64-byte form — see chunk-HA5FLM63.js:156
  // (`createKeyPairSignerFromBytes(bytes)` accepts the 64-byte secret).
  const secretKey64 = new Uint8Array(kp.secretKey);
  const publicKey = new Uint8Array(kp.publicKey.toBytes());
  return {
    privateKey: secretKey64,
    publicKey,
    address: kp.publicKey.toBase58(),
  };
}

/** Encode a 64-byte private key to URL-safe base64 (no padding). */
export function encodeEphemeralPrivateKey(privateKey: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < privateKey.length; i++) binary += String.fromCharCode(privateKey[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode the URL-safe base64 form back to bytes. Throws on length mismatch. */
export function decodeEphemeralPrivateKey(encoded: string): Uint8Array {
  const pad = encoded.length % 4 === 0 ? 0 : 4 - (encoded.length % 4);
  const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  if (out.length !== 64) {
    throw new Error(`Expected 64-byte ephemeral key, got ${out.length}`);
  }
  return out;
}

/**
 * Reconstruct the ephemeral Solana keypair object (web3.js form) from a
 * 64-byte secret key. Used by the claim page to derive the shadow's
 * public address before signing anything.
 */
export function ephemeralKeypairFromBytes(secretKey64: Uint8Array): EphemeralKeypair {
  const kp = Keypair.fromSecretKey(secretKey64);
  return {
    privateKey: new Uint8Array(kp.secretKey),
    publicKey: new Uint8Array(kp.publicKey.toBytes()),
    address: kp.publicKey.toBase58(),
  };
}

/* ─────────────────────────────────────────────────────────────────────
   2. Registration detection — answers "is recipient already on Umbra?"
   ───────────────────────────────────────────────────────────────────── */

export type RegistrationStatus = "registered" | "unregistered" | "unknown";

export interface RegistrationCheckResult {
  recipient: string;
  status: RegistrationStatus;
  /** Set when the on-chain query failed; UI shows "unknown" with the message. */
  error?: string;
}

/**
 * Check whether a recipient wallet has registered with Umbra. Returns
 * "registered" only if the on-chain account exists AND both the X25519
 * key + commitment are flagged as registered (the same condition our
 * own ensureRegistered short-circuits on).
 *
 * Uses the user-account querier on the SAME Umbra client Alice is
 * already running — no extra wallet popups, no new RPC connection.
 * Failures (e.g. RPC timeout) bucket as "unknown" so the UI can ask
 * Alice to retry rather than treating them as "definitely unregistered"
 * and creating an unnecessary shadow.
 */
export async function checkRecipientRegistration(
  client: UmbraClient,
  recipient: string,
): Promise<RegistrationCheckResult> {
  try {
    const query = getUserAccountQuerierFunction({ client });
    const result = await query(recipient as any);
    if (result.state !== "exists") {
      return { recipient, status: "unregistered" };
    }
    const ready =
      result.data.isUserAccountX25519KeyRegistered &&
      result.data.isUserCommitmentRegistered;
    return { recipient, status: ready ? "registered" : "unregistered" };
  } catch (err) {
    return {
      recipient,
      status: "unknown",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Bulk variant: runs the registration check for many recipients in
 * parallel. The querier is read-only and cheap; we don't bother
 * batching — Solana RPC handles 50 parallel `getAccountInfo` calls
 * fine, and even the indexer-backed versions of the querier are
 * lightweight.
 */
export async function checkRecipientsRegistration(
  client: UmbraClient,
  recipients: readonly string[],
): Promise<RegistrationCheckResult[]> {
  return Promise.all(recipients.map((r) => checkRecipientRegistration(client, r)));
}

/* ─────────────────────────────────────────────────────────────────────
   2.5. Sender-side direct-path lookup (Phase C)
   ───────────────────────────────────────────────────────────────────── */

/**
 * Values needed for the sender's direct-path deposit ix when the
 * recipient is already a registered Umbra user. These are EXACTLY the
 * values `payInvoiceCpi.generateProofAndCommitments` would otherwise
 * fetch from chain itself — pre-fetching them here lets the caller
 * pass them as `ProofOverrides` and skip the entire shadow setup
 * (no fund tx, no register, no shadow→recipient hop).
 *
 * Both fields use the SAME shape `payInvoiceCpi.ts` produces internally:
 *   - `x25519PublicKey`: 32-byte token-encryption pub key (the SDK
 *     stores TWO x25519 keys per user — for-token-encryption and
 *     for-mvk-encryption — and the deposit ECDH path uses the
 *     for-token one. NOT what `getUserAccountQuerierFunction`
 *     surfaces; that returns the for-mvk key. We decode the codama
 *     account directly to read the right field.)
 *   - `userCommitment`: 32-byte LE on chain → bigint here.
 */
export interface RegisteredReceiverValues {
  x25519PublicKey: Uint8Array;
  userCommitment: bigint;
}

/**
 * Bit indices on `EncryptedUserAccount.statusBits` that matter for the
 * direct path. Mirrors the SDK's `parseStatusBits` (sdk index.js:9508).
 */
const STATUS_BIT_USER_COMMITMENT_REGISTERED = 1n << 2n;
const STATUS_BIT_USER_X25519_KEY_REGISTERED = 1n << 4n;

/**
 * Per-payroll-run cache so repeated rows for the same wallet (or the
 * same recipient appearing in two pre-flight passes — registration
 * detector + direct-path lookup) don't hit chain twice. The Map is
 * keyed by base58 wallet address; the value is the resolved
 * registered-or-not status. `null` value = "checked, not registered".
 */
type LookupCacheEntry = RegisteredReceiverValues | null;
const lookupCache = new Map<string, LookupCacheEntry>();

/**
 * Reset the per-run lookup cache. Called from PayrollFlow at the start
 * of a run so a previous run's stale results don't leak across (e.g.
 * if a recipient registered between runs, the second run should see
 * the registered status, not the cached `null`).
 */
export function resetRegisteredReceiverCache(): void {
  lookupCache.clear();
}

/**
 * Read the on-chain x25519 token-encryption public key + userCommitment
 * for a recipient wallet, returning the values needed to build a
 * direct-path deposit ix that targets that recipient. Returns `null`
 * if the wallet has no Umbra user-account PDA, or the PDA exists but
 * either the X25519 key or the user commitment hasn't been registered
 * yet (= row should fall back to the shadow / claim-link path).
 *
 * Implementation notes:
 *
 *   1. We don't construct an Umbra client — we hit the bare
 *      Solana RPC via `connection.getAccountInfo`, then decode the
 *      raw account bytes with `getEncryptedUserAccountDecoder` from
 *      `@umbra-privacy/umbra-codama`. That's the same fixed-layout
 *      decoder the SDK uses internally; reading two struct fields
 *      doesn't require any of the client's heavier wiring (master
 *      seed storage, transaction forwarder, signer, etc.). The
 *      lookup is one RPC round-trip per row.
 *
 *   2. We use `x25519PublicKeyForTokenEncryption.first`, NOT the
 *      `x25519PublicKey` field that `getUserAccountQuerierFunction`
 *      returns. The SDK querier maps its result's `x25519PublicKey`
 *      to `x25519PublicKeyForMasterViewingKeyEncryption` (sdk
 *      index.js:9536), but the deposit ECDH path needs the
 *      `x25519PublicKeyForTokenEncryption` field (the same one
 *      `payInvoiceCpi.generateProofAndCommitments` reads via
 *      `decodeEncryptedUserAccount` on lines 392-399). Going through
 *      the codama decoder directly ensures we read the same value
 *      `payInvoiceCpi`'s default chain-fetch path would have read.
 *
 *   3. Status-bit checks mirror the SDK's `parseStatusBits` (sdk
 *      index.js:9508): bit 2 = userCommitment, bit 4 = x25519 key.
 *      Both must be set to qualify as "fully registered" — the same
 *      gate `umbra.ts::isFullyRegistered` enforces.
 *
 *   4. Result is cached per-wallet for the duration of the run via
 *      `lookupCache`. Reset between runs via `resetRegisteredReceiverCache`.
 *
 * Failures (RPC error, decode error) intentionally bubble — the
 * caller should treat thrown errors as "couldn't determine" and
 * fall back to the shadow path rather than dropping the row. We
 * don't wrap in try/catch here so the error message reaches the
 * row-level error chip.
 */
export async function lookupRegisteredReceiver(
  walletAddress: string,
  connection: Connection,
): Promise<RegisteredReceiverValues | null> {
  const cached = lookupCache.get(walletAddress);
  if (cached !== undefined) {
    return cached;
  }

  // Compute the user-account PDA from the recipient wallet. The kit
  // address-encoder accepts a base58 string; the SDK's PDA helper
  // returns a kit Address (string at runtime).
  const pdaAddress = await findEncryptedUserAccountPda(
    walletAddress as any,
    UMBRA_PROGRAM_ID.toBase58() as any,
  );
  const pdaPubkey = new PublicKey(String(pdaAddress));

  const accountInfo = await connection.getAccountInfo(pdaPubkey, "confirmed");
  if (!accountInfo) {
    lookupCache.set(walletAddress, null);
    return null;
  }

  // Decode the raw account bytes via the codama struct decoder.
  // `data` from `connection.getAccountInfo` is a Buffer; the decoder
  // wants a `ReadonlyUint8Array`. Buffer extends Uint8Array at runtime
  // but TS narrows it strictly — cast through Uint8Array.
  const decoder = getEncryptedUserAccountDecoder();
  const decoded = decoder.decode(new Uint8Array(accountInfo.data)) as any;

  // Status-bit checks — both flags must be set or this row should
  // take the shadow path.
  const statusBitsValue: bigint =
    typeof decoded.statusBits.first === "bigint"
      ? decoded.statusBits.first
      : BigInt(decoded.statusBits.first);
  const x25519Registered =
    (statusBitsValue & STATUS_BIT_USER_X25519_KEY_REGISTERED) !== 0n;
  const commitmentRegistered =
    (statusBitsValue & STATUS_BIT_USER_COMMITMENT_REGISTERED) !== 0n;
  if (!x25519Registered || !commitmentRegistered) {
    lookupCache.set(walletAddress, null);
    return null;
  }

  // Pull the two fields the deposit ix needs.
  const x25519PublicKey = new Uint8Array(
    decoded.x25519PublicKeyForTokenEncryption.first,
  );

  // userCommitment is stored as 32 bytes LE on chain; convert to bigint
  // the same way the SDK does (sdk index.js:9531 `bytesToBigIntLe2`).
  const userCommitmentBytes = new Uint8Array(decoded.userCommitment.first);
  let userCommitment = 0n;
  for (let i = 0; i < 32; i++) {
    userCommitment |= BigInt(userCommitmentBytes[i]) << BigInt(i * 8);
  }

  const value: RegisteredReceiverValues = { x25519PublicKey, userCommitment };
  lookupCache.set(walletAddress, value);
  return value;
}

/* ─────────────────────────────────────────────────────────────────────
   3. Shadow account — ephemeral Umbra client backed by a generated KP
   ───────────────────────────────────────────────────────────────────── */

/**
 * Build a fresh Umbra client whose signer is an ephemeral keypair.
 *
 * - Reuses the same RPC/indexer/network config as the wallet-driven
 *   client so transactions land on the same cluster.
 * - Does NOT pass `masterSeedStorage`; the in-memory default is fine
 *   because the shadow only lives for the duration of a single payroll
 *   send (Alice) or a single claim (Bob).
 * - The signer's `signMessage` will be invoked exactly once during
 *   `getMasterSeed()` — the SDK derives a master seed from the signed
 *   bytes. Because the ephemeral keypair signs deterministically, the
 *   master seed is deterministic too: Alice computes it during deposit,
 *   Bob recomputes the same seed during claim from the same key.
 */
export async function buildShadowClient(
  ephemeralPrivateKey: Uint8Array,
): Promise<UmbraClient> {
  // The SDK's createSignerFromPrivateKeyBytes accepts the 64-byte
  // secretKey form (private || public concatenated), matching what
  // Solana's Keypair.secretKey returns. See chunk-HA5FLM63.js:156-158.
  const signer = await createSignerFromPrivateKeyBytes(ephemeralPrivateKey as any);
  return await getUmbraClient(
    {
      signer,
      network: NETWORK,
      rpcUrl: RPC_URL,
      rpcSubscriptionsUrl: RPC_WSS_URL,
      indexerApiEndpoint: UMBRA_INDEXER_API,
    },
    {
      transactionForwarder: getWebsocketTransactionForwarder({
        rpcUrl: RPC_URL,
        rpcSubscriptionsUrl: RPC_WSS_URL,
      }),
    },
  );
}

/* ─────────────────────────────────────────────────────────────────────
   3.5. Local derivation of shadow registration values
   ───────────────────────────────────────────────────────────────────── */

/**
 * Values that register would store on chain for the shadow's
 * encrypted user_account: the x25519 token-encryption pub key and
 * the userCommitment field element. Both are deterministic functions
 * of the shadow's master seed (= the ephemeral private key). The
 * SDK's own derivers compute them — we just call them locally,
 * BEFORE the shadow's register tx has landed, to enable the
 * single-popup payroll batching flow:
 *
 *   - Build deposit txs at t=0 referencing these locally-derived
 *     values (via payInvoiceCpi's `ProofOverrides`).
 *   - Sign fund + deposits in ONE Phantom popup (signAllTransactions).
 *   - Submit fund first → run register (no popup) → submit deposits.
 *
 * Without this helper, deposit-tx building blocks on a chain fetch
 * of the receiver's user_account (which doesn't exist until register
 * confirms), forcing fund + deposit into separate popup phases.
 *
 * Mathematical equivalence: the SDK's register function uses the
 * SAME deriver chain we call here (see `chunk-3LS5P32X.cjs:8713-9013`
 * for the deriver impls and `index.cjs:1465` for register's
 * userCommitment computation). Same inputs → same output. ZK proof
 * verification compares the chain-stored value to the in-tx value,
 * and they match by construction.
 */
export interface ShadowRegistrationValues {
  /** 32-byte x25519 pub key. Same value register stores as
   *  `x25519PublicKeyForTokenEncryption.first`. */
  x25519PublicKey: Uint8Array;
  /** BN254 field element. Same value register stores as
   *  `userCommitment.first` (32 bytes LE on chain). */
  userCommitment: bigint;
}

export async function deriveShadowRegistrationValues(
  shadowClient: UmbraClient,
): Promise<ShadowRegistrationValues> {
  const c: any = shadowClient;
  const x25519Deriver = getUserAccountX25519KeypairDeriver({ client: c });
  const mvkDeriver = getMasterViewingKeyDeriver({ client: c });
  const mvkBFDeriver = getMasterViewingKeyBlindingFactorDeriver({ client: c });
  const ppkDeriver = getPoseidonPrivateKeyDeriver({ client: c });
  const ppkBFDeriver = getPoseidonBlindingFactorDeriver({ client: c });
  const ucGen = getUserCommitmentGeneratorFunction();

  const [keypairResult, mvk, mvkBF, ppk, ppkBF] = await Promise.all([
    x25519Deriver(),
    mvkDeriver(),
    mvkBFDeriver(),
    ppkDeriver(),
    ppkBFDeriver(),
  ]);

  const userCommitment = (await ucGen(mvk, mvkBF, ppk, ppkBF)) as unknown as bigint;
  const x25519PublicKey = new Uint8Array(
    (keypairResult as any).x25519Keypair.publicKey,
  );

  return { x25519PublicKey, userCommitment };
}

/* ─────────────────────────────────────────────────────────────────────
   4. Funding + registering the shadow (Alice's side)
   ───────────────────────────────────────────────────────────────────── */

export interface FundShadowArgs {
  /** A signer compatible with @solana/web3.js Transaction.signTransaction.
   *  In practice this is the wallet-adapter wallet (sendTransaction). */
  payerWallet: any;
  /** Address that will receive the SOL float. */
  shadowAddress: string;
  /** Lamports to send. Defaults to SHADOW_FUNDING_LAMPORTS. */
  lamports?: bigint;
  /** A web3.js Connection bound to the same RPC the SDK uses. Caller
   *  supplies it so we don't import a heavy module here for one call. */
  connection: { sendTransaction: (...args: any[]) => Promise<string>; getLatestBlockhash: () => Promise<{ blockhash: string; lastValidBlockHeight: number }>; confirmTransaction: (...args: any[]) => Promise<any> };
}

/**
 * Send a SOL transfer from Alice's wallet to the shadow address.
 * Returns the tx signature. Required because the shadow account has
 * zero balance at creation — without lamports it can't pay rent for
 * its own user-account PDA, deposit fees, or withdraw fees.
 *
 * Surfaces as ONE Phantom popup (a single SystemProgram.transfer).
 *
 * For batched-signing flows (multiple shadows in one Phantom popup
 * via signAllTransactions), use {@link buildFundShadowTx} +
 * {@link submitSignedFundShadowTx} instead — those split the
 * build/sign/submit boundary so the caller can collect N unsigned
 * txs, hand the array to `wallet.signAllTransactions` for one popup,
 * then submit each in parallel.
 */
export async function fundShadowAccount(args: FundShadowArgs): Promise<string> {
  const lamports = args.lamports ?? SHADOW_FUNDING_LAMPORTS;
  const payerPubkey = args.payerWallet.publicKey as PublicKey;
  if (!payerPubkey) throw new Error("Payer wallet not connected");

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payerPubkey,
      toPubkey: new PublicKey(args.shadowAddress),
      lamports: Number(lamports),
    }),
  );
  const { blockhash, lastValidBlockHeight } = await args.connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = payerPubkey;

  // wallet-adapter's sendTransaction handles signing + submission
  // in one call. Returns the signature once the wallet has dispatched.
  const sig = await args.payerWallet.sendTransaction(tx, args.connection);
  await args.connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

/* ─────────────────────────────────────────────────────────────────────
   Batched-signing helpers — split fund into build / submit so a
   coordinator can collect N unsigned txs across rows and hand them
   to wallet.signAllTransactions in a single Phantom popup. Cuts
   N fund popups down to 1 for any row count >= 2.
   ───────────────────────────────────────────────────────────────────── */

export interface BuiltFundShadowTx {
  tx: Transaction;
  blockhash: string;
  lastValidBlockHeight: number;
  shadowAddress: string;
}

/**
 * Build (but don't sign or submit) a SOL-transfer tx funding the shadow.
 * Caller is responsible for calling `wallet.signAllTransactions(txs)`
 * across an array of these (one popup), then forwarding each signed
 * result to {@link submitSignedFundShadowTx} for confirmation.
 */
export async function buildFundShadowTx(args: {
  payerPubkey: PublicKey;
  shadowAddress: string;
  lamports?: bigint;
  connection: {
    getLatestBlockhash: () => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  };
}): Promise<BuiltFundShadowTx> {
  const lamports = args.lamports ?? SHADOW_FUNDING_LAMPORTS;
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: args.payerPubkey,
      toPubkey: new PublicKey(args.shadowAddress),
      lamports: Number(lamports),
    }),
  );
  const { blockhash, lastValidBlockHeight } = await args.connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = args.payerPubkey;
  return { tx, blockhash, lastValidBlockHeight, shadowAddress: args.shadowAddress };
}

/**
 * Submit a previously-batch-signed fund tx and confirm it. Returns the
 * tx signature on confirm. Surfaces an error with the original
 * blockhash context so the caller can map "this fund failed" to the
 * specific shadow address (the shadowAddress field on `BuiltFundShadowTx`).
 */
export async function submitSignedFundShadowTx(args: {
  signedTx: Transaction;
  built: BuiltFundShadowTx;
  connection: {
    sendRawTransaction: (raw: Uint8Array | Buffer) => Promise<string>;
    confirmTransaction: (...args: any[]) => Promise<any>;
  };
}): Promise<string> {
  const sig = await args.connection.sendRawTransaction(args.signedTx.serialize());
  await args.connection.confirmTransaction(
    {
      signature: sig,
      blockhash: args.built.blockhash,
      lastValidBlockHeight: args.built.lastValidBlockHeight,
    },
    "confirmed",
  );
  return sig;
}

/**
 * Build (but don't sign or submit) ONE versioned tx that funds N
 * shadow accounts in one go — packs N `SystemProgram.transfer`
 * instructions into a single tx.
 *
 * Why versioned (v0) instead of legacy: Phantom's
 * `signAllTransactions` is generic over a single tx type. The
 * single-popup payroll flow batches the fund tx alongside N VeilPay
 * deposit txs (which are v0 with ALT) — they all need to be the same
 * type. Promoting the fund tx to v0 keeps the array uniform.
 *
 * Why one tx with N instructions instead of N txs: Phantom's batched
 * popup shows ALL the txs in a list. With N=5 rows, a list of 5 fund
 * txs + 5 deposit txs = 10 entries. Collapsing fund to one tx halves
 * that. Tx size is generous: each transfer ix is ~40 bytes, so a tx
 * with 10 transfers is still ~600 bytes — well under the 1232 cap.
 *
 * Each `BuiltBatchedFundTx` resolves to exactly one signature; on
 * submission failure all transfers fail together. That's actually
 * the right shape for our usage — if any single shadow's funding
 * doesn't land we want to fail the WHOLE batch (so partial-fund
 * state never confuses subsequent register / deposit phases).
 */
export interface BuiltBatchedFundTx {
  tx: VersionedTransaction;
  blockhash: string;
  lastValidBlockHeight: number;
  /** Shadow addresses in the same order they were funded — useful for
   *  the caller to map back to per-row state when reporting errors. */
  shadowAddresses: string[];
}

export async function buildBatchedFundTxV0(args: {
  payerPubkey: PublicKey;
  shadows: Array<{ address: string; lamports: bigint }>;
  connection: {
    getLatestBlockhash: () => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  };
}): Promise<BuiltBatchedFundTx> {
  const instructions = args.shadows.map((s) =>
    SystemProgram.transfer({
      fromPubkey: args.payerPubkey,
      toPubkey: new PublicKey(s.address),
      lamports: Number(s.lamports),
    }),
  );
  const { blockhash, lastValidBlockHeight } = await args.connection.getLatestBlockhash();
  const messageV0 = new TransactionMessage({
    payerKey: args.payerPubkey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(messageV0);
  return {
    tx,
    blockhash,
    lastValidBlockHeight,
    shadowAddresses: args.shadows.map((s) => s.address),
  };
}

/**
 * Submit a batched-fund v0 tx and confirm it. The signed tx must be
 * the result of running `buildBatchedFundTxV0`'s output through
 * `wallet.signAllTransactions`.
 */
export async function submitSignedBatchedFundTxV0(args: {
  signedTx: VersionedTransaction;
  built: BuiltBatchedFundTx;
  connection: {
    sendTransaction: (
      tx: VersionedTransaction,
      opts?: any,
    ) => Promise<string>;
    confirmTransaction: (...args: any[]) => Promise<any>;
  };
}): Promise<string> {
  const sig = await args.connection.sendTransaction(args.signedTx, {
    skipPreflight: false,
    maxRetries: 3,
  });
  await args.connection.confirmTransaction(
    {
      signature: sig,
      blockhash: args.built.blockhash,
      lastValidBlockHeight: args.built.lastValidBlockHeight,
    },
    "confirmed",
  );
  return sig;
}

export interface RegisterShadowArgs {
  shadowClient: UmbraClient;
}

/**
 * Run Umbra registration for the shadow account. Mirrors what
 * ensureRegistered does for Alice in umbra.ts but without the legacy
 * key-rotation-detection logic — a brand-new keypair is by definition
 * never previously registered.
 *
 * 3 sub-txs are issued by the SDK (init → x25519 → commitment), all
 * paid for by the shadow's lamport float. No wallet popups (the SDK
 * uses the in-memory shadow signer).
 */
export async function registerShadowAccount(args: RegisterShadowArgs): Promise<void> {
  const zkProver = getUserRegistrationProver({
    assetProvider: proxiedAssetProvider(),
    ...zkAssetCache,
  });
  const register = getUserRegistrationFunction({ client: args.shadowClient }, { zkProver } as any);
  await register({
    confidential: true,
    anonymous: true,
  });
}

/* ─────────────────────────────────────────────────────────────────────
   5. Deposit into shadow (Alice's side)
   ───────────────────────────────────────────────────────────────────── */

export interface DepositToShadowArgs {
  /** Alice's already-built Umbra client. The deposit is funded from
   *  Alice's public ATA, so the signer must be Alice. */
  payerClient: UmbraClient;
  /** Shadow address — the destination of the deposit (encrypted balance
   *  is credited to this address). */
  shadowAddress: string;
  mint: string;
  amount: bigint;
}

/**
 * Move funds from Alice's public ATA into the shadow's encrypted
 * balance. After this completes, the shadow account holds the full
 * payout amount (minus Umbra's deposit fee, see SDK docs) inside its
 * encrypted balance, ready for a single withdraw → Bob.
 *
 * Why we don't just send tokens directly to the shadow's ATA: the goal
 * is privacy. If Alice transferred USDC publicly to the shadow, anyone
 * watching could correlate (Alice → shadow → Bob) trivially. Routing
 * through the encrypted balance breaks that linkability — the shadow
 * looks like a normal Umbra user that received privately and withdrew.
 *
 * Why this uses the SDK direct path (and NOT VeilPay CPI):
 *
 *   We briefly routed this through `payInvoiceCpi` (VeilPay) to get
 *   1-popup claim-link rows (2026-05-04). It typechecked and the
 *   on-chain tx confirmed cleanly, but the recipient claim flow
 *   broke: VeilPay's atomic-CPI design intentionally bypasses the
 *   SDK's `awaitComputationFinalization` wrapper, so depositToShadow
 *   returned BEFORE Arcium MPC materialised the encrypted leaf in
 *   the merkle tree. Recipients clicking claim then saw 75 s of
 *   "no claimable UTXOs" + an opaque withdraw failure. We added
 *   recipient-side polling on `scanClaimableUtxos` as a workaround
 *   but devnet Arcium can be backlogged longer than any reasonable
 *   polling window, so the fix didn't hold.
 *
 *   The SDK's `getPublicBalanceToEncryptedBalanceDirectDepositorFunction`
 *   uses the client's `computationMonitor` to poll the specific
 *   Arcium computation account on-chain and return only after
 *   finalisation. It costs 2 Phantom popups instead of 1, but the
 *   claim flow stays reliable. Worth the trade until v0.2 when we
 *   can plumb `getPollingComputationMonitor` into `payInvoiceCpi`
 *   properly. Tracked in TODO.
 *
 *   Net claim-link row popup count: fund (1) + register (0, in-memory)
 *   + deposit (2) = 3.
 *
 * Invoice payment still uses VeilPay (1 popup) because the recipient
 * dashboard can scan asynchronously and tolerates indexer lag — the
 * synchronous claim-link page is where the race breaks.
 */
export async function depositToShadow(args: DepositToShadowArgs): Promise<{ depositSignature: string }> {
  const deposit = getPublicBalanceToEncryptedBalanceDirectDepositorFunction({
    client: args.payerClient,
  });
  const result = await deposit(
    args.shadowAddress as any,
    args.mint as any,
    args.amount as any,
  );
  // DepositResult shape: { queueSignature, callbackSignature?, ... }
  // (see @umbra-privacy/sdk index-Cd76ZBHA.d.ts:246). We surface the
  // queue signature — that's the on-chain anchor for the deposit
  // queueing event. The callback signature, when present, is the
  // Arcium MPC finalization tx and lands separately.
  return {
    depositSignature: String((result as any).queueSignature),
  };
}

/* ─────────────────────────────────────────────────────────────────────
   6. Withdraw from shadow → recipient (Bob's side)
   ───────────────────────────────────────────────────────────────────── */

export interface WithdrawFromShadowArgs {
  /** The shadow's Umbra client. Built fresh on the claim page from the
   *  64-byte private key in the URL fragment. */
  shadowClient: UmbraClient;
  /** Shadow's 64-byte secret key. Used to sign the post-withdraw sweep
   *  tx that transfers the unwrapped SOL from the shadow's main wallet
   *  to the recipient. The SDK's withdraw lands the SOL in the
   *  shadow's wallet (despite docs saying "destinationAddress can be
   *  another address" — the param is validated but never used in the
   *  actual ix; see `@umbra-privacy/sdk/dist/index.js:10505`). */
  ephemeralPrivateKey: Uint8Array;
  /** Connection used for the sweep tx. The SDK uses its own connection
   *  for the withdraw call. */
  connection: Connection;
  /** Bob's wallet — the FINAL destination for the withdrawn tokens. */
  recipientAddress: string;
  mint: string;
  amount: bigint;
}

/**
 * Direct ETA → ATA withdrawal.
 *
 * Account topology (from withdraw V11 IDL,
 * `@umbra-privacy/umbra-codama/dist/index.d.ts:30064`):
 *   #14 userTokenAccount — Umbra encrypted token account (ETA),
 *      created by register, debited by deposit.
 *   #20 userSplAta — shadow's own public wSOL ATA, initialised by
 *      the deposit ix's CPI (idempotent).
 *   #24 mpcCallbackWrappedSolUnwrappingHelperAccount — handles the
 *      wSOL → native SOL unwrap so the recipient doesn't need a
 *      wSOL ATA; native SOL lands directly in their wallet.
 *
 * Why the convert-to-shared step:
 *   Umbra ETAs have two encryption modes (status bit 3,
 *   `is_shared_mode`):
 *     - MXE: only the Arcium MPC network can decrypt
 *     - Shared: user's master viewing key can decrypt too
 *   Claim-link deposits land the ETA in MXE mode (the depositor
 *   doesn't have the receiver's X25519 key handy at deposit time, so
 *   the encryption is keyed only to the network). The withdraw V11
 *   ix requires Shared mode — without it, the user_token_account
 *   constraint fails with Anchor 3012 (AccountNotInitialized).
 *
 *   `getNetworkEncryptionToSharedEncryptionConverterFunction` queues
 *   an Arcium MPC computation that re-encrypts the balance under the
 *   user's MVK and flips bit 3. The SDK returns after the queue tx
 *   confirms; we then poll `getEncryptedBalanceQuerierFunction` until
 *   `state === "shared"` to verify the callback ran before
 *   continuing to the withdraw. Typical wait: 5-30 seconds.
 *
 *   Cost: ~0.0067 SOL Arcium escrow + tx fee, recoverable via
 *   rent-claim after the callback. Already budgeted in
 *   SHADOW_FUNDING_LAMPORTS.
 *
 * Why no recipient-ATA pre-create:
 *   An earlier version pre-created the recipient's wSOL ATA. Program
 *   logs proved this was unnecessary — the withdraw V11's
 *   mpcCallbackWrappedSolUnwrappingHelperAccount handles the unwrap
 *   directly. Removed 2026-05-05.
 */
/**
 * SystemProgram.transfer from the shadow's main wallet → recipient,
 * leaving a small dust buffer for tx fees. Used both as the final
 * step of `withdrawFromShadow` (after the SDK unwraps SOL into the
 * shadow's wallet) AND as a standalone fast-path for partial-success
 * recoveries where a prior withdraw landed SOL in the shadow but
 * the sweep never ran.
 *
 * Returns the tx signature on success, null when there's not enough
 * balance to sweep (rare; the shadow would need to have under
 * ~5000 lamports total).
 *
 * Caller should `.catch()` to log + swallow any tx failures — the
 * SOL is still recoverable on a later retry since the shadow's key
 * lives in the claim URL fragment.
 */
export async function sweepShadowToRecipient(args: {
  shadowKeypair: Keypair;
  recipientAddress: string;
  connection: Connection;
}): Promise<string | null> {
  const { shadowKeypair, recipientAddress, connection } = args;
  const shadowPubkey = shadowKeypair.publicKey;
  const recipientPubkey = new PublicKey(recipientAddress);
  const shadowBalance = await connection.getBalance(shadowPubkey, "confirmed");
  // eslint-disable-next-line no-console
  console.log(
    `[claim] shadow balance pre-sweep: ${shadowBalance} lamports`,
  );
  const SWEEP_DUST_LAMPORTS = 5_000; // tx fee buffer
  const sweepLamports = shadowBalance - SWEEP_DUST_LAMPORTS;
  if (sweepLamports <= 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[claim] shadow balance ${shadowBalance} too low to sweep — recipient receives nothing from this row`,
    );
    return null;
  }
  const sweepIx = SystemProgram.transfer({
    fromPubkey: shadowPubkey,
    toPubkey: recipientPubkey,
    lamports: sweepLamports,
  });
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: shadowPubkey,
    recentBlockhash: blockhash,
    instructions: [sweepIx],
  }).compileToV0Message();
  const sweepTx = new VersionedTransaction(msg);
  sweepTx.sign([shadowKeypair]);
  const sweepSig = await connection.sendTransaction(sweepTx, {
    skipPreflight: false,
    maxRetries: 3,
  });
  await connection.confirmTransaction(
    { signature: sweepSig, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  // eslint-disable-next-line no-console
  console.log(
    `[claim] swept ${sweepLamports} lamports to ${recipientAddress} (sig: ${sweepSig})`,
  );
  return sweepSig;
}

export async function withdrawFromShadow(
  args: WithdrawFromShadowArgs,
): Promise<{ queueSignature: string; callbackSignature?: string }> {
  const shadowKeypair = Keypair.fromSecretKey(args.ephemeralPrivateKey);
  const shadowPubkey = shadowKeypair.publicKey;

  // Sweep-only fast path: if a prior partial-success withdraw landed
  // SOL in the shadow's main wallet but never swept it to the
  // recipient, the shadow's wallet has a large balance (much more
  // than the original 0.04 SOL float minus register/deposit costs)
  // and the encrypted balance is now empty. Detect this by reading
  // the wallet balance — if above the funding-float threshold,
  // assume state 3 and skip the SDK withdraw chain entirely.
  //
  // Threshold logic: a fresh shadow has 0.04 SOL float. After
  // register + deposit it spends ~0.007 SOL and rent locks ~0.005
  // SOL in PDAs, leaving ~0.028 SOL liquid. After a withdraw
  // unwraps 0.099 SOL into the wallet, balance jumps to ~0.127 SOL.
  // Anything above 0.05 SOL is conclusively past the "fresh
  // shadow" envelope.
  const STATE_3_THRESHOLD_LAMPORTS = 50_000_000;
  const initialShadowBalance = await args.connection.getBalance(
    shadowPubkey,
    "confirmed",
  );
  // eslint-disable-next-line no-console
  console.log(
    `[claim] shadow wallet balance pre-claim: ${initialShadowBalance} lamports`,
  );
  if (initialShadowBalance > STATE_3_THRESHOLD_LAMPORTS) {
    // eslint-disable-next-line no-console
    console.log(
      `[claim] shadow wallet has >0.05 SOL — assuming a prior withdraw already unwrapped here; skipping SDK convert/withdraw and going straight to sweep`,
    );
    const sweepSig = await sweepShadowToRecipient({
      shadowKeypair,
      recipientAddress: args.recipientAddress,
      connection: args.connection,
    });
    return {
      queueSignature: sweepSig ?? "swept-only-no-sdk-call",
      callbackSignature: undefined,
    };
  }

  // 1. Convert the encrypted balance from MXE → Shared mode (or
  //    no-op if already shared).
  // eslint-disable-next-line no-console
  console.log(
    `[claim] convert-to-shared starting for mint ${args.mint}`,
  );
  const convertToShared = getNetworkEncryptionToSharedEncryptionConverterFunction({
    client: args.shadowClient,
  });
  const convertResult = await convertToShared([args.mint as any]);
  // eslint-disable-next-line no-console
  console.log(
    "[claim] convert-to-shared queued (serialized):\n" +
      JSON.stringify(
        {
          converted: Array.from(
            ((convertResult as any)?.converted as Map<unknown, unknown>) ?? [],
          ).map(([k, v]) => [String(k), String(v)]),
          skipped: Array.from(
            ((convertResult as any)?.skipped as Map<unknown, unknown>) ?? [],
          ).map(([k, v]) => [String(k), String(v)]),
        },
        null,
        2,
      ),
  );

  // 2. Poll until the Arcium callback finalises the conversion AND
  //    capture the actual balance value. We need this for the next
  //    step: passing `args.amount` (the GROSS deposit advertised in
  //    the claim URL) to the withdraw fails, because Umbra deducts a
  //    deposit fee (~125 bps) — so the encrypted balance is always
  //    LESS than the gross. Asking the MPC to withdraw 0.1 SOL when
  //    the balance has 0.099 SOL fails silently in the Arcium
  //    callback (queue tx returns "success" → MPC failure-claim
  //    flow runs → no SOL transferred). Clamping to the actual
  //    balance avoids that.
  const queryBalance = getEncryptedBalanceQuerierFunction({
    client: args.shadowClient,
  });
  const POLL_TIMEOUT_MS = 90_000;
  const POLL_INTERVAL_MS = 2_000;
  const pollStart = Date.now();
  let sharedBalance: bigint | null = null;
  while (Date.now() - pollStart < POLL_TIMEOUT_MS) {
    const results = await queryBalance([args.mint as any]);
    let observedState: string | undefined;
    for (const [, result] of results as any) {
      observedState = result?.state;
      if (result?.state === "shared") {
        const raw = result.balance;
        sharedBalance =
          typeof raw === "bigint"
            ? raw
            : typeof raw === "number"
              ? BigInt(Math.trunc(raw))
              : BigInt(String(raw));
        break;
      }
    }
    if (sharedBalance !== null) {
      // eslint-disable-next-line no-console
      console.log(
        `[claim] balance reached shared mode after ${Date.now() - pollStart}ms (balance=${sharedBalance})`,
      );
      break;
    }
    // eslint-disable-next-line no-console
    console.log(
      `[claim] waiting for shared mode (state=${observedState ?? "unknown"}, waited=${Date.now() - pollStart}ms)`,
    );
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  if (sharedBalance === null) {
    throw new Error(
      `Encrypted balance never reached "shared" mode after ${POLL_TIMEOUT_MS}ms — Arcium callback may be stuck. Try again in a minute.`,
    );
  }

  // 3. Withdraw if there's an encrypted balance to withdraw. If the
  //    balance is 0, a previous withdraw attempt already succeeded
  //    and unwrapped the SOL into the shadow's main wallet — but
  //    didn't sweep it to the recipient. We skip the SDK withdraw
  //    and fall through to the sweep, which is what'll deliver the
  //    funds. Trying to call the SDK withdraw with a 0-balance
  //    encrypted account fails with INSUFFICIENT_FUNDS in the
  //    Arcium callback (the same false-success → failure-claim
  //    flow we saw on chain earlier).
  let result: { queueSignature?: unknown; callbackSignature?: unknown } = {};
  if (sharedBalance === 0n) {
    // eslint-disable-next-line no-console
    console.log(
      `[claim] encrypted balance is 0 — assuming a prior withdraw already drained it; skipping SDK withdraw, going straight to sweep`,
    );
  } else {
    // Withdraw the smaller of (requested amount, actual balance).
    // The deposit fee means the encrypted balance is always slightly
    // less than the gross amount that was deposited. Withdrawing the
    // full balance pulls every available lamport; withdrawing the
    // requested amount risks under/over-shoot if a future protocol
    // change adjusts the fee.
    const withdrawAmount =
      sharedBalance < args.amount ? sharedBalance : args.amount;
    // eslint-disable-next-line no-console
    console.log(
      `[claim] withdrawing ${withdrawAmount} (requested=${args.amount}, available=${sharedBalance})`,
    );

    const withdraw =
      getEncryptedBalanceToPublicBalanceDirectWithdrawerFunction({
        client: args.shadowClient,
      });
    result = (await withdraw(
      args.recipientAddress as any,
      args.mint as any,
      withdrawAmount as any,
    )) as any;
  }

  // 4. Sweep the shadow's main wallet balance to the recipient. See
  //    `sweepShadowToRecipient` for the rationale (TL;DR: the SDK's
  //    `destinationAddress` argument is misleading; the unwrapped
  //    SOL lands in the shadow's own wallet, and we have to push it
  //    onward ourselves).
  await sweepShadowToRecipient({
    shadowKeypair,
    recipientAddress: args.recipientAddress,
    connection: args.connection,
  }).catch((err) => {
    // Don't fail the whole claim — the SDK withdraw already
    // finalised, the SOL is in the shadow's wallet, and a later
    // retry on the same URL will detect this state and re-sweep.
    // eslint-disable-next-line no-console
    console.warn("[claim] sweep tx failed", err);
  });

  return {
    queueSignature: String((result as any).queueSignature),
    callbackSignature: (result as any).callbackSignature
      ? String((result as any).callbackSignature)
      : undefined,
  };
}

/* ─────────────────────────────────────────────────────────────────────
   6.5. claimToRecipient — privacy-preserving mixer-based claim
   ───────────────────────────────────────────────────────────────────── */

export interface ClaimToRecipientArgs {
  /** The shadow's Umbra client (signed by ephemeral key from URL fragment).
   *  Used to scan + claim the sender's deposit into the shadow's encrypted
   *  balance, then to re-encrypt that balance toward the recipient. */
  shadowClient: UmbraClient;
  /** The recipient's wallet-backed Umbra client (signer = Phantom/etc).
   *  Used to scan + claim the re-encrypted UTXO and finally to withdraw
   *  the shielded balance into the recipient's own wallet. The signer's
   *  address is what the SDK's withdraw helper uses as the destination —
   *  see `node_modules/@umbra-privacy/sdk/dist/index.js:10505` and the
   *  `withdrawShielded` wrapper in `lib/umbra.ts` which closes to
   *  `client.signer.address` on purpose for this reason. */
  recipientClient: UmbraClient;
  /** 64-byte secret key for the shadow account, used to sign a sweep
   *  fallback when `fallbackToSweep` is enabled. */
  ephemeralPrivateKey: Uint8Array;
  /** RPC connection used for shadow-balance reads + the optional sweep tx. */
  connection: Connection;
  /** Recipient's wallet (Phantom) base58 address. UTXO is locked to this
   *  address via `destinationAddress` on the re-encrypt creator. */
  recipientAddress: string;
  mint: string;
  amount: bigint;
  /** When the recipient is unregistered AND the user opts out of the
   *  one-time setup popup (or the registration call fails for any
   *  reason), fall back to the legacy `withdrawFromShadow` path which
   *  withdraws + sweeps shadow→recipient publicly. Default: false.
   *  Privacy is reduced for that row when this fallback runs (the
   *  shadow→recipient SOL transfer is publicly visible on-chain). */
  fallbackToSweep?: boolean;
  /** Test-only override — pin the re-encrypt amount instead of clamping
   *  to the shadow's encrypted-balance reading. */
  __reencryptAmountOverride?: bigint;
  /** Optional phase callback for UI progress copy. Fires at the
   *  beginning of each major phase. The page-level `claimStep` state
   *  reads this to swap from "Looking for your funds" → "Forwarding
   *  via privacy pool" → "Withdrawing to your wallet" without the
   *  caller needing to await intermediate promises. */
  onPhase?: (
    phase: "scanning" | "claiming" | "reencrypting" | "withdrawing",
  ) => void;
}

export interface ClaimToRecipientResult {
  /** "mixer" when the privacy-preserving path was taken, "sweep" when
   *  the legacy fallback was used (registered=false + fallbackToSweep). */
  path: "mixer" | "sweep";
  /** Signature of the final recipient-side withdraw (mixer path) OR the
   *  shadow→recipient sweep (fallback path). Useful for the explorer
   *  link the UI shows on success. */
  finalSignature: string;
  /** Signature of the shadow's re-encrypt-to-recipient queue tx. Only
   *  set on the mixer path. */
  reencryptSignature?: string;
  /** Signature of the recipient's claim-into-encrypted-balance tx. Only
   *  set on the mixer path. */
  recipientClaimSignature?: string;
}

/**
 * Privacy-preserving end-to-end claim. Replaces `withdrawFromShadow`'s
 * sweep-based path with a mixer-based one:
 *
 *   1. Shadow scans + claims the sender's deposit (existing behaviour).
 *   2. Shadow re-encrypts its encrypted balance into a NEW UTXO in the
 *      stealth pool, encrypted to the RECIPIENT's view key (via
 *      `getEncryptedBalanceToReceiverClaimableUtxoCreatorFunction`).
 *      No on-chain link from shadow → recipient remains.
 *   3. Recipient scans the pool, claims the new UTXO into their own
 *      encrypted balance.
 *   4. Recipient withdraws the shielded balance to their public wallet
 *      (via `withdrawShielded`, which the SDK routes to the SIGNER's
 *      address — i.e. the recipient's connected wallet — see
 *      `node_modules/@umbra-privacy/sdk/dist/index.js:10505`).
 *
 * Privacy trade-off vs. the legacy sweep:
 *   - Legacy sweep:       Sender → Shadow → Recipient (2 hops, both
 *                         publicly visible; trivially trace-able on
 *                         Solana Explorer).
 *   - Mixer-based path:   Sender → Shadow → MIXER → Recipient. The
 *                         middle hop is a re-encryption inside the
 *                         Umbra pool; observers see "shadow deposited
 *                         into mixer" and "some wallet withdrew from
 *                         mixer" but cannot link the two without
 *                         breaking the encryption.
 *
 * Cost trade-off:
 *   - Recipient must register with Umbra (one-time, ~0.005 SOL,
 *     2 wallet popups). Caller is expected to have run
 *     `ensureRegistered` BEFORE invoking this. If `fallbackToSweep` is
 *     true and the recipient is not registered, this function will
 *     transparently fall back to the legacy sweep path so the gift /
 *     payroll row still completes.
 *   - One extra Arcium MPC round-trip for the re-encrypt step (10-30s
 *     typical on devnet) plus one for the recipient's claim.
 */
export async function claimToRecipient(
  args: ClaimToRecipientArgs,
): Promise<ClaimToRecipientResult> {
  const shadowKeypair = Keypair.fromSecretKey(args.ephemeralPrivateKey);
  const shadowPubkey = shadowKeypair.publicKey;

  // ─── Pre-scan check (mirrors the legacy fast paths) ──────────────────
  const existingBalance = await getEncryptedBalance(
    args.shadowClient,
    args.mint,
  );
  const initialShadowBalance = await args.connection.getBalance(
    shadowPubkey,
    "confirmed",
  );
  // eslint-disable-next-line no-console
  console.log(
    `[claim] claimToRecipient pre-scan: encryptedBalance=${existingBalance}, shadowWalletBalance=${initialShadowBalance}`,
  );

  // State 3 fallback: shadow has a fat SOL float and no encrypted balance
  // — a prior withdraw already unwrapped here, never swept. The mixer
  // path can't recover this state (there's nothing in the encrypted
  // balance to re-encrypt). Sweep directly when the caller permits it,
  // accepting the privacy degradation for this specific row.
  const STATE_3_THRESHOLD = 50_000_000;
  if (
    args.fallbackToSweep &&
    existingBalance === 0n &&
    initialShadowBalance > STATE_3_THRESHOLD
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      `[claim] state-3 recovery via legacy sweep — shadow has unswept SOL (${initialShadowBalance}) and no encrypted balance. Privacy reduced for this row.`,
    );
    const sweepSig = await sweepShadowToRecipient({
      shadowKeypair,
      recipientAddress: args.recipientAddress,
      connection: args.connection,
    });
    return {
      path: "sweep",
      finalSignature: sweepSig ?? "swept-only-no-sdk-call",
    };
  }

  // 1. Shadow scans + claims its own deposit (no-op when the encrypted
  //    balance is already populated, which means a prior run got past
  //    the claim step).
  if (existingBalance > 0n) {
    // eslint-disable-next-line no-console
    console.log(
      `[claim] encrypted balance already populated (${existingBalance}) — skipping scan + claim`,
    );
  } else {
    args.onPhase?.("scanning");
    const SCAN_TIMEOUT_MS = 90_000;
    const SCAN_INTERVAL_MS = 5_000;
    const scanStart = Date.now();
    let utxos: Awaited<
      ReturnType<typeof scanClaimableUtxos>
    >["received"] = [];
    while (Date.now() - scanStart < SCAN_TIMEOUT_MS) {
      const scan = await scanClaimableUtxos(args.shadowClient);
      utxos = [
        ...(scan.received ?? []),
        ...(scan.publicReceived ?? []),
      ];
      if (utxos.length > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[claim] shadow found ${utxos.length} UTXO(s) after ${Date.now() - scanStart}ms`,
        );
        break;
      }
      // eslint-disable-next-line no-console
      console.log(
        `[claim] shadow scan: no UTXO yet (waited=${Date.now() - scanStart}ms)`,
      );
      await new Promise((r) => setTimeout(r, SCAN_INTERVAL_MS));
    }
    if (utxos.length > 0) {
      args.onPhase?.("claiming");
      await claimUtxos({ client: args.shadowClient, utxos });
    }
  }

  // 2. Re-encrypt shadow's encrypted balance → new UTXO in the pool
  //    targeting the recipient's view key. Clamp the amount to the
  //    actual encrypted balance (post-deposit-fee, per the same
  //    rationale as `withdrawFromShadow` step 3).
  args.onPhase?.("reencrypting");
  const balanceForReencrypt = await getEncryptedBalance(
    args.shadowClient,
    args.mint,
  );
  if (balanceForReencrypt === 0n) {
    throw new Error(
      "Shadow has no encrypted balance to re-encrypt — the deposit hasn't claimed into the shadow's ETA yet, and the scan window expired.",
    );
  }
  const reencryptAmount =
    args.__reencryptAmountOverride ??
    (balanceForReencrypt < args.amount ? balanceForReencrypt : args.amount);
  // eslint-disable-next-line no-console
  console.log(
    `[claim] re-encrypting ${reencryptAmount} from shadow → recipient ${args.recipientAddress} (available=${balanceForReencrypt}, requested=${args.amount})`,
  );

  const reencryptZkProver = getCreateReceiverClaimableUtxoFromEncryptedBalanceProver({
    assetProvider: proxiedAssetProvider(),
    ...zkAssetCache,
  });
  const reencrypt = getEncryptedBalanceToReceiverClaimableUtxoCreatorFunction(
    { client: args.shadowClient },
    {
      zkProver: reencryptZkProver,
      // Skip the SDK's rent-claim follow-up tx — we can't recover that
      // dust from a one-shot ephemeral shadow anyway, and it adds an
      // extra wait. Same trade-off `payInvoiceFromShielded` makes.
      arcium: {
        awaitComputationFinalization: { reclaimComputationRent: false },
      },
    } as any,
  );
  const reencryptResult = await reencrypt({
    destinationAddress: args.recipientAddress as any,
    mint: args.mint as any,
    amount: reencryptAmount as any,
  });
  const reencryptSignature =
    String(
      (reencryptResult as any).queueSignature ??
        (reencryptResult as any).createUtxoSignature ??
        (reencryptResult as any).callbackSignature ??
        "",
    ) || undefined;
  // eslint-disable-next-line no-console
  console.log(
    `[claim] re-encrypt queue signature: ${reencryptSignature ?? "(none)"}`,
  );

  // 3. Recipient scans the pool for the freshly-deposited UTXO. The
  //    re-encrypt's Arcium callback typically lands within 10-30s; we
  //    poll up to 90s before giving up.
  args.onPhase?.("scanning");
  const RECIPIENT_SCAN_TIMEOUT_MS = 90_000;
  const RECIPIENT_SCAN_INTERVAL_MS = 5_000;
  const recipientScanStart = Date.now();
  let recipientUtxos: any[] = [];
  while (Date.now() - recipientScanStart < RECIPIENT_SCAN_TIMEOUT_MS) {
    const scan = await scanClaimableUtxos(args.recipientClient);
    recipientUtxos = [
      ...(scan.received ?? []),
      ...(scan.publicReceived ?? []),
    ];
    if (recipientUtxos.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[claim] recipient found ${recipientUtxos.length} UTXO(s) after ${Date.now() - recipientScanStart}ms`,
      );
      break;
    }
    // eslint-disable-next-line no-console
    console.log(
      `[claim] recipient scan: no UTXO yet (waited=${Date.now() - recipientScanStart}ms)`,
    );
    await new Promise((r) => setTimeout(r, RECIPIENT_SCAN_INTERVAL_MS));
  }
  if (recipientUtxos.length === 0) {
    throw new Error(
      `Re-encrypted UTXO never surfaced in the recipient's scan after ${RECIPIENT_SCAN_TIMEOUT_MS}ms. Arcium callback may be delayed; retrying the claim link in a minute should pick it up.`,
    );
  }

  // 4. Recipient claims the UTXO into their own encrypted balance.
  args.onPhase?.("claiming");
  const recipientClaimResult = await claimUtxos({
    client: args.recipientClient,
    utxos: recipientUtxos,
  });
  const recipientClaimSignature =
    String(
      (recipientClaimResult as any)?.[0] ??
        (recipientClaimResult as any)?.signature ??
        (recipientClaimResult as any)?.queueSignature ??
        "",
    ) || undefined;
  // eslint-disable-next-line no-console
  console.log(
    `[claim] recipient claim signature: ${recipientClaimSignature ?? "(none)"}`,
  );

  // 5. Recipient withdraws the shielded balance to their own wallet.
  //    The SDK's `withdrawShielded` (in `lib/umbra.ts`) closes to
  //    `client.signer.address` — i.e. the connected Phantom wallet —
  //    because empirically the SDK ignores the `destinationAddress`
  //    arg in withdrawIntoPublicBalance and routes by signer. Native
  //    SOL lands directly; no sweep needed.
  args.onPhase?.("withdrawing");
  const withdrawAmount =
    reencryptAmount < args.amount ? reencryptAmount : args.amount;
  // eslint-disable-next-line no-console
  console.log(
    `[claim] recipient withdrawing ${withdrawAmount} (re-encrypted=${reencryptAmount})`,
  );
  const withdrawResult = await withdrawShielded(
    args.recipientClient,
    args.mint,
    withdrawAmount,
  );
  const finalSignature =
    withdrawResult.callbackSignature ?? withdrawResult.queueSignature;

  return {
    path: "mixer",
    finalSignature,
    reencryptSignature,
    recipientClaimSignature,
  };
}

/* ─────────────────────────────────────────────────────────────────────
   7. Claim URL generation + parsing
   ───────────────────────────────────────────────────────────────────── */

export interface GenerateClaimUrlArgs {
  baseUrl: string;
  batchId: string;
  /** Row index in the batch — used to scope the claim page's metadata
   *  lookup. */
  row: number;
  ephemeralPrivateKey: Uint8Array;
  /** Optional metadata baked into the URL hash so the claim page can
   *  show the amount/sender BEFORE the recipient connects a wallet. */
  metadata?: ClaimUrlMetadata;
}

export interface ClaimUrlMetadata {
  /** Display amount, e.g. "100.00". */
  amount: string;
  symbol: string;
  /** Display name of the employer / payer. */
  sender: string;
  /** Mint address (base58). */
  mint: string;
  /** Amount in base units (string to survive JSON roundtrip). */
  amountBaseUnits: string;
}

/**
 * Build the claim URL Bob clicks. Format:
 *
 *   https://veil.app/claim/<batchId>/<row>#k=<base64-priv>&m=<base64-meta>
 *
 * The fragment (everything after #) is by spec NEVER sent to the
 * server in an HTTP request. So even though the URL is shared via
 * Slack/email/SMS (all of which may be observed by intermediaries on
 * the wire), the secret material stays on the recipient's device.
 *
 * Why include metadata in the fragment too: lets the claim page render
 * "You have $X from <sender>" before the recipient connects a wallet,
 * which is a much warmer welcome than "click connect to see what
 * you got".
 */
export function generateClaimUrl(args: GenerateClaimUrlArgs): string {
  const k = encodeEphemeralPrivateKey(args.ephemeralPrivateKey);
  const path = `${trimTrailingSlash(args.baseUrl)}/claim/${encodeURIComponent(
    args.batchId,
  )}/${args.row}`;
  const fragmentParts = [`k=${k}`];
  if (args.metadata) {
    const m = btoa(JSON.stringify(args.metadata))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    fragmentParts.push(`m=${m}`);
  }
  return `${path}#${fragmentParts.join("&")}`;
}

/** Inverse of generateClaimUrl — extract the key + metadata from a URL hash. */
export function parseClaimUrlFragment(hash: string): {
  privateKey: Uint8Array;
  metadata: ClaimUrlMetadata | null;
} {
  const stripped = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(stripped);
  const k = params.get("k");
  if (!k) throw new Error("Claim URL is missing key fragment (k=...)");
  const privateKey = decodeEphemeralPrivateKey(k);

  let metadata: ClaimUrlMetadata | null = null;
  const m = params.get("m");
  if (m) {
    try {
      const pad = m.length % 4 === 0 ? 0 : 4 - (m.length % 4);
      const b64 = m.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
      metadata = JSON.parse(atob(b64));
    } catch {
      // Bad metadata is non-fatal — claim page can still operate using
      // on-chain lookups. Surface as null and let the page degrade.
      metadata = null;
    }
  }

  return { privateKey, metadata };
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/* ─────────────────────────────────────────────────────────────────────
   8. Result type for the per-row payroll output
   ───────────────────────────────────────────────────────────────────── */

export interface ClaimLinkRow {
  recipient: string;
  amount: string;
  status: "claim-link" | "direct" | "failed";
  /** Set when status === "claim-link". */
  claimUrl?: string;
  /** Set when status === "claim-link" — for accounting of total cost. */
  shadowAddress?: string;
  /** Set when status === "claim-link" — for downloadable artifact. */
  fundingSignature?: string;
  /** Set when status === "claim-link" — for downloadable artifact. */
  depositSignature?: string;
  error?: string;
}

/**
 * Build a downloadable CSV of the claim links so the employer can hand
 * them out via whatever channel they prefer (a payroll system, manual
 * email, Slack DMs, etc.). Format:
 *
 *   row,recipient,amount,claim_url
 *
 * Empty claim_url cells correspond to recipients who were already
 * registered and got paid directly via the normal payroll flow.
 */
export function rowsToClaimLinkCsv(rows: readonly ClaimLinkRow[]): string {
  const header = "row,recipient,amount,status,claim_url";
  const lines = rows.map((row, idx) => {
    const cells = [
      String(idx + 1),
      row.recipient,
      row.amount,
      row.status,
      row.claimUrl ?? "",
    ];
    return cells.join(",");
  });
  return `${header}\n${lines.join("\n")}\n`;
}
