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
      {/*
        Wordmark in Boska — display serif chosen for personality. Both
        "Veil" and "Private invoicing" share IDENTICAL type treatment so
        the slot-machine roll reads as a clean letter swap rather than a
        weight/size shift. Title-case carries more gravitas than the
        lowercase indie-tech default; ball terminals on the 'a', 'i', 'e'
        give the brand voice its character.
      */}
      <span className="relative inline-block overflow-hidden h-8 leading-none">
        {/* Width ghost — invisible, reserves room for the wider phrase */}
        <span className="invisible block h-8 font-display font-medium text-[24px] tracking-[-0.015em] leading-8 whitespace-nowrap">
          Private invoicing
        </span>

        {/* Sliding strip */}
        <span
          className="
            absolute inset-x-0 top-0 flex flex-col
            transition-transform duration-[460ms]
            [transition-timing-function:cubic-bezier(0.22,1,0.36,1)]
            group-hover:-translate-y-8
            motion-reduce:transition-none motion-reduce:transform-none
          "
        >
          <span className="h-8 flex items-center font-display font-medium text-[24px] tracking-[-0.015em] text-ink whitespace-nowrap leading-none">
            Veil
          </span>
          <span
            aria-hidden
            className="h-8 flex items-center font-display font-medium text-[24px] tracking-[-0.015em] text-ink whitespace-nowrap leading-none"
          >
            Private invoicing
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
