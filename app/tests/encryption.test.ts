import { describe, expect, it } from "vitest";
import { encryptJson, decryptJson, generateKey, keyToBase58, keyFromBase58 } from "@/lib/encryption";

describe("encryption", () => {
  it("round-trips a JSON payload through encrypt/decrypt with matching key", async () => {
    const payload = { invoice_id: "inv_123", total: "4500000000", note: "Thanks" };
    const key = generateKey();
    const ciphertext = await encryptJson(payload, key);
    const decrypted = await decryptJson(ciphertext, key);
    expect(decrypted).toEqual(payload);
  });

  it("fails to decrypt with a wrong key", async () => {
    const payload = { secret: "value" };
    const key = generateKey();
    const wrong = generateKey();
    const ciphertext = await encryptJson(payload, key);
    await expect(decryptJson(ciphertext, wrong)).rejects.toThrow();
  });

  it("round-trips a key through base58 encoding", () => {
    const key = generateKey();
    const encoded = keyToBase58(key);
    const decoded = keyFromBase58(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(key));
  });
});
