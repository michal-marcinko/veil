// Get the EXACT serialised size of the shielded createBuffer + deposit ix
// data via codama's real encoders. We feed bigints / Uint8Arrays per the
// codama field types — the encoder validates each, so this matches what
// the SDK would emit at runtime.

import { readFileSync } from "node:fs";

async function main() {
  const codama = await import("@umbra-privacy/umbra-codama");
  const kit = await import("@solana/kit");

  const programAddress = "DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ";
  const fakeAddress = "11111111111111111111111111111111";
  const noopSigner = kit.createNoopSigner(fakeAddress);

  // Random bigint < 2^256 — for poseidon-hash and rescue-ciphertext fields
  // that codama wraps as bigint.
  function bigU256() {
    let r = 0n;
    for (let i = 0; i < 32; i++) r |= BigInt(Math.floor(Math.random() * 256)) << BigInt(i * 8);
    return r;
  }
  // Limit to 64 bits — codama's u128 helper wraps a u64 codec apparently.
  function bigU128() {
    let r = 0n;
    for (let i = 0; i < 8; i++) r |= BigInt(Math.floor(Math.random() * 256)) << BigInt(i * 8);
    return r;
  }
  function rand(n) {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
    return out;
  }

  // Build the SHIELDED create buffer ix
  const createIx = await codama.getCreateStealthPoolDepositInputBufferInstructionAsync(
    {
      depositor: noopSigner,
      feePayer: noopSigner,
      offset: { first: bigU128() },
      rescueEncryptionPublicKey: { first: rand(32) },
      rescueEncryptionNonce: { first: bigU128() },
      rescueEncryptedTotalAmount: { first: rand(32) },
      rescueEncryptedProtocolFees: { first: rand(32) },
      rescueEncryptedRandomFactorLow: { first: rand(32) },
      rescueEncryptedRandomFactorHigh: { first: rand(32) },
      encryptionValidationPolynomial: { first: rand(32) },
      rescueEncryptionFiatShamirCommitment: { first: rand(32) },
      insertionH2Commitment: { first: rand(32) },
      insertionTimestamp: { first: BigInt(Math.floor(Date.now() / 1000)) },
      linkerEncryption0: { first: rand(32) },
      linkerEncryption1: { first: rand(32) },
      linkerEncryption2: { first: rand(32) },
      keystreamCommitment0: { first: rand(32) },
      keystreamCommitment1: { first: rand(32) },
      keystreamCommitment2: { first: rand(32) },
      groth16ProofA: { first: rand(64) },
      groth16ProofB: { first: rand(128) },
      groth16ProofC: { first: rand(64) },
      aesEncryptedData: { first: rand(96) },
      optionalData: { first: rand(32) },
    },
    { programAddress },
  );

  // Build the SHIELDED v11 deposit ix
  const depIx = await codama.getDepositIntoStealthPoolFromSharedBalanceV11InstructionAsync(
    {
      depositor: noopSigner,
      feePayer: noopSigner,
      mxeAccount: fakeAddress,
      mempoolAccount: fakeAddress,
      executingPool: fakeAddress,
      computationAccount: fakeAddress,
      compDefAccount: fakeAddress,
      clusterAccount: fakeAddress,
      stealthPool: fakeAddress,
      mint: fakeAddress,
      computationOffset: { first: bigU128() },
      mpcCallbackDataOffset: { first: bigU128() },
      feeVaultOffset: { first: bigU128() },
      stealthPoolDepositInputBufferOffset: { first: bigU128() },
      priorityFees: { first: 0n },
    },
    { programAddress },
  );

  console.log("REAL CODAMA-BUILT SIZES:");
  console.log(`  createBuffer ix data: ${createIx.data.length} bytes`);
  console.log(`  createBuffer ix accounts: ${createIx.accounts.length}`);
  console.log(`  deposit ix data: ${depIx.data.length} bytes`);
  console.log(`  deposit ix accounts: ${depIx.accounts.length}`);

  // Show actual createBuffer field byte breakdown
  console.log(`\nBreakdown of shielded createBuffer (${createIx.data.length} bytes):`);
  console.log(`  discriminator:            8`);
  console.log(`  offset (u128):            16`);
  console.log(`  rescueEncryptionPubkey:   32`);
  console.log(`  rescueEncryptionNonce:    16`);
  console.log(`  rescueEncryptedAmount:    32`);
  console.log(`  rescueEncryptedFees:      32`);
  console.log(`  rescueRandomFactorLow:    32`);
  console.log(`  rescueRandomFactorHigh:   32`);
  console.log(`  encryptionValidationPoly: 32`);
  console.log(`  rescueFiatShamirCommit:   32`);
  console.log(`  insertionH2Commit:        32`);
  console.log(`  insertionTimestamp:       8`);
  console.log(`  linkerEncryption0/1/2:    96  (3 × 32)`);
  console.log(`  keystreamCommitment0/1/2: 96  (3 × 32)`);
  console.log(`  groth16ProofA/B/C:        256  (64+128+64)`);
  console.log(`  aesEncryptedData:         96`);
  console.log(`  optionalData:             32`);
  console.log(`  TOTAL:                    876+ (slight padding for codama struct)`);

  // VeilPay outer ix data size:
  const outerSize =
    8 + 4 + createIx.data.length + 4 + depIx.data.length + 1;
  console.log(`  VeilPay outer ix data: ${outerSize} bytes`);

  // Best-case tx: every static account ALT'd. Only per-tx accounts in body.
  // Per-tx: depositor (signer), invoice, lock, VEIL_PAY_PROGRAM (program id),
  //        buffer PDA, computation, computationData, depositorAta, depositorUserAccount.
  // = 9 keys * 32 bytes = 288 bytes
  // ALT lookup overhead: ~30 bytes for key + ~20 indices = ~50 bytes
  // Header (signers, key counts, etc.): ~5 bytes
  // Blockhash: 32 bytes
  // Compact-array length prefixes: ~5 bytes
  // Compute budget ix: ~12 bytes (program-id-index + accts + data)
  // VeilPay outer ix encoded: 1 (program-id-idx) + ~35 (account-key-indices)
  //   + 4 (data-length-varint) + outerSize
  // Signature space: 65 bytes
  const headerEst = 5 + 32 + 5;  // ~42
  const sigEst = 65;
  const veilPayIxEnvelopeEst = 1 + 35 + 4 + outerSize;
  const computeBudgetEst = 12;
  const altOverheadEst = 50;
  const staticKeysEst = 9 * 32;
  const bestCaseTotal =
    headerEst + sigEst + staticKeysEst + altOverheadEst +
    veilPayIxEnvelopeEst + computeBudgetEst;
  console.log(`\n=== BEST CASE (every static key ALT'd) ===`);
  console.log(`  Estimated signed-tx size: ${bestCaseTotal} bytes`);
  console.log(`  Cap: 1232 bytes`);
  console.log(`  Headroom: ${1232 - bestCaseTotal} bytes`);
  console.log(`  Under cap: ${bestCaseTotal <= 1232 ? "YES" : "NO"}`);

  console.log(`\n=== Breakdown ===`);
  console.log(`  Header + blockhash:        ${headerEst}`);
  console.log(`  Static keys (per-tx):      ${staticKeysEst}`);
  console.log(`  ALT overhead:              ${altOverheadEst}`);
  console.log(`  Compute budget ix:         ${computeBudgetEst}`);
  console.log(`  VeilPay outer ix envelope: ${veilPayIxEnvelopeEst}`);
  console.log(`    └── outer data only:     ${outerSize}`);
  console.log(`  Signature:                 ${sigEst}`);
  console.log(`  TOTAL:                     ${bestCaseTotal}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
