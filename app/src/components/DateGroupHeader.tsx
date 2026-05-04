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
  /** Optional small-caps count chip on the right, e.g. "03 / 12". */
  count?: string;
}

export function DateGroupHeader({ label, count }: Props) {
  return (
    <div
      className={
        // Sticky at the top of the list scroll container.
        // bg-paper to occlude rows scrolling under it; z-10 stays
        // above the row hover backdrop but well below modals (z-50).
        "sticky top-0 z-10 -mx-4 px-4 py-2 mb-3 bg-paper " +
        "flex items-baseline justify-between border-b border-ink/10"
      }
    >
      <span className="font-sans text-xs uppercase tracking-[0.18em] text-ink/50">
        {label}
      </span>
      {count && (
        <span className="font-sans text-[10.5px] tabular-nums tracking-[0.12em] text-ink/40">
          {count}
        </span>
      )}
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
