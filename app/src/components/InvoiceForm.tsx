"use client";

import { useState } from "react";
import { PAYMENT_SYMBOL, PAYMENT_DECIMALS } from "@/lib/constants";

export interface InvoiceFormValues {
  creatorDisplayName: string;
  payerDisplayName: string;
  payerWallet: string;
  lineItems: Array<{ description: string; quantity: string; unitPrice: string }>;
  notes: string;
  dueDate: string;
}

interface Props {
  values: InvoiceFormValues;
  onChange: (update: Partial<InvoiceFormValues>) => void;
  onSubmit: () => void;
  errorMessage?: string | null;
  onDismissError?: () => void;
  /** Form id used by the canvas bar's submit button via HTML5 form= attr. */
  formId?: string;
}

/**
 * Controlled invoice form. State lives in the parent (CreatePage) so the
 * sticky <InvoiceCanvasBar> can read live subtotal + mount its own
 * primary button outside this <form> via `form="<formId>"`.
 *
 * No card chrome — a continuous editorial canvas. Section structure
 * preserved (Parties → Items → Optional details) but expressed via
 * type hierarchy and whitespace, not bordered <section>s.
 */
export function InvoiceForm({
  values,
  onChange,
  onSubmit,
  errorMessage,
  onDismissError,
  formId = "invoice-form",
}: Props) {
  // Which optional-detail chip is currently expanded for editing.
  // null = chip row is collapsed; "notes" / "due" / "restrict" = open.
  const [openChip, setOpenChip] = useState<null | "notes" | "due" | "restrict">(null);

  function update(partial: Partial<InvoiceFormValues>) {
    onDismissError?.();
    onChange(partial);
  }

  function updateLineItem(
    idx: number,
    field: "description" | "quantity" | "unitPrice",
    value: string,
  ) {
    onDismissError?.();
    onChange({
      lineItems: values.lineItems.map((li, i) =>
        i === idx ? { ...li, [field]: value } : li,
      ),
    });
  }

  function addLineItem() {
    onDismissError?.();
    onChange({
      lineItems: [
        ...values.lineItems,
        { description: "", quantity: "1", unitPrice: "" },
      ],
    });
  }

  function removeLineItem(idx: number) {
    onDismissError?.();
    onChange({ lineItems: values.lineItems.filter((_, i) => i !== idx) });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit();
  }

  return (
    <form id={formId} onSubmit={handleSubmit} className="space-y-12 md:space-y-14">
      {/* From / Bill to — display-size inline-editable headlines */}
      <div className="space-y-8 md:space-y-10">
        <div>
          <label className="eyebrow block mb-2" htmlFor="cv-from">From</label>
          <input
            id="cv-from"
            value={values.creatorDisplayName}
            onChange={(e) => update({ creatorDisplayName: e.target.value })}
            className="canvas-display-input"
            placeholder="Acme Design Ltd."
            required
            aria-label="From"
          />
        </div>
        <div>
          <label className="eyebrow block mb-2" htmlFor="cv-billto">Bill to</label>
          <input
            id="cv-billto"
            value={values.payerDisplayName}
            onChange={(e) => update({ payerDisplayName: e.target.value })}
            className="canvas-display-input"
            placeholder="Globex Corp."
            required
            aria-label="Bill to"
          />
        </div>
      </div>

      {/* Line items — clean table, no card. Eyebrow + divider live here
          (not at the page top) so the band reads as the seam between
          parties and items, where the visual weight belongs. */}
      <div>
        <div className="eyebrow text-muted mb-3">New invoice</div>
        <div className="border-t border-line pt-8">
        {/* Column headers */}
        <div className="hidden md:grid grid-cols-[1.75rem_1fr_4rem_9rem_8rem_1.5rem] gap-4 pb-3 border-b border-line items-baseline">
          <div />
          <div className="mono-chip">Description</div>
          <div className="mono-chip text-right">Qty</div>
          <div className="mono-chip text-right">Rate · {PAYMENT_SYMBOL}</div>
          <div className="mono-chip text-right">Amount</div>
          <div />
        </div>

        <div className="divide-y divide-line/60">
          {values.lineItems.map((li, idx) => (
            <LineItemRow
              key={idx}
              index={idx}
              item={li}
              canRemove={values.lineItems.length > 1}
              onChange={(field, value) => updateLineItem(idx, field, value)}
              onRemove={() => removeLineItem(idx)}
            />
          ))}
        </div>

        <div className="mt-5">
          <button
            type="button"
            onClick={addLineItem}
            className="inline-flex items-center gap-2 text-[13px] text-muted hover:text-ink transition-colors"
          >
            <span aria-hidden className="text-gold">+</span>
            Add line
          </button>
        </div>
        </div>
      </div>

      {/* Optional-detail chips */}
      <div className="border-t border-line pt-8">
        <div className="flex flex-wrap gap-2.5">
          <DetailChip
            label={values.notes ? values.notes : "+ Note"}
            filled={!!values.notes}
            active={openChip === "notes"}
            onClick={() => setOpenChip(openChip === "notes" ? null : "notes")}
          />
          <DetailChip
            label={values.dueDate ? `Due ${values.dueDate}` : "+ Due date"}
            filled={!!values.dueDate}
            active={openChip === "due"}
            onClick={() => setOpenChip(openChip === "due" ? null : "due")}
          />
          <DetailChip
            label={
              values.payerWallet
                ? `Restricted to ${values.payerWallet.slice(0, 4)}…${values.payerWallet.slice(-4)}`
                : "+ Restrict who can pay"
            }
            filled={!!values.payerWallet}
            active={openChip === "restrict"}
            onClick={() => setOpenChip(openChip === "restrict" ? null : "restrict")}
          />
        </div>

        {/* Inline expansion area for the active chip */}
        {openChip === "notes" && (
          <div className="mt-5 max-w-2xl">
            <textarea
              value={values.notes}
              onChange={(e) => update({ notes: e.target.value })}
              className="input-editorial resize-none"
              rows={3}
              placeholder="Net 30. Late fee 1.5%/month. Thanks for your business."
              aria-label="Notes"
            />
          </div>
        )}

        {openChip === "due" && (
          <div className="mt-5 max-w-xs">
            <input
              type="date"
              value={values.dueDate}
              onChange={(e) => update({ dueDate: e.target.value })}
              className="input-editorial font-mono"
              aria-label="Due date"
            />
            {values.dueDate && (
              <button
                type="button"
                onClick={() => update({ dueDate: "" })}
                className="mt-2 text-[12px] text-muted hover:text-ink"
              >
                Clear
              </button>
            )}
          </div>
        )}

        {openChip === "restrict" && (
          <div className="mt-5 max-w-xl">
            <input
              value={values.payerWallet}
              onChange={(e) => update({ payerWallet: e.target.value })}
              className="input-editorial font-mono text-sm"
              placeholder="4w85uvq3GeKRWKeeB2CyH4FeSYtWsvumHt3XB2TaZdFg"
              aria-label="Payer wallet"
            />
            <p className="text-[12px] text-dim mt-2">
              Only the wallet you enter will be able to settle this invoice.
            </p>
          </div>
        )}
      </div>

      {/* Contextual error — sticky bar handles primary submit, no inline button */}
      {errorMessage && (
        <div className="flex items-start gap-4 border-l-2 border-brick pl-4 py-2 max-w-xl">
          <span className="mono-chip text-brick shrink-0 pt-0.5">Error</span>
          <span className="text-sm text-ink leading-relaxed flex-1">{errorMessage}</span>
          {onDismissError && (
            <button
              type="button"
              onClick={onDismissError}
              className="text-dim hover:text-ink transition-colors text-lg leading-none shrink-0"
              aria-label="Dismiss error"
            >
              ×
            </button>
          )}
        </div>
      )}
    </form>
  );
}

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

function LineItemRow({
  index,
  item,
  canRemove,
  onChange,
  onRemove,
}: {
  index: number;
  item: { description: string; quantity: string; unitPrice: string };
  canRemove: boolean;
  onChange: (field: "description" | "quantity" | "unitPrice", value: string) => void;
  onRemove: () => void;
}) {
  const amountMicros = computeLineMicros(item.quantity, item.unitPrice);
  const amountDisplay =
    amountMicros == null ? (
      <span className="text-dim">—</span>
    ) : (
      <span className="text-ink">{formatMicros(amountMicros)}</span>
    );

  return (
    <div className="md:grid md:grid-cols-[1.75rem_1fr_4rem_9rem_8rem_1.5rem] md:gap-4 md:items-baseline py-4 group flex flex-col gap-3">
      <div className="font-mono text-[11px] text-dim tabular-nums md:pt-2.5">
        {String(index + 1).padStart(2, "0")}
      </div>
      <div>
        <input
          value={item.description}
          onChange={(e) => onChange("description", e.target.value)}
          className="input-editorial"
          placeholder="Brand identity design (40h)"
          required
          aria-label={`Description for line ${index + 1}`}
        />
      </div>
      <div>
        <input
          value={item.quantity}
          onChange={(e) => onChange("quantity", sanitizeInteger(e.target.value))}
          inputMode="numeric"
          className="input-editorial text-right font-mono tabular-nums"
          placeholder="1"
          required
          aria-label={`Quantity for line ${index + 1}`}
        />
      </div>
      <div>
        <input
          value={item.unitPrice}
          onChange={(e) => onChange("unitPrice", sanitizeDecimal(e.target.value))}
          inputMode="decimal"
          className="input-editorial text-right font-mono tabular-nums"
          placeholder="0.00"
          required
          aria-label={`Unit price for line ${index + 1}`}
        />
      </div>
      <div className="text-right font-mono text-base tabular-nums md:pt-2">
        {amountDisplay}
      </div>
      <div className="md:text-right md:pt-1.5">
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="text-dim hover:text-brick transition-colors text-xl leading-none"
            aria-label={`Remove line ${index + 1}`}
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}

// ---- helpers (unchanged behavior, lifted into module scope) -------------

function sanitizeInteger(raw: string): string {
  return raw.replace(/[^\d]/g, "");
}

function sanitizeDecimal(raw: string): string {
  let cleaned = raw.replace(/[^\d.]/g, "");
  const firstDot = cleaned.indexOf(".");
  if (firstDot !== -1) {
    cleaned =
      cleaned.slice(0, firstDot + 1) +
      cleaned.slice(firstDot + 1).replace(/\./g, "");
    const [whole, frac = ""] = cleaned.split(".");
    cleaned = whole + "." + frac.slice(0, 6);
  }
  return cleaned;
}

function parseAmountToBaseUnits(value: string): bigint | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(
    new RegExp(`^(\\d+)(?:\\.(\\d{0,${PAYMENT_DECIMALS}}))?$`),
  );
  if (!match) return null;
  const whole = BigInt(match[1]);
  const fraction = (match[2] ?? "")
    .padEnd(PAYMENT_DECIMALS, "0")
    .slice(0, PAYMENT_DECIMALS);
  return whole * 10n ** BigInt(PAYMENT_DECIMALS) + BigInt(fraction);
}

function computeLineMicros(quantity: string, unitPrice: string): bigint | null {
  if (!quantity.trim() || !unitPrice.trim()) return null;
  const qty = Number.parseInt(quantity, 10);
  if (!Number.isFinite(qty) || qty <= 0) return null;
  const micros = parseAmountToBaseUnits(unitPrice);
  if (micros == null) return null;
  return BigInt(qty) * micros;
}

function formatMicros(micros: bigint): string {
  const divisor = 10n ** BigInt(PAYMENT_DECIMALS);
  const whole = micros / divisor;
  const fraction = micros % divisor;
  const fractionStr = fraction
    .toString()
    .padStart(PAYMENT_DECIMALS, "0")
    .slice(0, Math.min(4, PAYMENT_DECIMALS));
  return `${whole.toLocaleString("en-US")}.${fractionStr}`;
}

/**
 * Compute subtotal across all line items as base units. Exported so the
 * page can derive the live subtotal for the canvas bar.
 */
export function computeSubtotalMicros(values: InvoiceFormValues): bigint {
  return values.lineItems.reduce<bigint>((acc, li) => {
    const m = computeLineMicros(li.quantity, li.unitPrice);
    return m == null ? acc : acc + m;
  }, 0n);
}

/**
 * Format a bigint micros value as a "X,XXX.XX SYMBOL" string for the
 * canvas bar's subtotal indicator.
 */
export function formatSubtotal(micros: bigint): string {
  return `${formatMicros(micros)} ${PAYMENT_SYMBOL}`;
}
