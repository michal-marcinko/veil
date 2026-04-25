"use client";

/**
 * Shared brand mark — composition modeled on Phantom's logo lockup:
 * icon + bold lowercase wordmark, vertically center-aligned.
 *
 * The icon's soft gray vignette is dissolved into the cream paper
 * background via `mix-blend-multiply`. Wordmark is set in Switzer Bold
 * (the project's display sans) at 22px with tight negative tracking so
 * the visual mass matches the icon.
 *
 * `tagline` is optional and rendered as a separate mono-chip badge,
 * divided from the wordmark by a hairline vertical rule. Pages that
 * need page-context (audit, receipt) pass it; everywhere else the
 * mark stays clean.
 */
export function VeilLogo({ tagline }: { tagline?: string }) {
  return (
    <a href="/" className="inline-flex items-center gap-2.5 group">
      <img
        src="/veil-icon.png"
        alt=""
        aria-hidden
        className="h-8 w-8 object-contain mix-blend-multiply select-none shrink-0"
        draggable={false}
      />
      <span className="font-sans font-bold text-[22px] tracking-[-0.03em] text-ink leading-none lowercase">
        veil
      </span>
      {tagline && (
        <span className="hidden sm:inline-block ml-1 pl-3 border-l border-line font-mono text-[10.5px] tracking-[0.14em] uppercase text-muted leading-none">
          {tagline}
        </span>
      )}
    </a>
  );
}
