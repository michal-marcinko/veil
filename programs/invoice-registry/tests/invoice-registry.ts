import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { InvoiceRegistry } from "../target/types/invoice_registry";
import { expect } from "chai";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { randomBytes } from "crypto";

describe("invoice-registry", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.InvoiceRegistry as Program<InvoiceRegistry>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;

  function invoicePda(creator: PublicKey, nonce: Uint8Array): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("invoice"), creator.toBuffer(), Buffer.from(nonce)],
      program.programId,
    );
  }

  const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

  it("creates an invoice with pending status", async () => {
    const creator = provider.wallet.publicKey;
    const nonce = randomBytes(8);
    const [pda] = invoicePda(creator, nonce);

    const metadataHash = Array.from(randomBytes(32));
    const metadataUri = "https://arweave.net/test-tx-id";

    await program.methods
      .createInvoice(Array.from(nonce), metadataHash, metadataUri, USDC_MINT, null)
      .accounts({
        invoice: pda,
        creator,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const invoice = await program.account.invoice.fetch(pda);
    expect(invoice.creator.toBase58()).to.equal(creator.toBase58());
    expect(invoice.mint.toBase58()).to.equal(USDC_MINT.toBase58());
    expect(invoice.metadataUri).to.equal(metadataUri);
    expect(invoice.status).to.deep.equal({ pending: {} });
    expect(invoice.paidAt).to.be.null;
  });

  it("marks an invoice as paid when the creator signs", async () => {
    const creator = provider.wallet.publicKey;
    const nonce = randomBytes(8);
    const [pda] = invoicePda(creator, nonce);

    const metadataHash = Array.from(randomBytes(32));
    const utxoCommitment = Array.from(randomBytes(32));

    // Create pending invoice with no restricted payer
    await program.methods
      .createInvoice(Array.from(nonce), metadataHash, "https://arweave.net/x", USDC_MINT, null)
      .accounts({ invoice: pda, creator, systemProgram: SystemProgram.programId })
      .rpc();

    await program.methods
      .markPaid(utxoCommitment)
      .accounts({ invoice: pda, creator })
      .rpc();

    const invoice = await program.account.invoice.fetch(pda);
    expect(invoice.status).to.deep.equal({ paid: {} });
    expect(invoice.paidAt).to.not.be.null;
    expect(Array.from(invoice.utxoCommitment as Uint8Array)).to.deep.equal(utxoCommitment);
  });

  it("rejects mark_paid from non-creator even when payer is restricted", async () => {
    const creator = provider.wallet.publicKey;
    const nonce = randomBytes(8);
    const [pda] = invoicePda(creator, nonce);

    const designatedPayer = Keypair.generate();
    const randomSigner = Keypair.generate();
    const ad1 = await provider.connection.requestAirdrop(randomSigner.publicKey, 1e9);
    await provider.connection.confirmTransaction(ad1);

    // Create with restricted payer
    await program.methods
      .createInvoiceRestricted(
        Array.from(nonce),
        Array.from(randomBytes(32)),
        "https://arweave.net/x",
        USDC_MINT,
        null,
        designatedPayer.publicKey,
      )
      .accounts({ invoice: pda, creator, systemProgram: SystemProgram.programId })
      .rpc();

    try {
      await program.methods
        .markPaid(Array.from(randomBytes(32)))
        .accounts({ invoice: pda, creator: randomSigner.publicKey })
        .signers([randomSigner])
        .rpc();
      expect.fail("should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.match(/NotCreator|ConstraintHasOne/);
    }
  });

  it("allows creator to cancel a pending invoice", async () => {
    const creator = provider.wallet.publicKey;
    const nonce = randomBytes(8);
    const [pda] = invoicePda(creator, nonce);

    await program.methods
      .createInvoice(Array.from(nonce), Array.from(randomBytes(32)), "https://arweave.net/x", USDC_MINT, null)
      .accounts({ invoice: pda, creator, systemProgram: SystemProgram.programId })
      .rpc();

    await program.methods
      .cancelInvoice()
      .accounts({ invoice: pda, creator })
      .rpc();

    const invoice = await program.account.invoice.fetch(pda);
    expect(invoice.status).to.deep.equal({ cancelled: {} });
  });

  it("rejects cancel from non-creator", async () => {
    const creator = provider.wallet.publicKey;
    const nonce = randomBytes(8);
    const [pda] = invoicePda(creator, nonce);

    await program.methods
      .createInvoice(Array.from(nonce), Array.from(randomBytes(32)), "https://arweave.net/x", USDC_MINT, null)
      .accounts({ invoice: pda, creator, systemProgram: SystemProgram.programId })
      .rpc();

    const stranger = Keypair.generate();
    const ad = await provider.connection.requestAirdrop(stranger.publicKey, 1e9);
    await provider.connection.confirmTransaction(ad);

    try {
      await program.methods
        .cancelInvoice()
        .accounts({ invoice: pda, creator: stranger.publicKey })
        .signers([stranger])
        .rpc();
      expect.fail("should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.match(/NotCreator|ConstraintHasOne|ConstraintSeeds/);
    }
  });
});
