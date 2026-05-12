"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Brand wordmark with a one-shot typewriter sequence on hover.
 *
 * Sequence (fires once, runs to completion regardless of hover state):
 *   1. Backspace "Veil"
 *   2. Type "Private invoicing"
 *   3. Hold (~1.4s — the descriptor "rests")
 *   4. Backspace "Private invoicing"
 *   5. Type "Veil" — back to rest state
 *
 * Locked while playing — re-hovering does nothing until the cycle
 * completes. `prefers-reduced-motion` short-circuits to a 1.2s text
 * swap. Width is locked via an invisible "ghost" of the wider phrase
 * (absolute-positioning approach — CSS Grid stacking proved unreliable
 * when paired with arbitrary-value Tailwind classes here).
 */

const PRIMARY = "Veil";
const SECONDARY = "private payments";

const ERASE_MS = 28;
const TYPE_MS = 58;
const HOLD_BETWEEN_MS = 220;
const HOLD_FOREIGN_MS = 1400;
const HOLD_HOME_MS = 180;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function VeilLogo({ tagline }: { tagline?: string }) {
  const [text, setText] = useState(PRIMARY);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  function setSafe(s: string) {
    if (mountedRef.current) setText(s);
  }

  async function play() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);

    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    try {
      if (reduced) {
        setSafe(SECONDARY);
        await wait(1200);
        setSafe(PRIMARY);
      } else {
        // 1. erase "Veil"
        for (let i = PRIMARY.length; i > 0; i--) {
          await wait(ERASE_MS);
          setSafe(PRIMARY.slice(0, i - 1));
        }
        await wait(HOLD_BETWEEN_MS);

        // 2. type "Private invoicing"
        for (let i = 0; i < SECONDARY.length; i++) {
          await wait(TYPE_MS);
          setSafe(SECONDARY.slice(0, i + 1));
        }
        await wait(HOLD_FOREIGN_MS);

        // 3. erase "Private invoicing"
        for (let i = SECONDARY.length; i > 0; i--) {
          await wait(ERASE_MS);
          setSafe(SECONDARY.slice(0, i - 1));
        }
        await wait(HOLD_BETWEEN_MS);

        // 4. type "Veil"
        for (let i = 0; i < PRIMARY.length; i++) {
          await wait(TYPE_MS);
          setSafe(PRIMARY.slice(0, i + 1));
        }
        await wait(HOLD_HOME_MS);
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }

  return (
    <a
      href="/"
      className="inline-flex items-center gap-1 cursor-pointer"
      onMouseEnter={play}
      onFocus={play}
    >
      <img
        src="/veil-icon.svg"
        alt=""
        aria-hidden
        className="h-10 w-10 object-contain select-none shrink-0 pointer-events-none"
        draggable={false}
      />

      {/*
        Width-locked stage. The invisible "ghost" reserves room for the
        widest phrase ("Private invoicing") so the navbar layout never
        reflows during typewriter playback. The live text floats on top
        via absolute positioning.
      */}
      <span className="relative inline-block leading-none">
        <span
          aria-hidden
          className="invisible block font-display font-semibold text-[24px] tracking-[-0.02em] leading-none whitespace-nowrap"
        >
          {SECONDARY}
        </span>
        <span
          className="absolute inset-0 flex items-center font-display font-semibold text-[24px] tracking-[-0.02em] text-ink leading-none whitespace-nowrap"
          aria-label={PRIMARY}
        >
          {text}
          {busy && <span className="typewriter-cursor" aria-hidden />}
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
