"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
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
 * /create flow — picker stays anchored at the top; selecting Invoice or
 * Payroll spawns the matching form below and the page smooth-scrolls down
 * to it. Selecting "Choose differently" smooth-scrolls back up before
 * unmounting the form, so the user never sees an abrupt swap mid-scroll.
 *
 * Both modes inline now: invoice renders the form/wallet-gate/success
 * branches owned by this page; payroll delegates to <PayrollFlow />,
 * which is fully self-contained (its own wallet gate, registration modal,
 * success states, and internal heading). The /payroll/outgoing route
 * still works as a deep-link standalone and reuses the same component.
 *
 * Animation register is Apple-style ease-out-expo (cubic-bezier(0.16, 1,
 * 0.3, 1)) over 700ms — long enough to read as cinematic, short enough
 * not to drag. `prefers-reduced-motion` short-circuits to instant
 * presentation.
 */

type Mode = "invoice" | "payroll" | null;

const SCROLL_BACK_MS = 900;

export default function CreatePage() {
  const wallet = useWallet();

  const [mode, setMode] = useState<Mode>(null);
  // Drives the exit animation when going back to the picker. We add this
  // class to the form section before unmounting so it fades + drifts down
  // gracefully instead of popping out of existence after the smooth-scroll.
  const [formExiting, setFormExiting] = useState(false);
  // Anchor for the smooth scroll-down on mode select.
  const formRef = useRef<HTMLElement>(null);
  // Pending unmount timer — held so we can cancel it if the user
  // re-engages mid-exit (clicks a mode card during the 900ms back window).
  // Without this, the original timeout fires after their new selection and
  // wipes it out by setting mode back to null.
  const exitTimeoutRef = useRef<number | null>(null);

  // Always clear the unmount timer on component unmount so we don't run
  // setState on an unmounted tree.
  useEffect(() => {
    return () => {
      if (exitTimeoutRef.current !== null) {
        window.clearTimeout(exitTimeoutRef.current);
      }
    };
  }, []);

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

  function handleSelectMode(next: "invoice" | "payroll") {
    // If the user clicked back and is now re-engaging mid-exit, cancel
    // the pending unmount and clear the exit class so the reveal can
    // resume. The form is still mounted at this point — we just need to
    // halt the disappearance.
    if (exitTimeoutRef.current !== null) {
      window.clearTimeout(exitTimeoutRef.current);
      exitTimeoutRef.current = null;
      setFormExiting(false);
    }

    // Re-clicking the active mode card just re-scrolls to the form rather
    // than remounting (which would lose in-progress state).
    if (mode === next) {
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    setMode(next);
    // Two RAF beats so the form section has actually painted before we
    // ask the browser to scroll to it. Without this we sometimes scroll
    // before the element exists in the layout tree.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }

  function handleBackToPicker() {
    // Run the exit animation (fade + drift down) AND smooth-scroll up in
    // parallel. Unmount after both should be done. Without the exit class
    // the form pops out of existence at the unmount tick, which reads as
    // jank — especially if the scroll is still in flight.
    setFormExiting(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
    // Held in a ref so handleSelectMode can cancel it if the user
    // re-engages with a card during the back animation.
    exitTimeoutRef.current = window.setTimeout(() => {
      setMode(null);
      setFormExiting(false);
      setError(null);
      setResult(null);
      setCopied(false);
      exitTimeoutRef.current = null;
    }, SCROLL_BACK_MS);
  }

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
      // Align before publishing a pay link. If the creator registered under
      // an old drifting seed, payers would encrypt to a stale on-chain key and
      // the creator's dashboard could never decrypt/claim the incoming UTXO.
      await ensureReceiverKeyAligned(client);
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

      // One-time-per-wallet master signature is cached in localStorage —
      // see encryption.ts `getOrCreateMetadataMasterSig`. After Alice's
      // first invoice this is a no-op (no Phantom popup), so creating
      // subsequent invoices is just one signTransaction popup for the
      // on-chain create. The per-invoice key is HKDF'd from (masterSig,
      // PDA) and remains the deterministic unlock the re-open flow uses.
      const masterSig = await getOrCreateMetadataMasterSig(
        wallet as any,
        wallet.publicKey.toBase58(),
      );
      const key = await deriveKeyFromMasterSig(masterSig, pda.toBase58());
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
      // After a successful publish, scroll back into view so the user sees
      // the success summary even if they had scrolled past the form.
      requestAnimationFrame(() => {
        formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
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

  /* ─────────────────────────────── render ─────────────────────────────── */

  return (
    <Frame>
      {/* Accessibility-only heading. The two card titles below ("Invoice"
          and "Payroll") already frame the choice visually. */}
      <h1 className="sr-only">Compose a payment</h1>

      {/* Picker — anchored at the top. Stays mounted while the form
          spawns below for either mode. */}
      <section className="max-w-[1400px] mx-auto px-6 md:px-8 pt-24 md:pt-32 pb-16 md:pb-24">
        <CreateModeSelector onSelect={handleSelectMode} />
      </section>

      {/* Form — spawns below for both invoice and payroll modes. The page
          smooth-scrolls down to this section after it mounts. */}
      {mode !== null && (
        <section
          ref={formRef}
          className={[
            "form-reveal border-t border-line scroll-mt-24",
            formExiting ? "is-exiting" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          aria-label={mode === "invoice" ? "Create invoice" : "Run payroll"}
        >
          <div className="max-w-[1400px] mx-auto px-6 md:px-8 pt-12 md:pt-16">
            <button
              type="button"
              onClick={handleBackToPicker}
              className="inline-flex items-center gap-2 font-mono text-[12.5px] tracking-[0.04em] text-muted hover:text-ink transition-colors"
            >
              <span aria-hidden>↑</span> Choose differently
            </button>

            {mode === "invoice" && (
              <div className="mt-8 max-w-3xl">
                <span className="eyebrow">New invoice</span>
                <h2 className="mt-3 font-display font-medium text-ink text-[40px] md:text-[52px] leading-[1.03] tracking-[-0.025em]">
                  {result ? "Invoice sent" : "Create invoice"}
                </h2>
              </div>
            )}
          </div>

          {mode === "invoice" ? (
            <div className="max-w-[1400px] mx-auto px-6 md:px-8 mt-10 md:mt-12 pb-32">
              <div className="max-w-3xl">
                {!wallet.connected ? (
                  <div className="max-w-lg">
                    <p className="text-[17px] md:text-[19px] text-ink/80 leading-[1.5] mb-8">
                      To publish a private invoice, connect the wallet you&apos;ll receive payment to.
                    </p>
                    <ClientWalletMultiButton />
                  </div>
                ) : result ? (
                  <SuccessView
                    result={result}
                    copied={copied}
                    onCopy={handleCopy}
                    onSendAnother={() => {
                      setResult(null);
                      setCopied(false);
                    }}
                  />
                ) : (
                  <InvoiceForm
                    onSubmit={handleSubmit}
                    submitting={submitting}
                    errorMessage={error}
                    onDismissError={() => setError(null)}
                  />
                )}
              </div>
            </div>
          ) : (
            // Payroll: <PayrollFlow /> owns its own heading, wallet gate,
            // form, registration modal, and success states. We only render
            // the back button above it — no eyebrow/h2, since that would
            // double-stack with the component's internal heading.
            <div className="max-w-[1400px] mx-auto px-6 md:px-8 mt-10 md:mt-12 pb-32">
              <PayrollFlow />
            </div>
          )}
        </section>
      )}

      <RegistrationModal open={regOpen} steps={regSteps} />

      {/*
        Form-reveal animation. The arriving section starts 40px below its
        final position with opacity 0 and lands via cubic-bezier(0.16, 1,
        0.3, 1) — Apple's "ease-out-expo" — over 700ms. The curve lingers
        at the end so the form reads as "settling in" rather than snapping.
        prefers-reduced-motion users get the final state instantly.
      */}
      {/*
        Use dangerouslySetInnerHTML to bypass React's HTML-entity escaping
        for the CSS body. Without it, characters like " ' < inside the CSS
        comments get encoded to &quot; &#x27; &lt; on the server but render
        as raw on the client, triggering a hydration mismatch warning. CSS
        does not need HTML entity encoding inside <style> tags.
      */}
      <style
        dangerouslySetInnerHTML={{
          __html: `
        .form-reveal {
          opacity: 0;
          transform: translateY(40px);
          animation: form-reveal-anim 700ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
        /*
          Exit pair to the reveal: runs when the user clicks the back
          button. From state matches the post-reveal resting position so
          the handoff is seamless; to state fades out and drifts down
          24px. Curve mirrors the reveal so the section leaves with the
          same character it arrived. 600ms exit is shorter than 900ms
          unmount delay, so the section is fully invisible before unmount.
        */
        .form-reveal.is-exiting {
          animation: form-exit-anim 600ms cubic-bezier(0.7, 0, 0.84, 0) forwards;
        }
        @keyframes form-reveal-anim {
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        @keyframes form-exit-anim {
          from {
            opacity: 1;
            transform: translateY(0);
          }
          to {
            opacity: 0;
            transform: translateY(24px);
          }
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

/* ─────────────────────────────────────────────────────────────────────
   Layout shell — nav identical to the homepage spec.
   ───────────────────────────────────────────────────────────────────── */

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

/* ─────────────────────────────────────────────────────────────────────
   Success view — rendered inside the form section after a successful
   publish. Extracted so the conditional render inside CreatePage stays
   readable.
   ───────────────────────────────────────────────────────────────────── */

function SuccessView({
  result,
  copied,
  onCopy,
  onSendAnother,
}: {
  result: { url: string; payerName: string; formattedAmount: string };
  copied: boolean;
  onCopy: () => void;
  onSendAnother: () => void;
}) {
  return (
    <div className="max-w-2xl">
      {/* Headline summary — what was created, for whom */}
      <div className="flex items-baseline gap-2 mb-3">
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          className="text-sage shrink-0 translate-y-[1px]"
        >
          <path
            d="M3 7.5l3 3 5-6"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-sage">
          Published privately
        </span>
      </div>
      <h3 className="font-sans font-medium text-ink text-[28px] md:text-[32px] leading-[1.1] tracking-[-0.025em]">
        <span className="tnum">{result.formattedAmount}</span>
        <span className="text-muted"> requested from </span>
        <span>{result.payerName}</span>
      </h3>
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
        <button onClick={onCopy} className="btn-primary">
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
        <button onClick={onSendAnother} className="btn-quiet">
          + Send another
        </button>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Helpers (unchanged from the prior version of this file).
   ───────────────────────────────────────────────────────────────────── */

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
