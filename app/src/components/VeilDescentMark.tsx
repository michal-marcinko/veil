"use client";

import { useEffect, useState } from "react";

/**
 * Celebratory veil-descent animation for the /create success state.
 * Adapted from `CreateModeSelector`'s VeilMark: same visual composition
 * (paper + bust figure + line items) but the veil descends automatically
 * on mount, instead of on hover.
 *
 * Sized at 144x144 by default — large enough to be the visual focal
 * point of the success layout. Render inside a centered container.
 *
 * Hides itself for `prefers-reduced-motion` users by snapping straight
 * to the descended state with no transition.
 */
export function VeilDescentMark({ size = 144 }: { size?: number }) {
  const [descended, setDescended] = useState(false);

  useEffect(() => {
    // Two RAFs to give the browser a paint with the un-descended state
    // before flipping to descended; otherwise the transition can be
    // skipped entirely (the element starts already in its final state).
    const id1 = requestAnimationFrame(() => {
      const id2 = requestAnimationFrame(() => setDescended(true));
      // Cancel the inner RAF if the outer cleanup fires first.
      return () => cancelAnimationFrame(id2);
    });
    return () => cancelAnimationFrame(id1);
  }, []);

  return (
    <span
      className={`veil-descent-mark inline-block ${descended ? "is-descended" : ""}`}
      aria-hidden
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 512 512" className="w-full h-full" aria-hidden>
        <style>{`
          .veil-descent-mark .veil-grp {
            transform-box: fill-box;
            transform-origin: 50% 0%;
            transform: scaleY(0);
            opacity: 0;
            transition: transform 220ms ease-out, opacity 180ms ease-out;
          }
          .veil-descent-mark.is-descended .veil-grp {
            transform: scaleY(1);
            opacity: 1;
            transition: transform 1100ms cubic-bezier(0.19, 1, 0.22, 1) 280ms,
                        opacity 220ms ease-out 280ms;
          }
          @media (prefers-reduced-motion: reduce) {
            .veil-descent-mark .veil-grp,
            .veil-descent-mark.is-descended .veil-grp {
              transition: opacity 120ms ease-out;
              transform: scaleY(1);
              opacity: 1;
            }
          }
        `}</style>

        <defs>
          <linearGradient id="vdm-pageFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fffaf0" />
            <stop offset="1" stopColor="#f5f0e6" />
          </linearGradient>
          <linearGradient id="vdm-veilFill" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#fbf6ec" />
            <stop offset="0.55" stopColor="#f3ede2" />
            <stop offset="1" stopColor="#f9f4ea" />
          </linearGradient>
          <linearGradient id="vdm-foldFill" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#2a2823" />
            <stop offset="1" stopColor="#11100e" />
          </linearGradient>
          <clipPath id="vdm-pageClip">
            <path d="M138 83 H380 V358 L334 410 H138 Z" />
          </clipPath>
        </defs>

        {/* PAGE BASE */}
        <g>
          <path d="M138 83 H380 V358 L334 410 H138 Z" fill="url(#vdm-pageFill)" />
          <path d="M138 83 H380" stroke="#1A1814" strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <path d="M138 83 V280" stroke="#1A1814" strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <path d="M380 83 V257" stroke="#1A1814" strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <path d="M138 280 V410" stroke="#1A1814" strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <path d="M138 410 H334" stroke="#1A1814" strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <path d="M380 257 V358" stroke="#1A1814" strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </g>

        {/* PAGE CONTENT (clipped) — single bust + line items */}
        <g clipPath="url(#vdm-pageClip)">
          <g>
            <circle cx="259" cy="155" r="28" stroke="#1A1814" strokeWidth="5.2" fill="none" />
            <path
              d="M190 275 C190 220 213 195 259 195 C305 195 328 220 328 275"
              stroke="#1A1814"
              strokeWidth="5.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          </g>
          <g>
            <path d="M161 297 H213" stroke="#1A1814" strokeWidth="5.2" strokeLinecap="round" fill="none" />
            <path d="M161 317 H219" stroke="#1A1814" strokeWidth="5.2" strokeLinecap="round" fill="none" />
            <path d="M161 338 H206" stroke="#1A1814" strokeWidth="5.2" strokeLinecap="round" fill="none" />
            <circle cx="286" cy="295" r="6.2" fill="#1A1814" />
            <path d="M304 295 H349" stroke="#1A1814" strokeWidth="4.4" strokeLinecap="round" fill="none" />
            <circle cx="286" cy="317" r="6.2" fill="#1A1814" />
            <path d="M304 317 H352" stroke="#1A1814" strokeWidth="4.4" strokeLinecap="round" fill="none" />
            <circle cx="286" cy="339" r="6.2" fill="#1A1814" />
            <path d="M304 339 H351" stroke="#1A1814" strokeWidth="4.4" strokeLinecap="round" fill="none" />
          </g>
        </g>

        {/* FOLD */}
        <g>
          <path d="M334 410 L380 358 V410 Z" fill="url(#vdm-foldFill)" />
          <path d="M334 410 L380 358" stroke="#1A1814" strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </g>

        {/* VEIL — descends automatically */}
        <g className="veil-grp">
          <path
            d="M138 279 C178 294 224 280 270 263 C318 245 359 236 392 240"
            stroke="#1A1814"
            strokeWidth="11"
            strokeLinecap="round"
            fill="none"
            opacity="0.13"
          />
          <path
            d="M138 83 H378 C376 133 372 177 391 220 C396 232 404 240 410 245 C400 245 393 250 388 257 C348 239 305 246 262 264 C216 283 173 291 138 280 Z"
            fill="url(#vdm-veilFill)"
            stroke="#1A1814"
            strokeWidth="6.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M372 92 C358 160 324 219 265 253 C222 277 176 286 140 280"
            stroke="#1A1814"
            strokeWidth="2.2"
            strokeLinecap="round"
            fill="none"
            opacity="0.10"
          />
          <path
            d="M138 280 C178 294 224 280 270 263 C318 245 359 236 392 240"
            stroke="#1A1814"
            strokeWidth="6.8"
            strokeLinecap="round"
            fill="none"
          />
          <path
            d="M392 240 C403 238 409 242 410 245 C401 248 394 251 388 257"
            stroke="#1A1814"
            strokeWidth="6.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </g>
      </svg>
    </span>
  );
}
