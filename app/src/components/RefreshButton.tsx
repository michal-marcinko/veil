"use client";

import { useState } from "react";

/**
 * Circular icon-only refresh button — modern web3 affordance.
 *
 * Replaces the old "Refresh" text button (felt 2010s). On click the
 * icon rotates 360° over 600ms; while `loading` is true the icon spins
 * in a continuous slow rotation. Subtle bg-paper-2 hover, hairline
 * border, ~32px diameter — sits comfortably top-right of the page
 * header without competing with the H1.
 *
 * Aria-label "Refresh activity" + tooltip via title attribute.
 * Disabled state grays the icon and blocks pointer events.
 */
interface Props {
  onClick: () => void | Promise<void>;
  loading: boolean;
}

export function RefreshButton({ onClick, loading }: Props) {
  // One-shot rotation token — bumped on each click so the keyed wrapper
  // remounts and replays the 600ms rotation animation. Without the key
  // bump the second click in quick succession would not re-trigger the
  // animation (the class is already applied).
  const [spinToken, setSpinToken] = useState(0);

  function handleClick() {
    if (loading) return;
    setSpinToken((n) => n + 1);
    void onClick();
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={loading}
      aria-label="Refresh activity"
      title={loading ? "Refreshing…" : "Refresh"}
      className={[
        "inline-flex items-center justify-center",
        "h-9 w-9 rounded-full",
        "border border-line/70 bg-transparent",
        "text-ink/60 hover:text-ink hover:bg-paper-2",
        "transition-colors duration-150",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/30",
        "disabled:opacity-50 disabled:cursor-not-allowed",
      ].join(" ")}
    >
      <span
        key={spinToken}
        className={loading ? "inline-flex animate-spin-slow" : "inline-flex animate-spin-once"}
        aria-hidden
      >
        <RefreshIcon />
      </span>
    </button>
  );
}

function RefreshIcon() {
  // Two-arrow circular refresh glyph. 14px feels right inside a 36px button.
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 7a5 5 0 1 1-1.46-3.54" />
      <path d="M12 2v3.5h-3.5" />
    </svg>
  );
}
