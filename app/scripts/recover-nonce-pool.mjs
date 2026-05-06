// recover-nonce-pool.mjs
//
// One-time recovery script for the abandoned durable-nonce-pool experiment.
//
// Background:
//   The Veil project briefly used a per-wallet pool of durable nonce
//   accounts plus a per-wallet Address Lookup Table (ALT) to compress the
//   VeilPay deposit tx into a single Phantom popup. The approach was
//   abandoned because Solana's runtime cannot resolve ALT-referenced
//   accounts when those accounts are owned by an *invoked* program
//   (the Umbra deposit ix invokes inner programs whose account refs
//   bypass the message-level ALT lookup). The tx still ends up 19 bytes
//   over the 1232-byte cap and there is no client-side fix.
//
//   The orphaned artifacts:
//     1. Two durable nonce accounts per wallet (~0.0015 SOL rent each).
//     2. One per-wallet ALT (~0.001 SOL rent).
//
//   The persistence layer used localStorage:
//       key:   "veil:nonce-pool:<wallet-address>"
//       value: JSON { addresses: string[], altAddress?: string }
//
//   This script can't read the user's browser localStorage, so the
//   nonce account pubkeys + ALT address must be supplied via CLI flags
//   or by editing the constants below.
//
// What this script does:
//   1. Loads the user's wallet keypair from ~/.config/solana/id.json
//      (matching `deploy-veilpay-alt.mjs` convention).
//   2. For each nonce account: builds a `withdrawNonceAccount` system ix
//      that drains the full balance back to the wallet, then closes the
//      account (Solana auto-closes a nonce account once its lamport
//      balance drops below rent-exemption — `nonceWithdraw` of the full
//      balance triggers this).
//   3. For the ALT: deactivates it (one tx), waits ~513 slots (the
//      cooldown the runtime requires before an ALT may be closed —
//      this exists to prevent fork-related double-spend attacks where
//      a deactivated table could be re-pointed at a different set of
//      addresses on a competing fork), then closes it (one tx) returning
//      its rent to the wallet.
//   4. Reports total SOL recovered and any failed accounts.
//
// Network:
//   Reads RPC URL from NEXT_PUBLIC_RPC_URL (the project's env var, see
//   app/.env.local) or NEXT_PUBLIC_SOLANA_RPC_URL as a secondary alias,
//   falling back to https://api.devnet.solana.com. The Veil project
//   runs on devnet (verified via app/.env.local:
//   NEXT_PUBLIC_SOLANA_NETWORK=devnet).
//
// Usage:
//   # CLI form (preferred — paste pubkeys you copied from browser console):
//   node scripts/recover-nonce-pool.mjs \
//     --nonces <pk1>,<pk2> \
//     --alt DnzMky5TfyQgYWe2HMz39V7PtN8NDBdkTRudjZZGSUsE
//
//   # Or edit the FILL_ME_IN constants below and run with no flags:
//   node scripts/recover-nonce-pool.mjs
//
//   To grab the nonce pubkeys from the browser:
//     localStorage.getItem(
//       "veil:nonce-pool:2NYXizAU7JmSJwcupqDYkUekby54xk3fcHDahRrfP4Nw"
//     )
//   The returned JSON has `addresses: [pk1, pk2]`.

import {
  AddressLookupTableProgram,
  Connection,
  Keypair,
  NONCE_ACCOUNT_LENGTH,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------
// FILL ME IN — only used when no CLI flags are passed.
//
// Wallet that owned the pool (matches the localStorage key suffix):
const FILL_ME_IN_WALLET = "2NYXizAU7JmSJwcupqDYkUekby54xk3fcHDahRrfP4Nw";
//
// Nonce account pubkeys. Grab via browser console:
//   JSON.parse(localStorage.getItem(
//     "veil:nonce-pool:2NYXizAU7JmSJwcupqDYkUekby54xk3fcHDahRrfP4Nw"
//   )).addresses
const FILL_ME_IN_NONCES = [
  // "<paste nonce account 1 pubkey here>",
  // "<paste nonce account 2 pubkey here>",
];
//
// ALT address (from console logs):
const FILL_ME_IN_ALT = "DnzMky5TfyQgYWe2HMz39V7PtN8NDBdkTRudjZZGSUsE";
// ---------------------------------------------------------------------

// ALT cooldown: the runtime requires ~513 slots between deactivate and
// close (one full epoch's worth of slot history at the time the lookup
// rules were written; see solana-program/src/address_lookup_table.rs).
// At ~400ms/slot on devnet that's roughly 3.5 minutes wall clock.
const ALT_COOLDOWN_SLOTS = 513;
const SLOT_DURATION_MS = 400;

// ---------------------------------------------------------------------
// CLI parsing — `--nonces pk1,pk2 --alt pk` or fall back to constants.
// ---------------------------------------------------------------------

function parseArgs(argv) {
  const out = { nonces: null, alt: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--nonces" && argv[i + 1]) {
      out.nonces = argv[i + 1].split(",").map((s) => s.trim()).filter(Boolean);
      i++;
    } else if (a === "--alt" && argv[i + 1]) {
      out.alt = argv[i + 1].trim();
      i++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function lamportsToSol(lamports) {
  return (lamports / 1e9).toFixed(6);
}

async function withdrawNonce(connection, wallet, nonceAddrStr) {
  // Returns { ok: bool, lamports: number, sig?: string, error?: string }
  let noncePubkey;
  try {
    noncePubkey = new PublicKey(nonceAddrStr);
  } catch (e) {
    return { ok: false, lamports: 0, error: `invalid pubkey: ${e.message}` };
  }

  console.log(`\n[nonce] ${noncePubkey.toBase58()}`);

  // Confirm the account exists, is owned by the System program, and has
  // the expected nonce-account size. If any check fails, skip safely.
  const info = await connection.getAccountInfo(noncePubkey);
  if (!info) {
    console.log("  -> account not found on-chain (already closed?). Skipping.");
    return { ok: false, lamports: 0, error: "account not found" };
  }
  if (!info.owner.equals(SystemProgram.programId)) {
    console.log(
      `  -> owner is ${info.owner.toBase58()}, not SystemProgram. Skipping (not a nonce account).`,
    );
    return { ok: false, lamports: 0, error: "wrong owner" };
  }
  if (info.data.length !== NONCE_ACCOUNT_LENGTH) {
    console.log(
      `  -> data length ${info.data.length} != ${NONCE_ACCOUNT_LENGTH} (nonce). Skipping.`,
    );
    return { ok: false, lamports: 0, error: "wrong data size" };
  }

  console.log(`  balance: ${lamportsToSol(info.lamports)} SOL`);

  // Build the withdraw instruction. Withdrawing the full balance closes
  // the account (System program auto-closes once lamports < rent-exempt
  // minimum; sweeping the full balance trips that condition). Authority
  // for these nonce accounts was the wallet itself (per nonce-pool.ts's
  // `getOrAllocateNonces`).
  const ix = SystemProgram.nonceWithdraw({
    noncePubkey,
    authorizedPubkey: wallet.publicKey,
    toPubkey: wallet.publicKey,
    lamports: info.lamports,
  });

  const tx = new Transaction().add(ix);
  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet], {
      commitment: "confirmed",
    });
    console.log(`  withdraw tx: ${sig}`);
    return { ok: true, lamports: info.lamports, sig };
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
    return { ok: false, lamports: 0, error: e.message };
  }
}

async function deactivateAlt(connection, wallet, altPubkey) {
  console.log(`\n[ALT] deactivating ${altPubkey.toBase58()}`);

  // Pre-check: fetch the ALT to confirm authority + state.
  const altInfo = await connection.getAddressLookupTable(altPubkey);
  if (!altInfo.value) {
    console.log("  -> ALT not fetchable (already closed?). Skipping.");
    return { ok: false, error: "alt not found" };
  }
  const state = altInfo.value.state;
  console.log(`  current state: ${JSON.stringify({
    deactivationSlot: state.deactivationSlot?.toString() ?? "<active>",
    addresses: state.addresses.length,
    authority: state.authority?.toBase58() ?? "<frozen>",
  })}`);

  // If already deactivated, skip the deactivate tx (saves a fee + popup).
  // U64::MAX is the runtime's "active / not deactivated" sentinel; any
  // other value means deactivation is in progress or complete.
  const U64_MAX = 18446744073709551615n;
  if (
    state.deactivationSlot !== undefined &&
    BigInt(state.deactivationSlot.toString()) !== U64_MAX
  ) {
    console.log("  already deactivated, skipping deactivate tx.");
    return {
      ok: true,
      alreadyDeactivated: true,
      deactivationSlot: BigInt(state.deactivationSlot.toString()),
    };
  }

  const ix = AddressLookupTableProgram.deactivateLookupTable({
    lookupTable: altPubkey,
    authority: wallet.publicKey,
  });
  const tx = new Transaction().add(ix);
  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet], {
      commitment: "confirmed",
    });
    console.log(`  deactivate tx: ${sig}`);
    const deactivationSlot = BigInt(await connection.getSlot("confirmed"));
    return { ok: true, deactivationSlot, sig };
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

async function waitForAltCooldown(connection, deactivationSlot) {
  // Solana ALTs require a cooldown window between deactivation and close
  // to defeat fork-related double-spends: if a fork rewinds the slot
  // history, an attacker could re-write the table on the losing fork.
  // The runtime enforces ~513 slots (one slot-hashes window) before
  // `closeLookupTable` accepts the call.
  const targetSlot = deactivationSlot + BigInt(ALT_COOLDOWN_SLOTS);
  console.log(
    `\n[ALT] waiting cooldown — need ${ALT_COOLDOWN_SLOTS} slots from ` +
      `slot ${deactivationSlot} (target ${targetSlot}, ~${
        Math.round((ALT_COOLDOWN_SLOTS * SLOT_DURATION_MS) / 1000)
      }s).`,
  );

  // Poll every ~5s and print remaining slots so the user knows it's alive.
  // We poll because devnet slot times are bursty; sleeping a fixed
  // duration would either undershoot (close fails with
  // "lookup table is not deactivated yet") or oversleep.
  while (true) {
    const current = BigInt(await connection.getSlot("confirmed"));
    const remaining = targetSlot - current;
    if (remaining <= 0n) {
      console.log(`  cooldown reached at slot ${current}.`);
      return;
    }
    const remainingSec = Math.ceil(
      (Number(remaining) * SLOT_DURATION_MS) / 1000,
    );
    console.log(
      `  slot ${current}, ${remaining} slots remaining (~${remainingSec}s).`,
    );
    // 5s poll cadence. Using a hard sleep here is fine — we know we have
    // hundreds of slots to wait through, so polling every slot would just
    // spam the RPC.
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function closeAlt(connection, wallet, altPubkey) {
  console.log(`\n[ALT] closing ${altPubkey.toBase58()}`);

  // Capture rent before close so we can report the recovered amount.
  const accountInfo = await connection.getAccountInfo(altPubkey);
  const lamportsBefore = accountInfo?.lamports ?? 0;

  const ix = AddressLookupTableProgram.closeLookupTable({
    lookupTable: altPubkey,
    authority: wallet.publicKey,
    recipient: wallet.publicKey,
  });
  const tx = new Transaction().add(ix);
  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet], {
      commitment: "confirmed",
    });
    console.log(`  close tx: ${sig}`);
    console.log(
      `  recovered: ${lamportsToSol(lamportsBefore)} SOL (ALT rent)`,
    );
    return { ok: true, lamports: lamportsBefore, sig };
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
    return { ok: false, lamports: 0, error: e.message };
  }
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

async function main() {
  console.log("=== Veil nonce-pool recovery ===");

  // RPC URL — same convention the project uses elsewhere.
  // app/.env.local sets NEXT_PUBLIC_RPC_URL; we also accept
  // NEXT_PUBLIC_SOLANA_RPC_URL as an alias and fall back to public devnet.
  const rpcUrl =
    process.env.NEXT_PUBLIC_RPC_URL ||
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
    "https://api.devnet.solana.com";
  console.log(`RPC: ${rpcUrl}`);

  // Resolve nonce + ALT inputs from CLI flags first, then fall back to
  // the FILL_ME_IN constants near the top of this file.
  const cli = parseArgs(process.argv.slice(2));
  const nonceAddrs =
    cli.nonces && cli.nonces.length > 0 ? cli.nonces : FILL_ME_IN_NONCES;
  const altAddrStr = cli.alt || FILL_ME_IN_ALT;

  if (!nonceAddrs || nonceAddrs.length === 0) {
    console.error(
      "\nNo nonce accounts supplied. Pass --nonces pk1,pk2 OR edit " +
        "FILL_ME_IN_NONCES at the top of this script.",
    );
    console.error(
      "Hint: in the browser console, run\n  " +
        "JSON.parse(localStorage.getItem(\"veil:nonce-pool:" +
        FILL_ME_IN_WALLET +
        "\")).addresses",
    );
    process.exit(1);
  }
  if (!altAddrStr) {
    console.error("No ALT address supplied. Pass --alt <pk> or edit FILL_ME_IN_ALT.");
    process.exit(1);
  }

  // Load wallet (same path as deploy-veilpay-alt.mjs).
  const walletPath = join(homedir(), ".config", "solana", "id.json");
  console.log(`Wallet: ${walletPath}`);
  const secretKeyJson = readFileSync(walletPath, "utf8");
  const secretKey = Uint8Array.from(JSON.parse(secretKeyJson));
  const wallet = Keypair.fromSecretKey(secretKey);
  console.log(`Wallet address: ${wallet.publicKey.toBase58()}`);

  // Sanity: warn loudly if the wallet doesn't match the FILL_ME_IN_WALLET
  // hint. Catches the "ran on wrong machine" footgun.
  if (
    FILL_ME_IN_WALLET &&
    wallet.publicKey.toBase58() !== FILL_ME_IN_WALLET
  ) {
    console.warn(
      `\nWARNING: loaded wallet ${wallet.publicKey.toBase58()} does NOT ` +
        `match FILL_ME_IN_WALLET ${FILL_ME_IN_WALLET}. The recoverable ` +
        `accounts likely belong to a different keypair — proceeding anyway, ` +
        `but expect "Custom program error: 0x4" / "missing required signature".`,
    );
  }

  const connection = new Connection(rpcUrl, "confirmed");

  const startBalance = await connection.getBalance(wallet.publicKey);
  console.log(`Starting balance: ${lamportsToSol(startBalance)} SOL`);

  console.log(`\nNonce accounts to recover (${nonceAddrs.length}):`);
  for (const a of nonceAddrs) console.log(`  - ${a}`);
  console.log(`ALT to recover: ${altAddrStr}`);

  // ---- Phase 1: drain nonce accounts ----
  let totalNonceRecovered = 0;
  const nonceFailures = [];
  for (const addr of nonceAddrs) {
    const r = await withdrawNonce(connection, wallet, addr);
    if (r.ok) totalNonceRecovered += r.lamports;
    else nonceFailures.push({ addr, error: r.error });
  }

  // ---- Phase 2: deactivate ALT ----
  let altPubkey;
  try {
    altPubkey = new PublicKey(altAddrStr);
  } catch (e) {
    console.error(`\nInvalid ALT pubkey: ${e.message}`);
    process.exit(1);
  }
  const deactivateRes = await deactivateAlt(connection, wallet, altPubkey);

  // ---- Phase 3: cooldown + close ALT ----
  let altRecovered = 0;
  let altFailure = null;
  if (deactivateRes.ok) {
    await waitForAltCooldown(connection, deactivateRes.deactivationSlot);
    const closeRes = await closeAlt(connection, wallet, altPubkey);
    if (closeRes.ok) altRecovered = closeRes.lamports;
    else altFailure = closeRes.error;
  } else {
    altFailure = deactivateRes.error;
  }

  // ---- Final report ----
  const endBalance = await connection.getBalance(wallet.publicKey);
  const totalRecovered = totalNonceRecovered + altRecovered;

  console.log("\n===========================================================");
  console.log("Recovery report");
  console.log("===========================================================");
  console.log(`Nonce accounts processed: ${nonceAddrs.length}`);
  console.log(`  succeeded: ${nonceAddrs.length - nonceFailures.length}`);
  console.log(`  failed:    ${nonceFailures.length}`);
  if (nonceFailures.length > 0) {
    for (const f of nonceFailures) {
      console.log(`    - ${f.addr}: ${f.error}`);
    }
  }
  console.log(`Nonce SOL recovered: ${lamportsToSol(totalNonceRecovered)}`);
  console.log(`ALT SOL recovered:   ${lamportsToSol(altRecovered)}`);
  if (altFailure) console.log(`ALT failure:         ${altFailure}`);
  console.log(`-----------------------------------------------------------`);
  console.log(`Total recovered:     ${lamportsToSol(totalRecovered)} SOL`);
  console.log(
    `Wallet delta (incl. tx fees): ${
      lamportsToSol(endBalance - startBalance)
    } SOL`,
  );
  console.log("===========================================================");
}

main().catch((e) => {
  console.error("\nRecovery failed:", e);
  process.exit(1);
});
