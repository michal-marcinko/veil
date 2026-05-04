import { describe, expect, it } from "vitest";
import { buildPresets } from "@/app/dashboard/compliance/_components/PresetPills";

// Compliance preset-pill scope helper. The page renders these as a
// single row of date-range chips at the top of the picker; the auditor
// flow then filters in-scope invoices by the (mint, fromTs, toTs)
// triple. Lock the boundary semantics in tests so a date-math regression
// — e.g. quarter labels skipping a year boundary, or a tax-year ending
// at 23:59:58 instead of 23:59:59 — gets caught at CI time.

const FIXED_NOW = new Date(Date.UTC(2026, 4, 4, 12, 0, 0)); // 2026-05-04 12:00 UTC

function findById(id: string, presets: ReturnType<typeof buildPresets>) {
  const found = presets.find((p) => p.id === id);
  if (!found) throw new Error(`preset ${id} not in list`);
  return found;
}

describe("buildPresets — tax-year scopes", () => {
  it("includes the current and previous tax year", () => {
    const presets = buildPresets(FIXED_NOW);
    expect(presets.find((p) => p.label === "2026 tax year")).toBeTruthy();
    expect(presets.find((p) => p.label === "2025 tax year")).toBeTruthy();
  });

  it("2026 tax year covers Jan 1 00:00:00 → Dec 31 23:59:59 UTC", () => {
    const ytd = findById("ytd", buildPresets(FIXED_NOW));
    expect(ytd.scope.fromTs).toBe(Math.floor(Date.UTC(2026, 0, 1, 0, 0, 0) / 1000));
    expect(ytd.scope.toTs).toBe(Math.floor(Date.UTC(2026, 11, 31, 23, 59, 59) / 1000));
  });
});

describe("buildPresets — quarter scopes", () => {
  it("on 2026-05-04 (Q2), the 3 quarter pills are Q2 2026 / Q1 2026 / Q4 2025", () => {
    const presets = buildPresets(FIXED_NOW);
    const labels = presets
      .filter((p) => p.id === "qThis" || p.id === "qPrev1" || p.id === "qPrev2")
      .map((p) => p.label);
    expect(labels).toEqual(["Q2 2026", "Q1 2026", "Q4 2025"]);
  });

  it("Q1 2026 covers Jan 1 → Mar 31", () => {
    const presets = buildPresets(FIXED_NOW);
    const q1 = presets.find((p) => p.label === "Q1 2026");
    expect(q1?.scope.fromTs).toBe(Math.floor(Date.UTC(2026, 0, 1, 0, 0, 0) / 1000));
    expect(q1?.scope.toTs).toBe(Math.floor(Date.UTC(2026, 2, 31, 23, 59, 59) / 1000));
  });

  it("Q4 2025 (cross-year) covers Oct 1 → Dec 31 2025", () => {
    const presets = buildPresets(FIXED_NOW);
    const q4 = presets.find((p) => p.label === "Q4 2025");
    expect(q4?.scope.fromTs).toBe(Math.floor(Date.UTC(2025, 9, 1, 0, 0, 0) / 1000));
    expect(q4?.scope.toTs).toBe(Math.floor(Date.UTC(2025, 11, 31, 23, 59, 59) / 1000));
  });

  it("on 2026-02-01 (Q1), the prior-quarter pills wrap to 2025-Q4 / 2025-Q3", () => {
    const earlyQ1 = new Date(Date.UTC(2026, 1, 1, 0, 0, 0));
    const presets = buildPresets(earlyQ1);
    const labels = presets
      .filter((p) => p.id === "qThis" || p.id === "qPrev1" || p.id === "qPrev2")
      .map((p) => p.label);
    expect(labels).toEqual(["Q1 2026", "Q4 2025", "Q3 2025"]);
  });
});

describe("buildPresets — last-N-days windows", () => {
  it("Last 30 days starts 30 days before now and ends end-of-today", () => {
    const presets = buildPresets(FIXED_NOW);
    const last30 = findById("last30", presets);
    // 2026-05-04 - 30 days = 2026-04-04
    expect(last30.scope.fromTs).toBe(
      Math.floor(Date.UTC(2026, 3, 4, 0, 0, 0) / 1000),
    );
    expect(last30.scope.toTs).toBe(
      Math.floor(Date.UTC(2026, 4, 4, 23, 59, 59) / 1000),
    );
  });
});

describe("buildPresets — all-time + custom sentinels", () => {
  it("All time scope is null/null (no bounds)", () => {
    const all = findById("all", buildPresets(FIXED_NOW));
    expect(all.scope.fromTs).toBeNull();
    expect(all.scope.toTs).toBeNull();
  });

  it("Custom range is exposed as a sentinel id (page owns the actual dates)", () => {
    const custom = findById("custom", buildPresets(FIXED_NOW));
    expect(custom.label).toBe("Custom range");
    // Scope value is ignored when this preset is active — the page
    // reads from its own customFromDate/customToDate state instead.
    expect(custom.scope.fromTs).toBeNull();
    expect(custom.scope.toTs).toBeNull();
  });
});
