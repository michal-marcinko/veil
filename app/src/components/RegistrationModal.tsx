"use client";

export type RegistrationStep = "init" | "x25519" | "commitment";
export type StepStatus = "pending" | "in_progress" | "done";

interface Props {
  open: boolean;
  steps: Record<RegistrationStep, StepStatus>;
  onCancel?: () => void;
}

const STEP_DATA: Record<RegistrationStep, { title: string; desc: string }> = {
  init: {
    title: "Initialize account",
    desc: "Create your EncryptedUserAccount PDA on Solana.",
  },
  x25519: {
    title: "Register encryption key",
    desc: "Derive and register your X25519 public key.",
  },
  commitment: {
    title: "Enable anonymous transfers",
    desc: "Anchor a Poseidon user commitment for the mixer.",
  },
};

export function RegistrationModal({ open, steps, onCancel }: Props) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-ink/80 backdrop-blur-sm" />

      {/* Dialog */}
      <div
        className="relative w-full max-w-lg bg-paper border border-line p-9 md:p-11 animate-fade-up"
        style={{ boxShadow: "0 40px 100px -20px rgba(0,0,0,0.65)" }}
      >
        {/* Corner meta */}
        <div className="absolute top-4 left-4 mono-chip">One-time · ~10s</div>
        <div className="absolute top-4 right-4 mono-chip">Umbra</div>

        {/* Title */}
        <div className="pt-8 md:pt-10">
          <div className="flex items-baseline gap-5 mb-5">
            <span className="section-no">Setup</span>
            <span className="h-px w-16 bg-line" />
          </div>
          <h2 className="font-serif text-3xl md:text-4xl tracking-tight leading-[1.05]">
            Setting up your <span className="italic">private</span> account
          </h2>
          <p className="text-muted mt-4 text-[13px] md:text-sm leading-relaxed max-w-md">
            Three on-chain transactions establish your cryptographic identity. Your wallet will
            prompt you once for consent; subsequent operations reuse the cached seed.
          </p>
        </div>

        {/* Steps */}
        <ol className="mt-10 space-y-5">
          {(["init", "x25519", "commitment"] as const).map((step, i) => (
            <StepRow
              key={step}
              index={i + 1}
              title={STEP_DATA[step].title}
              desc={STEP_DATA[step].desc}
              status={steps[step]}
            />
          ))}
        </ol>

        {/* Cancel */}
        {onCancel && (
          <div className="mt-10 pt-5 border-t border-line">
            <button onClick={onCancel} className="btn-quiet">
              Cancel setup
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function StepRow({
  index,
  title,
  desc,
  status,
}: {
  index: number;
  title: string;
  desc: string;
  status: StepStatus;
}) {
  return (
    <li className="grid grid-cols-[auto_1fr_auto] gap-5 items-start">
      <span
        className={`font-mono text-[13px] tabular-nums pt-0.5 transition-colors duration-300 ${
          status === "done"
            ? "text-gold"
            : status === "in_progress"
              ? "text-cream"
              : "text-dim"
        }`}
      >
        {String(index).padStart(2, "0")}
      </span>
      <div>
        <div
          className={`font-serif text-lg md:text-xl leading-tight transition-colors duration-300 ${
            status === "done" ? "text-muted line-through" : "text-cream"
          }`}
        >
          {title}
        </div>
        <div className="text-[12px] text-dim mt-1 font-sans leading-relaxed">{desc}</div>
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
      <span className="pt-2 inline-block h-2 w-2 rounded-full bg-cream animate-slow-pulse" />
    );
  }
  return <span className="pt-2 inline-block h-2 w-2 rounded-full border border-dim" />;
}
