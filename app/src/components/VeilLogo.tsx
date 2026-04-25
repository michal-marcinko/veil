"use client";

/**
 * Shared brand mark used in every navbar. Image asset lives at
 * `app/public/veil-icon.png`; `mix-blend-multiply` lets the icon's
 * soft gray vignette fade into the cream paper background instead of
 * showing as a dark square.
 */
export function VeilLogo({
  tagline = "private invoicing",
  showTagline = true,
}: {
  tagline?: string;
  showTagline?: boolean;
}) {
  return (
    <a href="/" className="flex items-center gap-2.5 group">
      <img
        src="/veil-icon.png"
        alt=""
        aria-hidden
        className="h-7 w-7 object-contain mix-blend-multiply select-none"
        draggable={false}
      />
      <span className="flex items-baseline gap-3">
        <span className="font-sans font-semibold text-[17px] tracking-[-0.02em] text-ink">
          Veil
        </span>
        {showTagline && (
          <span className="hidden sm:inline font-mono text-[10.5px] tracking-[0.08em] text-muted">
            — {tagline}
          </span>
        )}
      </span>
    </a>
  );
}
