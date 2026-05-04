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
  createSignerFromPrivateKeyBytes,
  getWebsocketTransactionForwarder,
} from "@umbra-privacy/sdk";
import {
  getUserRegistrationProver,
  getCdnZkAssetProvider,
} from "@umbra-privacy/web-zk-prover";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { NETWORK, RPC_URL, RPC_WSS_URL, UMBRA_INDEXER_API } from "./constants";

type UmbraClient = Awaited<ReturnType<typeof getUmbraClient>>;

/**
 * Estimated SOL float (lamports) Alice transfers into the shadow account
 * so the shadow has enough lamports to cover its own rent + tx fees for
 * register → deposit → withdraw. This is HONEST — measured against
 * mainnet during 2026-04 round-trips:
 *   - User account PDA rent: ≈ 0.0026 SOL
 *   - ETA (encrypted token account) rent: ≈ 0.0021 SOL
 *   - 3 register sub-tx fees: ≈ 0.0001 SOL
 *   - 1 deposit tx fee + Arcium compute: ≈ 0.0007 SOL
 *   - 1 withdraw tx fee + Arcium compute: ≈ 0.0008 SOL
 *   - 50 % safety margin
 * Documented in the UI as "≈ 0.01 SOL extra setup per unregistered
 * recipient" so the employer is never surprised.
 */
export const SHADOW_FUNDING_LAMPORTS = 10_000_000n; // 0.01 SOL

/** Same proxied CDN trick as umbra.ts — avoids CORS on Umbra's CloudFront. */
function proxiedAssetProvider() {
  return getCdnZkAssetProvider({ baseUrl: "/umbra-cdn" });
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
  const zkProver = getUserRegistrationProver({ assetProvider: proxiedAssetProvider() });
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
  /** Bob's wallet — the FINAL destination for the withdrawn tokens. */
  recipientAddress: string;
  mint: string;
  amount: bigint;
}

/**
 * Direct ETA → ATA withdrawal. The destinationAddress can be ANY
 * address (verified against the SDK's withdrawer interface — line 4998
 * of @umbra-privacy/sdk index.d.ts: "Withdraw to another address").
 * That's the entire reason this design works: the shadow can deposit to
 * its own encrypted balance and immediately withdraw to a completely
 * unrelated wallet without Bob's wallet ever needing an Umbra account.
 */
export async function withdrawFromShadow(
  args: WithdrawFromShadowArgs,
): Promise<{ queueSignature: string; callbackSignature?: string }> {
  const withdraw = getEncryptedBalanceToPublicBalanceDirectWithdrawerFunction({
    client: args.shadowClient,
  });
  const result = await withdraw(
    args.recipientAddress as any,
    args.mint as any,
    args.amount as any,
  );
  return {
    queueSignature: String((result as any).queueSignature),
    callbackSignature: (result as any).callbackSignature
      ? String((result as any).callbackSignature)
      : undefined,
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
