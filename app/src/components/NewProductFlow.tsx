"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { CanvasBar, type CanvasBarState } from "@/components/CanvasBar";
import { VeilDescentMark } from "@/components/VeilDescentMark";
import { USDC_MINT, PAYMENT_SYMBOL, PAYMENT_DECIMALS } from "@/lib/constants";
import {
  addProductToCache,
  buildProductSpec,
  buildProductUrl,
  parseAmountToBaseUnits,
  uploadProductSpec,
} from "@/lib/products";

/**
 * NewProductFlow — Document Canvas redesign (2026-05-04).
 *
 * Same pattern as /create invoice + payroll: borderless display-size
 * inputs for the primary fields (Name, Price), optional fields hidden
 * behind chips (Description, Image URL), no card chrome anywhere, all
 * primary actions on the sticky <CanvasBar> at the bottom of the
 * viewport. Mounting in /create's chevron-back flow or as the
 * /products/new standalone route both work — the form is self-contained
 * and the bar portals to document.body so it's never constrained by an
 * ancestor transform.
 */
export function NewProductFlow() {
  const router = useRouter();
  const wallet = useWallet();

  const [name, setName] = useState("");
  const [priceText, setPriceText] = useState("");
  const [description, setDescription] = useState("");
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
  const [openChip, setOpenChip] = useState<null | "description" | "image">(null);

  /* ───────────────────── derived state ───────────────────── */

  // Validate price live so the canvas bar can enable/disable the Publish
  // button without the user clicking through to a useless attempt.
  const priceMicros = priceText.trim()
    ? parseAmountToBaseUnits(priceText, PAYMENT_DECIMALS)
    : null;
  const priceValid = priceMicros != null && priceMicros > 0n;
  const canSubmit =
    !submitting && wallet.connected && name.trim().length > 0 && priceValid;
  const priceDisplay = priceText.trim()
    ? `${priceText.trim()} ${PAYMENT_SYMBOL}`
    : `0.00 ${PAYMENT_SYMBOL}`;

  /* ───────────────────── canvas-bar state mapping ───────────────────── */

  const canvasState: CanvasBarState | null = !wallet.connected
    ? null
    : success
      ? {
          kind: "success",
          shareUrl: success.url,
          copyLabel: "Copy link",
          copied,
          onCopy: handleCopy,
          extras: [
            {
              label: "Preview buy page",
              onClick: () => window.open(success.url, "_blank"),
            },
          ],
          nav: { label: "All products", href: "/products" },
        }
      : submitting
        ? {
            kind: "publishing",
            stepLabel: "Uploading product to Arweave",
            stepCounter: "",
            awaitingWallet: false,
          }
        : {
            kind: "compose",
            totalDisplay: priceDisplay,
            canSubmit,
            buttonLabel: "Publish product",
          };

  /* ───────────────────── handlers ───────────────────── */

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
        amountDisplay: `${priceText.trim()} ${spec.symbol}`,
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

  /* ─────────────────────────────── render ─────────────────────────────── */

  // Wallet gate — same editorial register as the connected states.
  if (!wallet.connected) {
    return (
      <div className="max-w-2xl mx-auto">
        <span className="eyebrow">Storefront</span>
        <h2 className="mt-3 font-sans font-medium text-ink text-[40px] md:text-[52px] leading-[1.04] tracking-[-0.025em]">
          Open a private storefront.
        </h2>
        <p className="mt-6 text-[17px] md:text-[19px] text-ink/80 leading-[1.5]">
          Publish one product, get a URL. Customers buy through it any time —
          payments arrive privately through Umbra, no per-customer setup.
        </p>
        <div className="mt-8">
          <ClientWalletMultiButton />
        </div>
      </div>
    );
  }

  // Success state — replaces the form. VeilDescentMark celebrates the
  // publish; the canvas bar at the bottom holds the share URL.
  if (success) {
    return (
      <div className="max-w-3xl mx-auto pb-32">
        <SuccessHero
          name={success.name}
          amountDisplay={success.amountDisplay}
        />
        {canvasState && <CanvasBar state={canvasState} formId="product-form" />}
      </div>
    );
  }

  // Compose state.
  return (
    <div className="max-w-3xl mx-auto pb-32">
      <form
        id="product-form"
        onSubmit={handleSubmit}
        className="space-y-12 md:space-y-14"
        noValidate
      >
        {/* Name — display-size inline-editable headline */}
        <div>
          <label className="eyebrow block mb-2" htmlFor="product-name">
            Name
          </label>
          <input
            id="product-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="canvas-display-input"
            placeholder="Pro plan, annual"
            required
            maxLength={120}
            autoFocus
            spellCheck={false}
            aria-label="Product name"
          />
        </div>

        {/* Price — display-size with mono-cap currency suffix */}
        <div>
          <label className="eyebrow block mb-2" htmlFor="product-price">
            Price · {PAYMENT_SYMBOL}
          </label>
          <input
            id="product-price"
            value={priceText}
            onChange={(e) =>
              setPriceText(e.target.value.replace(/[^\d.]/g, ""))
            }
            inputMode="decimal"
            className="canvas-display-input tabular-nums"
            placeholder="0.00"
            required
            spellCheck={false}
            autoComplete="off"
            aria-label="Price"
          />
        </div>

        {/* Optional details — chips */}
        <div className="border-t border-line pt-8">
          <div className="flex flex-wrap gap-2.5">
            <DetailChip
              label={
                description
                  ? description.length > 60
                    ? description.slice(0, 60) + "…"
                    : description
                  : "+ Description"
              }
              filled={!!description}
              active={openChip === "description"}
              onClick={() =>
                setOpenChip(openChip === "description" ? null : "description")
              }
            />
            <DetailChip
              label={imageUrl ? "Image · linked" : "+ Image URL"}
              filled={!!imageUrl}
              active={openChip === "image"}
              onClick={() => setOpenChip(openChip === "image" ? null : "image")}
            />
          </div>

          {openChip === "description" && (
            <div className="mt-5 max-w-2xl">
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                maxLength={2000}
                className="input-editorial resize-none"
                placeholder="What customers are buying. Plain text, not Markdown."
                aria-label="Description"
              />
            </div>
          )}

          {openChip === "image" && (
            <div className="mt-5 max-w-xl">
              <input
                type="url"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                className="input-editorial font-mono text-sm"
                placeholder="https://example.com/your-image.png"
                aria-label="Image URL"
              />
              <p className="mt-2 text-[12px] text-dim">
                We don&apos;t host images — link to where it already lives.
              </p>
            </div>
          )}
        </div>

        {error && (
          <div className="flex items-start gap-4 border-l-2 border-brick pl-4 py-2 max-w-xl">
            <span className="mono-chip text-brick shrink-0 pt-0.5">Error</span>
            <span className="text-[13.5px] text-ink leading-relaxed">
              {error}
            </span>
            <button
              type="button"
              onClick={() => setError(null)}
              className="text-dim hover:text-ink transition-colors text-lg leading-none shrink-0"
              aria-label="Dismiss error"
            >
              ×
            </button>
          </div>
        )}
      </form>

      {canvasState && <CanvasBar state={canvasState} formId="product-form" />}
    </div>
  );
}

/* ─────────────────────────── sub-components ─────────────────────────── */

function DetailChip({
  label,
  filled,
  active,
  onClick,
}: {
  label: string;
  filled: boolean;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "canvas-chip",
        filled ? "" : "canvas-chip-empty",
        active ? "ring-2 ring-ink/15" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-expanded={active}
    >
      <span className={filled ? "text-ink" : ""}>{label}</span>
    </button>
  );
}

function SuccessHero({
  name,
  amountDisplay,
}: {
  name: string;
  amountDisplay: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center pt-4 md:pt-6 pb-8">
      <VeilDescentMark size={144} variant="single" />
      <div className="mt-8 eyebrow text-sage">✓ Storefront live · just now</div>
      <div className="mt-3 font-sans font-medium text-ink text-[28px] md:text-[32px] leading-[1.1] tracking-[-0.025em]">
        <span>{name}</span>
        <span className="text-muted"> · </span>
        <span className="tnum">{amountDisplay}</span>
      </div>
      <p className="mt-4 text-[14px] leading-[1.55] text-muted max-w-[480px]">
        Share the link below with customers. They pay privately through Umbra;
        every purchase appears in your dashboard as an incoming UTXO.
      </p>
    </div>
  );
}
