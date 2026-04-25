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
