import { describe, it, expect } from "vitest";
import { pdf } from "@react-pdf/renderer";
import { InvoicePdfDocument } from "../invoicePdf";
import type { InvoiceMetadata } from "../types";

const MOCK_METADATA: InvoiceMetadata = {
  version: 1,
  invoice_id: "inv_test_abc",
  created_at: "2026-04-26T10:00:00.000Z",
  creator: {
    display_name: "Acme Design Ltd.",
    wallet: "8xK2pN3qVbS9wL5R7Z3X1Y2A4B6C8D0E1F2G3H4J5K",
    contact: "billing@acme.example",
    logo_url: null,
  },
  payer: {
    display_name: "Globex Corp.",
    wallet: null,
    contact: null,
  },
  currency: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", decimals: 6 },
  line_items: [
    { description: "Brand identity design", quantity: "1", unit_price: "4000000000", total: "4000000000" },
    { description: "Revisions · 4 hrs", quantity: "4", unit_price: "50000000", total: "200000000" },
  ],
  subtotal: "4200000000",
  tax: "0",
  total: "4200000000",
  due_date: "2026-05-12",
  terms: null,
  notes: "Net 30. Late fee 1.5%/month.",
};

describe("InvoicePdfDocument", () => {
  it("renders to a non-empty Blob for valid metadata", async () => {
    const blob = await pdf(InvoicePdfDocument({ metadata: MOCK_METADATA, invoicePda: "11111111111111111111111111111111" })).toBlob();
    expect(blob.size).toBeGreaterThan(1000); // empty PDF would be ~500 bytes; real one is many KB
    expect(blob.type).toBe("application/pdf");
  });

  it("survives missing optional fields (notes, due_date, contact)", async () => {
    const minimal: InvoiceMetadata = {
      ...MOCK_METADATA,
      notes: null,
      due_date: null,
      creator: { ...MOCK_METADATA.creator, contact: null },
    };
    const blob = await pdf(InvoicePdfDocument({ metadata: minimal, invoicePda: "22222222222222222222222222222222" })).toBlob();
    expect(blob.size).toBeGreaterThan(1000);
  });

  it("handles a single line item with no tax", async () => {
    const single: InvoiceMetadata = {
      ...MOCK_METADATA,
      line_items: [{ description: "Consulting · 1 hr", quantity: "1", unit_price: "100000000", total: "100000000" }],
      subtotal: "100000000",
      tax: "0",
      total: "100000000",
    };
    const blob = await pdf(InvoicePdfDocument({ metadata: single, invoicePda: "33333333333333333333333333333333" })).toBlob();
    expect(blob.size).toBeGreaterThan(1000);
  });
});
