import { NextRequest, NextResponse } from "next/server";
import Bundlr from "@bundlr-network/client";

export const runtime = "nodejs"; // required for Bundlr

export async function POST(req: NextRequest) {
  const body = await req.arrayBuffer();
  const ciphertext = Buffer.from(body);

  const privateKey = process.env.BUNDLR_PRIVATE_KEY;
  if (!privateKey) {
    return NextResponse.json({ error: "Server misconfigured: BUNDLR_PRIVATE_KEY missing" }, { status: 500 });
  }

  // Bundlr node must match the SOL denomination of the payer wallet:
  // devnet SOL is only accepted by devnet.bundlr.network; mainnet SOL only by node1.
  const network = process.env.NEXT_PUBLIC_SOLANA_NETWORK || "devnet";
  const bundlrUrl =
    network === "mainnet"
      ? "https://node1.bundlr.network"
      : "https://devnet.bundlr.network";
  const providerUrl =
    process.env.NEXT_PUBLIC_RPC_URL ||
    (network === "mainnet"
      ? "https://api.mainnet-beta.solana.com"
      : "https://api.devnet.solana.com");

  const bundlr = new Bundlr(bundlrUrl, "solana", privateKey, { providerUrl });

  try {
    const tx = bundlr.createTransaction(ciphertext, {
      tags: [{ name: "Content-Type", value: "application/octet-stream" }],
    });
    await tx.sign();
    const result = await tx.upload();
    // Devnet Bundlr uploads never land on arweave.net — they're only served
    // from the Bundlr node itself. Return the gateway that matches the node.
    const gateway =
      network === "mainnet"
        ? `https://arweave.net/${result.id}`
        : `https://devnet.bundlr.network/${result.id}`;
    return NextResponse.json({ id: result.id, uri: gateway });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
