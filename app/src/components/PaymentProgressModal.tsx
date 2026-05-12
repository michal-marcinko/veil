"use client";

/**
 * Stays open from the moment the user clicks Confirm until the deposit
 * tx confirms — including the entire Phantom-popup-storm. Without this,
 * the registration modal closed between alignment and payInvoice, and
 * the user was left staring at a static page while 2-3 Phantom popups
 * fired in sequence — visually it read like the app had crashed.
 *
 * Steps mirror what the SDK actually does on the deposit-from-public path:
 *   1. Build the ZK proof + proof account
 *   2. Sign + submit the proof account creation tx (Phantom popup #1)
 *   3. Sign + submit the deposit tx (Phantom popup #2)
 *   4. Wait for callback / confirmation
 */

export type PayStep = "build" | "sign-proof" | "sign-deposit" | "confirm";
export type PayStepStatus = "pending" | "in_progress" | "done";

interface Props {
  open: boolean;
  steps: Record<PayStep, PayStepStatus>;
  amountLabel: string; // e.g. "0.5000 SOL"
  recipientLabel: string; // e.g. "Alice"
  // True when paying from shielded balance via the Umbra relayer.
  // The relayer signs + pays for the on-chain txs, so the user sees
  // ZERO Phantom popups. Modal copy branches on this so we don't lie
  // about "wallet prompts coming" when none will.
  isShielded?: boolean;
}

const STEP_DATA_PUBLIC: Record<PayStep, { title: string; desc: string }> = {
  build: {
    title: "Building zero-knowledge proof",
    desc: "Generating the privacy proof locally — no wallet prompt yet.",
  },
  "sign-proof": {
    title: "Sign proof-account transaction",
    desc: "Phantom will open. This tx allocates space for the proof on-chain.",
  },
  "sign-deposit": {
    title: "Sign deposit transaction",
    desc: "Phantom opens again. This is the actual private payment.",
  },
  confirm: {
    title: "Confirming on-chain",
    desc: "Waiting for the validator to finalize. ~5-15 seconds.",
  },
};

const STEP_DATA_SHIELDED: Record<PayStep, { title: string; desc: string }> = {
  build: {
    title: "Building zero-knowledge proof",
    desc: "Generating the privacy proof locally on your device.",
  },
  "sign-proof": {
    title: "Submitting proof to relayer",
    desc: "Encrypting and forwarding to Umbra's relayer — no wallet prompt.",
  },
  "sign-deposit": {
    title: "Relayer creates the private UTXO",
    desc: "The relayer signs and pays the gas. Your wallet stays untouched.",
  },
  confirm: {
    title: "Confirming on-chain",
    desc: "Waiting for the validator to finalize. ~5-15 seconds.",
  },
};

export function PaymentProgressModal({
  open,
  steps,
  amountLabel,
  recipientLabel,
  isShielded = false,
}: Props) {
  if (!open) return null;

  const stepData = isShielded ? STEP_DATA_SHIELDED : STEP_DATA_PUBLIC;
  // Each path requires multiple wallet signatures even though the
  // relayer pays the gas — user must authorize each tx with their key.
  // Measured popup counts:
  //   shielded path: 2 (after disabling rent-claim)
  //   public-balance path: 2 today, will be 1 once batched signing ships
  const lede = isShielded
    ? "Two wallet prompts will appear. Each one signs one of the two on-chain transactions Umbra uses to create the private payment. Don't close this tab."
    : "Two wallet prompts will appear. Each one signs one of the two on-chain transactions Umbra uses to create the private payment. Don't close this tab.";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      {/* Backdrop — explicitly NOT click-to-dismiss; user has to wait through the flow */}
      <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm" />

      <div
        className="relative w-full max-w-lg bg-paper-3 border border-line rounded-[4px] p-8 md:p-10 animate-fade-up"
        style={{ boxShadow: "0 30px 80px -24px rgba(26,24,20,0.35)" }}
      >
        <div className="flex items-baseline justify-between mb-6">
          <span className="eyebrow">
            {isShielded ? "Private · Relayer-paid" : "Payment in progress"}
          </span>
          <span className="eyebrow">~30s</span>
        </div>

        <div>
          <h2 className="font-sans font-medium text-ink text-[26px] md:text-[30px] tracking-[-0.02em] leading-[1.1]">
            Sending{" "}
            <span className="tnum">{amountLabel}</span>{" "}
            <span className="text-muted">to</span> {recipientLabel}
          </h2>
          <p className="text-muted mt-4 text-[13.5px] leading-[1.55] max-w-md">{lede}</p>
        </div>

        <ol className="mt-10 space-y-5">
          {(["build", "sign-proof", "sign-deposit", "confirm"] as const).map((step, i) => (
            <StepRow
              key={step}
              index={i + 1}
              title={stepData[step].title}
              desc={stepData[step].desc}
              status={steps[step]}
              isShielded={isShielded}
            />
          ))}
        </ol>
      </div>
    </div>
  );
}

function StepRow({
  index,
  title,
  desc,
  status,
  isShielded,
}: {
  index: number;
  title: string;
  desc: string;
  status: PayStepStatus;
  isShielded: boolean;
}) {
  // In-progress micro-label varies by step + path. The shielded path
  // never opens a wallet popup, so don't lie about "Waiting for
  // signature" — the relayer is doing the heavy lifting silently.
  let microLabel = "Working…";
  if (status === "in_progress") {
    if (!isShielded && (index === 2 || index === 3)) {
      microLabel = "Waiting for wallet signature…";
    } else if (isShielded && (index === 2 || index === 3)) {
      microLabel = "Relayer working…";
    }
  }

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
        <div className="text-[12.5px] text-muted mt-1 font-sans leading-[1.5]">{desc}</div>
        {status === "in_progress" && (
          <div className="text-[11.5px] font-mono text-gold mt-1.5 tracking-[0.05em] uppercase">
            {microLabel}
          </div>
        )}
      </div>
      <StatusGlyph status={status} />
    </li>
  );
}

function StatusGlyph({ status }: { status: PayStepStatus }) {
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
