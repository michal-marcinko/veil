"use client";

/**
 * Shared brand mark. Composition modeled on Phantom's logo lockup:
 * larger icon + bold lowercase wordmark, vertically center-aligned.
 *
 * Hover microinteraction: "veil" cross-fades + slides up to reveal
 * "private invoicing" sliding in from below. Stacked-grid technique
 * (both layers in the same grid cell) means the wrapper auto-sizes to
 * the wider of the two phrases, so neighbours never shift on hover.
 *
 * Animation respects `prefers-reduced-motion` — falls back to instant
 * snap with no transitions for users who've opted out.
 *
 * `tagline` is optional, rendered as a separate mono-chip badge with a
 * hairline divider. Pages that need page-context (audit, receipt) pass
 * it; everywhere else the mark stays clean.
 */
export function VeilLogo({ tagline }: { tagline?: string }) {
  return (
    <a href="/" className="inline-flex items-center gap-3 group">
      <img
        src="/veil-icon.png"
        alt=""
        aria-hidden
        className="h-10 w-10 object-contain mix-blend-multiply select-none shrink-0"
        draggable={false}
      />

      {/* Stacked wordmark. Both texts occupy the same grid cell so the
          wrapper measures itself against the wider phrase. */}
      <span className="grid items-center leading-none [grid-template-areas:'stack']">
        <span
          className="
            [grid-area:stack]
            font-sans font-bold text-[22px] tracking-[-0.03em]
            text-ink lowercase whitespace-nowrap
            transition-[opacity,transform] duration-200 ease-out
            group-hover:opacity-0 group-hover:-translate-y-1.5
            motion-reduce:transition-none motion-reduce:transform-none
          "
        >
          veil
        </span>
        <span
          aria-hidden
          className="
            [grid-area:stack]
            font-sans font-medium text-[16px] tracking-[-0.01em]
            text-ink lowercase whitespace-nowrap
            opacity-0 translate-y-1.5
            transition-[opacity,transform] duration-200 ease-out
            group-hover:opacity-100 group-hover:translate-y-0
            motion-reduce:transition-none motion-reduce:transform-none
          "
        >
          private invoicing
        </span>
      </span>

      {tagline && (
        <span className="hidden sm:inline-block ml-1 pl-3 border-l border-line font-mono text-[10.5px] tracking-[0.14em] uppercase text-muted leading-none">
          {tagline}
        </span>
      )}
    </a>
  );
}
