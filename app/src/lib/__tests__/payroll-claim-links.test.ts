import { describe, expect, it } from "vitest";
import {
  decodeEphemeralPrivateKey,
  encodeEphemeralPrivateKey,
  ephemeralKeypairFromBytes,
  generateClaimUrl,
  generateEphemeralKeypair,
  parseClaimUrlFragment,
  rowsToClaimLinkCsv,
  type ClaimLinkRow,
} from "../payroll-claim-links";

describe("generateEphemeralKeypair", () => {
  it("returns a 64-byte private key and 32-byte public key", () => {
    const kp = generateEphemeralKeypair();
    expect(kp.privateKey).toBeInstanceOf(Uint8Array);
    expect(kp.privateKey.length).toBe(64);
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey.length).toBe(32);
    // Private key's last 32 bytes ARE the public key (Ed25519 secret
    // key format used by Solana).
    expect(Array.from(kp.privateKey.slice(32))).toEqual(Array.from(kp.publicKey));
  });

  it("produces a base58 address that is non-empty and ≤ 44 chars", () => {
    const kp = generateEphemeralKeypair();
    expect(kp.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  it("generates different keypairs every call (csprng)", () => {
    const a = generateEphemeralKeypair();
    const b = generateEphemeralKeypair();
    expect(a.address).not.toBe(b.address);
  });
});

describe("encodeEphemeralPrivateKey + decodeEphemeralPrivateKey roundtrip", () => {
  it("preserves all 64 bytes losslessly", () => {
    const kp = generateEphemeralKeypair();
    const encoded = encodeEphemeralPrivateKey(kp.privateKey);
    const decoded = decodeEphemeralPrivateKey(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(kp.privateKey));
  });

  it("uses URL-safe base64 (no +, /, or = chars)", () => {
    const kp = generateEphemeralKeypair();
    const encoded = encodeEphemeralPrivateKey(kp.privateKey);
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it("rejects encoded payloads of the wrong length", () => {
    expect(() => decodeEphemeralPrivateKey("c2hvcnQ")).toThrow(/64-byte/);
  });
});

describe("ephemeralKeypairFromBytes", () => {
  it("recovers the same address as the original generation", () => {
    const original = generateEphemeralKeypair();
    const recovered = ephemeralKeypairFromBytes(original.privateKey);
    expect(recovered.address).toBe(original.address);
    expect(Array.from(recovered.publicKey)).toEqual(Array.from(original.publicKey));
  });
});

describe("generateClaimUrl", () => {
  it("formats /claim/<batch>/<row>#k=<key> with no metadata", () => {
    const kp = generateEphemeralKeypair();
    const url = generateClaimUrl({
      baseUrl: "https://veil.app",
      batchId: "payroll_abc",
      row: 3,
      ephemeralPrivateKey: kp.privateKey,
    });
    expect(url).toMatch(/^https:\/\/veil\.app\/claim\/payroll_abc\/3#k=[A-Za-z0-9_-]+$/);
  });

  it("trims trailing slash from baseUrl", () => {
    const kp = generateEphemeralKeypair();
    const url = generateClaimUrl({
      baseUrl: "https://veil.app/",
      batchId: "b",
      row: 0,
      ephemeralPrivateKey: kp.privateKey,
    });
    expect(url).toMatch(/^https:\/\/veil\.app\/claim\/b\/0#k=/);
    // Important: NOT veil.app//claim/...
    expect(url).not.toMatch(/\/\/claim/);
  });

  it("appends m=<metadata> when metadata is provided", () => {
    const kp = generateEphemeralKeypair();
    const url = generateClaimUrl({
      baseUrl: "https://veil.app",
      batchId: "batch1",
      row: 0,
      ephemeralPrivateKey: kp.privateKey,
      metadata: {
        amount: "100.00",
        symbol: "USDC",
        sender: "Acme Inc",
        mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amountBaseUnits: "100000000",
      },
    });
    expect(url).toContain("&m=");
  });

  it("URL-encodes batch IDs containing special chars", () => {
    const kp = generateEphemeralKeypair();
    const url = generateClaimUrl({
      baseUrl: "https://veil.app",
      batchId: "payroll/with/slashes",
      row: 0,
      ephemeralPrivateKey: kp.privateKey,
    });
    expect(url).toContain("payroll%2Fwith%2Fslashes");
  });
});

describe("parseClaimUrlFragment", () => {
  it("roundtrips a URL with metadata back into priv key + metadata", () => {
    const kp = generateEphemeralKeypair();
    const meta = {
      amount: "250.50",
      symbol: "USDC",
      sender: "Acme Payroll",
      mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      amountBaseUnits: "250500000",
    };
    const url = generateClaimUrl({
      baseUrl: "https://veil.app",
      batchId: "b",
      row: 0,
      ephemeralPrivateKey: kp.privateKey,
      metadata: meta,
    });
    const fragment = url.slice(url.indexOf("#"));
    const parsed = parseClaimUrlFragment(fragment);
    expect(Array.from(parsed.privateKey)).toEqual(Array.from(kp.privateKey));
    expect(parsed.metadata).toEqual(meta);
  });

  it("returns null metadata when m= is absent", () => {
    const kp = generateEphemeralKeypair();
    const url = generateClaimUrl({
      baseUrl: "https://veil.app",
      batchId: "b",
      row: 0,
      ephemeralPrivateKey: kp.privateKey,
    });
    const parsed = parseClaimUrlFragment(url.slice(url.indexOf("#")));
    expect(parsed.metadata).toBeNull();
    expect(Array.from(parsed.privateKey)).toEqual(Array.from(kp.privateKey));
  });

  it("throws when k= is missing", () => {
    expect(() => parseClaimUrlFragment("#m=eyJmb28iOjF9")).toThrow(/k=/);
  });

  it("tolerates missing leading hash", () => {
    const kp = generateEphemeralKeypair();
    const encoded = encodeEphemeralPrivateKey(kp.privateKey);
    const parsed = parseClaimUrlFragment(`k=${encoded}`);
    expect(Array.from(parsed.privateKey)).toEqual(Array.from(kp.privateKey));
  });

  it("degrades to null metadata on malformed m=", () => {
    const kp = generateEphemeralKeypair();
    const encoded = encodeEphemeralPrivateKey(kp.privateKey);
    const parsed = parseClaimUrlFragment(`#k=${encoded}&m=not-base64-at-all!@#`);
    expect(parsed.metadata).toBeNull();
  });
});

describe("rowsToClaimLinkCsv", () => {
  const rows: ClaimLinkRow[] = [
    {
      recipient: "AAA",
      amount: "100.00 USDC",
      status: "direct",
    },
    {
      recipient: "BBB",
      amount: "50.00 USDC",
      status: "claim-link",
      claimUrl: "https://veil.app/claim/b/1#k=xyz",
    },
    {
      recipient: "CCC",
      amount: "200.00 USDC",
      status: "failed",
      error: "boom",
    },
  ];

  it("produces a header line + one row per input", () => {
    const csv = rowsToClaimLinkCsv(rows);
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(4); // header + 3 rows
    expect(lines[0]).toBe("row,recipient,amount,status,claim_url");
  });

  it("leaves claim_url empty for direct sends", () => {
    const csv = rowsToClaimLinkCsv(rows);
    const lines = csv.trim().split("\n");
    expect(lines[1]).toBe("1,AAA,100.00 USDC,direct,");
    expect(lines[2]).toBe("2,BBB,50.00 USDC,claim-link,https://veil.app/claim/b/1#k=xyz");
    expect(lines[3]).toBe("3,CCC,200.00 USDC,failed,");
  });
});
