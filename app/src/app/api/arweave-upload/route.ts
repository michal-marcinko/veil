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

  const bundlr = new Bundlr("https://node1.bundlr.network", "solana", privateKey, {
    providerUrl: process.env.NEXT_PUBLIC_RPC_URL || "https://api.devnet.solana.com",
  });

  try {
    const tx = bundlr.createTransaction(ciphertext, {
      tags: [{ name: "Content-Type", value: "application/octet-stream" }],
    });
    await tx.sign();
    const result = await tx.upload();
    return NextResponse.json({ id: result.id, uri: `https://arweave.net/${result.id}` });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
