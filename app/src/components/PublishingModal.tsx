"use client";

/**
 * Full-screen overlay shown during the publish flow (after registration
 * is done, until the on-chain create-invoice settles). Mirrors
 * `RegistrationModal`'s visual register so the two flows feel like one
 * continuous gate. Lives at z-40 (above the canvas bar's z-30, below the
 * registration modal's z-50) so when registration is in flight, that
 * modal covers this one; once registration finishes, this one comes
 * forward.
 *
 * Critical UX role: the sticky bar alone wasn't a strong enough signal
 * during Phantom popups — users on Windows reported it appeared to "hide"
 * the moment Phantom's popup window grabbed focus. A centered modal with
 * backdrop blur eliminates ambiguity: when this is on screen, something
 * is happening; when it disappears, you're done.
 */

export type PublishStep = 1 | 2 | 3;

interface Props {
  open: boolean;
  step: PublishStep;
  awaitingWallet: boolean;
}

const STEPS: Array<{ title: string; desc: string }> = [
  {
    title: "Encrypt invoice metadata",
    desc: "AES-256-GCM with a per-invoice key derived from your wallet signature.",
  },
  {
    title: "Upload to Arweave",
    desc: "Permanent, content-addressed storage. The chain only sees the hash.",
  },
  {
    title: "Anchor on Solana",
    desc: "Create the on-chain invoice PDA — hash + Arweave URI, nothing else.",
  },
];

export function PublishingModal({ open, step, awaitingWallet }: Props) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center p-4"
      role="status"
      aria-live="polite"
      aria-label="Publishing your private invoice"
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
          <span className="eyebrow">Publishing · ~10s</span>
          <span className="eyebrow">Veil</span>
        </div>

        {/* Title */}
        <div>
          <h2 className="font-sans font-medium text-ink text-[26px] md:text-[30px] tracking-[-0.02em] leading-[1.1]">
            Publishing your private invoice
          </h2>
          <p className="text-muted mt-4 text-[13.5px] leading-[1.55] max-w-md">
            Three steps to encrypt, anchor, and ship the link. Stay on this tab
            until it completes.
          </p>
        </div>

        {/* Steps */}
        <ol className="mt-10 space-y-5">
          {STEPS.map((s, i) => {
            const stepNum = (i + 1) as PublishStep;
            const status =
              stepNum < step ? "done" : stepNum === step ? "in_progress" : "pending";
            return (
              <StepRow
                key={i}
                index={stepNum}
                title={s.title}
                desc={s.desc}
                status={status}
                awaitingWallet={awaitingWallet && stepNum === step}
              />
            );
          })}
        </ol>
      </div>
    </div>
  );
}

type StepStatus = "pending" | "in_progress" | "done";

function StepRow({
  index,
  title,
  desc,
  status,
  awaitingWallet,
}: {
  index: number;
  title: string;
  desc: string;
  status: StepStatus;
  awaitingWallet: boolean;
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
        <div className="text-[12.5px] text-muted mt-1 font-sans leading-[1.5]">
          {desc}
        </div>
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
