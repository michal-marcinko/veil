"use client";

import Link from "next/link";

interface DashboardInvoice {
  pda: string;
  creator: string;
  metadataUri: string;
  status: "Pending" | "Paid" | "Cancelled" | "Expired";
  createdAt: number;
}

export function DashboardList({
  title,
  invoices,
}: {
  title: string;
  invoices: DashboardInvoice[];
}) {
  if (invoices.length === 0) {
    return (
      <div>
        <div className="flex items-baseline justify-between mb-4">
          <span className="eyebrow">{title}</span>
          <span className="font-mono text-[11px] text-dim tnum">0</span>
        </div>
        <div className="border border-dashed border-line rounded-[4px] p-10 text-center">
          <p className="text-[14px] text-muted">No invoices yet.</p>
          <a href="/create" className="mt-3 inline-block btn-quiet">
            Create your first invoice →
          </a>
        </div>
      </div>
    );
  }
  return (
    <div>
      <div className="flex items-baseline justify-between mb-4">
        <span className="eyebrow">{title}</span>
        <span className="font-mono text-[11px] text-dim tnum">
          {String(invoices.length).padStart(2, "0")}
        </span>
      </div>
      <ul className="border border-line rounded-[4px] bg-paper-3 divide-y divide-line">
        {invoices.map((inv) => (
          <li key={inv.pda}>
            <Link
              href={`/invoice/${inv.pda}`}
              className="flex items-center justify-between gap-6 px-5 md:px-6 py-4 hover:bg-paper-2/40 transition-colors cursor-pointer"
              aria-label={`Open invoice ${inv.pda}`}
            >
              <div className="flex items-baseline gap-5 min-w-0">
                <span className="font-mono text-[11px] text-dim tnum shrink-0">
                  {formatDate(inv.createdAt)}
                </span>
                <span className="font-mono text-[13px] text-ink truncate">
                  {inv.pda.slice(0, 8)}…{inv.pda.slice(-4)}
                </span>
              </div>
              <StatusBadge status={inv.status} />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    Pending: "border-gold/40 text-gold bg-gold/5",
    Paid: "border-sage/40 text-sage bg-sage/5",
    Cancelled: "border-line-2 text-muted bg-paper-2/40",
    Expired: "border-brick/40 text-brick bg-brick/5",
  };
  return (
    <span
      className={`inline-block px-2.5 py-1 border rounded-[2px] font-mono text-[10.5px] tracking-[0.12em] uppercase ${styles[status] ?? ""}`}
    >
      {status}
    </span>
  );
}

function formatDate(ts: number): string {
  const d = new Date(ts * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}
