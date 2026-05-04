"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import {
  USDC_MINT,
  PAYMENT_SYMBOL,
  PAYMENT_DECIMALS,
} from "@/lib/constants";
import {
  addProductToCache,
  buildProductSpec,
  buildProductUrl,
  parseAmountToBaseUnits,
  uploadProductSpec,
} from "@/lib/products";

/**
 * NewProductFlow — pure body of the "create a payment-link product"
 * surface, hoisted out of `app/src/app/products/new/page.tsx` so /create
 * can embed the same form inline (like Invoice and Payroll do).
 *
 * Design contract:
 *   - Returns ONLY the form / success-state content. No <main>, no
 *     <ProductFrame>, no nav, no `max-w-[1400px]` page section — the
 *     caller wraps the content in whatever chrome they're providing.
 *   - The component does include the inner `max-w-2xl mx-auto` column
 *     because that's the form's intrinsic width and is identical
 *     between /create and /products/new.
 *   - All state is internal; unmounting resets it. That's what makes
 *     /create's chevron-back "discard and pick another mode" feel right.
 */
export function NewProductFlow() {
  const router = useRouter();
  const wallet = useWallet();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [priceText, setPriceText] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{
    arweaveTxId: string;
    name: string;
    amountDisplay: string;
    url: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!wallet.publicKey) {
      setError("Connect your wallet first.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const amountBaseUnits = parseAmountToBaseUnits(priceText, PAYMENT_DECIMALS);
      if (amountBaseUnits == null || amountBaseUnits === 0n) {
        throw new Error(
          `Enter a valid price greater than zero (e.g. 1.50 ${PAYMENT_SYMBOL}).`,
        );
      }

      const trimmedName = name.trim();
      if (trimmedName.length === 0) {
        throw new Error("Give your product a name.");
      }

      const spec = buildProductSpec({
        name: trimmedName,
        description: description.trim() || undefined,
        amountBaseUnits,
        mint: USDC_MINT.toBase58(),
        decimals: PAYMENT_DECIMALS,
        symbol: PAYMENT_SYMBOL,
        ownerWallet: wallet.publicKey.toBase58(),
        imageUrl: imageUrl.trim() || undefined,
      });

      const { arweaveTxId } = await uploadProductSpec(spec);

      addProductToCache(wallet.publicKey.toBase58(), {
        id: arweaveTxId,
        arweaveTxId,
        name: spec.name,
        amountBaseUnits: spec.amountBaseUnits,
        symbol: spec.symbol,
        decimals: spec.decimals,
        createdAt: spec.createdAt,
      });

      const url = buildProductUrl(window.location.origin, arweaveTxId);
      setSuccess({
        arweaveTxId,
        name: spec.name,
        amountDisplay: `${priceText} ${spec.symbol}`,
        url,
      });
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCopy() {
    if (!success) return;
    try {
      await navigator.clipboard.writeText(success.url);
    } catch {
      /* non-secure context — silently swallow, the visual still flips */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2200);
  }

  return (
    <div className="max-w-2xl mx-auto">
      {!wallet.connected ? (
        <div>
          <span className="eyebrow">Storefront · New product</span>
          <h1 className="mt-4 font-display font-medium text-ink text-[44px] md:text-[56px] leading-[1.02] tracking-[-0.02em]">
            Open a private storefront.
          </h1>
          <p className="mt-5 text-[15.5px] leading-[1.55] text-ink/70 max-w-md">
            Publish one product, get a URL. Customers buy through it any time —
            payments arrive privately through Umbra, no per-customer setup.
          </p>
          <div className="mt-8">
            <ClientWalletMultiButton />
          </div>
        </div>
      ) : success ? (
        <SuccessState
          success={success}
          copied={copied}
          onCopy={handleCopy}
          onViewAll={() => router.push("/products")}
        />
      ) : (
        <form onSubmit={handleSubmit} className="space-y-10" noValidate>
          <header>
            <span className="eyebrow">Storefront · New product</span>
            <h1 className="mt-4 font-display font-medium text-ink text-[44px] md:text-[56px] leading-[1.02] tracking-[-0.02em]">
              New product.
            </h1>
            <p className="mt-4 text-[14.5px] leading-[1.55] text-ink/70 max-w-lg">
              Give it a name and a price. We&apos;ll publish a private
              storefront URL any number of customers can pay through.
            </p>
          </header>

          <div>
            <label className="block">
              <span className="eyebrow">Name</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Pro plan, annual"
                maxLength={120}
                autoFocus
                className="mt-2 w-full bg-transparent border-0 border-b border-line outline-none text-ink placeholder:text-dim font-sans font-medium text-[28px] md:text-[32px] leading-[1.1] tracking-[-0.02em] py-2 focus:border-ink transition-colors"
              />
            </label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <label className="block">
              <span className="eyebrow">Price</span>
              <div className="mt-2 flex items-baseline gap-3">
                <input
                  type="text"
                  inputMode="decimal"
                  value={priceText}
                  onChange={(e) => setPriceText(e.target.value)}
                  placeholder="1.50"
                  className="flex-1 min-w-0 bg-transparent border-0 border-b border-line outline-none text-ink placeholder:text-dim font-sans font-medium text-[28px] md:text-[32px] leading-[1.1] tracking-[-0.02em] tnum py-2 focus:border-ink transition-colors"
                />
                <span className="font-mono text-[12px] tracking-[0.12em] uppercase text-muted shrink-0">
                  {PAYMENT_SYMBOL}
                </span>
              </div>
            </label>

            <div>
              <span className="eyebrow">Mint</span>
              <div className="mt-2 font-mono text-[12px] text-muted py-2 break-all leading-relaxed">
                {USDC_MINT.toBase58()}
                <span className="ml-2 text-dim">· {PAYMENT_DECIMALS} decimals</span>
              </div>
            </div>
          </div>

          <label className="block">
            <span className="eyebrow">Description (optional)</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What customers are buying. Markdown not supported."
              rows={4}
              maxLength={2000}
              className="mt-2 w-full bg-transparent border border-line rounded-[3px] outline-none text-ink placeholder:text-dim font-sans text-[14.5px] leading-[1.6] p-3 focus:border-ink transition-colors resize-y"
            />
          </label>

          <label className="block">
            <span className="eyebrow">Image URL (optional)</span>
            <input
              type="url"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              placeholder="https://example.com/your-image.png"
              className="mt-2 w-full bg-transparent border border-line rounded-[3px] outline-none text-ink placeholder:text-dim font-sans text-[14px] leading-[1.5] px-3 py-2.5 focus:border-ink transition-colors"
            />
            <span className="mt-1.5 block text-[12px] text-muted leading-relaxed">
              We don&apos;t host images — link to where it already lives.
            </span>
          </label>

          {error && (
            <div className="border-l-2 border-brick pl-4 py-2 text-[13.5px] text-ink leading-relaxed">
              {error}
            </div>
          )}

          <div className="flex items-center gap-4 pt-4">
            <button
              type="submit"
              disabled={submitting}
              className="btn-primary md:min-w-[260px]"
            >
              {submitting ? (
                <span className="inline-flex items-center gap-3">
                  <span className="h-1.5 w-1.5 rounded-full bg-paper animate-slow-pulse" />
                  Publishing…
                </span>
              ) : (
                <span>
                  Publish product <span aria-hidden>→</span>
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => router.push("/products")}
              className="btn-quiet"
              disabled={submitting}
            >
              Cancel
            </button>
          </div>

          <p className="text-[12px] text-muted leading-relaxed max-w-md">
            Product details are uploaded to Arweave (permanent, public). The
            URL embeds the Arweave id so anyone can verify the product
            spec. Only the owner wallet receives funds.
          </p>
        </form>
      )}
    </div>
  );
}

function SuccessState({
  success,
  copied,
  onCopy,
  onViewAll,
}: {
  success: { arweaveTxId: string; name: string; amountDisplay: string; url: string };
  copied: boolean;
  onCopy: () => void;
  onViewAll: () => void;
}) {
  return (
    <div className="space-y-10">
      <header>
        <span className="eyebrow text-sage">✓ Published · Just now</span>
        <h1 className="mt-4 font-display font-medium text-ink text-[40px] md:text-[52px] leading-[1.02] tracking-[-0.02em]">
          Your product is live.
        </h1>
        <p className="mt-4 text-[15px] leading-[1.55] text-ink/70 max-w-lg">
          Share this link or QR with customers. They&apos;ll pay privately
          through Umbra — every purchase shows up in your dashboard as an
          incoming UTXO.
        </p>
      </header>

      <div className="border border-line rounded-[3px] p-5 bg-paper-3/40">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <div className="text-[15.5px] text-ink font-medium leading-tight">
              {success.name}
            </div>
            <div className="mt-1 font-mono text-[12px] tracking-[0.04em] text-muted tnum">
              {success.amountDisplay}
            </div>
          </div>
          <span className="mono-chip text-sage">live</span>
        </div>

        <div className="mt-5 pt-5 border-t border-line/70">
          <div className="eyebrow mb-2">Share URL</div>
          <div className="flex items-stretch gap-2">
            <input
              readOnly
              value={success.url}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 min-w-0 text-[12px] font-mono bg-paper border border-line rounded-[2px] px-2.5 py-2 text-ink truncate"
            />
            <button
              type="button"
              onClick={onCopy}
              className="text-[12px] font-mono tracking-[0.05em] uppercase px-3 py-2 border border-line rounded-[2px] text-ink hover:bg-line/30 transition-colors shrink-0"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-5">
        <button type="button" onClick={onViewAll} className="btn-primary">
          See all products <span aria-hidden>→</span>
        </button>
        <a
          href={success.url}
          target="_blank"
          rel="noreferrer"
          className="btn-quiet"
        >
          Preview the buy page →
        </a>
      </div>
    </div>
  );
}
