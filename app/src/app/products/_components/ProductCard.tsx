"use client";

import { useState } from "react";
import Link from "next/link";
import {
  buildProductUrl,
  formatProductAmount,
  type ProductCacheEntry,
} from "@/lib/products";

/**
 * Single row in the merchant's products list. Renders the product name,
 * price, a copy-link button (one-click — design requirement), and a
 * "remove from dashboard" affordance. The URL preview area is read-only
 * but selectable so the merchant can paste it manually if they prefer.
 */
export function ProductCard({
  entry,
  onRemove,
}: {
  entry: ProductCacheEntry;
  onRemove: () => void;
}) {
  const [copied, setCopied] = useState(false);

  // Build the URL on render. We deliberately avoid memoizing — origin
  // can change (preview deploy → prod) and the cost is trivial.
  const url =
    typeof window !== "undefined"
      ? buildProductUrl(window.location.origin, entry.arweaveTxId)
      : `/buy/${entry.arweaveTxId}`;

  const amountDisplay = `${formatProductAmount(entry.amountBaseUnits, entry.decimals)} ${entry.symbol}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      /* non-secure context */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <article className="group border border-line rounded-[3px] p-5 hover:border-line-2 transition-colors">
      <div className="flex items-start justify-between gap-6 flex-wrap">
        <div className="min-w-0 flex-1">
          <Link
            href={`/buy/${entry.arweaveTxId}`}
            className="block text-[16px] text-ink font-medium leading-tight truncate hover:underline underline-offset-4 decoration-line-2"
            prefetch={false}
          >
            {entry.name}
          </Link>
          <div className="mt-1.5 flex items-baseline gap-3 flex-wrap">
            <span className="font-mono text-[12.5px] tracking-[0.04em] text-ink/80 tnum">
              {amountDisplay}
            </span>
            <span className="font-mono text-[11px] tracking-[0.06em] uppercase text-dim">
              · {new Date(entry.createdAt).toLocaleDateString()}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={copy}
            className="text-[12px] font-mono tracking-[0.05em] uppercase px-3 py-1.5 border border-line rounded-[2px] text-ink hover:bg-line/30 transition-colors"
            aria-label="Copy product URL"
          >
            {copied ? "Copied" : "Copy URL"}
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="text-[12px] font-mono tracking-[0.05em] uppercase px-3 py-1.5 border border-transparent text-muted hover:text-brick transition-colors"
            aria-label="Remove product from dashboard"
          >
            Remove
          </button>
        </div>
      </div>

      <div className="mt-4 pt-4 border-t border-line/60">
        <input
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="w-full text-[11.5px] font-mono bg-paper-3/40 border border-line rounded-[2px] px-2 py-1.5 text-muted truncate"
        />
      </div>
    </article>
  );
}
