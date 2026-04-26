"use client";

import { useEffect, useRef, useState } from "react";

const PRIMARY = "Veil";
const SECONDARY = "Private invoicing";
const ERASE_MS = 28;
const TYPE_MS = 58;
const HOLD_FOREIGN_MS = 1400;
const HOLD_BETWEEN_MS = 220;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function VeilLogo({ tagline }: { tagline?: string }) {
  const [text, setText] = useState(PRIMARY);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  // Diagnostic: log every render with current state
  // eslint-disable-next-line no-console
  console.log("[VeilLogo render]", { text, busy });

  async function play() {
    // eslint-disable-next-line no-console
    console.log("[VeilLogo play]", { busyRefBefore: busyRef.current });
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);

    const log = (s: string) => {
      // eslint-disable-next-line no-console
      console.log("[VeilLogo setText]", JSON.stringify(s));
    };

    try {
      // erase Veil
      for (let i = PRIMARY.length; i > 0; i--) {
        await wait(ERASE_MS);
        const next = PRIMARY.slice(0, i - 1);
        log(next);
        setText(next);
      }
      await wait(HOLD_BETWEEN_MS);

      // type Private invoicing
      for (let i = 0; i < SECONDARY.length; i++) {
        await wait(TYPE_MS);
        const next = SECONDARY.slice(0, i + 1);
        log(next);
        setText(next);
      }
      await wait(HOLD_FOREIGN_MS);

      // erase Private invoicing
      for (let i = SECONDARY.length; i > 0; i--) {
        await wait(ERASE_MS);
        const next = SECONDARY.slice(0, i - 1);
        log(next);
        setText(next);
      }
      await wait(HOLD_BETWEEN_MS);

      // type Veil
      for (let i = 0; i < PRIMARY.length; i++) {
        await wait(TYPE_MS);
        const next = PRIMARY.slice(0, i + 1);
        log(next);
        setText(next);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
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
        src="/veil-icon.png"
        alt=""
        aria-hidden
        className="h-10 w-10 object-contain mix-blend-multiply select-none shrink-0 pointer-events-none"
        draggable={false}
      />

      {/*
        BARE-BONES: no grid, no ghost, no overflow tricks. Just the text.
        Width will reflow as text changes — fixing later, after we
        confirm the typewriter renders at all.
      */}
      <span
        className="font-display font-semibold text-[24px] tracking-[-0.02em] text-ink leading-none whitespace-nowrap"
        aria-label={PRIMARY}
        data-veil-text={text}
        data-veil-busy={busy ? "1" : "0"}
        style={{ minWidth: "5ch", display: "inline-block" }}
      >
        {text}
        {busy && <span className="typewriter-cursor" aria-hidden />}
      </span>

      {tagline && (
        <span className="hidden sm:inline-block ml-1 pl-3 border-l border-line font-mono text-[10.5px] tracking-[0.14em] uppercase text-muted leading-none">
          {tagline}
        </span>
      )}
    </a>
  );
}
