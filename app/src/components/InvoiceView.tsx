"use client";

import type { InvoiceMetadata } from "@/lib/types";

export function InvoiceView({ metadata }: { metadata: InvoiceMetadata }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
      <div className="flex justify-between mb-6">
        <div>
          <div className="text-sm text-gray-500">FROM</div>
          <div className="font-bold">{metadata.creator.display_name}</div>
          {metadata.creator.contact && <div className="text-sm text-gray-400">{metadata.creator.contact}</div>}
        </div>
        <div className="text-right">
          <div className="text-sm text-gray-500">INVOICE</div>
          <div className="font-mono text-sm">{metadata.invoice_id}</div>
          <div className="text-xs text-gray-500 mt-1">{new Date(metadata.created_at).toLocaleDateString()}</div>
        </div>
      </div>

      <div className="mb-6">
        <div className="text-sm text-gray-500">BILL TO</div>
        <div className="font-bold">{metadata.payer.display_name}</div>
      </div>

      <table className="w-full mb-6">
        <thead>
          <tr className="border-b border-gray-800 text-left text-sm text-gray-500">
            <th className="pb-2">Description</th>
            <th className="pb-2 text-right">Qty</th>
            <th className="pb-2 text-right">Unit Price</th>
            <th className="pb-2 text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {metadata.line_items.map((li, i) => (
            <tr key={i} className="border-b border-gray-800/50">
              <td className="py-2">{li.description}</td>
              <td className="py-2 text-right">{li.quantity}</td>
              <td className="py-2 text-right font-mono">{formatAmount(li.unit_price, metadata.currency.decimals)}</td>
              <td className="py-2 text-right font-mono">{formatAmount(li.total, metadata.currency.decimals)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex justify-between items-center pt-4 border-t border-gray-800">
        <div className="text-gray-500">Total</div>
        <div className="text-2xl font-bold font-mono">
          {formatAmount(metadata.total, metadata.currency.decimals)} {metadata.currency.symbol}
        </div>
      </div>

      {metadata.notes && (
        <div className="mt-6 text-sm text-gray-400 italic">{metadata.notes}</div>
      )}
    </div>
  );
}

function formatAmount(units: string, decimals: number): string {
  const bn = BigInt(units);
  const divisor = BigInt(10 ** decimals);
  const whole = bn / divisor;
  const fraction = bn % divisor;
  return `${whole}.${fraction.toString().padStart(decimals, "0").slice(0, 2)}`;
}
