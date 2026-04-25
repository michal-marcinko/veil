"use client";

import type { InvoiceMetadata } from "@/lib/types";

export function InvoiceView({ metadata }: { metadata: InvoiceMetadata }) {
  const subtotal = formatAmount(metadata.subtotal, metadata.currency.decimals);
  const tax = formatAmount(metadata.tax, metadata.currency.decimals);
  const total = formatAmount(metadata.total, metadata.currency.decimals);
  const issued = new Date(metadata.created_at).toISOString().slice(0, 10);
  const hasTax = BigInt(metadata.tax) > 0n;

  return (
    <article className="relative border border-line bg-paper-3 rounded-[4px] p-8 md:p-12 lg:p-14 font-sans animate-fade-up shadow-[0_1px_0_rgba(0,0,0,0.02),0_20px_60px_-30px_rgba(26,24,20,0.25)]">
      {/* Corner marker */}
      <div className="absolute top-4 right-4 md:top-6 md:right-6 text-right">
        <div className="mono-chip mb-1">Invoice</div>
        <div className="font-mono text-[11px] text-dim tracking-wider">
          {metadata.invoice_id}
        </div>
      </div>

      {/* Header: from */}
      <header className="pb-8 md:pb-10 border-b border-line">
        <div className="mono-chip mb-2">From</div>
        <h1 className="font-sans font-medium text-ink text-[28px] md:text-[40px] tracking-[-0.025em] leading-[1.05]">
          {metadata.creator.display_name}
        </h1>
        {metadata.creator.contact && (
          <div className="text-muted text-sm mt-3">{metadata.creator.contact}</div>
        )}
      </header>

      {/* Meta row: bill to · issued · currency */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 py-8 md:py-10 border-b border-line">
        <div>
          <div className="mono-chip mb-2">Bill to</div>
          <div className="font-sans text-ink text-[17px] md:text-[19px] leading-tight tracking-[-0.01em]">
            {metadata.payer.display_name}
          </div>
        </div>
        <div>
          <div className="mono-chip mb-2">Issued</div>
          <div className="font-mono text-ink text-sm tabular-nums">{issued}</div>
        </div>
        <div className="sm:text-right">
          <div className="mono-chip mb-2">Settlement</div>
          <div className="font-mono text-ink text-sm">{metadata.currency.symbol}</div>
        </div>
      </div>

      {/* Line items */}
      <div className="mt-10 mb-10">
        <div className="grid grid-cols-12 gap-4 pb-3 border-b border-line">
          <div className="col-span-6 mono-chip">Description</div>
          <div className="col-span-2 mono-chip text-right">Qty</div>
          <div className="col-span-2 mono-chip text-right">Rate</div>
          <div className="col-span-2 mono-chip text-right">Amount</div>
        </div>

        <div className="divide-y divide-line/60">
          {metadata.line_items.map((li, i) => (
            <div key={i} className="grid grid-cols-12 gap-4 py-4 items-baseline">
              <div className="col-span-6 font-sans text-ink">{li.description}</div>
              <div className="col-span-2 text-right font-mono text-muted tabular-nums">
                {li.quantity}
              </div>
              <div className="col-span-2 text-right font-mono text-muted tabular-nums">
                {formatAmount(li.unit_price, metadata.currency.decimals)}
              </div>
              <div className="col-span-2 text-right font-mono text-ink tabular-nums">
                {formatAmount(li.total, metadata.currency.decimals)}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Totals */}
      <div className="ml-auto max-w-xs space-y-2 pt-5 border-t border-line">
        <TotalRow label="Subtotal" value={subtotal} />
        {hasTax && <TotalRow label="Tax" value={tax} />}
        <div className="flex justify-between items-baseline pt-4 mt-2 border-t border-line-2">
          <span className="mono-chip">Total</span>
          <span className="font-sans font-medium text-ink text-[28px] md:text-[34px] tracking-[-0.02em] tabular-nums leading-none">
            {total}
            <span className="ml-2 font-mono text-[11px] text-muted uppercase tracking-[0.14em] font-normal">
              {metadata.currency.symbol}
            </span>
          </span>
        </div>
      </div>

      {/* Notes */}
      {metadata.notes && (
        <div className="mt-14 pt-8 border-t border-line max-w-xl">
          <div className="mono-chip mb-3">Note</div>
          <p className="font-sans text-ink/80 leading-[1.6] text-[14.5px] md:text-[15px]">
            {metadata.notes}
          </p>
        </div>
      )}

      {/* Due */}
      {metadata.due_date && (
        <div className="mt-8 mono-chip">
          Due <span className="text-ink ml-2 font-mono tabular-nums">{metadata.due_date}</span>
        </div>
      )}

      {/* Footer watermark */}
      <div className="mt-14 pt-6 border-t border-line flex flex-col md:flex-row justify-between gap-3 text-[11px] font-mono tracking-[0.14em] uppercase text-dim">
        <span>Issued via Veil · privacy layer by Umbra</span>
        <span>↝ amounts encrypted onchain</span>
      </div>
    </article>
  );
}

function TotalRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-baseline">
      <span className="text-muted text-sm">{label}</span>
      <span className="font-mono text-ink tabular-nums">{value}</span>
    </div>
  );
}

function formatAmount(units: string, decimals: number): string {
  const bn = BigInt(units);
  const divisor = BigInt(10) ** BigInt(decimals);
  const whole = bn / divisor;
  const fraction = bn % divisor;
  // Show up to 4 significant fractional digits; trim trailing zeros beyond 2.
  const display = Math.min(4, decimals);
  const padded = fraction.toString().padStart(decimals, "0").slice(0, display);
  const trimmed = padded.replace(/0+$/, "").padEnd(2, "0");
  return `${whole.toLocaleString("en-US")}.${trimmed}`;
}
