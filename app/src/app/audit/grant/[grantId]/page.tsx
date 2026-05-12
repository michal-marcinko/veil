"use client";

// ---------------------------------------------------------------------------
// /audit/grant/[grantId] — auditor view, scoped-grant flow.
//
// Loads K + the Arweave URI list from the URL fragment, fetches each blob
// and decrypts it with K. Renders a clean table + CSV export.
//
// No wallet required to read — the URL is the credential. We still render
// a "connect wallet" affordance for parity with other audit pages, but it
// doesn't affect decryption.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { PublicKey } from "@solana/web3.js";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { VeilLogo } from "@/components/VeilLogo";
import {
  decodeScopedAuditFragment,
  decryptScopedGrant,
  type DecryptedScopedGrantEntry,
} from "@/lib/auditor-links";
import { fetchManyLocks } from "@/lib/anchor";
import { deriveLockPda } from "@/lib/lock-derivation";
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
  // Base58 of the wallet that actually settled the on-chain
  // PaymentIntentLock for this invoice. Empty when (a) the grant pre-dates
  // PDA embedding, (b) the lock account doesn't exist yet, or (c) the
  // on-chain fetch failed. Different from `payerWallet`, which is the
  // creator's claim taken from the encrypted invoice metadata.
  actualPayerWallet?: string;
  // Invoice PDA recovered from the re-encrypted blob (granter embedded it
  // in `generateScopedGrant`). Used internally to derive the lock PDA.
  invoicePda?: string;
  // null if this entry failed to decrypt
  ok: boolean;
  error: string | null;
}

export default function ScopedAuditGrantPage() {
  const params = useParams();
  const grantId =
    typeof params?.grantId === "string"
      ? params.grantId
      : Array.isArray(params?.grantId)
        ? params.grantId[0]
        : "";

  const [status, setStatus] = useState<LoadStatus>("loading");
  const [denyReason, setDenyReason] = useState<string | null>(null);
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [decryptedAt, setDecryptedAt] = useState<string | null>(null);

  // Filter state.
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [payerQuery, setPayerQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function run() {
      const hash = typeof window !== "undefined" ? window.location.hash : "";
      let payload;
      try {
        payload = decodeScopedAuditFragment(hash);
      } catch (err: any) {
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
          setDenyReason(
            `Failed to fetch grant contents: ${err?.message ?? String(err)}`,
          );
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

      // Best-effort on-chain enrichment: pull the actual settling wallet
      // out of each invoice's PaymentIntentLock PDA. This is the
      // trustless half of the auditor story — metadata says "Alice billed
      // Veil Pay for 1 SOL", chain says "wallet 7onP… settled it". We
      // batch one `getMultipleAccountsInfo` call (chunked at 100). On
      // any failure we leave the column empty silently.
      const rowsWithPda = built.filter((r) => r.invoicePda);
      if (rowsWithPda.length === 0) return;
      try {
        const lockPdaList = rowsWithPda
          .map((r) => {
            try {
              return { row: r, lockPda: deriveLockPda(new PublicKey(r.invoicePda!)) };
            } catch {
              return null;
            }
          })
          .filter((x): x is { row: AuditRow; lockPda: PublicKey } => x !== null);
        if (lockPdaList.length === 0) return;
        // Read-only Anchor wallet shim — no signing, just enough surface
        // for AnchorProvider to instantiate. Mirrors `fetchInvoicePublic`
        // in `lib/anchor.ts`.
        const readOnlyWallet = {
          publicKey: PublicKey.default,
          signTransaction: async () => {
            throw new Error("audit-grant: read-only wallet cannot sign");
          },
          signAllTransactions: async () => {
            throw new Error("audit-grant: read-only wallet cannot sign");
          },
        };
        const lockMap = await fetchManyLocks(
          readOnlyWallet as any,
          lockPdaList.map((x) => x.lockPda),
        );
        if (cancelled) return;
        // Re-key by uri so we can patch rows in place. AuditRow.uri is
        // unique per entry.
        const byUri = new Map<string, string>();
        for (const { row, lockPda } of lockPdaList) {
          const lock = lockMap.get(lockPda.toBase58());
          if (lock) byUri.set(row.uri, lock.payer.toBase58());
        }
        if (byUri.size === 0) return;
        setRows((prev) =>
          prev.map((r) =>
            byUri.has(r.uri) ? { ...r, actualPayerWallet: byUri.get(r.uri) ?? "" } : r,
          ),
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[Veil audit-grant] lock enrichment failed:", err);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (!r.ok) return true; // surface failures regardless of filters
      if (payerQuery.trim().length > 0) {
        if (!r.payer.toLowerCase().includes(payerQuery.trim().toLowerCase())) {
          return false;
        }
      }
      const dateOnly = r.date.slice(0, 10);
      if (fromDate && dateOnly < fromDate) return false;
      if (toDate && dateOnly > toDate) return false;
      return true;
    });
  }, [rows, fromDate, toDate, payerQuery]);

  function exportCsv() {
    const header = ["invoice_id", "created_at", "payer", "payer_wallet", "actual_payer_wallet", "amount_raw", "amount_display", "symbol", "memo"];
    const lines = [header.join(",")];
    for (const r of filteredRows) {
      if (!r.ok) continue;
      lines.push(
        [
          csvCell(r.invoiceId),
          csvCell(r.date),
          csvCell(r.payer),
          csvCell(r.payerWallet),
          csvCell(r.actualPayerWallet ?? ""),
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
    a.download = `veil-audit-${grantId || "grant"}.csv`;
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
            Scoped audit grant
          </h1>
          <p className="mt-5 text-[14.5px] leading-[1.6] text-ink/70 max-w-2xl">
            Grant <span className="font-mono text-ink">{grantId || "—"}</span>
            {decryptedAt ? (
              <>
                <span className="mx-2 text-line-2">·</span>
                Decrypted at <span className="font-mono text-ink">{decryptedAt}</span>
              </>
            ) : null}
          </p>

          {/* First-time intro — surfaces the two things a cold accountant
              needs to know in 10 seconds: (1) the URL itself is the
              credential, no wallet required to read; (2) what's actually
              in scope is enforced by the granter, not displayed to them
              by Veil. The fragment-key model is described in plain prose
              rather than crypto jargon. */}
          <p className="mt-4 text-[13.5px] leading-[1.65] text-muted max-w-2xl">
            You&apos;re reading a private invoice ledger that was shared with
            you by the issuer. Decryption happens locally in your browser
            using a key carried in this URL —{" "}
            <span className="text-ink">no wallet connection is required</span>.
            Connecting one is optional and doesn&apos;t change what you can
            see.
          </p>
        </div>

        {/* "Your scope" banner — derived from the decrypted invoices once
            we have them, since the URL fragment intentionally doesn't
            carry mint/date scope (it carries the per-grant key + the
            URI list). Until rows are ready, render a quiet placeholder. */}
        <ScopeBanner rows={rows} status={status} />

        <StatusBanner
          status={status}
          denyReason={denyReason}
          decryptedCount={rows.filter((r) => r.ok).length}
          totalCount={rows.length}
        />

        {status === "ready" && rows.length > 0 && (
          <>
            <FilterBar
              fromDate={fromDate}
              toDate={toDate}
              payerQuery={payerQuery}
              onFromChange={setFromDate}
              onToChange={setToDate}
              onPayerChange={setPayerQuery}
              onExport={exportCsv}
            />
            <InvoiceTable rows={filteredRows} />
          </>
        )}

        <p className="mt-8 max-w-2xl font-mono text-[12px] text-muted leading-relaxed">
          This URL carries an ephemeral decryption key in its fragment. Anyone
          who has this URL can read the listed invoices forever — they live
          on Arweave, which is permanent. Treat the link itself as the secret.
          Out-of-scope invoices are unreachable from this link.
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
      actualPayerWallet: "",
      invoicePda: e.invoicePda ?? undefined,
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
    actualPayerWallet: "",
    invoicePda: e.invoicePda ?? undefined,
    ok: true,
    error: null,
  };
}

/**
 * Render a base58 pubkey as a compact `7onP…JbDs` (4 + ellipsis + 4) so the
 * column stays narrow while still being skimmable. Returns "—" for empty
 * input. We avoid styling cues here — the renderer wraps the result in a
 * font-mono span so it visually parallels the metadata `payer_wallet`
 * column without introducing a new visual register.
 */
function truncatePubkey(pk: string): string {
  if (!pk) return "—";
  if (pk.length <= 10) return pk;
  return `${pk.slice(0, 4)}…${pk.slice(-4)}`;
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

function ScopeBanner({
  rows,
  status,
}: {
  rows: AuditRow[];
  status: LoadStatus;
}) {
  // Only render once we've successfully decrypted at least one row. Before
  // that the eyebrow + intro paragraph already orients the reader; the
  // scope banner would only mislead with placeholder dashes.
  if (status !== "ready") return null;
  const ok = rows.filter((r) => r.ok);
  if (ok.length === 0) return null;

  // Date range — min/max of ISO created_at strings (lexicographic
  // comparison is correct for ISO 8601 dates).
  const dates = ok.map((r) => r.date.slice(0, 10)).sort();
  const fromDate = dates[0];
  const toDate = dates[dates.length - 1];

  // Distinct currency symbols. Most grants will be a single mint; we
  // surface up to two by name and collapse the rest into "+N more".
  const symbols = Array.from(
    new Set(ok.map((r) => r.symbol).filter((s) => s && s.length > 0)),
  );
  const symbolsLabel =
    symbols.length === 0
      ? "—"
      : symbols.length <= 2
        ? symbols.join(" · ")
        : `${symbols.slice(0, 2).join(" · ")} +${symbols.length - 2}`;

  return (
    <div className="mb-8 border border-line rounded-[3px] bg-paper-3/60 max-w-2xl">
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-line">
        <span className="h-1 w-1 rounded-full bg-sage" aria-hidden />
        <span className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-muted">
          Your scope
        </span>
      </div>
      <dl className="grid grid-cols-3 divide-x divide-line">
        <ScopeCell label="Date range" value={`${fromDate} → ${toDate}`} mono />
        <ScopeCell
          label="Invoices"
          value={`${ok.length} of ${rows.length}`}
          mono
        />
        <ScopeCell label="Currency" value={symbolsLabel} mono />
      </dl>
    </div>
  );
}

function ScopeCell({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5 px-4 py-3">
      <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
        {label}
      </span>
      <span
        className={`text-[13px] text-ink truncate ${
          mono ? "font-mono tnum" : "font-sans"
        }`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

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
  // ready
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

function FilterBar({
  fromDate,
  toDate,
  payerQuery,
  onFromChange,
  onToChange,
  onPayerChange,
  onExport,
}: {
  fromDate: string;
  toDate: string;
  payerQuery: string;
  onFromChange: (v: string) => void;
  onToChange: (v: string) => void;
  onPayerChange: (v: string) => void;
  onExport: () => void;
}) {
  return (
    <div className="mb-10 border border-line rounded-[3px] p-4 flex flex-wrap items-end gap-x-6 gap-y-4">
      <div className="flex flex-col gap-1.5">
        <label className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-muted">
          From
        </label>
        <input
          type="date"
          value={fromDate}
          onChange={(e) => onFromChange(e.target.value)}
          className="bg-paper-3 border border-line rounded-[3px] px-3 py-2 font-mono text-[12.5px] text-ink focus:outline-none focus:border-ink"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-muted">
          To
        </label>
        <input
          type="date"
          value={toDate}
          onChange={(e) => onToChange(e.target.value)}
          className="bg-paper-3 border border-line rounded-[3px] px-3 py-2 font-mono text-[12.5px] text-ink focus:outline-none focus:border-ink"
        />
      </div>
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

function InvoiceTable({ rows }: { rows: AuditRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="border border-line rounded-[4px] py-12 text-center">
        <p className="text-[13.5px] text-muted">No invoices match the current filters.</p>
      </div>
    );
  }

  return (
    <div className="border border-line rounded-[4px] overflow-hidden">
      <div className="grid grid-cols-[160px_1fr_140px_140px_180px_140px] gap-4 px-5 md:px-6 py-3 border-b border-line bg-paper-3">
        {["Date", "Payer", "Actual payer (on-chain)", "Amount", "Memo", "Status"].map((h) => (
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
            className="grid grid-cols-[160px_1fr_140px_140px_180px_140px] gap-4 px-5 md:px-6 py-4 items-center"
          >
            <div className="font-mono text-[11px] text-dim tnum">
              {r.ok ? r.date.slice(0, 19).replace("T", " ") : "—"}
            </div>
            <div className="font-mono text-[12px] text-ink truncate">
              {r.ok ? r.payer : "(failed)"}
            </div>
            <div
              className="font-mono text-[11px] text-ink truncate"
              title={r.actualPayerWallet || undefined}
            >
              {truncatePubkey(r.actualPayerWallet ?? "")}
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
