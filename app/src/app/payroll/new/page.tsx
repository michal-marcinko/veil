"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { VeilLogo } from "@/components/VeilLogo";
import { PublicKey } from "@solana/web3.js";
import { PayrollCsvUploader, type PayrollFormValues } from "@/components/PayrollCsvUploader";
import { BatchProgress, type BatchStep } from "@/components/BatchProgress";
import {
  RegistrationModal,
  type RegistrationStep,
  type StepStatus,
} from "@/components/RegistrationModal";
import { getOrCreateClient, ensureRegistered } from "@/lib/umbra";
import { createInvoiceOnChain } from "@/lib/anchor";
import { buildMetadata, validateMetadata } from "@/lib/types";
import { encryptJson, generateKey, keyToBase58, sha256 } from "@/lib/encryption";
import { uploadCiphertext } from "@/lib/arweave";
import { generateBatchId, parseAmountToBaseUnits } from "@/lib/csv";
import { USDC_MINT, PAYMENT_SYMBOL, PAYMENT_DECIMALS } from "@/lib/constants";

interface CompletedInvoice {
  wallet: string;
  amount: string;
  url: string;
}

export default function PayrollNewPage() {
  const wallet = useWallet();
  const [submitting, setSubmitting] = useState(false);
  const [steps, setSteps] = useState<BatchStep[] | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [completed, setCompleted] = useState<CompletedInvoice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);
  const [regOpen, setRegOpen] = useState(false);
  const [regSteps, setRegSteps] = useState<Record<RegistrationStep, StepStatus>>({
    init: "pending",
    x25519: "pending",
    commitment: "pending",
  });

  async function handleSubmit(values: PayrollFormValues) {
    if (!wallet.publicKey || !wallet.signMessage) {
      setError("Connect wallet first");
      return;
    }
    setSubmitting(true);
    setError(null);

    // Pre-compute amount base units for every row so an invalid amount aborts
    // before we touch the network.
    const amounts: bigint[] = [];
    for (let i = 0; i < values.rows.length; i++) {
      const micros = parseAmountToBaseUnits(values.rows[i].amount, PAYMENT_DECIMALS);
      if (micros == null) {
        setError(`Row ${i + 1}: amount "${values.rows[i].amount}" is invalid for ${PAYMENT_SYMBOL}.`);
        setSubmitting(false);
        return;
      }
      amounts.push(micros);
    }

    const initialSteps: BatchStep[] = values.rows.map((r) => ({
      wallet: r.wallet,
      amount: r.amount,
      status: "pending",
      error: null,
      payUrl: null,
    }));
    setSteps(initialSteps);

    const thisBatchId = generateBatchId();
    setBatchId(thisBatchId);

    try {
      const client = await getOrCreateClient(wallet as any);
      setRegOpen(true);
      await ensureRegistered(client, (step, status) => {
        setRegSteps((prev) => ({
          ...prev,
          [step]: status === "pre" ? "in_progress" : "done",
        }));
      });
      setRegOpen(false);
    } catch (err: any) {
      setRegOpen(false);
      setError(`Umbra registration failed: ${err.message ?? String(err)}`);
      setSubmitting(false);
      return;
    }

    const completedLocal: CompletedInvoice[] = [];

    for (let i = 0; i < values.rows.length; i++) {
      const row = values.rows[i];
      const micros = amounts[i];

      setSteps((prev) =>
        prev ? prev.map((s, idx) => (idx === i ? { ...s, status: "in_progress" } : s)) : prev,
      );

      try {
        // Validate payer wallet up front — if it's not a pubkey we fail this
        // row and stop the batch (fail-fast).
        let payerPubkey: PublicKey;
        try {
          payerPubkey = new PublicKey(row.wallet);
        } catch {
          throw new Error(`"${row.wallet}" is not a valid Solana wallet address`);
        }

        const invoiceId = `inv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

        const lineItem = {
          description: row.memo || "Payroll",
          quantity: "1",
          unitPrice: micros.toString(),
          total: micros.toString(),
        };

        const md = buildMetadata({
          invoiceId,
          creatorDisplayName: values.creatorDisplayName,
          creatorWallet: wallet.publicKey.toBase58(),
          payerDisplayName: row.wallet,
          payerWallet: row.wallet,
          mint: USDC_MINT.toBase58(),
          symbol: PAYMENT_SYMBOL,
          decimals: PAYMENT_DECIMALS,
          lineItems: [lineItem],
          subtotal: micros.toString(),
          tax: "0",
          total: micros.toString(),
          dueDate: null,
          terms: null,
          notes: row.memo || null,
          batchId: thisBatchId,
        });
        validateMetadata(md);

        const key = generateKey();
        const ciphertext = await encryptJson(md, key);
        const { uri: rawUri } = await uploadCiphertext(ciphertext);
        // Stamp batch id onto the URI as an unencrypted query param so Alice's
        // batch dashboard can filter without decrypting each invoice. The
        // encrypted metadata also carries batch_id for recipient-side display.
        const uri = `${rawUri}${rawUri.includes("?") ? "&" : "?"}batch=${encodeURIComponent(thisBatchId)}`;
        const hash = await sha256(ciphertext);

        const nonce = crypto.getRandomValues(new Uint8Array(8));
        const pda = await createInvoiceOnChain(wallet as any, {
          nonce,
          metadataHash: hash,
          metadataUri: uri,
          mint: USDC_MINT,
          restrictedPayer: payerPubkey,
          expiresAt: null,
        });

        const url = `${window.location.origin}/pay/${pda.toBase58()}#${keyToBase58(key)}`;

        completedLocal.push({ wallet: row.wallet, amount: row.amount, url });
        setCompleted([...completedLocal]);
        setSteps((prev) =>
          prev
            ? prev.map((s, idx) => (idx === i ? { ...s, status: "done", payUrl: url } : s))
            : prev,
        );
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        setSteps((prev) =>
          prev
            ? prev.map((s, idx) => (idx === i ? { ...s, status: "error", error: msg } : s))
            : prev,
        );
        setError(
          `Row ${i + 1} failed: ${msg}. Earlier invoices in this batch are already on-chain and shareable.`,
        );
        setSubmitting(false);
        return;
      }
    }

    setSubmitting(false);
  }

  async function handleCopyAll() {
    if (completed.length === 0) return;
    const text = completed.map((c) => `${c.wallet}\t${c.amount} ${PAYMENT_SYMBOL}\t${c.url}`).join("\n");
    await navigator.clipboard.writeText(text);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 2200);
  }

  if (!wallet.connected) {
    return (
      <Frame heading="New payroll batch">
        <div className="max-w-lg reveal">
          <p className="text-[17px] md:text-[19px] text-ink/80 leading-[1.5] mb-8">
            Connect your wallet to publish a batch of private invoices.
          </p>
          <ClientWalletMultiButton />
        </div>
      </Frame>
    );
  }

  const allDone =
    steps !== null && steps.length > 0 && steps.every((s) => s.status === "done");

  if (allDone && batchId) {
    return (
      <Frame heading="Batch published">
        <div className="max-w-3xl reveal space-y-8">
          <div>
            <span className="eyebrow">Batch ID</span>
            <div className="mt-3 font-mono text-[13px] text-ink break-all">{batchId}</div>
          </div>
          <div className="flex flex-wrap gap-3">
            <button onClick={handleCopyAll} className="btn-primary">
              {copiedAll ? "Copied ✓" : "Copy all links"}
            </button>
            <a href={`/payroll/${batchId}`} className="btn-ghost">
              Open batch dashboard →
            </a>
          </div>
          <ul className="divide-y divide-line/60 border-t border-line">
            {completed.map((c, i) => (
              <li key={i} className="py-4 grid grid-cols-[1.75rem_auto_1fr] gap-4 items-baseline">
                <span className="font-mono text-[11px] text-dim tabular-nums">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="font-mono text-[13px] text-ink">
                  {c.wallet.slice(0, 6)}…{c.wallet.slice(-4)} · {c.amount} {PAYMENT_SYMBOL}
                </span>
                <span className="font-mono text-[12px] text-dim break-all">{c.url}</span>
              </li>
            ))}
          </ul>
        </div>
      </Frame>
    );
  }

  if (steps !== null) {
    return (
      <Frame heading="Publishing batch">
        <div className="max-w-3xl space-y-8 reveal">
          {error && (
            <div className="flex items-start gap-4 border-l-2 border-brick pl-4 py-2 max-w-2xl">
              <span className="mono-chip text-brick shrink-0 pt-0.5">Error</span>
              <span className="text-sm text-ink leading-relaxed flex-1">{error}</span>
            </div>
          )}
          <BatchProgress steps={steps} symbol={PAYMENT_SYMBOL} />
          {!submitting && error && completed.length > 0 && (
            <div className="pt-4">
              <button onClick={handleCopyAll} className="btn-ghost">
                {copiedAll ? "Copied ✓" : `Copy ${completed.length} completed link(s)`}
              </button>
            </div>
          )}
        </div>
      </Frame>
    );
  }

  return (
    <Frame heading="New payroll batch">
      <PayrollCsvUploader
        onSubmit={handleSubmit}
        submitting={submitting}
        errorMessage={error}
        onDismissError={() => setError(null)}
      />
      <RegistrationModal open={regOpen} steps={regSteps} />
    </Frame>
  );
}

function Frame({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <main className="min-h-screen relative pb-32">
      <nav className="sticky top-0 z-10 backdrop-blur-sm bg-paper/80 border-b border-line">
        <div className="max-w-[1100px] mx-auto flex items-center justify-between px-6 md:px-8 py-4">
          <VeilLogo />
          <div className="flex items-center gap-1 md:gap-2">
            <a href="/create" className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors">
              Create
            </a>
            <a href="/payroll/new" className="hidden sm:inline-block px-3 py-2 text-[13px] text-ink">
              Payroll
            </a>
            <a href="/dashboard" className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors">
              Dashboard
            </a>
            <div className="ml-2">
              <ClientWalletMultiButton />
            </div>
          </div>
        </div>
      </nav>

      <header className="max-w-[1100px] mx-auto px-6 md:px-8 pt-16 md:pt-20 pb-10 md:pb-12">
        <span className="eyebrow">Payroll</span>
        <h1 className="mt-3 font-sans font-medium text-ink text-[40px] md:text-[52px] leading-[1.03] tracking-[-0.03em] reveal">
          {heading}
        </h1>
      </header>

      <section className="max-w-[1100px] mx-auto px-6 md:px-8 max-w-3xl">{children}</section>
    </main>
  );
}
