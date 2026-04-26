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

      {/*
        Slot-machine reveal. Container is height-locked to a single line
        and clips overflow; the inner strip holds both phrases stacked
        vertically and translates up by one line on hover.

        Both phrases share IDENTICAL type treatment (same font, weight,
        size, tracking) so the user perceives a smooth letter-to-letter
        roll rather than a jarring weight/size shift. Width is set by an
        invisible "ghost" copy of the wider phrase, so the wrapper
        reserves the full width upfront — neighbours never shift.

        Type treatment:
        - Switzer 500 (medium) — refined, not the default Bold
        - 19px with negative -0.025em tracking — display-grade tightness
        - Stylistic alternates inherited from html (cv01, cv09, ss01, ss02)
        - lowercase keeps the editorial register

        Motion:
        - 460ms with cubic-bezier(0.22, 1, 0.36, 1) — the project's own
          `.reveal` curve. Feels considered rather than snappy.
        - prefers-reduced-motion → instant snap, no transition
      */}
      <span className="relative inline-block overflow-hidden h-7 leading-none">
        {/* Width ghost — invisible, sizes the container to fit "private invoicing" */}
        <span className="invisible block h-7 font-sans font-medium text-[19px] tracking-[-0.025em] lowercase leading-7 whitespace-nowrap">
          private invoicing
        </span>

        {/* Sliding strip */}
        <span
          className="
            absolute inset-x-0 top-0 flex flex-col
            transition-transform duration-[460ms]
            [transition-timing-function:cubic-bezier(0.22,1,0.36,1)]
            group-hover:-translate-y-7
            motion-reduce:transition-none motion-reduce:transform-none
          "
        >
          <span className="h-7 flex items-center font-sans font-medium text-[19px] tracking-[-0.025em] text-ink lowercase whitespace-nowrap leading-none">
            veil
          </span>
          <span
            aria-hidden
            className="h-7 flex items-center font-sans font-medium text-[19px] tracking-[-0.025em] text-ink lowercase whitespace-nowrap leading-none"
          >
            private invoicing
          </span>
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
