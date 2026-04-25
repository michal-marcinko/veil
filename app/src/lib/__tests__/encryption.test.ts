import { describe, expect, it, vi } from "vitest";
import { deriveKeyFromWalletSignature } from "@/lib/encryption";

function fakeWallet(signMessageImpl: (msg: Uint8Array) => Promise<Uint8Array>) {
  return { signMessage: signMessageImpl };
}

describe("deriveKeyFromWalletSignature", () => {
  it("returns a 32-byte key", async () => {
    const wallet = fakeWallet(async () => new Uint8Array(64).fill(7));
    const key = await deriveKeyFromWalletSignature(wallet as any, "inv_abc");
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
  });

  it("is deterministic — same signature + invoiceId → same key", async () => {
    const sig = new Uint8Array(64).fill(3);
    const wallet = fakeWallet(async () => sig);
    const k1 = await deriveKeyFromWalletSignature(wallet as any, "inv_abc");
    const k2 = await deriveKeyFromWalletSignature(wallet as any, "inv_abc");
    expect(Array.from(k1)).toEqual(Array.from(k2));
  });

  it("different invoiceIds → different keys (wallet signs different messages)", async () => {
    const signMessage = vi.fn(async (msg: Uint8Array) => {
      // Fake signature = SHA-256 of the message bytes, truncated/padded to 64.
      const buf = await crypto.subtle.digest("SHA-256", msg);
      const out = new Uint8Array(64);
      out.set(new Uint8Array(buf), 0);
      out.set(new Uint8Array(buf), 32);
      return out;
    });
    const wallet = fakeWallet(signMessage);
    const k1 = await deriveKeyFromWalletSignature(wallet as any, "inv_abc");
    const k2 = await deriveKeyFromWalletSignature(wallet as any, "inv_def");
    expect(Array.from(k1)).not.toEqual(Array.from(k2));

    expect(signMessage).toHaveBeenCalledTimes(2);
    const msg1 = new TextDecoder().decode(signMessage.mock.calls[0][0]);
    const msg2 = new TextDecoder().decode(signMessage.mock.calls[1][0]);
    expect(msg1).toBe("Veil invoice inv_abc");
    expect(msg2).toBe("Veil invoice inv_def");
  });

  it("throws a readable error when wallet.signMessage is missing", async () => {
    await expect(
      deriveKeyFromWalletSignature({} as any, "inv_abc"),
    ).rejects.toThrow(/signMessage/);
  });
});
