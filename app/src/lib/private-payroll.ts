import * as ed from "@noble/ed25519";
import bs58 from "bs58";

export interface PayrollPacketRow {
  recipient: string;
  amount: string;
  memo: string;
  status: "paid" | "failed";
  mode: "shielded" | "public";
  txSignature: string | null;
  error: string | null;
  /**
   * Optional sender-side delivery path tag. Surfaced for transparency in
   * the signed packet so the recipient (or a third-party verifier) can
   * see how the payment reached them:
   *
   *   - `"direct-registered"` — recipient was already an Umbra user
   *     when the run started; deposit ix targeted their on-chain x25519
   *     key directly (no shadow indirection, no claim URL). Phase C.
   *   - `"claim-link"` — recipient was unregistered; sender funded a
   *     shadow account, registered it, deposited there, and emitted a
   *     claim URL the recipient consumed via the dashboard. Phase A.
   *   - `"shielded"` — sender paid from their encrypted balance via the
   *     SDK's shielded creator path (Path A territory).
   *
   * INTENTIONALLY NOT in {@link canonicalPayrollPacketBytes}: keeping the
   * canonical-bytes shape backwards-compatible means old verifiers
   * (which build canonical bytes from the same fixed field list) still
   * verify. Newer verifiers see this field; older ones simply ignore it.
   */
  path?: "direct-registered" | "claim-link" | "shielded";
}

export interface PayrollPacket {
  version: 1;
  kind: "veil.private-payroll";
  batchId: string;
  payer: string;
  mint: string;
  symbol: string;
  decimals: number;
  createdAt: string;
  rows: PayrollPacketRow[];
}

export interface SignedPayrollPacket {
  packet: PayrollPacket;
  signature: string;
}

export interface PayrollDisclosure {
  version: 1;
  kind: "veil.payroll-disclosure";
  rowIndex: number;
  packet: PayrollPacket;
  signature: string;
}

export interface PayrollPacketSigner {
  publicKey: { toBase58(): string } | null;
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
}

export function generatePrivatePayrollBatchId(now: Date = new Date()): string {
  const ts = now.getTime().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `payroll_${ts}_${rand}`;
}

export function canonicalPayrollPacketBytes(packet: PayrollPacket): Uint8Array {
  const ordered: PayrollPacket = {
    version: 1,
    kind: "veil.private-payroll",
    batchId: packet.batchId,
    payer: packet.payer,
    mint: packet.mint,
    symbol: packet.symbol,
    decimals: packet.decimals,
    createdAt: packet.createdAt,
    rows: packet.rows.map((row) => ({
      recipient: row.recipient,
      amount: row.amount,
      memo: row.memo,
      status: row.status,
      mode: row.mode,
      txSignature: row.txSignature,
      error: row.error,
    })),
  };
  return new TextEncoder().encode(JSON.stringify(ordered));
}

export async function signPayrollPacket(
  packet: PayrollPacket,
  wallet: PayrollPacketSigner,
): Promise<SignedPayrollPacket> {
  if (!wallet.publicKey) throw new Error("Wallet is not connected");
  if (!wallet.signMessage) throw new Error("Connected wallet does not support signMessage");
  if (wallet.publicKey.toBase58() !== packet.payer) {
    throw new Error("Payroll packet payer does not match connected wallet");
  }
  const signatureBytes = await wallet.signMessage(canonicalPayrollPacketBytes(packet));
  if (signatureBytes.length !== 64) {
    throw new Error(`Expected 64-byte ed25519 signature, got ${signatureBytes.length}`);
  }
  return { packet, signature: bs58.encode(signatureBytes) };
}

export async function verifyPayrollPacket(signed: SignedPayrollPacket): Promise<boolean> {
  try {
    const pub = new Uint8Array(bs58.decode(signed.packet.payer));
    const sig = new Uint8Array(bs58.decode(signed.signature));
    if (pub.length !== 32 || sig.length !== 64) return false;
    return await ed.verifyAsync(sig, canonicalPayrollPacketBytes(signed.packet), pub);
  } catch {
    return false;
  }
}

export function buildPayrollDisclosure(
  signed: SignedPayrollPacket,
  rowIndex: number,
): PayrollDisclosure {
  if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= signed.packet.rows.length) {
    throw new Error("Disclosure row index is out of range");
  }
  return {
    version: 1,
    kind: "veil.payroll-disclosure",
    rowIndex,
    packet: signed.packet,
    signature: signed.signature,
  };
}

export async function verifyPayrollDisclosure(disclosure: PayrollDisclosure): Promise<boolean> {
  return verifyPayrollPacket({
    packet: disclosure.packet,
    signature: disclosure.signature,
  });
}

export function encodePayrollPacket(signed: SignedPayrollPacket): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(signed)));
}

export function decodePayrollPacket(blob: string): SignedPayrollPacket {
  const parsed = parseBlob(blob);
  if (
    !parsed ||
    parsed.packet?.version !== 1 ||
    parsed.packet?.kind !== "veil.private-payroll" ||
    typeof parsed.signature !== "string" ||
    !Array.isArray(parsed.packet.rows)
  ) {
    throw new Error("Payroll packet is missing required fields");
  }
  return parsed as SignedPayrollPacket;
}

export function encodePayrollDisclosure(disclosure: PayrollDisclosure): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(disclosure)));
}

export function decodePayrollDisclosure(blob: string): PayrollDisclosure {
  const parsed = parseBlob(blob);
  if (
    !parsed ||
    parsed.version !== 1 ||
    parsed.kind !== "veil.payroll-disclosure" ||
    typeof parsed.signature !== "string" ||
    !parsed.packet ||
    !Number.isInteger(parsed.rowIndex)
  ) {
    throw new Error("Payroll disclosure is missing required fields");
  }
  return parsed as PayrollDisclosure;
}

export function formatPayrollAmount(units: string | bigint, decimals: number): string {
  const value = typeof units === "bigint" ? units : BigInt(units);
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const frac = (value % divisor).toString().padStart(decimals, "0");
  const trimmed = frac.replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole.toString();
}

export function payrollExplorerTxUrl(signature: string, network: "devnet" | "mainnet"): string {
  const cluster = network === "devnet" ? "?cluster=devnet" : "";
  return `https://explorer.solana.com/tx/${signature}${cluster}`;
}

function parseBlob(blob: string): any {
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64Url(blob)));
  } catch (err) {
    throw new Error(`Invalid encoded payroll artifact: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const pad = value.length % 4 === 0 ? 0 : 4 - (value.length % 4);
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
