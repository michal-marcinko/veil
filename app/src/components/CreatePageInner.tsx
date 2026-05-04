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
import { PublishingModal } from "@/components/PublishingModal";
import { VeilDescentMark } from "@/components/VeilDescentMark";
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
 *
 * Lives outside `app/src/app/create/page.tsx` because Next.js's PageProps
 * type validation forbids arbitrary props or named exports on page files.
 * Tests render this directly with a `__forceState` prop; production code
 * imports the no-prop wrapper from page.tsx.
 */

type Mode = "invoice" | "payroll" | null;

// How long after click before form unmounts. Must be ≥ form-exit-anim
// duration (380ms below) so the user sees the exit complete. Below this
// we re-render before the animation finishes; above it we sit on a
// blank-but-faded form. Tuned with the exit curve for snap.
const FORM_EXIT_MS = 380;

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

export interface CreatePageInnerProps {
  /** Test-only: force-render at a specific state for jsdom renders. */
  __forceState?: "success";
}

export function CreatePageInner({ __forceState }: CreatePageInnerProps = {}) {
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
    }, FORM_EXIT_MS);
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

      {/* Picker — only shown before a mode is selected. Once the user
          enters Invoice or Payroll, it unmounts (form takes the whole
          viewport — no peek-through above to break immersion). The
          big-chevron back button below remounts it on demand.
          No section-level reveal animation: CreateModeSelector owns
          its own 200ms-with-stagger entry; stacking the old 700ms
          fade-up on top made the picker feel sluggish on remount. */}
      {mode === null && (
        <section className="max-w-[1400px] mx-auto px-6 md:px-8 pt-24 md:pt-32 pb-16 md:pb-24">
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
            {/* Back to picker — big bare chevron, no label. Hover lifts
                the chevron a few px to hint at the direction, color
                deepens from line-2 to ink. Hidden in invoice success
                state since the page is committed at that point. */}
            {!inSuccessState && (
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={handleBackToPicker}
                  aria-label="Back to picker — choose Invoice or Payroll"
                  className="canvas-back-arrow inline-flex items-center justify-center"
                >
                  <svg
                    viewBox="0 0 24 24"
                    className="w-10 h-10 md:w-12 md:h-12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M6 15l6-6 6 6" />
                  </svg>
                </button>
              </div>
            )}

            {/* Compose-state eyebrow lives INSIDE the form (above the
                items-table divider). Page-level eyebrow now reserved for
                the success state celebration only. */}
            {mode === "invoice" && inSuccessState && (
              <div className="mt-2">
                <span className="eyebrow text-sage">
                  ✓ Published privately · Just now
                </span>
              </div>
            )}
          </div>

          {mode === "invoice" ? (
            <div className="max-w-[1400px] mx-auto px-6 md:px-8 mt-8 md:mt-10 pb-32">
              {!wallet.connected ? (
                <div className="max-w-lg">
                  <p className="text-[17px] md:text-[19px] text-ink/80 leading-[1.5] mb-8">
                    To publish a private invoice, connect the wallet you&apos;ll receive payment to.
                  </p>
                  <ClientWalletMultiButton />
                </div>
              ) : inSuccessState && result ? (
                /* Clean success layout: veil-descent SVG + minimal text.
                   No form rerender, no chip row, no leftover state — just
                   the celebration and the sticky bar with the pay link. */
                <SuccessLayout result={result} />
              ) : (
                <div className="max-w-3xl">
                  <InvoiceForm
                    values={values}
                    onChange={(partial) =>
                      setValues((prev) => ({ ...prev, ...partial }))
                    }
                    onSubmit={handleSubmit}
                    errorMessage={error}
                    onDismissError={() => setError(null)}
                  />
                </div>
              )}
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

      {/* Publishing modal — overlays the canvas during the on-chain
          publish flow (after registration is done, before result lands).
          Solves the "modal disappears when Phantom popup opens" issue:
          this stays on screen continuously through every wallet popup. */}
      <PublishingModal
        open={mode === "invoice" && submitting && !regOpen && !result}
        step={publishStep}
        awaitingWallet={awaitingWallet}
      />

      <style
        dangerouslySetInnerHTML={{
          __html: `
        /*
          Form reveal (mount): 420ms ease-out-quart. Snappy onset, soft
          landing — feels responsive but not jittery.
          Form exit (back-button click): 380ms ease-in-quart. Fast
          acceleration outward; pairs with the slight scale-down for the
          "shrinking back into the picker" sensation. Distance kept
          small (translateY 18px) — large translates feel slow even at
          sub-400ms durations.
          Apple's app-switch transition is the reference: ~350-450ms
          with cubic curves and combined translate + scale, never just
          opacity.
        */
        .form-reveal {
          opacity: 0;
          transform: translateY(24px) scale(0.985);
          animation: form-reveal-anim 420ms cubic-bezier(0.165, 0.84, 0.44, 1) forwards;
          transform-origin: 50% 0%;
        }
        .form-reveal.is-exiting {
          animation: form-exit-anim 380ms cubic-bezier(0.5, 0, 0.75, 0) forwards;
          transform-origin: 50% 0%;
        }
        @keyframes form-reveal-anim {
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes form-exit-anim {
          from { opacity: 1; transform: translateY(0) scale(1); }
          to { opacity: 0; transform: translateY(18px) scale(0.985); }
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
 * Clean success layout — replaces the form entirely. Centered veil-
 * descent animation (the brand's primary visual metaphor) + minimal
 * text. The sticky bar at the bottom holds the pay link + Copy button.
 *
 * Deliberately omits: a re-render of the filled-in form, the chip row,
 * the line-items table, and any "+ Send another" button. The page reads
 * as "shipped, here's your link" — nothing else competes for attention.
 */
function SuccessLayout({ result }: { result: InvoiceResult }) {
  return (
    <div className="flex flex-col items-center justify-center text-center pt-12 md:pt-16 pb-8">
      <VeilDescentMark size={144} />
      <div className="mt-10 font-sans font-medium text-ink text-[28px] md:text-[32px] leading-[1.1] tracking-[-0.025em]">
        <span className="tnum">{result.formattedAmount}</span>
        <span className="text-muted"> requested from </span>
        <span>{result.payerName}</span>
      </div>
      <p className="mt-4 text-[14px] leading-[1.55] text-muted max-w-[440px]">
        Encrypted client-side. Only their wallet — or yours via the
        dashboard — can open it; the chain sees only a hash.
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
