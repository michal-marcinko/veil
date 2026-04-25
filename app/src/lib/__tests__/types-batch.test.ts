import { describe, expect, it } from "vitest";
import { buildMetadata, validateMetadata, type InvoiceMetadata } from "@/lib/types";

const baseArgs = {
  invoiceId: "inv_1",
  creatorDisplayName: "Alice",
  creatorWallet: "Alice111111111111111111111111111111111111",
  payerDisplayName: "Bob",
  payerWallet: null,
  mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  symbol: "USDC",
  decimals: 6,
  lineItems: [{ description: "Work", quantity: "1", unitPrice: "1000000", total: "1000000" }],
  subtotal: "1000000",
  tax: "0",
  total: "1000000",
  dueDate: null,
  terms: null,
  notes: null,
};

describe("batch_id on metadata", () => {
  it("defaults to null when batchId not supplied", () => {
    const md = buildMetadata(baseArgs);
    expect(md.batch_id).toBeNull();
  });

  it("propagates a supplied batchId", () => {
    const md = buildMetadata({ ...baseArgs, batchId: "batch_abc123" });
    expect(md.batch_id).toBe("batch_abc123");
  });

  it("validates with batch_id present", () => {
    const md = buildMetadata({ ...baseArgs, batchId: "batch_abc123" });
    expect(() => validateMetadata(md)).not.toThrow();
  });

  it("validates with batch_id null (backward compat)", () => {
    const md = buildMetadata(baseArgs);
    expect(() => validateMetadata(md)).not.toThrow();
  });

  it("rejects empty-string batch_id", () => {
    const md: InvoiceMetadata = { ...buildMetadata(baseArgs), batch_id: "" };
    expect(() => validateMetadata(md)).toThrow(/batch_id/);
  });

  it("rejects non-string batch_id", () => {
    const md: any = { ...buildMetadata(baseArgs), batch_id: 42 };
    expect(() => validateMetadata(md)).toThrow(/batch_id/);
  });
});
