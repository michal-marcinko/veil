import { describe, expect, it } from "vitest";
import * as ed from "@noble/ed25519";

describe("@noble/ed25519 import smoke test", () => {
  it("exports verifyAsync, getPublicKeyAsync, signAsync", () => {
    expect(ed.verifyAsync).toBeTypeOf("function");
    expect(ed.getPublicKeyAsync).toBeTypeOf("function");
    expect(ed.signAsync).toBeTypeOf("function");
  });

  it("round-trips a sign/verify with a real key", async () => {
    const priv = ed.utils.randomPrivateKey();
    const pub = await ed.getPublicKeyAsync(priv);
    const msg = new TextEncoder().encode("hello");
    const sig = await ed.signAsync(msg, priv);
    expect(await ed.verifyAsync(sig, msg, pub)).toBe(true);
  });
});
