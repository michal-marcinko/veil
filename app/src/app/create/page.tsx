"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { VeilLogo } from "@/components/VeilLogo";
import { PublicKey } from "@solana/web3.js";
import {
  InvoiceForm,
  type InvoiceFormValues,
  computeSubtotalMicros,
  formatSubtotal,
} from "@/components/InvoiceForm";
import { InvoiceCanvasBar, type CanvasBarState } from "@/components/InvoiceCanvasBar";
import {
  RegistrationModal,
  type RegistrationStep,
  type StepStatus,
} from "@/components/RegistrationModal";
import { CreateModeSelector } from "@/components/CreateModeSelector";
import { PayrollFlow } from "@/components/PayrollFlow";
import { getOrCreateClient, ensureRegistered, ensureReceiverKeyAligned } from "@/lib/umbra";
import { createInvoiceOnChain } from "@/lib/anchor";
import { buildMetadata, validateMetadata } from "@/lib/types";
import {
  encryptJson,
  getOrCreateMetadataMasterSig,
  deriveKeyFromMasterSig,
  keyToBase58,
  sha256,
} from "@/lib/encryption";
import { uploadCiphertext } from "@/lib/arweave";
import { USDC_MINT, PAYMENT_SYMBOL, PAYMENT_DECIMALS } from "@/lib/constants";

/**
 * /create — Document Canvas redesign (2026-05-04).
 *
 * Picker stays anchored at top while composing. After successful publish
 * (`result !== null`) the picker + "Choose differently" fade out so the
 * user's eye lands on the success state. The sticky <InvoiceCanvasBar>
 * persists across all states — never unmounts — which is what keeps
 * "the modal" mounted continuously through every Phantom popup.
 */

type Mode = "invoice" | "payroll" | null;

const SCROLL_BACK_MS = 900;

const EMPTY_FORM: InvoiceFormValues = {
  creatorDisplayName: "",
  payerDisplayName: "",
  payerWallet: "",
  lineItems: [{ description: "", quantity: "1", unitPrice: "" }],
  notes: "",
  dueDate: "",
};

type PublishStep = 1 | 2 | 3;

interface InvoiceResult {
  url: string;
  payerName: string;
  formattedAmount: string;
}

interface CreatePageProps {
  /** Test-only: force-render at a specific state for jsdom renders. */
  __forceState?: "success";
}

export default function CreatePage({ __forceState }: CreatePageProps = {}) {
  const wallet = useWallet();

  const [mode, setMode] = useState<Mode>(__forceState === "success" ? "invoice" : null);
  const [formExiting, setFormExiting] = useState(false);
  const formRef = useRef<HTMLElement>(null);
  const exitTimeoutRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (exitTimeoutRef.current !== null) {
        window.clearTimeout(exitTimeoutRef.current);
      }
    },
    [],
  );

  // Form state lifted into the page so the canvas bar can read live subtotal.
  const [values, setValues] = useState<InvoiceFormValues>(EMPTY_FORM);

  const [submitting, setSubmitting] = useState(false);
  const [publishStep, setPublishStep] = useState<PublishStep>(1);
  const [awaitingWallet, setAwaitingWallet] = useState(false);
  const [result, setResult] = useState<InvoiceResult | null>(
    __forceState === "success"
      ? {
          url: "https://veil.app/pay/CXfe1JwAXzSjvMKdFWgVkNE37vUdmwAW5aDfU6zbSNDW#8Mkfdk3G15PWkTk4F1QyMho2FCuVvGVFAiZJVzCiTmPt",
          payerName: "Globex Corp.",
          formattedAmount: "5,800.00 USDC",
        }
      : null,
  );
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [regOpen, setRegOpen] = useState(false);
  const [regSteps, setRegSteps] = useState<Record<RegistrationStep, StepStatus>>({
    init: "pending",
    x25519: "pending",
    commitment: "pending",
  });

  function handleSelectMode(next: "invoice" | "payroll") {
    if (exitTimeoutRef.current !== null) {
      window.clearTimeout(exitTimeoutRef.current);
      exitTimeoutRef.current = null;
      setFormExiting(false);
    }
    if (mode === next) {
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    setMode(next);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }

  function handleBackToPicker() {
    setFormExiting(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
    exitTimeoutRef.current = window.setTimeout(() => {
      setMode(null);
      setFormExiting(false);
      setError(null);
      setResult(null);
      setCopied(false);
      setValues(EMPTY_FORM);
      exitTimeoutRef.current = null;
    }, SCROLL_BACK_MS);
  }

  async function handleSubmit() {
    if (!wallet.publicKey || !wallet.signMessage) {
      setError("Connect wallet first");
      return;
    }
    setSubmitting(true);
    setPublishStep(1);
    setAwaitingWallet(false);
    setError(null);

    try {
      const parsedItems = values.lineItems.map((li, i) => {
        const unitPriceMicros = parseAmountToBaseUnits(li.unitPrice, PAYMENT_DECIMALS);
        if (unitPriceMicros == null) {
          throw new Error(
            `Line ${i + 1}: enter a valid ${PAYMENT_SYMBOL} amount (e.g. 100.00).`,
          );
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
      await ensureReceiverKeyAligned(client);
      setRegOpen(false);

      // Step 1: encrypt + upload (one wallet popup for master sig on first run).
      setPublishStep(1);
      setAwaitingWallet(true);

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

      const masterSig = await getOrCreateMetadataMasterSig(
        wallet as any,
        wallet.publicKey.toBase58(),
      );
      setAwaitingWallet(false);

      // Step 2: encrypt + upload.
      setPublishStep(2);
      const key = await deriveKeyFromMasterSig(masterSig, pda.toBase58());
      const ciphertext = await encryptJson(md, key);
      const { uri } = await uploadCiphertext(ciphertext);
      const hash = await sha256(ciphertext);

      // Step 3: anchor on Solana — second wallet popup.
      setPublishStep(3);
      setAwaitingWallet(true);
      const restrictedPayer = values.payerWallet ? new PublicKey(values.payerWallet) : null;
      await createInvoiceOnChain(wallet as any, {
        nonce,
        metadataHash: hash,
        metadataUri: uri,
        mint: USDC_MINT,
        restrictedPayer,
        expiresAt: null,
      });
      setAwaitingWallet(false);

      const url = `${window.location.origin}/pay/${pda.toBase58()}#${keyToBase58(key)}`;
      setResult({
        url,
        payerName: values.payerDisplayName,
        formattedAmount: formatTotalForDisplay(subtotal, PAYMENT_DECIMALS, PAYMENT_SYMBOL),
      });
      requestAnimationFrame(() => {
        formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    } catch (err: any) {
      setError(err.message ?? String(err));
      setRegOpen(false);
      setAwaitingWallet(false);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCopy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.url);
    } catch {
      // jsdom and some non-secure contexts have no clipboard. Silently
      // skip — the visual feedback still flips.
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2200);
  }

  // Live subtotal feeds the canvas bar in compose state.
  const subtotalMicros = computeSubtotalMicros(values);
  const canSubmit = !submitting && wallet.connected && subtotalMicros > 0n;

  // Build the canvas bar state for whatever phase we're in. The
  // *invoice* mode only renders the bar; payroll has its own primary
  // action inside <PayrollFlow />.
  let canvasState: CanvasBarState | null = null;
  if (mode === "invoice") {
    if (result) {
      canvasState = {
        kind: "success",
        payUrl: result.url,
        copied,
        onCopy: handleCopy,
      };
    } else if (submitting) {
      const stepLabels: Record<PublishStep, string> = {
        1: "Encrypting metadata",
        2: "Uploading to Arweave",
        3: "Anchoring on Solana",
      };
      canvasState = {
        kind: "publishing",
        step: publishStep,
        stepLabel: stepLabels[publishStep],
        awaitingWallet,
      };
    } else if (wallet.connected) {
      canvasState = {
        kind: "compose",
        subtotalDisplay: formatSubtotal(subtotalMicros),
        canSubmit,
      };
    }
  }

  // True while the canvas-bar success state is active. Used to fade out
  // the picker + "Choose differently" link.
  const inSuccessState = mode === "invoice" && !!result;

  /* ─────────────────────────────── render ─────────────────────────────── */

  return (
    <Frame>
      <h1 className="sr-only">Compose a payment</h1>

      {/* Picker — anchored at top. Hidden during invoice success state. */}
      {!inSuccessState && (
        <section
          className={[
            "max-w-[1400px] mx-auto px-6 md:px-8 pt-24 md:pt-32 pb-16 md:pb-24",
            "transition-opacity duration-300",
          ].join(" ")}
        >
          <CreateModeSelector onSelect={handleSelectMode} />
        </section>
      )}

      {mode !== null && (
        <section
          ref={formRef}
          className={[
            "form-reveal scroll-mt-24",
            !inSuccessState ? "border-t border-line" : "",
            formExiting ? "is-exiting" : "",
            submitting ? "canvas-page-fade" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          aria-label={mode === "invoice" ? "Create invoice" : "Run payroll"}
        >
          <div className="max-w-[1400px] mx-auto px-6 md:px-8 pt-12 md:pt-16">
            {/* Choose differently — hidden in invoice success state */}
            {!inSuccessState && (
              <button
                type="button"
                onClick={handleBackToPicker}
                className="inline-flex items-center gap-2 font-mono text-[12.5px] tracking-[0.04em] text-muted hover:text-ink transition-colors"
              >
                <span aria-hidden>↑</span> Choose differently
              </button>
            )}

            {mode === "invoice" && (
              <div className={inSuccessState ? "mt-2" : "mt-8"}>
                <span className={inSuccessState ? "eyebrow text-sage" : "eyebrow"}>
                  {inSuccessState ? "✓ Published privately · Just now" : "New invoice"}
                </span>
              </div>
            )}
          </div>

          {mode === "invoice" ? (
            <div className="max-w-[1400px] mx-auto px-6 md:px-8 mt-8 md:mt-10 pb-32">
              <div className="max-w-3xl">
                {!wallet.connected ? (
                  <div className="max-w-lg">
                    <p className="text-[17px] md:text-[19px] text-ink/80 leading-[1.5] mb-8">
                      To publish a private invoice, connect the wallet you&apos;ll receive payment to.
                    </p>
                    <ClientWalletMultiButton />
                  </div>
                ) : (
                  <InvoiceForm
                    values={values}
                    onChange={(partial) =>
                      setValues((prev) => ({ ...prev, ...partial }))
                    }
                    onSubmit={handleSubmit}
                    errorMessage={error}
                    onDismissError={() => setError(null)}
                  />
                )}
                {result && <SuccessSummary result={result} />}
              </div>
            </div>
          ) : (
            <div className="max-w-[1400px] mx-auto px-6 md:px-8 mt-10 md:mt-12 pb-32">
              <PayrollFlow />
            </div>
          )}
        </section>
      )}

      {/* Canvas bar — invoice mode only. Persists across all states. */}
      {canvasState && <InvoiceCanvasBar state={canvasState} formId="invoice-form" />}

      <RegistrationModal open={regOpen} steps={regSteps} />

      <style
        dangerouslySetInnerHTML={{
          __html: `
        .form-reveal {
          opacity: 0;
          transform: translateY(40px);
          animation: form-reveal-anim 700ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
        .form-reveal.is-exiting {
          animation: form-exit-anim 600ms cubic-bezier(0.7, 0, 0.84, 0) forwards;
        }
        @keyframes form-reveal-anim {
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes form-exit-anim {
          from { opacity: 1; transform: translateY(0); }
          to { opacity: 0; transform: translateY(24px); }
        }
        @media (prefers-reduced-motion: reduce) {
          .form-reveal,
          .form-reveal.is-exiting {
            animation: none;
            opacity: 1;
            transform: none;
          }
        }
      `,
        }}
      />
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen relative pb-32">
      <nav className="sticky top-0 z-10 backdrop-blur-sm bg-paper/80 border-b border-line">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between px-6 md:px-8 py-4">
          <VeilLogo tagline="compose" />
          <div className="flex items-center gap-1 md:gap-2">
            <Link
              href="/create"
              className="hidden sm:inline-block px-3 py-2 text-[13px] text-ink"
            >
              Create
            </Link>
            <Link
              href="/dashboard"
              className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors"
            >
              Activity
            </Link>
            <Link
              href="/docs"
              className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors"
            >
              Docs
            </Link>
            <div className="ml-2">
              <ClientWalletMultiButton />
            </div>
          </div>
        </div>
      </nav>
      {children}
    </main>
  );
}

/**
 * Success summary rendered above the sticky bar — describes what was
 * shipped, with the recipient name and amount. The bar itself holds the
 * pay link + Copy button.
 */
function SuccessSummary({ result }: { result: InvoiceResult }) {
  return (
    <div className="max-w-2xl mt-10">
      <h3 className="font-sans font-medium text-ink text-[28px] md:text-[32px] leading-[1.1] tracking-[-0.025em]">
        <span className="tnum">{result.formattedAmount}</span>
        <span className="text-muted"> requested from </span>
        <span>{result.payerName}</span>
      </h3>
      <p className="mt-4 text-[14px] leading-[1.55] text-ink/70 max-w-[520px]">
        Send the link below to your client. Only their wallet (or yours via
        the dashboard) can open it — the chain only sees an anchor hash.
      </p>
    </div>
  );
}

/* ──────────────── helpers (unchanged from the prior version) ──────────────── */

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
  return whole * 10n ** BigInt(decimals) + BigInt(fraction);
}
