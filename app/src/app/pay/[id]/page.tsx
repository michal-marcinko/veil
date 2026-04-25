"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { PublicKey } from "@solana/web3.js";
import { InvoiceView } from "@/components/InvoiceView";
import { RegistrationModal, type RegistrationStep, type StepStatus } from "@/components/RegistrationModal";
import { decryptJson, sha256, extractKeyFromFragment } from "@/lib/encryption";
import { fetchCiphertext } from "@/lib/arweave";
import { fetchInvoice, markPaidOnChain } from "@/lib/anchor";
import { getOrCreateClient, ensureRegistered, payInvoice } from "@/lib/umbra";
import { USDC_MINT } from "@/lib/constants";
import type { InvoiceMetadata } from "@/lib/types";

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

  async function handlePay() {
    if (!metadata || !wallet.publicKey) return;
    setPaying(true);
    setError(null);
    try {
      const client = await getOrCreateClient(wallet as any);
      setRegOpen(true);
      await ensureRegistered(client, (step, st) =>
        setRegSteps((p) => ({ ...p, [step]: st === "pre" ? "in_progress" : "done" })),
      );
      setRegOpen(false);

      const invoicePda = new PublicKey(params.id);
      const utxoCommitment = new Uint8Array(32);
      await payInvoice({
        client,
        recipientAddress: metadata.creator.wallet,
        mint: USDC_MINT.toBase58(),
        amount: BigInt(metadata.total),
      });

      await markPaidOnChain(wallet as any, invoicePda, utxoCommitment);
      setPaid(true);
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error("[Veil pay] full error:", err, "\nlogs:", err?.logs, "\ncause:", err?.cause);
      setError(err.message ?? String(err));
      setRegOpen(false);
    } finally {
      setPaying(false);
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
          <div className="mt-8 border border-sage/40 bg-sage/5 rounded-[3px] p-5 flex items-start gap-3">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="shrink-0 mt-0.5 text-sage">
              <path d="M3 8l3.5 3.5L13 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <div>
              <div className="text-[14px] text-ink font-medium">Payment sent.</div>
              <div className="text-[13px] text-muted mt-1 leading-relaxed">
                The recipient will see it when they next open their dashboard.
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-8">
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
              Settles via Umbra UTXO · amount never broadcast onchain
            </p>
          </div>
        )}
        <RegistrationModal open={regOpen} steps={regSteps} />
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
        <div className="max-w-[1100px] mx-auto flex items-center justify-between px-6 md:px-8 py-4">
          <a href="/" className="flex items-baseline gap-3">
            <span className="font-sans font-semibold text-[17px] tracking-[-0.02em] text-ink">
              Veil
            </span>
            <span className="hidden sm:inline font-mono text-[10.5px] tracking-[0.08em] text-muted">
              — private invoicing
            </span>
          </a>
          <ClientWalletMultiButton />
        </div>
      </nav>

      <section className="max-w-[1100px] mx-auto px-6 md:px-8 pt-16 md:pt-20">{children}</section>
    </main>
  );
}
