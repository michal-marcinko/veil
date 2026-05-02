"use client";

import { useState } from "react";
import { X25519HelpDialog } from "./X25519HelpDialog";

export interface ComplianceGrantFormValues {
  receiverAddress: string;
  receiverX25519PubKey: string;
  note?: string;
}

interface Props {
  onSubmit: (values: ComplianceGrantFormValues) => Promise<void>;
  submitting: boolean;
  /**
   * Audit URL to surface to Alice after a successful grant. Carries the
   * 64-byte metadata master signature in the URL fragment, so it MUST be
   * delivered out-of-band over a trusted channel (Signal, encrypted email).
   * The on-chain grant proves authorization; this URL delivers the key.
   */
  auditUrl?: string | null;
}

export function ComplianceGrantForm({ onSubmit, submitting, auditUrl }: Props) {
  const [receiverAddress, setReceiverAddress] = useState("");
  const [receiverX25519PubKey, setReceiverX25519PubKey] = useState("");
  const [note, setNote] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await onSubmit({
      receiverAddress: receiverAddress.trim(),
      receiverX25519PubKey: receiverX25519PubKey.trim(),
      note: note.trim() || undefined,
    });
  }

  async function handleCopy() {
    if (!auditUrl) return;
    try {
      // Prefer the modern clipboard API; fall back to a hidden textarea so the
      // copy still works in older browsers / non-secure contexts.
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(auditUrl);
      } else if (typeof document !== "undefined") {
        const ta = document.createElement("textarea");
        ta.value = auditUrl;
        ta.setAttribute("readonly", "");
        ta.style.position = "absolute";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Best-effort: clipboard failures shouldn't break the flow.
    }
  }

  return (
    <>
      {auditUrl && (
        <div className="mb-8 border border-sage/40 bg-sage/5 rounded-[3px] p-5 md:p-6 max-w-xl">
          <span className="eyebrow text-sage">Audit URL</span>
          <div className="mt-3 flex items-center gap-2">
            <input
              readOnly
              value={auditUrl}
              onFocus={(e) => e.currentTarget.select()}
              onClick={(e) => e.currentTarget.select()}
              className="flex-1 input-editorial font-mono text-[12px] select-all"
              aria-label="Audit URL"
            />
            <button
              type="button"
              onClick={handleCopy}
              className="shrink-0 px-4 py-2 border border-line rounded-[3px] font-mono text-[11px] tracking-[0.12em] uppercase text-ink hover:bg-ink hover:text-paper transition-colors"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="mt-3 font-mono text-[11px] leading-relaxed text-muted">
            Send this link to your auditor over a trusted channel (Signal,
            encrypted email). The on-chain grant proves authorization; this URL
            delivers the decryption key.
          </p>
        </div>
      )}
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

        <Field
          label="Auditor X25519 public key"
          headerRight={
            <button
              type="button"
              onClick={() => setHelpOpen(true)}
              className="font-mono text-[10.5px] tracking-[0.08em] uppercase text-muted hover:text-ink transition-colors underline-offset-2 hover:underline"
            >
              Where do I get this?
            </button>
          }
        >
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

      <X25519HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
    </>
  );
}

function Field({
  label,
  optional,
  headerRight,
  children,
}: {
  label: string;
  optional?: boolean;
  headerRight?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-3 justify-between">
        <div className="flex items-baseline gap-3">
          <label className="mono-chip">{label}</label>
          {optional && (
            <span className="font-mono text-[10px] tracking-[0.16em] uppercase text-dim">
              Optional
            </span>
          )}
        </div>
        {headerRight}
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
