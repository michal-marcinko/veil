"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { VeilLogo } from "@/components/VeilLogo";
import { PublicKey } from "@solana/web3.js";
import { InvoiceView } from "@/components/InvoiceView";
import { RegistrationModal, type RegistrationStep, type StepStatus } from "@/components/RegistrationModal";
import {
  PaymentProgressModal,
  type PayStep,
  type PayStepStatus,
} from "@/components/PaymentProgressModal";
import { decryptJson, sha256, extractKeyFromFragment } from "@/lib/encryption";
import { fetchCiphertext } from "@/lib/arweave";
import { fetchInvoice } from "@/lib/anchor";
import {
  getOrCreateClient,
  ensureRegistered,
  ensureReceiverKeyAligned,
  payInvoice,
  payInvoiceFromShielded,
  debugDumpIndexerTail,
  __veilResetPopupCounter,
  __veilPopupCountSnapshot,
} from "@/lib/umbra";
import { loadShieldedAvailability, type ShieldedAvailability } from "@/lib/shielded-pay";
import { USDC_MINT } from "@/lib/constants";
import { downloadInvoicePdf } from "@/lib/pdfDownload";
import type { InvoiceMetadata } from "@/lib/types";
import { buildReceipt, signReceipt, encodeReceipt, type SignedReceipt } from "@/lib/receipt";
import { fetchTxBlockTime } from "@/lib/anchor";
import bs58 from "bs58";

export default function PayPage({ params }: { params: { id: string } }) {
  const wallet = useWallet();
  const [metadata, setMetadata] = useState<InvoiceMetadata | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [regOpen, setRegOpen] = useState(false);
  const [regSteps, setRegSteps] = useState<Record<RegistrationStep, StepStatus>>({
    init: "pending",
    x25519: "pending",
    commitment: "pending",
  });
  const [paid, setPaid] = useState(false);
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null);
  const [receiptBuildError, setReceiptBuildError] = useState<string | null>(null);
  const [generatingReceipt, setGeneratingReceipt] = useState(false);
  const [paymentIntentSig, setPaymentIntentSig] = useState<string | null>(null);
  const [shielded, setShielded] = useState<ShieldedAvailability | null>(null);
  const [useShielded, setUseShielded] = useState(true); // default ON when available

  // Payment-progress modal state. Stays open through the entire deposit
  // flow (including all 2-3 Phantom popups) so the user is never left
  // staring at a static page wondering if anything is happening.
  const [payOpen, setPayOpen] = useState(false);
  const [payProgress, setPayProgress] = useState<Record<PayStep, PayStepStatus>>({
    build: "pending",
    "sign-proof": "pending",
    "sign-deposit": "pending",
    confirm: "pending",
  });

  useEffect(() => {
    (async () => {
      try {
        setError(null);

        const key = extractKeyFromFragment(window.location.hash);
        if (!key) {
          setError("This invoice link is incomplete. The decryption key is missing.");
          return;
        }

        if (!wallet.publicKey) {
          // Wallet not connected yet — let the "connect wallet" branch render.
          return;
        }

        const invoicePda = new PublicKey(params.id);
        const invoice = await fetchInvoice(wallet as any, invoicePda);

        if ("paid" in (invoice.status as any)) {
          setError("This invoice has already been paid.");
          return;
        }
        if ("cancelled" in (invoice.status as any)) {
          setError("This invoice has been cancelled.");
          return;
        }

        const ciphertext = await fetchCiphertext(invoice.metadataUri);
        const computedHash = await sha256(ciphertext);
        const onChainHash = new Uint8Array(invoice.metadataHash as any);
        const hashMatches = computedHash.every((byte, i) => byte === onChainHash[i]);
        if (!hashMatches) {
          setError("This invoice has been tampered with. Do NOT pay.");
          return;
        }

        const md = (await decryptJson(ciphertext, key)) as InvoiceMetadata;
        setMetadata(md);
      } catch (err: any) {
        setError(err.message ?? String(err));
      }
    })();
  }, [params.id, wallet.publicKey]);

  useEffect(() => {
    (async () => {
      if (!metadata || !wallet.publicKey) return;
      try {
        const client = await getOrCreateClient(wallet as any);
        const result = await loadShieldedAvailability({
          client,
          mint: metadata.currency.mint,
          total: BigInt(metadata.total),
        });
        setShielded(result);
      } catch {
        // loadShieldedAvailability swallows its own errors, but
        // getOrCreateClient can throw (e.g. wallet disconnected mid-flow).
        setShielded({ kind: "errored", message: "client unavailable" });
      }
    })();
  }, [metadata, wallet.publicKey]);

  async function handlePay() {
    if (!metadata || !wallet.publicKey) return;
    setPaying(true);
    setError(null);

    // ─── DIAGNOSTIC INSTRUMENTATION ────────────────────────────────
    // Every wallet sign request gets numbered + timestamped so we can
    // correlate console output with visible Phantom popups. The wrap
    // is restored in the finally{} block.
    const t0 = Date.now();
    const elapsed = () => `+${(Date.now() - t0).toString().padStart(5, "0")}ms`;
    const log = (msg: string, ...args: any[]) =>
      // eslint-disable-next-line no-console
      console.log(`[Veil pay ${elapsed()}] ${msg}`, ...args);
    log("════════════════ pay flow start ════════════════");
    log(`recipient=${metadata.creator.wallet}`);
    log(`amount=${metadata.total} (raw, base units)`);
    log(`mint=${USDC_MINT.toBase58()}`);
    log(`useShielded=${useShielded} shielded=${shielded?.kind ?? "null"}`);

    // Reset the module-level popup counter that lives inside
    // createFixedWalletStandardSigner (the ONLY place we can reliably
    // count popups — the SDK reaches Phantom via Wallet Standard,
    // bypassing wallet.signTransaction entirely).
    __veilResetPopupCounter();

    try {
      log("Step A: getOrCreateClient (may sign master-seed message)");
      const client = await getOrCreateClient(wallet as any);
      log("Step A done");

      setRegOpen(true);
      log("Step B: ensureRegistered");
      await ensureRegistered(client, (step, st) => {
        log(`  registration step ${step} → ${st}`);
        setRegSteps((p) => ({ ...p, [step]: st === "pre" ? "in_progress" : "done" }));
      });
      log("Step B done");

      try {
        const { diagnoseUmbraReceiver } = await import("@/lib/umbra");
        const diag = await diagnoseUmbraReceiver(client);
        log("Bob's on-chain key state:", diag);
      } catch (e) {
        log("diagnoseUmbraReceiver failed:", e);
      }

      log("Step C: ensureReceiverKeyAligned");
      const align = await ensureReceiverKeyAligned(client);
      log("Step C done — align result:", align);
      if (align.rotated) {
        setStatus(
          "Refreshed your encryption key on-chain so the recipient can decrypt. One-time step.",
        );
      }
      setRegOpen(false);

      // ─── HAND-OFF: registration done, payment starts ─────────────
      // Open the payment-progress modal BEFORE the SDK call so the
      // user has visible context throughout the Phantom popup storm.
      log("Opening payment progress modal");
      setPayProgress({
        build: "in_progress",
        "sign-proof": "pending",
        "sign-deposit": "pending",
        confirm: "pending",
      });
      setPayOpen(true);

      // Drive step transitions from the REAL popup counter (not timers).
      // Measured 3 popups on the shielded path, 2-3 on public. Map:
      //   count 0 → build phase still
      //   count 1 → first popup is open or signed
      //   count 2 → second popup is open or signed
      //   count ≥ 3 → all signing in flight
      const ticker = window.setInterval(() => {
        const snap = __veilPopupCountSnapshot();
        if (snap.count === 0) return;
        if (snap.count === 1) {
          setPayProgress((p) =>
            p["sign-proof"] === "pending"
              ? { ...p, build: "done", "sign-proof": "in_progress" }
              : p,
          );
        } else if (snap.count === 2) {
          setPayProgress((p) =>
            p["sign-deposit"] === "pending"
              ? { ...p, build: "done", "sign-proof": "done", "sign-deposit": "in_progress" }
              : p,
          );
        }
      }, 200);

      const invoicePda = new PublicKey(params.id);

      const payArgs = {
        client,
        recipientAddress: metadata.creator.wallet,
        mint: USDC_MINT.toBase58(),
        amount: BigInt(metadata.total),
      };

      const shouldUseShielded =
        useShielded && shielded?.kind === "available";

      log(`Step D: calling ${shouldUseShielded ? "payInvoiceFromShielded" : "payInvoice"}`);
      log("(Phantom popups fire from inside the SDK — each one logs as [Veil popup #N])");
      const payResult = shouldUseShielded
        ? await payInvoiceFromShielded(payArgs)
        : await payInvoice(payArgs);
      const popupSnap = __veilPopupCountSnapshot();
      log(`Step D done — total Phantom popups during pay: ${popupSnap.count} over ${popupSnap.sinceMs}ms`);
      log("payResult:", payResult);

      window.clearInterval(ticker);
      setPayProgress({
        build: "done",
        "sign-proof": "done",
        "sign-deposit": "done",
        confirm: "in_progress",
      });

      if (process.env.NEXT_PUBLIC_VEIL_DEBUG === "1") {
        await debugDumpIndexerTail(client, 8);
      }

      setPaymentIntentSig(payResult.createUtxoSignature);
      setPaid(true);

      // Keep the "all done" state visible for ~1.4s before unmounting,
      // so the user gets visual confirmation rather than a blink-and-gone.
      setPayProgress((p) => ({ ...p, confirm: "done" }));
      window.setTimeout(() => setPayOpen(false), 1400);
      log("════════════════ pay flow complete ════════════════");
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error(`[Veil pay ${elapsed()}] ✗ FAILED`, err, "\nlogs:", err?.logs, "\ncause:", err?.cause);
      setError(err.message ?? String(err));
      setRegOpen(false);
      setPayOpen(false);
    } finally {
      const final = __veilPopupCountSnapshot();
      setPaying(false);
      log(`Pay flow returned — total elapsed: ${Date.now() - t0}ms, total Phantom popups: ${final.count}`);
    }
  }

  // Lazy receipt generation. Triggers the wallet's signMessage popup ONLY
  // when Bob actually wants the receipt URL — most users never need it.
  // Lifted out of `handlePay` to keep the pay path at 2 popups instead of 3
  // (proof-account tx + deposit tx + previously the receipt sign).
  async function handleGenerateReceipt() {
    if (!wallet.publicKey || !paymentIntentSig) return;
    setGeneratingReceipt(true);
    setReceiptBuildError(null);
    try {
      const invoicePda = new PublicKey(params.id);
      // Hash metadata_uri || metadata_hash so the receipt is tamper-evident
      // against the on-chain anchor (verified by the receipt verifier).
      const invoice = await fetchInvoice(wallet as any, invoicePda);
      const uriBytes = new TextEncoder().encode(invoice.metadataUri);
      const hashBytes = new Uint8Array(invoice.metadataHash as any);
      const combined = new Uint8Array(uriBytes.length + hashBytes.length);
      combined.set(uriBytes, 0);
      combined.set(hashBytes, uriBytes.length);
      const invoiceHash = await sha256(combined);

      const blockTime = await fetchTxBlockTime(paymentIntentSig);
      const timestamp = blockTime ?? Math.floor(Date.now() / 1000);

      const receipt = buildReceipt({
        invoicePda: invoicePda.toBase58(),
        payerPubkey: wallet.publicKey.toBase58(),
        markPaidTxSig: paymentIntentSig,
        timestamp,
        invoiceHash: bs58.encode(invoiceHash),
      });
      const signed: SignedReceipt = await signReceipt(receipt, wallet as any);
      const blob = encodeReceipt(signed);
      setReceiptUrl(`${window.location.origin}/receipt/${invoicePda.toBase58()}#${blob}`);
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error("[Veil receipt] build/sign failed:", err);
      setReceiptBuildError(err.message ?? String(err));
    } finally {
      setGeneratingReceipt(false);
    }
  }

  if (error) {
    return (
      <Shell>
        <div className="max-w-2xl mx-auto reveal">
          <div className="flex items-start gap-4 border-l-2 border-brick pl-5 py-3">
            <span className="mono-chip text-brick shrink-0 pt-0.5">Error</span>
            <span className="text-[14.5px] text-ink leading-relaxed flex-1">{error}</span>
          </div>
        </div>
      </Shell>
    );
  }

  if (!wallet.connected) {
    return (
      <Shell>
        <div className="max-w-lg mx-auto reveal">
          <span className="eyebrow">Pay invoice</span>
          <h1 className="mt-4 font-sans font-medium text-ink text-[36px] md:text-[44px] leading-[1.05] tracking-[-0.025em]">
            Connect to view this invoice.
          </h1>
          <p className="mt-5 text-[15px] leading-[1.55] text-ink/70 max-w-md">
            The invoice is encrypted. Your wallet unlocks it locally — the amount is
            never decrypted on a server.
          </p>
          <div className="mt-8">
            <ClientWalletMultiButton />
          </div>
        </div>
      </Shell>
    );
  }

  if (!metadata) {
    return (
      <Shell>
        <div className="max-w-2xl mx-auto reveal">
          <p className="text-[13.5px] text-muted">Decrypting invoice…</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="max-w-2xl mx-auto reveal">
        <InvoiceView metadata={metadata} />
        {paid ? (
          <div className="mt-8 border border-sage/40 bg-sage/5 rounded-[3px] p-5">
            <div className="flex items-start gap-3">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="shrink-0 mt-0.5 text-sage">
                <path d="M3 8l3.5 3.5L13 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <div className="flex-1">
                <div className="text-[14px] text-ink font-medium">Payment sent.</div>
                <div className="text-[13px] text-muted mt-1 leading-relaxed">
                  The recipient&apos;s dashboard will pick this up and mark the invoice
                  paid within ~30 seconds — no action needed from them.
                </div>
              </div>
            </div>

            {receiptUrl ? (
              <div className="mt-5 pt-5 border-t border-sage/30">
                <div className="text-[12px] font-mono tracking-[0.1em] uppercase text-dim mb-2">
                  Receipt URL
                </div>
                <div className="flex items-start gap-2">
                  <input
                    readOnly
                    value={receiptUrl}
                    onFocus={(e) => e.currentTarget.select()}
                    className="flex-1 text-[12px] font-mono bg-paper border border-line rounded-[2px] px-2 py-1.5 text-ink truncate"
                  />
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(receiptUrl);
                      setStatus("Receipt URL copied.");
                    }}
                    className="text-[12px] font-mono tracking-[0.05em] uppercase px-3 py-1.5 border border-line rounded-[2px] text-ink hover:bg-line/30"
                  >
                    Copy
                  </button>
                </div>
                <div className="mt-3 text-[12px] text-muted leading-relaxed">
                  Share this link to prove you paid this invoice. The amount is hidden;
                  it verifies after the recipient claims the UTXO and marks the invoice paid.
                </div>
              </div>
            ) : (
              <div className="mt-5 pt-5 border-t border-sage/30">
                <button
                  onClick={handleGenerateReceipt}
                  disabled={generatingReceipt}
                  className="text-[12px] font-mono tracking-[0.05em] uppercase px-3 py-1.5 border border-line rounded-[2px] text-ink hover:bg-line/30 disabled:opacity-60"
                >
                  {generatingReceipt ? "Generating…" : "Generate signed receipt"}
                </button>
                <div className="mt-3 text-[12px] text-muted leading-relaxed">
                  Optional. Generates a sharable URL that cryptographically proves
                  this wallet paid this invoice. One extra wallet signature.
                </div>
                {receiptBuildError && (
                  <div className="mt-3 text-[12px] text-brick leading-relaxed">
                    Receipt build failed: {receiptBuildError}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="mt-8">
            {shielded?.kind === "available" && (
              <label className="flex items-start gap-3 mb-5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={useShielded}
                  onChange={(e) => setUseShielded(e.target.checked)}
                  disabled={paying}
                  className="mt-1 accent-sage"
                />
                <span className="text-[13.5px] leading-relaxed">
                  <span className="text-ink">Pay from shielded balance</span>
                  <span className="ml-2 mono-chip text-sage">Recommended</span>
                  <span className="block text-[12px] text-muted mt-0.5">
                    No public deposit. Amount never appears on a block explorer.
                  </span>
                </span>
              </label>
            )}
            <button
              onClick={handlePay}
              disabled={paying}
              className="btn-primary w-full md:w-auto md:min-w-[340px]"
            >
              {paying ? (
                <span className="inline-flex items-center gap-3">
                  <span className="h-1.5 w-1.5 rounded-full bg-paper animate-slow-pulse" />
                  Processing…
                </span>
              ) : (
                <span>
                  Pay {formatAmount(metadata.total, metadata.currency.decimals)} {metadata.currency.symbol} <span aria-hidden>→</span>
                </span>
              )}
            </button>
            <p className="mt-4 max-w-xl text-[12px] font-mono tracking-[0.12em] uppercase text-dim">
              {shielded?.kind === "available" && useShielded
                ? "From shielded balance · no public deposit"
                : "From public balance · one deposit tx"}
            </p>
          </div>
        )}
        <div className="mt-6">
          <button
            type="button"
            onClick={() => downloadInvoicePdf(metadata, params.id)}
            className="btn-quiet"
          >
            Download PDF →
          </button>
        </div>
        <RegistrationModal open={regOpen} steps={regSteps} />
        <PaymentProgressModal
          open={payOpen}
          steps={payProgress}
          amountLabel={
            metadata
              ? `${formatAmount(metadata.total, metadata.currency.decimals)} ${metadata.currency.symbol}`
              : ""
          }
          recipientLabel={metadata?.creator?.display_name || metadata?.creator?.wallet?.slice(0, 8) || "recipient"}
          isShielded={useShielded && shielded?.kind === "available"}
        />
        {status && <div className="mt-4 text-[13px] text-muted">{status}</div>}
      </div>
    </Shell>
  );
}

function formatAmount(units: string, decimals: number): string {
  const n = BigInt(units);
  const divisor = 10n ** BigInt(decimals);
  const whole = n / divisor;
  const frac = (n % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen relative pb-32">
      <nav className="sticky top-0 z-10 backdrop-blur-sm bg-paper/80 border-b border-line">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between px-6 md:px-8 py-4">
          <VeilLogo />
          <ClientWalletMultiButton />
        </div>
      </nav>

      <section className="max-w-[1400px] mx-auto px-6 md:px-8 pt-16 md:pt-20">{children}</section>
    </main>
  );
}
