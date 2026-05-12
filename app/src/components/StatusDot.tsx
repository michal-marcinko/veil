"use client";

/**
 * StatusDot — 6px Linear-sized status indicator.
 *
 * Always paired with a visible text label on the row (see InvoiceRow);
 * the dot itself carries an `aria-label` so screen readers don't see a
 * decorative orphan and end users without colour discrimination still
 * get the status word adjacent to it.
 *
 * Color tokens mirror the editorial palette:
 *   pending   → bg-gold (oxblood, the brand accent — draws the eye)
 *   paid      → bg-ink  (resolved, settled)
 *   cancelled → bg-ink/30 (deprioritised)
 *   expired   → bg-brick (calls attention without alarm)
 */

export type DotStatus = "pending" | "paid" | "cancelled" | "expired";

const COLOR_BY_STATUS: Record<DotStatus, string> = {
  pending: "bg-gold",
  paid: "bg-ink",
  cancelled: "bg-ink/30",
  expired: "bg-brick",
};

const LABEL_BY_STATUS: Record<DotStatus, string> = {
  pending: "Pending",
  paid: "Paid",
  cancelled: "Cancelled",
  expired: "Expired",
};

interface Props {
  status: DotStatus;
  /**
   * When true, the dot animates from gold→ink for a state transition.
   * Used by InvoiceRow when an invoice flips from pending→paid.
   */
  flashing?: boolean;
  /**
   * Override the auto-derived aria label (used when the status text is
   * already visible adjacent to the dot — pass empty string then).
   */
  label?: string;
  className?: string;
}

export function StatusDot({ status, flashing = false, label, className = "" }: Props) {
  const colorClass = COLOR_BY_STATUS[status] ?? "bg-ink/30";
  const ariaLabel = label ?? `${LABEL_BY_STATUS[status] ?? status} status`;
  return (
    <span
      aria-label={ariaLabel}
      role="status"
      className={[
        "inline-block w-1.5 h-1.5 rounded-full shrink-0 transition-colors duration-[400ms] ease-out",
        colorClass,
        flashing ? "status-dot-flash" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    />
  );
}

export function statusLabel(status: DotStatus | string): string {
  const key = String(status).toLowerCase() as DotStatus;
  return LABEL_BY_STATUS[key] ?? String(status);
}
