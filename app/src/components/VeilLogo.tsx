"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Brand wordmark with a one-shot typewriter sequence on hover.
 *
 * Sequence (fires once when the user hovers over the logo, runs to
 * completion regardless of whether they leave during playback):
 *   1. Backspace "Veil" character by character
 *   2. Brief pause
 *   3. Type "Private invoicing" character by character
 *   4. Hold (~1.4s — the descriptor "rests" so the user can read it)
 *   5. Backspace "Private invoicing"
 *   6. Brief pause
 *   7. Type "Veil" — back to rest state
 *
 * The sequence is locked while playing — re-hovering does nothing
 * until the cycle completes. This prevents the jarring restart that
 * a naive hover-tracking implementation would produce when users
 * twitch the cursor over the lockup.
 *
 * `prefers-reduced-motion` short-circuits the per-character timing
 * to a 1.2s text swap (Veil → hold → Private invoicing → snap back).
 *
 * Width is locked via an invisible "ghost" of the wider phrase so
 * neighbours never reflow during playback.
 */

const PRIMARY = "Veil";
const SECONDARY = "Private invoicing";

const ERASE_MS = 28;
const TYPE_MS = 58;
const HOLD_BETWEEN_MS = 220; // pause between erase and type
const HOLD_FOREIGN_MS = 1400; // hold "Private invoicing" so user can read
const HOLD_HOME_MS = 180; // briefly hold "Veil" before unlocking

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const id = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(id);
      reject(signal.reason);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function VeilLogo({ tagline }: { tagline?: string }) {
  const [displayed, setDisplayed] = useState(PRIMARY);
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // Cancel any in-flight sequence on unmount
  useEffect(() => () => abortRef.current?.abort("unmount"), []);

  async function play() {
    if (playingRef.current) return;
    playingRef.current = true;
    setPlaying(true);

    // Reduced motion: skip the per-character animation
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setDisplayed(SECONDARY);
      await new Promise((r) => setTimeout(r, 1200));
      setDisplayed(PRIMARY);
      playingRef.current = false;
      setPlaying(false);
      return;
    }

    const ac = new AbortController();
    abortRef.current = ac;
    const signal = ac.signal;

    try {
      let cur = PRIMARY;

      // 1. Erase "Veil"
      while (cur.length > 0) {
        await sleep(ERASE_MS, signal);
        cur = cur.slice(0, -1);
        setDisplayed(cur);
      }
      await sleep(HOLD_BETWEEN_MS, signal);

      // 2. Type "Private invoicing"
      while (cur.length < SECONDARY.length) {
        await sleep(TYPE_MS, signal);
        cur = SECONDARY.slice(0, cur.length + 1);
        setDisplayed(cur);
      }
      await sleep(HOLD_FOREIGN_MS, signal);

      // 3. Erase "Private invoicing"
      while (cur.length > 0) {
        await sleep(ERASE_MS, signal);
        cur = cur.slice(0, -1);
        setDisplayed(cur);
      }
      await sleep(HOLD_BETWEEN_MS, signal);

      // 4. Type "Veil" — back to rest state
      while (cur.length < PRIMARY.length) {
        await sleep(TYPE_MS, signal);
        cur = PRIMARY.slice(0, cur.length + 1);
        setDisplayed(cur);
      }
      await sleep(HOLD_HOME_MS, signal);
    } catch {
      // aborted (component unmounted) — fall through to cleanup
    } finally {
      playingRef.current = false;
      setPlaying(false);
    }
  }

  return (
    <a
      href="/"
      className="inline-flex items-center gap-1 group cursor-pointer"
      onMouseEnter={play}
      onFocus={play}
    >
      <img
        src="/veil-icon.png"
        alt=""
        aria-hidden
        className="h-10 w-10 object-contain mix-blend-multiply select-none shrink-0 pointer-events-none"
        draggable={false}
      />

      {/*
        Stacked grid: invisible ghost of the longer phrase reserves
        width so the surrounding nav never reflows. Visible text
        floats in the same cell with a blinking cursor while playing.
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
          aria-label={PRIMARY}
        >
          <span>{displayed || " "}</span>
          {playing && <span className="typewriter-cursor" aria-hidden />}
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
