import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { InvoiceMetadata } from "../types";

const MOCK_METADATA: InvoiceMetadata = {
  version: 1,
  invoice_id: "inv_dl_test",
  created_at: "2026-04-26T10:00:00.000Z",
  creator: { display_name: "X", wallet: "w", contact: null, logo_url: null },
  payer: { display_name: "Y", wallet: null, contact: null },
  currency: { mint: "m", symbol: "USDC", decimals: 6 },
  line_items: [{ description: "Item", quantity: "1", unit_price: "1000000", total: "1000000" }],
  subtotal: "1000000",
  tax: "0",
  total: "1000000",
  due_date: null,
  terms: null,
  notes: null,
};

describe("downloadInvoicePdf", () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let appendChild: ReturnType<typeof vi.fn>;
  let removeChild: ReturnType<typeof vi.fn>;
  let anchorClicks: number;

  beforeEach(() => {
    anchorClicks = 0;
    createObjectURL = vi.fn().mockReturnValue("blob:fake");
    revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, configurable: true });

    appendChild = vi.fn();
    removeChild = vi.fn();
    Object.defineProperty(document.body, "appendChild", { value: appendChild, configurable: true });
    Object.defineProperty(document.body, "removeChild", { value: removeChild, configurable: true });

    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = origCreate(tag);
      if (tag === "a") {
        // capture clicks instead of navigating
        Object.defineProperty(el, "click", { value: () => { anchorClicks += 1; }, configurable: true });
      }
      return el;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("triggers a download with the expected filename", async () => {
    const { downloadInvoicePdf } = await import("../pdfDownload");
    await downloadInvoicePdf(MOCK_METADATA, "11111111111111111111111111111111", "veil-inv-test.pdf");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(anchorClicks).toBe(1);
    expect(appendChild).toHaveBeenCalledTimes(1);
    expect(removeChild).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake");
  });

  it("derives a sensible default filename from invoice_id", async () => {
    const { downloadInvoicePdf } = await import("../pdfDownload");
    const a: HTMLAnchorElement[] = [];
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = origCreate(tag);
      if (tag === "a") {
        Object.defineProperty(el, "click", { value: () => {}, configurable: true });
        a.push(el as HTMLAnchorElement);
      }
      return el;
    });
    await downloadInvoicePdf(MOCK_METADATA, "11111111111111111111111111111111");
    expect(a[0].download).toBe("veil-inv_dl_test.pdf");
  });
});
