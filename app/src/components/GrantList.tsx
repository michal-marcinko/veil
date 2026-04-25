"use client";

import type { GrantWithStatus } from "@/lib/umbra";

interface Props {
  grants: GrantWithStatus[];
  onRevoke: (grant: GrantWithStatus) => void | Promise<void>;
  /** `${receiverX25519Base58}:${nonce}` of the grant currently being revoked, or null. */
  revokingKey: string | null;
}

export function GrantList({ grants, onRevoke, revokingKey }: Props) {
  if (grants.length === 0) {
    return (
      <div className="border border-dashed border-line rounded-[4px] p-8 text-center">
        <p className="text-[14px] text-muted">No grants yet.</p>
        <p className="text-[12px] text-dim mt-1">
          Issue a grant using the form above — it will appear here after confirmation.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-baseline justify-between mb-4">
        <span className="eyebrow">Issued grants</span>
        <span className="font-mono text-[11px] text-dim tnum">
          {String(grants.length).padStart(2, "0")}
        </span>
      </div>
      <ul className="border border-line rounded-[4px] bg-paper-3 divide-y divide-line">
        {grants.map((g) => {
          const key = `${g.receiverX25519Base58}:${g.nonce}`;
          const isRevoking = revokingKey === key;
          return (
            <li
              key={key}
              className="grid grid-cols-12 items-center gap-4 px-5 md:px-6 py-4"
            >
              <div className="col-span-4 min-w-0">
                <div className="mono-chip mb-1">Receiver</div>
                <div className="font-mono text-[13px] text-ink truncate">
                  {truncate(g.receiverAddress)}
                </div>
              </div>
              <div className="col-span-3 font-mono text-[12px] text-muted tnum break-all">
                {g.nonce}
              </div>
              <div className="col-span-2 font-mono text-[11px] text-dim tnum">
                {formatDate(g.issuedAt)}
              </div>
              <div className="col-span-1">
                <StatusPill status={g.status} />
              </div>
              <div className="col-span-2 text-right">
                <button
                  type="button"
                  onClick={() => onRevoke(g)}
                  disabled={g.status !== "active" || isRevoking}
                  className="btn-quiet text-[12px] disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isRevoking ? "Revoking…" : "Revoke"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function truncate(addr: string): string {
  if (addr.length <= 8) return addr;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

function StatusPill({ status }: { status: "active" | "revoked" | "unknown" }) {
  const styles: Record<string, string> = {
    active: "border-sage/40 text-sage bg-sage/5",
    revoked: "border-line-2 text-muted bg-paper-2/40",
    unknown: "border-gold/40 text-gold bg-gold/5",
  };
  return (
    <span
      className={`inline-block px-2 py-0.5 border rounded-[2px] font-mono text-[10px] tracking-[0.12em] uppercase ${styles[status]}`}
    >
      {status}
    </span>
  );
}
