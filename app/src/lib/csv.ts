export interface PayrollRow {
  wallet: string;
  amount: string;
  memo: string;
  /**
   * Optional human-friendly name the sender knows the recipient by.
   * Off-chain only; never included in any canonical / signed bytes.
   * Trimmed at parse time and capped at {@link MAX_RECIPIENT_NAME_LENGTH}
   * chars so a runaway paste from a spreadsheet can't bloat the packet.
   * Absent when the source CSV has no `name` column.
   */
  name?: string;
}

export interface ParseResult {
  rows: PayrollRow[];
  errors: string[];
}

export const MAX_PAYROLL_ROWS = 50;

/**
 * Cap on the length of the optional `name` column. Trimming + capping
 * happens at parse time so downstream UIs (form, run ledger, PDFs,
 * auditor view) can render the value verbatim without re-validating.
 */
export const MAX_RECIPIENT_NAME_LENGTH = 64;

/**
 * Pure CSV parser for the payroll form. Accepts a header row that lists
 * the columns in any order and returns parsed rows plus a list of human-
 * readable errors. The caller displays errors in the UI and only submits
 * if `errors.length === 0`.
 *
 * Required columns: `wallet`, `amount`, `memo`.
 * Optional column: `name` (recipient display name; off-chain only). When
 * present, the parser populates `row.name`; when absent, the field is
 * omitted entirely so existing CSVs keep working unchanged.
 *
 * Header matching is case-insensitive and tolerant of leading/trailing
 * whitespace ("  Wallet ", "WALLET", "wallet" all match). Column order
 * is driven by the header row, so consumers can produce
 * `name,wallet,amount,memo` or `wallet,amount,memo,name` interchangeably.
 *
 * Intentional constraints:
 * - No embedded commas or quoted fields. Memos / names with commas
 *   aren't supported in Tier 1 — the UI documents this.
 * - Max 50 rows. Excess rows are truncated and an error is reported.
 * - Amounts are validated as positive decimals (e.g. "100", "100.50"),
 *   not parsed to base units here — that happens at submit time using
 *   the same `parseAmountToBaseUnits` logic the single-invoice flow
 *   uses.
 * - Names are trimmed and capped at {@link MAX_RECIPIENT_NAME_LENGTH}
 *   characters; longer values are silently truncated.
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

  // Build a column index map. Required columns are wallet/amount/memo;
  // `name` is optional and skipped when absent. Unknown headers are
  // ignored — keeping the parser forgiving lets users paste from a
  // spreadsheet that carries extra bookkeeping columns without having
  // to strip them first.
  const columnIndex: Record<"wallet" | "amount" | "memo" | "name", number> = {
    wallet: -1,
    amount: -1,
    memo: -1,
    name: -1,
  };
  headerCells.forEach((cell, idx) => {
    if (cell === "wallet" && columnIndex.wallet === -1) columnIndex.wallet = idx;
    else if (cell === "amount" && columnIndex.amount === -1) columnIndex.amount = idx;
    else if (cell === "memo" && columnIndex.memo === -1) columnIndex.memo = idx;
    else if (cell === "name" && columnIndex.name === -1) columnIndex.name = idx;
  });

  const missing: string[] = [];
  if (columnIndex.wallet === -1) missing.push("wallet");
  if (columnIndex.amount === -1) missing.push("amount");
  if (columnIndex.memo === -1) missing.push("memo");
  if (missing.length > 0) {
    errors.push(
      `CSV header must include ${missing.join(", ")} (got "${lines[0]}"). The "name" column is optional.`,
    );
    return { rows, errors };
  }

  const expectedColumnCount = headerCells.length;

  const dataLines = lines.slice(1);
  const over = dataLines.length - MAX_PAYROLL_ROWS;
  const capped = over > 0 ? dataLines.slice(0, MAX_PAYROLL_ROWS) : dataLines;
  if (over > 0) {
    errors.push(
      `CSV has ${dataLines.length} rows but the maximum is ${MAX_PAYROLL_ROWS}. The extra ${over} row(s) were discarded.`,
    );
  }

  capped.forEach((line, idx) => {
    // Row number in errors corresponds to the CSV file line number (header is
    // row 1, first data row is row 2). This matches how a user sees their CSV
    // in a text editor.
    const rowNum = idx + 2;
    const cells = line.split(",");
    if (cells.length !== expectedColumnCount) {
      errors.push(
        `Row ${rowNum}: expected ${expectedColumnCount} columns, got ${cells.length}.`,
      );
      return;
    }
    const wallet = (cells[columnIndex.wallet] ?? "").trim();
    const amount = (cells[columnIndex.amount] ?? "").trim();
    const memo = (cells[columnIndex.memo] ?? "").trim();
    const rawName =
      columnIndex.name === -1 ? "" : (cells[columnIndex.name] ?? "").trim();
    const name = rawName.slice(0, MAX_RECIPIENT_NAME_LENGTH);

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

    const parsed: PayrollRow = { wallet, amount, memo };
    if (name.length > 0) parsed.name = name;
    rows.push(parsed);
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
