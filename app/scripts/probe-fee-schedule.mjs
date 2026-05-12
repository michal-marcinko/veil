// Probe: how initialized is the Umbra program on devnet?
//
// We check three things:
//  1. protocolConfig (single program-wide PDA) — if missing, the program
//     was deployed but never initialized at all
//  2. fee_schedule for USDC + DepositIntoStealthPoolFromPublicBalance
//  3. Same as 2 but for wSOL — different mint, in case Umbra only
//     initialized pools for some tokens
//
// Seed bytes lifted directly from the codama-generated builder
// (node_modules/@umbra-privacy/umbra-codama/dist/index.cjs).

import { PublicKey, Connection } from "@solana/web3.js";

const PROGRAM_ID = new PublicKey("DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ");
const RPC_URL = "https://api.devnet.solana.com";

// Candidate mints to probe.
const MINTS = {
  "USDC (Circle devnet)": new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
  "wSOL": new PublicKey("So11111111111111111111111111111111111111112"),
  // Mainnet UMBRA token, just in case it was reused on devnet for testing
  "UMBRA": new PublicKey("PRVT6TB7uss3FrUd2D9xs2zqDBsa3GbMJMwCQsgmeta"),
};

const FEE_SCHEDULE_SEED = Buffer.from([
  219, 103, 184, 147, 198, 147, 112, 38, 55, 38, 235, 215, 80, 203, 76, 46,
  100, 134, 54, 137, 90, 55, 236, 128, 221, 55, 222, 172, 164, 85, 109, 139,
]);
const DEPOSIT_FROM_PUBLIC_INSTR_SEED = Buffer.from([
  94, 35, 209, 185, 160, 81, 246, 69, 49, 174, 241, 12, 73, 248, 43, 89,
]);
const PROTOCOL_CONFIG_SEED = Buffer.from([
  159, 100, 53, 16, 217, 113, 43, 203, 167, 5, 163, 74, 88, 105, 189, 194,
  208, 152, 173, 184, 208, 3, 163, 55, 229, 49, 254, 115, 201, 134, 96, 90,
]);

const conn = new Connection(RPC_URL, "confirmed");

async function check(label, seeds) {
  const [pda] = PublicKey.findProgramAddressSync(seeds, PROGRAM_ID);
  const info = await conn.getAccountInfo(pda);
  const status = info ? `✅ EXISTS (${info.data.length}b, owner ${info.owner.toBase58().slice(0, 8)}...)` : "❌ MISSING";
  console.log(`  ${status}  ${pda.toBase58()}  ${label}`);
  return !!info;
}

async function main() {
  console.log(`Program: ${PROGRAM_ID.toBase58()} (devnet)\n`);

  console.log("=== Program-wide config ===");
  const cfgExists = await check("protocolConfig (single seed)", [PROTOCOL_CONFIG_SEED]);

  if (!cfgExists) {
    console.log("\n⚠️  protocolConfig is missing — the program was deployed but never initialized.");
    console.log("    Nothing else will work. The Umbra team would need to call init.");
    return;
  }

  console.log("\n=== fee_schedule per mint ===");
  for (const [name, mint] of Object.entries(MINTS)) {
    await check(name, [FEE_SCHEDULE_SEED, DEPOSIT_FROM_PUBLIC_INSTR_SEED, mint.toBuffer()]);
  }
}

main().catch((e) => {
  console.error("Probe failed:", e);
  process.exit(1);
});
