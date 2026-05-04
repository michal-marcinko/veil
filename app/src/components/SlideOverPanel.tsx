"use client";

import { useEffect, useRef } from "react";

/**
 * Right-edge slide-over panel — used for the apply-receipt flow on the
 * dashboard. Modeled on Linear / Vercel command-palette patterns:
 *   - mount + transform from translate-x-full → translate-x-0 (300ms ease-out)
 *   - backdrop click + ESC dismiss
 *   - body scroll locked while open
 *   - focus moves to the panel on open
 *
 * The panel itself is bg-paper with a left border-line; the backdrop
 * is bg-ink/40 with a soft blur. 420px wide on desktop, full-width on
 * mobile (max-w-full).
 */
interface Props {
  open: boolean;
  onClose: () => void;
  /** Header label rendered as small-caps tracking text (NOT Boska). */
  title: string;
  /** Optional secondary line under the title (Switzer body, muted). */
  subtitle?: string;
  children: React.ReactNode;
  /**
   * aria-labelledby target id — caller can wire a header element to
   * the panel for screen-reader semantics. When omitted, falls back
   * to aria-label = title.
   */
  labelledBy?: string;
}

export function SlideOverPanel({
  open,
  onClose,
  title,
  subtitle,
  children,
  labelledBy,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const lastFocusRef = useRef<HTMLElement | null>(null);

  // ESC key → close. Bound globally so it fires regardless of focus
  // location (textarea inside, button outside, etc.).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Body scroll lock while open — without this, scrolling the textarea
  // bleeds through to the underlying dashboard list which feels broken.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Focus management — capture the previously-focused element on open
  // and restore it on close, so keyboard users return to where they
  // were (typically the "Apply receipt" trigger button).
  useEffect(() => {
    if (open) {
      lastFocusRef.current = document.activeElement as HTMLElement | null;
      // Defer focus until the panel has mounted + transitioned. 50ms
      // is enough to clear the initial paint without delaying the
      // user's perception of "this opened".
      const t = setTimeout(() => {
        panelRef.current?.focus();
      }, 50);
      return () => clearTimeout(t);
    }
    if (lastFocusRef.current) {
      try {
        lastFocusRef.current.focus();
      } catch {
        // element may have been removed — silently ignore
      }
    }
  }, [open]);

  return (
    <div
      aria-hidden={!open}
      className={`fixed inset-0 z-50 ${open ? "pointer-events-auto" : "pointer-events-none"}`}
      role="presentation"
    >
      {/* Backdrop — fades in/out, click-to-dismiss */}
      <div
        onClick={onClose}
        className={[
          "absolute inset-0 bg-ink/40 backdrop-blur-sm transition-opacity duration-300 ease-out",
          open ? "opacity-100" : "opacity-0",
        ].join(" ")}
      />

      {/* Panel — slides in from the right edge */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : title}
        tabIndex={-1}
        className={[
          "absolute top-0 right-0 h-full w-[420px] max-w-full",
          "bg-paper border-l border-line",
          "transform transition-transform duration-300 ease-out",
          "shadow-[0_30px_80px_-24px_rgba(26,24,20,0.35)]",
          "outline-none flex flex-col",
          open ? "translate-x-0" : "translate-x-full",
        ].join(" ")}
      >
        {/* Header — small-caps tracking, NEVER Boska */}
        <div className="flex items-start justify-between px-6 pt-7 pb-5 border-b border-ink/10">
          <div className="flex-1 min-w-0">
            <span className="font-sans text-xs uppercase tracking-[0.18em] text-ink/50">
              {title}
            </span>
            {subtitle && (
              <p className="mt-2 text-[13.5px] text-ink/70 leading-[1.5]">
                {subtitle}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="ml-3 -mt-1 -mr-1 inline-flex h-8 w-8 items-center justify-center rounded-full border border-line text-muted hover:text-ink hover:border-ink transition-colors"
          >
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden>
              <path
                d="M1 1l9 9M10 1l-9 9"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {/* Body — scrolls if content overflows */}
        <div className="flex-1 overflow-y-auto px-6 py-6">
          {children}
        </div>
      </div>
    </div>
  );
}
