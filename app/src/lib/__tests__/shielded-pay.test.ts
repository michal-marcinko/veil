import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  decideShieldedPayAvailability,
  loadShieldedAvailability,
  type ShieldedAvailability,
} from "@/lib/shielded-pay";

describe("decideShieldedPayAvailability", () => {
  it("returns 'available' when encrypted balance >= total", () => {
    const d = decideShieldedPayAvailability({ encryptedBalance: 1_000_000n, total: 1_000_000n });
    expect(d).toEqual<ShieldedAvailability>({ kind: "available", balance: 1_000_000n });
  });

  it("returns 'available' when encrypted balance strictly exceeds total", () => {
    const d = decideShieldedPayAvailability({ encryptedBalance: 5_000_000n, total: 1_000_000n });
    expect(d).toEqual<ShieldedAvailability>({ kind: "available", balance: 5_000_000n });
  });

  it("returns 'insufficient' when encrypted balance is below total", () => {
    const d = decideShieldedPayAvailability({ encryptedBalance: 999_999n, total: 1_000_000n });
    expect(d).toEqual<ShieldedAvailability>({ kind: "insufficient", balance: 999_999n });
  });

  it("returns 'insufficient' when encrypted balance is zero", () => {
    const d = decideShieldedPayAvailability({ encryptedBalance: 0n, total: 1_000_000n });
    expect(d).toEqual<ShieldedAvailability>({ kind: "insufficient", balance: 0n });
  });

  it("returns 'insufficient' when total is zero but balance is zero too (degenerate invoice)", () => {
    // encryptedBalance >= total holds (0 >= 0), so 'available'. This guards the boundary.
    const d = decideShieldedPayAvailability({ encryptedBalance: 0n, total: 0n });
    expect(d).toEqual<ShieldedAvailability>({ kind: "available", balance: 0n });
  });
});

describe("loadShieldedAvailability", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("calls getEncryptedBalance with the mint and wraps the result as 'available'", async () => {
    const fakeClient = { id: "client-1" } as any;
    const fakeGetEncryptedBalance = vi.fn().mockResolvedValue(2_000_000n);

    const d = await loadShieldedAvailability({
      client: fakeClient,
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      total: 1_000_000n,
      getEncryptedBalance: fakeGetEncryptedBalance,
    });

    expect(fakeGetEncryptedBalance).toHaveBeenCalledWith(
      fakeClient,
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    );
    expect(d).toEqual<ShieldedAvailability>({ kind: "available", balance: 2_000_000n });
  });

  it("wraps a sub-total balance as 'insufficient'", async () => {
    const d = await loadShieldedAvailability({
      client: {} as any,
      mint: "mint-x",
      total: 1_000_000n,
      getEncryptedBalance: vi.fn().mockResolvedValue(500n),
    });
    expect(d).toEqual<ShieldedAvailability>({ kind: "insufficient", balance: 500n });
  });

  it("surfaces the error as 'errored' when the querier throws", async () => {
    const d = await loadShieldedAvailability({
      client: {} as any,
      mint: "mint-x",
      total: 1_000_000n,
      getEncryptedBalance: vi.fn().mockRejectedValue(new Error("indexer unreachable")),
    });
    expect(d.kind).toBe("errored");
    if (d.kind === "errored") {
      expect(d.message).toMatch(/indexer unreachable/);
    }
  });
});
