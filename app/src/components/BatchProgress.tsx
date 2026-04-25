"use client";

export type BatchStepStatus = "pending" | "in_progress" | "done" | "error";

export interface BatchStep {
  wallet: string;
  amount: string;
  status: BatchStepStatus;
  error?: string | null;
  payUrl?: string | null;
}

interface Props {
  steps: BatchStep[];
  symbol: string;
}

export function BatchProgress({ steps, symbol }: Props) {
  const done = steps.filter((s) => s.status === "done").length;
  const total = steps.length;
  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between border-b border-line pb-3">
        <span className="eyebrow">Batch progress</span>
        <span className="font-mono text-[13px] tabular-nums text-ink">
          {done}/{total}
        </span>
      </div>
      <ol className="space-y-2">
        {steps.map((s, i) => (
          <li
            key={i}
            className="grid grid-cols-[1.75rem_auto_1fr_auto] gap-4 items-baseline py-2 border-b border-line/60"
          >
            <span className="font-mono text-[11px] text-dim tabular-nums">
              {String(i + 1).padStart(2, "0")}
            </span>
            <StatusIcon status={s.status} />
            <span className="font-mono text-[13px] text-ink truncate">
              {truncateWallet(s.wallet)} · {s.amount} {symbol}
              {s.error && (
                <span className="ml-3 text-brick text-[12px]">{s.error}</span>
              )}
            </span>
            <span className="font-mono text-[11px] text-dim uppercase tracking-[0.12em]">
              {labelFor(s.status)}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function StatusIcon({ status }: { status: BatchStepStatus }) {
  if (status === "done") {
    return <span className="text-sage font-mono text-[13px]">✓</span>;
  }
  if (status === "error") {
    return <span className="text-brick font-mono text-[13px]">×</span>;
  }
  if (status === "in_progress") {
    return (
      <span
        className="inline-block h-2 w-2 rounded-full bg-gold animate-slow-pulse"
        aria-label="in progress"
      />
    );
  }
  return <span className="inline-block h-2 w-2 rounded-full bg-line" aria-label="pending" />;
}

function labelFor(status: BatchStepStatus): string {
  switch (status) {
    case "pending":
      return "Queued";
    case "in_progress":
      return "Creating";
    case "done":
      return "Done";
    case "error":
      return "Failed";
  }
}

function truncateWallet(wallet: string): string {
  if (wallet.length <= 12) return wallet;
  return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
}
