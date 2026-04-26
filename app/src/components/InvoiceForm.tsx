"use client";

import { useMemo, useState } from "react";
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
  onSubmit: (values: InvoiceFormValues) => Promise<void>;
  submitting: boolean;
  errorMessage?: string | null;
  onDismissError?: () => void;
}

export function InvoiceForm({ onSubmit, submitting, errorMessage, onDismissError }: Props) {
  const [values, setValues] = useState<InvoiceFormValues>({
    creatorDisplayName: "",
    payerDisplayName: "",
    payerWallet: "",
    lineItems: [{ description: "", quantity: "1", unitPrice: "" }],
    notes: "",
    dueDate: "",
  });
  const [restrictPayer, setRestrictPayer] = useState(false);

  const lineTotals = useMemo(
    () => values.lineItems.map((li) => computeLineMicros(li.quantity, li.unitPrice)),
    [values.lineItems],
  );

  const subtotalMicros = useMemo<bigint>(
    () => lineTotals.reduce<bigint>((acc, m) => (m == null ? acc : acc + m), 0n),
    [lineTotals],
  );

  function updateValues(update: Partial<InvoiceFormValues>) {
    onDismissError?.();
    setValues((v) => ({ ...v, ...update }));
  }

  function addLineItem() {
    onDismissError?.();
    setValues((v) => ({
      ...v,
      lineItems: [...v.lineItems, { description: "", quantity: "1", unitPrice: "" }],
    }));
  }

  function updateLineItem(
    idx: number,
    field: "description" | "quantity" | "unitPrice",
    value: string,
  ) {
    onDismissError?.();
    setValues((v) => ({
      ...v,
      lineItems: v.lineItems.map((li, i) => (i === idx ? { ...li, [field]: value } : li)),
    }));
  }

  function removeLineItem(idx: number) {
    onDismissError?.();
    setValues((v) => ({ ...v, lineItems: v.lineItems.filter((_, i) => i !== idx) }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const submitted = restrictPayer
      ? values
      : { ...values, payerWallet: "" };
    await onSubmit(submitted);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      {/* Parties */}
      <section className="rounded-[4px] border border-line bg-paper-3/60 p-7 md:p-9 space-y-7 animate-fade-up">
        <SectionHeader eyebrow="01" title="Parties" />

        <div className="space-y-7">
          <Field label="From">
            <input
              value={values.creatorDisplayName}
              onChange={(e) => updateValues({ creatorDisplayName: e.target.value })}
              className="input-editorial"
              placeholder="Acme Design Ltd."
              required
            />
            <FieldHint>Your name or business as it will appear on the invoice.</FieldHint>
          </Field>

          <Field label="Bill to">
            <input
              value={values.payerDisplayName}
              onChange={(e) => updateValues({ payerDisplayName: e.target.value })}
              className="input-editorial"
              placeholder="Globex Corp."
              required
            />
            <FieldHint>How the payer will be identified on the invoice.</FieldHint>
          </Field>

          <OptionalToggle
            label="Restrict who can pay"
            hint="Only the wallet you enter will be able to settle this invoice."
            open={restrictPayer}
            onToggle={() => {
              onDismissError?.();
              setRestrictPayer((prev) => !prev);
              if (restrictPayer) updateValues({ payerWallet: "" });
            }}
          >
            <Field label="Payer wallet">
              <input
                value={values.payerWallet}
                onChange={(e) => updateValues({ payerWallet: e.target.value })}
                className="input-editorial font-mono text-sm"
                placeholder="4w85uvq3GeKRWKeeB2CyH4FeSYtWsvumHt3XB2TaZdFg"
              />
            </Field>
          </OptionalToggle>
        </div>
      </section>

      {/* Items */}
      <section className="rounded-[4px] border border-line bg-paper-3/60 p-7 md:p-9 space-y-7 animate-fade-up" style={{ animationDelay: "100ms" }}>
        <SectionHeader eyebrow="02" title="Items" />

        <div>
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
                amountMicros={lineTotals[idx]}
                canRemove={values.lineItems.length > 1}
                onChange={(field, value) => updateLineItem(idx, field, value)}
                onRemove={() => removeLineItem(idx)}
              />
            ))}
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-between gap-6">
            <button
              type="button"
              onClick={addLineItem}
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded-[3px] border border-line bg-paper hover:bg-paper-2 hover:border-ink/60 transition-colors text-[13px] font-sans font-medium text-ink"
            >
              <span aria-hidden className="text-gold">+</span>
              Add line
            </button>

            <div className="inline-flex items-baseline gap-4 rounded-[3px] bg-paper-2/60 border border-line px-5 py-3">
              <span className="mono-chip">Subtotal</span>
              <span className="font-sans font-medium text-ink text-[24px] md:text-[28px] tabular-nums tracking-[-0.02em] leading-none">
                {formatMicros(subtotalMicros)}
              </span>
              <span className="font-mono text-[10.5px] text-dim tracking-[0.14em] uppercase">
                {PAYMENT_SYMBOL}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* Terms */}
      <section className="rounded-[4px] border border-line bg-paper-3/60 p-7 md:p-9 space-y-7 animate-fade-up" style={{ animationDelay: "200ms" }}>
        <SectionHeader eyebrow="03" title="Terms" />

        <div className="grid grid-cols-1 md:grid-cols-[2fr_1fr] gap-10">
          <Field label="Notes" optional>
            <textarea
              value={values.notes}
              onChange={(e) => updateValues({ notes: e.target.value })}
              className="input-editorial resize-none"
              rows={3}
              placeholder="Net 30. Late fee 1.5%/month. Thanks for your business."
            />
          </Field>
          <Field label="Due date" optional>
            <input
              type="date"
              value={values.dueDate}
              onChange={(e) => updateValues({ dueDate: e.target.value })}
              className="input-editorial font-mono"
            />
          </Field>
        </div>
      </section>

      {/* Submit + contextual error */}
      <div className="pt-2 animate-fade-up space-y-5" style={{ animationDelay: "300ms" }}>
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
        <button
          type="submit"
          disabled={submitting || subtotalMicros === 0n}
          className="btn-primary w-full md:w-auto md:min-w-[340px]"
        >
          {submitting ? (
            <span className="inline-flex items-center gap-3">
              <span className="h-1.5 w-1.5 rounded-full bg-paper animate-slow-pulse" />
              Publishing encrypted invoice
            </span>
          ) : (
            <span>
              Create private invoice <span aria-hidden>→</span>
            </span>
          )}
        </button>
        <p className="max-w-xl text-[12px] font-mono tracking-[0.12em] uppercase text-dim">
          Encrypts client-side · Anchors hash on Solana · Settles via Umbra UTXO
        </p>
      </div>
    </form>
  );
}

function SectionHeader({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="flex items-baseline gap-4 pb-1">
      <span className="font-mono text-[10.5px] text-gold tracking-[0.18em] tabular-nums">
        {eyebrow}
      </span>
      <h2 className="font-sans font-medium text-ink text-[20px] md:text-[22px] tracking-[-0.015em] leading-none">
        {title}
      </h2>
    </div>
  );
}

function Field({
  label,
  optional,
  children,
}: {
  label: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-3">
        <label className="mono-chip">{label}</label>
        {optional && (
          <span className="font-mono text-[10px] tracking-[0.16em] uppercase text-dim">
            Optional
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function FieldHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[12px] text-dim font-sans leading-relaxed mt-1.5">{children}</div>
  );
}

function OptionalToggle({
  label,
  hint,
  open,
  onToggle,
  children,
}: {
  label: string;
  hint: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border-t border-line/60 pt-5">
      <button
        type="button"
        onClick={onToggle}
        className="group flex items-baseline gap-3 text-left"
      >
        <span
          className={`font-mono text-[11px] tabular-nums transition-colors ${
            open ? "text-gold" : "text-dim group-hover:text-ink"
          }`}
        >
          {open ? "−" : "+"}
        </span>
        <span className="mono-chip group-hover:text-ink transition-colors">{label}</span>
      </button>
      {!open && <div className="text-[12px] text-dim mt-1.5 ml-5">{hint}</div>}
      {open && <div className="mt-5 ml-5">{children}</div>}
    </div>
  );
}

function LineItemRow({
  index,
  item,
  amountMicros,
  canRemove,
  onChange,
  onRemove,
}: {
  index: number;
  item: { description: string; quantity: string; unitPrice: string };
  amountMicros: bigint | null;
  canRemove: boolean;
  onChange: (field: "description" | "quantity" | "unitPrice", value: string) => void;
  onRemove: () => void;
}) {
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
      <div className="text-right font-mono text-base tabular-nums md:pt-2">{amountDisplay}</div>
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

// ---- helpers ------------------------------------------------------------

function sanitizeInteger(raw: string): string {
  return raw.replace(/[^\d]/g, "");
}

function sanitizeDecimal(raw: string): string {
  let cleaned = raw.replace(/[^\d.]/g, "");
  const firstDot = cleaned.indexOf(".");
  if (firstDot !== -1) {
    cleaned =
      cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "");
    const [whole, frac = ""] = cleaned.split(".");
    cleaned = whole + "." + frac.slice(0, 6);
  }
  return cleaned;
}

function parseAmountToBaseUnits(value: string): bigint | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(new RegExp(`^(\\d+)(?:\\.(\\d{0,${PAYMENT_DECIMALS}}))?$`));
  if (!match) return null;
  const whole = BigInt(match[1]);
  const fraction = (match[2] ?? "").padEnd(PAYMENT_DECIMALS, "0").slice(0, PAYMENT_DECIMALS);
  return whole * (10n ** BigInt(PAYMENT_DECIMALS)) + BigInt(fraction);
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
  const fractionStr = fraction.toString().padStart(PAYMENT_DECIMALS, "0").slice(0, Math.min(4, PAYMENT_DECIMALS));
  return `${whole.toLocaleString("en-US")}.${fractionStr}`;
}
