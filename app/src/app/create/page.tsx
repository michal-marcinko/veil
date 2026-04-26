"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { VeilLogo } from "@/components/VeilLogo";
import { PublicKey } from "@solana/web3.js";
import { InvoiceForm, type InvoiceFormValues } from "@/components/InvoiceForm";
import {
  RegistrationModal,
  type RegistrationStep,
  type StepStatus,
} from "@/components/RegistrationModal";
import { getOrCreateClient, ensureRegistered } from "@/lib/umbra";
import { createInvoiceOnChain } from "@/lib/anchor";
import { buildMetadata, validateMetadata } from "@/lib/types";
import { encryptJson, deriveKeyFromWalletSignature, keyToBase58, sha256 } from "@/lib/encryption";
import { uploadCiphertext } from "@/lib/arweave";
import { USDC_MINT, PAYMENT_SYMBOL, PAYMENT_DECIMALS } from "@/lib/constants";

export default function CreatePage() {
  const wallet = useWallet();
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{
    url: string;
    payerName: string;
    formattedAmount: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [regOpen, setRegOpen] = useState(false);
  const [regSteps, setRegSteps] = useState<Record<RegistrationStep, StepStatus>>({
    init: "pending",
    x25519: "pending",
    commitment: "pending",
  });

  async function handleSubmit(values: InvoiceFormValues) {
    if (!wallet.publicKey || !wallet.signMessage) {
      setError("Connect wallet first");
      return;
    }
    setSubmitting(true);
    setError(null);

    try {
      const parsedItems = values.lineItems.map((li, i) => {
        const unitPriceMicros = parseAmountToBaseUnits(li.unitPrice, PAYMENT_DECIMALS);
        if (unitPriceMicros == null) {
          throw new Error(`Line ${i + 1}: enter a valid ${PAYMENT_SYMBOL} amount (e.g. 100.00).`);
        }
        const qty = Number.parseInt(li.quantity, 10);
        if (!Number.isFinite(qty) || qty <= 0) {
          throw new Error(`Line ${i + 1}: quantity must be a whole number ≥ 1.`);
        }
        return {
          description: li.description,
          quantity: qty.toString(),
          unitPriceMicros,
          totalMicros: unitPriceMicros * BigInt(qty),
        };
      });

      const client = await getOrCreateClient(wallet as any);
      setRegOpen(true);
      await ensureRegistered(client, (step, status) => {
        setRegSteps((prev) => ({
          ...prev,
          [step]: status === "pre" ? "in_progress" : "done",
        }));
      });
      setRegOpen(false);

      const invoiceId = `inv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const subtotal = parsedItems.reduce((sum, li) => sum + li.totalMicros, 0n);

      const nonce = crypto.getRandomValues(new Uint8Array(8));
      const { deriveInvoicePda } = await import("@/lib/anchor");
      const [pda] = deriveInvoicePda(wallet.publicKey, nonce);

      const md = buildMetadata({
        invoiceId,
        creatorDisplayName: values.creatorDisplayName,
        creatorWallet: wallet.publicKey.toBase58(),
        payerDisplayName: values.payerDisplayName,
        payerWallet: values.payerWallet || null,
        mint: USDC_MINT.toBase58(),
        symbol: PAYMENT_SYMBOL,
        decimals: PAYMENT_DECIMALS,
        lineItems: parsedItems.map((li) => ({
          description: li.description,
          quantity: li.quantity,
          unitPrice: li.unitPriceMicros.toString(),
          total: li.totalMicros.toString(),
        })),
        subtotal: subtotal.toString(),
        tax: "0",
        total: subtotal.toString(),
        dueDate: values.dueDate || null,
        terms: null,
        notes: values.notes || null,
      });
      validateMetadata(md);

      // Sign over the PDA (always knowable off-chain from wallet + nonce),
      // so the re-open flow can re-derive the same key without needing to
      // first decrypt the metadata.
      const key = await deriveKeyFromWalletSignature(wallet as any, pda.toBase58());
      const ciphertext = await encryptJson(md, key);
      const { uri } = await uploadCiphertext(ciphertext);
      const hash = await sha256(ciphertext);

      const restrictedPayer = values.payerWallet ? new PublicKey(values.payerWallet) : null;
      await createInvoiceOnChain(wallet as any, {
        nonce,
        metadataHash: hash,
        metadataUri: uri,
        mint: USDC_MINT,
        restrictedPayer,
        expiresAt: null,
      });

      const url = `${window.location.origin}/pay/${pda.toBase58()}#${keyToBase58(key)}`;
      setResult({
        url,
        payerName: values.payerDisplayName,
        formattedAmount: formatTotalForDisplay(subtotal, PAYMENT_DECIMALS, PAYMENT_SYMBOL),
      });
    } catch (err: any) {
      setError(err.message ?? String(err));
      setRegOpen(false);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCopy() {
    if (!result) return;
    await navigator.clipboard.writeText(result.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2200);
  }

  if (!wallet.connected) {
    return (
      <Frame heading="Create invoice">
        <div className="max-w-lg reveal">
          <p className="text-[17px] md:text-[19px] text-ink/80 leading-[1.5] mb-8">
            To publish a private invoice, connect the wallet you&apos;ll receive payment to.
          </p>
          <ClientWalletMultiButton />
        </div>
      </Frame>
    );
  }

  if (result) {
    return (
      <Frame heading="Invoice sent">
        <div className="max-w-2xl reveal">
          {/* Headline summary — what was created, for whom */}
          <div className="flex items-baseline gap-2 mb-3">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-sage shrink-0 translate-y-[1px]">
              <path d="M3 7.5l3 3 5-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-sage">
              Published privately
            </span>
          </div>
          <h2 className="font-sans font-medium text-ink text-[28px] md:text-[32px] leading-[1.1] tracking-[-0.025em]">
            <span className="tnum">{result.formattedAmount}</span>
            <span className="text-muted"> requested from </span>
            <span>{result.payerName}</span>
          </h2>
          <p className="mt-5 text-[14px] leading-[1.55] text-ink/70 max-w-[520px]">
            Send this link to your client. Only their wallet (or yours, via your dashboard) can
            open it — the amount and details are encrypted, the chain only sees an anchor hash.
          </p>

          {/* Shareable link */}
          <div className="mt-9">
            <span className="eyebrow">Pay link</span>
            <div className="mt-3 border border-line bg-paper-3 rounded-[3px] p-4 font-mono text-[12.5px] text-ink break-all">
              {result.url}
            </div>
          </div>

          {/* Actions */}
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <button onClick={handleCopy} className="btn-primary">
              {copied ? (
                <span>Copied ✓</span>
              ) : (
                <span>
                  Copy link <span aria-hidden>→</span>
                </span>
              )}
            </button>
            <a href="/dashboard" className="btn-ghost">
              View dashboard
            </a>
            <button
              onClick={() => {
                setResult(null);
                setCopied(false);
              }}
              className="btn-quiet"
            >
              + Send another
            </button>
          </div>
        </div>
      </Frame>
    );
  }

  return (
    <Frame heading="Create invoice">
      <InvoiceForm
        onSubmit={handleSubmit}
        submitting={submitting}
        errorMessage={error}
        onDismissError={() => setError(null)}
      />
      <RegistrationModal open={regOpen} steps={regSteps} />
    </Frame>
  );
}

/**
 * Format a base-units bigint as a human "$X,XXX.XX SYMBOL" string for the
 * "Invoice sent" success summary. Trims trailing fractional zeros down to
 * a 2-digit minimum so $4,200.00 stays $4,200.00 but $4,200.5000 reads
 * $4,200.50, matching the on-screen InvoiceView formatting.
 */
function formatTotalForDisplay(units: bigint, decimals: number, symbol: string): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = units / divisor;
  const fraction = units % divisor;
  const display = Math.min(4, decimals);
  const padded = fraction.toString().padStart(decimals, "0").slice(0, display);
  const trimmed = padded.replace(/0+$/, "").padEnd(2, "0");
  const symbolPrefix = symbol === "USDC" ? "$" : "";
  const symbolSuffix = symbol === "USDC" ? " USDC" : ` ${symbol}`;
  return `${symbolPrefix}${whole.toLocaleString("en-US")}.${trimmed}${symbolSuffix}`;
}

function parseAmountToBaseUnits(value: string, decimals: number): bigint | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(new RegExp(`^(\\d+)(?:\\.(\\d{0,${decimals}}))?$`));
  if (!match) return null;
  const whole = BigInt(match[1]);
  const fraction = (match[2] ?? "").padEnd(decimals, "0").slice(0, decimals);
  return whole * (10n ** BigInt(decimals)) + BigInt(fraction);
}

function Frame({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <main className="min-h-screen relative pb-32">
      <nav className="sticky top-0 z-10 backdrop-blur-sm bg-paper/80 border-b border-line">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between px-6 md:px-8 py-4">
          <VeilLogo />
          <div className="flex items-center gap-1 md:gap-2">
            <a
              href="/create"
              className="hidden sm:inline-block px-3 py-2 text-[13px] text-ink"
            >
              Create
            </a>
            <a
              href="/dashboard"
              className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors"
            >
              Dashboard
            </a>
            <div className="ml-2">
              <ClientWalletMultiButton />
            </div>
          </div>
        </div>
      </nav>

      <header className="max-w-[1400px] mx-auto px-6 md:px-8 pt-16 md:pt-20 pb-10 md:pb-12">
        <span className="eyebrow">New invoice</span>
        <h1 className="mt-3 font-sans font-medium text-ink text-[40px] md:text-[52px] leading-[1.03] tracking-[-0.03em] reveal">
          {heading}
        </h1>
      </header>

      <section className="max-w-[1400px] mx-auto px-6 md:px-8 max-w-3xl">{children}</section>
    </main>
  );
}
