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
} from "./constants";

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

async function generateProofAndCommitments(
  args: PayInvoiceArgs,
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

  // 6. Fetch receiver account + mxe
  const receiverAccountMap: Map<string, any> = await c.accountInfoProvider(
    [receiverUserAccountPda, c.networkConfig.mxeAccountAddress],
    { commitment: "confirmed" },
  );
  const receiverAccountInfo = receiverAccountMap.get(receiverUserAccountPda);
  if (receiverAccountInfo?.exists !== true) {
    throw new Error(`Receiver is not registered: ${recipientAddress}`);
  }

  // 7. Decode receiver data → x25519 pub key + user commitment
  const receiverAccount = decodeEncryptedUserAccount(receiverAccountInfo);
  const receiverAccountData = (receiverAccount as any).data;
  const receiverX25519PublicKeyBytes =
    receiverAccountData.x25519PublicKeyForTokenEncryption?.first;
  if (receiverX25519PublicKeyBytes === undefined) {
    throw new Error("Receiver does not have X25519 public key registered");
  }
  const receiverX25519PublicKey = new Uint8Array(receiverX25519PublicKeyBytes);

  const receiverUserCommitmentBytes = receiverAccountData.userCommitment?.first;
  if (receiverUserCommitmentBytes === undefined) {
    throw new Error("Receiver does not have user commitment registered");
  }
  const receiverUserCommitmentLeBytes = new Uint8Array(
    receiverUserCommitmentBytes,
  );
  // Decode 32 bytes LE → bigint
  let receiverUserCommitment = 0n;
  for (let i = 0; i < 32; i++) {
    receiverUserCommitment |=
      BigInt(receiverUserCommitmentLeBytes[i]) << BigInt(i * 8);
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
  const assetProvider = await getProxiedAssetProvider();
  const zkProver = getCreateReceiverClaimableUtxoFromPublicBalanceProver({
    assetProvider,
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
): TransactionInstruction {
  // Serialize args matching veil_pay::pay_invoice signature:
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

  const data = concatBytes(
    PAY_INVOICE_DISCRIMINATOR,
    encodeBorshVecU8(createBufferData),
    encodeBorshVecU8(depositData),
    new Uint8Array([createBufferAccountCount]),
  );

  // Account list:
  //   #0 depositor (signer, NOT writable — Anchor declares it as Signer<'info>)
  //   #1 umbra_program (the deposit program ID; required by VeilPay constraint)
  //   #2..N remaining_accounts: union of buffer + deposit accounts
  //
  // The depositor signature on the outer tx propagates through CPI to both
  // inner Umbra calls automatically — Solana's signer-privilege model says
  // any account that signed the outer tx is treated as a signer for any
  // CPIs whose AccountMetas mark it as a signer.
  const keys: Web3AccountMeta[] = [
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

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

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

  // 3. Wrap both in our single VeilPay instruction
  const veilPayIx = buildVeilPayInstruction(
    createBufferIx,
    depositIx,
    depositorPubkey,
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
