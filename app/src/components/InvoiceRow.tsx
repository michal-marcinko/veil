"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { StatusDot, statusLabel, type DotStatus } from "@/components/StatusDot";

/**
 * Editorial-ledger row — one invoice per row.
 *
 * Layout (desktop, ≥640px):
 *   [date] [description / payer] [pda chip] [amount $] [• Status]   [hover actions]
 *
 * Layout (mobile, <640px):
 *   Card stack — description + amount + status dot prominent;
 *   date secondary, PDA chip hidden.
 *
 * State-transition microinteraction:
 *   When `status` prop changes from "pending" → "paid", the dot
 *   crossfades gold→ink over 400ms AND the row briefly flashes
 *   bg-paper-2→bg-paper over 600ms. Detected via a ref tracking the
 *   previous status. Suppressed under prefers-reduced-motion.
 *
 * Hover actions (desktop only):
 *   Three icon buttons slide in opacity-0 → 100 on group-hover:
 *     1. Copy PDA      (clipboard → checkmark on click for 1.2s)
 *     2. View on explorer (↗ external link to Solana explorer)
 *     3. Bind receipt  (✎ opens the apply-receipt slide-over for this PDA)
 */

interface InvoiceRowProps {
  pda: string;
  status: string; // "pending" | "paid" | "cancelled" | "expired"
  createdAt: number; // unix seconds
  /** Decrypted label (payer/amount/description) — undefined while loading. */
  label?: { payer: string; amount: string; description?: string };
  /**
   * Optional CSS animation-delay (in ms) for the stagger fade-up on
   * initial mount. Caller passes index * 60 capped at 600.
   */
  animationDelayMs?: number;
  /**
   * Called when the user clicks the hover bind-receipt action. The
   * dashboard wires this to open the slide-over with the PDA prefilled.
   */
  onBindReceipt?: (pda: string) => void;
  /**
   * Optional explorer base URL. Defaults to Solana mainnet explorer.
   * Pass devnet/testnet variant from the page if applicable.
   */
  explorerBase?: string;
}

const DEFAULT_EXPLORER = "https://explorer.solana.com/address";

export function InvoiceRow({
  pda,
  status,
  createdAt,
  label,
  animationDelayMs,
  onBindReceipt,
  explorerBase = DEFAULT_EXPLORER,
}: InvoiceRowProps) {
  const normalisedStatus = String(status).toLowerCase() as DotStatus;
  const [flashing, setFlashing] = useState(false);
  const previousStatus = useRef<string>(normalisedStatus);
  const [copied, setCopied] = useState(false);

  // Detect pending → paid transition. Fire the row + dot animation
  // exactly once per transition; clear after 600ms so a re-render
  // doesn't retrigger. prefers-reduced-motion handled in CSS.
  useEffect(() => {
    if (
      previousStatus.current === "pending" &&
      normalisedStatus === "paid"
    ) {
      setFlashing(true);
      const t = setTimeout(() => setFlashing(false), 650);
      previousStatus.current = normalisedStatus;
      return () => clearTimeout(t);
    }
    previousStatus.current = normalisedStatus;
  }, [normalisedStatus]);

  const dateStr = formatDateShort(createdAt);
  const pdaShort = `${pda.slice(0, 6)}…${pda.slice(-4)}`;
  const description = label?.description?.trim() || "";
  const primaryText = description
    ? description
    : label?.payer
      ? label.payer
      : pdaShort;

  return (
    <li
      style={
        animationDelayMs != null
          ? ({
              animationDelay: `${animationDelayMs}ms`,
            } as React.CSSProperties)
          : undefined
      }
      className={[
        "group relative",
        animationDelayMs != null ? "animate-fade-up" : "",
        flashing ? "row-flash" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <Link
        href={`/invoice/${pda}`}
        aria-label={`Open invoice ${pda}, ${statusLabel(normalisedStatus)}`}
        className="block px-4 py-3 hover:bg-paper-2 transition-colors duration-150 cursor-pointer"
      >
        {/* DESKTOP layout (≥640px) */}
        <div className="hidden sm:grid sm:grid-cols-[88px_1fr_140px_auto_auto] sm:items-center sm:gap-5">
          {/* date — Switzer tabular-nums, dim */}
          <span className="font-sans tabular-nums text-[12px] text-ink/45 tracking-tight">
            {dateStr}
          </span>

          {/* primary — description (or payer / pda fallback) */}
          <span className="text-[14px] text-ink truncate">
            {primaryText}
          </span>

          {/* PDA short chip — Fragment Mono (codes only) */}
          <span className="font-mono text-[10.5px] text-ink/40 tracking-[0.04em] truncate">
            {pdaShort}
          </span>

          {/* amount — Switzer tabular-nums, right-aligned, NOT mono */}
          <span className="text-right font-sans tabular-nums tracking-tight text-[16px] text-ink">
            {label?.amount ?? <span className="text-ink/30">—</span>}
          </span>

          {/* status dot + visible label */}
          <span className="inline-flex items-center gap-2 min-w-[68px]">
            <StatusDot status={normalisedStatus} flashing={flashing} label="" />
            <span className="font-sans text-[12px] tracking-tight text-ink/60 capitalize">
              {statusLabel(normalisedStatus)}
            </span>
          </span>
        </div>

        {/* MOBILE layout (<640px) — card-per-row */}
        <div className="sm:hidden flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[14px] text-ink truncate flex-1">
              {primaryText}
            </span>
            <span className="font-sans tabular-nums tracking-tight text-[15px] text-ink shrink-0">
              {label?.amount ?? "—"}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="font-sans tabular-nums text-[11px] text-ink/40 tracking-tight">
              {dateStr}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <StatusDot status={normalisedStatus} flashing={flashing} label="" />
              <span className="font-sans text-[11px] tracking-tight text-ink/55 capitalize">
                {statusLabel(normalisedStatus)}
              </span>
            </span>
          </div>
        </div>
      </Link>

      {/* Hover-reveal actions — desktop only.
          Sits on top of the row's right edge with a paper backdrop so
          icons remain legible over the ledger content. opacity-0 by
          default; group-hover bumps to 100 with a 200ms fade. The
          buttons are NOT inside the <Link> wrapping the row — they're
          siblings — to avoid nested-interactive-element a11y errors. */}
      <div
        className={[
          "hidden sm:flex absolute top-1/2 -translate-y-1/2 right-3",
          "opacity-0 group-hover:opacity-100 transition-opacity duration-200",
          "pointer-events-none group-hover:pointer-events-auto",
          "items-center gap-1 bg-paper rounded-[3px] border border-line/60 px-1.5 py-1 shadow-[0_2px_8px_-4px_rgba(28,23,18,0.18)]",
        ].join(" ")}
      >
        <button
          type="button"
          aria-label="Copy invoice PDA"
          title={copied ? "Copied" : "Copy PDA"}
          className="inline-flex h-7 w-7 items-center justify-center rounded-[2px] text-ink/55 hover:text-ink hover:bg-paper-2 transition-colors"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            try {
              void navigator.clipboard?.writeText(pda);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            } catch {
              // clipboard unavailable — silently no-op
            }
          }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
        <a
          href={`${explorerBase}/${pda}`}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="View invoice on Solana explorer"
          title="View on explorer"
          className="inline-flex h-7 w-7 items-center justify-center rounded-[2px] text-ink/55 hover:text-ink hover:bg-paper-2 transition-colors"
          onClick={(e) => e.stopPropagation()}
        >
          <ArrowUpRightIcon />
        </a>
        {onBindReceipt && normalisedStatus === "pending" && (
          <button
            type="button"
            aria-label="Bind receipt to this invoice"
            title="Bind receipt"
            className="inline-flex h-7 w-7 items-center justify-center rounded-[2px] text-ink/55 hover:text-gold hover:bg-paper-2 transition-colors"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onBindReceipt(pda);
            }}
          >
            <PencilIcon />
          </button>
        )}
      </div>
    </li>
  );
}

function CopyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <rect x="3" y="3" width="7" height="8" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2 8.5V2a1 1 0 0 1 1-1h5.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="M2.5 6l2.5 2.5L9.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ArrowUpRightIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden>
      <path d="M3 8L8 3M4 3h4v4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d="M2 10l1.2-3.2L8 2l2 2-4.8 4.8L2 10z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function formatDateShort(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  // Editorial date format: "Apr 21" or "Apr 21 '25" if not current year.
  // Locale-stable using en-US so test snapshots aren't flaky on non-en
  // dev machines.
  const now = new Date();
  const sameYear = d.getUTCFullYear() === now.getUTCFullYear();
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const day = d.getUTCDate();
  if (sameYear) return `${month} ${day}`;
  const yy = String(d.getUTCFullYear()).slice(-2);
  return `${month} ${day} '${yy}`;
}
