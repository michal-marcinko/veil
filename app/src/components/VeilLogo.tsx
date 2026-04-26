"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Shared brand mark with a typewriter hover effect:
 * - Default state: "Veil"
 * - Hover: backspace "Veil" → type "Private invoicing"
 * - Un-hover: backspace current → type "Veil" (mid-animation interrupt safe)
 *
 * Width is locked via an invisible "ghost" copy of the wider phrase, so
 * the typewriter never causes neighbours to shift. A blinking cursor is
 * shown while the user is hovering OR while text is mid-animation.
 *
 * Respects `prefers-reduced-motion` — snaps to target text instantly,
 * no per-character timing.
 */

const PRIMARY = "Veil";
const SECONDARY = "Private invoicing";
const ERASE_MS = 26;
const TYPE_MS = 55;
const ENTER_PAUSE_MS = 90; // brief pause before typing the descriptor

export function VeilLogo({ tagline }: { tagline?: string }) {
  const [displayed, setDisplayed] = useState(PRIMARY);
  const [isHovered, setIsHovered] = useState(false);
  const displayedRef = useRef(displayed);

  // Keep ref in sync so the animation effect always reads the latest text
  useEffect(() => {
    displayedRef.current = displayed;
  }, [displayed]);

  // Drive the typewriter whenever the hover-derived target changes
  useEffect(() => {
    const target = isHovered ? SECONDARY : PRIMARY;
    if (displayedRef.current === target) return;

    // Reduced motion: snap, no animation
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setDisplayed(target);
      return;
    }

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let cur = displayedRef.current;

    function step() {
      if (cancelled) return;

      let next: string;
      let delay: number;

      if (target.startsWith(cur)) {
        // Type forward toward target
        next = target.slice(0, cur.length + 1);
        delay = TYPE_MS;
      } else {
        // Erase backward — current is not a prefix of target
        next = cur.slice(0, cur.length - 1);
        delay = ERASE_MS;
      }

      cur = next;
      setDisplayed(next);

      if (next !== target) {
        timeoutId = setTimeout(step, delay);
      }
    }

    // Slight pause before typing the descriptor on hover-in feels more
    // "considered"; no pause on hover-out (immediate response).
    const initialDelay = target === SECONDARY ? ENTER_PAUSE_MS : 0;
    timeoutId = setTimeout(step, initialDelay);

    return () => {
      cancelled = true;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    };
  }, [isHovered]);

  const target = isHovered ? SECONDARY : PRIMARY;
  const showCursor = isHovered || displayed !== target;

  return (
    <a
      href="/"
      className="inline-flex items-center gap-1 group"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <img
        src="/veil-icon.png"
        alt=""
        aria-hidden
        className="h-10 w-10 object-contain mix-blend-multiply select-none shrink-0"
        draggable={false}
      />

      {/*
        Stacked grid: invisible ghost reserves the width of the longer
        phrase upfront, visible text floats on top. Both share identical
        type treatment so the only change the user sees is letters.
      */}
      <span className="grid items-center leading-none [grid-template-areas:'stack']">
        <span
          aria-hidden
          className="invisible [grid-area:stack] font-display font-semibold text-[24px] tracking-[-0.02em] leading-none whitespace-nowrap"
        >
          {SECONDARY}
        </span>
        <span
          className="[grid-area:stack] font-display font-semibold text-[24px] tracking-[-0.02em] text-ink leading-none whitespace-nowrap inline-flex items-center"
          aria-label={target}
        >
          <span>{displayed}</span>
          {showCursor && <span className="typewriter-cursor" aria-hidden />}
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
