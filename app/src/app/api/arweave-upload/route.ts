import { NextRequest, NextResponse } from "next/server";
import Bundlr from "@bundlr-network/client";

export const runtime = "nodejs"; // required for Bundlr

/**
 * Cap on the total tag bytes accepted from clients. Bundlr itself accepts
 * up to 2KiB of tags per tx, but allowing arbitrary client-supplied tags
 * is a small footgun (cost amplification, log noise). We cap at 1KiB
 * which is generous for our use cases (`Veil-Index = sha256-hex` is
 * 64 bytes; the rest is overhead).
 */
const MAX_CLIENT_TAG_BYTES = 1024;

/**
 * Whitelist of tag NAMES that clients may set. Bundlr/Arweave tags are
 * indexed by GraphQL — accepting arbitrary names would let a misbehaving
 * client spam the index. The only legitimate caller-set tag today is
 * `Veil-Index`, which carries an opaque per-wallet hash that lets the
 * dashboard discover its own payroll-run blobs across devices.
 */
const ALLOWED_CLIENT_TAG_NAMES = new Set(["Veil-Index"]);

interface ClientTag {
  name: string;
  value: string;
}

function parseClientTags(header: string | null): ClientTag[] {
  if (!header) return [];
  // Header format is base64(JSON.stringify([{name, value}])). We use
  // base64 over a header to avoid quoting issues with raw JSON values
  // that contain commas or non-ASCII bytes.
  let decoded: string;
  try {
    decoded = Buffer.from(header, "base64").toString("utf-8");
  } catch {
    throw new Error("Malformed X-Veil-Tags header (base64 decode failed)");
  }
  if (decoded.length > MAX_CLIENT_TAG_BYTES) {
    throw new Error(`X-Veil-Tags exceeds ${MAX_CLIENT_TAG_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new Error("Malformed X-Veil-Tags header (JSON parse failed)");
  }
  if (!Array.isArray(parsed)) throw new Error("X-Veil-Tags must be an array");
  const out: ClientTag[] = [];
  for (const t of parsed) {
    if (
      !t ||
      typeof t !== "object" ||
      typeof (t as any).name !== "string" ||
      typeof (t as any).value !== "string"
    ) {
      throw new Error("Each X-Veil-Tags entry must be {name: string, value: string}");
    }
    const name = (t as any).name as string;
    const value = (t as any).value as string;
    if (!ALLOWED_CLIENT_TAG_NAMES.has(name)) {
      throw new Error(`Tag name not allowed: ${name}`);
    }
    if (value.length === 0 || value.length > 256) {
      throw new Error(`Invalid tag value length for ${name}`);
    }
    out.push({ name, value });
  }
  return out;
}

export async function POST(req: NextRequest) {
  const body = await req.arrayBuffer();
  const ciphertext = Buffer.from(body);

  // Optional caller-set tags (whitelisted names only — see top of file).
  // The cross-device payroll-run sync uses this to attach an opaque
  // per-wallet `Veil-Index` so the wallet can later discover its own
  // uploads via Arweave GraphQL without leaking who they belong to.
  let clientTags: ClientTag[];
  try {
    clientTags = parseClientTags(req.headers.get("x-veil-tags"));
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }

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
    const tags = [
      { name: "Content-Type", value: "application/octet-stream" },
      ...clientTags,
    ];
    const tx = bundlr.createTransaction(ciphertext, { tags });
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
