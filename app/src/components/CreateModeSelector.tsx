"use client";

import { useEffect, useState } from "react";

/**
 * Three-card picker for the /create flow. The page is the choreographer —
 * this component just renders the cards and reports the selection upward.
 *
 * All three tiles (Invoice, Payroll, Storefront) use the same in-page
 * mode swap: clicking calls `onSelect`, the picker fades out, and the
 * corresponding form takes the page — with a chevron-up "back to
 * picker" affordance at the top. The flow components live in
 * `src/components/` and are also rendered by their standalone routes
 * (e.g. `/products/new`) so direct hits still work.
 *
 * Private transfer was removed from the picker on 2026-05-04 — it's
 * strictly a subset of Payroll's claim-link path (single recipient ==
 * one-row payroll) and adding it as a fourth tile diluted the B2B
 * positioning. The /send and /gift/[token] routes remain alive in the
 * codebase but are unlinked from the main flow. See
 * `docs/roadmap.md` for the full reasoning.
 *
 * Cards mount with a tiny stagger (Apple-style: read all three, *then*
 * commit to one). Icons are inline SVG drawn against the same
 * page+veil silhouette across variants — only the figures inside the
 * page swap so the marks read as a family.
 */
export type CreateMode = "invoice" | "payroll" | "product";

export interface CreateModeSelectorProps {
  onSelect: (mode: CreateMode) => void;
}

export function CreateModeSelector({ onSelect }: CreateModeSelectorProps) {
  // mounted gate drives the stagger-in. Starts false on first render so the
  // initial paint has the cards in their pre-state, then flips on the next
  // tick to trigger the transition. No JS animation lib needed.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-3xl mx-auto">
      <ModeCard
        index={0}
        mounted={mounted}
        title="Invoice"
        body="Bill one client. They open a private link to pay."
        icon={<VeilMark variant="single" />}
        onClick={() => onSelect("invoice")}
      />
      <ModeCard
        index={1}
        mounted={mounted}
        title="Payroll"
        body="Pay many recipients at once, from a CSV."
        icon={<VeilMark variant="batch" />}
        onClick={() => onSelect("payroll")}
      />
      <ModeCard
        index={2}
        mounted={mounted}
        title="Storefront"
        body="Publish a product. Customers buy from one URL, any time."
        icon={<VeilMark variant="product" />}
        onClick={() => onSelect("product")}
      />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Card — pure presentation. The whole tile is the button.
   ───────────────────────────────────────────────────────────────────── */

interface ModeCardProps {
  index: number;
  mounted: boolean;
  title: string;
  body: string;
  icon: React.ReactNode;
  onClick: () => void;
}

function ModeCard({
  index,
  mounted,
  title,
  body,
  icon,
  onClick,
}: ModeCardProps) {
  // 60ms stagger — perceptible but not theatrical
  const enterDelay = `${index * 60}ms`;
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        transitionDelay: mounted ? enterDelay : "0ms",
      }}
      className={[
        "group relative text-left",
        "border border-line rounded-[4px] p-8 bg-paper-3/40",
        "hover:border-ink/40 hover:bg-paper-3",
        "focus:outline-none focus-visible:border-ink",
        "transition-[border-color,background-color,opacity] duration-200 ease-out",
        // No `will-change-transform` and no entry transform: keeping the
        // card off a GPU compositing layer at rest means the inline SVG
        // (with its drop-shadow filter) renders at native sharpness
        // instead of being bilinear-filtered through a GPU texture
        // during/after the mount animation.
        mounted ? "opacity-100" : "opacity-0",
      ].join(" ")}
    >
      <div className="flex flex-col h-full">
        <div className="mb-7">{icon}</div>

        <h3 className="font-display font-medium text-ink text-[28px] leading-[1.1] tracking-[-0.025em]">
          {title}
        </h3>

        <p className="mt-3 text-[14px] text-ink/75 leading-relaxed">{body}</p>
      </div>
    </button>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Brand mark — inline SVG so the veil group can listen to the parent
   button's `group:hover` state. Default state: figures exposed, veil
   collapsed (scaleY 0, opacity 0). On hover: 280ms hold lets the eye
   register the figure(s), then a 1.1s ease-out-expo descent drops the
   veil to cover them. On un-hover: snappy 220ms retraction so leaving
   the card doesn't drag.
   The four variants differ only in the figures group inside the page:
     - single   → one person bust            (Invoice)
     - batch    → three figures in a row     (Payroll)
     - transfer → sealed envelope + wax seal (Private transfer)
     - product  → tag with circular hole     (Storefront)
   ───────────────────────────────────────────────────────────────────── */
function VeilMark({
  variant,
}: {
  variant: "single" | "batch" | "transfer" | "product";
}) {
  const ns = variant; // namespaces all SVG-internal IDs
  return (
    <span className="relative inline-flex w-16 h-16 -ml-1" aria-hidden="true">
      <svg viewBox="0 0 512 512" className="w-full h-full" aria-hidden="true">
        {/*
          Veil class is scoped per variant so two SVG instances don't
          collide. `.group:hover .veil-X` reaches up to the parent button
          (Tailwind's `group` utility) and switches the slow cinematic
          transition in. The default rule keeps un-hover snappy.
        */}
        <style>{`
          .veil-${ns} {
            transform-box: fill-box;
            transform-origin: 50% 0%;
            transform: scaleY(0);
            opacity: 0;
            transition: transform 220ms ease-out, opacity 180ms ease-out;
          }
          .group:hover .veil-${ns},
          .group:focus-visible .veil-${ns} {
            transform: scaleY(1);
            opacity: 1;
            transition: transform 1100ms cubic-bezier(0.19, 1, 0.22, 1) 280ms,
                        opacity 220ms ease-out 280ms;
          }
          @media (prefers-reduced-motion: reduce) {
            .veil-${ns} {
              transition: opacity 120ms ease-out;
            }
          }
        `}</style>

        <defs>
          <linearGradient id={`pageFill-${ns}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fffaf0" />
            <stop offset="1" stopColor="#f5f0e6" />
          </linearGradient>
          <linearGradient id={`veilFill-${ns}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#fbf6ec" />
            <stop offset="0.55" stopColor="#f3ede2" />
            <stop offset="1" stopColor="#f9f4ea" />
          </linearGradient>
          <linearGradient id={`foldFill-${ns}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#2a2823" />
            <stop offset="1" stopColor="#11100e" />
          </linearGradient>
          <clipPath id={`pageClip-${ns}`}>
            <path d="M138 83 H380 V358 L334 410 H138 Z" />
          </clipPath>
        </defs>

        {/* PAGE BASE — no SVG filter on this group; at 64px display size
            the soft drop shadow that lives in the master /veil-icon.svg
            adds almost no visual weight, and inline-SVG filters can be
            rasterized by the browser at a lower resolution during initial
            paint, producing a brief blur until the next compositor cycle. */}
        <g>
          <path d="M138 83 H380 V358 L334 410 H138 Z" fill={`url(#pageFill-${ns})`} />
          <path d="M138 83 H380" stroke="#1A1814" strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <path d="M138 83 V280" stroke="#1A1814" strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <path d="M380 83 V257" stroke="#1A1814" strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <path d="M138 280 V410" stroke="#1A1814" strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <path d="M138 410 H334" stroke="#1A1814" strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <path d="M380 257 V358" stroke="#1A1814" strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </g>

        {/* PAGE CONTENT (clipped to page outline) */}
        <g clipPath={`url(#pageClip-${ns})`}>
          {variant === "single" && (
            <g>
              <circle cx="259" cy="155" r="28" stroke="#1A1814" strokeWidth="5.2" fill="none" />
              <path
                d="M190 275 C190 220 213 195 259 195 C305 195 328 220 328 275"
                stroke="#1A1814" strokeWidth="5.2" strokeLinecap="round" strokeLinejoin="round" fill="none"
              />
            </g>
          )}

          {variant === "batch" && (
            <g>
              {/* Left figure */}
              <circle cx="192" cy="160" r="18" stroke="#1A1814" strokeWidth="5.2" fill="none" />
              <path
                d="M162 275 C162 232 174 220 192 220 C210 220 222 232 222 275"
                stroke="#1A1814" strokeWidth="5.2" strokeLinecap="round" strokeLinejoin="round" fill="none"
              />
              {/* Right figure (mirror) */}
              <circle cx="326" cy="160" r="18" stroke="#1A1814" strokeWidth="5.2" fill="none" />
              <path
                d="M296 275 C296 232 308 220 326 220 C344 220 356 232 356 275"
                stroke="#1A1814" strokeWidth="5.2" strokeLinecap="round" strokeLinejoin="round" fill="none"
              />
              {/* Center figure — taller, drawn last so it sits in front */}
              <circle cx="259" cy="148" r="20" stroke="#1A1814" strokeWidth="5.2" fill="none" />
              <path
                d="M225 275 C225 222 240 202 259 202 C278 202 293 222 293 275"
                stroke="#1A1814" strokeWidth="5.2" strokeLinecap="round" strokeLinejoin="round" fill="none"
              />
            </g>
          )}

          {variant === "transfer" && (
            <g>
              {/* Sealed envelope. Body rect + closed-flap V meeting at
                  the wax-seal dot in the center. Reads instantly as
                  "private letter / sealed transfer" — the dot
                  reinforces the sealed-not-yet-opened semantic.
                  Coordinates tuned for 64px display size; thicker
                  strokes than figures because thinner lines vanish
                  when the veil descends in reduced-motion mode. */}
              <rect
                x="194" y="178" width="130" height="86"
                stroke="#1A1814" strokeWidth="5.2" fill="none"
                strokeLinejoin="round"
              />
              {/* Closed top flap — V shape from the two top corners
                  down to the seal point at the centre of the body. */}
              <path
                d="M194 178 L259 232 L324 178"
                stroke="#1A1814"
                strokeWidth="5.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
              {/* Wax seal — slightly larger than the figure-page
                  reading dots so it carries weight as the focal point. */}
              <circle cx="259" cy="232" r="7.5" fill="#1A1814" />
            </g>
          )}

          {variant === "product" && (
            <g>
              {/* Price-tag silhouette pointing right + a small "$" carved
                  inside reads instantly as "payment". The tag's
                  punched hole sits on the left so the visual mass leans
                  toward the chevron — same diagonal energy the page-fold
                  in the lower-right of the icon already carries. */}
              <path
                d="M196 152 H260 L322 213 L260 274 H196 Z"
                stroke="#1A1814" strokeWidth="5.2" strokeLinecap="round" strokeLinejoin="round" fill="none"
              />
              {/* Punch hole */}
              <circle cx="218" cy="213" r="9" stroke="#1A1814" strokeWidth="4.8" fill="none" />
              {/* Inline $ — kept as two arcs + a vertical, not a glyph,
                  so it survives at any rendering size without font fallback */}
              <path
                d="M278 184 C268 184 263 192 263 198 C263 204 268 210 281 213 C294 216 299 222 299 228 C299 234 294 242 284 242"
                stroke="#1A1814" strokeWidth="4.8" strokeLinecap="round" fill="none"
              />
              <path d="M281 178 V248" stroke="#1A1814" strokeWidth="4.8" strokeLinecap="round" fill="none" />
            </g>
          )}

          {/* Lower line items — always visible (sender's records).
              Shared across all variants so the marks feel like a
              family rather than four unrelated illustrations. */}
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
          <path d="M334 410 L380 358 V410 Z" fill={`url(#foldFill-${ns})`} />
          <path d="M334 410 L380 358" stroke="#1A1814" strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </g>

        {/* VEIL — collapsed by default, descends on parent .group hover */}
        <g className={`veil-${ns}`}>
          <path
            d="M138 279 C178 294 224 280 270 263 C318 245 359 236 392 240"
            stroke="#1A1814" strokeWidth="11" strokeLinecap="round" fill="none" opacity="0.13"
          />
          <path
            d="M138 83 H378 C376 133 372 177 391 220 C396 232 404 240 410 245 C400 245 393 250 388 257 C348 239 305 246 262 264 C216 283 173 291 138 280 Z"
            fill={`url(#veilFill-${ns})`}
            stroke="#1A1814"
            strokeWidth="6.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M372 92 C358 160 324 219 265 253 C222 277 176 286 140 280"
            stroke="#1A1814" strokeWidth="2.2" strokeLinecap="round" fill="none" opacity="0.10"
          />
          <path
            d="M138 280 C178 294 224 280 270 263 C318 245 359 236 392 240"
            stroke="#1A1814" strokeWidth="6.8" strokeLinecap="round" fill="none"
          />
          <path
            d="M392 240 C403 238 409 242 410 245 C401 248 394 251 388 257"
            stroke="#1A1814" strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" fill="none"
          />
        </g>
      </svg>
    </span>
  );
}
