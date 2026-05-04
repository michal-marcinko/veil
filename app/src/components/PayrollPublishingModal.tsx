"use client";

/**
 * Full-screen overlay shown during the payroll run + receipt-signing
 * flow. Mirrors `PublishingModal` (used by /create invoice) so the two
 * publish gestures feel like one continuous surface across modes.
 *
 * Two parent steps:
 *  1. Send batch — N private payments. Has a sub-progress counter
 *     (sentCount / totalCount). Status flips to "in_progress" while
 *     payments are firing and "done" once all are settled.
 *  2. Sign receipt packet — final wallet popup. The signed JSON +
 *     signed PDF kick off automatically once the packet is signed.
 *
 * Z-index 40 (above the canvas bar's z-30, below the registration
 * modal's z-50). Stays on screen continuously through every Phantom
 * popup so the employer never wonders "did it go through?"
 */

interface Props {
  open: boolean;
  totalCount: number;
  sentCount: number;
  phase: "sending" | "signing";
  awaitingWallet: boolean;
}

type StepStatus = "pending" | "in_progress" | "done";

export function PayrollPublishingModal({
  open,
  totalCount,
  sentCount,
  phase,
  awaitingWallet,
}: Props) {
  if (!open) return null;

  const sendStatus: StepStatus =
    phase === "sending" ? "in_progress" : sentCount >= totalCount ? "done" : "in_progress";
  const signStatus: StepStatus =
    phase === "signing" ? "in_progress" : sendStatus === "done" ? "pending" : "pending";

  const sendingLabel =
    sentCount === 0
      ? "Preparing batch…"
      : sentCount >= totalCount
        ? `${totalCount} of ${totalCount} payments settled`
        : `Sending payment ${sentCount + 1} of ${totalCount}`;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center p-4"
      role="status"
      aria-live="polite"
      aria-label="Running private payroll"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm" />

      {/* Dialog */}
      <div
        className="relative w-full max-w-lg bg-paper-3 border border-line rounded-[4px] p-8 md:p-10 animate-fade-up"
        style={{ boxShadow: "0 30px 80px -24px rgba(26,24,20,0.35)" }}
      >
        {/* Corner meta */}
        <div className="flex items-baseline justify-between mb-6">
          <span className="eyebrow">
            Running payroll · {totalCount} payment{totalCount === 1 ? "" : "s"}
          </span>
          <span className="eyebrow">Veil</span>
        </div>

        {/* Title */}
        <div>
          <h2 className="font-sans font-medium text-ink text-[26px] md:text-[30px] tracking-[-0.02em] leading-[1.1]">
            Sending {totalCount} private payment{totalCount === 1 ? "" : "s"}
          </h2>
          <p className="text-muted mt-4 text-[13.5px] leading-[1.55] max-w-md">
            Each payment runs through Umbra. Stay on this tab — you&apos;ll get
            a receipt packet to share with your accountant when it&apos;s done.
          </p>
        </div>

        {/* Steps */}
        <ol className="mt-10 space-y-6">
          <StepRow
            index={1}
            title="Send batch"
            status={sendStatus}
            awaitingWallet={awaitingWallet && phase === "sending"}
          >
            <div className="text-[12.5px] text-muted mt-1 font-sans leading-[1.5]">
              {sendingLabel}
            </div>
            {totalCount > 0 && (
              <ProgressBar value={sentCount} max={totalCount} />
            )}
          </StepRow>

          <StepRow
            index={2}
            title="Sign receipt packet"
            status={signStatus}
            awaitingWallet={awaitingWallet && phase === "signing"}
          >
            <div className="text-[12.5px] text-muted mt-1 font-sans leading-[1.5]">
              One signature commits the batch to a JSON + PDF you can share
              with your accountant or per-row with each contractor.
            </div>
          </StepRow>
        </ol>
      </div>
    </div>
  );
}

function StepRow({
  index,
  title,
  status,
  awaitingWallet,
  children,
}: {
  index: number;
  title: string;
  status: StepStatus;
  awaitingWallet: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className="grid grid-cols-[auto_1fr_auto] gap-5 items-start">
      <span
        className={`font-mono text-[12px] tabular-nums pt-0.5 transition-colors duration-300 ${
          status === "done"
            ? "text-gold"
            : status === "in_progress"
              ? "text-ink"
              : "text-dim"
        }`}
      >
        {String(index).padStart(2, "0")}
      </span>
      <div>
        <div
          className={`font-sans font-medium text-[15.5px] md:text-[16px] tracking-[-0.01em] leading-tight transition-colors duration-300 ${
            status === "done" ? "text-muted" : "text-ink"
          }`}
        >
          {title}
        </div>
        {children}
        {awaitingWallet && (
          <div className="mt-2 font-mono text-[10.5px] tracking-[0.16em] uppercase text-gold">
            Waiting on wallet
          </div>
        )}
      </div>
      <StatusGlyph status={status} />
    </li>
  );
}

function StatusGlyph({ status }: { status: StepStatus }) {
  if (status === "done") {
    return <span className="font-mono text-gold pt-1">✓</span>;
  }
  if (status === "in_progress") {
    return (
      <span className="pt-2 inline-block h-2 w-2 rounded-full bg-gold animate-slow-pulse" />
    );
  }
  return <span className="pt-2 inline-block h-2 w-2 rounded-full border border-line-2" />;
}

function ProgressBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div
      className="mt-3 h-1 w-full bg-line/60 rounded-full overflow-hidden"
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
    >
      <div
        className="h-full bg-gold transition-[width] duration-500 ease-out"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
