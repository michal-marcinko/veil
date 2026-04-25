import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { fetchInvoicePublic } from "../anchor";

describe("fetchInvoicePublic", () => {
  // This is a shape-only test — it confirms the function exists and has the
  // right signature. Real fetch is exercised in the E2E smoke test (Task 6).
  it("is an async function that accepts a PublicKey", () => {
    expect(fetchInvoicePublic).toBeTypeOf("function");
    expect(fetchInvoicePublic.constructor.name).toBe("AsyncFunction");
    // Confirm it doesn't throw synchronously when called with a valid PublicKey.
    // Network call will error but only after the sync setup returns.
    const p = fetchInvoicePublic(PublicKey.default);
    expect(p).toBeInstanceOf(Promise);
    // Swallow the rejection so vitest doesn't report an unhandled promise.
    p.catch(() => {});
  });
});
