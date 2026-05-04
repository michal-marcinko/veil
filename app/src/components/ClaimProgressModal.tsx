"use client";

/**
 * Shown the moment the dashboard discovers `N` claimable UTXOs and is
 * about to walk through them sequentially. Each UTXO is one Phantom
 * popup (one Solana tx); without this modal, six unclaimed UTXOs meant
 * six Phantom prompts in quick succession with zero context — looked
 * like a wallet-popup attack to anyone unfamiliar with the SDK.
 *
 * Mirrors the visual language of `PaymentProgressModal`:
 *   - cream paper background, gold accents, font-mono labels
 *   - `animate-fade-up` entrance, soft blurred backdrop
 *   - backdrop click does NOT dismiss (user has to wait through it)
 *
 * Lifecycle on the dashboard side:
 *   1. open=true, current=0, total=N        → "About to claim N…"
 *   2. open=true, current=k, total=N (k<N)  → progress bar + step list
 *   3. open=true, current=N, total=N        → success state for ~1.5s
 *   4. open=false                            → unmount
 */

interface Props {
  open: boolean;
  /** Number of UTXOs claimed so far (0..total). */
  current: number;
  /** Total UTXOs that will be claimed in this run. */
  total: number;
  /**
   * When set, the flow has hit a fatal error mid-run. Modal pivots to
   * an error state showing how many succeeded before the failure.
   * Caller is responsible for closing the modal after the user has
   * had a chance to read it.
   */
  errorMessage?: string | null;
}

export function ClaimProgressModal({
  open,
  current,
  total,
  errorMessage = null,
}: Props) {
  if (!open) return null;

  const safeTotal = Math.max(1, total);
  const safeCurrent = Math.min(current, total);
  const allDone = errorMessage == null && total > 0 && safeCurrent >= total;
  const percent = Math.round((safeCurrent / safeTotal) * 100);

  const lede = errorMessage
    ? "We hit an error mid-claim. Funds for already-claimed UTXOs are safe in your encrypted balance — just refresh again to retry the rest."
    : allDone
      ? `All ${total} claim${total === 1 ? "" : "s"} settled. Funds are in your encrypted balance.`
      : "Each claim is one wallet signature. Funds land in your encrypted balance. ~3-5 seconds per claim.";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Claiming incoming payments"
    >
      {/* Backdrop — explicitly NOT click-to-dismiss; user must wait through */}
      <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm" />

      <div
        className="relative w-full max-w-lg bg-paper-3 border border-line rounded-[4px] p-8 md:p-10 animate-fade-up"
        style={{ boxShadow: "0 30px 80px -24px rgba(26,24,20,0.35)" }}
      >
        <div className="flex items-baseline justify-between mb-6">
          <span className="eyebrow">
            {errorMessage
              ? "Claim · Interrupted"
              : allDone
                ? "Claim · Complete"
                : "Claim · In progress"}
          </span>
          <span className="eyebrow tnum">
            {String(safeCurrent).padStart(2, "0")} / {String(total).padStart(2, "0")}
          </span>
        </div>

        <div>
          <h2 className="font-sans font-medium text-ink text-[26px] md:text-[30px] tracking-[-0.02em] leading-[1.1]">
            {errorMessage ? (
              <>Claim interrupted</>
            ) : allDone ? (
              <>
                <span className="text-sage mr-2">✓</span> All {total} claim
                {total === 1 ? "" : "s"} complete
              </>
            ) : (
              <>
                Claiming{" "}
                <span className="tnum">{total}</span>{" "}
                incoming payment{total === 1 ? "" : "s"}
              </>
            )}
          </h2>
          <p className="text-muted mt-4 text-[13.5px] leading-[1.55] max-w-md">
            {lede}
          </p>
        </div>

        {/* Progress bar — gold fill on a hairline track. tnum percent on the right. */}
        <div className="mt-8">
          <div
            className="h-[6px] w-full bg-paper-2 rounded-full overflow-hidden"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={safeCurrent}
          >
            <div
              className={`h-full rounded-full transition-all duration-500 ease-out ${
                errorMessage
                  ? "bg-brick"
                  : allDone
                    ? "bg-sage"
                    : "bg-gold"
              }`}
              style={{ width: `${percent}%` }}
            />
          </div>
          <div className="mt-2 flex items-baseline justify-between">
            <span className="font-mono text-[10.5px] text-dim tracking-[0.08em] uppercase">
              {errorMessage
                ? "Interrupted"
                : allDone
                  ? "Settled"
                  : safeCurrent === 0
                    ? "Awaiting first signature"
                    : "Claiming next UTXO"}
            </span>
            <span className="font-mono text-[10.5px] text-dim tnum">
              {percent}%
            </span>
          </div>
        </div>

        {/* Step list — one row per UTXO. Cap visible rows at 8 to avoid
            an overlong modal on edge cases (≥10 UTXOs). The progress bar
            still represents the full count. */}
        <ol className="mt-7 space-y-2.5 max-h-[260px] overflow-y-auto pr-1">
          {Array.from({ length: total }).map((_, i) => {
            const done = i < safeCurrent;
            const inProgress = i === safeCurrent && !allDone && !errorMessage;
            return (
              <ClaimStepRow
                key={i}
                index={i + 1}
                total={total}
                done={done}
                inProgress={inProgress}
                interrupted={Boolean(errorMessage) && i >= safeCurrent}
              />
            );
          })}
        </ol>

        {errorMessage && (
          <div className="mt-6 flex items-start gap-3 border-l-2 border-brick pl-3 py-1.5">
            <span className="mono-chip text-brick shrink-0 pt-0.5">Error</span>
            <span className="text-[12.5px] text-ink leading-relaxed flex-1">
              {errorMessage}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function ClaimStepRow({
  index,
  total,
  done,
  inProgress,
  interrupted,
}: {
  index: number;
  total: number;
  done: boolean;
  inProgress: boolean;
  interrupted: boolean;
}) {
  return (
    <li className="grid grid-cols-[auto_1fr_auto] gap-4 items-center">
      <span
        className={`font-mono text-[11px] tabular-nums transition-colors duration-300 ${
          done
            ? "text-sage"
            : inProgress
              ? "text-ink"
              : interrupted
                ? "text-dim"
                : "text-dim"
        }`}
      >
        {String(index).padStart(2, "0")} / {String(total).padStart(2, "0")}
      </span>
      <span
        className={`text-[12.5px] font-mono tracking-[0.04em] transition-colors duration-300 ${
          done
            ? "text-muted"
            : inProgress
              ? "text-ink"
              : "text-dim"
        }`}
      >
        {done
          ? "Claimed"
          : inProgress
            ? "Awaiting wallet signature…"
            : interrupted
              ? "Skipped"
              : "Queued"}
      </span>
      <ClaimStatusGlyph
        done={done}
        inProgress={inProgress}
        interrupted={interrupted}
      />
    </li>
  );
}

function ClaimStatusGlyph({
  done,
  inProgress,
  interrupted,
}: {
  done: boolean;
  inProgress: boolean;
  interrupted: boolean;
}) {
  if (done) return <span className="font-mono text-sage">✓</span>;
  if (inProgress)
    return (
      <span className="inline-block h-2 w-2 rounded-full bg-gold animate-slow-pulse" />
    );
  if (interrupted)
    return <span className="font-mono text-dim">—</span>;
  return (
    <span className="inline-block h-2 w-2 rounded-full border border-line-2" />
  );
}
