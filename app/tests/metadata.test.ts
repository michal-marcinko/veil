import { describe, expect, it } from "vitest";
import { buildMetadata, validateMetadata, type InvoiceMetadata } from "@/lib/types";

describe("invoice metadata", () => {
  it("builds a well-formed metadata object", () => {
    const md = buildMetadata({
      invoiceId: "inv_123",
      creatorDisplayName: "Acme",
      creatorWallet: "Alice111111111111111111111111111111111111",
      payerDisplayName: "Globex",
      payerWallet: null,
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      symbol: "USDC",
      decimals: 6,
      lineItems: [{ description: "Design", quantity: "40", unitPrice: "100000000", total: "4000000000" }],
      subtotal: "4000000000",
      tax: "0",
      total: "4000000000",
      dueDate: "2026-05-15",
      terms: "Net 30",
      notes: "Thanks",
    });

    expect(md.version).toBe(1);
    expect(md.invoice_id).toBe("inv_123");
    expect(md.line_items).toHaveLength(1);
    expect(md.total).toBe("4000000000");
  });

  it("validates a correct metadata object", () => {
    const md: InvoiceMetadata = {
      version: 1,
      invoice_id: "inv_123",
      created_at: new Date().toISOString(),
      creator: { display_name: "A", wallet: "A1", contact: null, logo_url: null },
      payer: { display_name: "B", wallet: null, contact: null },
      currency: { mint: "USDC", symbol: "USDC", decimals: 6 },
      line_items: [],
      subtotal: "0",
      tax: "0",
      total: "0",
      due_date: null,
      terms: null,
      notes: null,
    };
    expect(() => validateMetadata(md)).not.toThrow();
  });

  it("rejects metadata with mismatched totals", () => {
    const md: InvoiceMetadata = {
      version: 1,
      invoice_id: "inv_123",
      created_at: new Date().toISOString(),
      creator: { display_name: "A", wallet: "A1", contact: null, logo_url: null },
      payer: { display_name: "B", wallet: null, contact: null },
      currency: { mint: "USDC", symbol: "USDC", decimals: 6 },
      line_items: [{ description: "x", quantity: "1", unit_price: "100", total: "100" }],
      subtotal: "999", // wrong
      tax: "0",
      total: "100",
      due_date: null,
      terms: null,
      notes: null,
    };
    expect(() => validateMetadata(md)).toThrow(/subtotal/);
  });
});
