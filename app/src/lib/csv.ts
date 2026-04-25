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
    // Row number in errors corresponds to the CSV file line number (header is
    // row 1, first data row is row 2). This matches how a user sees their CSV
    // in a text editor.
    const rowNum = idx + 2;
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
