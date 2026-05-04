"use client";

import { useEffect, useState } from "react";
import { buildGiftQuickShareTargets } from "@/lib/gift-cards";

/**
 * GiftShareCard — the celebratory artifact that appears AFTER the sender
 * finishes the create flow.
 *
 * Two halves:
 *   - A "card" (left): an editorial-celebratory rendition of the gift —
 *     amount in display serif, optional message in Boska italic, sender
 *     and recipient names. This is what the sender sees as proof their
 *     gift exists; it's also the visual identity of the gift before the
 *     URL is even shared.
 *   - A "share" panel (right): the gift URL in a copy-able row, plus three
 *     quick-share buttons (X, email, sms). Mobile collapses to a stack.
 *
 * Tone: editorial-celebratory (thoughtful birthday card from a designer
 * friend), NOT crypto-bro confetti. Boska italic for the message; gold
 * accent only on the amount; thin gold rule under the card. No emoji
 * unless the user typed one in their message.
 */
export interface GiftShareCardProps {
  giftUrl: string;
  amountDisplay: string;
  symbol: string;
  message?: string;
  senderName?: string;
  recipientName?: string;
  /** Called when the sender clicks "Send another" on the share screen. */
  onReset?: () => void;
}

export function GiftShareCard({
  giftUrl,
  amountDisplay,
  symbol,
  message,
  senderName,
  recipientName,
  onReset,
}: GiftShareCardProps) {
  const [copied, setCopied] = useState(false);

  // Reset the "Copied" pill after a beat — same UX as PayrollFlow's copy
  // confirmations elsewhere in the app.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2200);
    return () => clearTimeout(t);
  }, [copied]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(giftUrl);
      setCopied(true);
    } catch {
      // jsdom / non-secure contexts. The visual feedback below still flips
      // — the user sees something acknowledged regardless of clipboard
      // availability.
      setCopied(true);
    }
  }

  const targets = buildGiftQuickShareTargets({
    giftUrl,
    amountDisplay,
    symbol,
    recipientName,
  });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
      {/* The card itself. */}
      <article
        className="col-span-1 lg:col-span-7 reveal"
        style={{ animationDelay: "60ms" }}
      >
        <div className="relative bg-paper-3 border border-line rounded-[4px] px-8 md:px-12 py-10 md:py-14 overflow-hidden">
          {/* Hairline gold rule: the "ribbon" without the actual ribbon. */}
          <div className="absolute left-0 top-0 h-1 w-full bg-gold/80" />

          <span className="eyebrow">A gift</span>

          {recipientName && (
            <p className="mt-4 text-[14px] text-muted">
              For{" "}
              <span className="text-ink font-medium">{recipientName}</span>
            </p>
          )}

          <div className="mt-6 flex items-baseline gap-3">
            <span className="font-display font-medium text-gold text-[64px] md:text-[88px] leading-[0.95] tracking-[-0.025em]">
              {amountDisplay}
            </span>
            <span className="font-mono text-[14px] tracking-[0.1em] uppercase text-muted">
              {symbol}
            </span>
          </div>

          {message && (
            <blockquote className="mt-10 max-w-[520px] font-display italic text-ink text-[22px] md:text-[26px] leading-[1.35] tracking-[-0.005em]">
              <span aria-hidden className="text-muted mr-1">&ldquo;</span>
              {message}
              <span aria-hidden className="text-muted ml-1">&rdquo;</span>
            </blockquote>
          )}

          {senderName && (
            <p className="mt-10 text-[13px] text-muted">
              From{" "}
              <span className="text-ink font-medium">{senderName}</span>
            </p>
          )}

          <div className="mt-12 pt-6 border-t border-line/70 flex items-center justify-between gap-4">
            <span className="font-mono text-[10.5px] tracking-[0.16em] uppercase text-dim">
              Veil · private gift
            </span>
            <span className="font-mono text-[10.5px] tracking-[0.16em] uppercase text-dim">
              Claim once
            </span>
          </div>
        </div>
      </article>

      {/* The share panel. */}
      <aside
        className="col-span-1 lg:col-span-5 reveal"
        style={{ animationDelay: "180ms" }}
      >
        <span className="eyebrow">Share</span>
        <h2 className="mt-3 font-sans font-medium text-ink text-[24px] md:text-[28px] leading-[1.15] tracking-[-0.015em]">
          The gift is funded.
          <br />
          <span className="text-muted">Hand it to {recipientName?.trim() || "them"}.</span>
        </h2>

        <p className="mt-5 text-[14px] text-ink/75 leading-relaxed">
          Anyone holding this URL can claim once. Send it through the
          channel you trust — copying is fine, encrypted DMs are better.
        </p>

        <div className="mt-7">
          <label className="eyebrow block mb-2">Gift link</label>
          <div className="flex items-stretch gap-2">
            <input
              readOnly
              value={giftUrl}
              onFocus={(e) => e.currentTarget.select()}
              className="input-editorial font-mono text-[12.5px] truncate"
              aria-label="Gift link"
            />
            <button
              type="button"
              onClick={handleCopy}
              className="btn-ghost px-4 shrink-0"
              aria-label="Copy gift link"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>

        <div className="mt-6">
          <label className="eyebrow block mb-2">Send via</label>
          <div className="grid grid-cols-3 gap-2">
            <a
              href={targets.twitter}
              target="_blank"
              rel="noreferrer"
              className="btn-ghost text-[13px] justify-center px-2"
            >
              X / Twitter
            </a>
            <a
              href={targets.email}
              className="btn-ghost text-[13px] justify-center px-2"
            >
              Email
            </a>
            <a
              href={targets.sms}
              className="btn-ghost text-[13px] justify-center px-2"
            >
              Messages
            </a>
          </div>
        </div>

        {onReset && (
          <div className="mt-10 pt-6 border-t border-line">
            <button type="button" onClick={onReset} className="btn-quiet text-[13px]">
              Send another gift →
            </button>
          </div>
        )}
      </aside>
    </div>
  );
}
