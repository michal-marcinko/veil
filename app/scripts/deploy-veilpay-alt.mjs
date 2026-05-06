// deploy-veilpay-alt.mjs
//
// Deploy an Address Lookup Table (ALT) for VeilPay's single-popup pay
// flow on devnet. The pay tx (payInvoiceCpi.ts) is currently 252 bytes
// over Solana's 1232-byte cap with 19 unique account keys; ALT-ing the
// static + mint-specific accounts saves ~280-310 bytes (each key drops
// from 32 bytes in the message body to a 1-byte index).
//
// =====================================================================
// ACCOUNT CLASSIFICATION (verified against codama-generated builders
// in node_modules/@umbra-privacy/umbra-codama/dist/index.cjs)
// =====================================================================
//
// createBuffer ix (4 accounts):
//   1. depositor                            PER-USER
//   2. feePayer (== depositor)              PER-USER (dedup)
//   3. publicStealthPoolDepositInputBuffer  PER-TX  (PDA: depositor + offset)
//   4. systemProgram                        STATIC
//
// deposit ix (17 accounts):
//   1. feePayer                             PER-USER (dedup)
//   2. depositor                            PER-USER (dedup)
//   3. publicStealthPoolDepositInputBuffer  PER-TX   (dedup)
//   4. depositorAta                         PER-USER (depositor + mint)
//   5. depositorUserAccount                 PER-USER (depositor)
//   6. feeSchedule                          STATIC*  (per-mint, devnet wSOL only)
//   7. feeVault                             STATIC*
//   8. tokenPool                            STATIC*
//   9. tokenPoolSplAta                      STATIC*  (mint-specific PDA)
//  10. stealthPool                          STATIC   (index 0, no mint)
//  11. mint                                 STATIC*  (devnet wSOL only)
//  12. protocolConfig                       STATIC
//  13. zeroKnowledgeVerifyingKey            STATIC
//  14. tokenProgram                         STATIC   (SPL Token)
//  15. associatedTokenProgram               STATIC
//  16. systemProgram                        STATIC   (dedup w/ createBuffer's)
//  17. clock                                STATIC
//
// VeilPay outer ix adds:
//   - depositor (signer)                    PER-USER
//   - umbra_program                         STATIC
//
// (*) STATIC for our use case: devnet-only, wSOL-only mint. If we add
//     another mint or move to mainnet, we redeploy the ALT.
//
// ALT'd accounts (13):
//   1. UMBRA_PROGRAM_ID
//   2. systemProgram
//   3. tokenProgram (SPL Token)
//   4. associatedTokenProgram
//   5. clock sysvar
//   6. mint (wSOL)
//   7. feeSchedule PDA
//   8. feeVault PDA
//   9. tokenPool PDA
//  10. tokenPoolSplAta PDA
//  11. stealthPool PDA (index 0)
//  12. protocolConfig PDA
//  13. zeroKnowledgeVerifyingKey PDA
//
// Per-user / per-tx accounts (stay in message body):
//   - depositor
//   - depositorAta
//   - depositorUserAccount PDA
//   - publicStealthPoolDepositInputBuffer PDA
//   - VEIL_PAY_PROGRAM_ID (program ID, stays for instruction routing)
//
// Estimated savings: 13 ALT'd keys * (32-1) = 403 bytes minus the v0
// message ALT lookup overhead (~30 bytes for the lookup table address +
// writable/readonly index counts). Net savings ~360-380 bytes; budget
// shortfall is 252, so we land ~100-130 bytes under cap.
//
// =====================================================================
//
// Usage:
//   cd app && node scripts/deploy-veilpay-alt.mjs
//
// Prints the ALT address; user copies into .env.local as
// NEXT_PUBLIC_VEILPAY_ALT_ADDRESS=...

import {
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------

const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL || "https://api.devnet.solana.com";

const UMBRA_PROGRAM_ID = new PublicKey(
  "DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ",
);
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

// Native programs / sysvars
const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");
const SPL_TOKEN_PROGRAM = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);
const CLOCK_SYSVAR = new PublicKey(
  "SysvarC1ock11111111111111111111111111111111",
);

// Seed bytes lifted verbatim from
// node_modules/@umbra-privacy/umbra-codama/dist/index.cjs (deposit ix).
const FEE_SCHEDULE_SEED = Buffer.from([
  219, 103, 184, 147, 198, 147, 112, 38, 55, 38, 235, 215, 80, 203, 76, 46,
  100, 134, 54, 137, 90, 55, 236, 128, 221, 55, 222, 172, 164, 85, 109, 139,
]);
const FEE_VAULT_SEED = Buffer.from([
  179, 37, 45, 22, 96, 77, 187, 83, 214, 27, 136, 248, 186, 191, 16, 30, 30,
  8, 127, 147, 114, 194, 122, 73, 33, 5, 236, 62, 239, 130, 207, 221,
]);
// "DepositIntoStealthPoolFromPublicBalance" instruction discriminator seed
// (used by both fee_schedule and fee_vault PDAs).
const DEPOSIT_FROM_PUBLIC_INSTR_SEED = Buffer.from([
  94, 35, 209, 185, 160, 81, 246, 69, 49, 174, 241, 12, 73, 248, 43, 89,
]);
// Bytes between FEE_VAULT_SEED and the instr seed in the fee_vault PDA.
const FEE_VAULT_MID_SEED = Buffer.from([
  3, 90, 193, 96, 232, 76, 253, 129, 5, 160, 193, 17, 1, 189, 78, 77, 218,
  76, 91, 45, 152, 246, 251, 5, 111, 22, 232, 53, 164, 66, 26, 145,
]);
const TOKEN_POOL_SEED = Buffer.from([
  61, 21, 254, 10, 117, 50, 210, 47, 122, 79, 232, 171, 118, 26, 22, 118,
  205, 174, 242, 211, 17, 197, 198, 61, 164, 43, 231, 196, 167, 221, 63, 210,
]);
const PROTOCOL_CONFIG_SEED = Buffer.from([
  159, 100, 53, 16, 217, 113, 43, 203, 167, 5, 163, 74, 88, 105, 189, 194,
  208, 152, 173, 184, 208, 3, 163, 55, 229, 49, 254, 115, 201, 134, 96, 90,
]);
const ZK_VERIFYING_KEY_SEED = Buffer.from([
  21, 6, 250, 31, 203, 58, 71, 108, 43, 66, 148, 27, 192, 251, 191, 254, 26,
  201, 104, 72, 178, 98, 139, 142, 82, 165, 233, 148, 55, 207, 220, 7,
]);
// stealthPool PDA seed: sha256("StealthPool"). Per
// node_modules/@umbra-privacy/sdk/dist/chunk-UEI7SYH6.cjs:
//   var STEALTH_POOL_SEED = computeStructSeed("StealthPool");  // sha256
//   findStealthPoolPda(index, programId)
//     -> getProgramDerivedAddress({ seeds: [STEALTH_POOL_SEED, u128le(index)] })
const STEALTH_POOL_SEED = createHash("sha256").update("StealthPool").digest();

// Account-offset encoding helper: codama encodes account offset (u128) as a
// fixed 16-byte LE blob in seeds. The `feeVaultOffset` in our pay ix is
// always 0n.
function encodeOffsetU128(value) {
  const buf = Buffer.alloc(16);
  let remaining = value;
  for (let i = 0; i < 16; i++) {
    buf[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return buf;
}

// ---------------------------------------------------------------------
// PDA derivation
// ---------------------------------------------------------------------

function findPda(seeds, programId) {
  const [pda] = PublicKey.findProgramAddressSync(seeds, programId);
  return pda;
}

function deriveStealthPoolPda(index) {
  // index 0 → 16 LE zero bytes, matching the SDK's encodeU128ToU128LeBytes(0n).
  const indexBuf = encodeOffsetU128(index);
  return findPda([STEALTH_POOL_SEED, indexBuf], UMBRA_PROGRAM_ID);
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

async function main() {
  console.log("=== Veil Pay ALT deploy ===");
  console.log(`RPC: ${RPC_URL}`);

  // Load wallet
  const walletPath = join(homedir(), ".config", "solana", "id.json");
  console.log(`Wallet: ${walletPath}`);
  const secretKeyJson = readFileSync(walletPath, "utf8");
  const secretKey = Uint8Array.from(JSON.parse(secretKeyJson));
  const wallet = Keypair.fromSecretKey(secretKey);
  console.log(`Wallet address: ${wallet.publicKey.toBase58()}`);

  const connection = new Connection(RPC_URL, "confirmed");

  // Sanity: balance
  const balance = await connection.getBalance(wallet.publicKey);
  console.log(`Balance: ${(balance / 1e9).toFixed(4)} SOL`);
  if (balance < 0.01 * 1e9) {
    console.error("Insufficient SOL — need at least 0.01 SOL for ALT rent.");
    process.exit(1);
  }

  // ---- Compute the addresses we'll ALT ----
  console.log("\n--- Deriving PDAs ---");

  const feeSchedulePda = findPda(
    [FEE_SCHEDULE_SEED, DEPOSIT_FROM_PUBLIC_INSTR_SEED, WSOL_MINT.toBuffer()],
    UMBRA_PROGRAM_ID,
  );
  console.log(`feeSchedule: ${feeSchedulePda.toBase58()}`);

  const feeVaultPda = findPda(
    [
      FEE_VAULT_SEED,
      FEE_VAULT_MID_SEED,
      DEPOSIT_FROM_PUBLIC_INSTR_SEED,
      WSOL_MINT.toBuffer(),
      encodeOffsetU128(0n),
    ],
    UMBRA_PROGRAM_ID,
  );
  console.log(`feeVault: ${feeVaultPda.toBase58()}`);

  const tokenPoolPda = findPda(
    [TOKEN_POOL_SEED, WSOL_MINT.toBuffer()],
    UMBRA_PROGRAM_ID,
  );
  console.log(`tokenPool: ${tokenPoolPda.toBase58()}`);

  // tokenPoolSplAta is an associated-token-account PDA with the
  // ATokenGPv... program: seeds = [tokenPool, tokenProgram, mint]
  const tokenPoolSplAtaPda = findPda(
    [
      tokenPoolPda.toBuffer(),
      SPL_TOKEN_PROGRAM.toBuffer(),
      WSOL_MINT.toBuffer(),
    ],
    ASSOCIATED_TOKEN_PROGRAM,
  );
  console.log(`tokenPoolSplAta: ${tokenPoolSplAtaPda.toBase58()}`);

  const protocolConfigPda = findPda(
    [PROTOCOL_CONFIG_SEED],
    UMBRA_PROGRAM_ID,
  );
  console.log(`protocolConfig: ${protocolConfigPda.toBase58()}`);

  const zkVerifyingKeyPda = findPda(
    [ZK_VERIFYING_KEY_SEED, DEPOSIT_FROM_PUBLIC_INSTR_SEED],
    UMBRA_PROGRAM_ID,
  );
  console.log(`zkVerifyingKey: ${zkVerifyingKeyPda.toBase58()}`);

  const stealthPoolPda = deriveStealthPoolPda(0n);
  console.log(`stealthPool (index 0): ${stealthPoolPda.toBase58()}`);

  // Sanity: confirm at least the most-load-bearing PDAs actually exist
  // on-chain. If any is missing, the ALT is still deployable but the pay
  // tx will fail; warn but proceed.
  console.log("\n--- Sanity-checking PDAs on-chain ---");
  for (const [label, pk] of [
    ["feeSchedule", feeSchedulePda],
    ["feeVault", feeVaultPda],
    ["tokenPool", tokenPoolPda],
    ["tokenPoolSplAta", tokenPoolSplAtaPda],
    ["protocolConfig", protocolConfigPda],
    ["zkVerifyingKey", zkVerifyingKeyPda],
    ["stealthPool", stealthPoolPda],
  ]) {
    const info = await connection.getAccountInfo(pk);
    const status = info ? `EXISTS (${info.data.length}b)` : "MISSING";
    console.log(`  ${status.padEnd(25)} ${label}: ${pk.toBase58()}`);
  }

  // ---- Final ALT address list (order doesn't matter for substitution) ----
  const altAddresses = [
    UMBRA_PROGRAM_ID,
    SYSTEM_PROGRAM,
    SPL_TOKEN_PROGRAM,
    ASSOCIATED_TOKEN_PROGRAM,
    CLOCK_SYSVAR,
    WSOL_MINT,
    feeSchedulePda,
    feeVaultPda,
    tokenPoolPda,
    tokenPoolSplAtaPda,
    stealthPoolPda,
    protocolConfigPda,
    zkVerifyingKeyPda,
  ];
  console.log(`\nALT will hold ${altAddresses.length} addresses.`);

  // ---- Tx 1: createLookupTable ----
  console.log("\n--- Creating lookup table ---");
  const slot = await connection.getSlot("finalized");
  console.log(`Recent finalized slot: ${slot}`);

  const [createIx, lookupTableAddress] =
    AddressLookupTableProgram.createLookupTable({
      authority: wallet.publicKey,
      payer: wallet.publicKey,
      recentSlot: slot,
    });
  console.log(`Lookup table address: ${lookupTableAddress.toBase58()}`);

  const createTx = new Transaction().add(createIx);
  const createSig = await sendAndConfirmTransaction(connection, createTx, [
    wallet,
  ], { commitment: "confirmed" });
  console.log(`Create tx: ${createSig}`);

  // ---- Tx 2: extendLookupTable ----
  console.log("\n--- Extending lookup table ---");
  const extendIx = AddressLookupTableProgram.extendLookupTable({
    payer: wallet.publicKey,
    authority: wallet.publicKey,
    lookupTable: lookupTableAddress,
    addresses: altAddresses,
  });
  const extendTx = new Transaction().add(extendIx);
  const extendSig = await sendAndConfirmTransaction(connection, extendTx, [
    wallet,
  ], { commitment: "confirmed" });
  console.log(`Extend tx: ${extendSig}`);

  // ---- Wait for activation + verify ----
  console.log("\n--- Verifying ALT is fetchable ---");
  // ALT activation takes ~1 slot after extend. Poll up to 30s.
  const startMs = Date.now();
  let altAccount = null;
  while (Date.now() - startMs < 30_000) {
    const result = await connection.getAddressLookupTable(lookupTableAddress);
    if (result.value) {
      altAccount = result.value;
      break;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!altAccount) {
    console.error(
      "ALT was not fetchable after 30s. Devnet activation lag — wait a minute and retry getAddressLookupTable.",
    );
    console.error(`ALT address: ${lookupTableAddress.toBase58()}`);
    process.exit(1);
  }
  console.log(`ALT fetched OK. Contains ${altAccount.state.addresses.length} addresses.`);

  // ---- Final report ----
  console.log("\n===========================================================");
  console.log("ALT deployed successfully.");
  console.log(`Address: ${lookupTableAddress.toBase58()}`);
  console.log(`Addresses in table: ${altAccount.state.addresses.length}`);
  console.log("");
  console.log("Add to app/.env.local:");
  console.log(`  NEXT_PUBLIC_VEILPAY_ALT_ADDRESS=${lookupTableAddress.toBase58()}`);
  console.log("===========================================================");
}

main().catch((e) => {
  console.error("\nALT deploy failed:", e);
  process.exit(1);
});
