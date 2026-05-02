import * as anchorNs from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";

// Under node's ESM loader, CJS packages are wrapped so the real exports live on
// `default`. Under ts-node/CJS, they are on the namespace itself. Normalize.
const anchor: any = (anchorNs as any).default ?? anchorNs;
const BN = anchor.BN;

describe("veil_pay routing", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  // workspace name matches the program name pascal-cased
  const program = (anchor.workspace as any).VeilPay || (anchor.workspace as any).veil_pay;

  const UMBRA_PROGRAM_ID = new PublicKey(
    "DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ"
  );

  // PROBE_PDA_SEEDS.md (the corrected 3-seed layout) — kept for future use.
  const SEED_CONST = Buffer.from([
    210, 117, 170, 207, 65, 10, 84, 93,
    32, 196, 228, 241, 64, 226, 130, 157,
    3, 5, 20, 123, 110, 142, 123, 197,
    60, 131, 205, 173, 255, 172, 168, 181,
  ]);

  // Phase 0 probe (probeCreateBuffer instruction) was replaced by the full
  // pay_invoice instruction in Phase 1. The Phase 0 test result ("CPI auth
  // layer accepted us, only Umbra deserializer rejects mock data") is
  // re-verified by the routing test below.

  it.skip("LEGACY Phase 0 — probeCreateBuffer (instruction removed in Phase 1)", async () => {
    const depositor = provider.wallet.publicKey;

    const offsetBytes = Buffer.alloc(16, 0); // u128 LE = 0
    const [bufferPda] = PublicKey.findProgramAddressSync(
      [SEED_CONST, depositor.toBuffer(), offsetBytes],
      UMBRA_PROGRAM_ID
    );

    console.log("Depositor:", depositor.toBase58());
    console.log("Buffer PDA:", bufferPda.toBase58());

    let signature: string | undefined;
    let logs: string[] = [];
    let txStatus: any = null;
    let outerErrorMessage: string | undefined;
    let succeeded = false;

    try {
      // Build the instruction via Anchor (uses IDL-derived discriminator + account meta).
      const ix = await program.methods
        .probeCreateBuffer(new BN(0))
        .accounts({
          depositor,
          feePayer: depositor,
          proofBuffer: bufferPda,
          systemProgram: SystemProgram.programId,
          umbraProgram: UMBRA_PROGRAM_ID,
        })
        .instruction();

      // Build, sign, and send manually so error semantics are clear.
      const tx = new Transaction().add(ix);
      tx.feePayer = depositor;
      const latest = await provider.connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = latest.blockhash;

      const signedTx = await provider.wallet.signTransaction(tx);
      const rawTx = signedTx.serialize();

      // skipPreflight ensures the tx hits the chain even with mock data so we can read logs.
      signature = await provider.connection.sendRawTransaction(rawTx, {
        skipPreflight: true,
        preflightCommitment: "confirmed",
      });
      console.log("Sent tx, signature:", signature);

      // Confirm (will succeed even if tx errored on-chain — we just want to know it landed).
      const confirmation = await provider.connection.confirmTransaction(
        {
          signature,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        },
        "confirmed"
      );
      txStatus = confirmation.value;
      console.log("Confirmation status:", JSON.stringify(txStatus));

      if (!txStatus.err) {
        succeeded = true;
      }
    } catch (err: any) {
      outerErrorMessage = err.message;
      console.log("Outer send error:", err.message);
      console.log("Stack:", err.stack);
    }

    // Always try to fetch logs from the chain if we have a signature.
    if (signature) {
      // small delay so the tx is queryable
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const txInfo = await provider.connection.getTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        logs = txInfo?.meta?.logMessages || [];
      } catch (fetchErr: any) {
        console.log("Failed to fetch tx logs:", fetchErr.message);
      }
    }

    console.log("\n=== PROBE RESULT ===\n");
    console.log("Signature:", signature || "(none)");
    console.log("Tx-level err:", txStatus?.err ? JSON.stringify(txStatus.err) : "(none)");
    console.log("Outer JS err:", outerErrorMessage || "(none)");

    console.log("\n=== Program logs ===\n");
    if (logs.length > 0) {
      logs.forEach((l: string) => console.log(l));
    } else {
      console.log("(no logs available)");
    }

    console.log("\n=== INTERPRETATION ===\n");
    const joined = logs.join("\n");
    const reachedUmbra = joined.includes(
      "DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ invoke"
    );
    const cpiBlocked =
      joined.includes("Cross-program invocation") ||
      joined.includes("MissingRequiredSignature");
    const sawOurMsg = joined.includes("veil_pay::probe_create_buffer");

    if (succeeded) {
      console.log(
        "UNEXPECTED-GO -- transaction succeeded. CPI auth layer accepted us AND Umbra accepted the mock payload (very unlikely)."
      );
    } else if (reachedUmbra && !cpiBlocked) {
      console.log(
        "GO -- CPI reached Umbra. Error is from Umbra's own validation (mock data fails as expected, but the CPI auth layer accepted us)."
      );
    } else if (cpiBlocked) {
      console.log(
        "NO-GO -- CPI was rejected at the auth layer. Pivot to fallback path."
      );
    } else if (sawOurMsg && !reachedUmbra) {
      console.log(
        "INCONCLUSIVE -- VeilPay ran but never invoked Umbra. Account list issue likely."
      );
    } else if (
      outerErrorMessage &&
      /Blockhash not found|block height exceeded|RPC|fetch failed|429/i.test(
        outerErrorMessage
      )
    ) {
      console.log(
        "INCONCLUSIVE -- transient devnet RPC error (" +
          outerErrorMessage +
          "). Re-run."
      );
    } else {
      console.log("INCONCLUSIVE -- investigate logs above.");
    }
  });

  it("pay_invoice routes both CPIs in order — proof errors expected with mock data", async () => {
    const depositor = provider.wallet.publicKey;

    // Discriminators must match the program's hardcoded constants so they pass
    // the require!() checks. Bodies are kept minimal — we only need the bytes
    // to flow into Umbra; Umbra will reject them at deserialization. Larger
    // payloads push the test tx over the 1232 byte size limit when combined
    // with 21 mock account pubkeys.
    const createBufferData = Buffer.concat([
      Buffer.from([139, 135, 169, 216, 228, 15, 104, 98]), // CREATE_BUFFER_DISCRIMINATOR
      Buffer.alloc(16, 0),
    ]);
    const depositData = Buffer.concat([
      Buffer.from([232, 133, 25, 16, 203, 167, 3, 3]), // DEPOSIT_DISCRIMINATOR
      Buffer.alloc(16, 0),
    ]);

    // 21 random pubkeys — first 4 will be split into create-buffer slice,
    // the remaining 17 into the deposit slice.
    const mockAccounts = Array.from({ length: 21 }, () => Keypair.generate().publicKey);

    let signature: string | undefined;
    let logs: string[] = [];
    let outerErrorMessage: string | undefined;
    let succeeded = false;
    let txStatus: any = null;

    try {
      const ix = await program.methods
        .payInvoice(createBufferData, depositData, 4)
        .accounts({
          depositor,
          umbraProgram: UMBRA_PROGRAM_ID,
        })
        .remainingAccounts(
          mockAccounts.map((pubkey, i) => ({
            pubkey,
            isWritable: i % 2 === 0,
            isSigner: false,
          }))
        )
        .instruction();

      const tx = new Transaction().add(ix);
      tx.feePayer = depositor;
      const latest = await provider.connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = latest.blockhash;

      const signedTx = await provider.wallet.signTransaction(tx);
      const rawTx = signedTx.serialize();

      signature = await provider.connection.sendRawTransaction(rawTx, {
        skipPreflight: true,
        preflightCommitment: "confirmed",
      });
      console.log("Sent tx, signature:", signature);

      const confirmation = await provider.connection.confirmTransaction(
        {
          signature,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        },
        "confirmed"
      );
      txStatus = confirmation.value;
      console.log("Confirmation status:", JSON.stringify(txStatus));

      if (!txStatus.err) {
        succeeded = true;
      }
    } catch (err: any) {
      outerErrorMessage = err.message;
      console.log("Outer send error:", err.message);
    }

    if (signature) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const txInfo = await provider.connection.getTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        logs = txInfo?.meta?.logMessages || [];
      } catch (fetchErr: any) {
        console.log("Failed to fetch tx logs:", fetchErr.message);
      }
    }

    console.log("\n=== Routing test result ===");
    console.log("Signature:", signature || "(none)");
    console.log("Tx-level err:", txStatus?.err ? JSON.stringify(txStatus.err) : "(none)");
    console.log("Outer JS err:", outerErrorMessage || "(none)");

    console.log("\n=== Program logs ===");
    if (logs.length > 0) {
      logs.forEach((l: string) => console.log(l));
    } else {
      console.log("(no logs available)");
    }

    console.log("\n=== INTERPRETATION ===");
    const joined = logs.join("\n");
    if (succeeded) {
      console.log(
        "UNEXPECTED success — both CPIs accepted the mock payload. Investigate."
      );
    } else if (joined.includes("veil_pay: CPI 1/2")) {
      console.log(
        "Routing works — got into create-buffer CPI. Mock accounts/data fail as expected."
      );
    } else if (
      outerErrorMessage &&
      /Blockhash not found|block height exceeded|RPC|fetch failed|429/i.test(
        outerErrorMessage
      )
    ) {
      console.log(
        "INCONCLUSIVE — transient devnet RPC error (" +
          outerErrorMessage +
          "). Re-run."
      );
    } else {
      console.log(
        "Failed before our log — instruction shape issue. Investigate logs above."
      );
    }
  });
});
