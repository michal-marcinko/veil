import { describe, expect, it } from "vitest";
import {
  encodeAuditPackage,
  decodeAuditPackage,
  buildAuditUrl,
} from "@/lib/umbra-auditor";

describe("encodeAuditPackage / decodeAuditPackage", () => {
  it("round-trips a 64-byte master signature", () => {
    const sig = new Uint8Array(64);
    for (let i = 0; i < 64; i++) sig[i] = (i * 7 + 3) & 0xff;
    const encoded = encodeAuditPackage(sig);
    expect(typeof encoded).toBe("string");
    expect(encoded.length).toBeGreaterThan(0);

    const decoded = decodeAuditPackage(encoded);
    // bs58 in Node returns a Buffer (subclass of Uint8Array); compare bytes.
    expect(decoded.length).toBe(64);
    expect(Array.from(decoded)).toEqual(Array.from(sig));
  });

  it("decodeAuditPackage rejects wrong-length input", () => {
    // 32-byte payload — what a pay link would carry. Audit links must be 64.
    const tooShort = new Uint8Array(32).fill(9);
    const bs58 = require("bs58");
    const fragment32 = bs58.encode(tooShort);
    expect(() => decodeAuditPackage(fragment32)).toThrow(/64 bytes/);

    const tooLong = new Uint8Array(96).fill(1);
    const fragment96 = bs58.encode(tooLong);
    expect(() => decodeAuditPackage(fragment96)).toThrow(/64 bytes/);

    expect(() => decodeAuditPackage("")).toThrow();
    expect(() => decodeAuditPackage("#")).toThrow();
  });

  it("encodeAuditPackage rejects wrong-length input", () => {
    expect(() => encodeAuditPackage(new Uint8Array(32))).toThrow(/64 bytes/);
    expect(() => encodeAuditPackage(new Uint8Array(0))).toThrow(/64 bytes/);
  });
});

describe("buildAuditUrl", () => {
  it("produces ${origin}/audit/${granter}#${base58sig} with the right shape", () => {
    const sig = new Uint8Array(64);
    for (let i = 0; i < 64; i++) sig[i] = i;
    const url = buildAuditUrl({
      origin: "https://veil.app",
      granterWallet: "Alice1111111111111111111111111111111111111",
      masterSig: sig,
    });

    expect(url.startsWith("https://veil.app/audit/")).toBe(true);
    expect(url).toContain("/audit/Alice1111111111111111111111111111111111111#");

    const fragment = url.split("#")[1];
    expect(fragment).toBeDefined();
    expect(fragment.length).toBeGreaterThan(0);

    // Fragment must round-trip back to the original sig.
    const recovered = decodeAuditPackage(fragment);
    expect(Array.from(recovered)).toEqual(Array.from(sig));
  });
});
