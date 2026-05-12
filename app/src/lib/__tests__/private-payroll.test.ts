import { describe, expect, it } from "vitest";
import * as ed from "@noble/ed25519";
import bs58 from "bs58";
import {
  buildPayrollDisclosure,
  decodePayrollDisclosure,
  decodePayrollPacket,
  encodePayrollDisclosure,
  encodePayrollPacket,
  formatPayrollAmount,
  payrollExplorerTxUrl,
  signPayrollPacket,
  verifyPayrollDisclosure,
  verifyPayrollPacket,
  type PayrollPacket,
} from "../private-payroll";

function packetFor(payer: string): PayrollPacket {
  return {
    version: 1,
    kind: "veil.private-payroll",
    batchId: "payroll_test",
    payer,
    mint: "So11111111111111111111111111111111111111112",
    symbol: "SOL",
    decimals: 9,
    createdAt: "2026-04-27T12:00:00.000Z",
    rows: [
      {
        recipient: "7YttLkHDoCNKPfpUj2xRLVxnN9p1gVkH3GQqNjFztJhd",
        amount: "1500000000",
        memo: "April retainer",
        status: "paid",
        mode: "shielded",
        txSignature: "3vKp9wRjF5FQhdQ2i7qJYQpE1f3LtXxqvA2w4n3v6m7b8c9d1e2f3g4h5j6k7m8n9p",
        error: null,
      },
    ],
  };
}

describe("private payroll packet", () => {
  it("signs, encodes, decodes, and verifies a payroll packet", async () => {
    const privateKey = ed.utils.randomPrivateKey();
    const publicKey = await ed.getPublicKeyAsync(privateKey);
    const payer = bs58.encode(publicKey);
    const packet = packetFor(payer);
    const signed = await signPayrollPacket(packet, {
      publicKey: { toBase58: () => payer },
      signMessage: (message) => ed.signAsync(message, privateKey),
    });

    expect(await verifyPayrollPacket(signed)).toBe(true);
    expect(await verifyPayrollPacket(decodePayrollPacket(encodePayrollPacket(signed)))).toBe(true);
  });

  it("builds a row disclosure that verifies against the signed packet", async () => {
    const privateKey = ed.utils.randomPrivateKey();
    const publicKey = await ed.getPublicKeyAsync(privateKey);
    const payer = bs58.encode(publicKey);
    const signed = await signPayrollPacket(packetFor(payer), {
      publicKey: { toBase58: () => payer },
      signMessage: (message) => ed.signAsync(message, privateKey),
    });

    const disclosure = decodePayrollDisclosure(
      encodePayrollDisclosure(buildPayrollDisclosure(signed, 0)),
    );
    expect(disclosure.packet.rows[disclosure.rowIndex].memo).toBe("April retainer");
    expect(await verifyPayrollDisclosure(disclosure)).toBe(true);
  });

  it("formats base units and explorer URLs", () => {
    expect(formatPayrollAmount("1500000000", 9)).toBe("1.5");
    expect(formatPayrollAmount("4200000000", 6)).toBe("4200");
    expect(payrollExplorerTxUrl("abc", "devnet")).toBe(
      "https://explorer.solana.com/tx/abc?cluster=devnet",
    );
    expect(payrollExplorerTxUrl("abc", "mainnet")).toBe(
      "https://explorer.solana.com/tx/abc",
    );
  });
});
