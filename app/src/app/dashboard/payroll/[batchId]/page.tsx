// ---------------------------------------------------------------------------
// /dashboard/payroll/[batchId] — per-run drill-in.
//
// Loads the signed payroll packet from cross-device storage (Arweave-backed
// localStorage cache) and renders one row per recipient with:
//   - Recipient name + wallet (truncated, with copy-to-clipboard)
//   - Amount + mint
//   - Per-row status from the packet (Sent / Failed)
//   - Per-row actions (download payslip PDF with audit-mode toggle,
//     send compliance grant)
//
// Status-fidelity note: the signed packet records the SENDER side outcome
// (`status: "paid" | "failed"`). True "Claimed" status would require
// scanning Umbra's claimable-utxo queue per-recipient — too RPC-heavy
// for the hackathon timeline. We surface the sender's outcome and a
// "Recipient must claim via the URL emitted at run time" footnote so
// reviewers don't read this as a bug. v2 wires Umbra scanner here.
// ---------------------------------------------------------------------------
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { VeilLogo } from "@/components/VeilLogo";
import {
  loadCachedPayrollRuns,
  syncPayrollRunsFromArweave,
  type CachedPayrollRun,
} from "@/lib/payroll-runs-storage";
import type { PayrollPacketRow, SignedPayrollPacket } from "@/lib/private-payroll";
import { downloadPayslipPdf } from "@/lib/payslipPdf";
import { explorerAddressUrl, explorerTxUrl } from "@/lib/explorer";
import { NETWORK } from "@/lib/constants";

function formatAmount(units: string, decimals: number): string {
  const bn = BigInt(units);
  const divisor = BigInt(10) ** BigInt(decimals);
  const whole = bn / divisor;
  const fraction = bn % divisor;
  const display = Math.min(4, decimals);
  const padded = fraction.toString().padStart(decimals, "0").slice(0, display);
  const trimmed = padded.replace(/0+$/, "").padEnd(2, "0");
  return `${whole.toLocaleString("en-US")}.${trimmed}`;
}

function truncate(s: string, head = 6, tail = 6): string {
  if (s.length <= head + tail + 2) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function formatDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toISOString().slice(0, 10);
}

interface RowProps {
  row: PayrollPacketRow;
  rowIndex: number;
  packet: SignedPayrollPacket;
  walletBase58: string | null;
}

function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ml-2 text-[10px] text-dim hover:text-ink underline-offset-2 hover:underline"
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          // No clipboard access — silently no-op.
        }
      }}
    >
      {copied ? "copied" : label ?? "copy"}
    </button>
  );
}

function RecipientRow({ row, rowIndex, packet, walletBase58 }: RowProps) {
  const [auditMode, setAuditMode] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const statusLabel =
    row.status === "paid" ? "Sent" : "Failed";
  const statusColor =
    row.status === "paid" ? "text-sage" : "text-brick";

  const handleDownload = useCallback(async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      // Build a synthetic ReceivedPayment shape from the row data so we
      // can reuse the existing PayslipPdfDocument. Sender-side download
      // doesn't have a `withdrawSignature` (that's on the recipient when
      // they claim) — leave it undefined and the doc renders cleanly.
      const payment = {
        batchId: packet.packet.batchId,
        rowIndex,
        senderWallet: packet.packet.payer,
        senderDisplayName: "",
        amount: row.amount,
        amountDisplay: formatAmount(row.amount, packet.packet.decimals),
        symbol: packet.packet.symbol,
        mint: packet.packet.mint,
        memo: row.memo || null,
        claimSignature: row.txSignature ?? "",
        receivedAt: packet.packet.createdAt,
        mode: row.mode === "shielded" ? ("mixer" as const) : ("sweep" as const),
      };

      // Verify-token seed: hash of the canonical packet bytes for this row.
      // Without a real Invoice account, we fall back to a deterministic
      // 32-byte seed derived from batchId+rowIndex so a given row's audit
      // QR is stable across redownloads.
      const seedInput = new TextEncoder().encode(
        `${packet.packet.batchId}:${rowIndex}:${row.recipient}`,
      );
      const seedBuf = await crypto.subtle.digest("SHA-256", seedInput);
      const verifyTokenSeed = new Uint8Array(seedBuf);

      await downloadPayslipPdf(payment as any, {
        recipientWallet: row.recipient,
        recipientName: row.recipientName,
        network: NETWORK,
        auditMode,
        // Use the row's recipient pubkey as a synthetic "PDA" surface
        // for the verifier QR; v2 will plumb a real audit anchor.
        auditInvoicePda: row.recipient,
        verifyTokenSeed,
      });
    } finally {
      setDownloading(false);
    }
  }, [auditMode, downloading, packet, row, rowIndex]);

  return (
    <tr className="border-b border-line">
      <td className="py-3 pr-3 align-top">
        <div className="text-[13.5px] text-ink">
          {row.recipientName?.trim() || "—"}
        </div>
      </td>
      <td className="py-3 pr-3 align-top">
        <div className="text-[12px] font-mono text-ink">
          <a
            href={explorerAddressUrl(row.recipient)}
            target="_blank"
            rel="noreferrer"
            className="hover:text-sage underline-offset-2 hover:underline"
          >
            {truncate(row.recipient, 6, 6)}
          </a>
          <CopyButton value={row.recipient} />
        </div>
      </td>
      <td className="py-3 pr-3 align-top text-right">
        <div className="text-[13.5px] font-mono text-ink">
          {formatAmount(row.amount, packet.packet.decimals)} {packet.packet.symbol}
        </div>
      </td>
      <td className="py-3 pr-3 align-top">
        <div className={`text-[11px] font-mono uppercase tracking-[0.1em] ${statusColor}`}>
          {statusLabel}
        </div>
        {row.txSignature ? (
          <a
            href={explorerTxUrl(row.txSignature)}
            target="_blank"
            rel="noreferrer"
            className="block text-[10px] font-mono text-dim hover:text-ink underline-offset-2 hover:underline mt-1"
          >
            {truncate(row.txSignature, 6, 6)}
          </a>
        ) : null}
      </td>
      <td className="py-3 align-top">
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-1.5 text-[10.5px] text-dim cursor-pointer">
            <input
              type="checkbox"
              checked={auditMode}
              onChange={(e) => setAuditMode(e.target.checked)}
              className="accent-ink"
            />
            Audit details
          </label>
          <button
            onClick={handleDownload}
            disabled={downloading || row.status !== "paid"}
            className="text-[11.5px] text-ink underline-offset-2 hover:underline disabled:text-dim disabled:no-underline disabled:cursor-not-allowed text-left"
          >
            {downloading ? "Generating…" : "Download payslip PDF"}
          </button>
          {/*
            Per-row compliance grant from a payroll row is a v2 feature —
            payroll rows don't have an Invoice PDA today, and the
            compliance page is invoice-scoped. Surface an explanatory
            link to the compliance page (pre-fill skipped) so the user
            can manually pick invoices if they have any.
          */}
          <Link
            href="/dashboard/compliance"
            className="text-[11.5px] text-ink underline-offset-2 hover:underline"
          >
            Send compliance grant
          </Link>
        </div>
      </td>
    </tr>
  );
}

export default function PayrollDrillInPage() {
  const params = useParams();
  const router = useRouter();
  const wallet = useWallet();
  const batchId =
    typeof params?.batchId === "string"
      ? params.batchId
      : Array.isArray(params?.batchId)
        ? params.batchId[0]
        : "";

  const walletBase58 = wallet.publicKey?.toBase58() ?? null;
  const [runs, setRuns] = useState<CachedPayrollRun[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!walletBase58) {
      setRuns([]);
      setLoaded(true);
      return;
    }
    setRuns(loadCachedPayrollRuns(walletBase58));
    setLoaded(true);
    // Best-effort sync from Arweave so the drill-in works on a freshly-
    // connected device. Fire-and-forget.
    syncPayrollRunsFromArweave({ wallet, walletBase58 })
      .then(() => setRuns(loadCachedPayrollRuns(walletBase58)))
      .catch(() => {
        // Sync errors are surfaced from the dashboard; don't repeat them
        // here. The local cache is still useful for the drill-in.
      });
  }, [walletBase58, wallet]);

  const run = useMemo(
    () => runs.find((r) => r.signed.packet.batchId === batchId),
    [runs, batchId],
  );

  const totalUnits = useMemo(() => {
    if (!run) return 0n;
    return run.signed.packet.rows.reduce(
      (acc, r) => acc + (r.status === "paid" ? BigInt(r.amount) : 0n),
      0n,
    );
  }, [run]);

  const claimedCount = run
    ? run.signed.packet.rows.filter((r) => r.status === "paid").length
    : 0;

  return (
    <main className="min-h-screen relative pb-32">
      <nav className="sticky top-0 z-10 backdrop-blur-sm bg-paper/80 border-b border-line">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between px-6 md:px-8 py-4">
          <VeilLogo tagline="payroll run" />
          <div className="flex items-center gap-4">
            <button
              onClick={() => router.back()}
              className="text-[12.5px] text-muted hover:text-ink underline-offset-2 hover:underline"
            >
              ← Activity
            </button>
            <ClientWalletMultiButton />
          </div>
        </div>
      </nav>

      <section className="max-w-[1400px] mx-auto px-6 md:px-8 pt-12 md:pt-16">
        <div className="max-w-3xl">
          {!walletBase58 && (
            <div>
              <span className="eyebrow">Connect to view</span>
              <h1 className="mt-4 font-sans font-medium text-ink text-[28px] tracking-[-0.025em]">
                Connect a wallet to view this payroll run.
              </h1>
            </div>
          )}

          {walletBase58 && loaded && !run && (
            <div>
              <div className="border-l-2 border-brick pl-5 py-3">
                <div className="mono-chip text-brick mb-2">Run not found</div>
                <div className="text-[14.5px] text-ink leading-relaxed">
                  No payroll run with batch ID{" "}
                  <span className="font-mono">{batchId}</span> was found in this
                  wallet's history. The run may belong to a different wallet, or
                  it may not have synced from Arweave yet — try refreshing.
                </div>
              </div>
            </div>
          )}

          {walletBase58 && run && (
            <div>
              <span className="eyebrow">Payroll run</span>
              <h1 className="mt-4 font-sans font-medium text-ink text-[32px] md:text-[38px] leading-[1.05] tracking-[-0.025em]">
                {claimedCount} of {run.signed.packet.rows.length} sent
              </h1>

              <dl className="mt-8 grid grid-cols-3 gap-6 border-t border-line pt-6">
                <div>
                  <dt className="text-[11px] font-mono uppercase tracking-[0.12em] text-dim">
                    Total amount
                  </dt>
                  <dd className="mt-1 text-[16px] font-mono text-ink">
                    {formatAmount(totalUnits.toString(), run.signed.packet.decimals)}{" "}
                    {run.signed.packet.symbol}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] font-mono uppercase tracking-[0.12em] text-dim">
                    Run ID
                  </dt>
                  <dd className="mt-1 text-[12px] font-mono text-ink break-all">
                    {batchId}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] font-mono uppercase tracking-[0.12em] text-dim">
                    Sent
                  </dt>
                  <dd className="mt-1 text-[14px] text-ink">
                    {formatDate(run.signed.packet.createdAt)}
                  </dd>
                </div>
              </dl>

              <div className="mt-10 flex items-center justify-between">
                <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-dim">
                  Recipients
                </h2>
                {/*
                  v2: payroll-run-scoped compliance grant. Today the grant
                  flow is invoice-scoped; we surface a link to the picker
                  page rather than auto-pre-selecting (no invoice PDAs
                  attached to a payroll batch).
                */}
                <Link
                  href="/dashboard/compliance"
                  className="text-[12px] text-ink underline-offset-2 hover:underline"
                >
                  Send compliance grant for full run
                </Link>
              </div>

              <table className="mt-4 w-full text-left">
                <thead>
                  <tr className="text-[10.5px] font-mono uppercase tracking-[0.12em] text-dim border-b border-line">
                    <th className="py-2 pr-3 font-normal">Name</th>
                    <th className="py-2 pr-3 font-normal">Wallet</th>
                    <th className="py-2 pr-3 font-normal text-right">Amount</th>
                    <th className="py-2 pr-3 font-normal">Status</th>
                    <th className="py-2 font-normal">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {run.signed.packet.rows.map((row, idx) => (
                    <RecipientRow
                      key={idx}
                      row={row}
                      rowIndex={idx}
                      packet={run.signed}
                      walletBase58={walletBase58}
                    />
                  ))}
                </tbody>
              </table>

              <p className="mt-10 text-[11.5px] text-dim leading-relaxed max-w-2xl">
                Status reflects the sender-side outcome (the row's deposit /
                claim-link tx). True per-recipient claim status (whether the
                recipient has redeemed an unregistered claim link) requires
                an Umbra scanner pass and is on the v2 roadmap.
              </p>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
