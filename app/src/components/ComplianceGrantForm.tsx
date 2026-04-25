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
    <form onSubmit={handleSubmit} className="space-y-8">
      <Field label="Auditor Solana wallet address">
        <input
          value={receiverAddress}
          onChange={(e) => setReceiverAddress(e.target.value)}
          placeholder="base58 Solana wallet address"
          className="input-editorial font-mono text-sm"
          required
        />
        <FieldHint>The on-chain address of your auditor or accountant.</FieldHint>
      </Field>

      <Field label="Auditor X25519 public key">
        <input
          value={receiverX25519PubKey}
          onChange={(e) => setReceiverX25519PubKey(e.target.value)}
          placeholder="base58 encoded X25519 public key (32 bytes)"
          className="input-editorial font-mono text-sm"
          required
        />
        <FieldHint>
          Ask your auditor for their X25519 key. Once granted, they can decrypt
          transactions scoped by this nonce.{" "}
          <span className="text-brick">
            Warning: the nonce creates permanent disclosure for everything encrypted
            under it, even after revocation.
          </span>
        </FieldHint>
      </Field>

      <Field label="Note for the auditor" optional>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Scope, period covered, engagement reference, etc."
          rows={3}
          className="input-editorial resize-none"
        />
      </Field>

      <button
        type="submit"
        disabled={submitting}
        className="btn-primary w-full md:w-auto md:min-w-[280px]"
      >
        {submitting ? (
          <span className="inline-flex items-center gap-3">
            <span className="h-1.5 w-1.5 rounded-full bg-paper animate-slow-pulse" />
            Creating grant…
          </span>
        ) : (
          <span>
            Grant access <span aria-hidden>→</span>
          </span>
        )}
      </button>
    </form>
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
    <div className="text-[12px] text-dim font-sans leading-relaxed mt-1.5">
      {children}
    </div>
  );
}
