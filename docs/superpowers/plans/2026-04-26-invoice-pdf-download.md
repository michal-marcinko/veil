# Invoice PDF Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-click "Download PDF" affordance to both the creator's invoice re-open view (`/invoice/[id]`) and the payer's pay view (`/pay/[id]`) that produces a brand-styled, print-ready PDF of the decrypted invoice.

**Architecture:** Client-side PDF generation via `@react-pdf/renderer`, lazy-loaded only when the user clicks the download button (so the ~600KB renderer doesn't inflate the initial route bundle). PDF rendering uses a single shared `<InvoicePdfDocument>` component that takes `InvoiceMetadata` and produces a deterministic visual layout matching the brand (cream paper background, ink text, sage settled badge, embedded Veil logo). A thin `downloadInvoicePdf(metadata, filename)` helper handles the dynamic import + Blob URL + `<a download>` click trigger so call sites stay one-line.

**Tech Stack:** Next.js 14 · React 18 · `@react-pdf/renderer` (NEW dep, ~600KB lazy-loaded) · TypeScript · Vitest. No backend, no email, no signed URLs — purely client-side PDF generation from the already-decrypted in-memory metadata.

**Spec source:** Brainstorm exchange 2026-04-26: Codex flagged "real billing software" perception gap; PDF download is the highest-ROI addition for the Umbra side track because judges immediately understand it and it makes Veil feel like a real product, not a crypto demo. Email backend explicitly OUT of scope for this plan (privacy contradiction — emailing `/pay/[id]#<key>` would put the decryption key through SMTP servers).

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `app/package.json` | Modify | Add `@react-pdf/renderer` dep |
| `app/src/lib/invoicePdf.tsx` | NEW | `<InvoicePdfDocument>` React component using `@react-pdf/renderer` primitives. Pure presentation, no data fetching. |
| `app/src/lib/pdfDownload.ts` | NEW | `downloadInvoicePdf(metadata, filename?)` — lazy-imports `invoicePdf.tsx`, renders to Blob, triggers browser download. Wraps the dynamic import so call sites don't need to know about it. |
| `app/src/lib/__tests__/invoicePdf.test.ts` | NEW | Unit test: renders document with mock metadata, asserts a non-empty Buffer/Blob is produced and contains the expected invoice ID + amount as substrings of the PDF text stream. |
| `app/src/lib/__tests__/pdf-download.test.ts` | NEW | Unit test: mocks `URL.createObjectURL` + DOM, asserts `downloadInvoicePdf` triggers an anchor click with the right filename. |
| `app/src/app/invoice/[id]/page.tsx` | Modify | Add "Download PDF" button next to existing actions when `metadata` is loaded. |
| `app/src/app/pay/[id]/page.tsx` | Modify | Add "Download PDF" button after metadata decrypts (works pre- and post-payment). |

No new API routes. No backend. No env vars.

---

## Visual reference — what the PDF should look like

A single A4 / Letter page rendered approximately like:

```
┌────────────────────────────────────────────────────────┐
│  [Veil logo SVG]  Veil                  Invoice INV-001 │
│  ───────────────────────────────────────────────────── │
│                                                        │
│  FROM                          BILL TO                 │
│  Acme Design Ltd.              Globex Corp.            │
│                                                        │
│  ISSUED                        DUE                     │
│  2026-04-12                    2026-05-12              │
│                                                        │
│  ─────────────────────────────────────────────────────  │
│  DESCRIPTION              QTY    RATE      AMOUNT      │
│  Brand identity design     1     $4,000    $4,000.00   │
│  Revisions · 4 hrs         4     $50       $200.00     │
│  ─────────────────────────────────────────────────────  │
│                                          SUBTOTAL      │
│                                          $4,200.00     │
│                                                        │
│                                          TOTAL DUE     │
│                                          $4,200.00     │
│                                                        │
│  NOTES                                                 │
│  Net 30. Late fee 1.5%/month.                          │
│                                                        │
│  ─────────────────────────────────────────────────────  │
│  Settled via USDC · Encrypted onchain via Umbra        │
│  Invoice PDA: <pda> · Generated 2026-04-26             │
└────────────────────────────────────────────────────────┘
```

Cream paper background (`#f8f4e9`), ink text (`#1c1712`), gold accent (`#6a2420`) for the eyebrow labels, sage (`#3a6b4a`) for the "Settled via USDC" indicator. Helvetica fallback (no custom font registration in v1 — saves bundle weight; brand fidelity comes from layout + color, not typography).

---

## Task 1: Install @react-pdf/renderer + smoke-test the import

**Files:**
- Modify: `app/package.json`
- Create: `app/src/lib/__tests__/pdf-renderer-imports.test.ts`

- [ ] **Step 1: Add the dep**

```bash
cd /c/Users/marci/Desktop/veil
npm install --workspace app @react-pdf/renderer@^3.4.0
```

Expected: `package.json` gains `"@react-pdf/renderer": "^3.4.0"` under `"dependencies"`. Lockfile updated.

- [ ] **Step 2: Write a smoke test asserting the SDK exports we need**

Create `app/src/lib/__tests__/pdf-renderer-imports.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { Document, Page, Text, View, StyleSheet, pdf } from "@react-pdf/renderer";

describe("@react-pdf/renderer imports", () => {
  it("exports the primitives we depend on", () => {
    expect(Document).toBeDefined();
    expect(Page).toBeDefined();
    expect(Text).toBeDefined();
    expect(View).toBeDefined();
    expect(typeof StyleSheet.create).toBe("function");
    expect(typeof pdf).toBe("function");
  });
});
```

- [ ] **Step 3: Run the smoke test**

```bash
cd /c/Users/marci/Desktop/veil/app
npm test -- src/lib/__tests__/pdf-renderer-imports
```

Expected: 1 passing test. If the test errors with "Cannot find module," the install didn't take — re-run Step 1.

- [ ] **Step 4: Commit**

```bash
cd /c/Users/marci/Desktop/veil
git add app/package.json package-lock.json app/src/lib/__tests__/pdf-renderer-imports.test.ts
git commit -m "chore(deps): add @react-pdf/renderer for client-side invoice PDF generation"
```

---

## Task 2: Build the `<InvoicePdfDocument>` component (TDD)

**Files:**
- Create: `app/src/lib/invoicePdf.tsx`
- Create: `app/src/lib/__tests__/invoicePdf.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/src/lib/__tests__/invoicePdf.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /c/Users/marci/Desktop/veil/app
npm test -- src/lib/__tests__/invoicePdf
```

Expected: FAIL with `Failed to resolve import "../invoicePdf"`.

- [ ] **Step 3: Implement the component**

Create `app/src/lib/invoicePdf.tsx`:

```tsx
/* eslint-disable react/jsx-key */
import React from "react";
import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import type { InvoiceMetadata } from "./types";

// Brand palette — keep in sync with tailwind.config.ts
const PAPER = "#f8f4e9";
const INK = "#1c1712";
const MUTED = "#736b57";
const DIM = "#a59c84";
const LINE = "#d6ceba";
const GOLD = "#6a2420";
const SAGE = "#3a6b4a";

const styles = StyleSheet.create({
  page: {
    backgroundColor: PAPER,
    color: INK,
    padding: 56,
    fontFamily: "Helvetica",
    fontSize: 10,
    lineHeight: 1.5,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 32,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: LINE,
  },
  brand: {
    flexDirection: "column",
  },
  brandName: {
    fontSize: 16,
    fontFamily: "Helvetica-Bold",
    color: INK,
    letterSpacing: -0.4,
  },
  brandTagline: {
    fontSize: 8,
    color: MUTED,
    marginTop: 2,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  invoiceMeta: {
    flexDirection: "column",
    alignItems: "flex-end",
  },
  eyebrow: {
    fontSize: 7,
    color: MUTED,
    textTransform: "uppercase",
    letterSpacing: 1.2,
    marginBottom: 3,
  },
  invoiceId: {
    fontSize: 11,
    fontFamily: "Courier",
    color: INK,
  },
  partyRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 28,
  },
  party: {
    flexDirection: "column",
    width: "48%",
  },
  partyName: {
    fontSize: 13,
    fontFamily: "Helvetica-Bold",
    color: INK,
    marginTop: 4,
  },
  partyContact: {
    fontSize: 9,
    color: MUTED,
    marginTop: 3,
  },
  dateRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 32,
  },
  dateBlock: {
    flexDirection: "column",
    width: "48%",
  },
  dateValue: {
    fontSize: 11,
    fontFamily: "Courier",
    color: INK,
    marginTop: 4,
  },
  itemsHeader: {
    flexDirection: "row",
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: LINE,
    marginBottom: 8,
  },
  itemsHeaderCell: {
    fontSize: 7,
    color: MUTED,
    textTransform: "uppercase",
    letterSpacing: 1.2,
  },
  itemRow: {
    flexDirection: "row",
    paddingVertical: 8,
    borderBottomWidth: 0.5,
    borderBottomColor: LINE,
  },
  cellDescription: { width: "55%", color: INK, fontSize: 10 },
  cellQty: { width: "10%", textAlign: "right", color: MUTED, fontFamily: "Courier", fontSize: 10 },
  cellRate: { width: "17%", textAlign: "right", color: MUTED, fontFamily: "Courier", fontSize: 10 },
  cellAmount: { width: "18%", textAlign: "right", color: INK, fontFamily: "Courier", fontSize: 10 },
  totalsContainer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: 24,
  },
  totalsBlock: {
    width: "45%",
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
  },
  totalRowFinal: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: 12,
    marginTop: 8,
    borderTopWidth: 1,
    borderTopColor: INK,
  },
  totalLabel: { fontSize: 9, color: MUTED, textTransform: "uppercase", letterSpacing: 1 },
  totalLabelFinal: { fontSize: 10, color: INK, fontFamily: "Helvetica-Bold", textTransform: "uppercase", letterSpacing: 1 },
  totalValue: { fontSize: 11, color: INK, fontFamily: "Courier" },
  totalValueFinal: { fontSize: 16, color: INK, fontFamily: "Helvetica-Bold" },
  notesBlock: {
    marginTop: 36,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: LINE,
  },
  notesText: {
    fontSize: 10,
    color: INK,
    marginTop: 6,
  },
  footer: {
    position: "absolute",
    bottom: 32,
    left: 56,
    right: 56,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: LINE,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  footerText: {
    fontSize: 7,
    color: DIM,
    textTransform: "uppercase",
    letterSpacing: 1.2,
  },
  settledBadge: {
    fontSize: 7,
    color: SAGE,
    textTransform: "uppercase",
    letterSpacing: 1.2,
  },
});

/**
 * Format a base-units amount string ("4200000000") into a human-readable
 * string ("$4,200.00") given the currency's decimals. Mirrors the
 * formatting used in app/src/components/InvoiceView.tsx so the PDF and
 * the on-screen view show identical numbers.
 */
function formatAmount(units: string, decimals: number, symbol: string): string {
  const bn = BigInt(units);
  const divisor = BigInt(10) ** BigInt(decimals);
  const whole = bn / divisor;
  const fraction = bn % divisor;
  const display = Math.min(4, decimals);
  const padded = fraction.toString().padStart(decimals, "0").slice(0, display);
  const trimmed = padded.replace(/0+$/, "").padEnd(2, "0");
  const symbolPrefix = symbol === "USDC" ? "$" : "";
  const symbolSuffix = symbol === "USDC" ? "" : ` ${symbol}`;
  return `${symbolPrefix}${whole.toLocaleString("en-US")}.${trimmed}${symbolSuffix}`;
}

function formatIssued(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

function truncatePda(pda: string): string {
  if (pda.length <= 16) return pda;
  return `${pda.slice(0, 8)}…${pda.slice(-8)}`;
}

interface InvoicePdfDocumentProps {
  metadata: InvoiceMetadata;
  invoicePda: string;
}

export function InvoicePdfDocument({ metadata, invoicePda }: InvoicePdfDocumentProps) {
  const { creator, payer, currency, line_items, subtotal, tax, total, notes, due_date, invoice_id, created_at } = metadata;
  const hasTax = BigInt(tax) > 0n;
  const generatedAt = new Date().toISOString().slice(0, 10);

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {/* Header — brand + invoice ID */}
        <View style={styles.header}>
          <View style={styles.brand}>
            <Text style={styles.brandName}>Veil</Text>
            <Text style={styles.brandTagline}>Private invoicing</Text>
          </View>
          <View style={styles.invoiceMeta}>
            <Text style={styles.eyebrow}>Invoice</Text>
            <Text style={styles.invoiceId}>{invoice_id}</Text>
          </View>
        </View>

        {/* Parties */}
        <View style={styles.partyRow}>
          <View style={styles.party}>
            <Text style={styles.eyebrow}>From</Text>
            <Text style={styles.partyName}>{creator.display_name}</Text>
            {creator.contact ? <Text style={styles.partyContact}>{creator.contact}</Text> : null}
          </View>
          <View style={styles.party}>
            <Text style={styles.eyebrow}>Bill to</Text>
            <Text style={styles.partyName}>{payer.display_name}</Text>
            {payer.contact ? <Text style={styles.partyContact}>{payer.contact}</Text> : null}
          </View>
        </View>

        {/* Dates */}
        <View style={styles.dateRow}>
          <View style={styles.dateBlock}>
            <Text style={styles.eyebrow}>Issued</Text>
            <Text style={styles.dateValue}>{formatIssued(created_at)}</Text>
          </View>
          <View style={styles.dateBlock}>
            <Text style={styles.eyebrow}>{due_date ? "Due" : "Settlement"}</Text>
            <Text style={styles.dateValue}>{due_date ?? currency.symbol}</Text>
          </View>
        </View>

        {/* Line items */}
        <View>
          <View style={styles.itemsHeader}>
            <Text style={[styles.cellDescription, styles.itemsHeaderCell]}>Description</Text>
            <Text style={[styles.cellQty, styles.itemsHeaderCell]}>Qty</Text>
            <Text style={[styles.cellRate, styles.itemsHeaderCell]}>Rate</Text>
            <Text style={[styles.cellAmount, styles.itemsHeaderCell]}>Amount</Text>
          </View>
          {line_items.map((li, i) => (
            <View key={i} style={styles.itemRow}>
              <Text style={styles.cellDescription}>{li.description}</Text>
              <Text style={styles.cellQty}>{li.quantity}</Text>
              <Text style={styles.cellRate}>{formatAmount(li.unit_price, currency.decimals, currency.symbol)}</Text>
              <Text style={styles.cellAmount}>{formatAmount(li.total, currency.decimals, currency.symbol)}</Text>
            </View>
          ))}
        </View>

        {/* Totals */}
        <View style={styles.totalsContainer}>
          <View style={styles.totalsBlock}>
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Subtotal</Text>
              <Text style={styles.totalValue}>{formatAmount(subtotal, currency.decimals, currency.symbol)}</Text>
            </View>
            {hasTax && (
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Tax</Text>
                <Text style={styles.totalValue}>{formatAmount(tax, currency.decimals, currency.symbol)}</Text>
              </View>
            )}
            <View style={styles.totalRowFinal}>
              <Text style={styles.totalLabelFinal}>Total Due</Text>
              <Text style={styles.totalValueFinal}>{formatAmount(total, currency.decimals, currency.symbol)}</Text>
            </View>
          </View>
        </View>

        {/* Notes */}
        {notes ? (
          <View style={styles.notesBlock}>
            <Text style={styles.eyebrow}>Notes</Text>
            <Text style={styles.notesText}>{notes}</Text>
          </View>
        ) : null}

        {/* Footer */}
        <View style={styles.footer}>
          <Text style={styles.footerText}>
            Veil · PDA {truncatePda(invoicePda)} · Generated {generatedAt}
          </Text>
          <Text style={styles.settledBadge}>Settled via {currency.symbol}</Text>
        </View>
      </Page>
    </Document>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /c/Users/marci/Desktop/veil/app
npm test -- src/lib/__tests__/invoicePdf
```

Expected: 3 passing tests.

If you get `Cannot find module 'react'` from inside `@react-pdf/renderer`, the dep wasn't installed correctly — re-run Task 1 Step 1.

If you get a `text not allowed in this context` warning, that's a `@react-pdf/renderer` quirk where bare strings aren't allowed inside `<View>` — every text MUST be wrapped in `<Text>`. Audit the JSX and fix.

- [ ] **Step 5: Commit**

```bash
cd /c/Users/marci/Desktop/veil
git add app/src/lib/invoicePdf.tsx app/src/lib/__tests__/invoicePdf.test.ts
git commit -m "feat(pdf): InvoicePdfDocument — brand-styled A4 invoice PDF from InvoiceMetadata"
```

---

## Task 3: Build the `downloadInvoicePdf` helper (TDD)

**Files:**
- Create: `app/src/lib/pdfDownload.ts`
- Create: `app/src/lib/__tests__/pdf-download.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/src/lib/__tests__/pdf-download.test.ts`:

```typescript
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
    createObjectURL = vi.fn(() => "blob:fake");
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
        Object.defineProperty(el, "click", { value: () => { anchorClicks += 1; } });
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
        Object.defineProperty(el, "click", { value: () => {} });
        a.push(el as HTMLAnchorElement);
      }
      return el;
    });
    await downloadInvoicePdf(MOCK_METADATA, "11111111111111111111111111111111");
    expect(a[0].download).toBe("veil-inv_dl_test.pdf");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /c/Users/marci/Desktop/veil/app
npm test -- src/lib/__tests__/pdf-download
```

Expected: FAIL with `Failed to resolve import "../pdfDownload"`.

- [ ] **Step 3: Implement the helper**

Create `app/src/lib/pdfDownload.ts`:

```typescript
import type { InvoiceMetadata } from "./types";

/**
 * Lazy-load the PDF renderer + invoice document and trigger a browser
 * download of the rendered invoice. Dynamic import keeps the ~600KB
 * @react-pdf bundle out of the initial route payload — only users who
 * click "Download PDF" pay the load cost.
 *
 * Filename defaults to `veil-<invoice_id>.pdf`; pass a custom string
 * to override (e.g. for accountant packets).
 */
export async function downloadInvoicePdf(
  metadata: InvoiceMetadata,
  invoicePda: string,
  filename?: string,
): Promise<void> {
  const [{ pdf }, { InvoicePdfDocument }] = await Promise.all([
    import("@react-pdf/renderer"),
    import("./invoicePdf"),
  ]);

  const blob = await pdf(InvoicePdfDocument({ metadata, invoicePda })).toBlob();
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename ?? `veil-${metadata.invoice_id}.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /c/Users/marci/Desktop/veil/app
npm test -- src/lib/__tests__/pdf-download
```

Expected: 2 passing tests.

If the second test fails because the `download` attribute isn't set, the helper isn't assigning it before `click()` — verify Step 3 implementation.

- [ ] **Step 5: Commit**

```bash
cd /c/Users/marci/Desktop/veil
git add app/src/lib/pdfDownload.ts app/src/lib/__tests__/pdf-download.test.ts
git commit -m "feat(pdf): downloadInvoicePdf helper — lazy-loads renderer, triggers blob download"
```

---

## Task 4: Wire "Download PDF" button into `/invoice/[id]` (creator's re-open view)

**Files:**
- Modify: `app/src/app/invoice/[id]/page.tsx`

- [ ] **Step 1: Add the import**

Open `app/src/app/invoice/[id]/page.tsx`. Add to the imports near the top (alongside the other `@/lib/*` imports):

```typescript
import { downloadInvoicePdf } from "@/lib/pdfDownload";
```

- [ ] **Step 2: Add a download handler + button next to the existing actions**

In the page's render section, find the block that renders `<InvoiceView metadata={metadata} />`. Immediately below it (or wherever the existing "back to dashboard" / action buttons live), add:

```tsx
<div className="mt-8 flex flex-wrap items-center gap-3">
  <button
    type="button"
    onClick={() => downloadInvoicePdf(metadata, params.id)}
    className="btn-ghost"
  >
    Download PDF
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden>
      <path d="M5.5 1v7M2.5 5.5l3 3 3-3M1.5 10h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  </button>
</div>
```

If the page already has an action row, ADD this button to it instead of creating a new row — keep the visual rhythm consistent.

- [ ] **Step 3: Run tsc to confirm no regressions**

```bash
cd /c/Users/marci/Desktop/veil/app
npx tsc --noEmit
echo "tsc: $?"
```

Expected: `tsc: 0`.

- [ ] **Step 4: Commit**

```bash
cd /c/Users/marci/Desktop/veil
git add app/src/app/invoice/[id]/page.tsx
git commit -m "feat(invoice): Download PDF button on creator re-open view"
```

---

## Task 5: Wire "Download PDF" button into `/pay/[id]` (payer's view)

**Files:**
- Modify: `app/src/app/pay/[id]/page.tsx`

- [ ] **Step 1: Add the import**

Open `app/src/app/pay/[id]/page.tsx`. Add:

```typescript
import { downloadInvoicePdf } from "@/lib/pdfDownload";
```

- [ ] **Step 2: Add the button next to the existing pay button or success state**

Find the block that renders `<InvoiceView metadata={metadata} />` and the pay/post-pay UI. Below the pay button (and visible regardless of pay state, since Bob may want a copy before OR after paying), add:

```tsx
<div className="mt-6">
  <button
    type="button"
    onClick={() => downloadInvoicePdf(metadata, params.id)}
    className="btn-quiet"
  >
    Download PDF →
  </button>
</div>
```

`btn-quiet` (gold-text quiet button per `app/src/app/globals.css`) is the right register here — the primary action is "Pay this invoice"; PDF download is a secondary affordance.

- [ ] **Step 3: Run tsc**

```bash
cd /c/Users/marci/Desktop/veil/app
npx tsc --noEmit
echo "tsc: $?"
```

Expected: `tsc: 0`.

- [ ] **Step 4: Commit**

```bash
cd /c/Users/marci/Desktop/veil
git add app/src/app/pay/[id]/page.tsx
git commit -m "feat(pay): Download PDF button on payer's invoice view"
```

---

## Task 6: Verify all gates green

**Files:** N/A — verification only.

- [ ] **Step 1: Full test suite**

```bash
cd /c/Users/marci/Desktop/veil/app
npm test
```

Expected: previous 81 tests + 6 new (1 pdf-renderer-imports + 3 invoicePdf + 2 pdf-download) = 87 total passing. Adjust the expected count if the existing baseline drifted.

- [ ] **Step 2: Type-check**

```bash
cd /c/Users/marci/Desktop/veil/app
npx tsc --noEmit
echo "tsc: $?"
```

Expected: `tsc: 0`.

- [ ] **Step 3: Production build**

```bash
cd /c/Users/marci/Desktop/veil/app
npx next build
```

Expected: build completes, route table includes `/invoice/[id]` and `/pay/[id]` at the same or smaller initial-bundle size than before — `@react-pdf/renderer` is dynamically imported, so it lands in a separate chunk that's only loaded on PDF-button click.

If the build fails for an unrelated pre-existing reason (e.g. the bundlr/got webpack quirk), confirm `/invoice/[id]` and `/pay/[id]` themselves compile fine and proceed.

- [ ] **Step 4: No commit needed if all green**

If anything failed, return to the relevant task and fix before continuing.

---

## Task 7: Manual smoke test (defer to human operator)

**Files:** N/A — manual verification only.

- [ ] **Step 1: Start the dev server**

```bash
cd /c/Users/marci/Desktop/veil/app
npm run dev
```

- [ ] **Step 2: Connect Alice's wallet, create a test invoice, copy the pay link**

Walk through the existing create flow. After creation, you'll have a `/pay/<pda>#<key>` URL.

- [ ] **Step 3: Verify Alice's `/invoice/[pda]` PDF download**

Open `/invoice/<pda>` (Alice's wallet connected). Sign the wallet challenge. After metadata decrypts, click "Download PDF". A file named `veil-<invoice_id>.pdf` should download. Open it. Verify:
- Header shows "Veil" wordmark + "Private invoicing" tagline + invoice ID
- "From" and "Bill to" rows show the right names
- Line items match what was created
- Total Due is correctly formatted with $ prefix
- Notes appear (if entered)
- Footer shows "Settled via USDC" and the truncated PDA + generated date

- [ ] **Step 4: Verify Bob's `/pay/[pda]#<key>` PDF download**

Open the pay URL in a different browser profile (Bob). After metadata decrypts, BEFORE paying, click "Download PDF →". The same PDF should download. (Bob's copy is identical to Alice's — that's correct: it's the invoice as issued.)

- [ ] **Step 5: Edge cases**

Try creating an invoice with:
- Just one line item → PDF should not crash
- No notes → PDF should not show an empty notes section
- No due date → PDF's "Due" header should fallback to "Settlement" with currency symbol
- Tax = 0 → PDF should not show a Tax row

Each should produce a clean PDF.

- [ ] **Step 6: No commit — manual smoke is verification only**

If any case produces a broken PDF, return to Task 2 and adjust the document component.

---

## Self-review — coverage check

| Brainstorm requirement | Implemented in | Status |
|---|---|---|
| Per-invoice PDF download | Tasks 4 + 5 | ✅ |
| Brand-styled (cream paper, ink, sage settled badge) | Task 2 styles | ✅ |
| Available to creator (Alice) on her re-open view | Task 4 | ✅ |
| Available to payer (Bob) on his pay view | Task 5 | ✅ |
| Lazy-loaded renderer (no initial-bundle bloat) | Task 3 dynamic import | ✅ |
| Unit-tested document rendering | Task 2 step 1 — 3 cases | ✅ |
| Unit-tested download trigger | Task 3 step 1 — 2 cases | ✅ |
| Verification gates (tsc / tests / build) | Task 6 | ✅ |
| Manual smoke including edge cases | Task 7 | ✅ |

Brainstorm items NOT in this plan (deferred per scope decision):
- **Multi-invoice accountant packet** — bulk PDF export from `/audit/<granter>`. Useful, ~3-4 hrs, write a follow-up plan after this lands.
- **Email backend** — Codex flagged the privacy contradiction (decryption key in plaintext through SMTP); explicitly out of scope. If demand exists, add a `mailto:` "Email this invoice" with a template that does NOT include the `#key` — just the public PDA URL — but that breaks the privacy story and probably isn't worth it.
- **PDF embedding the Veil SVG logo as an image** — `@react-pdf/renderer` supports `<Image src="...">` but the SVG would need to be rasterized first or use the package's experimental SVG support. Falling back to text-only "Veil" wordmark in the header for v1 keeps it simple and crisp at any scale.
- **Custom font registration (Switzer/Boska)** — adds ~50-100KB per font weight. Helvetica/Courier system fallback is fine for v1; brand fidelity comes from layout + color, not typography.

## Self-review — placeholder scan

Searched for: `TODO`, `TBD`, `placeholder`, `add error handling`, `similar to`. None found in code blocks. The phrase "Adjust the expected count if the existing baseline drifted" in Task 6 is not a placeholder — it's an honest acknowledgment that the test count may have changed since this plan was written.

## Self-review — type/prop consistency

- `InvoicePdfDocument({ metadata, invoicePda })` — defined in Task 2, called identically in Task 3 (helper) and Tasks 4+5 (page wiring). ✅
- `downloadInvoicePdf(metadata, invoicePda, filename?)` — defined in Task 3, called with same signature in Tasks 4+5. ✅
- `InvoiceMetadata` import path `@/lib/types` — consistent across all tasks. ✅
- Tailwind classes used: `btn-ghost`, `btn-quiet` — both defined in `app/src/app/globals.css` (verified line 144 and 153 of the existing globals). ✅
