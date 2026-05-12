// Measure the size of the wrapped shielded pay tx.
//
// Workstream 6 of the 2026-05-06 shielded-wrap plan. We don't have access
// to Alice's wallet / receiver / shielded balance from a script context,
// so we cannot drive the actual SDK proof generation. Instead we
// SYNTHESISE realistic-looking inputs (correctly-sized random bytes for
// each field) and run them through codama's builders + web3.js's v0
// message compiler. The resulting tx-size is byte-accurate because:
//   - Codama serializes our synthesised bytes verbatim into ix data.
//   - The ALT lookup-table substitution is purely a function of which
//     keys are STATIC vs PER-TX — no proof content matters.
//   - The 65-byte signature overhead is fixed.
//
// Usage:
//   cd app && node scripts/measure-shielded-tx-size.mjs
//
// Output: serialized message size, account counts, and a clear over/under
// the 1232-byte cap verdict.

import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL || "https://api.devnet.solana.com";

const VEIL_PAY_PROGRAM_ID = new PublicKey(
  "E2G6dN7yY8VQ2dFRgkvqskdAnPhJXkdorYP6BhKvfa8m",
);
const UMBRA_PROGRAM_ID = new PublicKey(
  "DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ",
);
const INVOICE_REGISTRY_PROGRAM_ID = new PublicKey(
  "54ryi8hcihut8fDSVFSbN5NbArQ5GAd1xgmGCA3hqWoo",
);
const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");

const ALT_ADDRESS = process.env.NEXT_PUBLIC_VEILPAY_ALT_ADDRESS
  ? new PublicKey(process.env.NEXT_PUBLIC_VEILPAY_ALT_ADDRESS)
  : null;

const PAY_INVOICE_FROM_SHIELDED_DISCRIMINATOR = new Uint8Array([
  69, 48, 101, 99, 117, 44, 70, 194,
]);
const CREATE_SHIELDED_BUFFER_DISCRIMINATOR = new Uint8Array([
  239, 89, 111, 177, 2, 224, 90, 79,
]);
const DEPOSIT_FROM_SHIELDED_DISCRIMINATOR = new Uint8Array([
  22, 229, 199, 112, 193, 65, 111, 243,
]);

function rand(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

function concatBytes(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrays) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

function encodeBorshVecU8(bytes) {
  const out = new Uint8Array(4 + bytes.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}

// ---------------------------------------------------------------------
// Field-by-field synthesis matching codama's struct layouts
// ---------------------------------------------------------------------

// CreateStealthPoolDepositInputBuffer (shielded) layout — codama
// dist/index.cjs lines 24611-24638.
function buildShieldedCreateBufferData() {
  // Field sizes verified by reading the codama encoder helpers.
  return concatBytes(
    CREATE_SHIELDED_BUFFER_DISCRIMINATOR,        // 8  — discriminator
    rand(16),                                    // 16 — offset (u128)
    rand(32),                                    // 32 — rescueEncryptionPublicKey (X25519 pub)
    rand(16),                                    // 16 — rescueEncryptionNonce (X25519 nonce)
    rand(32),                                    // 32 — rescueEncryptedTotalAmount (u256)
    rand(32),                                    // 32 — rescueEncryptedProtocolFees
    rand(32),                                    // 32 — rescueEncryptedRandomFactorLow
    rand(32),                                    // 32 — rescueEncryptedRandomFactorHigh
    rand(32),                                    // 32 — encryptionValidationPolynomial (FieldElement25519)
    rand(32),                                    // 32 — rescueEncryptionFiatShamirCommitment (poseidonHash)
    rand(32),                                    // 32 — insertionH2Commitment
    rand(8),                                     // 8  — insertionTimestamp (i64 unix)
    rand(32),                                    // 32 — linkerEncryption0 (poseidonCiphertext = 32)
    rand(32),                                    // 32 — linkerEncryption1
    rand(32),                                    // 32 — linkerEncryption2 (NEW vs public)
    rand(32),                                    // 32 — keystreamCommitment0
    rand(32),                                    // 32 — keystreamCommitment1
    rand(32),                                    // 32 — keystreamCommitment2 (NEW vs public)
    rand(64),                                    // 64 — groth16ProofA
    rand(128),                                   // 128 — groth16ProofB
    rand(64),                                    // 64 — groth16ProofC
    rand(80),                                    // 80 — aesEncryptedData (UTXO size)
    rand(32),                                    // 32 — optionalData
  );
}

// DepositIntoStealthPoolFromSharedBalanceV11 layout — codama lines 32058-32067.
function buildShieldedDepositData() {
  return concatBytes(
    DEPOSIT_FROM_SHIELDED_DISCRIMINATOR,         // 8
    rand(16),                                    // 16 — computationOffset (u128)
    rand(16),                                    // 16 — feeVaultOffset (u128)
    rand(16),                                    // 16 — stealthPoolDepositInputBufferOffset (u128)
    rand(16),                                    // 16 — mpcCallbackDataOffset (u128)
    rand(8),                                     // 8  — priorityFees (u64)
  );
}

// ---------------------------------------------------------------------
// Account list — matches the SHIELDED deposit ix's 25 accounts + the 4
// for create-buffer. Static-vs-per-tx mirrors the codama defaults.
// ---------------------------------------------------------------------

async function main() {
  const walletPath = join(homedir(), ".config", "solana", "id.json");
  const secret = Uint8Array.from(JSON.parse(readFileSync(walletPath, "utf8")));
  const wallet = Keypair.fromSecretKey(secret);
  const depositor = wallet.publicKey;

  // Synthesise random per-tx accounts (kept as random unique pubkeys —
  // their content doesn't affect compiled message size).
  function randPubkey() {
    return Keypair.generate().publicKey;
  }

  // 4 accounts for create-buffer (depositor, feePayer dedup, buffer PDA, system_prog)
  const createBufferAccounts = [
    { pubkey: depositor, isSigner: true, isWritable: true },        // depositor
    { pubkey: depositor, isSigner: true, isWritable: true },        // feePayer = depositor (dedupe)
    { pubkey: randPubkey(), isSigner: false, isWritable: true },    // stealthPoolDepositInputBuffer (per-tx)
    { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false }, // systemProgram (ALT'd)
  ];

  // 25 accounts for v11 deposit. Order matches codama.
  // Mark which are static (eligible for ALT) vs per-tx.
  const ARCIUM_PROGRAM = new PublicKey("Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ");
  const ARCIUM_POOL = new PublicKey("G2sRWJvi3xoyh5k2gY49eG9L8YhAEWQPtNb1zb1GXTtC");
  const ARCIUM_CLOCK = new PublicKey("7EbMUTLo5DjdzbN7s8BXeZwXzEwNQb1hScfRvWg8a6ot");
  const CLOCK_SYSVAR = new PublicKey("SysvarC1ock11111111111111111111111111111111");

  // We use random pubkeys for static-but-not-yet-on-ALT (e.g. signPda,
  // mxe, comp_def, etc.) — what matters for tx-size is which keys are
  // duplicates and whether they appear in the ALT.
  const signPda = randPubkey();      // STATIC (Umbra-side derivation)
  const mxe = randPubkey();          // STATIC (network-level)
  const mempool = randPubkey();      // STATIC (cluster-bound, devnet stable)
  const executingPool = randPubkey();// STATIC
  const computation = randPubkey();  // PER-TX (writable)
  const compDef = randPubkey();      // STATIC
  const cluster = randPubkey();      // STATIC
  const computationData = randPubkey(); // PER-TX
  const depositorUserAccount = randPubkey(); // PER-USER (treated per-tx for budget)
  const depositorTokenAccount = randPubkey(); // PER-USER
  const feeSchedule = randPubkey();  // STATIC (shielded variant)
  const feeVault = randPubkey();     // STATIC
  const stealthPool = randPubkey();  // STATIC (already ALT'd)
  const tokenPool = randPubkey();    // STATIC (already ALT'd)
  const mint = randPubkey();         // STATIC (wSOL, already ALT'd)
  const protocolConfig = randPubkey(); // STATIC (already ALT'd)
  const zkVerifyingKey = randPubkey(); // STATIC (shielded variant)

  const depositAccounts = [
    { pubkey: depositor, isSigner: true, isWritable: true },          // 0  depositor
    { pubkey: depositor, isSigner: true, isWritable: true },          // 1  feePayer (dedup)
    { pubkey: signPda, isSigner: false, isWritable: false },           // 2  signPdaAccount
    { pubkey: mxe, isSigner: false, isWritable: false },               // 3  mxeAccount
    { pubkey: mempool, isSigner: false, isWritable: true },            // 4  mempoolAccount
    { pubkey: executingPool, isSigner: false, isWritable: true },      // 5  executingPool
    { pubkey: computation, isSigner: false, isWritable: true },        // 6  computationAccount
    { pubkey: compDef, isSigner: false, isWritable: false },           // 7  compDefAccount
    { pubkey: cluster, isSigner: false, isWritable: true },            // 8  clusterAccount
    { pubkey: ARCIUM_POOL, isSigner: false, isWritable: true },        // 9  poolAccount
    { pubkey: ARCIUM_CLOCK, isSigner: false, isWritable: true },       // 10 clockAccount (Arcium)
    { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },    // 11 systemProgram
    { pubkey: ARCIUM_PROGRAM, isSigner: false, isWritable: false },    // 12 arciumProgram
    { pubkey: createBufferAccounts[2].pubkey, isSigner: false, isWritable: true }, // 13 sphPDIB (dedup with createBuffer)
    { pubkey: computationData, isSigner: false, isWritable: true },    // 14 computationData
    { pubkey: depositorUserAccount, isSigner: false, isWritable: false }, // 15
    { pubkey: depositorTokenAccount, isSigner: false, isWritable: true }, // 16
    { pubkey: feeSchedule, isSigner: false, isWritable: false },        // 17
    { pubkey: feeVault, isSigner: false, isWritable: true },            // 18
    { pubkey: stealthPool, isSigner: false, isWritable: false },        // 19
    { pubkey: tokenPool, isSigner: false, isWritable: true },           // 20
    { pubkey: mint, isSigner: false, isWritable: false },               // 21
    { pubkey: protocolConfig, isSigner: false, isWritable: false },     // 22
    { pubkey: zkVerifyingKey, isSigner: false, isWritable: false },     // 23
    { pubkey: CLOCK_SYSVAR, isSigner: false, isWritable: false },       // 24 clockSysvarAccount
  ];

  // Build VeilPay outer ix data
  const createBufferData = buildShieldedCreateBufferData();
  const depositData = buildShieldedDepositData();
  console.log(`createBufferData size: ${createBufferData.length} bytes`);
  console.log(`depositData size: ${depositData.length} bytes`);

  const outerData = concatBytes(
    PAY_INVOICE_FROM_SHIELDED_DISCRIMINATOR,
    encodeBorshVecU8(createBufferData),
    encodeBorshVecU8(depositData),
    new Uint8Array([createBufferAccounts.length]),
  );
  console.log(`outerData size: ${outerData.length} bytes`);

  const invoicePda = randPubkey();
  const lockPda = randPubkey();

  const veilPayKeys = [
    { pubkey: depositor, isSigner: true, isWritable: true },
    { pubkey: invoicePda, isSigner: false, isWritable: false },
    { pubkey: lockPda, isSigner: false, isWritable: true },
    { pubkey: INVOICE_REGISTRY_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: UMBRA_PROGRAM_ID, isSigner: false, isWritable: false },
    ...createBufferAccounts,
    ...depositAccounts,
  ];
  console.log(`veilPay outer ix account count (with dups): ${veilPayKeys.length}`);

  const veilPayIx = new TransactionInstruction({
    programId: VEIL_PAY_PROGRAM_ID,
    keys: veilPayKeys,
    data: Buffer.from(outerData),
  });

  const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 1_400_000,
  });

  // Connect to fetch ALT (if configured)
  const connection = new Connection(RPC_URL, "confirmed");
  let altAccounts = [];
  if (ALT_ADDRESS) {
    console.log(`Fetching ALT ${ALT_ADDRESS.toBase58()}...`);
    const altResult = await connection.getAddressLookupTable(ALT_ADDRESS);
    if (altResult.value) {
      altAccounts = [altResult.value];
      console.log(`  ALT contains ${altResult.value.state.addresses.length} addresses`);
    } else {
      console.warn("  ALT not fetchable — measuring without ALT (worst case)");
    }
  } else {
    console.warn("NEXT_PUBLIC_VEILPAY_ALT_ADDRESS not set — measuring without ALT (worst case)");
  }

  // Synthetic ALT for "what would savings look like with all-static-keys ALT'd"
  // We construct a hypothetical ALT containing every static address from
  // the full plan. Since we used random pubkeys above for the not-yet-ALT'd
  // accounts (signPda, mxe, mempool, ...), we need to ALT THOSE specific
  // values. So substitute them by adding to the ALT we got from chain.
  const hypotheticalAltAddresses = [
    UMBRA_PROGRAM_ID,
    SYSTEM_PROGRAM,
    INVOICE_REGISTRY_PROGRAM_ID,
    CLOCK_SYSVAR,
    ARCIUM_PROGRAM,
    ARCIUM_POOL,
    ARCIUM_CLOCK,
    signPda,
    mxe,
    mempool,
    executingPool,
    compDef,
    cluster,
    feeSchedule,
    feeVault,
    stealthPool,
    tokenPool,
    mint,
    protocolConfig,
    zkVerifyingKey,
  ];

  // For a realistic measurement, we synthesise an ALT object with these
  // addresses (no actual on-chain account needed for compilation).
  const fakeAltKeypair = Keypair.generate();
  const fakeAlt = {
    key: fakeAltKeypair.publicKey,
    state: {
      deactivationSlot: BigInt("0xffffffffffffffff"),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: depositor,
      addresses: hypotheticalAltAddresses,
    },
    isActive: () => true,
  };

  console.log(`\n=== With FULL hypothetical ALT (${hypotheticalAltAddresses.length} static keys) ===`);
  measureBuild(
    [computeBudgetIx, veilPayIx],
    depositor,
    [fakeAlt],
  );

  console.log(`\n=== With NO ALT (worst case) ===`);
  measureBuild(
    [computeBudgetIx, veilPayIx],
    depositor,
    [],
  );

  if (altAccounts.length > 0) {
    console.log(`\n=== With LIVE ALT only (${altAccounts[0].state.addresses.length} addresses) ===`);
    measureBuild(
      [computeBudgetIx, veilPayIx],
      depositor,
      altAccounts,
    );
  }
}

function measureBuild(instructions, payer, altAccounts) {
  const messageV0 = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: "11111111111111111111111111111111",
    instructions,
  }).compileToV0Message(altAccounts);

  const altWritable = (messageV0.addressTableLookups || []).reduce(
    (n, l) => n + l.writableIndexes.length,
    0,
  );
  const altReadonly = (messageV0.addressTableLookups || []).reduce(
    (n, l) => n + l.readonlyIndexes.length,
    0,
  );

  let serializedSize = null;
  let serializeErr = null;
  try {
    const messageBytes = messageV0.serialize();
    serializedSize = messageBytes.length;
  } catch (e) {
    serializeErr = e.message;
  }

  // Diagnostic — sum of major contributions even if serialize fails.
  // staticAccountKeys: 32 each. ix data + headers approximated.
  const estStaticKeyBytes = messageV0.staticAccountKeys.length * 32;
  const estIxDataBytes = (messageV0.compiledInstructions || []).reduce(
    (s, ix) => s + ix.data.length + ix.accountKeyIndexes.length + 1,
    0,
  );
  const estAltLookupBytes = (messageV0.addressTableLookups || []).reduce(
    (s, l) => s + 32 + 1 + l.writableIndexes.length + 1 + l.readonlyIndexes.length,
    0,
  );

  const summary = {
    serializedMessageBytes: serializedSize,
    serializeErr,
    estSignedTxBytes: serializedSize !== null ? serializedSize + 65 : null,
    underCap1232: serializedSize !== null ? serializedSize + 65 <= 1232 : false,
    headroomBytes: serializedSize !== null ? 1232 - (serializedSize + 65) : null,
    accountKeys: messageV0.staticAccountKeys.length,
    altCount: altAccounts.length,
    altWritable,
    altReadonly,
    instructions: messageV0.compiledInstructions.length,
    estStaticKeyBytes,
    estIxDataBytes,
    estAltLookupBytes,
    estTotalApprox:
      estStaticKeyBytes + estIxDataBytes + estAltLookupBytes + 65 + 50, // 50 for header/blockhash/etc.
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error("\nMeasurement failed:", e);
  process.exit(1);
});
