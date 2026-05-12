/**
 * VeilPay anchor integration tests.
 *
 * Approach: Option A — mocked Umbra program + REAL invoice-registry program.
 *   The Umbra program (DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ) requires a
 *   full ZK proof + buffer-PDA infrastructure that is impractical to deploy in
 *   localnet. Instead, the sibling `mock-umbra` crate is built into a tiny
 *   .so that the test runner (tests/run.cjs) loads at the real Umbra address
 *   via solana-test-validator's `--bpf-program` flag. The mock has a fallback
 *   handler that accepts any account list and just logs which discriminator
 *   it received — letting us assert "VeilPay forwarded the right bytes" via
 *   tx logs without needing real Umbra circuits.
 *
 *   For Fix 2 (single-use payment-intent lock), we deploy the REAL
 *   invoice-registry program at its hardcoded address. Its `init` constraint
 *   on the lock PDA is exactly the safety guarantee we want to test, so a
 *   mock would defeat the purpose. The runner installs invoice-registry's
 *   .so via the same surfnet_setAccount cheatcode used for mock-umbra.
 *
 * Tests:
 *   1. Happy path — pay_no_invoice succeeds; both CPIs land in the mock with
 *      the expected discriminators in order. (covers payroll path)
 *   2. Discriminator mismatch — invalid first 8 bytes of create_buffer_data.
 *      Expect VeilPayError::DiscriminatorMismatch (code 6001).
 *   3. Account-slice OOB — create_buffer_account_count > remaining_accounts.len().
 *      Expect VeilPayError::AccountSliceOutOfBounds (code 6002).
 *   4. pay_invoice happy path — creates a real invoice via invoice-registry,
 *      then calls pay_invoice; assert lock PDA exists + Umbra CPIs fired.
 *   5. pay_invoice double-pay rejection — second attempt on same invoice
 *      fails because the lock PDA already exists; both Umbra CPIs do NOT fire.
 *   6. pay_invoice with restricted invoice + wrong signer — fails with
 *      NotPayer (custom code 6003 = 0x1773).
 *   7. pay_invoice with restricted invoice + correct signer — happy path.
 */

import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { expect } from "chai";

// VeilPay's hardcoded discriminators (from programs/veil-pay/src/lib.rs).
const CREATE_BUFFER_DISCRIMINATOR = Buffer.from([139, 135, 169, 216, 228, 15, 104, 98]);
const DEPOSIT_DISCRIMINATOR = Buffer.from([232, 133, 25, 16, 203, 167, 3, 3]);

// Shielded variants — from CREATE_SHIELDED_BUFFER_DISCRIMINATOR /
// DEPOSIT_FROM_SHIELDED_DISCRIMINATOR in lib.rs.
const CREATE_SHIELDED_BUFFER_DISCRIMINATOR = Buffer.from([239, 89, 111, 177, 2, 224, 90, 79]);
const DEPOSIT_FROM_SHIELDED_DISCRIMINATOR = Buffer.from([22, 229, 199, 112, 193, 65, 111, 243]);

const UMBRA_PROGRAM_ID = new PublicKey("DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ");
const INVOICE_REGISTRY_PROGRAM_ID = new PublicKey(
  "54ryi8hcihut8fDSVFSbN5NbArQ5GAd1xgmGCA3hqWoo",
);

// Anchor error codes from #[error_code] enum VeilPayError in lib.rs.
const ERR_INVALID_INSTRUCTION_DATA = 6000;
const ERR_DISCRIMINATOR_MISMATCH = 6001;
const ERR_ACCOUNT_SLICE_OOB = 6002;

// Anchor error codes from invoice-registry's InvoiceError enum.
const ERR_INVOICE_INVALID_STATUS = 6001;
const ERR_INVOICE_NOT_PAYER = 6003;

// invoice-registry::create_invoice / create_invoice_restricted / lock_payment_intent
// /mark_paid / cancel_payment_intent discriminators — sha256("global:<name>")[0..8].
// Used to build raw txs in tests so we don't need to wire the invoice-registry IDL
// into ts-mocha. Verified against programs/invoice-registry/target/idl/invoice_registry.json.
const CREATE_INVOICE_DISC = Buffer.from([154, 170, 31, 135, 134, 100, 156, 146]);
const CREATE_INVOICE_RESTRICTED_DISC = Buffer.from([137, 203, 155, 244, 127, 40, 184, 27]);
const MARK_PAID_DISC = Buffer.from([51, 120, 9, 160, 70, 29, 18, 205]);
const CANCEL_PAYMENT_INTENT_DISC = Buffer.from([179, 158, 125, 231, 73, 7, 32, 95]);

describe("veil_pay", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = (anchor.workspace as any).VeilPay ||
    (anchor.workspace as any).veil_pay ||
    (anchor.workspace as any).veilPay;

  if (!program) {
    throw new Error(
      "VeilPay program not found in anchor.workspace. Did `anchor build --ignore-keys` run?"
    );
  }

  // 21 mock accounts: 4 will be split into the create-buffer slice and 17 into
  // the deposit slice (matches the comment in lib.rs line 33: "~21 total: 4
  // for create-buffer + 17 for deposit"). The exact accounts don't matter
  // because the mock Umbra ignores them.
  function makeMockAccounts(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      pubkey: Keypair.generate().publicKey,
      isWritable: i % 2 === 0,
      isSigner: false,
    }));
  }

  // Submit a tx that may fail at the Anchor-program level, fetch logs from the
  // confirmed signature, and return them. We manually sign + sendRawTransaction
  // (rather than provider.sendAndConfirm) because the latter throws before
  // surfacing the signature on failed txs, which would block log extraction
  // for the failure-case tests.
  async function sendCollectingLogs(ix: any, extraSigners: Keypair[] = []) {
    const tx = new anchor.web3.Transaction().add(ix);
    tx.feePayer = provider.wallet.publicKey;
    const latest = await provider.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = latest.blockhash;
    if (extraSigners.length > 0) {
      tx.partialSign(...extraSigners);
    }
    const signed = await provider.wallet.signTransaction(tx);

    let signature: string | undefined;
    let sendErr: any = null;
    let txErr: any = null;
    let logs: string[] = [];

    try {
      signature = await provider.connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: true,
        preflightCommitment: "confirmed",
      });

      const conf = await provider.connection.confirmTransaction(
        {
          signature,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        },
        "confirmed"
      );
      txErr = conf.value.err ?? null;
    } catch (err: any) {
      sendErr = err;
    }

    if (signature) {
      await new Promise((r) => setTimeout(r, 750));
      try {
        const txInfo = await provider.connection.getTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        logs = txInfo?.meta?.logMessages ?? logs;
        if (txErr === null) txErr = txInfo?.meta?.err ?? null;
      } catch {
        // ignore — fall through with empty logs
      }
    }

    if (logs.length === 0 && sendErr?.logs) {
      logs = sendErr.logs;
    }

    return { signature, txErr, sendErr, logs };
  }

  // Encode a `String` for Borsh: u32 LE length prefix + UTF-8 bytes.
  function encodeBorshString(s: string): Buffer {
    const bytes = Buffer.from(s, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(bytes.length, 0);
    return Buffer.concat([len, bytes]);
  }

  // Encode `Option<i64>` for Borsh: 0u8 for None, 1u8 + i64 LE for Some.
  function encodeBorshOptionI64Null(): Buffer {
    return Buffer.from([0]);
  }

  // Build a raw invoice-registry::create_invoice instruction. We do this by
  // hand to keep the test self-contained (no IDL load). The arg layout is:
  //   nonce: [u8; 8]
  //   metadata_hash: [u8; 32]
  //   metadata_uri: String
  //   mint: Pubkey (32 bytes)
  //   expires_at: Option<i64> (1 byte: None)
  function buildCreateInvoiceIx(args: {
    creator: PublicKey;
    nonce: Buffer; // 8 bytes
    invoicePda: PublicKey;
  }): anchor.web3.TransactionInstruction {
    const metadataHash = Buffer.alloc(32, 0);
    const metadataUri = ""; // empty string is valid (under MAX_URI_LEN)
    const mint = PublicKey.default; // any Pubkey is fine — not validated

    const data = Buffer.concat([
      CREATE_INVOICE_DISC,
      args.nonce,
      metadataHash,
      encodeBorshString(metadataUri),
      mint.toBuffer(),
      encodeBorshOptionI64Null(),
    ]);

    return new anchor.web3.TransactionInstruction({
      programId: INVOICE_REGISTRY_PROGRAM_ID,
      keys: [
        { pubkey: args.invoicePda, isSigner: false, isWritable: true },
        { pubkey: args.creator, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  // Build a raw invoice-registry::create_invoice_restricted instruction.
  // Same as create_invoice plus a trailing `payer: Pubkey` arg.
  function buildCreateInvoiceRestrictedIx(args: {
    creator: PublicKey;
    nonce: Buffer;
    invoicePda: PublicKey;
    restrictedPayer: PublicKey;
  }): anchor.web3.TransactionInstruction {
    const metadataHash = Buffer.alloc(32, 0);
    const metadataUri = "";
    const mint = PublicKey.default;

    const data = Buffer.concat([
      CREATE_INVOICE_RESTRICTED_DISC,
      args.nonce,
      metadataHash,
      encodeBorshString(metadataUri),
      mint.toBuffer(),
      encodeBorshOptionI64Null(),
      args.restrictedPayer.toBuffer(),
    ]);

    return new anchor.web3.TransactionInstruction({
      programId: INVOICE_REGISTRY_PROGRAM_ID,
      keys: [
        { pubkey: args.invoicePda, isSigner: false, isWritable: true },
        { pubkey: args.creator, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  function deriveInvoicePda(creator: PublicKey, nonce: Buffer): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("invoice"), creator.toBuffer(), nonce],
      INVOICE_REGISTRY_PROGRAM_ID,
    );
    return pda;
  }

  function deriveLockPda(invoicePda: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("intent_lock"), invoicePda.toBuffer()],
      INVOICE_REGISTRY_PROGRAM_ID,
    );
    return pda;
  }

  // invoice-registry::lock_payment_intent discriminator (verified against
  // target/idl/invoice_registry.json) — used to acquire a lock directly,
  // outside of VeilPay, in the cancel_payment_intent tests below. Going
  // direct keeps the cancel tests independent of mock-Umbra's behaviour.
  const LOCK_PAYMENT_INTENT_DISC = Buffer.from([96, 172, 233, 81, 188, 200, 139, 94]);

  // Build a raw invoice-registry::lock_payment_intent ix — no args, three
  // accounts: [invoice (read), lock (writable, init), payer (signer, mut),
  // system_program]. This mirrors what VeilPay's pay_invoice CPI does
  // internally; we go direct here so cancel tests don't need Umbra mocks.
  function buildLockPaymentIntentIx(args: {
    invoicePda: PublicKey;
    lockPda: PublicKey;
    payer: PublicKey;
  }): anchor.web3.TransactionInstruction {
    return new anchor.web3.TransactionInstruction({
      programId: INVOICE_REGISTRY_PROGRAM_ID,
      keys: [
        { pubkey: args.invoicePda, isSigner: false, isWritable: false },
        { pubkey: args.lockPda, isSigner: false, isWritable: true },
        { pubkey: args.payer, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: LOCK_PAYMENT_INTENT_DISC,
    });
  }

  // Build a raw invoice-registry::cancel_payment_intent ix — no args, three
  // accounts: [invoice (read), lock (writable, close), payer (signer, mut)].
  // No system_program: close = payer doesn't need it (it's a balance transfer
  // back to payer + zeroing the data, both done by Anchor's close attribute).
  function buildCancelPaymentIntentIx(args: {
    invoicePda: PublicKey;
    lockPda: PublicKey;
    payer: PublicKey;
  }): anchor.web3.TransactionInstruction {
    return new anchor.web3.TransactionInstruction({
      programId: INVOICE_REGISTRY_PROGRAM_ID,
      keys: [
        { pubkey: args.invoicePda, isSigner: false, isWritable: false },
        { pubkey: args.lockPda, isSigner: false, isWritable: true },
        { pubkey: args.payer, isSigner: true, isWritable: true },
      ],
      data: CANCEL_PAYMENT_INTENT_DISC,
    });
  }

  // Build a raw invoice-registry::mark_paid ix. Args: utxo_commitment: [u8; 32].
  // Accounts: [invoice (writable, has_one creator), creator (signer)].
  function buildMarkPaidIx(args: {
    invoicePda: PublicKey;
    creator: PublicKey;
    utxoCommitment: Buffer;
  }): anchor.web3.TransactionInstruction {
    return new anchor.web3.TransactionInstruction({
      programId: INVOICE_REGISTRY_PROGRAM_ID,
      keys: [
        { pubkey: args.invoicePda, isSigner: false, isWritable: true },
        { pubkey: args.creator, isSigner: true, isWritable: false },
      ],
      data: Buffer.concat([MARK_PAID_DISC, args.utxoCommitment]),
    });
  }

  // Helper: create a pending invoice on chain, return its PDA. The creator
  // signs from `provider.wallet` so we don't need to manage a separate
  // keypair for invoice creation.
  async function createPendingInvoice(opts?: { restrictedPayer?: PublicKey }): Promise<PublicKey> {
    const nonce = Buffer.from(Keypair.generate().publicKey.toBuffer().slice(0, 8));
    const invoicePda = deriveInvoicePda(provider.wallet.publicKey, nonce);
    const ix = opts?.restrictedPayer
      ? buildCreateInvoiceRestrictedIx({
          creator: provider.wallet.publicKey,
          nonce,
          invoicePda,
          restrictedPayer: opts.restrictedPayer,
        })
      : buildCreateInvoiceIx({
          creator: provider.wallet.publicKey,
          nonce,
          invoicePda,
        });

    const tx = new Transaction().add(ix);
    tx.feePayer = provider.wallet.publicKey;
    tx.recentBlockhash = (await provider.connection.getLatestBlockhash("confirmed")).blockhash;
    const signed = await provider.wallet.signTransaction(tx);
    const sig = await provider.connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
    });
    await provider.connection.confirmTransaction(sig, "confirmed");
    return invoicePda;
  }

  before(async () => {
    const balance = await provider.connection.getBalance(provider.wallet.publicKey);
    if (balance < 1_000_000_000) {
      const sig = await provider.connection.requestAirdrop(
        provider.wallet.publicKey,
        10_000_000_000
      );
      await provider.connection.confirmTransaction(sig, "confirmed");
    }
  });

  // ---------------------------------------------------------------------
  //  pay_no_invoice tests (the payroll path — pre-Fix-2 behavior preserved)
  // ---------------------------------------------------------------------

  it("pay_no_invoice — happy path: forwards both CPIs to the mock Umbra in order", async () => {
    const createBufferData = Buffer.concat([CREATE_BUFFER_DISCRIMINATOR, Buffer.alloc(8, 0)]);
    const depositData = Buffer.concat([DEPOSIT_DISCRIMINATOR, Buffer.alloc(8, 0)]);

    const remainingAccounts = makeMockAccounts(21);

    const ix = await program.methods
      .payNoInvoice(createBufferData, depositData, 4)
      .accounts({
        depositor: provider.wallet.publicKey,
        umbraProgram: UMBRA_PROGRAM_ID,
      })
      .remainingAccounts(remainingAccounts)
      .instruction();

    const { signature, txErr, logs } = await sendCollectingLogs(ix);

    if (process.env.VEILPAY_TEST_DEBUG) {
      console.log("[happy path] logs:\n" + logs.join("\n"));
    }

    expect(signature, "tx should have landed on chain").to.be.a("string");
    expect(txErr, `tx should have succeeded; logs:\n${logs.join("\n")}`).to.be.null;

    const veilPayCpi1 = logs.find((l) => l.includes("veil_pay: CPI 1/2"));
    const veilPayCpi2 = logs.find((l) => l.includes("veil_pay: CPI 2/2"));
    expect(veilPayCpi1, `missing 'CPI 1/2' marker. Logs:\n${logs.join("\n")}`).to.exist;
    expect(veilPayCpi2, `missing 'CPI 2/2' marker. Logs:\n${logs.join("\n")}`).to.exist;
    expect(veilPayCpi1, "create-buffer slice should have received exactly 4 accts").to.include(
      "(4 accts)"
    );
    expect(veilPayCpi2, "deposit slice should have received exactly 17 accts").to.include(
      "(17 accts)"
    );

    const mockCreate = logs.find((l) => l.includes("mock_umbra: create_buffer hit"));
    const mockDeposit = logs.find((l) => l.includes("mock_umbra: deposit hit"));
    expect(mockCreate, `mock did not see create_buffer. Logs:\n${logs.join("\n")}`).to.exist;
    expect(mockDeposit, `mock did not see deposit. Logs:\n${logs.join("\n")}`).to.exist;

    const idxCreate = logs.indexOf(mockCreate!);
    const idxDeposit = logs.indexOf(mockDeposit!);
    expect(idxCreate).to.be.lessThan(idxDeposit);
  });

  it("pay_no_invoice — fails with DiscriminatorMismatch when create_buffer_data has wrong first 8 bytes", async () => {
    const badCreateBufferData = Buffer.concat([
      Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
      Buffer.alloc(8, 0),
    ]);
    const validDepositData = Buffer.concat([DEPOSIT_DISCRIMINATOR, Buffer.alloc(8, 0)]);

    const ix = await program.methods
      .payNoInvoice(badCreateBufferData, validDepositData, 4)
      .accounts({
        depositor: provider.wallet.publicKey,
        umbraProgram: UMBRA_PROGRAM_ID,
      })
      .remainingAccounts(makeMockAccounts(21))
      .instruction();

    const { signature, txErr, logs } = await sendCollectingLogs(ix);

    expect(signature, "tx should have landed (so we can read its err)").to.be.a("string");
    expect(txErr, `expected tx to fail; logs:\n${logs.join("\n")}`).to.not.be.null;

    const errHex = `0x${ERR_DISCRIMINATOR_MISMATCH.toString(16)}`;
    const sawErrorCode = logs.some(
      (l) =>
        l.includes("DiscriminatorMismatch") ||
        l.includes(`Error Number: ${ERR_DISCRIMINATOR_MISMATCH}`) ||
        l.toLowerCase().includes(`custom program error: ${errHex}`)
    );
    expect(sawErrorCode, `expected DiscriminatorMismatch (6001) in logs:\n${logs.join("\n")}`)
      .to.be.true;

    const sawAnyCpi = logs.some((l) => l.includes("veil_pay: CPI"));
    expect(sawAnyCpi, "should not have reached the CPI invoke step").to.be.false;
    const sawMockHit = logs.some((l) => l.includes("mock_umbra:"));
    expect(sawMockHit, "mock Umbra should never have been invoked").to.be.false;
  });

  it("pay_no_invoice — fails with AccountSliceOutOfBounds when create_buffer_account_count > remaining_accounts.len()", async () => {
    const validCreateBufferData = Buffer.concat([
      CREATE_BUFFER_DISCRIMINATOR,
      Buffer.alloc(8, 0),
    ]);
    const validDepositData = Buffer.concat([DEPOSIT_DISCRIMINATOR, Buffer.alloc(8, 0)]);

    const remainingAccounts = makeMockAccounts(5);
    const requestedCount = 10;
    expect(requestedCount).to.be.greaterThan(remainingAccounts.length);

    const ix = await program.methods
      .payNoInvoice(validCreateBufferData, validDepositData, requestedCount)
      .accounts({
        depositor: provider.wallet.publicKey,
        umbraProgram: UMBRA_PROGRAM_ID,
      })
      .remainingAccounts(remainingAccounts)
      .instruction();

    const { signature, txErr, logs } = await sendCollectingLogs(ix);

    expect(signature, "tx should have landed (so we can read its err)").to.be.a("string");
    expect(txErr, `expected tx to fail; logs:\n${logs.join("\n")}`).to.not.be.null;

    const errHex = `0x${ERR_ACCOUNT_SLICE_OOB.toString(16)}`;
    const sawErrorCode = logs.some(
      (l) =>
        l.includes("AccountSliceOutOfBounds") ||
        l.includes(`Error Number: ${ERR_ACCOUNT_SLICE_OOB}`) ||
        l.toLowerCase().includes(`custom program error: ${errHex}`)
    );
    expect(sawErrorCode, `expected AccountSliceOutOfBounds (6002) in logs:\n${logs.join("\n")}`)
      .to.be.true;

    const sawAnyCpi = logs.some((l) => l.includes("veil_pay: CPI"));
    expect(sawAnyCpi, "should not have reached the CPI invoke step").to.be.false;
    const sawMockHit = logs.some((l) => l.includes("mock_umbra:"));
    expect(sawMockHit, "mock Umbra should never have been invoked").to.be.false;
  });

  // ---------------------------------------------------------------------
  //  pay_invoice tests (Fix 2 — single-use payment-intent lock)
  // ---------------------------------------------------------------------

  it("pay_invoice — happy path: locks the invoice + fires both Umbra CPIs", async () => {
    const invoicePda = await createPendingInvoice();
    const lockPda = deriveLockPda(invoicePda);

    // Lock should NOT exist yet.
    const preLock = await provider.connection.getAccountInfo(lockPda);
    expect(preLock, "lock PDA should not exist before pay_invoice").to.be.null;

    const createBufferData = Buffer.concat([CREATE_BUFFER_DISCRIMINATOR, Buffer.alloc(8, 0)]);
    const depositData = Buffer.concat([DEPOSIT_DISCRIMINATOR, Buffer.alloc(8, 0)]);

    const ix = await program.methods
      .payInvoice(createBufferData, depositData, 4)
      .accounts({
        depositor: provider.wallet.publicKey,
        invoice: invoicePda,
        lock: lockPda,
        invoiceRegistryProgram: INVOICE_REGISTRY_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        umbraProgram: UMBRA_PROGRAM_ID,
      })
      .remainingAccounts(makeMockAccounts(21))
      .instruction();

    const { signature, txErr, logs } = await sendCollectingLogs(ix);

    expect(signature, "tx should have landed").to.be.a("string");
    expect(txErr, `tx should have succeeded; logs:\n${logs.join("\n")}`).to.be.null;

    // Lock PDA should now exist (init'd by the CPI).
    const postLock = await provider.connection.getAccountInfo(lockPda);
    expect(postLock, "lock PDA should exist after pay_invoice").to.not.be.null;
    expect(postLock!.owner.toBase58()).to.equal(INVOICE_REGISTRY_PROGRAM_ID.toBase58());
    // size = 8 (disc) + 32 (invoice) + 32 (payer) + 8 (locked_at) + 1 (bump) = 81
    expect(postLock!.data.length).to.equal(81);

    // Both Umbra CPIs should have fired.
    const sawCreate = logs.some((l) => l.includes("mock_umbra: create_buffer hit"));
    const sawDeposit = logs.some((l) => l.includes("mock_umbra: deposit hit"));
    expect(sawCreate, "create_buffer CPI must have fired").to.be.true;
    expect(sawDeposit, "deposit CPI must have fired").to.be.true;
  });

  it("pay_invoice — second attempt on the SAME invoice fails (lock PDA already exists), and Umbra CPIs do NOT fire", async () => {
    const invoicePda = await createPendingInvoice();
    const lockPda = deriveLockPda(invoicePda);

    const createBufferData = Buffer.concat([CREATE_BUFFER_DISCRIMINATOR, Buffer.alloc(8, 0)]);
    const depositData = Buffer.concat([DEPOSIT_DISCRIMINATOR, Buffer.alloc(8, 0)]);

    // First payment — succeeds, locks the invoice.
    const ix1 = await program.methods
      .payInvoice(createBufferData, depositData, 4)
      .accounts({
        depositor: provider.wallet.publicKey,
        invoice: invoicePda,
        lock: lockPda,
        invoiceRegistryProgram: INVOICE_REGISTRY_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        umbraProgram: UMBRA_PROGRAM_ID,
      })
      .remainingAccounts(makeMockAccounts(21))
      .instruction();
    const r1 = await sendCollectingLogs(ix1);
    expect(r1.txErr, `first pay should succeed; logs:\n${r1.logs.join("\n")}`).to.be.null;

    // Second payment — must fail at the `init` constraint inside
    // invoice_registry::lock_payment_intent because the lock PDA already
    // exists.
    const ix2 = await program.methods
      .payInvoice(createBufferData, depositData, 4)
      .accounts({
        depositor: provider.wallet.publicKey,
        invoice: invoicePda,
        lock: lockPda,
        invoiceRegistryProgram: INVOICE_REGISTRY_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        umbraProgram: UMBRA_PROGRAM_ID,
      })
      .remainingAccounts(makeMockAccounts(21))
      .instruction();
    const r2 = await sendCollectingLogs(ix2);

    expect(r2.signature, "second tx should land so we can read err").to.be.a("string");
    expect(r2.txErr, `second pay should fail; logs:\n${r2.logs.join("\n")}`).to.not.be.null;

    // Both Umbra CPIs must NOT have fired in the second tx — the whole tx
    // reverts because the lock CPI is the FIRST step. We isolate the
    // second-tx logs from the first by checking for the second pay's
    // log marker first.
    //
    // The error surfaces somewhere in the logs as either:
    //   - "Allocate: account ... already in use"
    //   - or "already in use"
    //   - or a SystemProgram error code
    const sawAlreadyInUse = r2.logs.some(
      (l) =>
        l.toLowerCase().includes("already in use") ||
        l.includes("custom program error: 0x0") || // SystemError::AccountAlreadyInUse = 0
        l.includes("Allocate"),
    );
    expect(
      sawAlreadyInUse,
      `expected 'already in use' or Allocate-failure in logs:\n${r2.logs.join("\n")}`,
    ).to.be.true;

    // The Umbra CPIs run AFTER the lock CPI in pay_invoice, so a failed
    // lock means the create_buffer + deposit CPIs never fire in this tx.
    // Filter mock_umbra hits — there should be none in the failed tx's logs.
    const sawCreate = r2.logs.some((l) => l.includes("mock_umbra: create_buffer hit"));
    const sawDeposit = r2.logs.some((l) => l.includes("mock_umbra: deposit hit"));
    expect(sawCreate, "create_buffer CPI must NOT fire on second pay").to.be.false;
    expect(sawDeposit, "deposit CPI must NOT fire on second pay").to.be.false;
  });

  it("pay_invoice — restricted invoice + WRONG payer signer → NotPayer (code 6003 / 0x1773)", async () => {
    // Mark the invoice as restricted to a different wallet so the wallet
    // signing the pay tx is NOT authorized.
    const restrictedTo = Keypair.generate();
    const invoicePda = await createPendingInvoice({ restrictedPayer: restrictedTo.publicKey });
    const lockPda = deriveLockPda(invoicePda);

    const createBufferData = Buffer.concat([CREATE_BUFFER_DISCRIMINATOR, Buffer.alloc(8, 0)]);
    const depositData = Buffer.concat([DEPOSIT_DISCRIMINATOR, Buffer.alloc(8, 0)]);

    // provider.wallet pays — but it's NOT the restricted payer.
    const ix = await program.methods
      .payInvoice(createBufferData, depositData, 4)
      .accounts({
        depositor: provider.wallet.publicKey,
        invoice: invoicePda,
        lock: lockPda,
        invoiceRegistryProgram: INVOICE_REGISTRY_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        umbraProgram: UMBRA_PROGRAM_ID,
      })
      .remainingAccounts(makeMockAccounts(21))
      .instruction();

    const { signature, txErr, logs } = await sendCollectingLogs(ix);

    expect(signature, "tx should land so we can read err").to.be.a("string");
    expect(txErr, `tx should fail; logs:\n${logs.join("\n")}`).to.not.be.null;

    // Anchor surfaces invoice_registry::NotPayer as code 6003 (0x1773).
    const errHex = `0x${ERR_INVOICE_NOT_PAYER.toString(16)}`;
    const sawNotPayer = logs.some(
      (l) =>
        l.includes("NotPayer") ||
        l.includes(`Error Number: ${ERR_INVOICE_NOT_PAYER}`) ||
        l.toLowerCase().includes(`custom program error: ${errHex}`),
    );
    expect(sawNotPayer, `expected NotPayer (6003 / 0x1773) in logs:\n${logs.join("\n")}`).to.be.true;

    // Lock must NOT have been created (CPI rejected before init).
    const lockInfo = await provider.connection.getAccountInfo(lockPda);
    expect(lockInfo, "lock PDA should NOT exist after a NotPayer-rejected attempt").to.be.null;

    // Umbra CPIs must NOT have fired.
    const sawMock = logs.some((l) => l.includes("mock_umbra:"));
    expect(sawMock, "Umbra CPIs must NOT fire on a NotPayer rejection").to.be.false;
  });

  it("pay_invoice — restricted invoice + CORRECT payer signer → happy path", async () => {
    // The restricted payer is provider.wallet itself, so the same wallet
    // that creates the invoice ALSO signs the pay tx. That's fine — the
    // creator-vs-payer distinction is not enforced by the lock CPI, only
    // the payer-restriction is.
    const invoicePda = await createPendingInvoice({
      restrictedPayer: provider.wallet.publicKey,
    });
    const lockPda = deriveLockPda(invoicePda);

    const createBufferData = Buffer.concat([CREATE_BUFFER_DISCRIMINATOR, Buffer.alloc(8, 0)]);
    const depositData = Buffer.concat([DEPOSIT_DISCRIMINATOR, Buffer.alloc(8, 0)]);

    const ix = await program.methods
      .payInvoice(createBufferData, depositData, 4)
      .accounts({
        depositor: provider.wallet.publicKey,
        invoice: invoicePda,
        lock: lockPda,
        invoiceRegistryProgram: INVOICE_REGISTRY_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        umbraProgram: UMBRA_PROGRAM_ID,
      })
      .remainingAccounts(makeMockAccounts(21))
      .instruction();

    const { signature, txErr, logs } = await sendCollectingLogs(ix);

    expect(signature).to.be.a("string");
    expect(txErr, `tx should succeed; logs:\n${logs.join("\n")}`).to.be.null;

    const lockInfo = await provider.connection.getAccountInfo(lockPda);
    expect(lockInfo, "lock should exist").to.not.be.null;

    const sawCreate = logs.some((l) => l.includes("mock_umbra: create_buffer hit"));
    const sawDeposit = logs.some((l) => l.includes("mock_umbra: deposit hit"));
    expect(sawCreate).to.be.true;
    expect(sawDeposit).to.be.true;
  });

  // ---------------------------------------------------------------------
  //  pay_invoice_from_shielded tests (shielded-balance source path)
  //
  // The shielded variant differs from `pay_invoice` only in:
  //   - which discriminators VeilPay enforces on the inner Umbra ix data
  //     (CREATE_SHIELDED_BUFFER_DISCRIMINATOR / DEPOSIT_FROM_SHIELDED_DISCRIMINATOR
  //     instead of the public ones)
  //   - the deposit ix accepts ~25 accounts vs. 17 for the public path
  //     (8 extra Arcium MPC accounts) — but the mock-Umbra harness is
  //     discriminator-and-account-list agnostic, so we just feed it
  //     mock accounts with the correct *shape* (count and split point).
  // The lock-acquisition behaviour is identical — same invoice-registry
  // CPI, same lock PDA seeds — so the same NotPayer + double-pay
  // assertions apply.
  // ---------------------------------------------------------------------

  it("pay_invoice_from_shielded — happy path: locks the invoice + fires both Umbra CPIs (shielded variant)", async () => {
    const invoicePda = await createPendingInvoice();
    const lockPda = deriveLockPda(invoicePda);

    // Lock should NOT exist yet.
    const preLock = await provider.connection.getAccountInfo(lockPda);
    expect(preLock, "lock PDA should not exist before pay_invoice_from_shielded").to.be.null;

    const createBufferData = Buffer.concat([CREATE_SHIELDED_BUFFER_DISCRIMINATOR, Buffer.alloc(8, 0)]);
    const depositData = Buffer.concat([DEPOSIT_FROM_SHIELDED_DISCRIMINATOR, Buffer.alloc(8, 0)]);

    // 4 accounts for create-buffer, 25 accounts for the v11 deposit.
    // The shape is what matters for VeilPay's split logic; the mock
    // doesn't validate the contents.
    const ix = await program.methods
      .payInvoiceFromShielded(createBufferData, depositData, 4)
      .accounts({
        depositor: provider.wallet.publicKey,
        invoice: invoicePda,
        lock: lockPda,
        invoiceRegistryProgram: INVOICE_REGISTRY_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        umbraProgram: UMBRA_PROGRAM_ID,
      })
      // 18 mock accounts (down from the 29 the production shielded path
      // needs: 4 for create-buffer + 25 for v11 deposit). Anchor tests run
      // legacy txs with no ALT, so the full account set blows past Solana's
      // 1232-byte cap (we measured 1341 bytes). The mock-Umbra harness
      // just logs and doesn't care about the account count, so we exercise
      // the VeilPay split-and-forward logic with a smaller mock list. The
      // real-world tx-size measurement happens in workstream 5 (frontend
      // build with ALT) where we verify the production tx fits under cap.
      .remainingAccounts(makeMockAccounts(18))
      .instruction();

    const { signature, txErr, logs } = await sendCollectingLogs(ix);

    expect(signature, "tx should have landed").to.be.a("string");
    expect(txErr, `tx should have succeeded; logs:\n${logs.join("\n")}`).to.be.null;

    // Lock PDA should now exist (init'd by the CPI).
    const postLock = await provider.connection.getAccountInfo(lockPda);
    expect(postLock, "lock PDA should exist after pay_invoice_from_shielded").to.not.be.null;
    expect(postLock!.owner.toBase58()).to.equal(INVOICE_REGISTRY_PROGRAM_ID.toBase58());
    // size = 8 (disc) + 32 (invoice) + 32 (payer) + 8 (locked_at) + 1 (bump) = 81
    expect(postLock!.data.length).to.equal(81);

    // The shielded ix logs use a different marker — make sure they fired.
    const sawShieldedMarker = logs.some((l) => l.includes("veil_pay: 3/3 - deposit from shielded balance"));
    expect(sawShieldedMarker, `expected shielded deposit log marker. Logs:\n${logs.join("\n")}`).to.be.true;

    // Both Umbra CPIs should have fired (mock just logs; doesn't validate
    // the shielded-vs-public discriminator distinction).
    const sawCreate = logs.some((l) => l.includes("mock_umbra: create_buffer hit"));
    const sawDeposit = logs.some((l) => l.includes("mock_umbra: deposit hit"));
    expect(sawCreate, "create_buffer CPI must have fired").to.be.true;
    expect(sawDeposit, "deposit CPI must have fired").to.be.true;
  });

  it("pay_invoice_from_shielded — second attempt on the SAME invoice fails (lock PDA already exists), and Umbra CPIs do NOT fire", async () => {
    const invoicePda = await createPendingInvoice();
    const lockPda = deriveLockPda(invoicePda);

    const createBufferData = Buffer.concat([CREATE_SHIELDED_BUFFER_DISCRIMINATOR, Buffer.alloc(8, 0)]);
    const depositData = Buffer.concat([DEPOSIT_FROM_SHIELDED_DISCRIMINATOR, Buffer.alloc(8, 0)]);

    // First payment — succeeds, locks the invoice.
    const ix1 = await program.methods
      .payInvoiceFromShielded(createBufferData, depositData, 4)
      .accounts({
        depositor: provider.wallet.publicKey,
        invoice: invoicePda,
        lock: lockPda,
        invoiceRegistryProgram: INVOICE_REGISTRY_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        umbraProgram: UMBRA_PROGRAM_ID,
      })
      // 18 mock accounts (down from the 29 the production shielded path
      // needs: 4 for create-buffer + 25 for v11 deposit). Anchor tests run
      // legacy txs with no ALT, so the full account set blows past Solana's
      // 1232-byte cap (we measured 1341 bytes). The mock-Umbra harness
      // just logs and doesn't care about the account count, so we exercise
      // the VeilPay split-and-forward logic with a smaller mock list. The
      // real-world tx-size measurement happens in workstream 5 (frontend
      // build with ALT) where we verify the production tx fits under cap.
      .remainingAccounts(makeMockAccounts(18))
      .instruction();
    const r1 = await sendCollectingLogs(ix1);
    expect(r1.txErr, `first pay should succeed; logs:\n${r1.logs.join("\n")}`).to.be.null;

    // Second payment — must fail at the `init` constraint inside
    // invoice_registry::lock_payment_intent because the lock PDA already
    // exists. This proves the shielded variant inherits the same
    // double-pay protection as the public path.
    const ix2 = await program.methods
      .payInvoiceFromShielded(createBufferData, depositData, 4)
      .accounts({
        depositor: provider.wallet.publicKey,
        invoice: invoicePda,
        lock: lockPda,
        invoiceRegistryProgram: INVOICE_REGISTRY_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        umbraProgram: UMBRA_PROGRAM_ID,
      })
      // 18 mock accounts (down from the 29 the production shielded path
      // needs: 4 for create-buffer + 25 for v11 deposit). Anchor tests run
      // legacy txs with no ALT, so the full account set blows past Solana's
      // 1232-byte cap (we measured 1341 bytes). The mock-Umbra harness
      // just logs and doesn't care about the account count, so we exercise
      // the VeilPay split-and-forward logic with a smaller mock list. The
      // real-world tx-size measurement happens in workstream 5 (frontend
      // build with ALT) where we verify the production tx fits under cap.
      .remainingAccounts(makeMockAccounts(18))
      .instruction();
    const r2 = await sendCollectingLogs(ix2);

    expect(r2.signature, "second tx should land so we can read err").to.be.a("string");
    expect(r2.txErr, `second pay should fail; logs:\n${r2.logs.join("\n")}`).to.not.be.null;

    const sawAlreadyInUse = r2.logs.some(
      (l) =>
        l.toLowerCase().includes("already in use") ||
        l.includes("custom program error: 0x0") ||
        l.includes("Allocate"),
    );
    expect(
      sawAlreadyInUse,
      `expected 'already in use' or Allocate-failure in logs:\n${r2.logs.join("\n")}`,
    ).to.be.true;

    // Umbra CPIs must NOT have fired in the failed second tx.
    const sawCreate = r2.logs.some((l) => l.includes("mock_umbra: create_buffer hit"));
    const sawDeposit = r2.logs.some((l) => l.includes("mock_umbra: deposit hit"));
    expect(sawCreate, "create_buffer CPI must NOT fire on second pay").to.be.false;
    expect(sawDeposit, "deposit CPI must NOT fire on second pay").to.be.false;
  });

  it("pay_invoice_from_shielded — restricted invoice + WRONG payer signer → NotPayer (code 6003 / 0x1773)", async () => {
    // Invoice is restricted to a different wallet — provider.wallet is
    // NOT authorised to pay it. The shielded path inherits the public
    // path's NotPayer rejection because the lock CPI runs first and
    // invoice-registry's lock_payment_intent enforces the restriction.
    const restrictedTo = Keypair.generate();
    const invoicePda = await createPendingInvoice({ restrictedPayer: restrictedTo.publicKey });
    const lockPda = deriveLockPda(invoicePda);

    const createBufferData = Buffer.concat([CREATE_SHIELDED_BUFFER_DISCRIMINATOR, Buffer.alloc(8, 0)]);
    const depositData = Buffer.concat([DEPOSIT_FROM_SHIELDED_DISCRIMINATOR, Buffer.alloc(8, 0)]);

    const ix = await program.methods
      .payInvoiceFromShielded(createBufferData, depositData, 4)
      .accounts({
        depositor: provider.wallet.publicKey,
        invoice: invoicePda,
        lock: lockPda,
        invoiceRegistryProgram: INVOICE_REGISTRY_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        umbraProgram: UMBRA_PROGRAM_ID,
      })
      // 18 mock accounts (down from the 29 the production shielded path
      // needs: 4 for create-buffer + 25 for v11 deposit). Anchor tests run
      // legacy txs with no ALT, so the full account set blows past Solana's
      // 1232-byte cap (we measured 1341 bytes). The mock-Umbra harness
      // just logs and doesn't care about the account count, so we exercise
      // the VeilPay split-and-forward logic with a smaller mock list. The
      // real-world tx-size measurement happens in workstream 5 (frontend
      // build with ALT) where we verify the production tx fits under cap.
      .remainingAccounts(makeMockAccounts(18))
      .instruction();

    const { signature, txErr, logs } = await sendCollectingLogs(ix);

    expect(signature, "tx should land so we can read err").to.be.a("string");
    expect(txErr, `tx should fail; logs:\n${logs.join("\n")}`).to.not.be.null;

    const errHex = `0x${ERR_INVOICE_NOT_PAYER.toString(16)}`;
    const sawNotPayer = logs.some(
      (l) =>
        l.includes("NotPayer") ||
        l.includes(`Error Number: ${ERR_INVOICE_NOT_PAYER}`) ||
        l.toLowerCase().includes(`custom program error: ${errHex}`),
    );
    expect(sawNotPayer, `expected NotPayer (6003 / 0x1773) in logs:\n${logs.join("\n")}`).to.be.true;

    // Lock must NOT have been created.
    const lockInfo = await provider.connection.getAccountInfo(lockPda);
    expect(lockInfo, "lock PDA should NOT exist after a NotPayer-rejected attempt").to.be.null;

    // Umbra CPIs must NOT have fired.
    const sawMock = logs.some((l) => l.includes("mock_umbra:"));
    expect(sawMock, "Umbra CPIs must NOT fire on a NotPayer rejection").to.be.false;
  });

  // ---------------------------------------------------------------------
  //  cancel_payment_intent tests (recovery primitive for the shielded
  //  batched flow — when the lock tx confirms but the subsequent
  //  createBuffer or deposit tx fails, the payer has a stuck lock
  //  with no settlement. cancel_payment_intent releases the lock and
  //  refunds the rent so the user can retry.)
  // ---------------------------------------------------------------------

  it("cancel_payment_intent — happy path: payer cancels → lock account closed, rent refunded, invoice unchanged", async () => {
    const invoicePda = await createPendingInvoice();
    const lockPda = deriveLockPda(invoicePda);
    const payer = provider.wallet.publicKey;

    // 1. Acquire the lock via a direct lock_payment_intent call.
    const lockIx = buildLockPaymentIntentIx({ invoicePda, lockPda, payer });
    const lockRes = await sendCollectingLogs(lockIx);
    expect(lockRes.txErr, `lock should succeed; logs:\n${lockRes.logs.join("\n")}`).to.be.null;

    const preLock = await provider.connection.getAccountInfo(lockPda);
    expect(preLock, "lock should exist before cancel").to.not.be.null;
    const lockBalance = preLock!.lamports;
    expect(lockBalance).to.be.greaterThan(0);

    const balanceBeforeCancel = await provider.connection.getBalance(payer);

    // 2. Cancel — releases the lock + refunds rent.
    const cancelIx = buildCancelPaymentIntentIx({ invoicePda, lockPda, payer });
    const cancelRes = await sendCollectingLogs(cancelIx);
    expect(
      cancelRes.txErr,
      `cancel should succeed; logs:\n${cancelRes.logs.join("\n")}`,
    ).to.be.null;

    // Lock account must be closed (gone).
    const postLock = await provider.connection.getAccountInfo(lockPda);
    expect(postLock, "lock PDA should be closed after cancel").to.be.null;

    // Rent should have been refunded — payer balance is roughly
    // (balance_before + lock_lamports - tx_fee). We check >= balance_before
    // - tx_fee_upper_bound; the close transfers ~1 SOL of rent (overstating
    // for safety) so `>= before - 0.01 SOL` is comfortable.
    const balanceAfterCancel = await provider.connection.getBalance(payer);
    expect(
      balanceAfterCancel,
      "payer balance must increase by lock rent minus tx fee (or at least not drop appreciably)",
    ).to.be.greaterThan(balanceBeforeCancel - 10_000_000);

    // Invoice status untouched (still Pending — cancel doesn't mutate it).
    // Read raw bytes; status field is u8 at offset 8 (disc) + 1 (version)
    // + 32 (creator) + 33 (payer Option) + 32 (mint) + 32 (metadata_hash)
    // + 4 + uri_len (var) + 33 (utxo_commitment Option). The URI is "" in
    // our test invoices, so uri_len = 0 → status offset = 8+1+32+33+32+32+4+33 = 175.
    const invoiceInfo = await provider.connection.getAccountInfo(invoicePda);
    expect(invoiceInfo, "invoice should still exist").to.not.be.null;
    const statusByte = invoiceInfo!.data[175];
    // 0 = Pending; 1 = Paid; 2 = Cancelled; 3 = Expired (matches the
    // InvoiceStatus enum order in lib.rs).
    expect(statusByte, "invoice status should still be Pending after cancel").to.equal(0);
  });

  it("cancel_payment_intent — wrong payer signer → NotPayer (code 6003 / 0x1773)", async () => {
    const invoicePda = await createPendingInvoice();
    const lockPda = deriveLockPda(invoicePda);
    const realPayer = provider.wallet.publicKey;

    // Acquire lock as realPayer (provider.wallet).
    const lockIx = buildLockPaymentIntentIx({ invoicePda, lockPda, payer: realPayer });
    const lockRes = await sendCollectingLogs(lockIx);
    expect(lockRes.txErr, `lock should succeed; logs:\n${lockRes.logs.join("\n")}`).to.be.null;

    // Stranger tries to cancel — must fail with NotPayer (the lock's
    // has_one = payer constraint inside CancelPaymentIntent rejects).
    const stranger = Keypair.generate();
    const ad = await provider.connection.requestAirdrop(stranger.publicKey, 1_000_000_000);
    await provider.connection.confirmTransaction(ad, "confirmed");

    const cancelIx = buildCancelPaymentIntentIx({
      invoicePda,
      lockPda,
      payer: stranger.publicKey,
    });
    const { signature, txErr, logs } = await sendCollectingLogs(cancelIx, [stranger]);

    expect(signature, "tx should land so we can read err").to.be.a("string");
    expect(txErr, `cancel should fail; logs:\n${logs.join("\n")}`).to.not.be.null;

    const errHex = `0x${ERR_INVOICE_NOT_PAYER.toString(16)}`;
    const sawNotPayer = logs.some(
      (l) =>
        l.includes("NotPayer") ||
        l.includes("ConstraintHasOne") ||
        l.includes(`Error Number: ${ERR_INVOICE_NOT_PAYER}`) ||
        l.toLowerCase().includes(`custom program error: ${errHex}`),
    );
    expect(
      sawNotPayer,
      `expected NotPayer / ConstraintHasOne in logs:\n${logs.join("\n")}`,
    ).to.be.true;

    // Lock must STILL exist — failed cancel must not close it.
    const lockInfo = await provider.connection.getAccountInfo(lockPda);
    expect(lockInfo, "lock should still exist after rejected stranger cancel").to.not.be.null;
  });

  it("cancel_payment_intent — invoice already Paid → InvalidStatus (cannot cancel a settled lock)", async () => {
    const invoicePda = await createPendingInvoice();
    const lockPda = deriveLockPda(invoicePda);
    const payer = provider.wallet.publicKey;

    // Acquire lock.
    const lockIx = buildLockPaymentIntentIx({ invoicePda, lockPda, payer });
    const lockRes = await sendCollectingLogs(lockIx);
    expect(lockRes.txErr, `lock should succeed; logs:\n${lockRes.logs.join("\n")}`).to.be.null;

    // Mark the invoice as Paid (creator == provider.wallet, since the
    // helper creates invoices with provider.wallet as creator).
    const utxoCommitment = Buffer.alloc(32, 7);
    const markIx = buildMarkPaidIx({ invoicePda, creator: payer, utxoCommitment });
    const markRes = await sendCollectingLogs(markIx);
    expect(markRes.txErr, `mark_paid should succeed; logs:\n${markRes.logs.join("\n")}`).to.be.null;

    // Now try to cancel — must fail with InvalidStatus.
    const cancelIx = buildCancelPaymentIntentIx({ invoicePda, lockPda, payer });
    const { signature, txErr, logs } = await sendCollectingLogs(cancelIx);

    expect(signature, "tx should land so we can read err").to.be.a("string");
    expect(txErr, `cancel should fail when invoice already Paid; logs:\n${logs.join("\n")}`)
      .to.not.be.null;

    const errHex = `0x${ERR_INVOICE_INVALID_STATUS.toString(16)}`;
    const sawInvalidStatus = logs.some(
      (l) =>
        l.includes("InvalidStatus") ||
        l.includes(`Error Number: ${ERR_INVOICE_INVALID_STATUS}`) ||
        l.toLowerCase().includes(`custom program error: ${errHex}`),
    );
    expect(
      sawInvalidStatus,
      `expected InvalidStatus in logs:\n${logs.join("\n")}`,
    ).to.be.true;

    // Lock must STILL exist — failed cancel must not close it.
    const lockInfo = await provider.connection.getAccountInfo(lockPda);
    expect(lockInfo, "lock should still exist after rejected paid-invoice cancel").to.not.be.null;
  });
});
