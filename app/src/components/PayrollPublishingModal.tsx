"use client";

import { useEffect, useState } from "react";

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

/** Per-row Umbra sub-step. Drives the honest progress copy + decides
 *  whether "Waiting on wallet" is actually true. The slowest step is
 *  `register` (Umbra ZK proof + 3 sub-txs, can run 30–90s on devnet)
 *  and it does NOT have a wallet popup — the prior version of this
 *  modal lied about that for the entire run. */
export type RunSubStep = "fund" | "register" | "deposit" | "shielded" | "public" | null;

interface Props {
  open: boolean;
  totalCount: number;
  sentCount: number;
  phase: "sending" | "signing";
  /** Sub-step within the current row, when known. */
  subStep?: RunSubStep;
  /** 0-based row index currently being processed. */
  rowIndex?: number;
  /** External "did the user just sign?" hint. We OR this with our own
   *  per-sub-step truthiness, but for the slow ZK step we explicitly
   *  override to false because no wallet input is required. */
  awaitingWallet: boolean;
}

type StepStatus = "pending" | "in_progress" | "done";

export function PayrollPublishingModal({
  open,
  totalCount,
  sentCount,
  phase,
  subStep,
  rowIndex,
  awaitingWallet,
}: Props) {
  // Elapsed-time counter so the user can see the modal isn't frozen
  // during the slow ZK-proof step (which can run 30–90s with no other
  // visible signal). Reset on every transition: opening → 0, switching
  // sub-step (e.g. register → deposit) → 0. The seconds tick once per
  // wall-clock second; we don't try to be precise to ms.
  const [elapsedSec, setElapsedSec] = useState(0);
  useEffect(() => {
    if (!open) return;
    setElapsedSec(0);
    const id = window.setInterval(() => {
      setElapsedSec((s) => s + 1);
    }, 1000);
    return () => window.clearInterval(id);
    // Re-run when the row OR sub-step transitions so the counter
    // resets per phase. `phase` covers the run → sign transition.
  }, [open, subStep, rowIndex, phase]);

  // Lock the page's body scroll while the modal is open so users
  // can't scroll the modal off-screen mid-run. Restores on unmount.
  useEffect(() => {
    if (!open) return;
    if (typeof document === "undefined") return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return null;

  const sendStatus: StepStatus =
    phase === "sending" ? "in_progress" : sentCount >= totalCount ? "done" : "in_progress";
  const signStatus: StepStatus =
    phase === "signing" ? "in_progress" : sendStatus === "done" ? "pending" : "pending";

  // Row label is 1-based for human consumption.
  const humanRow = (rowIndex ?? 0) + 1;
  const rowOfTotal = `row ${humanRow} of ${totalCount}`;

  // Honest per-sub-step copy. The previous version always said
  // "Preparing batch…" / "Sending payment N of M" — useful as a
  // header but blind to where the time was actually going inside a
  // single row. Now the deepest level wins: "Generating ZK proof…"
  // when registering a shadow, "Funding shadow account…" while the
  // SOL transfer is in flight, etc.
  // Format mm:ss for the elapsed counter — keeps the visual signal
  // tight at the small uppercase mono text size used in the modal.
  const elapsedLabel = `${Math.floor(elapsedSec / 60)}:${String(elapsedSec % 60).padStart(2, "0")}`;

  const sendingLabel = (() => {
    if (sentCount === 0 && !subStep) return "Preparing batch…";
    if (sentCount >= totalCount) return `${totalCount} of ${totalCount} payments settled`;
    switch (subStep) {
      case "fund":
        return `Funding shadow account · ${rowOfTotal} · ${elapsedLabel} elapsed`;
      case "register":
        return `Generating zero-knowledge proof for shadow registration · ${rowOfTotal} (slow step — ~30–90s) · ${elapsedLabel} elapsed`;
      case "deposit":
        return `Depositing into encrypted balance · ${rowOfTotal} · ${elapsedLabel} elapsed`;
      case "shielded":
        return `Sending shielded payment · ${rowOfTotal} · ${elapsedLabel} elapsed`;
      case "public":
        return `Sending public payment · ${rowOfTotal} · ${elapsedLabel} elapsed`;
      default:
        return `Sending payment ${sentCount + 1} of ${totalCount} · ${elapsedLabel} elapsed`;
    }
  })();

  // Wallet input is only genuinely pending during the steps that
  // actually open Phantom: fund + deposit + the direct payInvoice
  // paths. ZK proving (`register`) runs entirely in-browser. We OR
  // with the parent's hint so we don't suppress it during the
  // post-loop receipt-packet signing.
  const isLocalCompute = subStep === "register";
  const effectiveAwaitingWallet = awaitingWallet && !isLocalCompute;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center p-4"
      role="status"
      aria-live="polite"
      aria-label="Running private payroll"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm" />

      {/* Dialog. max-h pinned to the dynamic viewport height (dvh)
          minus our outer padding so on shorter viewports the dialog
          gets an internal scroll instead of overflowing past the
          backdrop. Without this the user could scroll past the modal
          (which they shouldn't be able to do mid-run) and lose the
          progress signal. */}
      <div
        className="relative w-full max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto bg-paper-3 border border-line rounded-[4px] p-8 md:p-10 animate-fade-up"
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
            awaitingWallet={effectiveAwaitingWallet && phase === "sending"}
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
