"use client";

import { useState } from "react";

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

  function addLineItem() {
    setValues((v) => ({ ...v, lineItems: [...v.lineItems, { description: "", quantity: "1", unitPrice: "" }] }));
  }

  function updateLineItem(idx: number, field: "description" | "quantity" | "unitPrice", value: string) {
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
    <form onSubmit={handleSubmit} className="space-y-6">
      <div>
        <label className="block text-sm font-medium mb-1">Your name or business</label>
        <input
          value={values.creatorDisplayName}
          onChange={(e) => setValues({ ...values, creatorDisplayName: e.target.value })}
          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded"
          required
        />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">Payer display name</label>
        <input
          value={values.payerDisplayName}
          onChange={(e) => setValues({ ...values, payerDisplayName: e.target.value })}
          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded"
          required
        />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">
          Payer wallet <span className="text-gray-500">(optional — leave empty for share-by-link)</span>
        </label>
        <input
          value={values.payerWallet}
          onChange={(e) => setValues({ ...values, payerWallet: e.target.value })}
          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded"
          placeholder="Globex wallet address"
        />
      </div>
      <div>
        <label className="block text-sm font-medium mb-2">Line items</label>
        {values.lineItems.map((li, idx) => (
          <div key={idx} className="flex gap-2 mb-2">
            <input
              value={li.description}
              onChange={(e) => updateLineItem(idx, "description", e.target.value)}
              placeholder="Description"
              className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded"
              required
            />
            <input
              value={li.quantity}
              onChange={(e) => updateLineItem(idx, "quantity", e.target.value)}
              placeholder="Qty"
              className="w-20 px-3 py-2 bg-gray-800 border border-gray-700 rounded"
              required
            />
            <input
              value={li.unitPrice}
              onChange={(e) => updateLineItem(idx, "unitPrice", e.target.value)}
              placeholder="Unit price (USDC)"
              className="w-32 px-3 py-2 bg-gray-800 border border-gray-700 rounded"
              required
            />
            {values.lineItems.length > 1 && (
              <button
                type="button"
                onClick={() => removeLineItem(idx)}
                className="px-3 text-red-400 hover:text-red-300"
              >
                ✕
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={addLineItem}
          className="text-sm text-indigo-400 hover:text-indigo-300"
        >
          + Add line item
        </button>
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">Notes</label>
        <textarea
          value={values.notes}
          onChange={(e) => setValues({ ...values, notes: e.target.value })}
          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded"
          rows={3}
        />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">Due date</label>
        <input
          type="date"
          value={values.dueDate}
          onChange={(e) => setValues({ ...values, dueDate: e.target.value })}
          className="px-3 py-2 bg-gray-800 border border-gray-700 rounded"
        />
      </div>
      <button
        type="submit"
        disabled={submitting}
        className="w-full px-6 py-3 bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
      >
        {submitting ? "Creating..." : "Create Private Invoice"}
      </button>
    </form>
  );
}
