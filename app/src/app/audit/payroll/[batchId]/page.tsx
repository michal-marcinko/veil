"use client";

// ---------------------------------------------------------------------------
// /audit/payroll/[batchId] — payroll batch auditor view (scoped grant flow).
//
// Same URL-fragment-key model as /audit/grant/[grantId], but the grant is
// understood to cover one payroll batch worth of invoices. The path
// segment is the batch ID (for human/log clarity) — the access material
// is in the fragment.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { VeilLogo } from "@/components/VeilLogo";
import {
  decodeScopedAuditFragment,
  decryptScopedGrant,
  type DecryptedScopedGrantEntry,
} from "@/lib/auditor-links";
import type { InvoiceMetadata } from "@/lib/types";

type LoadStatus = "loading" | "ready" | "denied";

interface AuditRow {
  uri: string;
  invoiceId: string;
  date: string;
  payer: string;
  payerWallet: string;
  amount: string;
  amountRaw: string;
  symbol: string;
  memo: string;
  ok: boolean;
  error: string | null;
}

export default function PayrollAuditPage() {
  const params = useParams();
  const batchId =
    typeof params?.batchId === "string"
      ? params.batchId
      : Array.isArray(params?.batchId)
        ? params.batchId[0]
        : "";

  const [status, setStatus] = useState<LoadStatus>("loading");
  const [denyReason, setDenyReason] = useState<string | null>(null);
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [decryptedAt, setDecryptedAt] = useState<string | null>(null);

  const [payerQuery, setPayerQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function run() {
      const hash = typeof window !== "undefined" ? window.location.hash : "";
      let payload;
      try {
        payload = decodeScopedAuditFragment(hash);
      } catch {
        if (!cancelled) {
          setStatus("denied");
          setDenyReason(
            "Audit URL is missing or malformed — the link must include the decryption package after #.",
          );
        }
        return;
      }

      if (payload.invoiceUris.length === 0) {
        if (!cancelled) {
          setStatus("ready");
          setRows([]);
          setDecryptedAt(new Date().toISOString().slice(0, 19).replace("T", " ") + " UTC");
        }
        return;
      }

      let entries: DecryptedScopedGrantEntry[];
      try {
        entries = await decryptScopedGrant(payload);
      } catch (err: any) {
        if (!cancelled) {
          setStatus("denied");
          setDenyReason(`Failed to fetch grant contents: ${err?.message ?? String(err)}`);
        }
        return;
      }

      if (cancelled) return;

      const built: AuditRow[] = entries.map((e) => entryToRow(e));
      // Newest first.
      built.sort((a, b) => (a.date < b.date ? 1 : -1));

      setRows(built);
      setStatus("ready");
      setDecryptedAt(
        new Date().toISOString().slice(0, 19).replace("T", " ") + " UTC",
      );
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (!r.ok) return true;
      if (payerQuery.trim().length > 0) {
        if (!r.payer.toLowerCase().includes(payerQuery.trim().toLowerCase())) {
          return false;
        }
      }
      return true;
    });
  }, [rows, payerQuery]);

  const totals = useMemo(() => {
    let total = 0n;
    let symbol = "";
    let decimals = 0;
    let count = 0;
    for (const r of rows) {
      if (!r.ok) continue;
      try {
        total += BigInt(r.amountRaw);
        if (!symbol) symbol = r.symbol;
        // decimals: peek at the first metadata-derived row's display.
        // Recompute decimals from the difference between the displayed
        // form and amountRaw to avoid passing it explicitly here.
        if (decimals === 0) {
          const dotIdx = r.amount.indexOf(".");
          if (dotIdx >= 0) {
            const fracPart = r.amount.slice(dotIdx + 1).split(" ")[0];
            decimals = fracPart.length;
          }
        }
        count++;
      } catch {
        /* ignore parse failures */
      }
    }
    return { total, symbol, decimals, count };
  }, [rows]);

  function exportCsv() {
    const header = [
      "invoice_id",
      "created_at",
      "payer",
      "payer_wallet",
      "amount_raw",
      "amount_display",
      "symbol",
      "memo",
    ];
    const lines = [header.join(",")];
    for (const r of filteredRows) {
      if (!r.ok) continue;
      lines.push(
        [
          csvCell(r.invoiceId),
          csvCell(r.date),
          csvCell(r.payer),
          csvCell(r.payerWallet),
          csvCell(r.amountRaw),
          csvCell(r.amount),
          csvCell(r.symbol),
          csvCell(r.memo),
        ].join(","),
      );
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `veil-payroll-audit-${batchId || "batch"}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <Shell>
      <div className="reveal">
        <div className="mb-10">
          <span className="eyebrow">Audit access</span>
          <h1 className="mt-3 font-sans font-medium text-ink text-[40px] md:text-[52px] leading-[1.05] tracking-[-0.03em]">
            Payroll batch audit
          </h1>
          <p className="mt-5 text-[14.5px] leading-[1.6] text-ink/70 max-w-2xl">
            Batch <span className="font-mono text-ink break-all">{batchId || "—"}</span>
            {decryptedAt ? (
              <>
                <span className="mx-2 text-line-2">·</span>
                Decrypted at <span className="font-mono text-ink">{decryptedAt}</span>
              </>
            ) : null}
          </p>
        </div>

        <StatusBanner
          status={status}
          denyReason={denyReason}
          decryptedCount={rows.filter((r) => r.ok).length}
          totalCount={rows.length}
        />

        {status === "ready" && rows.length > 0 && (
          <>
            <BatchTotals
              count={totals.count}
              total={totals.total}
              symbol={totals.symbol}
              decimals={totals.decimals}
            />
            <FilterBar
              payerQuery={payerQuery}
              onPayerChange={setPayerQuery}
              onExport={exportCsv}
            />
            <PayrollTable rows={filteredRows} />
          </>
        )}

        <p className="mt-8 max-w-2xl font-mono text-[12px] text-muted leading-relaxed">
          This URL covers one payroll batch. The decryption key in the fragment
          can&apos;t be used to read other batches or other invoices. Anyone
          who has this URL can read these rows — treat the link as the secret.
        </p>
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function entryToRow(e: DecryptedScopedGrantEntry): AuditRow {
  if (!e.metadata) {
    return {
      uri: e.uri,
      invoiceId: "—",
      date: "—",
      payer: "—",
      payerWallet: "",
      amount: "—",
      amountRaw: "",
      symbol: "",
      memo: "",
      ok: false,
      error: e.error,
    };
  }
  const md: InvoiceMetadata = e.metadata;
  return {
    uri: e.uri,
    invoiceId: md.invoice_id,
    date: md.created_at,
    payer: md.payer.display_name || "—",
    payerWallet: md.payer.wallet ?? "",
    amount: formatAmount(BigInt(md.total), md.currency.decimals, md.currency.symbol),
    amountRaw: md.total,
    symbol: md.currency.symbol,
    memo: md.notes ?? "",
    ok: true,
    error: null,
  };
}

function formatAmount(amount: bigint, decimals: number, symbol: string): string {
  const divisor = decimals > 0 ? 10n ** BigInt(decimals) : 1n;
  const whole = amount / divisor;
  const frac = decimals > 0 ? amount % divisor : 0n;
  const display = Math.min(4, decimals);
  const padded =
    decimals > 0
      ? frac.toString().padStart(decimals, "0").slice(0, display)
      : "";
  const wholeFormatted = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const numeric = padded ? `${wholeFormatted}.${padded}` : wholeFormatted;
  return symbol ? `${numeric} ${symbol}` : numeric;
}

function csvCell(s: string): string {
  if (s == null) return "";
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// ---------------------------------------------------------------------------
// UI components
// ---------------------------------------------------------------------------

function StatusBanner({
  status,
  denyReason,
  decryptedCount,
  totalCount,
}: {
  status: LoadStatus;
  denyReason: string | null;
  decryptedCount: number;
  totalCount: number;
}) {
  if (status === "loading") {
    return (
      <div className="mb-10 flex items-start gap-4 border-l-2 border-gold pl-5 py-3 max-w-2xl">
        <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-gold animate-pulse shrink-0" />
        <div>
          <div className="mono-chip text-gold mb-1">Decrypting</div>
          <div className="text-[14px] text-ink leading-relaxed">
            Fetching ciphertexts and decrypting under the per-grant key…
          </div>
        </div>
      </div>
    );
  }
  if (status === "denied") {
    return (
      <div className="mb-10 flex items-start gap-4 border-l-2 border-brick pl-5 py-3 max-w-2xl">
        <div>
          <div className="mono-chip text-brick mb-1">Cannot read</div>
          <div className="text-[14px] text-ink leading-relaxed">
            {denyReason ?? "Audit URL is invalid or unreadable."}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="mb-10 flex items-start gap-4 border-l-2 border-sage pl-5 py-3 max-w-2xl">
      <svg
        width="14"
        height="14"
        viewBox="0 0 12 12"
        fill="none"
        aria-hidden
        className="mt-1 text-sage shrink-0"
      >
        <path
          d="M2 6l3 3 5-6"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <div>
        <div className="mono-chip text-sage mb-1">Decrypted</div>
        <div className="text-[14px] text-ink leading-relaxed">
          {totalCount === 0
            ? "Grant references no invoices."
            : `${decryptedCount} of ${totalCount} invoice${totalCount === 1 ? "" : "s"} decrypted.`}
        </div>
      </div>
    </div>
  );
}

function BatchTotals({
  count,
  total,
  symbol,
  decimals,
}: {
  count: number;
  total: bigint;
  symbol: string;
  decimals: number;
}) {
  const display = formatAmount(total, decimals || 0, symbol);
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-10">
      <Card label="Invoices" value={count.toString()} />
      <Card label="Total disbursed" value={display} />
    </div>
  );
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-line bg-paper-3 rounded-[4px] p-6">
      <span className="eyebrow">{label}</span>
      <div className="mt-2 font-sans tnum text-ink text-[24px] md:text-[28px] font-medium tracking-[-0.02em] leading-none">
        {value}
      </div>
    </div>
  );
}

function FilterBar({
  payerQuery,
  onPayerChange,
  onExport,
}: {
  payerQuery: string;
  onPayerChange: (v: string) => void;
  onExport: () => void;
}) {
  return (
    <div className="mb-10 border border-line rounded-[3px] p-4 flex flex-wrap items-end gap-x-6 gap-y-4">
      <div className="flex flex-col gap-1.5 flex-1 min-w-[220px]">
        <label className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-muted">
          Payer
        </label>
        <input
          type="text"
          value={payerQuery}
          onChange={(e) => onPayerChange(e.target.value)}
          placeholder="Filter by payer name…"
          className="bg-paper-3 border border-line rounded-[3px] px-3 py-2 font-mono text-[12.5px] text-ink placeholder:text-dim/80 focus:outline-none focus:border-ink"
        />
      </div>
      <button
        type="button"
        onClick={onExport}
        className="px-4 py-2 border border-line rounded-[3px] font-mono text-[11px] tracking-[0.12em] uppercase text-ink hover:bg-ink hover:text-paper transition-colors"
      >
        Export CSV
      </button>
    </div>
  );
}

function PayrollTable({ rows }: { rows: AuditRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="border border-line rounded-[4px] py-12 text-center">
        <p className="text-[13.5px] text-muted">No invoices match the current filter.</p>
      </div>
    );
  }
  return (
    <div className="border border-line rounded-[4px] overflow-hidden">
      <div className="grid grid-cols-[160px_1fr_140px_180px_140px] gap-4 px-5 md:px-6 py-3 border-b border-line bg-paper-3">
        {["Date", "Payer", "Amount", "Memo", "Status"].map((h) => (
          <span
            key={h}
            className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-muted"
          >
            {h}
          </span>
        ))}
      </div>
      <ul className="divide-y divide-line">
        {rows.map((r) => (
          <li
            key={r.uri}
            className="grid grid-cols-[160px_1fr_140px_180px_140px] gap-4 px-5 md:px-6 py-4 items-center"
          >
            <div className="font-mono text-[11px] text-dim tnum">
              {r.ok ? r.date.slice(0, 19).replace("T", " ") : "—"}
            </div>
            <div className="font-mono text-[12px] text-ink truncate">
              {r.ok ? r.payer : "(failed)"}
            </div>
            <div className="font-sans tnum font-medium text-ink text-[15px]">
              {r.ok ? r.amount : "—"}
            </div>
            <div className="font-mono text-[11px] text-muted truncate">
              {r.ok ? r.memo || "—" : r.error ?? "—"}
            </div>
            <div className="font-mono text-[10.5px] tracking-[0.14em] uppercase">
              {r.ok ? <span className="text-sage">decrypted</span> : <span className="text-brick">failed</span>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen relative pb-32">
      <nav className="sticky top-0 z-10 backdrop-blur-sm bg-paper/80 border-b border-line">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between px-6 md:px-8 py-4">
          <VeilLogo tagline="auditor view" />
          <ClientWalletMultiButton />
        </div>
      </nav>
      <section className="max-w-[1400px] mx-auto px-6 md:px-8 pt-16">{children}</section>
    </main>
  );
}
