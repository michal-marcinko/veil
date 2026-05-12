"use client";

/**
 * Sticky date-group header inside the editorial ledger list.
 *
 * Sticks to the top of the scroll container as the user scans down the
 * list, so the bucket they're currently looking at always carries a
 * header. Section sub-headers use Switzer with letter-spacing — never
 * Boska (Boska is reserved for page-level headers per the design spec).
 */
interface Props {
  label: string;
}

export function DateGroupHeader({ label }: Props) {
  return (
    // 2026-05-04 v2 refinement (user feedback): the previous implementation
    // had `-mx-4 px-4 bg-paper` which produced a horizontal band that read
    // as "ugly white space" against the rows above/below — even though
    // bg-paper matches the page bg, the negative-margin extension created
    // a perceived strip. Also dropped the count chip on the right (visual
    // noise; the row stack already shows count). Sticky stays so the
    // bucket label tracks scroll position; bg-paper now sits flush with
    // row content (no horizontal extension), so it occludes scrolling
    // rows without creating a visual band when stationary.
    <div className="sticky top-0 z-10 bg-paper pt-2 pb-1.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.20em] text-ink/45">
        {label}
      </span>
    </div>
  );
}

/**
 * Bucket an invoice's createdAt UNIX seconds into one of:
 *   "Today" | "Yesterday" | "This week" | "This month" | "Earlier"
 *
 * Boundaries are wall-clock relative to the local timezone — a payment
 * landed at 23:59 yesterday is "Yesterday", not "Today", which matches
 * how a human reading their books would group them.
 */
export function bucketByCreatedAt(createdAtUnixSec: number, now: Date = new Date()): string {
  const d = new Date(createdAtUnixSec * 1000);
  if (Number.isNaN(d.getTime())) return "Earlier";

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);

  // "This week" = within the last 7 days but before yesterday.
  // We intentionally use a rolling 7-day window rather than calendar
  // week (Mon-Sun) — for a financial ledger "this week" reads more
  // naturally as "the past several days" than "since last Monday".
  const sevenDaysAgo = new Date(startOfToday);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  // "This month" = within the calendar month + previous if rolling
  // window has not yet covered it. Calendar-month feels right for
  // monthly book reviews ("how did April look?").
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  if (d >= startOfToday) return "Today";
  if (d >= startOfYesterday) return "Yesterday";
  if (d >= sevenDaysAgo) return "This week";
  if (d >= startOfMonth) return "This month";
  return "Earlier";
}

/**
 * Stable bucket order — empty buckets are still represented in the
 * order map but consumer should skip rendering when the bucket is
 * empty. Used so groups render Today → Yesterday → This week → ...
 * regardless of which buckets happen to exist.
 */
export const DATE_BUCKET_ORDER: ReadonlyArray<string> = [
  "Today",
  "Yesterday",
  "This week",
  "This month",
  "Earlier",
];
