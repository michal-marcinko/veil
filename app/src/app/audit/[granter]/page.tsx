"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { VeilLogo } from "@/components/VeilLogo";
import { fetchInvoicesByCreator, type NormalizedInvoice } from "@/lib/anchor";
import { decryptInvoicesForAudit, decodeAuditPackage } from "@/lib/umbra-auditor";
import type { InvoiceMetadata } from "@/lib/types";
import { explorerAddressUrl } from "@/lib/explorer";

// ─────────────────────────────────────────────────────────────────────
// Types — invoice-shaped audit timeline (was UTXO-shaped mock).
// ─────────────────────────────────────────────────────────────────────

type GrantStatus = "verifying" | "authorized" | "denied";

type InvoiceStatus = "Pending" | "Paid" | "Cancelled" | "Expired";

type StatusFilter = "all" | InvoiceStatus;

interface InvoiceEntry {
  id: string;             // PDA, doubles as React key
  createdAt: string;      // "2026-04-15 14:23 UTC"
  payer: string;          // metadata.payer.display_name (or "—")
  amount: string;         // "4,200.0000 USDC" (or "—")
  status: InvoiceStatus;
  invoicePda: string;     // base58
  metadataUri: string;
}

// ─────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────

export default function AuditPage() {
  const params = useParams();
  const wallet = useWallet();
  const granterParam = typeof params.granter === "string" ? params.granter : "";

  const [grantStatus, setGrantStatus] = useState<GrantStatus>("verifying");
  const [deniedReason, setDeniedReason] = useState<string | null>(null);
  const [grantedDateDisplay, setGrantedDateDisplay] = useState<string | null>(null);

  const [entries, setEntries] = useState<InvoiceEntry[]>([]);

  // Filter state — front-end only, doesn't crypto-restrict.
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [payerQuery, setPayerQuery] = useState("");

  const granterDisplay = useMemo(() => truncate(granterParam, 6), [granterParam]);
  const auditorDisplay = useMemo(
    () => (wallet.publicKey ? truncate(wallet.publicKey.toBase58(), 6) : ""),
    [wallet.publicKey],
  );

  // Load invoices + decrypt with the master sig from the URL fragment.
  // No wallet signature required — chain reads use a granter-shaped wrapper
  // (publicKey only) and the decryption material lives in the URL.
  useEffect(() => {
    let cancelled = false;
    async function run() {
      // 1. Read fragment — must be present and decodable to 64 bytes.
      const hash =
        typeof window !== "undefined" ? window.location.hash : "";
      let masterSig: Uint8Array;
      try {
        if (!hash || hash === "#") {
          if (!cancelled) {
            setGrantStatus("denied");
            setDeniedReason("Audit URL is missing the decryption package.");
          }
          return;
        }
        masterSig = decodeAuditPackage(hash);
      } catch {
        if (!cancelled) {
          setGrantStatus("denied");
          setDeniedReason("Audit URL is missing the decryption package.");
        }
        return;
      }

      // 2. Validate granter param as a real Solana pubkey.
      let granterPk: PublicKey;
      try {
        granterPk = new PublicKey(granterParam);
      } catch {
        if (!cancelled) {
          setGrantStatus("denied");
          setDeniedReason("Granter address is not a valid Solana wallet.");
        }
        return;
      }

      // 3. Read all of Alice's invoices on-chain. fetchInvoicesByCreator
      //    only needs `wallet.publicKey` for read-paths — pass a stub.
      let invoices: Array<{ publicKey: PublicKey; account: NormalizedInvoice }>;
      try {
        invoices = await fetchInvoicesByCreator(
          { publicKey: granterPk } as any,
          granterPk,
        );
      } catch (err: any) {
        if (!cancelled) {
          setGrantStatus("denied");
          setDeniedReason(
            `Failed to load invoices: ${err?.message ?? String(err)}`,
          );
        }
        return;
      }

      if (invoices.length === 0) {
        if (!cancelled) {
          setGrantStatus("denied");
          setDeniedReason("Granter has no invoices on-chain.");
        }
        return;
      }

      // 4. Decrypt every decryptable invoice in parallel. Failures (legacy
      //    per-PDA signMessage keys, fetch blips) drop out of the map.
      const decrypted = await decryptInvoicesForAudit({
        invoices,
        masterSig,
      });

      if (cancelled) return;

      const rows: InvoiceEntry[] = invoices.map((inv) => {
        const pda = inv.publicKey.toBase58();
        const md = decrypted.get(pda);
        return {
          id: pda,
          createdAt: formatUnixTimestamp(inv.account.createdAt),
          payer: md?.payer?.display_name || "—",
          amount: md
            ? formatAmount(
                BigInt(md.total),
                md.currency?.decimals ?? 0,
                md.currency?.symbol ?? "",
              )
            : "—",
          status: deriveInvoiceStatus(inv.account),
          invoicePda: pda,
          metadataUri: inv.account.metadataUri,
        };
      });

      // Newest first — invoices sorted by on-chain createdAt descending.
      rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

      setEntries(rows);

      // 5. Authorization gate: at least one invoice decrypted means the
      //    fragment matches Alice's master sig and the grant is real.
      if (decrypted.size === 0) {
        setGrantStatus("denied");
        setDeniedReason(
          "Audit URL did not decrypt any invoices for this granter.",
        );
        return;
      }

      setGrantStatus("authorized");
      // Use the oldest invoice's createdAt as a proxy for "granted on" —
      // the on-chain grant doesn't carry its own timestamp client-side.
      const oldest = invoices.reduce(
        (acc, inv) =>
          acc == null || inv.account.createdAt < acc
            ? inv.account.createdAt
            : acc,
        null as number | null,
      );
      if (oldest != null) {
        setGrantedDateDisplay(formatUnixTimestamp(oldest).slice(0, 10));
      }
    }

    if (wallet.connected) void run();
    return () => {
      cancelled = true;
    };
  }, [granterParam, wallet.connected]);

  const filteredEntries = useMemo(() => {
    return entries.filter((e) => {
      if (statusFilter !== "all" && e.status !== statusFilter) return false;
      if (payerQuery.trim().length > 0) {
        if (!e.payer.toLowerCase().includes(payerQuery.trim().toLowerCase())) {
          return false;
        }
      }
      const dateOnly = e.createdAt.slice(0, 10);
      if (fromDate && dateOnly < fromDate) return false;
      if (toDate && dateOnly > toDate) return false;
      return true;
    });
  }, [entries, statusFilter, payerQuery, fromDate, toDate]);

  // ─── Disconnected state ───────────────────────────────────────────
  if (!wallet.connected) {
    return (
      <Shell>
        <div className="max-w-lg mx-auto pt-12 reveal text-center">
          <span className="eyebrow">Audit access</span>
          <h1 className="mt-4 font-sans font-medium text-ink text-[40px] md:text-[52px] leading-[1.05] tracking-[-0.03em]">
            Connect to view audit access.
          </h1>
          <p className="mt-6 text-[15px] leading-[1.6] text-ink/70 max-w-md mx-auto">
            Audit grants are scoped per-wallet. Connect the wallet that holds the
            grant from this granter to verify your access and decrypt their
            on-chain invoice history.
          </p>
          <div className="mt-10 flex justify-center">
            <ClientWalletMultiButton />
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="reveal">
        {/* ─── Section 1: Header ───────────────────────────────── */}
        <div className="mb-10">
          <span className="eyebrow">Audit access</span>
          <h1 className="mt-3 font-sans font-medium text-ink text-[40px] md:text-[52px] leading-[1.05] tracking-[-0.03em]">
            Audit access
          </h1>
          <p className="mt-5 text-[14.5px] leading-[1.6] text-ink/70 max-w-2xl">
            Granter <span className="font-mono text-ink">{granterDisplay}</span>
            <span className="mx-2 text-line-2">·</span>
            Verifying as <span className="font-mono text-ink">{auditorDisplay}</span>
          </p>
        </div>

        {/* ─── Section 2: Status banner ────────────────────────── */}
        <StatusBanner
          status={grantStatus}
          deniedReason={deniedReason}
          grantedDateDisplay={grantedDateDisplay}
        />

        {/* ─── Section 3 + 4: filter + timeline (skip when denied) ── */}
        {grantStatus !== "denied" && (
          <>
            <FilterBar
              fromDate={fromDate}
              toDate={toDate}
              statusFilter={statusFilter}
              payerQuery={payerQuery}
              onFromChange={setFromDate}
              onToChange={setToDate}
              onStatusChange={setStatusFilter}
              onPayerChange={setPayerQuery}
            />
            <InvoiceTimeline entries={filteredEntries} />
          </>
        )}

        {/* ─── Section 5: Footer disclosure ────────────────────── */}
        <p className="mt-8 max-w-2xl font-mono text-[12px] text-muted leading-relaxed">
          Decryption material was delivered to you out-of-band by the granter.
          The on-chain grant for this granter ↔ your wallet pair authorizes
          you to view this data; revoking the grant prevents <em>future</em>{" "}
          invoice access but does not retroactively un-share what&apos;s
          already been decrypted.
        </p>
      </div>
    </Shell>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Status banner
// ─────────────────────────────────────────────────────────────────────

function StatusBanner({
  status,
  deniedReason,
  grantedDateDisplay,
}: {
  status: GrantStatus;
  deniedReason: string | null;
  grantedDateDisplay: string | null;
}) {
  if (status === "verifying") {
    return (
      <div className="mb-10 flex items-start gap-4 border-l-2 border-gold pl-5 py-3 max-w-2xl">
        <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-gold animate-pulse shrink-0" />
        <div>
          <div className="mono-chip text-gold mb-1">Verifying</div>
          <div className="text-[14px] text-ink leading-relaxed">
            Verifying authorization…
          </div>
        </div>
      </div>
    );
  }
  if (status === "authorized") {
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
          <div className="mono-chip text-sage mb-1">Authorized</div>
          <div className="text-[14px] text-ink leading-relaxed">
            {grantedDateDisplay
              ? `Granted on ${grantedDateDisplay}`
              : "Decryption package valid"}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="mb-10 flex items-start gap-4 border-l-2 border-brick pl-5 py-3 max-w-2xl">
      <div>
        <div className="mono-chip text-brick mb-1">No grant</div>
        <div className="text-[14px] text-ink leading-relaxed">
          {deniedReason ??
            "No active grant — your wallet does not hold a compliance grant from this granter."}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Filter bar
// ─────────────────────────────────────────────────────────────────────

function FilterBar({
  fromDate,
  toDate,
  statusFilter,
  payerQuery,
  onFromChange,
  onToChange,
  onStatusChange,
  onPayerChange,
}: {
  fromDate: string;
  toDate: string;
  statusFilter: StatusFilter;
  payerQuery: string;
  onFromChange: (v: string) => void;
  onToChange: (v: string) => void;
  onStatusChange: (v: StatusFilter) => void;
  onPayerChange: (v: string) => void;
}) {
  const statuses: { key: StatusFilter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "Pending", label: "Pending" },
    { key: "Paid", label: "Paid" },
    { key: "Cancelled", label: "Cancelled" },
    { key: "Expired", label: "Expired" },
  ];

  return (
    <div className="mb-10 border border-line rounded-[3px] p-4 flex flex-wrap items-end gap-x-6 gap-y-4">
      {/* Date range */}
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="audit-from"
          className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-muted"
        >
          From
        </label>
        <input
          id="audit-from"
          type="date"
          value={fromDate}
          onChange={(e) => onFromChange(e.target.value)}
          className="bg-paper-3 border border-line rounded-[3px] px-3 py-2 font-mono text-[12.5px] text-ink focus:outline-none focus:border-ink"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="audit-to"
          className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-muted"
        >
          To
        </label>
        <input
          id="audit-to"
          type="date"
          value={toDate}
          onChange={(e) => onToChange(e.target.value)}
          className="bg-paper-3 border border-line rounded-[3px] px-3 py-2 font-mono text-[12.5px] text-ink focus:outline-none focus:border-ink"
        />
      </div>

      {/* Status pills */}
      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-muted">
          Status
        </span>
        <div className="flex items-center gap-1 border border-line rounded-[3px] p-0.5 bg-paper-3">
          {statuses.map((d) => {
            const active = statusFilter === d.key;
            return (
              <button
                key={d.key}
                type="button"
                onClick={() => onStatusChange(d.key)}
                className={
                  "px-3 py-1.5 rounded-[2px] font-mono text-[11px] tracking-[0.12em] uppercase transition-colors " +
                  (active ? "bg-ink text-paper" : "text-muted hover:text-ink")
                }
              >
                {d.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Payer search */}
      <div className="flex flex-col gap-1.5 flex-1 min-w-[220px]">
        <label
          htmlFor="audit-payer"
          className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-muted"
        >
          Payer
        </label>
        <input
          id="audit-payer"
          type="text"
          value={payerQuery}
          onChange={(e) => onPayerChange(e.target.value)}
          placeholder="Filter by payer name…"
          className="bg-paper-3 border border-line rounded-[3px] px-3 py-2 font-mono text-[12.5px] text-ink placeholder:text-dim/80 focus:outline-none focus:border-ink"
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Invoice timeline
// ─────────────────────────────────────────────────────────────────────

function InvoiceTimeline({ entries }: { entries: InvoiceEntry[] }) {
  if (entries.length === 0) {
    return (
      <div className="border border-line rounded-[4px] py-12 text-center">
        <p className="text-[13.5px] text-muted">
          No invoices match the current filters.
        </p>
      </div>
    );
  }

  return (
    <ul className="border border-line rounded-[4px] divide-y divide-line">
      {entries.map((entry) => (
        <li
          key={entry.id}
          className="px-5 md:px-6 py-4 flex items-center gap-5 flex-wrap md:flex-nowrap"
        >
          {/* Date */}
          <div className="font-mono text-[11px] text-dim tnum w-[140px] shrink-0">
            {entry.createdAt}
          </div>

          {/* Status pill */}
          <div className="w-[110px] shrink-0">
            <StatusLabel status={entry.status} />
          </div>

          {/* Amount */}
          <div className="font-sans tnum font-medium text-ink text-[16px] flex-1 min-w-[120px]">
            {entry.amount}
          </div>

          {/* Payer */}
          <div className="font-mono text-[12px] text-muted w-[160px] shrink-0 truncate">
            {entry.payer}
          </div>

          {/* Invoice PDA → Solana Explorer link */}
          <div className="shrink-0">
            <a
              href={explorerAddressUrl(entry.invoicePda)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-mono text-[11px] tracking-[0.12em] uppercase text-muted hover:text-ink transition-colors"
              aria-label="View invoice account on Solana Explorer"
            >
              <span>Invoice</span>
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="none"
                aria-hidden
              >
                <path
                  d="M3 1h6v6M9 1L3.5 6.5M1 3v6h6"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </a>
          </div>
        </li>
      ))}
    </ul>
  );
}

function StatusLabel({ status }: { status: InvoiceStatus }) {
  const palette: Record<InvoiceStatus, string> = {
    Paid: "text-sage",
    Pending: "text-gold",
    Cancelled: "text-brick",
    Expired: "text-muted",
  };
  return (
    <span
      className={
        "inline-flex items-center gap-1.5 font-mono text-[11px] tracking-[0.12em] uppercase " +
        palette[status]
      }
    >
      {status}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Layout shell
// ─────────────────────────────────────────────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen relative pb-32">
      <nav className="sticky top-0 z-10 backdrop-blur-sm bg-paper/80 border-b border-line">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between px-6 md:px-8 py-4">
          <VeilLogo tagline="auditor view" />
          <ClientWalletMultiButton />
        </div>
      </nav>
      <section className="max-w-[1400px] mx-auto px-6 md:px-8 pt-16">
        {children}
      </section>
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function truncate(s: string, keep = 6): string {
  if (s.length <= keep * 2 + 1) return s;
  return `${s.slice(0, keep)}…${s.slice(-keep)}`;
}

function formatUnixTimestamp(unixSeconds: number): string {
  if (!unixSeconds || unixSeconds <= 0) return "—";
  const d = new Date(unixSeconds * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min} UTC`;
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
  // Add thousands separators to the whole part for readability.
  const wholeFormatted = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const numeric = padded ? `${wholeFormatted}.${padded}` : wholeFormatted;
  return symbol ? `${numeric} ${symbol}` : numeric;
}

/**
 * Map the on-chain `status` enum (Anchor returns it as `{ pending: {} }`,
 * `{ paid: {} }`, etc.) to a display string. Anything we don't recognize
 * collapses to "Pending" — the safe default for an unpaid invoice.
 */
function deriveInvoiceStatus(
  account: { status: Record<string, unknown> },
): InvoiceStatus {
  const keys = Object.keys(account.status ?? {});
  const k = keys[0]?.toLowerCase() ?? "";
  if (k === "paid") return "Paid";
  if (k === "cancelled" || k === "canceled") return "Cancelled";
  if (k === "expired") return "Expired";
  return "Pending";
}
