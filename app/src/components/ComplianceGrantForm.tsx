"use client";

import { useState } from "react";

export interface ComplianceGrantFormValues {
  receiverAddress: string;
  receiverX25519PubKey: string;
  note?: string;
}

interface Props {
  onSubmit: (values: ComplianceGrantFormValues) => Promise<void>;
  submitting: boolean;
}

export function ComplianceGrantForm({ onSubmit, submitting }: Props) {
  const [receiverAddress, setReceiverAddress] = useState("");
  const [receiverX25519PubKey, setReceiverX25519PubKey] = useState("");
  const [note, setNote] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await onSubmit({
      receiverAddress: receiverAddress.trim(),
      receiverX25519PubKey: receiverX25519PubKey.trim(),
      note: note.trim() || undefined,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium mb-1">
          Auditor Solana wallet address
        </label>
        <input
          value={receiverAddress}
          onChange={(e) => setReceiverAddress(e.target.value)}
          placeholder="base58 Solana wallet address"
          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded font-mono text-sm"
          required
        />
        <p className="text-xs text-gray-500 mt-1">
          The on-chain address of your auditor or accountant.
        </p>
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">
          Auditor X25519 public key
        </label>
        <input
          value={receiverX25519PubKey}
          onChange={(e) => setReceiverX25519PubKey(e.target.value)}
          placeholder="base58 encoded X25519 public key (32 bytes)"
          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded font-mono text-sm"
          required
        />
        <p className="text-xs text-gray-500 mt-1">
          Ask your auditor for their X25519 key. Once the grant is created, they can
          decrypt transactions scoped by the grant nonce.{" "}
          <strong>Warning:</strong> the nonce creates permanent disclosure for
          everything encrypted under it, even after revocation.
        </p>
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">
          Note for the auditor <span className="text-gray-500">(optional)</span>
        </label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Scope, period covered, engagement reference, etc."
          rows={3}
          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm"
        />
      </div>
      <button
        type="submit"
        disabled={submitting}
        className="w-full px-6 py-3 bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
      >
        {submitting ? "Creating grant..." : "Grant access"}
      </button>
    </form>
  );
}
