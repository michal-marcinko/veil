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
});
