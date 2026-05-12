"use client";

import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useParams } from "next/navigation";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { VeilLogo } from "@/components/VeilLogo";
import { fetchInvoicesByCreator } from "@/lib/anchor";
import { PAYMENT_SYMBOL } from "@/lib/constants";
import { getOrCreateMetadataMasterSig } from "@/lib/encryption";
import {
  buildScopedPayrollAuditUrl,
  generateScopedGrant,
  type InScopeInvoice,
} from "@/lib/auditor-links";

interface BatchInvoice {
  pda: string;
  metadataUri: string;
  metadataHash: Uint8Array;
  status: "pending" | "paid" | "expired" | "canceled" | string;
  createdAt: number;
}

interface AuditorLinkPreview {
  url: string;
  invoiceCount: number;
  skippedCount: number;
}

export default function BatchDashboardPage() {
  const wallet = useWallet();
  const params = useParams<{ batchId: string }>();
  const batchId = params?.batchId ?? "";

  const [invoices, setInvoices] = useState<BatchInvoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  // Auditor link state — gated behind a click so we don't pop a wallet
  // signature unless the user actually wants to share the batch.
  const [generatingAudit, setGeneratingAudit] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditPreview, setAuditPreview] = useState<AuditorLinkPreview | null>(null);
  const [auditCopied, setAuditCopied] = useState(false);

  async function refresh() {
    if (!wallet.publicKey) return;
    setLoading(true);
    setError(null);
    try {
      const all = await fetchInvoicesByCreator(wallet as any, wallet.publicKey);
      // Fast path: `batch_id` lives in the metadataUri query string, so we
      // can filter without hitting Arweave at all.
      const filtered = all
        .map((a: any) => ({
          pda: a.publicKey.toBase58(),
          metadataUri: a.account.metadataUri as string,
          metadataHash:
            a.account.metadataHash instanceof Uint8Array
              ? a.account.metadataHash
              : new Uint8Array(a.account.metadataHash ?? []),
          status: Object.keys(a.account.status)[0],
          createdAt: Number(a.account.createdAt),
        }))
        .filter((i: BatchInvoice) => extractBatchId(i.metadataUri) === batchId)
        .sort((a: BatchInvoice, b: BatchInvoice) => a.createdAt - b.createdAt);
      setInvoices(filtered);
    } catch (err: any) {
      setError(`Batch load: ${err.message ?? String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.publicKey, batchId]);

  const stats = useMemo(() => {
    let total = 0;
    let paid = 0;
    let pending = 0;
    for (const inv of invoices) {
      total++;
      if (inv.status === "paid") paid++;
      else if (inv.status === "pending") pending++;
    }
    return { total, paid, pending };
  }, [invoices]);

  async function handleCopy(idx: number, url: string) {
    await navigator.clipboard.writeText(url);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 2200);
  }

  async function handleGenerateAuditorLink() {
    if (!wallet.publicKey) return;
    if (invoices.length === 0) {
      setAuditError("No invoices in this batch to share.");
      return;
    }
    setGeneratingAudit(true);
    setAuditError(null);
    setAuditPreview(null);
    try {
      // Master sig — cached after first use, so this is a no-op popup most
      // of the time. Used in-process only; never embedded in the URL.
      const masterSig = await getOrCreateMetadataMasterSig(
        wallet as any,
        wallet.publicKey.toBase58(),
      );
      const inScope: InScopeInvoice[] = invoices.map((inv) => ({
        invoicePda: inv.pda,
        metadataUri: inv.metadataUri,
        metadataHash: inv.metadataHash,
      }));
      const payload = await generateScopedGrant({ masterSig, invoices: inScope });
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      const url = buildScopedPayrollAuditUrl({ origin, batchId, payload });
      setAuditPreview({
        url,
        invoiceCount: payload.invoiceUris.length,
        skippedCount: invoices.length - payload.invoiceUris.length,
      });
    } catch (err: any) {
      setAuditError(err?.message ?? String(err));
    } finally {
      setGeneratingAudit(false);
    }
  }

  async function copyAuditUrl() {
    if (!auditPreview) return;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(auditPreview.url);
      }
      setAuditCopied(true);
      setTimeout(() => setAuditCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  if (!wallet.connected) {
    return (
      <Shell>
        <div className="max-w-lg reveal">
          <span className="eyebrow">Batch dashboard</span>
          <h1 className="mt-4 font-sans font-medium text-ink text-[40px] md:text-[48px] leading-[1.05] tracking-[-0.03em]">
            Connect to view this batch.
          </h1>
          <div className="mt-8">
            <ClientWalletMultiButton />
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex items-baseline justify-between mb-10 reveal">
        <div>
          <span className="eyebrow">Batch</span>
          <h1 className="mt-3 font-sans font-medium text-ink text-[36px] md:text-[44px] leading-[1.05] tracking-[-0.025em] break-all">
            {batchId}
          </h1>
        </div>
        <button onClick={refresh} disabled={loading} className="btn-ghost text-[13px] px-4 py-2">
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {/* Totals */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-10 reveal">
        <StatCard label="Invoices" value={stats.total.toString()} />
        <StatCard label="Paid" value={stats.paid.toString()} />
        <StatCard label="Pending" value={stats.pending.toString()} />
      </div>

      {/* Auditor link generation — opt-in to avoid popping wallet sig until needed. */}
      <div className="mb-10 border border-line rounded-[3px] p-5 md:p-6 reveal">
        <div className="flex items-baseline justify-between gap-4 flex-wrap">
          <div>
            <span className="eyebrow">Share with auditor</span>
            <p className="mt-2 text-[13px] text-ink/70 max-w-xl leading-relaxed">
              Generate a link your auditor can open to see this batch&apos;s
              decrypted rows. The decryption key is fresh per grant and
              embedded in the URL fragment — it never leaves the browser
              until you copy it.
            </p>
          </div>
          <button
            type="button"
            onClick={handleGenerateAuditorLink}
            disabled={generatingAudit || invoices.length === 0}
            className="btn-primary text-[13px] px-5 py-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {generatingAudit ? "Generating…" : "Generate auditor link"}
          </button>
        </div>

        {auditError && (
          <div className="mt-5 flex items-start gap-3 border-l-2 border-brick pl-3 py-1">
            <span className="mono-chip text-brick shrink-0 pt-0.5">Error</span>
            <span className="text-[13px] text-ink leading-relaxed flex-1">{auditError}</span>
          </div>
        )}

        {auditPreview && (
          <div className="mt-5 border-t border-line pt-5">
            <div className="flex items-baseline justify-between mb-3">
              <span className="eyebrow text-sage">Auditor link</span>
              <span className="font-mono text-[11px] text-dim tnum">
                {String(auditPreview.invoiceCount).padStart(2, "0")} invoice
                {auditPreview.invoiceCount === 1 ? "" : "s"}
                {auditPreview.skippedCount > 0
                  ? ` · ${auditPreview.skippedCount} skipped`
                  : ""}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={auditPreview.url}
                onFocus={(e) => e.currentTarget.select()}
                onClick={(e) => e.currentTarget.select()}
                className="flex-1 input-editorial font-mono text-[12px] select-all"
                aria-label="Auditor URL"
              />
              <button
                type="button"
                onClick={copyAuditUrl}
                className="shrink-0 px-4 py-2 border border-line rounded-[3px] font-mono text-[11px] tracking-[0.12em] uppercase text-ink hover:bg-ink hover:text-paper transition-colors"
              >
                {auditCopied ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="mt-3 font-mono text-[11px] leading-relaxed text-muted">
              Send over a trusted channel (Signal, encrypted email). Anyone who
              has the link can read these rows; treat the URL as the secret.
            </p>
          </div>
        )}
      </div>

      {error && (
        <div className="mb-8 flex items-start gap-4 border-l-2 border-brick pl-4 py-2 max-w-2xl">
          <span className="mono-chip text-brick shrink-0 pt-0.5">Error</span>
          <span className="text-[13.5px] text-ink leading-relaxed flex-1">{error}</span>
        </div>
      )}

      {invoices.length === 0 ? (
        <div className="border border-line bg-paper-3 rounded-[4px] p-8 text-center">
          <span className="eyebrow">Nothing yet</span>
          <p className="mt-3 text-[14px] text-ink/80">
            No invoices found for batch <span className="font-mono">{batchId}</span> under this wallet.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-line/60 border-t border-line">
          {invoices.map((inv, i) => {
            const payUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/pay/${inv.pda}`;
            return (
              <li
                key={inv.pda}
                className="py-4 grid grid-cols-[1.75rem_1fr_6rem_auto] gap-4 items-baseline"
              >
                <span className="font-mono text-[11px] text-dim tabular-nums">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="font-mono text-[13px] text-ink truncate">
                  {inv.pda.slice(0, 8)}…{inv.pda.slice(-6)}
                </span>
                <StatusBadge status={inv.status} />
                <button
                  onClick={() => handleCopy(i, payUrl)}
                  className="btn-quiet text-[12px]"
                >
                  {copiedIdx === i ? "Copied ✓" : "Copy pay link"}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-10 pt-8 border-t border-line">
        <a href="/dashboard" className="btn-quiet">
          ← Back to activity
        </a>
      </div>
    </Shell>
  );
}

/**
 * Pull `batch=` off an Arweave-style URI. Returns null if not present.
 * Exported-style helper kept local — if it gets reused elsewhere, move it to
 * `lib/batch.ts`.
 */
function extractBatchId(uri: string): string | null {
  const q = uri.indexOf("?");
  if (q === -1) return null;
  const search = new URLSearchParams(uri.slice(q + 1));
  return search.get("batch");
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-line bg-paper-3 rounded-[4px] p-6">
      <span className="eyebrow">{label}</span>
      <div className="mt-2 font-sans tnum text-ink text-[28px] md:text-[32px] font-medium tracking-[-0.02em] leading-none">
        {value}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === "paid"
      ? "text-sage"
      : status === "expired" || status === "canceled"
        ? "text-brick"
        : "text-gold";
  return (
    <span className={`font-mono text-[11px] uppercase tracking-[0.14em] ${color}`}>
      {status}
    </span>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen relative pb-32">
      <nav className="sticky top-0 z-10 backdrop-blur-sm bg-paper/80 border-b border-line">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between px-6 md:px-8 py-4">
          <VeilLogo />
          <div className="flex items-center gap-1 md:gap-2">
            <a href="/create" className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors">
              Create
            </a>
            <a href="/dashboard" className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors">
              Activity
            </a>
            <a
              href="https://github.com/michal-marcinko/veil"
              target="_blank"
              rel="noreferrer noopener"
              className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors"
            >
              Docs
            </a>
            <div className="ml-2">
              <ClientWalletMultiButton />
            </div>
          </div>
        </div>
      </nav>

      <section className="max-w-[1400px] mx-auto px-6 md:px-8 pt-16 md:pt-20">{children}</section>
    </main>
  );
}
