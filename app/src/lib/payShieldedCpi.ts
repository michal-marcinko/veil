"use client";

/**
 * payShieldedCpi — single-popup ENCRYPTED-balance pay path.
 *
 * Sister module to payInvoiceCpi.ts (which handles the public-balance
 * source). The two surface symmetric APIs so the integrator in
 * PayrollFlow can collect both kinds of build-results into the same
 * `wallet.signAllTransactions` array and get ONE Phantom popup for an
 * entire mixed-source payroll batch.
 *
 * ─────────────────────────────────────────────────────────────────────
 * Architectural choice — delegation, not reimplementation
 * ─────────────────────────────────────────────────────────────────────
 *
 * The encrypted-balance path is FAR more involved than the public one.
 * `getEncryptedBalanceToReceiverClaimableUtxoCreatorFunction` (sdk
 * index.cjs lines 7351-8295) computes ~200 ZK signals: rescue
 * encryption (4 ciphertexts + 4 keys), Fiat-Shamir challenge over a
 * deterministic transcript, polynomial-commitment evaluation,
 * 16+ modular inverses, an aggregator hash with 42 inputs. Mistranscribing
 * any one of them produces an invalid Groth16 proof that the validator
 * silently rejects with no useful diagnostic. Reproducing this faithfully
 * in user-space is a multi-week, high-risk job.
 *
 * Instead this module DELEGATES the entire heavy lift to the SDK and
 * intercepts the network layer. We construct a proxied client whose
 * `signer.signTransaction` is a no-op that captures the unsigned message
 * bytes (which `partiallySignTransactionMessageWithSigners` has already
 * compiled, ALT-substituted, and frozen by the time the SDK's signer
 * is invoked — see sdk index.cjs:5842), and whose
 * `transactionForwarder.forwardSequentially` is a no-op that returns
 * a stub signature so the SDK's sequential build flow continues.
 *
 * The SDK's create function then walks through:
 *   1. (optional) close-existing-proof-account  → captured tx 0
 *   2. create-proof-account                     → captured tx 1
 *   3. create-receiver-claimable-utxo (Arcium)  → captured tx 2
 *
 * We disable the SDK's await-callback + rent-claim with
 * `arcium: { awaitComputationFinalization: false }` (sdk index.cjs:8245),
 * which prevents the SDK from BUILDING a fourth rent-claim tx after
 * Arcium MPC finalisation. With await disabled, `forwardAndMonitor`
 * returns immediately after the no-op forwarder resolves
 * (sdk index.cjs:5857). Net effect: exactly 2 or 3 captured txs,
 * depending on whether a stale proof-account cleanup is needed.
 *
 * The captured `messageBytes` are kit's standard v0 wire format —
 * byte-identical to what web3.js emits, so we wrap each in a
 * `VersionedTransaction` for the integrator to feed into
 * `wallet.signAllTransactions`. The pre-baked Umbra ALT for the
 * Arcium deposit instruction (clusterOffset 456 on devnet,
 * `deposit_into_stealth_pool_from_shared_balance_v11`) is already
 * substituted by the SDK's compiler — we don't need our own ALT
 * machinery for shielded.
 *
 * ─────────────────────────────────────────────────────────────────────
 * Why this is safer than reimplementation
 * ─────────────────────────────────────────────────────────────────────
 *
 * Every byte of every captured message comes from the SDK's own code
 * paths: the same ZK proof, the same codama instruction builders, the
 * same account orderings, the same ALT entries. If the SDK is correct
 * in its all-in-one orchestration (which it is — the existing
 * payInvoiceFromShielded() in umbra.ts proves this end-to-end), then
 * every captured byte is correct here. We're moving the SIGN +
 * SUBMIT boundary outward, not changing what gets signed or submitted.
 *
 * Forward-compat: when Umbra ships a circuit version bump or instruction
 * v12, the SDK absorbs the change, our captured messages absorb it
 * transparently, and this module needs zero updates.
 *
 * ─────────────────────────────────────────────────────────────────────
 * Submission order constraint
 * ─────────────────────────────────────────────────────────────────────
 *
 * The three captured txs share one blockhash (we override
 * `blockhashProvider` to pin a single fetched blockhash for the entire
 * build). They MUST submit in order with confirmation between each:
 *
 *   close (if present) → confirm → proof → confirm → utxo → confirm
 *
 * The proof-account PDA is (depositor, offset) — both txs target the
 * same PDA, and we MUST close the stale one before creating a fresh
 * buffer. The deposit (utxo) tx reads the buffer the proof tx wrote,
 * so it must run AFTER the proof tx confirms. submitSignedShieldedTxsInOrder
 * encodes this order.
 *
 * The Arcium MPC finalisation that lands AFTER the queue (utxo) tx
 * confirms is async — we don't wait for it here, and the SDK's
 * existing receiver-claim flow (`scanClaimableUtxos`, claim page) tolerates
 * indexer/MPC lag transparently. Same trade-off the existing
 * `payInvoiceFromShielded` already accepts.
 */

import {
  AddressLookupTableAccount,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
  VersionedMessage,
  Connection,
} from "@solana/web3.js";

import { getEncryptedBalanceToReceiverClaimableUtxoCreatorFunction } from "@umbra-privacy/sdk";
import { getCreateReceiverClaimableUtxoFromEncryptedBalanceProver } from "@umbra-privacy/web-zk-prover";

import { RPC_URL } from "./constants";

// Re-using the same UmbraClient handle the rest of the app uses. We
// import the type via `getUmbraClient`'s return type rather than
// hard-coding the shape so SDK updates flow through transparently.
import type { getUmbraClient } from "@umbra-privacy/sdk";
type UmbraClient = Awaited<ReturnType<typeof getUmbraClient>>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the SDK's create flow returns without producing the
 * minimum expected number of captured transactions (proof + utxo).
 * Indicates an SDK behaviour change — the integrator should fall back
 * to the legacy `payInvoiceFromShielded` path until this module is
 * updated.
 */
export class ShieldedCpiNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShieldedCpiNotConfiguredError";
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ShieldedCpiArgs {
  /** Alice's already-built Umbra client (the payer/sender). The signer
   *  on this client must be Alice's wallet — every captured tx is
   *  signed by this address when the integrator calls
   *  `wallet.signAllTransactions`. */
  client: UmbraClient;
  /** Bob — must already be a fully-registered Umbra recipient. The
   *  SDK reads his on-chain user-account PDA during proof generation
   *  to pick up his X25519 key + commitment; if he's not registered
   *  the SDK throws inside the proof step. */
  recipientAddress: string;
  /** SPL mint (e.g. wSOL or USDC). Token-2022 with TransferFee
   *  extensions is supported by the SDK; we just pass through. */
  mint: string;
  /** Amount in base units — the GROSS amount before Umbra's protocol
   *  fee (35 bps for shielded; the SDK deducts internally). */
  amount: bigint;
}

export interface BuiltShieldedCpiTxs {
  /** Present only if a stale proof account exists at our chosen offset.
   *  Submit FIRST and wait for confirm before proofTx. */
  closeTx?: VersionedTransaction;
  /** Create-proof-account tx. Submit AFTER closeTx (if any) confirms. */
  proofTx: VersionedTransaction;
  /** Create-receiver-claimable-utxo tx (the Arcium queue tx). Submit
   *  AFTER proofTx confirms. The MPC callback that finalises the UTXO
   *  on-chain lands asynchronously and does NOT need a popup — we
   *  return after the queue tx confirms. */
  utxoTx: VersionedTransaction;
  /** Shared blockhash across all three txs. We pin a single
   *  blockhashProvider during build so close+proof+utxo all share. */
  blockhash: string;
  lastValidBlockHeight: number;
  payerAddress: string;
  /** Cached blockhash-independent components for fast blockhash refresh.
   *  See refreshShieldedCpiTxsBlockhash. */
  cached: {
    closeMessageBytes?: Uint8Array;
    proofMessageBytes: Uint8Array;
    utxoMessageBytes: Uint8Array;
    payerPubkey: PublicKey;
    /** Always empty — the SDK's pre-baked Umbra ALT is already inlined
     *  into the captured messageBytes by kit's compiler, so web3.js
     *  doesn't need a separate ALT account to deserialize the messages.
     *  Field present for API symmetry with payInvoiceCpi. */
    altAccounts: AddressLookupTableAccount[];
    /** For API symmetry with payInvoiceCpi.cached. The shielded path
     *  doesn't use a single TransactionInstruction abstraction (the
     *  SDK builds its own messages via kit) — the messageBytes above
     *  are the cached artefact. */
    closeIx?: TransactionInstruction;
    proofIx: TransactionInstruction;
    utxoIx: TransactionInstruction;
  };
}

// ---------------------------------------------------------------------------
// Capture-mode proxies for signer + forwarder + blockhash provider
// ---------------------------------------------------------------------------

/**
 * Stub signature value used to satisfy the SDK's
 * `isSignedTransaction` shape check (sdk index.cjs:7335). The SDK's
 * downstream `getSignatureFromTransaction` call (sdk
 * index.cjs:5852) is also satisfied — it just base58-encodes whatever
 * 64 bytes it finds, so all-zeros becomes the all-1's address. The
 * stub signature is NEVER submitted to chain — our forwarder is also
 * a no-op, and the integrator re-signs through Phantom anyway.
 */
function makePlaceholderSignature(): Uint8Array {
  return new Uint8Array(64);
}

interface CaptureContext {
  /** Captured kit-style messageBytes in build order:
   *    - tx 0: close (if a stale proof account existed)
   *    - tx 1: create-proof-account
   *    - tx 2: deposit / queue-into-stealth-pool (Arcium)
   *  When no close is needed, length is 2; otherwise 3. */
  capturedMessages: Uint8Array[];
  /** Pinned blockhash + height the build re-uses for every sub-tx. */
  pinnedBlockhash: { blockhash: string; lastValidBlockHeight: number };
  /** Address the SDK's signer reports — kit string form. The fee-payer
   *  on every captured message will match this. */
  signerAddress: string;
}

/**
 * Build a proxied client that forwards 99% of properties to the real
 * client but overrides:
 *   - signer.signTransaction → captures messageBytes, returns stub-signed
 *   - transactionForwarder    → captures-and-resolves; never hits chain
 *   - blockhashProvider       → returns pinned blockhash so all sub-txs
 *                                share one
 *   - computationMonitor      → undefined (defensive: with
 *                                awaitComputationFinalization: false the
 *                                SDK doesn't reach for it, but clearing
 *                                makes the no-await invariant explicit)
 *
 * The SDK reads other client properties (networkConfig, masterSeed,
 * accountInfoProvider) which all pass through unchanged.
 */
function makeCaptureClient(
  realClient: UmbraClient,
  ctx: CaptureContext,
): UmbraClient {
  const client: any = realClient;
  const realSigner = client.signer;

  const stubSigner = {
    // Pass the real address through — accountInfoProvider lookups in
    // the SDK use this for PDA derivation (e.g. depositorUserAccount).
    address: realSigner.address,
    async signTransaction(partial: any): Promise<any> {
      // `partial` is what kit's partiallySignTransactionMessageWithSigners
      // produced: { messageBytes, signatures: { [feePayer]: null } }
      // (sdk index.cjs:5843). Capture the bytes and return a "signed"
      // shape good enough for isSignedTransaction (length>0 signatures).
      ctx.capturedMessages.push(new Uint8Array(partial.messageBytes));
      const signerAddr = String(realSigner.address);
      return {
        ...partial,
        messageBytes: partial.messageBytes,
        signatures: {
          ...partial.signatures,
          [signerAddr]: makePlaceholderSignature(),
        },
      };
    },
    // Defensive — the create flow never calls these, but if it ever
    // does (e.g. signMessage during a deeper key derivation), forward
    // to the real signer rather than crash.
    signMessage:
      typeof realSigner.signMessage === "function"
        ? realSigner.signMessage.bind(realSigner)
        : undefined,
    signTransactions:
      typeof realSigner.signTransactions === "function"
        ? realSigner.signTransactions.bind(realSigner)
        : undefined,
  };

  const stubForwarder = {
    async forwardSequentially(_txs: readonly any[], _options?: any) {
      // Returning [stub] is enough — `forwardAndMonitor` line 5853 does
      // `await transactionForwarder.forwardSequentially([signedTransaction])`
      // and ignores the result. Subsequent `getSignatureFromTransaction`
      // pulls the sig from the signedTransaction itself, not from us.
      return [makePlaceholderSignature()];
    },
    async forwardInParallel(_txs: readonly any[], _options?: any) {
      return _txs.map(() => makePlaceholderSignature());
    },
    async fireAndForget(_tx: any) {
      // With awaitComputationFinalization: false the rent-claim path
      // (sdk index.cjs:5901) is never reached, so this never fires.
      // Stubbed for completeness in case Umbra changes that branch.
      return makePlaceholderSignature();
    },
  };

  const pinnedBlockhashProvider = async (_options?: any) => {
    return {
      blockhash: ctx.pinnedBlockhash.blockhash,
      lastValidBlockHeight: ctx.pinnedBlockhash.lastValidBlockHeight,
    };
  };

  // Construct a new POJO that has all the original client's properties
  // and our overrides on top. Spread into a fresh object so mutating
  // our copy can't bleed into the cached client used by the rest of
  // the app.
  return {
    ...client,
    signer: stubSigner,
    transactionForwarder: stubForwarder,
    blockhashProvider: pinnedBlockhashProvider,
    // Defensive: ensure the SDK's awaitComputation path doesn't try to
    // poll despite our awaitComputationFinalization:false config. With
    // both gates closed, we get the simplest possible flow.
    computationMonitor: undefined,
  } as UmbraClient;
}

// ---------------------------------------------------------------------------
// Same proxied-CDN trick used in umbra.ts / payInvoiceCpi.ts. Routes the
// ZK asset bundle through our same-origin /umbra-cdn rewrite to dodge
// CloudFront's missing CORS headers on direct fetches.
// ---------------------------------------------------------------------------

async function getProxiedAssetProvider() {
  const { getCdnZkAssetProvider } = await import("@umbra-privacy/web-zk-prover");
  return getCdnZkAssetProvider({ baseUrl: "/umbra-cdn" });
}

// ---------------------------------------------------------------------------
// Build phase
// ---------------------------------------------------------------------------

/**
 * Build (but don't sign or submit) the 2-3 transactions the SDK's
 * encrypted-balance pay flow would produce, ready for the integrator
 * to batch-sign with `wallet.signAllTransactions(...)` alongside any
 * other batched txs (fund tx, deposit txs from other rows, etc.).
 *
 * Heavy work — the underlying SDK call drives:
 *   - Master-seed derivation (cached after first session)
 *   - ZK proof generation (~10-20s on cold cache, ~5-8s warm)
 *   - On-chain account fetches for receiver + MXE + mint
 *   - Codama instruction building × 2-3
 *
 * Returns immediately once the SDK's create function resolves — no
 * tx is submitted during build. The caller owns the signing + submission
 * lifecycle.
 *
 * @throws {ShieldedCpiNotConfiguredError} if the SDK produces fewer
 *   than 2 captured txs (proof + utxo are mandatory).
 */
export async function buildShieldedCpiTxs(
  args: ShieldedCpiArgs,
): Promise<BuiltShieldedCpiTxs> {
  const { client, recipientAddress, mint, amount } = args;
  const c: any = client;

  // 1. Pin a single blockhash for the whole build so all 2-3 captured
  //    sub-txs share it. Source it from the SAME RPC the rest of the
  //    app uses to avoid a fork-vs-our-confirm race.
  const connection = new Connection(RPC_URL, "confirmed");
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  const ctx: CaptureContext = {
    capturedMessages: [],
    pinnedBlockhash: { blockhash, lastValidBlockHeight },
    signerAddress: String(c.signer.address),
  };

  // 2. Build a proxy client. Reusing the real client wholesale means
  //    SDK reads of `client.networkConfig` / `client.masterSeed` /
  //    `client.accountInfoProvider` all pass through unchanged.
  const captureClient = makeCaptureClient(client, ctx);

  // 3. Stand up the ZK prover (same as payInvoiceFromShielded in
  //    umbra.ts). IndexedDB cache + same-origin CDN rewrite.
  const assetProvider = await getProxiedAssetProvider();
  const { zkAssetCache } = await import("./zk-asset-cache");
  const zkProver = getCreateReceiverClaimableUtxoFromEncryptedBalanceProver({
    assetProvider,
    ...zkAssetCache,
  });

  // 4. Drive the SDK's create function with our capture client. The
  //    call returns when the SDK has built+signed+forwarded all 2-3
  //    sub-txs (with our no-op forwarder, "forwarded" means "captured").
  //    Critical: awaitComputationFinalization: false skips both the
  //    callback wait AND the rent-claim follow-up tx (sdk
  //    index.cjs:5880 / 8245).
  const create = getEncryptedBalanceToReceiverClaimableUtxoCreatorFunction(
    { client: captureClient } as any,
    {
      zkProver,
      arcium: { awaitComputationFinalization: false },
    } as any,
  );

  await create({
    destinationAddress: recipientAddress as any,
    mint: mint as any,
    amount: amount as any,
  });

  // 5. Validate capture count. The SDK's create flow ALWAYS produces
  //    exactly 2 (no stale buffer) or 3 (stale buffer needed close)
  //    captured txs. Anything else means the SDK changed shape — fall
  //    back loudly so the integrator routes around us until this
  //    module is rebuilt.
  if (ctx.capturedMessages.length < 2 || ctx.capturedMessages.length > 3) {
    throw new ShieldedCpiNotConfiguredError(
      `Shielded build captured ${ctx.capturedMessages.length} txs — ` +
        `expected 2 (proof+utxo) or 3 (close+proof+utxo). The SDK's ` +
        `create flow may have changed; see payShieldedCpi.ts comments.`,
    );
  }

  // Order in capturedMessages reflects SDK build order:
  //   - if length === 3: [close, proof, utxo]
  //   - if length === 2: [proof, utxo]
  // See sdk index.cjs lines 8128 (close), 8209 (proof), 8253 (utxo).
  let closeMessageBytes: Uint8Array | undefined;
  let proofMessageBytes: Uint8Array;
  let utxoMessageBytes: Uint8Array;
  if (ctx.capturedMessages.length === 3) {
    [closeMessageBytes, proofMessageBytes, utxoMessageBytes] =
      ctx.capturedMessages;
  } else {
    [proofMessageBytes, utxoMessageBytes] = ctx.capturedMessages;
  }

  // 6. Wrap each captured kit-style messageBytes in a web3.js
  //    VersionedTransaction. The wire format is identical between
  //    kit's encoder and web3.js's VersionedMessage.deserialize —
  //    both implement the standard Solana v0 message format.
  //    No ALT-resolution needed at sign-time: wallets just sign the
  //    message bytes verbatim.
  const closeTx = closeMessageBytes
    ? messageBytesToVersionedTx(closeMessageBytes)
    : undefined;
  const proofTx = messageBytesToVersionedTx(proofMessageBytes);
  const utxoTx = messageBytesToVersionedTx(utxoMessageBytes);

  const payerPubkey = new PublicKey(ctx.signerAddress);

  // The cached.{close,proof,utxo}Ix fields are only present for API
  // shape compatibility with payInvoiceCpi (whose cached field stores
  // a TransactionInstruction). The shielded path doesn't have a single
  // TransactionInstruction handle — the SDK assembles full kit-style
  // messages internally, and we capture those messages whole. We
  // populate placeholder TransactionInstructions whose `data` carries
  // the message bytes for diagnostic visibility, and whose `programId`
  // / `keys` are empty. Refresh code uses cached.*MessageBytes, not
  // these, so the placeholders don't drive anything functional.
  const placeholderIx = (data: Uint8Array): TransactionInstruction =>
    new TransactionInstruction({
      programId: payerPubkey,
      keys: [],
      data: Buffer.from(data),
    });

  return {
    closeTx,
    proofTx,
    utxoTx,
    blockhash,
    lastValidBlockHeight,
    payerAddress: ctx.signerAddress,
    cached: {
      closeMessageBytes,
      proofMessageBytes,
      utxoMessageBytes,
      payerPubkey,
      altAccounts: [], // kit pre-baked ALT is already substituted
      closeIx: closeMessageBytes ? placeholderIx(closeMessageBytes) : undefined,
      proofIx: placeholderIx(proofMessageBytes),
      utxoIx: placeholderIx(utxoMessageBytes),
    },
  };
}

/**
 * Wrap kit-format messageBytes in a web3.js VersionedTransaction.
 *
 * `VersionedMessage.deserialize` parses the standard v0 wire format
 * (1 byte version + 3 byte header + compact-arrays of static keys,
 * compiled instructions, and ALT lookups). Both kit and web3.js emit
 * and consume this format identically — verified empirically by
 * crossing kit-built messages through wallet adapters that use web3.js
 * internals (see umbra.ts:108-153 for our existing kit-encoder/web3.js
 * decoder pipeline).
 */
function messageBytesToVersionedTx(
  messageBytes: Uint8Array,
): VersionedTransaction {
  const message = VersionedMessage.deserialize(messageBytes);
  return new VersionedTransaction(message);
}

// ---------------------------------------------------------------------------
// Refresh phase
// ---------------------------------------------------------------------------

/**
 * Rebuild the 2-3 captured txs with a fresh blockhash, reusing the
 * cached messageBytes. Mirrors `refreshPayInvoiceCpiTxBlockhash` in
 * payInvoiceCpi.ts.
 *
 * Cold-cache fallback: if a pre-signed shielded build sits in memory
 * for too long (typically >60s, the blockhash window), submitting any
 * of the three sub-txs fails with "Blockhash not found". Refreshing
 * just the blockhash is cheap (<1s); regenerating the ZK proof would
 * cost 10-20s. We swap the recentBlockhash field on each cached
 * MessageV0 and re-wrap, leaving every other byte untouched.
 *
 * Implementation note: the message's `recentBlockhash` field is a
 * mutable string on web3.js's MessageV0 (verified runtime — it's a
 * plain prop, no setter trap). Mutating in place after deserialize +
 * recompiling produces a syntactically-identical message except for
 * the blockhash bytes. Account indexes, ALT lookups, instruction
 * data, ALT references — all unchanged, so the captured ZK proof
 * remains valid.
 */
export async function refreshShieldedCpiTxsBlockhash(
  built: BuiltShieldedCpiTxs,
): Promise<BuiltShieldedCpiTxs> {
  const connection = new Connection(RPC_URL, "confirmed");
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  function withFreshBlockhash(messageBytes: Uint8Array): VersionedTransaction {
    const message = VersionedMessage.deserialize(messageBytes);
    // MessageV0.recentBlockhash is a mutable base58 string. Reassigning
    // it before we hand the message to VersionedTransaction is enough —
    // the wallet signs the serialized form, which web3.js re-emits with
    // our updated blockhash.
    (message as any).recentBlockhash = blockhash;
    return new VersionedTransaction(message);
  }

  const closeTx = built.cached.closeMessageBytes
    ? withFreshBlockhash(built.cached.closeMessageBytes)
    : undefined;
  const proofTx = withFreshBlockhash(built.cached.proofMessageBytes);
  const utxoTx = withFreshBlockhash(built.cached.utxoMessageBytes);

  return {
    closeTx,
    proofTx,
    utxoTx,
    blockhash,
    lastValidBlockHeight,
    payerAddress: built.payerAddress,
    cached: built.cached,
  };
}

// ---------------------------------------------------------------------------
// Submission phase
// ---------------------------------------------------------------------------

/**
 * Submit the signed shielded txs in their required order with
 * confirmation between each. Mirrors `submitSignedPayInvoiceCpiTx`
 * but enforces the close→proof→utxo ordering inherent to the
 * encrypted-balance flow.
 *
 * Why sequential, not parallel:
 *   - The proof tx writes a buffer at PDA (depositor, offset). The
 *     utxo tx READS that buffer. Submitting in parallel risks the
 *     utxo tx landing in a slot before the proof tx confirms,
 *     producing a "buffer not found" failure on chain.
 *   - The close tx (when present) deletes the SAME buffer the proof
 *     tx will recreate. Parallel submission could land the proof tx
 *     before the close clears the slot, producing
 *     "AccountAlreadyExists".
 *
 * Why we don't await the Arcium MPC callback:
 *   - The callback finalises the encrypted leaf in the merkle tree
 *     asynchronously (anywhere from 10s to several minutes on devnet
 *     during peak load). Waiting blocks the popup-batched UX for that
 *     long; since invoice payment status is read from the on-chain
 *     PDA (not from MPC finalisation), we don't gain anything by
 *     waiting. The same async-callback model works for the existing
 *     `payInvoiceFromShielded` in umbra.ts.
 *
 * Returns the queue-tx (utxoTx) signature, which is the canonical
 * "the shielded payment was queued" signature in the SDK's result
 * shape. The Arcium MPC callback signature is NOT returned because
 * we don't wait for it.
 */
export async function submitSignedShieldedTxsInOrder(args: {
  signedClose?: VersionedTransaction;
  signedProof: VersionedTransaction;
  signedUtxo: VersionedTransaction;
  built: BuiltShieldedCpiTxs;
}): Promise<{ utxoSignature: string }> {
  const connection = new Connection(RPC_URL, "confirmed");

  // Confirmation strategy: blockhash-based with lastValidBlockHeight
  // (per Solana 1.16+ recs). Same as payInvoiceCpi.
  async function sendAndConfirm(tx: VersionedTransaction): Promise<string> {
    const sig = await connection.sendTransaction(tx, {
      skipPreflight: false,
      maxRetries: 3,
    });
    await connection.confirmTransaction(
      {
        signature: sig,
        blockhash: args.built.blockhash,
        lastValidBlockHeight: args.built.lastValidBlockHeight,
      },
      "confirmed",
    );
    return sig;
  }

  // Defensive: if the integrator passes a signedClose but built has no
  // closeMessageBytes (or vice versa), surface clearly. Easy mistake to
  // make when refactoring PayrollFlow's batched-signing array to align
  // with row-by-row build outputs.
  const builtHasClose = !!args.built.cached.closeMessageBytes;
  if (Boolean(args.signedClose) !== builtHasClose) {
    throw new Error(
      "submitSignedShieldedTxsInOrder: signedClose presence does not " +
        "match built.cached.closeMessageBytes presence — check that " +
        "the close tx made it into wallet.signAllTransactions in the " +
        "same order it was built.",
    );
  }

  if (args.signedClose) {
    await sendAndConfirm(args.signedClose);
  }
  await sendAndConfirm(args.signedProof);
  const utxoSignature = await sendAndConfirm(args.signedUtxo);

  return { utxoSignature };
}
