"use client";

import { useMemo } from "react";

// ---------------------------------------------------------------------------
// Preset date-range pills for the compliance scope picker.
//
// Why presets and not a calendar? Compliance work is calendar-driven: an
// auditor asks for "Q1 2026" or "your 2025 tax year", and a bare date
// picker forces the operator to mentally translate that into two
// YYYY-MM-DD strings. Presets cover the 95% case in one click; the
// "Custom range" pill remains for the edge case.
//
// The pill aesthetic mirrors the Activity page's status filter so the
// two pages read as one design system (px-3 py-1.5 rounded-full mono
// 10.5px small-caps, active = bg-paper-2 text-ink). Switching feels
// instant — no debounce — because the parent only filters an in-memory
// invoice list (~30 rows in typical use).
// ---------------------------------------------------------------------------

/** A computed scope is either explicit dates or null (= unbounded). */
export interface PresetScope {
  /** UTC unix-second lower bound, inclusive. null = no lower bound. */
  fromTs: number | null;
  /** UTC unix-second upper bound, inclusive. null = no upper bound. */
  toTs: number | null;
}

export type PresetId =
  | "all"
  | "last30"
  | "last90"
  | "ytd"
  | "lastYear"
  | "qThis"
  | "qPrev1"
  | "qPrev2"
  | "custom";

export interface PresetOption {
  id: PresetId;
  label: string;
  scope: PresetScope; // ignored when id === "custom"
}

/**
 * Build the list of presets given a "now" reference date. Quarter labels
 * adapt to the current date so the most recent few quarters always show
 * up by name (e.g. on 2026-05-04 the list reads "Q2 2026" / "Q1 2026" /
 * "Q4 2025"). Tax-year pills cover the current and previous calendar
 * year, which matches how most jurisdictions account.
 */
export function buildPresets(now: Date = new Date()): PresetOption[] {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-11

  // Day-resolution scope helper: floor `from` to UTC midnight, ceil
  // `to` to 23:59:59 so an invoice timestamped any time on the boundary
  // day is in-scope.
  const startOfDay = (d: Date): number =>
    Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0) / 1000);
  const endOfDay = (d: Date): number =>
    Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59) / 1000);

  const yearScope = (y: number): PresetScope => ({
    fromTs: Math.floor(Date.UTC(y, 0, 1, 0, 0, 0) / 1000),
    toTs: Math.floor(Date.UTC(y, 11, 31, 23, 59, 59) / 1000),
  });

  // Quarter helpers. Quarters are 3 months wide starting Jan/Apr/Jul/Oct.
  const quarterIndex = (m: number): number => Math.floor(m / 3); // 0-3
  const currentQ = quarterIndex(month);

  const quarterScope = (y: number, q: number): { from: number; to: number } => {
    const startMonth = q * 3;
    const endMonth = startMonth + 2; // 0-11
    // Day count per month — Date(year, endMonth+1, 0) gets last day of endMonth.
    const lastDay = new Date(Date.UTC(y, endMonth + 1, 0)).getUTCDate();
    return {
      from: Math.floor(Date.UTC(y, startMonth, 1, 0, 0, 0) / 1000),
      to: Math.floor(Date.UTC(y, endMonth, lastDay, 23, 59, 59) / 1000),
    };
  };

  const quarterLabel = (y: number, q: number): string => `Q${q + 1} ${y}`;

  // Compute the most recent 3 quarters: current, previous, one before.
  // Wrap year boundaries so on 2026-Q1 the prior list shows 2025-Q4 +
  // 2025-Q3 — matching how an auditor would scan a recent run of
  // statements regardless of calendar boundaries.
  const quarters: { id: PresetId; label: string; from: number; to: number }[] = [];
  let qCursor = currentQ;
  let yCursor = year;
  for (let i = 0; i < 3; i++) {
    const { from, to } = quarterScope(yCursor, qCursor);
    quarters.push({
      id: i === 0 ? "qThis" : i === 1 ? "qPrev1" : "qPrev2",
      label: quarterLabel(yCursor, qCursor),
      from,
      to,
    });
    qCursor -= 1;
    if (qCursor < 0) {
      qCursor = 3;
      yCursor -= 1;
    }
  }

  // Last-N-days windows. The to-bound is "end of today" so an invoice
  // created today is included. Last-30 is the most common compliance
  // ask ("show me last month's books"); we put it before quarterly.
  const today = new Date(now);
  const last30From = new Date(today);
  last30From.setUTCDate(last30From.getUTCDate() - 30);
  const last90From = new Date(today);
  last90From.setUTCDate(last90From.getUTCDate() - 90);

  return [
    {
      id: "ytd",
      label: `${year} tax year`,
      scope: yearScope(year),
    },
    {
      id: "lastYear",
      label: `${year - 1} tax year`,
      scope: yearScope(year - 1),
    },
    ...quarters.map<PresetOption>((q) => ({
      id: q.id,
      label: q.label,
      scope: { fromTs: q.from, toTs: q.to },
    })),
    {
      id: "last30",
      label: "Last 30 days",
      scope: { fromTs: startOfDay(last30From), toTs: endOfDay(today) },
    },
    {
      id: "last90",
      label: "Last 90 days",
      scope: { fromTs: startOfDay(last90From), toTs: endOfDay(today) },
    },
    {
      id: "all",
      label: "All time",
      scope: { fromTs: null, toTs: null },
    },
    {
      id: "custom",
      label: "Custom range",
      // Sentinel — the page maintains its own from/to state when this
      // pill is active. The scope value here is ignored.
      scope: { fromTs: null, toTs: null },
    },
  ];
}

// ---------------------------------------------------------------------------
// Mint pill — quiet inline dropdown.
// ---------------------------------------------------------------------------

export interface MintOption {
  base58: string;
  symbol: string;
}

interface PresetPillsProps {
  activePresetId: PresetId;
  onSelectPreset: (id: PresetId) => void;
  /** Custom-range inputs — only rendered when activePresetId === "custom". */
  customFromDate: string;
  customToDate: string;
  onChangeCustomFromDate: (v: string) => void;
  onChangeCustomToDate: (v: string) => void;
  /** Mint dropdown — emits base58 mint addresses. */
  mintOptions: MintOption[];
  activeMint: string;
  onSelectMint: (base58: string) => void;
  /** Reference "now" for preset computation. Tests pass a fixed Date. */
  now?: Date;
}

export function PresetPills({
  activePresetId,
  onSelectPreset,
  customFromDate,
  customToDate,
  onChangeCustomFromDate,
  onChangeCustomToDate,
  mintOptions,
  activeMint,
  onSelectMint,
  now,
}: PresetPillsProps) {
  const presets = useMemo(() => buildPresets(now ?? new Date()), [now]);
  const activeMintOption = mintOptions.find((m) => m.base58 === activeMint);
  const activeMintLabel = activeMintOption?.symbol ?? truncateMid(activeMint);

  return (
    <div className="flex flex-col gap-3">
      <div
        role="tablist"
        aria-label="Filter invoices by date range"
        className="flex flex-wrap items-center gap-1.5"
      >
        {presets.map((p) => {
          const active = activePresetId === p.id;
          return (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onSelectPreset(p.id)}
              className={[
                "px-3 py-1.5 rounded-full",
                "font-mono text-[10.5px] tracking-[0.14em] uppercase",
                "transition-colors duration-150",
                active
                  ? "bg-paper-2 text-ink"
                  : "text-ink/45 hover:text-ink hover:bg-paper-2/40",
              ].join(" ")}
            >
              {p.label}
            </button>
          );
        })}

        <span
          aria-hidden
          className="mx-2 hidden sm:inline-block w-px h-3 bg-line"
        />

        {/* Mint pill — same visual language as the preset pills, but
            announces itself as a select. Single mint today (devnet
            wSOL); list grows as we add support for more tokens. */}
        <MintPill
          options={mintOptions}
          activeMint={activeMint}
          activeLabel={activeMintLabel}
          onSelect={onSelectMint}
        />
      </div>

      {activePresetId === "custom" && (
        <div className="flex flex-wrap items-center gap-3 pl-1">
          <span className="font-mono text-[10px] tracking-[0.16em] uppercase text-dim shrink-0">
            From
          </span>
          <input
            type="date"
            value={customFromDate}
            onChange={(e) => onChangeCustomFromDate(e.target.value)}
            aria-label="Custom range start date"
            className="bg-transparent border-0 border-b border-line/70 focus:border-ink outline-none font-mono text-[12px] text-ink py-1 px-0.5 caret-gold transition-colors duration-150"
          />
          <span className="font-mono text-[10px] tracking-[0.16em] uppercase text-dim shrink-0">
            To
          </span>
          <input
            type="date"
            value={customToDate}
            onChange={(e) => onChangeCustomToDate(e.target.value)}
            aria-label="Custom range end date"
            className="bg-transparent border-0 border-b border-line/70 focus:border-ink outline-none font-mono text-[12px] text-ink py-1 px-0.5 caret-gold transition-colors duration-150"
          />
        </div>
      )}
    </div>
  );
}

function MintPill({
  options,
  activeMint,
  activeLabel,
  onSelect,
}: {
  options: MintOption[];
  activeMint: string;
  activeLabel: string;
  onSelect: (base58: string) => void;
}) {
  // Single-option case — no need for a dropdown affordance, just
  // display the active mint as a static pill so the user knows what
  // they're scoping. Keeps the toolbar quiet on devnet (one mint).
  if (options.length <= 1) {
    return (
      <span
        className={[
          "px-3 py-1.5 rounded-full",
          "font-mono text-[10.5px] tracking-[0.14em] uppercase",
          "text-ink/55 bg-paper-3 border border-line",
          "inline-flex items-center gap-1.5",
        ].join(" ")}
        title="Mint scope (only one configured)"
      >
        <span className="text-ink/40">Mint</span>
        <span className="text-ink">{activeLabel}</span>
      </span>
    );
  }

  return (
    <label
      className={[
        "relative px-3 py-1.5 rounded-full",
        "font-mono text-[10.5px] tracking-[0.14em] uppercase",
        "text-ink/55 hover:text-ink hover:bg-paper-2/40 bg-paper-3 border border-line",
        "inline-flex items-center gap-1.5 cursor-pointer transition-colors",
      ].join(" ")}
    >
      <span className="text-ink/40">Mint</span>
      <span className="text-ink">{activeLabel}</span>
      <ChevronTinyIcon />
      <select
        aria-label="Select mint to scope grant"
        value={activeMint}
        onChange={(e) => onSelect(e.target.value)}
        className="absolute inset-0 opacity-0 cursor-pointer"
      >
        {options.map((m) => (
          <option key={m.base58} value={m.base58}>
            {m.symbol}
          </option>
        ))}
      </select>
    </label>
  );
}

function ChevronTinyIcon() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden>
      <path d="M2 3l2 2 2-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function truncateMid(s: string, keep = 4): string {
  if (s.length <= keep * 2 + 1) return s;
  return `${s.slice(0, keep)}…${s.slice(-keep)}`;
}
