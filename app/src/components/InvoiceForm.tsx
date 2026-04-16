"use client";

import { useMemo, useState } from "react";

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
}

export function InvoiceForm({ onSubmit, submitting }: Props) {
  const [values, setValues] = useState<InvoiceFormValues>({
    creatorDisplayName: "",
    payerDisplayName: "",
    payerWallet: "",
    lineItems: [{ description: "", quantity: "1", unitPrice: "" }],
    notes: "",
    dueDate: "",
  });

  const runningTotal = useMemo(() => {
    try {
      const sum = values.lineItems.reduce((acc, li) => {
        if (!li.quantity || !li.unitPrice) return acc;
        return acc + BigInt(li.quantity) * BigInt(li.unitPrice);
      }, 0n);
      return formatMicroUsdc(sum);
    } catch {
      return null;
    }
  }, [values.lineItems]);

  function addLineItem() {
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
    setValues((v) => ({
      ...v,
      lineItems: v.lineItems.map((li, i) => (i === idx ? { ...li, [field]: value } : li)),
    }));
  }

  function removeLineItem(idx: number) {
    setValues((v) => ({ ...v, lineItems: v.lineItems.filter((_, i) => i !== idx) }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await onSubmit(values);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-20">
      {/* §I Parties */}
      <section className="space-y-10 animate-fade-up">
        <SectionHeader number="I" title="Parties" />

        <div className="space-y-9">
          <Field label="From" hint="Your name or business as it will appear on the invoice.">
            <input
              value={values.creatorDisplayName}
              onChange={(e) => setValues({ ...values, creatorDisplayName: e.target.value })}
              className="input-editorial"
              placeholder="Acme Design Ltd."
              required
            />
          </Field>

          <Field label="Bill to" hint="How the payer should be identified on the invoice.">
            <input
              value={values.payerDisplayName}
              onChange={(e) => setValues({ ...values, payerDisplayName: e.target.value })}
              className="input-editorial"
              placeholder="Globex Corp."
              required
            />
          </Field>

          <Field
            label="Payer wallet"
            hint="Optional — restricts who can pay. Leave empty to share by link."
          >
            <input
              value={values.payerWallet}
              onChange={(e) => setValues({ ...values, payerWallet: e.target.value })}
              className="input-editorial font-mono text-sm"
              placeholder="4w85uvq3GeKRWKeeB2CyH4FeSYtWsvumHt3XB2TaZdFg"
            />
          </Field>
        </div>
      </section>

      {/* §II Line items */}
      <section className="space-y-10 animate-fade-up" style={{ animationDelay: "120ms" }}>
        <SectionHeader number="II" title="Line items" />

        <div>
          <div className="grid grid-cols-12 gap-4 pb-3 border-b border-line">
            <div className="col-span-1 mono-chip">№</div>
            <div className="col-span-6 mono-chip">Description</div>
            <div className="col-span-2 mono-chip text-right">Qty</div>
            <div className="col-span-2 mono-chip text-right">Rate (µUSDC)</div>
            <div className="col-span-1" />
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

          <div className="mt-5 flex items-baseline justify-between">
            <button type="button" onClick={addLineItem} className="btn-quiet">
              + Add line item
            </button>

            {runningTotal && (
              <div className="flex items-baseline gap-4 text-sm">
                <span className="mono-chip">Subtotal</span>
                <span className="font-mono text-cream text-base tabular-nums">
                  {runningTotal} <span className="text-muted">USDC</span>
                </span>
              </div>
            )}
          </div>

          <p className="mt-6 max-w-md text-[12px] leading-relaxed text-dim">
            Amounts are expressed in USDC micro-units (6 decimals). Enter{" "}
            <span className="font-mono text-muted">100000000</span> for 100.00 USDC. A helper to
            type human-readable amounts is on the stretches plan.
          </p>
        </div>
      </section>

      {/* §III Terms */}
      <section className="space-y-10 animate-fade-up" style={{ animationDelay: "240ms" }}>
        <SectionHeader number="III" title="Terms" />

        <div className="grid grid-cols-1 md:grid-cols-3 gap-10 md:gap-12">
          <div className="md:col-span-2">
            <Field label="Notes">
              <textarea
                value={values.notes}
                onChange={(e) => setValues({ ...values, notes: e.target.value })}
                className="input-editorial resize-none"
                rows={3}
                placeholder="Net 30. Late fee 1.5%/month. Thanks for your business."
              />
            </Field>
          </div>
          <div>
            <Field label="Due">
              <input
                type="date"
                value={values.dueDate}
                onChange={(e) => setValues({ ...values, dueDate: e.target.value })}
                className="input-editorial font-mono"
              />
            </Field>
          </div>
        </div>
      </section>

      {/* Submit */}
      <div className="pt-4 animate-fade-up" style={{ animationDelay: "360ms" }}>
        <button
          type="submit"
          disabled={submitting}
          className="btn-primary w-full md:w-auto md:min-w-[360px]"
        >
          {submitting ? (
            <span className="inline-flex items-center gap-3">
              <span className="h-1.5 w-1.5 rounded-full bg-ink animate-slow-pulse" />
              Publishing encrypted invoice
            </span>
          ) : (
            <span>
              Create private invoice <span aria-hidden>→</span>
            </span>
          )}
        </button>
        <p className="mt-5 max-w-xl text-[12px] font-mono tracking-[0.12em] uppercase text-dim">
          Encrypts client-side · Anchors hash on Solana · Settles via Umbra UTXO
        </p>
      </div>
    </form>
  );
}

function SectionHeader({ number, title }: { number: string; title: string }) {
  return (
    <div className="flex items-baseline gap-6 border-b border-line pb-3">
      <span className="section-no">§ {number}</span>
      <h2 className="font-serif italic text-2xl md:text-3xl">{title}</h2>
      <span className="flex-1 h-px bg-line/60 mb-1" />
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline flex-wrap gap-x-3">
        <label className="mono-chip">{label}</label>
        {hint && (
          <span className="text-[12px] text-dim font-sans leading-relaxed">— {hint}</span>
        )}
      </div>
      {children}
    </div>
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
  onChange: (
    field: "description" | "quantity" | "unitPrice",
    value: string,
  ) => void;
  onRemove: () => void;
}) {
  return (
    <div className="grid grid-cols-12 gap-4 items-baseline py-4 group">
      <div className="col-span-1 font-mono text-[12px] text-dim tabular-nums pt-2.5">
        {String(index + 1).padStart(2, "0")}
      </div>
      <div className="col-span-6">
        <input
          value={item.description}
          onChange={(e) => onChange("description", e.target.value)}
          className="input-editorial"
          placeholder="Brand identity design (40h)"
          required
        />
      </div>
      <div className="col-span-2">
        <input
          value={item.quantity}
          onChange={(e) => onChange("quantity", e.target.value)}
          inputMode="numeric"
          className="input-editorial text-right font-mono tabular-nums"
          placeholder="1"
          required
        />
      </div>
      <div className="col-span-2">
        <input
          value={item.unitPrice}
          onChange={(e) => onChange("unitPrice", e.target.value)}
          inputMode="numeric"
          className="input-editorial text-right font-mono tabular-nums"
          placeholder="100000000"
          required
        />
      </div>
      <div className="col-span-1 text-right pt-1.5">
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

function formatMicroUsdc(micros: bigint): string {
  const divisor = 1_000_000n;
  const whole = micros / divisor;
  const fraction = micros % divisor;
  const fractionStr = fraction.toString().padStart(6, "0").slice(0, 2);
  return `${whole.toLocaleString("en-US")}.${fractionStr}`;
}
