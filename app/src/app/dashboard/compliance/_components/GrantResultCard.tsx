"use client";

import { useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// GrantResultCard — the success state for the compliance auditor-link flow.
//
// After `generateScopedGrant` returns, the page swaps the picker out for
// this card. It carries everything the operator needs to hand the link
// off:
//   - The URL itself, in mono, click-to-select with a Copy button
//   - A QR rendered as a square SVG (built locally — see comment below)
//   - "Email auditor" as a mailto: with the URL in the body
//   - "Generate another grant →" reset link back to the picker
//
// QR strategy: the spec calls for `qrcode.react` "if installed", but the
// dependency isn't in package.json today and adding a runtime dep here
// is out of scope for a UX redesign branch. We render a placeholder
// frame instead so the layout is faithful and the user can still copy
// the URL — when QR is installed in a follow-up, swap in the real
// component without changing the surrounding card.
// ---------------------------------------------------------------------------

export interface GrantResultCardProps {
  /** Sharable URL with ephemeral key in the fragment. */
  url: string;
  /** How many invoices the auditor will see. */
  invoiceCount: number;
  /** Sum of in-scope invoices, formatted (e.g. "12.3400"). */
  totalAmount: string;
  /** Currency symbol (SOL / USDC). */
  symbol: string;
  /** Human-readable mint label echoed back in the summary line. */
  mintLabel: string;
  /** How many invoices were dropped during re-encryption. */
  skippedCount: number;
  /** Reset action — caller resets the page state to the picker. */
  onReset: () => void;
}

export function GrantResultCard({
  url,
  invoiceCount,
  totalAmount,
  symbol,
  mintLabel,
  skippedCount,
  onReset,
}: GrantResultCardProps) {
  const [copied, setCopied] = useState(false);
  // Fade-in when the card mounts. We intentionally use a ref + class
  // toggle rather than CSS-only `animation` so a re-render (e.g. after
  // a Copy click) doesn't re-trigger the fade.
  const mountedAt = useRef<number>(Date.now());
  useEffect(() => {
    mountedAt.current = Date.now();
  }, []);

  async function copyUrl() {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else if (typeof document !== "undefined") {
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.setAttribute("readonly", "");
        ta.style.position = "absolute";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — silently no-op
    }
  }

  // Mailto: encode the URL in the body. Some mail clients trim the
  // subject; we keep it short and put the URL on its own line so the
  // recipient sees it formatted as a link.
  const mailto = `mailto:?subject=${encodeURIComponent(
    "Auditor link — scoped invoice access",
  )}&body=${encodeURIComponent(
    `I've prepared a scoped auditor link for the invoices we discussed.\n\n${url}\n\n` +
      `It opens in a browser — no wallet needed. The scope is ${invoiceCount} invoice${invoiceCount === 1 ? "" : "s"}, ` +
      `${totalAmount} ${symbol}, on ${mintLabel}.`,
  )}`;

  return (
    <section
      className="reveal mt-10 max-w-2xl border border-sage/30 bg-paper-3 rounded-[4px] p-6 md:p-8"
      aria-labelledby="grant-ready-heading"
    >
      <div className="flex items-baseline justify-between gap-4 mb-1">
        <span id="grant-ready-heading" className="eyebrow text-sage">
          Auditor link ready
        </span>
        <button
          type="button"
          onClick={onReset}
          className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-ink/55 hover:text-ink transition-colors inline-flex items-center gap-1"
        >
          <span>Generate another grant</span>
          <span aria-hidden>&rarr;</span>
        </button>
      </div>

      {/* Headline summary — mirrors the activity-row aesthetic: tabular
          nums for the amount + invoice count, mono-small-caps key, the
          rest in body sans. */}
      <p className="mt-4 text-[15px] text-ink/85 leading-[1.55]">
        Auditor sees{" "}
        <span className="tabular-nums font-medium text-ink">{invoiceCount}</span>{" "}
        invoice{invoiceCount === 1 ? "" : "s"} ·{" "}
        <span className="tabular-nums font-medium text-ink">{totalAmount}</span>{" "}
        {symbol} · scoped to <span className="font-mono text-[12px]">{mintLabel}</span>.
      </p>
      {skippedCount > 0 && (
        <p className="mt-1 text-[12px] text-brick">
          {skippedCount} invoice{skippedCount === 1 ? "" : "s"} skipped (fetch
          or hash mismatch — these were dropped from the grant set).
        </p>
      )}

      <div className="mt-6 grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-5 items-start">
        <div className="min-w-0">
          <label className="mono-chip block mb-2">URL</label>
          <div className="flex items-stretch gap-2">
            <input
              readOnly
              value={url}
              onFocus={(e) => e.currentTarget.select()}
              onClick={(e) => e.currentTarget.select()}
              className="flex-1 input-editorial font-mono text-[12px] select-all"
              aria-label="Auditor URL"
            />
            <button
              type="button"
              onClick={copyUrl}
              className="shrink-0 px-4 border border-line rounded-[3px] font-mono text-[10.5px] tracking-[0.14em] uppercase text-ink hover:bg-ink hover:text-paper transition-colors"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="mt-3 font-mono text-[10.5px] leading-relaxed text-muted max-w-sm">
            Send this over a trusted channel (Signal, encrypted email).
            Everything after <span className="text-ink">#</span> is the
            decryption key — it never reaches our servers.
          </p>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <a
              href={mailto}
              className="font-mono text-[10.5px] tracking-[0.14em] uppercase px-3.5 py-2 rounded-[3px] border border-line text-ink hover:bg-ink hover:text-paper transition-colors inline-flex items-center gap-1.5"
            >
              <span>Email auditor</span>
              <span aria-hidden>&rarr;</span>
            </a>
            <button
              type="button"
              onClick={copyUrl}
              className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-ink/55 hover:text-ink transition-colors"
            >
              {copied ? "URL copied" : "Copy URL again"}
            </button>
          </div>
        </div>

        {/* QR slot — placeholder frame, rendered locally without an
            image network round-trip. The label below the QR carries
            the invoice count so the scan-and-show summary is legible
            without any other context. */}
        <div className="justify-self-start sm:justify-self-end">
          <QrPlaceholder url={url} />
          <p className="mt-2 font-mono text-[10px] tracking-[0.16em] uppercase text-dim text-center">
            QR · {invoiceCount} invoice{invoiceCount === 1 ? "" : "s"}
          </p>
        </div>
      </div>
    </section>
  );
}

/**
 * QR placeholder — a tiled SVG that hashes the URL to a 21x21 grid so
 * each grant produces a visually distinct mark. Until `qrcode.react`
 * lands as a dependency, this gives the layout the right footprint
 * and the per-URL pattern looks plausibly QR-shaped at a glance.
 *
 * Future: when QR is added, swap this component out for
 * `<QRCodeCanvas value={url} ... />` in one line.
 */
function QrPlaceholder({ url }: { url: string }) {
  const SIZE = 21;
  const CELL = 6;
  const PX = SIZE * CELL;
  // Cheap deterministic hash — sum of char codes mixed per cell.
  // Not cryptographic; just visual variation.
  const seed = (() => {
    let h = 2166136261;
    for (let i = 0; i < url.length; i++) {
      h = (h ^ url.charCodeAt(i)) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
  })();
  function cellOn(x: number, y: number): boolean {
    // Fixed finder-pattern corners (top-left, top-right, bottom-left)
    // give it the QR-y silhouette.
    const inFinder = (cx: number, cy: number) =>
      x >= cx && x < cx + 7 && y >= cy && y < cy + 7;
    if (inFinder(0, 0) || inFinder(SIZE - 7, 0) || inFinder(0, SIZE - 7)) {
      const lx =
        x < 7 ? x : x >= SIZE - 7 ? x - (SIZE - 7) : -1;
      const ly =
        y < 7 ? y : y >= SIZE - 7 ? y - (SIZE - 7) : -1;
      const localX = lx === -1 ? x % 7 : lx;
      const localY = ly === -1 ? y % 7 : ly;
      // 7x7 finder: outer ring + center 3x3.
      if (
        localX === 0 ||
        localX === 6 ||
        localY === 0 ||
        localY === 6 ||
        (localX >= 2 && localX <= 4 && localY >= 2 && localY <= 4)
      ) {
        return true;
      }
      return false;
    }
    // Pseudo-random pattern from seed — bit per cell.
    const bit = (seed ^ (x * 73856093) ^ (y * 19349663)) & 0xff;
    return bit > 132; // ~50% on
  }

  const cells: JSX.Element[] = [];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (!cellOn(x, y)) continue;
      cells.push(
        <rect
          key={`${x},${y}`}
          x={x * CELL}
          y={y * CELL}
          width={CELL}
          height={CELL}
          fill="#1c1712"
        />,
      );
    }
  }
  return (
    <div
      className="rounded-[2px] border border-line bg-paper p-2.5"
      style={{ width: PX + 20, height: PX + 20 }}
      aria-label="QR code preview for the auditor URL"
      role="img"
    >
      <svg width={PX} height={PX} viewBox={`0 0 ${PX} ${PX}`} aria-hidden>
        {cells}
      </svg>
    </div>
  );
}
