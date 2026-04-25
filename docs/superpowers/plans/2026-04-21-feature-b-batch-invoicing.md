# Feature B — Batch / Payroll Invoicing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Feature B Tier 1 from `docs/wow-features.md` — a payroll UX that lets Alice paste a CSV (or fill up to ~50 inline rows), generates N invoices in a loop (each with a shared `batch_id`), and renders a consolidated batch dashboard at `/payroll/[batchId]` with statuses, totals, and a "Copy all links" action.

**Architecture:** Thin client wrapper around the existing single-invoice flow. A new `/payroll/new` page parses CSV or inline rows client-side, generates one shared `batch_id` per submission, and loops over entries calling the existing `createInvoiceOnChain` + `uploadCiphertext` pipeline per row. `batch_id` is added as an optional field to `InvoiceMetadata` so existing invoices stay valid. Batch dashboard hydrates metadata lazily in parallel from Arweave, then filters by `batch_id`. No on-chain changes, no new instruction, no multi-recipient single-tx (Tier 2 is explicitly out of scope).

**Tech Stack:** Next.js 14 App Router, TypeScript 5, Tailwind (existing `input-editorial`/`btn-primary`/`mono-chip`/`eyebrow` utility classes), `@coral-xyz/anchor`, `@solana/web3.js`, `@solana/wallet-adapter-react`, Vitest at `app/` via `npm test`.

**Spec:** `docs/wow-features.md` §Feature B (Tier 1) + research points 1.1 (salary visibility), 1.6 (batch UX). Preceding core MVP plan at `docs/superpowers/plans/2026-04-15-veil-core-mvp.md`.

**Scope note:** TIER 1 ONLY. Explicit non-goals:
- No single-tx multi-recipient payout from Alice's encrypted balance.
- No `create_batch` Anchor instruction.
- No Anchor program changes of any kind.
- No mobile polish, no responsive layout work beyond what the existing utility classes give for free.

---

## Task 1: Add `batch_id` to metadata types

**Files:**
- Modify: `app/src/lib/types.ts`
- Create: `app/src/lib/__tests__/types-batch.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/src/lib/__tests__/types-batch.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test, verify FAIL**

Run: `cd app && npm test -- src/lib/__tests__/types-batch`
Expected: FAIL — all six cases fail because `batch_id` is not on the type, not produced by `buildMetadata`, and not checked by `validateMetadata`.

- [ ] **Step 3: Add `batch_id` to `InvoiceMetadata` and `BuildMetadataArgs`**

Edit `app/src/lib/types.ts`. Replace the entire file contents with:

```typescript
export interface LineItem {
  description: string;
  quantity: string;
  unit_price: string;
  total: string;
}

export interface CreatorInfo {
  display_name: string;
  wallet: string;
  contact: string | null;
  logo_url: string | null;
}

export interface PayerInfo {
  display_name: string;
  wallet: string | null;
  contact: string | null;
}

export interface CurrencyInfo {
  mint: string;
  symbol: string;
  decimals: number;
}

export interface InvoiceMetadata {
  version: 1;
  invoice_id: string;
  created_at: string;
  creator: CreatorInfo;
  payer: PayerInfo;
  currency: CurrencyInfo;
  line_items: LineItem[];
  subtotal: string;
  tax: string;
  total: string;
  due_date: string | null;
  terms: string | null;
  notes: string | null;
  // Optional grouping key for batch/payroll invoices. Null for single invoices
  // created pre-Feature-B or created through /create.
  batch_id: string | null;
}

export interface BuildMetadataArgs {
  invoiceId: string;
  creatorDisplayName: string;
  creatorWallet: string;
  creatorContact?: string | null;
  creatorLogoUrl?: string | null;
  payerDisplayName: string;
  payerWallet: string | null;
  payerContact?: string | null;
  mint: string;
  symbol: string;
  decimals: number;
  lineItems: Array<{ description: string; quantity: string; unitPrice: string; total: string }>;
  subtotal: string;
  tax: string;
  total: string;
  dueDate: string | null;
  terms: string | null;
  notes: string | null;
  batchId?: string | null;
}

export function buildMetadata(args: BuildMetadataArgs): InvoiceMetadata {
  return {
    version: 1,
    invoice_id: args.invoiceId,
    created_at: new Date().toISOString(),
    creator: {
      display_name: args.creatorDisplayName,
      wallet: args.creatorWallet,
      contact: args.creatorContact ?? null,
      logo_url: args.creatorLogoUrl ?? null,
    },
    payer: {
      display_name: args.payerDisplayName,
      wallet: args.payerWallet,
      contact: args.payerContact ?? null,
    },
    currency: { mint: args.mint, symbol: args.symbol, decimals: args.decimals },
    line_items: args.lineItems.map((li) => ({
      description: li.description,
      quantity: li.quantity,
      unit_price: li.unitPrice,
      total: li.total,
    })),
    subtotal: args.subtotal,
    tax: args.tax,
    total: args.total,
    due_date: args.dueDate,
    terms: args.terms,
    notes: args.notes,
    batch_id: args.batchId ?? null,
  };
}

export function validateMetadata(md: InvoiceMetadata): void {
  if (md.version !== 1) throw new Error("Unsupported metadata version");
  const sum = md.line_items.reduce((acc, li) => acc + BigInt(li.total), 0n);
  if (BigInt(md.subtotal) !== sum) {
    throw new Error(`subtotal ${md.subtotal} does not match sum of line items ${sum}`);
  }
  const expectedTotal = BigInt(md.subtotal) + BigInt(md.tax);
  if (BigInt(md.total) !== expectedTotal) {
    throw new Error(`total ${md.total} does not match subtotal + tax ${expectedTotal}`);
  }
  // batch_id: absent (undefined), null, or a non-empty string. Empty string and
  // non-string types are rejected so downstream filters can trust the value.
  if (md.batch_id !== null && md.batch_id !== undefined) {
    if (typeof md.batch_id !== "string") {
      throw new Error(`batch_id must be a string or null, got ${typeof md.batch_id}`);
    }
    if (md.batch_id.length === 0) {
      throw new Error("batch_id must be a non-empty string when present");
    }
  }
}
```

- [ ] **Step 4: Run test, verify PASS**

Run: `cd app && npm test -- src/lib/__tests__/types-batch`
Expected: PASS — all six cases green.

- [ ] **Step 5: Run full test suite to confirm no regression**

Run: `cd app && npm test`
Expected: existing `tests/metadata.test.ts` still passes (its three cases don't set `batch_id`, so `buildMetadata` defaults it to `null` and `validateMetadata` permits that).

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/types.ts app/src/lib/__tests__/types-batch.test.ts
git commit -m "feat(types): add optional batch_id to InvoiceMetadata"
```

---

## Task 2: CSV parser pure function

**Files:**
- Create: `app/src/lib/csv.ts`
- Create: `app/src/lib/__tests__/csv-parser.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/src/lib/__tests__/csv-parser.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { parsePayrollCsv, type PayrollRow } from "@/lib/csv";

describe("parsePayrollCsv", () => {
  it("parses a minimal three-column CSV with header", () => {
    const csv = "wallet,amount,memo\nAlice111,100.50,Jan salary\nBob222,75,March bonus\n";
    const { rows, errors } = parsePayrollCsv(csv);
    expect(errors).toEqual([]);
    expect(rows).toEqual<PayrollRow[]>([
      { wallet: "Alice111", amount: "100.50", memo: "Jan salary" },
      { wallet: "Bob222", amount: "75", memo: "March bonus" },
    ]);
  });

  it("tolerates CRLF line endings", () => {
    const csv = "wallet,amount,memo\r\nAlice111,1,m\r\n";
    const { rows, errors } = parsePayrollCsv(csv);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
  });

  it("accepts header in any case and with whitespace", () => {
    const csv = "  Wallet , Amount , Memo \nAlice111,1,m\n";
    const { rows, errors } = parsePayrollCsv(csv);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
  });

  it("skips fully blank lines", () => {
    const csv = "wallet,amount,memo\nAlice111,1,m\n\n\nBob222,2,n\n";
    const { rows } = parsePayrollCsv(csv);
    expect(rows).toHaveLength(2);
  });

  it("allows empty memo", () => {
    const csv = "wallet,amount,memo\nAlice111,1,\n";
    const { rows, errors } = parsePayrollCsv(csv);
    expect(errors).toEqual([]);
    expect(rows[0].memo).toBe("");
  });

  it("reports error for missing header", () => {
    const csv = "Alice111,1,memo\n";
    const { errors } = parsePayrollCsv(csv);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/header/i);
  });

  it("reports error for wrong number of columns", () => {
    const csv = "wallet,amount,memo\nAlice111,1\n";
    const { errors } = parsePayrollCsv(csv);
    expect(errors.some((e) => /row 2/i.test(e) && /column/i.test(e))).toBe(true);
  });

  it("reports error for blank wallet", () => {
    const csv = "wallet,amount,memo\n,1,m\n";
    const { errors } = parsePayrollCsv(csv);
    expect(errors.some((e) => /wallet/i.test(e))).toBe(true);
  });

  it("reports error for blank amount", () => {
    const csv = "wallet,amount,memo\nAlice111,,m\n";
    const { errors } = parsePayrollCsv(csv);
    expect(errors.some((e) => /amount/i.test(e))).toBe(true);
  });

  it("reports error for non-numeric amount", () => {
    const csv = "wallet,amount,memo\nAlice111,abc,m\n";
    const { errors } = parsePayrollCsv(csv);
    expect(errors.some((e) => /amount/i.test(e))).toBe(true);
  });

  it("reports error for zero amount", () => {
    const csv = "wallet,amount,memo\nAlice111,0,m\n";
    const { errors } = parsePayrollCsv(csv);
    expect(errors.some((e) => /amount/i.test(e))).toBe(true);
  });

  it("reports error for empty CSV", () => {
    const { errors } = parsePayrollCsv("");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("caps rows at 50 and reports the excess", () => {
    const header = "wallet,amount,memo\n";
    const body = Array.from({ length: 51 }, (_, i) => `W${i},1,m${i}`).join("\n");
    const { rows, errors } = parsePayrollCsv(header + body);
    expect(rows).toHaveLength(50);
    expect(errors.some((e) => /50/.test(e))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

Run: `cd app && npm test -- src/lib/__tests__/csv-parser`
Expected: FAIL with "parsePayrollCsv is not a function" (the module does not yet exist).

- [ ] **Step 3: Implement the parser**

Create `app/src/lib/csv.ts`:

```typescript
export interface PayrollRow {
  wallet: string;
  amount: string;
  memo: string;
}

export interface ParseResult {
  rows: PayrollRow[];
  errors: string[];
}

export const MAX_PAYROLL_ROWS = 50;

/**
 * Pure CSV parser for the payroll form. Accepts headered `wallet,amount,memo`
 * content and returns parsed rows plus a list of human-readable errors. The
 * caller displays errors in the UI and only submits if `errors.length === 0`.
 *
 * Intentional constraints:
 * - No embedded commas or quoted fields. Memos with commas aren't supported
 *   in Tier 1 — the UI documents this.
 * - Max 50 rows. Excess rows are truncated and an error is reported.
 * - Amounts are validated as positive decimals (e.g. "100", "100.50"), not
 *   parsed to base units here — that happens at submit time using the same
 *   `parseAmountToBaseUnits` logic the single-invoice flow uses.
 */
export function parsePayrollCsv(text: string): ParseResult {
  const errors: string[] = [];
  const rows: PayrollRow[] = [];

  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const allLines = normalized.split("\n");
  const lines = allLines.filter((l) => l.trim().length > 0);

  if (lines.length === 0) {
    errors.push("CSV is empty. Expected a header row followed by at least one data row.");
    return { rows, errors };
  }

  const headerCells = lines[0].split(",").map((c) => c.trim().toLowerCase());
  const expectedHeader = ["wallet", "amount", "memo"];
  if (
    headerCells.length !== 3 ||
    headerCells[0] !== expectedHeader[0] ||
    headerCells[1] !== expectedHeader[1] ||
    headerCells[2] !== expectedHeader[2]
  ) {
    errors.push(
      `CSV header must be "wallet,amount,memo" (got "${lines[0]}"). Paste a header row as the first line.`,
    );
    return { rows, errors };
  }

  const dataLines = lines.slice(1);
  const over = dataLines.length - MAX_PAYROLL_ROWS;
  const capped = over > 0 ? dataLines.slice(0, MAX_PAYROLL_ROWS) : dataLines;
  if (over > 0) {
    errors.push(
      `CSV has ${dataLines.length} rows but the maximum is ${MAX_PAYROLL_ROWS}. The extra ${over} row(s) were discarded.`,
    );
  }

  capped.forEach((line, idx) => {
    // Row number in errors is 1-indexed from the user's perspective and refers
    // to the data row (1 = first data row, not the header).
    const rowNum = idx + 1;
    const cells = line.split(",");
    if (cells.length !== 3) {
      errors.push(
        `Row ${rowNum}: expected 3 columns (wallet, amount, memo), got ${cells.length}.`,
      );
      return;
    }
    const wallet = cells[0].trim();
    const amount = cells[1].trim();
    const memo = cells[2].trim();

    if (wallet.length === 0) {
      errors.push(`Row ${rowNum}: wallet is blank.`);
      return;
    }
    if (amount.length === 0) {
      errors.push(`Row ${rowNum}: amount is blank.`);
      return;
    }
    if (!/^\d+(\.\d+)?$/.test(amount)) {
      errors.push(`Row ${rowNum}: amount "${amount}" is not a positive decimal (e.g. 100 or 100.50).`);
      return;
    }
    if (Number.parseFloat(amount) === 0) {
      errors.push(`Row ${rowNum}: amount must be greater than zero.`);
      return;
    }

    rows.push({ wallet, amount, memo });
  });

  return { rows, errors };
}

/**
 * Generate a batch id. Exposed for testability; the page uses this at submit
 * time and stamps every invoice in the batch with the same value.
 */
export function generateBatchId(now: Date = new Date()): string {
  const ts = now.getTime().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `batch_${ts}_${rand}`;
}
```

- [ ] **Step 4: Run test, verify PASS**

Run: `cd app && npm test -- src/lib/__tests__/csv-parser`
Expected: all 13 cases green.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/csv.ts app/src/lib/__tests__/csv-parser.test.ts
git commit -m "feat(lib): add parsePayrollCsv and generateBatchId helpers"
```

---

## Task 3: Shared amount helper extraction

**Files:**
- Modify: `app/src/lib/csv.ts` (add helper)
- Modify: `app/src/lib/__tests__/csv-parser.test.ts` (add cases)

The CSV parser validates amount *shape* but the submit flow needs base-unit conversion identical to the single-invoice flow (`parseAmountToBaseUnits` inside `app/src/app/create/page.tsx` lines 210–218). Extract it to `csv.ts` so the payroll page imports the same logic — avoids drift.

- [ ] **Step 1: Write the failing test**

Append to `app/src/lib/__tests__/csv-parser.test.ts`:

```typescript
import { parseAmountToBaseUnits } from "@/lib/csv";

describe("parseAmountToBaseUnits", () => {
  it("converts whole amounts", () => {
    expect(parseAmountToBaseUnits("100", 6)).toBe(100_000_000n);
  });

  it("converts amounts with fractional part", () => {
    expect(parseAmountToBaseUnits("1.5", 6)).toBe(1_500_000n);
  });

  it("pads short fractions", () => {
    expect(parseAmountToBaseUnits("0.1", 6)).toBe(100_000n);
  });

  it("accepts max-precision fractions", () => {
    expect(parseAmountToBaseUnits("0.123456", 6)).toBe(123_456n);
  });

  it("returns null for over-precision", () => {
    expect(parseAmountToBaseUnits("0.1234567", 6)).toBeNull();
  });

  it("returns null for non-numeric", () => {
    expect(parseAmountToBaseUnits("abc", 6)).toBeNull();
  });

  it("returns null for empty", () => {
    expect(parseAmountToBaseUnits("", 6)).toBeNull();
  });

  it("respects decimals=9 for wSOL", () => {
    expect(parseAmountToBaseUnits("1", 9)).toBe(1_000_000_000n);
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

Run: `cd app && npm test -- src/lib/__tests__/csv-parser`
Expected: FAIL — `parseAmountToBaseUnits` is not exported from `@/lib/csv`.

- [ ] **Step 3: Export the helper from `csv.ts`**

Append to `app/src/lib/csv.ts`:

```typescript
/**
 * Convert a decimal string like "100.50" to base units (e.g. microUSDC when
 * decimals=6). Returns null for any invalid input including over-precision
 * (more fractional digits than `decimals`). Identical semantics to the helper
 * inlined in app/src/app/create/page.tsx; exported here so the payroll flow
 * imports it directly instead of re-implementing.
 */
export function parseAmountToBaseUnits(value: string, decimals: number): bigint | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(new RegExp(`^(\\d+)(?:\\.(\\d{0,${decimals}}))?$`));
  if (!match) return null;
  // Reject over-precision: if the user typed more fractional digits than
  // decimals allows, the regex above will not match (the inner group is
  // constrained to {0,decimals}) — but only when the first group still consumes
  // the leading digits and there's no trailing content. Validate by reassembly:
  const whole = match[1];
  const frac = match[2] ?? "";
  if (frac.length > decimals) return null;
  const wholeN = BigInt(whole);
  const fracPadded = frac.padEnd(decimals, "0").slice(0, decimals);
  return wholeN * 10n ** BigInt(decimals) + BigInt(fracPadded);
}
```

- [ ] **Step 4: Run test, verify PASS**

Run: `cd app && npm test -- src/lib/__tests__/csv-parser`
Expected: all 8 new cases green (plus the 13 existing from Task 2).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/csv.ts app/src/lib/__tests__/csv-parser.test.ts
git commit -m "refactor(lib): extract parseAmountToBaseUnits for reuse"
```

---

## Task 4: `PayrollCsvUploader` component

**Files:**
- Create: `app/src/components/PayrollCsvUploader.tsx`

This is the form that drives `/payroll/new`. Two modes toggle between CSV paste and inline row editor, same shape of output in both modes. No network calls — it hands parsed rows back to the parent via `onSubmit`.

- [ ] **Step 1: Create the component**

Create `app/src/components/PayrollCsvUploader.tsx`:

```typescript
"use client";

import { useMemo, useState } from "react";
import { parsePayrollCsv, MAX_PAYROLL_ROWS, type PayrollRow } from "@/lib/csv";
import { PAYMENT_SYMBOL } from "@/lib/constants";

export interface PayrollFormValues {
  creatorDisplayName: string;
  rows: PayrollRow[];
}

interface Props {
  onSubmit: (values: PayrollFormValues) => Promise<void>;
  submitting: boolean;
  errorMessage?: string | null;
  onDismissError?: () => void;
}

type Mode = "csv" | "inline";

export function PayrollCsvUploader({ onSubmit, submitting, errorMessage, onDismissError }: Props) {
  const [mode, setMode] = useState<Mode>("csv");
  const [creatorDisplayName, setCreatorDisplayName] = useState("");
  const [csvText, setCsvText] = useState("");
  const [inlineRows, setInlineRows] = useState<PayrollRow[]>([
    { wallet: "", amount: "", memo: "" },
  ]);
  const [localErrors, setLocalErrors] = useState<string[]>([]);

  const csvParsed = useMemo(
    () => (mode === "csv" ? parsePayrollCsv(csvText) : { rows: [], errors: [] }),
    [mode, csvText],
  );

  const activeRows: PayrollRow[] = mode === "csv" ? csvParsed.rows : inlineRows;
  const activeErrors: string[] = mode === "csv" ? csvParsed.errors : [];

  function updateInlineRow(idx: number, field: keyof PayrollRow, value: string) {
    onDismissError?.();
    setInlineRows((rs) => rs.map((r, i) => (i === idx ? { ...r, [field]: value } : r)));
  }

  function addInlineRow() {
    onDismissError?.();
    setInlineRows((rs) =>
      rs.length >= MAX_PAYROLL_ROWS ? rs : [...rs, { wallet: "", amount: "", memo: "" }],
    );
  }

  function removeInlineRow(idx: number) {
    onDismissError?.();
    setInlineRows((rs) => (rs.length > 1 ? rs.filter((_, i) => i !== idx) : rs));
  }

  function validateInlineRows(): string[] {
    const errs: string[] = [];
    inlineRows.forEach((r, i) => {
      const n = i + 1;
      if (!r.wallet.trim()) errs.push(`Row ${n}: wallet is blank.`);
      if (!r.amount.trim()) errs.push(`Row ${n}: amount is blank.`);
      else if (!/^\d+(\.\d+)?$/.test(r.amount.trim())) {
        errs.push(`Row ${n}: amount "${r.amount}" is not a positive decimal.`);
      } else if (Number.parseFloat(r.amount) === 0) {
        errs.push(`Row ${n}: amount must be greater than zero.`);
      }
    });
    if (inlineRows.length > MAX_PAYROLL_ROWS) {
      errs.push(`Inline mode supports up to ${MAX_PAYROLL_ROWS} rows.`);
    }
    return errs;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onDismissError?.();

    if (!creatorDisplayName.trim()) {
      setLocalErrors(['From name is required.']);
      return;
    }
    if (activeRows.length === 0) {
      setLocalErrors(["Add at least one row."]);
      return;
    }
    const validationErrors = mode === "csv" ? activeErrors : validateInlineRows();
    if (validationErrors.length > 0) {
      setLocalErrors(validationErrors);
      return;
    }
    setLocalErrors([]);
    const rows: PayrollRow[] =
      mode === "csv"
        ? activeRows
        : inlineRows.map((r) => ({ wallet: r.wallet.trim(), amount: r.amount.trim(), memo: r.memo.trim() }));
    await onSubmit({ creatorDisplayName: creatorDisplayName.trim(), rows });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-14">
      {/* From */}
      <section className="space-y-7 animate-fade-up">
        <SectionHeader eyebrow="01" title="From" />
        <div className="space-y-2">
          <label className="mono-chip">From name</label>
          <input
            value={creatorDisplayName}
            onChange={(e) => {
              onDismissError?.();
              setCreatorDisplayName(e.target.value);
            }}
            className="input-editorial"
            placeholder="Acme Design Ltd."
            required
          />
          <div className="text-[12px] text-dim font-sans leading-relaxed mt-1.5">
            This name appears on every invoice in the batch.
          </div>
        </div>
      </section>

      {/* Recipients */}
      <section className="space-y-7 animate-fade-up" style={{ animationDelay: "100ms" }}>
        <SectionHeader eyebrow="02" title="Recipients" />

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setMode("csv")}
            className={mode === "csv" ? "btn-primary" : "btn-quiet"}
          >
            Paste CSV
          </button>
          <button
            type="button"
            onClick={() => setMode("inline")}
            className={mode === "inline" ? "btn-primary" : "btn-quiet"}
          >
            Inline rows
          </button>
        </div>

        {mode === "csv" ? (
          <div className="space-y-2">
            <label className="mono-chip">CSV — header: wallet,amount,memo</label>
            <textarea
              value={csvText}
              onChange={(e) => {
                onDismissError?.();
                setCsvText(e.target.value);
              }}
              rows={12}
              className="input-editorial font-mono text-[13px] resize-y"
              placeholder={"wallet,amount,memo\n4w85uvq3GeKRWKeeB2CyH4FeSYtWsvumHt3XB2TaZdFg,100.00,March retainer\n..."}
            />
            <div className="text-[12px] text-dim font-sans leading-relaxed">
              Up to {MAX_PAYROLL_ROWS} rows. One {PAYMENT_SYMBOL} invoice will be created per row.
              Commas inside memos are not supported in this release.
            </div>
            {csvParsed.errors.length === 0 && csvParsed.rows.length > 0 && (
              <div className="text-[12px] text-sage font-mono">
                {csvParsed.rows.length} row(s) ready.
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="hidden md:grid grid-cols-[1.75rem_1fr_8rem_1fr_1.5rem] gap-4 pb-3 border-b border-line items-baseline">
              <div />
              <div className="mono-chip">Wallet</div>
              <div className="mono-chip text-right">Amount · {PAYMENT_SYMBOL}</div>
              <div className="mono-chip">Memo</div>
              <div />
            </div>
            {inlineRows.map((r, idx) => (
              <div
                key={idx}
                className="md:grid md:grid-cols-[1.75rem_1fr_8rem_1fr_1.5rem] md:gap-4 md:items-baseline py-2 flex flex-col gap-3"
              >
                <div className="font-mono text-[11px] text-dim tabular-nums md:pt-2.5">
                  {String(idx + 1).padStart(2, "0")}
                </div>
                <input
                  value={r.wallet}
                  onChange={(e) => updateInlineRow(idx, "wallet", e.target.value)}
                  className="input-editorial font-mono text-sm"
                  placeholder="4w85uvq3GeKR..."
                />
                <input
                  value={r.amount}
                  onChange={(e) => updateInlineRow(idx, "amount", e.target.value)}
                  inputMode="decimal"
                  className="input-editorial text-right font-mono tabular-nums"
                  placeholder="100.00"
                />
                <input
                  value={r.memo}
                  onChange={(e) => updateInlineRow(idx, "memo", e.target.value)}
                  className="input-editorial"
                  placeholder="March retainer"
                />
                <div className="md:text-right md:pt-1.5">
                  {inlineRows.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeInlineRow(idx)}
                      className="text-dim hover:text-brick transition-colors text-xl leading-none"
                      aria-label={`Remove row ${idx + 1}`}
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>
            ))}
            <button
              type="button"
              onClick={addInlineRow}
              disabled={inlineRows.length >= MAX_PAYROLL_ROWS}
              className="btn-quiet"
            >
              + Add row
            </button>
            <div className="text-[12px] text-dim font-sans">
              {inlineRows.length}/{MAX_PAYROLL_ROWS} rows.
            </div>
          </div>
        )}

        {activeErrors.length > 0 && (
          <div className="border-l-2 border-brick pl-4 py-2 space-y-1 max-w-2xl">
            {activeErrors.map((e, i) => (
              <div key={i} className="text-[13px] text-ink font-mono">
                {e}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Submit */}
      <div className="pt-2 animate-fade-up space-y-5" style={{ animationDelay: "200ms" }}>
        {(errorMessage || localErrors.length > 0) && (
          <div className="flex items-start gap-4 border-l-2 border-brick pl-4 py-2 max-w-2xl">
            <span className="mono-chip text-brick shrink-0 pt-0.5">Error</span>
            <div className="text-sm text-ink leading-relaxed flex-1 space-y-1">
              {errorMessage && <div>{errorMessage}</div>}
              {localErrors.map((e, i) => (
                <div key={i}>{e}</div>
              ))}
            </div>
            {onDismissError && errorMessage && (
              <button
                type="button"
                onClick={onDismissError}
                className="text-dim hover:text-ink transition-colors text-lg leading-none shrink-0"
                aria-label="Dismiss error"
              >
                ×
              </button>
            )}
          </div>
        )}
        <button
          type="submit"
          disabled={submitting || activeRows.length === 0}
          className="btn-primary w-full md:w-auto md:min-w-[340px]"
        >
          {submitting ? (
            <span className="inline-flex items-center gap-3">
              <span className="h-1.5 w-1.5 rounded-full bg-paper animate-slow-pulse" />
              Publishing batch
            </span>
          ) : (
            <span>
              Generate {activeRows.length || "N"} invoice link{activeRows.length === 1 ? "" : "s"}{" "}
              <span aria-hidden>→</span>
            </span>
          )}
        </button>
        <p className="max-w-xl text-[12px] font-mono tracking-[0.12em] uppercase text-dim">
          One invoice · one {PAYMENT_SYMBOL} PDA · per row. Shared batch ID stamped on all.
        </p>
      </div>
    </form>
  );
}

function SectionHeader({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="flex items-baseline gap-5 border-b border-line pb-3">
      <span className="font-mono text-[10.5px] text-gold tracking-[0.18em] tabular-nums">
        {eyebrow}
      </span>
      <h2 className="font-sans font-medium text-ink text-[20px] md:text-[22px] tracking-[-0.015em] leading-none">
        {title}
      </h2>
      <span className="flex-1 h-px bg-line/50 mb-1.5" />
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd app && npx tsc --noEmit`
Expected: no errors. The component imports only `PayrollRow`, `parsePayrollCsv`, `MAX_PAYROLL_ROWS` from `@/lib/csv` and `PAYMENT_SYMBOL` from `@/lib/constants` — all present.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/PayrollCsvUploader.tsx
git commit -m "feat(components): add PayrollCsvUploader form"
```

---

## Task 5: `BatchProgress` component

**Files:**
- Create: `app/src/components/BatchProgress.tsx`

Step-by-step spinner list rendered during submission. Each row represents one invoice; states are `pending | in_progress | done | error`.

- [ ] **Step 1: Create the component**

Create `app/src/components/BatchProgress.tsx`:

```typescript
"use client";

export type BatchStepStatus = "pending" | "in_progress" | "done" | "error";

export interface BatchStep {
  wallet: string;
  amount: string;
  status: BatchStepStatus;
  error?: string | null;
  payUrl?: string | null;
}

interface Props {
  steps: BatchStep[];
  symbol: string;
}

export function BatchProgress({ steps, symbol }: Props) {
  const done = steps.filter((s) => s.status === "done").length;
  const total = steps.length;
  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between border-b border-line pb-3">
        <span className="eyebrow">Batch progress</span>
        <span className="font-mono text-[13px] tabular-nums text-ink">
          {done}/{total}
        </span>
      </div>
      <ol className="space-y-2">
        {steps.map((s, i) => (
          <li
            key={i}
            className="grid grid-cols-[1.75rem_auto_1fr_auto] gap-4 items-baseline py-2 border-b border-line/60"
          >
            <span className="font-mono text-[11px] text-dim tabular-nums">
              {String(i + 1).padStart(2, "0")}
            </span>
            <StatusIcon status={s.status} />
            <span className="font-mono text-[13px] text-ink truncate">
              {truncateWallet(s.wallet)} · {s.amount} {symbol}
              {s.error && (
                <span className="ml-3 text-brick text-[12px]">{s.error}</span>
              )}
            </span>
            <span className="font-mono text-[11px] text-dim uppercase tracking-[0.12em]">
              {labelFor(s.status)}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function StatusIcon({ status }: { status: BatchStepStatus }) {
  if (status === "done") {
    return <span className="text-sage font-mono text-[13px]">✓</span>;
  }
  if (status === "error") {
    return <span className="text-brick font-mono text-[13px]">×</span>;
  }
  if (status === "in_progress") {
    return (
      <span
        className="inline-block h-2 w-2 rounded-full bg-gold animate-slow-pulse"
        aria-label="in progress"
      />
    );
  }
  return <span className="inline-block h-2 w-2 rounded-full bg-line" aria-label="pending" />;
}

function labelFor(status: BatchStepStatus): string {
  switch (status) {
    case "pending":
      return "Queued";
    case "in_progress":
      return "Creating";
    case "done":
      return "Done";
    case "error":
      return "Failed";
  }
}

function truncateWallet(wallet: string): string {
  if (wallet.length <= 12) return wallet;
  return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd app && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/BatchProgress.tsx
git commit -m "feat(components): add BatchProgress step list"
```

---

## Task 6: `/payroll/new` page — wiring

**Files:**
- Create: `app/src/app/payroll/new/page.tsx`

Loops over parsed rows, calls the existing invoice-creation pipeline per row, updates `BatchProgress` between rows. Fail-fast: on first error, stops but keeps already-completed invoices (they're on-chain already, we just have URLs for them). Final result page shows all URLs and a copy-all button.

- [ ] **Step 1: Create the directory**

```bash
mkdir -p app/src/app/payroll/new
```

- [ ] **Step 2: Create the page**

Create `app/src/app/payroll/new/page.tsx`:

```typescript
"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { PublicKey } from "@solana/web3.js";
import { PayrollCsvUploader, type PayrollFormValues } from "@/components/PayrollCsvUploader";
import { BatchProgress, type BatchStep } from "@/components/BatchProgress";
import {
  RegistrationModal,
  type RegistrationStep,
  type StepStatus,
} from "@/components/RegistrationModal";
import { getOrCreateClient, ensureRegistered } from "@/lib/umbra";
import { createInvoiceOnChain } from "@/lib/anchor";
import { buildMetadata, validateMetadata } from "@/lib/types";
import { encryptJson, generateKey, keyToBase58, sha256 } from "@/lib/encryption";
import { uploadCiphertext } from "@/lib/arweave";
import { generateBatchId, parseAmountToBaseUnits } from "@/lib/csv";
import { USDC_MINT, PAYMENT_SYMBOL, PAYMENT_DECIMALS } from "@/lib/constants";

interface CompletedInvoice {
  wallet: string;
  amount: string;
  url: string;
}

export default function PayrollNewPage() {
  const wallet = useWallet();
  const [submitting, setSubmitting] = useState(false);
  const [steps, setSteps] = useState<BatchStep[] | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [completed, setCompleted] = useState<CompletedInvoice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);
  const [regOpen, setRegOpen] = useState(false);
  const [regSteps, setRegSteps] = useState<Record<RegistrationStep, StepStatus>>({
    init: "pending",
    x25519: "pending",
    commitment: "pending",
  });

  async function handleSubmit(values: PayrollFormValues) {
    if (!wallet.publicKey || !wallet.signMessage) {
      setError("Connect wallet first");
      return;
    }
    setSubmitting(true);
    setError(null);

    // Pre-compute amount base units for every row so an invalid amount aborts
    // before we touch the network.
    const amounts: bigint[] = [];
    for (let i = 0; i < values.rows.length; i++) {
      const micros = parseAmountToBaseUnits(values.rows[i].amount, PAYMENT_DECIMALS);
      if (micros == null) {
        setError(`Row ${i + 1}: amount "${values.rows[i].amount}" is invalid for ${PAYMENT_SYMBOL}.`);
        setSubmitting(false);
        return;
      }
      amounts.push(micros);
    }

    const initialSteps: BatchStep[] = values.rows.map((r) => ({
      wallet: r.wallet,
      amount: r.amount,
      status: "pending",
      error: null,
      payUrl: null,
    }));
    setSteps(initialSteps);

    const thisBatchId = generateBatchId();
    setBatchId(thisBatchId);

    try {
      const client = await getOrCreateClient(wallet as any);
      setRegOpen(true);
      await ensureRegistered(client, (step, status) => {
        setRegSteps((prev) => ({
          ...prev,
          [step]: status === "pre" ? "in_progress" : "done",
        }));
      });
      setRegOpen(false);
    } catch (err: any) {
      setRegOpen(false);
      setError(`Umbra registration failed: ${err.message ?? String(err)}`);
      setSubmitting(false);
      return;
    }

    const completedLocal: CompletedInvoice[] = [];

    for (let i = 0; i < values.rows.length; i++) {
      const row = values.rows[i];
      const micros = amounts[i];

      setSteps((prev) =>
        prev ? prev.map((s, idx) => (idx === i ? { ...s, status: "in_progress" } : s)) : prev,
      );

      try {
        // Validate payer wallet up front — if it's not a pubkey we fail this
        // row and stop the batch (fail-fast).
        let payerPubkey: PublicKey;
        try {
          payerPubkey = new PublicKey(row.wallet);
        } catch {
          throw new Error(`"${row.wallet}" is not a valid Solana wallet address`);
        }

        const invoiceId = `inv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

        const lineItem = {
          description: row.memo || "Payroll",
          quantity: "1",
          unitPrice: micros.toString(),
          total: micros.toString(),
        };

        const md = buildMetadata({
          invoiceId,
          creatorDisplayName: values.creatorDisplayName,
          creatorWallet: wallet.publicKey.toBase58(),
          payerDisplayName: row.wallet,
          payerWallet: row.wallet,
          mint: USDC_MINT.toBase58(),
          symbol: PAYMENT_SYMBOL,
          decimals: PAYMENT_DECIMALS,
          lineItems: [lineItem],
          subtotal: micros.toString(),
          tax: "0",
          total: micros.toString(),
          dueDate: null,
          terms: null,
          notes: row.memo || null,
          batchId: thisBatchId,
        });
        validateMetadata(md);

        const key = generateKey();
        const ciphertext = await encryptJson(md, key);
        const { uri } = await uploadCiphertext(ciphertext);
        const hash = await sha256(ciphertext);

        const nonce = crypto.getRandomValues(new Uint8Array(8));
        const pda = await createInvoiceOnChain(wallet as any, {
          nonce,
          metadataHash: hash,
          metadataUri: uri,
          mint: USDC_MINT,
          restrictedPayer: payerPubkey,
          expiresAt: null,
        });

        const url = `${window.location.origin}/pay/${pda.toBase58()}#${keyToBase58(key)}`;

        completedLocal.push({ wallet: row.wallet, amount: row.amount, url });
        setCompleted([...completedLocal]);
        setSteps((prev) =>
          prev
            ? prev.map((s, idx) => (idx === i ? { ...s, status: "done", payUrl: url } : s))
            : prev,
        );
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        setSteps((prev) =>
          prev
            ? prev.map((s, idx) => (idx === i ? { ...s, status: "error", error: msg } : s))
            : prev,
        );
        setError(
          `Row ${i + 1} failed: ${msg}. Earlier invoices in this batch are already on-chain and shareable.`,
        );
        setSubmitting(false);
        return;
      }
    }

    setSubmitting(false);
  }

  async function handleCopyAll() {
    if (completed.length === 0) return;
    const text = completed.map((c) => `${c.wallet}\t${c.amount} ${PAYMENT_SYMBOL}\t${c.url}`).join("\n");
    await navigator.clipboard.writeText(text);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 2200);
  }

  if (!wallet.connected) {
    return (
      <Frame heading="New payroll batch">
        <div className="max-w-lg reveal">
          <p className="text-[17px] md:text-[19px] text-ink/80 leading-[1.5] mb-8">
            Connect your wallet to publish a batch of private invoices.
          </p>
          <ClientWalletMultiButton />
        </div>
      </Frame>
    );
  }

  const allDone =
    steps !== null && steps.length > 0 && steps.every((s) => s.status === "done");

  if (allDone && batchId) {
    return (
      <Frame heading="Batch published">
        <div className="max-w-3xl reveal space-y-8">
          <div>
            <span className="eyebrow">Batch ID</span>
            <div className="mt-3 font-mono text-[13px] text-ink break-all">{batchId}</div>
          </div>
          <div className="flex flex-wrap gap-3">
            <button onClick={handleCopyAll} className="btn-primary">
              {copiedAll ? "Copied ✓" : "Copy all links"}
            </button>
            <a href={`/payroll/${batchId}`} className="btn-ghost">
              Open batch dashboard →
            </a>
          </div>
          <ul className="divide-y divide-line/60 border-t border-line">
            {completed.map((c, i) => (
              <li key={i} className="py-4 grid grid-cols-[1.75rem_auto_1fr] gap-4 items-baseline">
                <span className="font-mono text-[11px] text-dim tabular-nums">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="font-mono text-[13px] text-ink">
                  {c.wallet.slice(0, 6)}…{c.wallet.slice(-4)} · {c.amount} {PAYMENT_SYMBOL}
                </span>
                <span className="font-mono text-[12px] text-dim break-all">{c.url}</span>
              </li>
            ))}
          </ul>
        </div>
      </Frame>
    );
  }

  if (steps !== null) {
    return (
      <Frame heading="Publishing batch">
        <div className="max-w-3xl space-y-8 reveal">
          {error && (
            <div className="flex items-start gap-4 border-l-2 border-brick pl-4 py-2 max-w-2xl">
              <span className="mono-chip text-brick shrink-0 pt-0.5">Error</span>
              <span className="text-sm text-ink leading-relaxed flex-1">{error}</span>
            </div>
          )}
          <BatchProgress steps={steps} symbol={PAYMENT_SYMBOL} />
          {!submitting && error && completed.length > 0 && (
            <div className="pt-4">
              <button onClick={handleCopyAll} className="btn-ghost">
                {copiedAll ? "Copied ✓" : `Copy ${completed.length} completed link(s)`}
              </button>
            </div>
          )}
        </div>
      </Frame>
    );
  }

  return (
    <Frame heading="New payroll batch">
      <PayrollCsvUploader
        onSubmit={handleSubmit}
        submitting={submitting}
        errorMessage={error}
        onDismissError={() => setError(null)}
      />
      <RegistrationModal open={regOpen} steps={regSteps} />
    </Frame>
  );
}

function Frame({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <main className="min-h-screen relative pb-32">
      <nav className="sticky top-0 z-10 backdrop-blur-sm bg-paper/80 border-b border-line">
        <div className="max-w-[1100px] mx-auto flex items-center justify-between px-6 md:px-8 py-4">
          <a href="/" className="flex items-baseline gap-3">
            <span className="font-sans font-semibold text-[17px] tracking-[-0.02em] text-ink">
              Veil
            </span>
            <span className="hidden sm:inline font-mono text-[10.5px] tracking-[0.08em] text-muted">
              — private invoicing
            </span>
          </a>
          <div className="flex items-center gap-1 md:gap-2">
            <a href="/create" className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors">
              Create
            </a>
            <a href="/payroll/new" className="hidden sm:inline-block px-3 py-2 text-[13px] text-ink">
              Payroll
            </a>
            <a href="/dashboard" className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors">
              Dashboard
            </a>
            <div className="ml-2">
              <ClientWalletMultiButton />
            </div>
          </div>
        </div>
      </nav>

      <header className="max-w-[1100px] mx-auto px-6 md:px-8 pt-16 md:pt-20 pb-10 md:pb-12">
        <span className="eyebrow">Payroll</span>
        <h1 className="mt-3 font-sans font-medium text-ink text-[40px] md:text-[52px] leading-[1.03] tracking-[-0.03em] reveal">
          {heading}
        </h1>
      </header>

      <section className="max-w-[1100px] mx-auto px-6 md:px-8 max-w-3xl">{children}</section>
    </main>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `cd app && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run dev server smoke test**

Run: `cd app && npm run dev` in one terminal, then open `http://localhost:3000/payroll/new` in a browser.

Expected: page renders, wallet-connect prompt appears when disconnected, form renders when connected, "Paste CSV" and "Inline rows" toggle work, submit button is disabled until there is at least one valid row. Kill the dev server.

- [ ] **Step 5: Commit**

```bash
git add app/src/app/payroll/new/page.tsx
git commit -m "feat(payroll): add /payroll/new page with CSV + inline flow"
```

---

## Task 7: Batch dashboard `/payroll/[batchId]`

**Files:**
- Create: `app/src/app/payroll/[batchId]/page.tsx`

Fetches the connected wallet's invoices (uses existing `fetchInvoicesByCreator`), then for each invoice hydrates the Arweave metadata in parallel with `Promise.all`, decrypts with a per-invoice key (impossible — keys live only in the URL fragment of each pay-link). Since the dashboard owner is Alice and she doesn't hold the per-invoice decryption keys (they're only in each payer's pay-link fragment), the `batch_id` needs to come from somewhere Alice *can* read.

**Decision:** hydration reads the raw ciphertext from Arweave, but the `batch_id` is stored UN-encrypted in a small side-channel. Two viable options:

1. Stamp `batch_id` onto the `metadataUri` as a query param (e.g. `?batch=batch_abc`) — simplest, no schema change, but couples the URI to the batch lookup.
2. Write an unencrypted companion `{ batch_id }` JSON alongside each invoice's encrypted blob — extra upload per invoice.

**Chosen:** option 1 (query param on `metadataUri`). Task 1's `batch_id` inside encrypted metadata still exists for payer/auditor-side display, but the dashboard filter uses the URI query param for fast lookup without decryption. This requires the `/payroll/new` page to append `?batch={batchId}` to the URI returned from `uploadCiphertext`.

- [ ] **Step 1: Update `/payroll/new` to stamp `?batch=...` on the URI**

Edit `app/src/app/payroll/new/page.tsx`. Find the `const { uri } = await uploadCiphertext(ciphertext);` line inside the per-row loop and replace with:

```typescript
        const { uri: rawUri } = await uploadCiphertext(ciphertext);
        // Stamp batch id onto the URI as an unencrypted query param so Alice's
        // batch dashboard can filter without decrypting each invoice. The
        // encrypted metadata also carries batch_id for recipient-side display.
        const uri = `${rawUri}${rawUri.includes("?") ? "&" : "?"}batch=${encodeURIComponent(thisBatchId)}`;
```

- [ ] **Step 2: Create the directory**

```bash
mkdir -p app/src/app/payroll/[batchId]
```

- [ ] **Step 3: Create the page**

Create `app/src/app/payroll/[batchId]/page.tsx`:

```typescript
"use client";

import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useParams } from "next/navigation";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { fetchInvoicesByCreator } from "@/lib/anchor";
import { PAYMENT_SYMBOL, PAYMENT_DECIMALS } from "@/lib/constants";

interface BatchInvoice {
  pda: string;
  metadataUri: string;
  status: "pending" | "paid" | "expired" | "canceled" | string;
  createdAt: number;
}

export default function BatchDashboardPage() {
  const wallet = useWallet();
  const params = useParams<{ batchId: string }>();
  const batchId = params?.batchId ?? "";

  const [invoices, setInvoices] = useState<BatchInvoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  async function refresh() {
    if (!wallet.publicKey) return;
    setLoading(true);
    setError(null);
    try {
      const all = await fetchInvoicesByCreator(wallet as any, wallet.publicKey);
      // Fast path: `batch_id` lives in the metadataUri query string, so we
      // can filter without hitting Arweave at all.
      const filtered = all
        .map((a: any) => ({
          pda: a.publicKey.toBase58(),
          metadataUri: a.account.metadataUri as string,
          status: Object.keys(a.account.status)[0],
          createdAt: Number(a.account.createdAt),
        }))
        .filter((i: BatchInvoice) => extractBatchId(i.metadataUri) === batchId)
        .sort((a: BatchInvoice, b: BatchInvoice) => a.createdAt - b.createdAt);
      setInvoices(filtered);
    } catch (err: any) {
      setError(`Batch load: ${err.message ?? String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30000);
    return () => clearInterval(interval);
  }, [wallet.publicKey, batchId]);

  const stats = useMemo(() => {
    let total = 0;
    let paid = 0;
    let pending = 0;
    for (const inv of invoices) {
      total++;
      if (inv.status === "paid") paid++;
      else if (inv.status === "pending") pending++;
    }
    return { total, paid, pending };
  }, [invoices]);

  async function handleCopy(idx: number, url: string) {
    await navigator.clipboard.writeText(url);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 2200);
  }

  if (!wallet.connected) {
    return (
      <Shell>
        <div className="max-w-lg reveal">
          <span className="eyebrow">Batch dashboard</span>
          <h1 className="mt-4 font-sans font-medium text-ink text-[40px] md:text-[48px] leading-[1.05] tracking-[-0.03em]">
            Connect to view this batch.
          </h1>
          <div className="mt-8">
            <ClientWalletMultiButton />
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex items-baseline justify-between mb-10 reveal">
        <div>
          <span className="eyebrow">Batch</span>
          <h1 className="mt-3 font-sans font-medium text-ink text-[36px] md:text-[44px] leading-[1.05] tracking-[-0.025em] break-all">
            {batchId}
          </h1>
        </div>
        <button onClick={refresh} disabled={loading} className="btn-ghost text-[13px] px-4 py-2">
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {/* Totals */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-10 reveal">
        <StatCard label="Invoices" value={stats.total.toString()} />
        <StatCard label="Paid" value={stats.paid.toString()} />
        <StatCard label="Pending" value={stats.pending.toString()} />
      </div>

      {error && (
        <div className="mb-8 flex items-start gap-4 border-l-2 border-brick pl-4 py-2 max-w-2xl">
          <span className="mono-chip text-brick shrink-0 pt-0.5">Error</span>
          <span className="text-[13.5px] text-ink leading-relaxed flex-1">{error}</span>
        </div>
      )}

      {invoices.length === 0 ? (
        <div className="border border-line bg-paper-3 rounded-[4px] p-8 text-center">
          <span className="eyebrow">Nothing yet</span>
          <p className="mt-3 text-[14px] text-ink/80">
            No invoices found for batch <span className="font-mono">{batchId}</span> under this wallet.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-line/60 border-t border-line">
          {invoices.map((inv, i) => {
            const payUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/pay/${inv.pda}`;
            return (
              <li
                key={inv.pda}
                className="py-4 grid grid-cols-[1.75rem_1fr_6rem_auto] gap-4 items-baseline"
              >
                <span className="font-mono text-[11px] text-dim tabular-nums">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="font-mono text-[13px] text-ink truncate">
                  {inv.pda.slice(0, 8)}…{inv.pda.slice(-6)}
                </span>
                <StatusBadge status={inv.status} />
                <button
                  onClick={() => handleCopy(i, payUrl)}
                  className="btn-quiet text-[12px]"
                >
                  {copiedIdx === i ? "Copied ✓" : "Copy pay link"}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-10 pt-8 border-t border-line">
        <a href="/dashboard" className="btn-quiet">
          ← Back to dashboard
        </a>
      </div>
    </Shell>
  );
}

/**
 * Pull `batch=` off an Arweave-style URI. Returns null if not present.
 * Exported-style helper kept local — if it gets reused elsewhere, move it to
 * `lib/batch.ts`.
 */
function extractBatchId(uri: string): string | null {
  const q = uri.indexOf("?");
  if (q === -1) return null;
  const search = new URLSearchParams(uri.slice(q + 1));
  return search.get("batch");
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-line bg-paper-3 rounded-[4px] p-6">
      <span className="eyebrow">{label}</span>
      <div className="mt-2 font-sans tnum text-ink text-[28px] md:text-[32px] font-medium tracking-[-0.02em] leading-none">
        {value}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === "paid"
      ? "text-sage"
      : status === "expired" || status === "canceled"
        ? "text-brick"
        : "text-gold";
  return (
    <span className={`font-mono text-[11px] uppercase tracking-[0.14em] ${color}`}>
      {status}
    </span>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen relative pb-32">
      <nav className="sticky top-0 z-10 backdrop-blur-sm bg-paper/80 border-b border-line">
        <div className="max-w-[1100px] mx-auto flex items-center justify-between px-6 md:px-8 py-4">
          <a href="/" className="flex items-baseline gap-3">
            <span className="font-sans font-semibold text-[17px] tracking-[-0.02em] text-ink">
              Veil
            </span>
            <span className="hidden sm:inline font-mono text-[10.5px] tracking-[0.08em] text-muted">
              — private invoicing
            </span>
          </a>
          <div className="flex items-center gap-1 md:gap-2">
            <a href="/create" className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors">
              Create
            </a>
            <a href="/payroll/new" className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors">
              Payroll
            </a>
            <a href="/dashboard" className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors">
              Dashboard
            </a>
            <div className="ml-2">
              <ClientWalletMultiButton />
            </div>
          </div>
        </div>
      </nav>

      <section className="max-w-[1100px] mx-auto px-6 md:px-8 pt-16 md:pt-20">{children}</section>
    </main>
  );
}
```

Note: `PAYMENT_SYMBOL` / `PAYMENT_DECIMALS` are imported even if only symbol is used downstream — keeps the import parallel to other pages in case totals-with-amount are added later. If TypeScript complains about unused `PAYMENT_DECIMALS`, remove it — the dev server will error on unused imports in strict mode otherwise.

- [ ] **Step 4: Typecheck**

Run: `cd app && npx tsc --noEmit`
Expected: no errors. If `PAYMENT_DECIMALS` shows as unused, drop it from the import list.

- [ ] **Step 5: Commit**

```bash
git add app/src/app/payroll/new/page.tsx app/src/app/payroll/[batchId]/page.tsx
git commit -m "feat(payroll): add /payroll/[batchId] dashboard with batch-id URI filter"
```

---

## Task 8: Dashboard "Payrolls" link-out section

**Files:**
- Modify: `app/src/app/dashboard/page.tsx`

Group invoices by `batch_id` extracted from the `metadataUri` query param, list each distinct batch as a row with count + earliest-created-at, linking to `/payroll/[batchId]`. Skip invoices whose URI has no `batch=` param.

- [ ] **Step 1: Add the batch grouping logic and section**

Edit `app/src/app/dashboard/page.tsx`.

Find the line:
```typescript
  const incoming = invoices.map((i) => ({
```

and replace the block from there down to (but not including) the `return (` of the connected render with:

```typescript
  const incoming = invoices.map((i) => ({
    pda: i.pda.toBase58(),
    creator: i.account.creator.toBase58(),
    metadataUri: i.account.metadataUri,
    status: Object.keys(i.account.status)[0] as any,
    createdAt: Number(i.account.createdAt),
  }));

  // Group by batch_id (carried on the URI as a ?batch= query param, stamped
  // there by /payroll/new). Invoices without batch=... are single invoices
  // from /create and are skipped here.
  const batches = new Map<string, { count: number; earliest: number }>();
  for (const inv of incoming) {
    const batchId = extractBatchIdFromUri(inv.metadataUri);
    if (!batchId) continue;
    const prev = batches.get(batchId);
    if (prev) {
      prev.count += 1;
      prev.earliest = Math.min(prev.earliest, inv.createdAt);
    } else {
      batches.set(batchId, { count: 1, earliest: inv.createdAt });
    }
  }
  const batchList = Array.from(batches.entries())
    .map(([batchId, info]) => ({ batchId, ...info }))
    .sort((a, b) => b.earliest - a.earliest);
```

And at the bottom of the file, above the `function Shell` declaration, add the helper:

```typescript
function extractBatchIdFromUri(uri: string): string | null {
  const q = uri.indexOf("?");
  if (q === -1) return null;
  const search = new URLSearchParams(uri.slice(q + 1));
  return search.get("batch");
}
```

- [ ] **Step 2: Render the Payrolls section**

In the same file, find the line:
```tsx
      <DashboardList title="Invoices you created" invoices={incoming} />
```

Immediately *after* that line, add:

```tsx
      {batchList.length > 0 && (
        <div className="mt-14">
          <div className="flex items-baseline justify-between mb-6 border-b border-line pb-3">
            <span className="eyebrow">Payrolls</span>
            <a href="/payroll/new" className="btn-quiet text-[12px]">
              + New batch
            </a>
          </div>
          <ul className="divide-y divide-line/60">
            {batchList.map((b) => (
              <li key={b.batchId} className="py-4 grid grid-cols-[1fr_auto_auto] gap-4 items-baseline">
                <a
                  href={`/payroll/${b.batchId}`}
                  className="font-mono text-[13px] text-ink hover:text-gold transition-colors truncate"
                >
                  {b.batchId}
                </a>
                <span className="font-mono text-[12px] text-dim tabular-nums">
                  {b.count} invoice{b.count === 1 ? "" : "s"}
                </span>
                <a href={`/payroll/${b.batchId}`} className="btn-quiet text-[12px]">
                  Open →
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
```

- [ ] **Step 3: Typecheck**

Run: `cd app && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Full test suite passes**

Run: `cd app && npm test`
Expected: all tests green — the existing `tests/metadata.test.ts`, the new `src/lib/__tests__/csv-parser.test.ts`, and `src/lib/__tests__/types-batch.test.ts` all pass. Umbra import smoke test continues to pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/app/dashboard/page.tsx
git commit -m "feat(dashboard): add Payrolls section linking to /payroll/[batchId]"
```

---

## Task 9: Manual end-to-end smoke

**Files:** none.

Devnet exercise to confirm the full flow works. Ambient prerequisite: the core MVP plan's deploy + `.env.local` is already in place.

- [ ] **Step 1: Start dev server**

Run: `cd app && npm run dev`

- [ ] **Step 2: Connect Alice's wallet and publish a 3-row batch**

1. Open `http://localhost:3000/payroll/new`.
2. Connect Phantom with Alice's devnet wallet.
3. Enter "From name" = `Alice Test Co.`.
4. Select "Paste CSV" mode.
5. Paste:

```
wallet,amount,memo
BobWalletAddressHereReplaceWithRealDevnetWallet,1.00,Batch row 1
CarolWalletAddressHereReplaceWithRealDevnetWallet,0.50,Batch row 2
DaveWalletAddressHereReplaceWithRealDevnetWallet,2.00,Batch row 3
```

(Use three real devnet addresses — the restricted-payer check will reject invalid ones at tx time.)

6. Click "Generate 3 invoice links". Registration modal appears if first run. Watch the `BatchProgress` tick `01 → 02 → 03`.
7. Expected: "Batch published" screen with three URLs + a `batch_id` like `batch_...`.
8. Click "Open batch dashboard →".
9. Expected: `/payroll/[batchId]` loads, shows 3 invoices with status `pending`, totals `3 / 0 / 3`.

- [ ] **Step 3: Pay one invoice as Bob**

1. Copy one pay-link from the batch dashboard.
2. Open in a second browser with Bob's wallet connected.
3. Pay the invoice (existing pay flow).
4. Return to Alice's `/payroll/[batchId]` and click Refresh.
5. Expected: that row flips to `paid`, totals become `3 / 1 / 2`.

- [ ] **Step 4: Verify `/dashboard` Payrolls section**

Open `http://localhost:3000/dashboard` as Alice.
Expected: under "Invoices you created" a new "Payrolls" section lists the batch with "3 invoices" and an "Open →" link.

- [ ] **Step 5: Verify single-invoice regression**

Create a normal invoice via `/create`. Expected: it appears in "Invoices you created" but NOT as a batch under "Payrolls" (because its URI has no `?batch=`).

- [ ] **Step 6: Commit anything incidental**

```bash
git status
```

If nothing changed, move on. If smoke revealed a bug and you edited a file, commit with an explanatory message naming the specific file(s).

---

## Done criteria

- [ ] All 4 created source files compile (`npx tsc --noEmit` clean).
- [ ] All 3 modified source files compile.
- [ ] Vitest suite passes (`npm test`): 2 new test files (`csv-parser.test.ts`, `types-batch.test.ts`) + existing tests green.
- [ ] `/payroll/new` publishes N invoices in sequence with shared `batch_id`.
- [ ] `/payroll/[batchId]` lists all invoices in the batch with correct totals.
- [ ] `/dashboard` lists batches in a "Payrolls" section and links to each batch.
- [ ] Existing `/create` + `/pay/[id]` + `/dashboard` single-invoice flow is unaffected.

## Out of scope (defer)

- Tier 2 single-tx multi-recipient payout (`docs/wow-features.md` §Feature B Tier 2).
- On-chain `create_batch` instruction.
- Resumable batches (pick-up-where-left-off after a mid-batch error).
- Per-recipient custom due dates / memos-with-commas / per-row currencies.
- CSV file-upload drag-and-drop (paste-only in Tier 1; a file `<input>` is a trivial follow-up).
- Showing per-row decrypted amount on the batch dashboard (requires Alice to hold each invoice's decryption key, which she doesn't by design — would require a per-batch master key, out of scope).
