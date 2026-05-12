"use client";

/**
 * payInvoiceCpi — single-popup public-balance pay path.
 *
 * Architecture (chosen after recon — see
 * docs/superpowers/notes/2026-05-02-sdk-pay-function-recon.md):
 *
 * Direct codama. We mirror the cryptographic orchestration of the SDK's
 * `getPublicBalanceToReceiverClaimableUtxoCreatorFunction` (sdk index.cjs
 * lines 8842-9347), reusing every primitive the SDK exports so we don't
 * reimplement Poseidon / AES / ZK proof gen ourselves. We then build BOTH
 * Umbra instructions via codama (without submitting), pack them into a
 * single `pay_invoice` call on our `veil_pay` Anchor program, and submit
 * one tx via `@solana/web3.js`. ONE Phantom popup.
 *
 * The on-chain `veil_pay` program (programs/veil-pay/programs/veil-pay/src/lib.rs)
 * receives:
 *   - create_buffer_data: Vec<u8> — full codama-built ix data (incl. discriminator)
 *   - deposit_data: Vec<u8> — same
 *   - create_buffer_account_count: u8 — split point inside remaining_accounts
 * and CPIs both into the Umbra deposit program inside a single atomic tx.
 *
 * On the kit version drift: app has no top-level @solana/kit. Both
 * @umbra-privacy/sdk and @umbra-privacy/umbra-codama nest @solana/kit@6.8.0,
 * so we DO NOT import kit types directly. We accept `as any` casts at the
 * codama boundary (codama's `address` field is just a base58 string at
 * runtime — easy to coerce). Tx construction uses @solana/web3.js, the
 * lingua franca already used throughout the app.
 *
 * See: docs/superpowers/specs/2026-05-02-veilpay-cpi-single-popup-design.md
 */

import {
  AddressLookupTableAccount,
  PublicKey,
  TransactionMessage,
  TransactionInstruction,
  VersionedTransaction,
  Connection,
  ComputeBudgetProgram,
  type AccountMeta as Web3AccountMeta,
} from "@solana/web3.js";
import { x25519 } from "@noble/curves/ed25519";
import { keccak_256 } from "@noble/hashes/sha3";
import { kmac256 } from "@noble/hashes/sha3-addons";

// SDK exports — all available via @umbra-privacy/sdk top-level. The SDK
// re-exports these from internal chunks (verified in recon doc).
import {
  getMasterViewingKeyDeriver,
  getMasterViewingKeyBlindingFactorDeriver,
  getPoseidonPrivateKeyDeriver,
  getPoseidonBlindingFactorDeriver,
  getUserAccountX25519KeypairDeriver,
  getSecondViewingKeyDeriver,
  getPoseidonKeystreamBlindingFactorDeriver,
  getPoseidonEncryptor,
  getPoseidonKeystreamGenerator,
  getKeystreamCommitmentGenerator,
  getUtxoCommitmentHashGenerator,
  getUserCommitmentGeneratorFunction,
  getPoseidonAggregator,
  getAesEncryptor,
  computeBn254ModularInverse,
  deriveProofAccountOffsetFromModifiedGenerationIndex,
  deriveRandomSecretFromModifiedGenerationIndex,
  deriveNullifierFromModifiedGenerationIndex,
  getHardcodedCreateUtxoProtocolFeeProvider,
  feeSlabResultToInstructionFields,
} from "@umbra-privacy/sdk";
import {
  findEncryptedUserAccountPda,
  findStealthPoolPda,
  findPublicUtxoInputBufferPda,
} from "@umbra-privacy/sdk/pda";
import { decodeEncryptedUserAccount } from "@umbra-privacy/umbra-codama";
import { getCreateReceiverClaimableUtxoFromPublicBalanceProver } from "@umbra-privacy/web-zk-prover";

import type { PayInvoiceArgs, PayInvoiceResult } from "./umbra";
import {
  VEIL_PAY_PROGRAM_ID,
  UMBRA_PROGRAM_ID,
  VEILPAY_ALT_ADDRESS,
  RPC_URL,
  INVOICE_REGISTRY_PROGRAM_ID,
} from "./constants";

// SystemProgram pubkey — referenced by the lock_payment_intent CPI
// (its `init` constraint requires the system program account).
const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Anchor discriminator for veil_pay::pay_invoice. Computed as
// sha256("global:pay_invoice")[0..8]. Verified independently:
//   node -e "console.log(require('crypto').createHash('sha256')
//     .update('global:pay_invoice').digest().slice(0,8))"
// Once VeilPay's IDL is fetched post-deploy this can be cross-checked via
// `anchor idl fetch <program-id> --provider.cluster devnet`.
const PAY_INVOICE_DISCRIMINATOR = new Uint8Array([
  104, 6, 62, 239, 197, 206, 208, 220,
]);

// Anchor discriminator for veil_pay::pay_no_invoice. Same payload shape as
// pay_invoice, but the on-chain instruction skips the invoice-registry CPI —
// used by payroll rows that aren't bound to an invoice. Computed as
// sha256("global:pay_no_invoice")[0..8].
const PAY_NO_INVOICE_DISCRIMINATOR = new Uint8Array([
  55, 109, 173, 79, 149, 180, 76, 205,
]);

// Anchor discriminator for veil_pay::pay_invoice_from_shielded. Computed
// as sha256("global:pay_invoice_from_shielded")[0..8]. Verified against
// the post-build IDL at programs/veil-pay/target/idl/veil_pay.json
// (instructions[].discriminator for `pay_invoice_from_shielded`).
const PAY_INVOICE_FROM_SHIELDED_DISCRIMINATOR = new Uint8Array([
  69, 48, 101, 99, 117, 44, 70, 194,
]);

// Anchor discriminator for invoice_registry::lock_payment_intent. Used
// by the shielded batched flow (tx 1 of 3) to acquire a single-use
// `PaymentIntentLock` PDA before the Umbra createBuffer + deposit txs.
// Verified against programs/invoice-registry/target/idl/invoice_registry.json.
const LOCK_PAYMENT_INTENT_DISCRIMINATOR = new Uint8Array([
  96, 172, 233, 81, 188, 200, 139, 94,
]);

// Anchor discriminator for invoice_registry::cancel_payment_intent. Used
// by the dashboard's stuck-lock recovery UI to release a lock when the
// shielded batched flow's tx 2/3 or tx 3/3 fails. Verified against
// programs/invoice-registry/target/idl/invoice_registry.json (added
// 2026-05-06 alongside the batched-signing rollout).
export const CANCEL_PAYMENT_INTENT_DISCRIMINATOR = new Uint8Array([
  179, 158, 125, 231, 73, 7, 32, 95,
]);

// Keccak256 domain separator for AES plaintext, copied verbatim from the
// SDK (index.cjs:8824). Distinguishes receiver-claimable UTXOs created from
// a public-balance source from the other three create-utxo flavours so the
// recipient can route claims correctly.
const AES_DOMAIN_SEPARATOR_PUBLIC_RECEIVER = keccak_256(
  new TextEncoder().encode(
    "UmbraPrivacy / CreateReceiverClaimableUtxoFromPublicBalance",
  ),
).slice(0, 12);

// kmac256 personalization string for `modifiedGenerationIndex` derivation —
// SDK index.cjs:8827. Different from the other three flavors of pay path.
const DOMAIN_MODIFIED_GEN_INDEX_PUBLIC_RECEIVER =
  "PublicBalanceToReceiverClaimableUtxoCreatorFunction / modifiedGenerationIndex";

// Sentinel stealth pool index (the SDK hardcodes 0 at sdk index.cjs:9180).
const STEALTH_POOL_INDEX = 0n;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class VeilPayNotConfiguredError extends Error {
  constructor() {
    super(
      "VEIL_PAY_PROGRAM_ID not configured — falling back to SDK orchestration.",
    );
    this.name = "VeilPayNotConfiguredError";
  }
}

/**
 * Thrown when the lock-acquisition tx (tx 1/3 of the shielded batched
 * flow) fails to land. None of the subsequent createBuffer/deposit txs
 * will be submitted, so callers can treat this as a clean failure with
 * standard retry UX (no stuck on-chain state, no rent locked).
 *
 * Common causes:
 *   - The invoice was paid by someone else first (lock PDA already exists)
 *   - The invoice is restricted to a different payer (NotPayer rejection)
 *   - The invoice has been cancelled or expired (InvalidStatus)
 *   - The user rejected the popup (wallet error propagated)
 */
export class PaymentIntentLockError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    const causeMsg =
      cause instanceof Error ? cause.message : String(cause ?? "unknown");
    super(`Payment intent lock could not be acquired: ${causeMsg}`);
    this.name = "PaymentIntentLockError";
    this.cause = cause;
  }
}

/**
 * Thrown when tx 1/3 (the lock) succeeds but tx 2/3 (createBuffer) or
 * tx 3/3 (deposit) fails. The on-chain effect is that the invoice has
 * an `intent_lock` PDA — preventing further payment attempts — but no
 * actual fund movement happened.
 *
 * The user must call `cancel_payment_intent` to release the lock and
 * recover the rent before retrying. The dashboard's stuck-lock recovery
 * UI exists exactly for this case.
 *
 * The thrown instance carries the lockSig (so the recovery UI can
 * display it for diagnostics) and the original cause from tx2/tx3.
 */
export class StuckLockError extends Error {
  readonly invoicePda: string;
  readonly lockSig: string | null;
  readonly cause: unknown;
  constructor(args: { invoicePda: string; lockSig: string | null; cause: unknown }) {
    const causeMsg =
      args.cause instanceof Error ? args.cause.message : String(args.cause ?? "unknown");
    super(
      `Shielded payment stuck after lock: invoice ${args.invoicePda}, ` +
        `lock confirmed (${args.lockSig ?? "?"}) but proof/deposit failed: ${causeMsg}`,
    );
    this.name = "StuckLockError";
    this.invoicePda = args.invoicePda;
    this.lockSig = args.lockSig;
    this.cause = args.cause;
  }
}

// ---------------------------------------------------------------------------
// Byte / bigint helpers (inlined — SDK keeps these in private chunks)
// ---------------------------------------------------------------------------

function generateRandomU256(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let result = 0n;
  for (let i = 0; i < 32; i++) {
    result |= BigInt(bytes[i]) << BigInt(i * 8);
  }
  return result;
}

function encodeU64ToU64LeBytes(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let remaining = n;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}

function encodeU256ToU256LeBytes(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let remaining = n;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}

function decodeU128LeBytesToU128(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = 0; i < 16; i++) {
    result |= BigInt(bytes[i]) << BigInt(i * 8);
  }
  return result;
}

function splitAddressToLowHigh(address: string): { low: bigint; high: bigint } {
  // Solana addresses are 32 bytes base58-encoded. Split into 16-byte halves
  // so they fit Poseidon's u128 field plaintext.
  const addressBytes = new PublicKey(address).toBytes();
  const low = decodeU128LeBytesToU128(addressBytes.slice(0, 16));
  const high = decodeU128LeBytesToU128(addressBytes.slice(16, 32));
  return { low, high };
}

function bigintToFieldElement(value: bigint): bigint {
  // The SDK passes raw bigints through `toBn254FieldElement` which is just
  // an assertion; the values we feed are derived from primitives (u64, u128
  // address halves, hash outputs already mod p) so they're in-range. No
  // explicit mod needed — the SDK's asserts would already throw.
  return value;
}

interface UtcComponents {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function extractUtcComponents(now: Date): UtcComponents {
  return {
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() + 1,
    day: now.getUTCDate(),
    hour: now.getUTCHours(),
    minute: now.getUTCMinutes(),
    second: now.getUTCSeconds(),
  };
}

// ---------------------------------------------------------------------------
// Codama runtime account → web3.js AccountMeta
// ---------------------------------------------------------------------------

// AccountRole enum values from @solana/instructions:
//   READONLY = 0, WRITABLE = 1, READONLY_SIGNER = 2, WRITABLE_SIGNER = 3
function codamaAccountToWeb3Meta(account: any): Web3AccountMeta {
  const role: number = account.role;
  return {
    pubkey: new PublicKey(String(account.address)),
    isSigner: role === 2 || role === 3,
    isWritable: role === 1 || role === 3,
  };
}

// ---------------------------------------------------------------------------
// Borsh encoding helpers (for veil_pay::pay_invoice arg blobs)
// ---------------------------------------------------------------------------

function encodeBorshVecU8(bytes: Uint8Array): Uint8Array {
  // Borsh: u32 length prefix (little-endian) + payload bytes.
  const out = new Uint8Array(4 + bytes.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, bytes.length, /* littleEndian */ true);
  out.set(bytes, 4);
  return out;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// proxiedAssetProvider — same trick as umbra.ts; route ZK assets through our
// same-origin /umbra-cdn rewrite to dodge CloudFront's missing CORS.
// ---------------------------------------------------------------------------

async function getProxiedAssetProvider() {
  const { getCdnZkAssetProvider } = await import("@umbra-privacy/web-zk-prover");
  return getCdnZkAssetProvider({ baseUrl: "/umbra-cdn" });
}

// ---------------------------------------------------------------------------
// Crypto orchestration — mirror SDK lines 8864-9176
// ---------------------------------------------------------------------------

interface ProofGenerationOutput {
  // Codama input fields (will feed straight into the codama ix builders)
  proofA: Uint8Array;
  proofB: Uint8Array;
  proofC: Uint8Array;
  h2HashBytes: Uint8Array;
  linkerEncryption0Bytes: Uint8Array;
  linkerEncryption1Bytes: Uint8Array;
  keystreamCommitment0Bytes: Uint8Array;
  keystreamCommitment1Bytes: Uint8Array;
  aesEncryptedUtxoData: Uint8Array;
  optionalDataBytes: Uint8Array;
  proofAccountOffset: bigint;
  currentTimestamp: number;
  // For the deposit ix
  protocolFeeConfig: any;
  mintTokenProgram: string;
  stealthPoolAddress: string;
  // For PDA derivation
  receiverUserAccountPda: string;
}

/**
 * Optional overrides that let the caller skip the on-chain receiver
 * fetch in `generateProofAndCommitments`. Used by the single-popup
 * payroll batching flow: the recipient is a freshly-generated shadow
 * account that hasn't been registered yet at the time we build the
 * deposit tx (because we want to BUILD + SIGN before register lands,
 * so we can batch-sign with the fund tx in one Phantom popup).
 *
 * The caller computes these locally from the shadow client's master
 * seed via `deriveShadowRegistrationValues` (in payroll-claim-links.ts),
 * which uses the SDK's own deriver functions — meaning the values
 * will EXACTLY match what register would store on chain. ZK proof
 * verification is fully unaffected.
 *
 * Skipping the fetch costs nothing: the only chain call we still
 * need from this region is the MXE account info (network-level,
 * receiver-independent), which we make on its own.
 */
export interface ProofOverrides {
  receiverX25519PublicKey?: Uint8Array;
  receiverUserCommitment?: bigint;
}

async function generateProofAndCommitments(
  args: PayInvoiceArgs,
  overrides?: ProofOverrides,
): Promise<ProofGenerationOutput> {
  const { client, recipientAddress, mint, amount } = args;

  // The SDK's client object is typed with @solana/kit shapes that we don't
  // import here; access via `as any`. The runtime contract is stable.
  const c: any = client;

  // 1. Random generation index (U256)
  const effectiveGenerationIndex = generateRandomU256();

  // 2. Master seed
  const masterSeed: Uint8Array = await c.masterSeed.getMasterSeed();
  if (!(masterSeed instanceof Uint8Array) || masterSeed.length === 0) {
    throw new Error("Failed to retrieve master seed from client");
  }

  // 3. modifiedGenerationIndex via kmac256(domain, masterSeed,
  //    personalization=genIndexBytes, dkLen=16)
  const generationIndexBytes = new TextEncoder().encode(
    effectiveGenerationIndex.toString(),
  );
  const modifiedGenerationIndex = kmac256(
    new TextEncoder().encode(DOMAIN_MODIFIED_GEN_INDEX_PUBLIC_RECEIVER),
    masterSeed,
    { dkLen: 16, personalization: generationIndexBytes },
  );

  // 4. Proof-account offset (u128)
  const proofAccountOffsetBytes =
    deriveProofAccountOffsetFromModifiedGenerationIndex(modifiedGenerationIndex);
  let proofAccountOffset = 0n;
  for (let i = 0; i < 16; i++) {
    proofAccountOffset |= BigInt(proofAccountOffsetBytes[i]) << BigInt(i * 8);
  }

  // 5. Receiver UserAccount PDA
  const receiverUserAccountPda = String(
    await findEncryptedUserAccountPda(
      recipientAddress as any,
      c.networkConfig.programId,
    ),
  );

  // 6 + 7. Receiver x25519 pub key + userCommitment.
  //
  // Two paths:
  //   - OVERRIDE PATH (single-popup payroll batching): caller passes
  //     locally-derived values via `overrides`. Used when the
  //     recipient is a freshly-generated shadow that hasn't been
  //     registered yet — at deposit-build time we don't have a chain
  //     account to read. The SDK's own derivers produce the same
  //     values register would store, so ZK proof verification is
  //     unaffected. We still need the MXE account info from this
  //     region (network-level, receiver-independent), so fetch that
  //     alone.
  //   - DEFAULT PATH: receiver is already registered on chain. Fetch
  //     receiver account + MXE in one round-trip; decode the values
  //     out of the receiver account.
  let receiverX25519PublicKey: Uint8Array;
  let receiverUserCommitment: bigint;
  if (overrides?.receiverX25519PublicKey && overrides?.receiverUserCommitment !== undefined) {
    receiverX25519PublicKey = overrides.receiverX25519PublicKey;
    receiverUserCommitment = overrides.receiverUserCommitment;
    // Still need the MXE account info, but we don't pre-empt the
    // receiver-account fetch — useful for cache-warming the next
    // call. Single-account fetch is cheap.
    await c.accountInfoProvider(
      [c.networkConfig.mxeAccountAddress],
      { commitment: "confirmed" },
    );
  } else {
    const receiverAccountMap: Map<string, any> = await c.accountInfoProvider(
      [receiverUserAccountPda, c.networkConfig.mxeAccountAddress],
      { commitment: "confirmed" },
    );
    const receiverAccountInfo = receiverAccountMap.get(receiverUserAccountPda);
    if (receiverAccountInfo?.exists !== true) {
      throw new Error(`Receiver is not registered: ${recipientAddress}`);
    }
    const receiverAccount = decodeEncryptedUserAccount(receiverAccountInfo);
    const receiverAccountData = (receiverAccount as any).data;
    const receiverX25519PublicKeyBytes =
      receiverAccountData.x25519PublicKeyForTokenEncryption?.first;
    if (receiverX25519PublicKeyBytes === undefined) {
      throw new Error("Receiver does not have X25519 public key registered");
    }
    receiverX25519PublicKey = new Uint8Array(receiverX25519PublicKeyBytes);

    const receiverUserCommitmentBytes = receiverAccountData.userCommitment?.first;
    if (receiverUserCommitmentBytes === undefined) {
      throw new Error("Receiver does not have user commitment registered");
    }
    const receiverUserCommitmentLeBytes = new Uint8Array(
      receiverUserCommitmentBytes,
    );
    // Decode 32 bytes LE → bigint
    receiverUserCommitment = 0n;
    for (let i = 0; i < 32; i++) {
      receiverUserCommitment |=
        BigInt(receiverUserCommitmentLeBytes[i]) << BigInt(i * 8);
    }
  }

  // 8. Mint program detection.
  //
  // SCOPE NOTE: We assume the SPL Token program. Veil's invoice flow uses
  // devnet USDC (vanilla SPL Token) or wSOL (also SPL). Token-2022 with
  // TransferFee extensions would need extra fee math (SDK index.cjs lines
  // 8929-8943). If we ever expand to fee-bearing mints we'll mirror that
  // branch.
  const mintAccountMap: Map<string, any> = await c.accountInfoProvider([mint], {
    commitment: "confirmed",
  });
  const mintAccount = mintAccountMap.get(mint);
  if (mintAccount?.exists !== true) {
    throw new Error(`Mint account not found: ${mint}`);
  }
  const mintOwner = String(mintAccount.programAddress);
  const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
  let mintTokenProgram: string;
  let actualReceived: bigint;
  if (mintOwner === SPL_TOKEN) {
    mintTokenProgram = SPL_TOKEN;
    actualReceived = amount;
  } else if (mintOwner === TOKEN_2022) {
    // We don't currently expect Token-2022 mints. If/when we hit one we add
    // the extension parser. For now refuse loudly.
    throw new Error(
      `Mint ${mint} uses Token-2022 — payInvoiceCpi does not yet handle ` +
        "transfer fees. Use the SDK fallback path (set NEXT_PUBLIC_USE_VEIL_PAY_CPI=false).",
    );
  } else {
    throw new Error(`Unknown token program for mint ${mint}: ${mintOwner}`);
  }

  // 9. Protocol fee
  const protocolFeeProvider = getHardcodedCreateUtxoProtocolFeeProvider();
  const protocolFeeConfig = await protocolFeeProvider(actualReceived as any);
  const baseFeesInSpl: bigint = protocolFeeConfig.slab.baseFee;
  const commissionFeeInBps: bigint = protocolFeeConfig.slab.bps;
  const amountAfterBaseFeeForBps = actualReceived - baseFeesInSpl;
  const commissionFee = (amountAfterBaseFeeForBps * commissionFeeInBps) / 16384n;
  const totalProtocolFees = baseFeesInSpl + commissionFee;
  const netDepositAmount = actualReceived - totalProtocolFees;
  if (netDepositAmount <= 0n) {
    throw new Error(
      `Net deposit amount is zero or negative after fees ` +
        `(amount=${amount} fees=${totalProtocolFees}).`,
    );
  }

  // 10. Timestamp
  const now = new Date();
  const currentTimestamp = Math.floor(now.getTime() / 1000);
  const { year, month, day, hour, minute, second } = extractUtcComponents(now);

  // 11. Second viewing key (per-tx)
  const secondViewingKeyGenerator = getSecondViewingKeyDeriver({
    client: c,
  } as any);
  // Umbra's BN254 field-element check rejects raw `number` — every
  // timestamp component must be coerced to `bigint` before any SDK helper
  // touches it (assertBn254FieldElement throws "Expected bigint, got number").
  const transactionViewingKey = (await secondViewingKeyGenerator(
    mint as any,
    BigInt(year) as any,
    BigInt(month) as any,
    BigInt(day) as any,
    BigInt(hour) as any,
    BigInt(minute) as any,
    BigInt(second) as any,
  )) as bigint;

  // 12. Split destination address
  const { low: destinationAddressLow, high: destinationAddressHigh } =
    splitAddressToLowHigh(recipientAddress);

  // 13. Sender commitment building blocks
  const masterViewingKeyGenerator = getMasterViewingKeyDeriver({
    client: c,
  } as any);
  const senderMasterViewingKey = (await masterViewingKeyGenerator()) as bigint;
  const masterViewingKeyBlindingFactorGenerator =
    getMasterViewingKeyBlindingFactorDeriver({ client: c } as any);
  const senderMvkBlindingFactor =
    (await masterViewingKeyBlindingFactorGenerator()) as bigint;
  const poseidonPrivateKeyGenerator = getPoseidonPrivateKeyDeriver({
    client: c,
  } as any);
  const senderPrivateKey = (await poseidonPrivateKeyGenerator()) as bigint;
  const poseidonBlindingFactorGenerator = getPoseidonBlindingFactorDeriver({
    client: c,
  } as any);
  const senderPrivateKeyBlindingFactor =
    (await poseidonBlindingFactorGenerator()) as bigint;

  const userCommitmentGenerator = getUserCommitmentGeneratorFunction();
  const senderUserCommitment = (await userCommitmentGenerator(
    senderMasterViewingKey as any,
    senderMvkBlindingFactor as any,
    senderPrivateKey as any,
    senderPrivateKeyBlindingFactor as any,
  )) as bigint;

  // 14. Per-tx random secret + nullifier from modifiedGenerationIndex
  const randomSecret = deriveRandomSecretFromModifiedGenerationIndex(
    modifiedGenerationIndex,
  ) as bigint;
  const nullifier = deriveNullifierFromModifiedGenerationIndex(
    modifiedGenerationIndex,
  ) as bigint;

  // 15. h2 hash
  const h2Generator = getUtxoCommitmentHashGenerator();
  const h2Hash = (await h2Generator.generateH2({
    amount: bigintToFieldElement(netDepositAmount),
    nullifier,
    userCommitment: receiverUserCommitment,
    finalDestinationAddressLow: bigintToFieldElement(destinationAddressLow),
    finalDestinationAddressHigh: bigintToFieldElement(destinationAddressHigh),
    h2BlindingFactor: randomSecret,
  } as any)) as bigint;

  // 16. Poseidon-encrypt the destination address (low + high) with the
  //     transaction viewing key
  const poseidonEncryptor = getPoseidonEncryptor();
  const pcCiphertexts = (await poseidonEncryptor(
    [destinationAddressLow, destinationAddressHigh] as any,
    transactionViewingKey as any,
  )) as bigint[];
  if (pcCiphertexts.length !== 2) {
    throw new Error(`Expected 2 ciphertexts, got ${pcCiphertexts.length}`);
  }
  const pcEncryptedDestinationAddressLow = pcCiphertexts[0];
  const pcEncryptedDestinationAddressHigh = pcCiphertexts[1];

  // 17. Poseidon keystream + commitments
  const poseidonKeystreamGenerator = getPoseidonKeystreamGenerator();
  const pcKeystreams: Map<bigint, bigint> = (await poseidonKeystreamGenerator(
    [0n, 1n] as any,
    transactionViewingKey as any,
  )) as any;
  const pcKeyForLow = pcKeystreams.get(0n);
  const pcKeyForHigh = pcKeystreams.get(1n);
  if (pcKeyForLow === undefined || pcKeyForHigh === undefined) {
    throw new Error("Missing keystream entry");
  }
  const poseidonKeystreamBlindingFactorGenerator =
    getPoseidonKeystreamBlindingFactorDeriver({ client: c } as any);
  const firstKeystreamBlindingFactor =
    (await poseidonKeystreamBlindingFactorGenerator(
      pcKeyForLow as any,
      0n as any,
    )) as bigint;
  const secondKeystreamBlindingFactor =
    (await poseidonKeystreamBlindingFactorGenerator(
      pcKeyForHigh as any,
      1n as any,
    )) as bigint;
  const keystreamCommitmentGenerator = getKeystreamCommitmentGenerator();
  const firstPcKeystreamCommitment = (await keystreamCommitmentGenerator(
    pcKeyForLow as any,
    firstKeystreamBlindingFactor as any,
  )) as bigint;
  const secondPcKeystreamCommitment = (await keystreamCommitmentGenerator(
    pcKeyForHigh as any,
    secondKeystreamBlindingFactor as any,
  )) as bigint;

  // 18. ECDH(client_priv, receiver_pub) → AES key
  const userAccountX25519KeypairDeriver = getUserAccountX25519KeypairDeriver({
    client: c,
  } as any);
  const keypairResult = (await userAccountX25519KeypairDeriver()) as any;
  const clientX25519PrivateKey = new Uint8Array(
    keypairResult.x25519Keypair.privateKey,
  );
  const aesSharedSecret = x25519.getSharedSecret(
    clientX25519PrivateKey,
    receiverX25519PublicKey,
  );
  const aesEncryptionKeyBytes = keccak_256(aesSharedSecret).slice(0, 32);

  // 19. AES plaintext (68 bytes): amount(8) || destAddr(32) ||
  //     modifiedGenIdx(16) || domainSep(12)
  const destinationAddressBytes = new PublicKey(recipientAddress).toBytes();
  const aesPlaintextData = new Uint8Array(68);
  aesPlaintextData.set(encodeU64ToU64LeBytes(netDepositAmount), 0);
  aesPlaintextData.set(destinationAddressBytes, 8);
  aesPlaintextData.set(modifiedGenerationIndex, 40);
  aesPlaintextData.set(AES_DOMAIN_SEPARATOR_PUBLIC_RECEIVER, 56);
  const aesEncryptor = getAesEncryptor();
  const aesEncryptedUtxoData = (await aesEncryptor(
    aesEncryptionKeyBytes as any,
    aesPlaintextData as any,
  )) as Uint8Array;

  // 20. optionalData (32 zeros — Veil doesn't carry side-channel data
  //     through; per design 2026-04-16 addendum, invoice linkage happens
  //     off-chain at claim time)
  const optionalDataBytes = new Uint8Array(32);

  // 21. Aggregator hash for prover public input
  const { low: mintAddressLow, high: mintAddressHigh } =
    splitAddressToLowHigh(mint);
  const poseidonAggregator = getPoseidonAggregator();
  const aggregatedHashInputs = [
    bigintToFieldElement(mintAddressLow),
    bigintToFieldElement(mintAddressHigh),
    bigintToFieldElement(netDepositAmount),
    bigintToFieldElement(BigInt(year)),
    bigintToFieldElement(BigInt(month)),
    bigintToFieldElement(BigInt(day)),
    bigintToFieldElement(BigInt(hour)),
    bigintToFieldElement(BigInt(minute)),
    bigintToFieldElement(BigInt(second)),
    h2Hash,
    senderUserCommitment,
    bigintToFieldElement(pcEncryptedDestinationAddressLow),
    bigintToFieldElement(pcEncryptedDestinationAddressHigh),
    firstPcKeystreamCommitment,
    secondPcKeystreamCommitment,
    bigintToFieldElement(protocolFeeConfig.merkleRoot),
  ];
  const aggregatedPublicInputHash = (await poseidonAggregator(
    aggregatedHashInputs as any,
  )) as bigint;

  // 22. Modular inverses (8 of them). The SDK's computeBn254ModularInverse
  // wants its arg branded as Bn254FieldElement; we feed plain bigints —
  // they're already in the field by construction (all derived via
  // SDK-internal field-mod ops, hash outputs, or u128/u64 values which are
  // trivially under p). The cast is purely a TS escape hatch.
  const modInv = computeBn254ModularInverse as unknown as (x: bigint) => bigint;
  const inverseForSenderMvkBlindingFactor = modInv(senderMvkBlindingFactor);
  const inverseForSenderPrivateKeyBlindingFactor = modInv(
    senderPrivateKeyBlindingFactor,
  );
  const inverseForSenderPrivateKey = modInv(senderPrivateKey);
  const inverseForSenderMasterViewingKey = modInv(senderMasterViewingKey);
  const inverseForAmount = modInv(bigintToFieldElement(netDepositAmount));
  const inverseForNullifier = modInv(nullifier);
  const inverseForH2BlindingFactor = modInv(randomSecret);
  const inverseForFirstKeystreamBlindingFactor = modInv(
    firstKeystreamBlindingFactor,
  );
  const inverseForSecondKeystreamBlindingFactor = modInv(
    secondKeystreamBlindingFactor,
  );

  // 23. ZK circuit inputs
  const zkCircuitInputs = {
    senderPrivateKey,
    senderMasterViewingKey,
    senderMvkBlindingFactor,
    inverseForSenderMvkBlindingFactor,
    senderPrivateKeyBlindingFactor,
    inverseForSenderPrivateKeyBlindingFactor,
    inverseForSenderPrivateKey,
    inverseForSenderMasterViewingKey,
    amount: bigintToFieldElement(netDepositAmount),
    inverseForAmount,
    nullifier,
    inverseForNullifier,
    unlockingUserCommitment: receiverUserCommitment,
    h2BlindingFactor: randomSecret,
    inverseForH2BlindingFactor,
    year: bigintToFieldElement(BigInt(year)),
    month: bigintToFieldElement(BigInt(month)),
    day: bigintToFieldElement(BigInt(day)),
    hour: bigintToFieldElement(BigInt(hour)),
    minute: bigintToFieldElement(BigInt(minute)),
    second: bigintToFieldElement(BigInt(second)),
    mintAddressLow: bigintToFieldElement(mintAddressLow),
    mintAddressHigh: bigintToFieldElement(mintAddressHigh),
    finalDestinationAddressLow: bigintToFieldElement(destinationAddressLow),
    finalDestinationAddressHigh: bigintToFieldElement(destinationAddressHigh),
    keystreamBlindingFactor: [
      firstKeystreamBlindingFactor,
      secondKeystreamBlindingFactor,
    ],
    inverseForKeystreamBlindingFactor: [
      inverseForFirstKeystreamBlindingFactor,
      inverseForSecondKeystreamBlindingFactor,
    ],
    protocolFeesRoot: bigintToFieldElement(protocolFeeConfig.merkleRoot),
    publicAggregatedHash: aggregatedPublicInputHash,
  };

  // 24. Prove
  // Mount the IndexedDB-backed asset cache alongside the CDN provider —
  // first run on a device downloads the ~30 MB zkey, every subsequent
  // session reads it from IDB instantly. See lib/zk-asset-cache.ts.
  const assetProvider = await getProxiedAssetProvider();
  const { zkAssetCache } = await import("./zk-asset-cache");
  const zkProver = getCreateReceiverClaimableUtxoFromPublicBalanceProver({
    assetProvider,
    ...zkAssetCache,
  });
  const { proofA, proofB, proofC } = await zkProver.prove(
    zkCircuitInputs as any,
  );

  // 25. Stealth pool PDA
  const stealthPoolAddress = String(
    await findStealthPoolPda(
      STEALTH_POOL_INDEX as any,
      c.networkConfig.programId,
    ),
  );

  // 26. Encode commitment + linker bytes for ix args (32 bytes LE each)
  const h2HashBytes = encodeU256ToU256LeBytes(h2Hash);
  const linkerEncryption0Bytes = encodeU256ToU256LeBytes(
    pcEncryptedDestinationAddressLow,
  );
  const linkerEncryption1Bytes = encodeU256ToU256LeBytes(
    pcEncryptedDestinationAddressHigh,
  );
  const keystreamCommitment0Bytes = encodeU256ToU256LeBytes(
    firstPcKeystreamCommitment,
  );
  const keystreamCommitment1Bytes = encodeU256ToU256LeBytes(
    secondPcKeystreamCommitment,
  );

  return {
    proofA,
    proofB,
    proofC,
    h2HashBytes,
    linkerEncryption0Bytes,
    linkerEncryption1Bytes,
    keystreamCommitment0Bytes,
    keystreamCommitment1Bytes,
    aesEncryptedUtxoData,
    optionalDataBytes,
    proofAccountOffset,
    currentTimestamp,
    protocolFeeConfig,
    mintTokenProgram,
    stealthPoolAddress,
    receiverUserAccountPda,
  };
}

// ---------------------------------------------------------------------------
// Build the codama instructions (without submitting them)
// ---------------------------------------------------------------------------

interface CodamaInstructions {
  createBufferIx: any;
  depositIx: any;
}

async function buildCodamaInstructions(
  args: PayInvoiceArgs,
  proof: ProofGenerationOutput,
): Promise<CodamaInstructions> {
  // Lazy-load codama; keeps the module out of the SSR bundle.
  const codama: any = await import("@umbra-privacy/umbra-codama");
  // Lazy-load createNoopSigner from kit (codama's nested kit). Codama
  // expects a kit-flavored signer interface for any account marked as
  // signer in its IDL; createNoopSigner just provides the address with no
  // actual signing capability — perfect because WE sign the outer tx, not
  // these inner ix builders.
  const kit: any = await import("@solana/kit");

  const c: any = args.client;
  const depositorAddress: any = c.signer.address;
  const noopDepositor = kit.createNoopSigner(depositorAddress);

  const createBufferIx = await codama.getCreatePublicStealthPoolDepositInputBufferInstructionAsync(
    {
      depositor: noopDepositor,
      feePayer: noopDepositor,
      offset: { first: proof.proofAccountOffset },
      insertionH2Commitment: { first: proof.h2HashBytes },
      insertionTimestamp: { first: BigInt(proof.currentTimestamp) },
      linkerEncryption0: { first: proof.linkerEncryption0Bytes },
      linkerEncryption1: { first: proof.linkerEncryption1Bytes },
      keystreamCommitment0: { first: proof.keystreamCommitment0Bytes },
      keystreamCommitment1: { first: proof.keystreamCommitment1Bytes },
      groth16ProofA: { first: proof.proofA },
      groth16ProofB: { first: proof.proofB },
      groth16ProofC: { first: proof.proofC },
      aesEncryptedData: { first: proof.aesEncryptedUtxoData },
      optionalData: { first: proof.optionalDataBytes },
    },
    { programAddress: c.networkConfig.programId },
  );

  const depositIx = await codama.getDepositIntoStealthPoolFromPublicBalanceInstructionAsync(
    {
      feePayer: noopDepositor,
      depositor: noopDepositor,
      stealthPool: proof.stealthPoolAddress,
      mint: args.mint,
      tokenProgram: proof.mintTokenProgram,
      feeVaultOffset: { first: 0n },
      publicStealthPoolDepositInputBufferOffset: {
        first: proof.proofAccountOffset,
      },
      ...feeSlabResultToInstructionFields(proof.protocolFeeConfig),
      transferAmount: { first: args.amount },
    },
    { programAddress: c.networkConfig.programId },
  );

  return { createBufferIx, depositIx };
}

// ---------------------------------------------------------------------------
// Compose the single VeilPay tx
// ---------------------------------------------------------------------------

function buildVeilPayInstruction(
  createBufferIx: any,
  depositIx: any,
  depositor: PublicKey,
  invoicePda?: PublicKey,
): TransactionInstruction {
  // Serialize args. Same shape for both pay_invoice and pay_no_invoice:
  //   create_buffer_data: Vec<u8>      (codama's full ix.data, incl. discriminator)
  //   deposit_data: Vec<u8>            (same)
  //   create_buffer_account_count: u8  (split point inside remaining_accounts)
  const createBufferData: Uint8Array = createBufferIx.data;
  const depositData: Uint8Array = depositIx.data;
  const createBufferAccountCount = createBufferIx.accounts.length;
  if (createBufferAccountCount > 255) {
    throw new Error(
      `Codama buffer ix produced ${createBufferAccountCount} accounts — exceeds u8 limit`,
    );
  }

  // Route by whether we're paying an invoice (Fix 2 lock-bound) or doing
  // an invoice-less payroll deposit (no lock).
  const isInvoicePay = invoicePda !== undefined;
  const discriminator = isInvoicePay
    ? PAY_INVOICE_DISCRIMINATOR
    : PAY_NO_INVOICE_DISCRIMINATOR;

  const data = concatBytes(
    discriminator,
    encodeBorshVecU8(createBufferData),
    encodeBorshVecU8(depositData),
    new Uint8Array([createBufferAccountCount]),
  );

  // Account list — must match the corresponding Rust `Accounts` struct
  // order. Two shapes:
  //
  // pay_invoice (PayInvoice):
  //   #0 depositor                  (signer, writable — pays lock rent)
  //   #1 invoice                    (read-only)
  //   #2 lock                       (writable — init'd inside CPI)
  //   #3 invoice_registry_program   (read-only — CPI program id)
  //   #4 system_program             (read-only — required by `init`)
  //   #5 umbra_program              (read-only — CPI program id for Umbra)
  //   #6..N remaining_accounts
  //
  // pay_no_invoice (PayNoInvoice):
  //   #0 depositor                  (signer, NOT writable)
  //   #1 umbra_program              (read-only)
  //   #2..N remaining_accounts
  //
  // The depositor signature on the outer tx propagates through CPI to all
  // inner calls automatically.
  const keys: Web3AccountMeta[] = isInvoicePay
    ? [
        { pubkey: depositor, isSigner: true, isWritable: true },
        { pubkey: invoicePda!, isSigner: false, isWritable: false },
        { pubkey: deriveLockPda(invoicePda!), isSigner: false, isWritable: true },
        { pubkey: INVOICE_REGISTRY_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: UMBRA_PROGRAM_ID, isSigner: false, isWritable: false },
        ...createBufferIx.accounts.map(codamaAccountToWeb3Meta),
        ...depositIx.accounts.map(codamaAccountToWeb3Meta),
      ]
    : [
        { pubkey: depositor, isSigner: true, isWritable: true },
        { pubkey: UMBRA_PROGRAM_ID, isSigner: false, isWritable: false },
        ...createBufferIx.accounts.map(codamaAccountToWeb3Meta),
        ...depositIx.accounts.map(codamaAccountToWeb3Meta),
      ];

  if (!VEIL_PAY_PROGRAM_ID) {
    // Should be unreachable — payInvoiceCpi guards with VeilPayNotConfiguredError.
    throw new VeilPayNotConfiguredError();
  }
  return new TransactionInstruction({
    programId: VEIL_PAY_PROGRAM_ID,
    keys,
    data: Buffer.from(data),
  });
}

/**
 * Derive the PaymentIntentLock PDA for an invoice. Mirrors the Rust
 * derive seeds at `programs/invoice-registry/.../lib.rs::LockPaymentIntent`.
 */
function deriveLockPda(invoicePda: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("intent_lock"), invoicePda.toBuffer()],
    INVOICE_REGISTRY_PROGRAM_ID,
  );
  return pda;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Output of `buildPayInvoiceCpiTx` — the unsigned VersionedTransaction
 * along with the metadata `submitSignedPayInvoiceCpiTx` needs to confirm
 * the result. Used by the batched-signing flow in PayrollFlow's run()
 * so multiple deposit txs across rows can be signed in ONE Phantom
 * popup via `wallet.signAllTransactions`.
 *
 * `cached` carries the heavy build artifacts (ZK proof + codama
 * instruction + ALT) so `refreshPayInvoiceCpiTxBlockhash` can rebuild
 * the tx with a new blockhash WITHOUT redoing the ~10-20s ZK proof.
 * This is what powers the cold-cache fallback: when a pre-signed
 * deposit fails post-register-wait with "Blockhash not found", we
 * refresh just the blockhash and re-sign in a single fallback popup.
 */
export interface BuiltPayInvoiceCpiTx {
  /** Unsigned versioned tx — caller signs via wallet.signAllTransactions. */
  tx: VersionedTransaction;
  /** Re-derive the same blockhash for the confirm call. Empty string
   *  when nonce-anchored — confirm uses signature polling instead. */
  blockhash: string;
  lastValidBlockHeight: number;
  depositorAddress: string;
  /** Set when this tx is anchored to a durable nonce instead of a
   *  recent blockhash. Submission uses signature polling (no
   *  blockhash window concern) and refresh becomes a no-op (nonce
   *  doesn't expire). */
  nonceConfig?: NonceConfig;
  /** Cached blockhash-independent components for fast refresh. */
  cached: {
    veilPayIx: TransactionInstruction;
    altAccounts: AddressLookupTableAccount[];
    depositorPubkey: PublicKey;
  };
}

/**
 * Build (but don't sign or submit) a single VeilPay deposit tx. The
 * caller is expected to:
 *   1. Collect N of these from N rows.
 *   2. Pass `[t1.tx, t2.tx, ...]` to `wallet.signAllTransactions(...)` —
 *      Phantom shows ONE popup with all N txs, user approves once.
 *   3. For each signed tx, call `submitSignedPayInvoiceCpiTx`.
 *
 * The same heavy ZK-proof + codama instruction-building work happens
 * here as in `payInvoiceCpi`; only the final signing + submission
 * stages are deferred so they can be batched.
 */
/**
 * Optional durable-nonce config that anchors the tx's blockhash to a
 * nonce account instead of a regular recent blockhash. Used by the
 * single-popup payroll batching flow: deposit txs are signed at t=0
 * but submitted only after register completes (which can take 90s+
 * on cold cache, exceeding the regular blockhash window). A nonce
 * doesn't expire — the tx stays valid until submitted (which advances
 * the nonce as a side-effect).
 *
 * When `nonceConfig` is provided:
 *   - `nonce.nonce` is used as the tx's `recentBlockhash`.
 *   - `SystemProgram.nonceAdvance` is prepended as the FIRST
 *     instruction (Solana protocol requirement).
 *   - The fresh blockhash fetch is skipped.
 *
 * `nonceConfig.lastValidBlockHeight` is opaque (we don't use it for
 * confirmation) but kept in the return for symmetry with the
 * regular-blockhash path.
 */
export interface NonceConfig {
  noncePubkey: PublicKey;
  authorityPubkey: PublicKey;
  /** Current nonce value, used as the tx's recentBlockhash. */
  nonce: string;
  /** ALT containing the nonce account + sysvar `recent_blockhashes`.
   *  When provided, fetched + merged with VeilPay's existing ALT so
   *  both new accounts resolve via lookup-table indices instead of
   *  inflating the static account list. Required because adding the
   *  `nonceAdvance` instruction otherwise pushes the deposit tx
   *  ~47 bytes over the 1232-byte cap. */
  altAddress?: PublicKey;
}

export async function buildPayInvoiceCpiTx(
  args: PayInvoiceArgs,
  overrides?: ProofOverrides,
  nonceConfig?: NonceConfig,
): Promise<BuiltPayInvoiceCpiTx> {
  if (!VEIL_PAY_PROGRAM_ID) throw new VeilPayNotConfiguredError();

  const c: any = args.client;
  const depositorAddress: string = String(c.signer.address);
  const depositorPubkey = new PublicKey(depositorAddress);

  // 1. Crypto + ZK proof (heavy; takes a few seconds in the browser).
  //    `overrides` allows the caller to supply locally-derived
  //    receiver values when the receiver isn't yet registered on
  //    chain — see ProofOverrides docstring.
  const proofOutput = await generateProofAndCommitments(args, overrides);

  // 2. Build the two Umbra instructions via codama (no submission)
  const { createBufferIx, depositIx } = await buildCodamaInstructions(
    args,
    proofOutput,
  );

  // 3. Wrap both in our single VeilPay instruction. Routes to
  //    pay_invoice (lock-bound) when an invoicePda is supplied, otherwise
  //    pay_no_invoice (payroll path; no lock).
  const veilPayIx = buildVeilPayInstruction(
    createBufferIx,
    depositIx,
    depositorPubkey,
    args.invoicePda,
  );

  const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 1_250_000,
  });

  const connection = new Connection(RPC_URL, "confirmed");

  // Two paths for the tx's recentBlockhash:
  //   - DURABLE NONCE PATH (nonceConfig provided): use the nonce
  //     account's current nonce value as the blockhash; prepend
  //     `system_instruction::advance_nonce_account` as the FIRST
  //     instruction. The tx never expires — Solana keeps it valid
  //     until the nonce is consumed at execution time. Used by
  //     the single-popup payroll flow so deposits signed at t=0
  //     stay valid through the ~15-90s register wait.
  //   - REGULAR BLOCKHASH PATH (default): fetch a recent blockhash.
  //     The tx is valid for ~150 slots (~60s). Adequate when sign
  //     and submit happen within seconds of each other.
  let blockhash: string;
  let lastValidBlockHeight: number;
  if (nonceConfig) {
    blockhash = nonceConfig.nonce;
    // We don't use lastValidBlockHeight for confirmation when nonce
    // is in play (signature-status polling instead). Set to a safe
    // placeholder so the type stays uniform.
    lastValidBlockHeight = 0;
  } else {
    const latest = await connection.getLatestBlockhash("confirmed");
    blockhash = latest.blockhash;
    lastValidBlockHeight = latest.lastValidBlockHeight;
  }

  let altAccounts: AddressLookupTableAccount[] = [];
  if (VEILPAY_ALT_ADDRESS) {
    const altResult = await connection.getAddressLookupTable(
      VEILPAY_ALT_ADDRESS,
    );
    if (altResult.value) {
      altAccounts = [altResult.value];
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `[VeilPay] ALT ${VEILPAY_ALT_ADDRESS.toBase58()} not fetchable — falling back to inline accounts. Tx will likely exceed 1232b.`,
      );
    }
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      "[VeilPay] NEXT_PUBLIC_VEILPAY_ALT_ADDRESS not set — tx will likely exceed 1232b. Run `cd app && node scripts/deploy-veilpay-alt.mjs`.",
    );
  }

  // Per-wallet nonce ALT — fetched and appended to altAccounts so the
  // nonce account + sysvar `recent_blockhashes` resolve via lookup-table
  // indices. Without this, the `nonceAdvance` instruction's two new
  // accounts inflate the deposit tx by ~64 bytes and push it over the
  // 1232-byte cap. The ALT is created lazily by `lib/nonce-pool.ts`'s
  // `getOrAllocateNonces` and persisted per-wallet.
  if (nonceConfig?.altAddress) {
    const nonceAltResult = await connection.getAddressLookupTable(
      nonceConfig.altAddress,
    );
    if (nonceAltResult.value) {
      altAccounts = [...altAccounts, nonceAltResult.value];
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `[VeilPay] nonce ALT ${nonceConfig.altAddress.toBase58()} not fetchable — tx will likely exceed 1232b.`,
      );
    }
  }

  // The instruction list: when using a durable nonce, advance_nonce_account
  // MUST be the first instruction (Solana runtime requirement).
  const txInstructions = nonceConfig
    ? [
        // Lazy import to keep the SystemProgram dep contained at this
        // call site only when nonces are in play.
        (await import("@solana/web3.js")).SystemProgram.nonceAdvance({
          noncePubkey: nonceConfig.noncePubkey,
          authorizedPubkey: nonceConfig.authorityPubkey,
        }),
        computeBudgetIx,
        veilPayIx,
      ]
    : [computeBudgetIx, veilPayIx];

  const messageV0 = new TransactionMessage({
    payerKey: depositorPubkey,
    recentBlockhash: blockhash,
    instructions: txInstructions,
  }).compileToV0Message(altAccounts);
  const tx = new VersionedTransaction(messageV0);

  if (process.env.NEXT_PUBLIC_VEIL_DEBUG === "1") {
    const messageBytes = messageV0.serialize();
    // eslint-disable-next-line no-console
    console.log("[VeilPay tx-size]", {
      serializedMessageBytes: messageBytes.length,
      estSignedTxBytes: messageBytes.length + 65,
      underCap1232: messageBytes.length + 65 <= 1232,
      accountKeys: messageV0.staticAccountKeys.length,
      altCount: altAccounts.length,
      altWritable: messageV0.addressTableLookups.reduce(
        (n, l) => n + l.writableIndexes.length,
        0,
      ),
      altReadonly: messageV0.addressTableLookups.reduce(
        (n, l) => n + l.readonlyIndexes.length,
        0,
      ),
      instructions: messageV0.compiledInstructions.length,
      veilPayIxDataBytes: veilPayIx.data.length,
      veilPayIxAccountCount: veilPayIx.keys.length,
      createBufferDataBytes: createBufferIx.data.length,
      depositDataBytes: depositIx.data.length,
      createBufferAccountCount: createBufferIx.accounts.length,
      depositAccountCount: depositIx.accounts.length,
    });
  }

  return {
    tx,
    blockhash,
    lastValidBlockHeight,
    depositorAddress,
    nonceConfig,
    cached: { veilPayIx, altAccounts, depositorPubkey },
  };
}

/**
 * Rebuild the deposit tx with a fresh blockhash, reusing the cached
 * (blockhash-independent) ZK proof + codama instructions + ALT from
 * the original build. Used as the cold-cache fallback when a
 * pre-signed deposit fails with "Blockhash not found": the gap
 * between sign-time and submit-time exceeded the ~60s blockhash
 * window. ZK proof regeneration is the slow part (~10-20s); a fresh
 * blockhash takes <1s.
 *
 * The returned `BuiltPayInvoiceCpiTx` shares its `cached` artifacts
 * with the input. The caller signs the new `tx` via
 * `wallet.signAllTransactions` and submits via
 * `submitSignedPayInvoiceCpiTx`.
 */
export async function refreshPayInvoiceCpiTxBlockhash(
  built: BuiltPayInvoiceCpiTx,
): Promise<BuiltPayInvoiceCpiTx> {
  // Nonce-anchored txs never expire; refresh is a no-op (the same
  // signed tx remains valid indefinitely until the nonce is consumed).
  // Defensive return so callers don't have to special-case.
  if (built.nonceConfig) return built;

  const connection = new Connection(RPC_URL, "confirmed");
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 1_250_000,
  });
  const messageV0 = new TransactionMessage({
    payerKey: built.cached.depositorPubkey,
    recentBlockhash: blockhash,
    instructions: [computeBudgetIx, built.cached.veilPayIx],
  }).compileToV0Message(built.cached.altAccounts);
  return {
    tx: new VersionedTransaction(messageV0),
    blockhash,
    lastValidBlockHeight,
    depositorAddress: built.depositorAddress,
    cached: built.cached,
  };
}

/**
 * Submit a previously-batch-signed VeilPay deposit tx and confirm it.
 *
 * Two confirmation modes:
 *   - Regular blockhash (built.nonceConfig undefined): blockhash +
 *     lastValidBlockHeight feed `confirmTransaction`'s
 *     blockheight-based timeout. Tx valid for ~150 slots.
 *   - Durable nonce (built.nonceConfig present): the tx stays valid
 *     until its nonce is consumed at execution. We use signature-
 *     status polling instead of blockhash-based confirm.
 */
export async function submitSignedPayInvoiceCpiTx(args: {
  signedTx: VersionedTransaction;
  built: BuiltPayInvoiceCpiTx;
}): Promise<PayInvoiceResult> {
  const connection = new Connection(RPC_URL, "confirmed");
  const txSignature = await connection.sendTransaction(args.signedTx, {
    skipPreflight: false,
    maxRetries: 3,
  });
  if (args.built.nonceConfig) {
    // Nonce-anchored: poll signature status until "confirmed" or a
    // generous timeout (60s — Arcium MPC can extend confirmation
    // tail latency on devnet).
    const deadlineMs = Date.now() + 60_000;
    while (Date.now() < deadlineMs) {
      const statuses = await connection.getSignatureStatuses([txSignature]);
      const s = statuses.value[0];
      if (s?.err) {
        throw new Error(
          `Tx ${txSignature} failed: ${JSON.stringify(s.err)}`,
        );
      }
      if (
        s?.confirmationStatus === "confirmed" ||
        s?.confirmationStatus === "finalized"
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  } else {
    await connection.confirmTransaction(
      {
        signature: txSignature,
        blockhash: args.built.blockhash,
        lastValidBlockHeight: args.built.lastValidBlockHeight,
      },
      "confirmed",
    );
  }
  return {
    createProofAccountSignature: txSignature,
    createUtxoSignature: txSignature,
  };
}

export async function payInvoiceCpi(
  args: PayInvoiceArgs,
): Promise<PayInvoiceResult> {
  if (!VEIL_PAY_PROGRAM_ID) throw new VeilPayNotConfiguredError();

  const c: any = args.client;
  const depositorAddress: string = String(c.signer.address);
  const depositorPubkey = new PublicKey(depositorAddress);

  // 1. Crypto + ZK proof (heavy; takes a few seconds in the browser)
  const proofOutput = await generateProofAndCommitments(args);

  // 2. Build the two Umbra instructions via codama (no submission)
  const { createBufferIx, depositIx } = await buildCodamaInstructions(
    args,
    proofOutput,
  );

  // 3. Wrap both in our single VeilPay instruction. The pay-invoice path
  //    requires an invoicePda so the on-chain CPI into
  //    invoice-registry::lock_payment_intent can derive its lock account —
  //    enforces the double-pay guard at the program level.
  if (!args.invoicePda) {
    throw new Error(
      "payInvoiceCpi: args.invoicePda is required (Fix 2 — single-popup pay binds to an Invoice account). " +
        "If you're paying outside an invoice (payroll), use buildPayInvoiceCpiTx instead.",
    );
  }
  const veilPayIx = buildVeilPayInstruction(
    createBufferIx,
    depositIx,
    depositorPubkey,
    args.invoicePda,
  );

  // 4. Compute budget tuned to actual measured usage. The deposit verifier
  //    alone runs ~1.2M CU; CPI overhead pushes that to ~1.25M. We use 1.25M
  //    (the actual ceiling of measured usage + a small margin) instead of
  //    Solana's 1.4M per-tx cap because the smaller value is more honest.
  //
  //    Note on Phantom: we initially hoped reducing this from 1.4M to 1.25M
  //    might help Phantom's Blowfish-powered simulator (which is known to
  //    cap simulated CU). It did not — Phantom still shows "Failed to
  //    simulate the results of this request." The actual root cause is
  //    Blowfish's devnet pipeline + unknown-program allowlist gap, which
  //    rejects simulation BEFORE CU is evaluated. There's no dApp-side fix.
  //    Solflare uses raw RPC simulateTransaction and previews correctly.
  //    On mainnet, once VeilPay + Umbra are added to Blowfish's allowlist,
  //    Phantom's UX will match Solflare's.
  //    Source: docs/superpowers/notes/2026-05-03-phantom-blowfish-simulator.md
  const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 1_250_000,
  });

  // 5. Compile a v0 message via @solana/web3.js
  const connection = new Connection(RPC_URL, "confirmed");
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  // 5a. Fetch the ALT (if configured). The VeilPay tx is ~250 bytes over
  //     the 1232-byte cap with all account keys inline; ALT-substitution
  //     drops 13 keys to 1-byte indices, saving ~360-380 bytes net.
  //     If the ALT isn't configured we still try to compile — useful for
  //     local diagnosis even though the resulting tx will fail at
  //     serialize-time with "encoding overruns Uint8Array".
  let altAccounts: AddressLookupTableAccount[] = [];
  if (VEILPAY_ALT_ADDRESS) {
    const altResult = await connection.getAddressLookupTable(
      VEILPAY_ALT_ADDRESS,
    );
    if (altResult.value) {
      altAccounts = [altResult.value];
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `[VeilPay] ALT ${VEILPAY_ALT_ADDRESS.toBase58()} not fetchable — falling back to inline accounts. Tx will likely exceed 1232b.`,
      );
    }
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      "[VeilPay] NEXT_PUBLIC_VEILPAY_ALT_ADDRESS not set — tx will likely exceed 1232b. Run `cd app && node scripts/deploy-veilpay-alt.mjs`.",
    );
  }

  const messageV0 = new TransactionMessage({
    payerKey: depositorPubkey,
    recentBlockhash: blockhash,
    instructions: [computeBudgetIx, veilPayIx],
  }).compileToV0Message(altAccounts);
  const tx = new VersionedTransaction(messageV0);

  // 6. Sign once via the SDK client's signer (which routes to our wrapped
  //    Wallet Standard signer in umbra.ts — that's where the popup logging
  //    happens, so we'll see exactly one [Veil popup #1]).
  //
  //    The SDK signer's signTransaction expects a kit-style transaction
  //    object shaped { messageBytes, signatures }. Build that shape from
  //    our VersionedTransaction's serialized message.
  const messageBytes = messageV0.serialize();
  // DIAGNOSTIC — print sizes so we can tell at a glance whether ALT
  // substitution landed us under the 1232-byte cap. messageBytes.length is
  // the post-ALT serialized message; signed tx adds 1 byte (sig count) +
  // 64 bytes (one signature) = 65 bytes overhead.
  //
  // Gated behind NEXT_PUBLIC_VEIL_DEBUG=1 so the production console isn't
  // spammed on every payment. Inline check (no umbra.ts import) to keep
  // this module's dep surface minimal.
  if (process.env.NEXT_PUBLIC_VEIL_DEBUG === "1") {
    // eslint-disable-next-line no-console
    console.log("[VeilPay tx-size]", {
      serializedMessageBytes: messageBytes.length,
      estSignedTxBytes: messageBytes.length + 65,
      underCap1232: messageBytes.length + 65 <= 1232,
      accountKeys: messageV0.staticAccountKeys.length,
      altCount: altAccounts.length,
      altWritable: messageV0.addressTableLookups.reduce(
        (n, l) => n + l.writableIndexes.length,
        0,
      ),
      altReadonly: messageV0.addressTableLookups.reduce(
        (n, l) => n + l.readonlyIndexes.length,
        0,
      ),
      instructions: messageV0.compiledInstructions.length,
      veilPayIxDataBytes: veilPayIx.data.length,
      veilPayIxAccountCount: veilPayIx.keys.length,
      createBufferDataBytes: createBufferIx.data.length,
      depositDataBytes: depositIx.data.length,
      createBufferAccountCount: createBufferIx.accounts.length,
      depositAccountCount: depositIx.accounts.length,
    });
  }
  const kitTx: any = {
    messageBytes,
    signatures: { [depositorAddress]: null },
  };
  const signed: any = await c.signer.signTransaction(kitTx);

  // 7. Reassemble + submit. The SDK signer returned `{ messageBytes,
  //    signatures }` where signatures is an object keyed by address.
  //    Convert back to a wire-format VersionedTransaction.
  const reassembled = new VersionedTransaction(messageV0);
  const signatureBytes: Uint8Array = signed.signatures[depositorAddress];
  if (!signatureBytes) {
    throw new Error("Wallet did not return a signature for the depositor");
  }
  reassembled.addSignature(depositorPubkey, signatureBytes);

  const txSignature = await connection.sendTransaction(reassembled, {
    skipPreflight: false,
    maxRetries: 3,
  });

  // 8. Confirm. Use blockhash-based confirmation (per Solana 1.16+ recs);
  //    falls back to a 60s timeout via lastValidBlockHeight.
  await connection.confirmTransaction(
    {
      signature: txSignature,
      blockhash,
      lastValidBlockHeight,
    },
    "confirmed",
  );

  // Return shape mirrors PayInvoiceResult so the caller is unchanged.
  // Both inner CPIs share one outer signature; we duplicate it across the
  // two fields and leave closeProofAccountSignature undefined (we never
  // pre-create + close a stale buffer in this path).
  return {
    createProofAccountSignature: txSignature,
    createUtxoSignature: txSignature,
    closeProofAccountSignature: undefined,
  };
}

// =============================================================================
// SHIELDED-balance pay path (workstream 2026-05-06)
// =============================================================================
//
// Wraps `pay_invoice_from_shielded` — the Anchor ix that fires the
// invoice-registry lock CPI followed by the two Umbra CPIs:
//   1. create_stealth_pool_deposit_input_buffer (the SHIELDED variant —
//      different ix than the public path's create_buffer).
//   2. deposit_into_stealth_pool_from_shared_balance_v11 (the SHIELDED-source
//      deposit — uses Arcium MPC instead of plaintext debit).
//
// Architectural choice: we delegate the ZK-proof + crypto orchestration to
// the SDK via the same capture proxy used by `payShieldedCpi.ts`, then
// extract the two Umbra instructions from the SDK's built kit-format
// messages and re-pack them into our VeilPay outer ix. This avoids
// reimplementing the SDK's encrypted-balance ZK proof generation
// (~200 ZK signals, rescue encryption, polynomial commitments — far more
// involved than the public-balance path we hand-built in
// `generateProofAndCommitments`).
//
// What changes vs. payShieldedCpi.ts (which produces 2-3 SEPARATE signed
// txs): we go from 2-3 popups to 1 popup AND acquire the on-chain
// PaymentIntentLock atomically. The trade-off is that we need to surgically
// extract the Umbra ixs from the SDK's captured messages — the
// `extractUmbraInstructionFromCapturedMessage` helper below does that.

// Reuse the parser from payShieldedCpi's capture pattern. We import lazily
// to keep the SDK dep out of payInvoiceCpi's static graph.

interface ExtractedUmbraIxs {
  createBufferIx: TransactionInstruction;
  depositIx: TransactionInstruction;
  /** Whether the SDK also produced a stale-buffer close ix that we need
   *  to fire BEFORE the wrapped pay tx. The CPI wrap only handles the
   *  proof+deposit pair; if the SDK detects a leftover buffer, the
   *  caller must close it in a separate prep tx (we expose the close
   *  ix on the returned object so the caller can decide). */
  closeIx?: TransactionInstruction;
  payerAddress: string;
}

/**
 * Extract the two Umbra instructions (createBuffer + deposit) from the
 * SDK's captured kit-format messages.
 *
 * Layout of each captured message (verified by reading sdk index.cjs
 * 8209-8243): [optional ComputeBudget ix..., Umbra ix]. We pick the
 * Umbra-program-id instruction. The captured messages may have ALT
 * lookups embedded (the SDK pre-bakes its own Umbra ALT into messages),
 * so we resolve account indices through both static keys AND the ALT
 * (fetching the ALT account if any are referenced).
 */
async function extractUmbraInstructionsFromShieldedBuild(
  builtMessages: Uint8Array[],
  payerAddress: string,
): Promise<ExtractedUmbraIxs> {
  // Validate count: 2 = [proof, utxo], 3 = [close, proof, utxo].
  if (builtMessages.length !== 2 && builtMessages.length !== 3) {
    throw new Error(
      `Shielded build produced ${builtMessages.length} captured txs — expected 2 or 3.`,
    );
  }
  const hasClose = builtMessages.length === 3;
  const closeBytes = hasClose ? builtMessages[0] : undefined;
  const proofBytes = hasClose ? builtMessages[1] : builtMessages[0];
  const depositBytes = hasClose ? builtMessages[2] : builtMessages[1];

  const connection = new Connection(RPC_URL, "confirmed");

  // Helper: parse a v0 message and return only the Umbra-program-id
  // instructions resolved into web3.js TransactionInstruction objects.
  // Filters out ComputeBudget. The SDK's per-tx structure means each
  // captured message contains ONE Umbra ix (plus optional helpers).
  async function extractUmbraIx(
    messageBytes: Uint8Array,
  ): Promise<TransactionInstruction> {
    const { VersionedMessage } = await import("@solana/web3.js");
    const message = VersionedMessage.deserialize(messageBytes);

    // Resolve ALT lookups, if any. kit's compiler may pre-bake an ALT
    // into the captured message — we have to fetch it to map indices
    // back to pubkeys.
    const altAccounts: AddressLookupTableAccount[] = [];
    if (message.addressTableLookups && message.addressTableLookups.length > 0) {
      for (const lookup of message.addressTableLookups) {
        const altResult = await connection.getAddressLookupTable(
          lookup.accountKey,
        );
        if (altResult.value) {
          altAccounts.push(altResult.value);
        } else {
          throw new Error(
            `Captured message references ALT ${lookup.accountKey.toBase58()} that is not fetchable. Cannot resolve account indices.`,
          );
        }
      }
    }

    // Build the canonical pubkey list: static keys first, then ALT-
    // writable (in the order they appear across lookups), then ALT-
    // readonly. This matches Solana's runtime ordering for v0 messages.
    const allKeys: PublicKey[] = [...message.staticAccountKeys];
    for (let i = 0; i < (message.addressTableLookups?.length ?? 0); i++) {
      const lookup = message.addressTableLookups[i];
      const alt = altAccounts[i];
      for (const idx of lookup.writableIndexes) {
        allKeys.push(alt.state.addresses[idx]);
      }
    }
    for (let i = 0; i < (message.addressTableLookups?.length ?? 0); i++) {
      const lookup = message.addressTableLookups[i];
      const alt = altAccounts[i];
      for (const idx of lookup.readonlyIndexes) {
        allKeys.push(alt.state.addresses[idx]);
      }
    }

    // Resolve writable / signer flags. The header gives signer + signer-
    // readonly counts at the top of staticAccountKeys; non-signer-writable
    // are next; non-signer-readonly are last. ALT-writable / ALT-readonly
    // append AFTER all static. v0 message-format layout, verified by
    // reading web3.js's MessageV0 source.
    const numRequiredSignatures = message.header.numRequiredSignatures;
    const numReadonlySigned = message.header.numReadonlySignedAccounts;
    const numReadonlyUnsigned = message.header.numReadonlyUnsignedAccounts;
    const staticLen = message.staticAccountKeys.length;
    const numWritableSigned = numRequiredSignatures - numReadonlySigned;
    const numWritableUnsigned =
      staticLen - numRequiredSignatures - numReadonlyUnsigned;
    const altWritableCount = (message.addressTableLookups ?? []).reduce(
      (n, l) => n + l.writableIndexes.length,
      0,
    );

    function isSigner(i: number): boolean {
      // Static keys: first numRequiredSignatures are signers.
      // ALT keys are NEVER signers (Solana protocol).
      return i < numRequiredSignatures;
    }
    function isWritable(i: number): boolean {
      if (i < numWritableSigned) return true; // writable signer
      if (i < numRequiredSignatures) return false; // readonly signer
      if (i < numRequiredSignatures + numWritableUnsigned) return true; // writable unsigned
      if (i < staticLen) return false; // readonly unsigned
      // ALT range: first altWritableCount are writable, rest readonly.
      return i < staticLen + altWritableCount;
    }

    // Find the Umbra-program-id instruction. Compiled instructions
    // reference the program id by index into staticAccountKeys.
    let umbraIx: TransactionInstruction | null = null;
    for (const compiled of message.compiledInstructions) {
      const programId = allKeys[compiled.programIdIndex];
      if (!programId.equals(UMBRA_PROGRAM_ID)) continue;
      const keys: Web3AccountMeta[] = compiled.accountKeyIndexes.map((idx) => ({
        pubkey: allKeys[idx],
        isSigner: isSigner(idx),
        isWritable: isWritable(idx),
      }));
      umbraIx = new TransactionInstruction({
        programId,
        keys,
        data: Buffer.from(compiled.data),
      });
      // First Umbra ix in the message is the one we want (each captured
      // message contains exactly one).
      break;
    }
    if (!umbraIx) {
      throw new Error(
        "Captured message contained no Umbra-program-id instruction.",
      );
    }
    return umbraIx;
  }

  const [proofIx, depositIx] = await Promise.all([
    extractUmbraIx(proofBytes),
    extractUmbraIx(depositBytes),
  ]);
  const closeIx = closeBytes ? await extractUmbraIx(closeBytes) : undefined;

  return {
    createBufferIx: proofIx,
    depositIx,
    closeIx,
    payerAddress,
  };
}

// ---------------------------------------------------------------------------
//  Shielded batched-signing flow
//
//  The bundled-CPI path (`buildVeilPayShieldedCpiTx_DEAD_v1` below) blew the
//  1232-byte tx cap by 234 bytes. This replacement builds 3 small txs
//  (lock + createBuffer + deposit), signs them with `signAllTransactions`
//  in one popup, and submits sequentially.
//
//  Atomicity story:
//    - Tx 1 (lock) confirms first. If it fails, tx 2/3 are NEVER submitted —
//      the wallet pre-signed them but we abort before the network sees them.
//      Same UX as today's failed-pay path.
//    - Tx 2 (createBuffer) confirms second. Failure leaves the lock
//      account in place but no fund movement. Surface as `StuckLockError`
//      so the dashboard can prompt for `cancel_payment_intent`.
//    - Tx 3 (deposit) confirms third. Same StuckLockError if it fails.
//
//  This is "near-atomic" — same guarantees as pay_invoice's CPI bundle for
//  the public path, modulo the recovery primitive for the rare 2/3 or 3/3
//  failure case.
// ---------------------------------------------------------------------------

/**
 * Build a raw `lock_payment_intent` instruction. Account ordering must
 * match the `LockPaymentIntent<'info>` accounts struct in
 * `programs/invoice-registry/.../lib.rs`:
 *   #0 invoice              (read-only)
 *   #1 lock                 (writable, init via PDA seeds + system_program)
 *   #2 payer                (signer, writable — pays the rent)
 *   #3 system_program       (read-only — required by Anchor `init`)
 *
 * No args; the discriminator is the entire instruction data payload.
 */
function buildLockPaymentIntentIx(args: {
  invoicePda: PublicKey;
  payer: PublicKey;
}): TransactionInstruction {
  const lockPda = deriveLockPda(args.invoicePda);
  return new TransactionInstruction({
    programId: INVOICE_REGISTRY_PROGRAM_ID,
    keys: [
      { pubkey: args.invoicePda, isSigner: false, isWritable: false },
      { pubkey: lockPda, isSigner: false, isWritable: true },
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(LOCK_PAYMENT_INTENT_DISCRIMINATOR),
  });
}

/**
 * Build (but do not sign) a `cancel_payment_intent` versioned tx. Used
 * by the dashboard's stuck-lock recovery UI. Returns the unsigned tx
 * + the blockhash + lastValidBlockHeight so the caller can sign and
 * confirm in two follow-up steps.
 *
 * Account ordering matches the `CancelPaymentIntent<'info>` accounts
 * struct in invoice-registry's lib.rs:
 *   #0 invoice              (read-only)
 *   #1 lock                 (writable, close = payer)
 *   #2 payer                (signer, writable — receives the rent refund)
 */
export async function buildCancelPaymentIntentTx(args: {
  invoicePda: PublicKey;
  payer: PublicKey;
}): Promise<{
  tx: VersionedTransaction;
  blockhash: string;
  lastValidBlockHeight: number;
}> {
  const lockPda = deriveLockPda(args.invoicePda);
  const ix = new TransactionInstruction({
    programId: INVOICE_REGISTRY_PROGRAM_ID,
    keys: [
      { pubkey: args.invoicePda, isSigner: false, isWritable: false },
      { pubkey: lockPda, isSigner: false, isWritable: true },
      { pubkey: args.payer, isSigner: true, isWritable: true },
    ],
    data: Buffer.from(CANCEL_PAYMENT_INTENT_DISCRIMINATOR),
  });

  const connection = new Connection(RPC_URL, "confirmed");
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  const messageV0 = new TransactionMessage({
    payerKey: args.payer,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();
  return { tx: new VersionedTransaction(messageV0), blockhash, lastValidBlockHeight };
}

/**
 * Build a v0 transaction wrapping a single instruction with a fixed
 * blockhash + an optional ALT. Internal helper for the shielded
 * batched flow.
 *
 * Compute-budget instructions can be passed inline via `extraIxs`.
 */
function buildV0Tx(
  ixs: TransactionInstruction[],
  blockhash: string,
  payer: PublicKey,
  altAccounts: AddressLookupTableAccount[],
): VersionedTransaction {
  const messageV0 = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message(altAccounts);
  return new VersionedTransaction(messageV0);
}

/**
 * Pay an invoice from Bob's encrypted (shielded) balance via 3 small
 * txs signed in ONE popup using `signAllTransactions`.
 *
 * Architecture:
 *   1. Tx 1: invoice_registry::lock_payment_intent — acquires the
 *      single-use `PaymentIntentLock` PDA, paid for by the depositor.
 *      Tiny tx (4 accounts + 8 bytes data), no ALT needed.
 *   2. Tx 2: Umbra createBuffer — pre-allocates the proof input buffer
 *      PDA. Same ix the SDK emits in its 2-popup flow; extracted from
 *      the SDK build via `buildShieldedCpiTxs` (capture proxy).
 *   3. Tx 3: Umbra deposit_into_stealth_pool_from_shared_balance_v11 —
 *      consumes the buffer + queues the Arcium MPC computation.
 *
 * All three share the same blockhash, signed via the kit-style
 * `signer.signTransactions` (which maps to the wallet adapter's
 * `signAllTransactions` — one popup, three signatures).
 *
 * Submission is sequential with `confirmed` commitment between txs:
 *   - Tx 1 fails  → throw `PaymentIntentLockError`. Tx 2/3 are dropped
 *     (never submitted). User retries cleanly.
 *   - Tx 2 or 3 fails → throw `StuckLockError`. The lock is now on
 *     chain but no fund movement happened. Dashboard surfaces the
 *     "Release payment intent" recovery button. User cancels + retries.
 *   - All three succeed → happy path. Returns
 *     `createProofAccountSignature` (tx 2) and `createUtxoSignature`
 *     (tx 3) for callers that key off these specific signatures.
 *
 * If the SDK's build returned a stale-buffer close tx (rare —
 * previous attempt left a buffer behind), it's submitted FIRST as a
 * separate single-tx prep step, BEFORE the batched signing popup.
 * That's a 2-popup flow in the rare case but doesn't muddle the
 * happy-path UX.
 */
export async function payInvoiceFromShieldedBatched(
  args: PayInvoiceArgs,
): Promise<PayInvoiceResult> {
  if (!VEIL_PAY_PROGRAM_ID) {
    // We don't actually use the VeilPay program in the batched path —
    // it's pure invoice-registry + Umbra. But we keep the same gating
    // signal as `payInvoiceCpi` so the umbra.ts try/wrap fallback
    // pattern stays uniform: missing config = "use SDK fallback".
    throw new VeilPayNotConfiguredError();
  }
  if (!args.invoicePda) {
    throw new Error(
      "payInvoiceFromShieldedBatched: args.invoicePda is required (the lock PDA is invoice-bound).",
    );
  }

  const c: any = args.client;
  const depositorAddress: string = String(c.signer.address);
  const depositorPubkey = new PublicKey(depositorAddress);

  // ---- 1. Drive the SDK's encrypted-balance create flow under the capture
  //         proxy from payShieldedCpi.ts. Produces 2-3 captured kit messages,
  //         each containing one Umbra ix. We pin the same blockhash for all
  //         3 batched txs below; the SDK's pinned blockhash from this build
  //         is a separate concern — we re-extract the ixs and recompile
  //         under our blockhash, so the SDK's blockhash is discarded.
  const { buildShieldedCpiTxs, ShieldedCpiNotConfiguredError } = await import(
    "./payShieldedCpi"
  );
  let built;
  try {
    built = await buildShieldedCpiTxs({
      client: args.client,
      recipientAddress: args.recipientAddress,
      mint: args.mint,
      amount: args.amount,
    });
  } catch (err) {
    if (err instanceof ShieldedCpiNotConfiguredError) {
      // SDK behaviour drift — surface as VeilPay-not-configured so the
      // umbra.ts try/wrap pattern falls back to the legacy SDK flow.
      throw new VeilPayNotConfiguredError();
    }
    throw err;
  }

  // ---- 2. Extract the createBuffer + deposit ixs (and optional close)
  //         from the captured messages. This is the same extraction logic
  //         the dead `buildVeilPayShieldedCpiTx_DEAD_v1` uses — REUSED.
  const captured = [
    ...(built.cached.closeMessageBytes ? [built.cached.closeMessageBytes] : []),
    built.cached.proofMessageBytes,
    built.cached.utxoMessageBytes,
  ];
  const extracted = await extractUmbraInstructionsFromShieldedBuild(
    captured,
    built.payerAddress,
  );

  // ---- 3. If a stale-buffer close is needed, submit it FIRST as a
  //         separate (non-batched) prep step. Rare path. The user sees
  //         an extra popup in this case — acceptable since the alternative
  //         is bundling close into the same batch, which would require
  //         tx ordering coordination (close MUST land before createBuffer
  //         can re-allocate the same PDA, but a close-then-createBuffer
  //         in the same batch could race with the close finalization).
  const connection = new Connection(RPC_URL, "confirmed");
  if (extracted.closeIx) {
    // eslint-disable-next-line no-console
    console.warn(
      "[payInvoiceFromShieldedBatched] stale buffer detected — submitting close tx as separate prep step.",
    );
    const { blockhash: closeBh, lastValidBlockHeight: closeLvbh } =
      await connection.getLatestBlockhash("confirmed");
    const closeTx = buildV0Tx([extracted.closeIx], closeBh, depositorPubkey, []);
    const closeKitTx: any = {
      messageBytes: closeTx.message.serialize(),
      signatures: { [depositorAddress]: null },
    };
    const signedClose: any = await c.signer.signTransaction(closeKitTx);
    const closeReassembled = new VersionedTransaction(closeTx.message);
    const closeSigBytes: Uint8Array = signedClose.signatures[depositorAddress];
    if (!closeSigBytes) {
      throw new Error("Wallet did not sign the stale-buffer close tx");
    }
    closeReassembled.addSignature(depositorPubkey, closeSigBytes);
    const closeSig = await connection.sendTransaction(closeReassembled, {
      skipPreflight: false,
      maxRetries: 3,
    });
    await connection.confirmTransaction(
      { signature: closeSig, blockhash: closeBh, lastValidBlockHeight: closeLvbh },
      "confirmed",
    );
  }

  // ---- 4. Build the 3 separate VersionedTransactions, all sharing one
  //         blockhash so the wallet can batch-sign them in one popup.
  //         The lock tx is small (no ALT). The createBuffer + deposit
  //         txs use the VeilPay ALT to fit under 1232 bytes — when the
  //         outer ix bundle is split into separate txs, each individual
  //         tx is small enough that the ALT comfortably puts them under
  //         cap.
  const lockIx = buildLockPaymentIntentIx({
    invoicePda: args.invoicePda,
    payer: depositorPubkey,
  });

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  let altAccounts: AddressLookupTableAccount[] = [];
  if (VEILPAY_ALT_ADDRESS) {
    const altResult = await connection.getAddressLookupTable(VEILPAY_ALT_ADDRESS);
    if (altResult.value) {
      altAccounts = [altResult.value];
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `[payInvoiceFromShieldedBatched] ALT ${VEILPAY_ALT_ADDRESS.toBase58()} not fetchable — falling back to inline accounts. Tx may exceed 1232b.`,
      );
    }
  }

  // The deposit tx is the heaviest of the three (Arcium MPC v11 has
  // ~25 accounts). Set a generous compute-unit limit just on the
  // deposit tx; the lock tx and createBuffer tx are well within the
  // default 200k CU budget.
  const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 1_400_000,
  });

  const lockTx = buildV0Tx([lockIx], blockhash, depositorPubkey, []);
  const createTx = buildV0Tx(
    [extracted.createBufferIx],
    blockhash,
    depositorPubkey,
    altAccounts,
  );
  const depositTx = buildV0Tx(
    [computeBudgetIx, extracted.depositIx],
    blockhash,
    depositorPubkey,
    altAccounts,
  );

  if (process.env.NEXT_PUBLIC_VEIL_DEBUG === "1") {
    const sizes = [
      { label: "lock", tx: lockTx },
      { label: "createBuffer", tx: createTx },
      { label: "deposit", tx: depositTx },
    ].map(({ label, tx }) => {
      const messageBytes = tx.message.serialize();
      return {
        label,
        serializedMessageBytes: messageBytes.length,
        estSignedTxBytes: messageBytes.length + 65,
        underCap1232: messageBytes.length + 65 <= 1232,
        accountKeys: tx.message.staticAccountKeys.length,
      };
    });
    // eslint-disable-next-line no-console
    console.log("[VeilPay tx-size shielded-batched]", sizes);
  }

  // ---- 5. Sign all three in ONE popup via the wallet adapter's
  //         `signAllTransactions(VersionedTransaction[])`. This is the
  //         same pattern PayrollFlow.tsx uses (line 1264) and is proven
  //         to round-trip cleanly.
  //
  //         Earlier attempt: route through `c.signer.signTransactions`
  //         passing kit-format `{messageBytes, signatures}` objects.
  //         That path fails with "Transaction did not pass signature
  //         verification" because the kit signer's serialization of v0
  //         messages doesn't byte-for-byte match what
  //         `lockTx.message.serialize()` produces — so the signature
  //         is over different bytes than the tx we send. Bypassed
  //         entirely; we go straight to the web3.js wallet adapter.
  if (!args.wallet?.signAllTransactions) {
    throw new Error(
      "Wallet does not support signAllTransactions — required for the shielded batched flow. " +
        "Make sure the caller passes `wallet` from `useWallet()` in PayInvoiceArgs.",
    );
  }

  let signedTxs: VersionedTransaction[];
  try {
    signedTxs = await args.wallet.signAllTransactions([
      lockTx,
      createTx,
      depositTx,
    ]);
  } catch (err) {
    // User rejected the popup or wallet errored before signing —
    // surface as PaymentIntentLockError so the UI shows a normal
    // failure (no on-chain effect; no recovery needed).
    throw new PaymentIntentLockError(err);
  }

  const [lockSigned, createSigned, depositSigned] = signedTxs;

  // ---- 6. Submit sequentially. tx1 first; if it fails, abort cleanly
  //         (none of tx2/tx3 are sent; the wallet's pre-signed bytes
  //         don't reach the network).
  async function sendAndConfirm(tx: VersionedTransaction): Promise<string> {
    const sig = await connection.sendTransaction(tx, {
      skipPreflight: false,
      maxRetries: 3,
    });
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    return sig;
  }

  let lockSig: string | null = null;
  try {
    lockSig = await sendAndConfirm(lockSigned);
  } catch (err) {
    // tx1 fails — restricted-payer mismatch, already-paid race,
    // already-locked-by-someone-else, etc. Tx 2/3 never submitted.
    throw new PaymentIntentLockError(err);
  }

  let createSig: string;
  let depositSig: string;
  try {
    createSig = await sendAndConfirm(createSigned);
    depositSig = await sendAndConfirm(depositSigned);
  } catch (err) {
    // tx2 or tx3 failed — lock is on chain but no fund movement.
    // Surface as StuckLockError so the dashboard can prompt for
    // cancel_payment_intent. The plan explicitly forbids retrying
    // tx2/tx3 internally — let the user release the lock + retry
    // from scratch.
    throw new StuckLockError({
      invoicePda: args.invoicePda.toBase58(),
      lockSig,
      cause: err,
    });
  }

  // Happy path. The Arcium MPC callback that finalises the encrypted
  // leaf lands asynchronously after this tx confirms — the dashboard's
  // scan/claim flow tolerates indexer/MPC lag transparently, same as
  // the public path does.
  return {
    createProofAccountSignature: createSig,
    createUtxoSignature: depositSig,
    closeProofAccountSignature: undefined,
  };
}

/**
 * DEAD CODE — DO NOT WIRE INTO THE PRODUCTION FLOW.
 *
 * This wraps the shielded createBuffer + deposit ixs into a single
 * outer `pay_invoice_from_shielded` VeilPay ix. The on-chain program
 * works correctly (see `programs/veil-pay/tests/veil-pay.ts` —
 * pay_invoice_from_shielded happy/double-pay/wrong-payer all pass),
 * but the resulting tx is **234 bytes over the 1232-byte cap** even
 * with our ALT extended.
 *
 * Why: the shielded `createBuffer` ix carries ~880 bytes of encrypted
 * ciphertext fields that the public-balance variant doesn't. Bundling
 * two heavy Umbra ixs + a lock CPI inside one outer ix simply doesn't
 * fit. Measured 1466 bytes vs. 1232 cap — see the [VeilPay tx-size
 * shielded] log emitted when NEXT_PUBLIC_VEIL_DEBUG=1.
 *
 * The replacement is `payInvoiceFromShieldedBatched` below, which
 * builds 3 small txs (lock + createBuffer + deposit), signs them all
 * via wallet.signAllTransactions in ONE popup, and submits sequentially.
 * Same UX (one popup), works around the size cap.
 *
 * Kept here as documentation of what was tried + why it failed, so the
 * shape is recoverable if Solana ever raises the per-tx limit. Do not
 * delete — the ix extraction logic in `extractUmbraInstructionsFromShieldedBuild`
 * + the call to `buildShieldedCpiTxs` is shared with the working batched
 * path; deleting this function would leave that helper orphaned.
 */
async function buildVeilPayShieldedCpiTx_DEAD_v1(
  args: PayInvoiceArgs,
): Promise<PayInvoiceResult> {
  if (!VEIL_PAY_PROGRAM_ID) throw new VeilPayNotConfiguredError();
  if (!args.invoicePda) {
    throw new Error(
      "payInvoiceFromShieldedCpi: args.invoicePda is required (Fix 2 — single-popup pay binds to an Invoice account).",
    );
  }

  const c: any = args.client;
  const depositorAddress: string = String(c.signer.address);
  const depositorPubkey = new PublicKey(depositorAddress);

  // 1. Drive the SDK's encrypted-balance create flow under the capture
  //    proxy from payShieldedCpi.ts. This produces 2-3 captured kit-
  //    format messages (closeOptional+proof+deposit), each containing
  //    one Umbra ix.
  const { buildShieldedCpiTxs, ShieldedCpiNotConfiguredError } = await import(
    "./payShieldedCpi"
  );
  let built;
  try {
    built = await buildShieldedCpiTxs({
      client: args.client,
      recipientAddress: args.recipientAddress,
      mint: args.mint,
      amount: args.amount,
    });
  } catch (err) {
    if (err instanceof ShieldedCpiNotConfiguredError) {
      // SDK behaviour drift — surface as VeilPay-not-configured so the
      // umbra.ts try/wrap pattern falls back to the legacy SDK flow.
      throw new VeilPayNotConfiguredError();
    }
    throw err;
  }

  // 2. Extract the Umbra ixs (createBuffer + deposit, optional close)
  //    from the captured messages.
  const captured = [
    ...(built.cached.closeMessageBytes
      ? [built.cached.closeMessageBytes]
      : []),
    built.cached.proofMessageBytes,
    built.cached.utxoMessageBytes,
  ];
  const extracted = await extractUmbraInstructionsFromShieldedBuild(
    captured,
    built.payerAddress,
  );

  // If a stale-buffer close is needed, submit it FIRST as a separate tx
  // (NOT wrapped — see function docstring rationale). This is rare.
  if (extracted.closeIx) {
    // eslint-disable-next-line no-console
    console.warn(
      "[payInvoiceFromShieldedCpi] stale buffer detected — submitting close tx as separate (non-wrapped) prep step.",
    );
    const connection = new Connection(RPC_URL, "confirmed");
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");
    const messageV0 = new TransactionMessage({
      payerKey: depositorPubkey,
      recentBlockhash: blockhash,
      instructions: [extracted.closeIx],
    }).compileToV0Message();
    const closeTx = new VersionedTransaction(messageV0);
    const closeMessageBytes = messageV0.serialize();
    const closeKitTx: any = {
      messageBytes: closeMessageBytes,
      signatures: { [depositorAddress]: null },
    };
    const signed: any = await c.signer.signTransaction(closeKitTx);
    const closeReassembled = new VersionedTransaction(messageV0);
    const sigBytes: Uint8Array = signed.signatures[depositorAddress];
    if (!sigBytes) throw new Error("Wallet did not sign the close tx");
    closeReassembled.addSignature(depositorPubkey, sigBytes);
    const closeSig = await connection.sendTransaction(closeReassembled, {
      skipPreflight: false,
      maxRetries: 3,
    });
    await connection.confirmTransaction(
      { signature: closeSig, blockhash, lastValidBlockHeight },
      "confirmed",
    );
  }

  // 3. Build the VeilPay outer ix wrapping createBuffer + deposit.
  //    Account list order matches `PayInvoiceFromShielded` in lib.rs:
  //      #0 depositor                  (signer, writable)
  //      #1 invoice                    (read-only)
  //      #2 lock                       (writable)
  //      #3 invoice_registry_program   (read-only)
  //      #4 system_program             (read-only)
  //      #5 umbra_program              (read-only)
  //      #6..N remaining_accounts (createBuffer accts then deposit accts)
  const createBufferData: Uint8Array = new Uint8Array(extracted.createBufferIx.data);
  const depositData: Uint8Array = new Uint8Array(extracted.depositIx.data);
  const createBufferAccountCount = extracted.createBufferIx.keys.length;
  if (createBufferAccountCount > 255) {
    throw new Error(
      `Captured create-buffer ix had ${createBufferAccountCount} accounts — exceeds u8 limit`,
    );
  }
  const data = concatBytes(
    PAY_INVOICE_FROM_SHIELDED_DISCRIMINATOR,
    encodeBorshVecU8(createBufferData),
    encodeBorshVecU8(depositData),
    new Uint8Array([createBufferAccountCount]),
  );

  const lockPda = deriveLockPda(args.invoicePda);
  const keys: Web3AccountMeta[] = [
    { pubkey: depositorPubkey, isSigner: true, isWritable: true },
    { pubkey: args.invoicePda, isSigner: false, isWritable: false },
    { pubkey: lockPda, isSigner: false, isWritable: true },
    { pubkey: INVOICE_REGISTRY_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: UMBRA_PROGRAM_ID, isSigner: false, isWritable: false },
    ...extracted.createBufferIx.keys,
    ...extracted.depositIx.keys,
  ];

  const veilPayIx = new TransactionInstruction({
    programId: VEIL_PAY_PROGRAM_ID,
    keys,
    data: Buffer.from(data),
  });

  // 4. Compute budget — Arcium MPC v11 deposit is heavier than the
  //    public path. Set 1.4M (Solana's per-tx ceiling) defensively.
  //    Measured CU: SDK uses 600k for the deposit alone, but our wrap
  //    adds the lock-CPI plus the create-buffer CPI in the same tx.
  const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 1_400_000,
  });

  // 5. Compile a v0 message with our VeilPay ALT.
  const connection = new Connection(RPC_URL, "confirmed");
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  let altAccounts: AddressLookupTableAccount[] = [];
  if (VEILPAY_ALT_ADDRESS) {
    const altResult = await connection.getAddressLookupTable(
      VEILPAY_ALT_ADDRESS,
    );
    if (altResult.value) {
      altAccounts = [altResult.value];
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `[VeilPay shielded] ALT ${VEILPAY_ALT_ADDRESS.toBase58()} not fetchable — falling back to inline accounts. Tx will likely exceed 1232b.`,
      );
    }
  }

  const messageV0 = new TransactionMessage({
    payerKey: depositorPubkey,
    recentBlockhash: blockhash,
    instructions: [computeBudgetIx, veilPayIx],
  }).compileToV0Message(altAccounts);
  const tx = new VersionedTransaction(messageV0);

  if (process.env.NEXT_PUBLIC_VEIL_DEBUG === "1") {
    const messageBytes = messageV0.serialize();
    const altWritable = messageV0.addressTableLookups.reduce(
      (n, l) => n + l.writableIndexes.length,
      0,
    );
    const altReadonly = messageV0.addressTableLookups.reduce(
      (n, l) => n + l.readonlyIndexes.length,
      0,
    );
    // eslint-disable-next-line no-console
    console.log("[VeilPay tx-size shielded]", {
      serializedMessageBytes: messageBytes.length,
      estSignedTxBytes: messageBytes.length + 65,
      underCap1232: messageBytes.length + 65 <= 1232,
      accountKeys: messageV0.staticAccountKeys.length,
      altCount: altAccounts.length,
      altWritable,
      altReadonly,
      instructions: messageV0.compiledInstructions.length,
      veilPayIxDataBytes: veilPayIx.data.length,
      veilPayIxAccountCount: veilPayIx.keys.length,
      createBufferDataBytes: createBufferData.length,
      depositDataBytes: depositData.length,
      createBufferAccountCount: extracted.createBufferIx.keys.length,
      depositAccountCount: extracted.depositIx.keys.length,
    });
  }

  // 6. Sign once via the wrapped Wallet Standard signer.
  const messageBytes = messageV0.serialize();
  const kitTx: any = {
    messageBytes,
    signatures: { [depositorAddress]: null },
  };
  const signed: any = await c.signer.signTransaction(kitTx);

  const reassembled = new VersionedTransaction(messageV0);
  const signatureBytes: Uint8Array = signed.signatures[depositorAddress];
  if (!signatureBytes) {
    throw new Error("Wallet did not return a signature for the depositor");
  }
  reassembled.addSignature(depositorPubkey, signatureBytes);

  const txSignature = await connection.sendTransaction(reassembled, {
    skipPreflight: false,
    maxRetries: 3,
  });

  await connection.confirmTransaction(
    { signature: txSignature, blockhash, lastValidBlockHeight },
    "confirmed",
  );

  // The Arcium MPC callback that finalises the encrypted leaf lands
  // asynchronously after this tx confirms. Mirroring `payInvoiceCpi`
  // (which has no MPC component), we don't wait for it here — the
  // existing scan/claim flow tolerates indexer/MPC lag transparently.
  return {
    createProofAccountSignature: txSignature,
    createUtxoSignature: txSignature,
    closeProofAccountSignature: undefined,
  };
}
