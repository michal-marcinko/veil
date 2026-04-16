"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
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
import { encryptJson, generateKey, keyToBase58, sha256 } from "@/lib/encryption";
import { uploadCiphertext } from "@/lib/arweave";
import { USDC_MINT } from "@/lib/constants";

export default function CreatePage() {
  const wallet = useWallet();
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ url: string } | null>(null);
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
      const subtotal = values.lineItems.reduce(
        (sum, li) => sum + BigInt(li.unitPrice) * BigInt(li.quantity),
        0n,
      );

      const md = buildMetadata({
        invoiceId,
        creatorDisplayName: values.creatorDisplayName,
        creatorWallet: wallet.publicKey.toBase58(),
        payerDisplayName: values.payerDisplayName,
        payerWallet: values.payerWallet || null,
        mint: USDC_MINT.toBase58(),
        symbol: "USDC",
        decimals: 6,
        lineItems: values.lineItems.map((li) => ({
          description: li.description,
          quantity: li.quantity,
          unitPrice: li.unitPrice,
          total: (BigInt(li.unitPrice) * BigInt(li.quantity)).toString(),
        })),
        subtotal: subtotal.toString(),
        tax: "0",
        total: subtotal.toString(),
        dueDate: values.dueDate || null,
        terms: null,
        notes: values.notes || null,
      });
      validateMetadata(md);

      const key = generateKey();
      const ciphertext = await encryptJson(md, key);
      const { uri } = await uploadCiphertext(ciphertext);
      const hash = await sha256(ciphertext);

      const nonce = crypto.getRandomValues(new Uint8Array(8));
      const restrictedPayer = values.payerWallet ? new PublicKey(values.payerWallet) : null;
      const pda = await createInvoiceOnChain(wallet as any, {
        nonce,
        metadataHash: hash,
        metadataUri: uri,
        mint: USDC_MINT,
        restrictedPayer,
        expiresAt: null,
      });

      const url = `${window.location.origin}/pay/${pda.toBase58()}#${keyToBase58(key)}`;
      setResult({ url });
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
      <Frame heading="Create invoice" number="02">
        <div className="max-w-lg mt-16 animate-fade-up">
          <p className="font-serif italic text-2xl md:text-3xl text-muted leading-[1.3] mb-10">
            To publish a private invoice, first connect the wallet you&apos;ll receive payment to.
          </p>
          <ClientWalletMultiButton />
        </div>
      </Frame>
    );
  }

  if (result) {
    return (
      <Frame heading="Invoice published" number="02">
        <div className="max-w-2xl mt-14 animate-fade-up">
          <div className="mono-chip mb-3">Shareable link</div>
          <div className="border border-line p-5 mb-8 font-mono text-sm text-cream break-all bg-paper">
            {result.url}
          </div>
          <div className="flex flex-wrap gap-3">
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
              className="btn-quiet self-center"
            >
              + Another invoice
            </button>
          </div>

          <ol className="mt-20 space-y-3.5 font-mono text-[12px] tracking-[0.1em] uppercase text-dim leading-relaxed">
            <li className="flex gap-6">
              <span className="text-gold w-6 shrink-0">01</span>
              <span>Metadata encrypted client-side (AES-256-GCM).</span>
            </li>
            <li className="flex gap-6">
              <span className="text-gold w-6 shrink-0">02</span>
              <span>Ciphertext anchored to Arweave · hash on Solana.</span>
            </li>
            <li className="flex gap-6">
              <span className="text-gold w-6 shrink-0">03</span>
              <span>Decryption key in URL fragment — never sent to a server.</span>
            </li>
            <li className="flex gap-6">
              <span className="text-gold w-6 shrink-0">04</span>
              <span>Payment settles via Umbra UTXO · amount hidden onchain.</span>
            </li>
          </ol>
        </div>
      </Frame>
    );
  }

  return (
    <Frame heading="Create invoice" number="02">
      {error && (
        <div className="mb-12 border-l-2 border-brick pl-5 py-3 flex items-baseline gap-4 animate-fade-up">
          <span className="mono-chip text-brick">Error</span>
          <span className="text-sm text-cream leading-relaxed">{error}</span>
        </div>
      )}
      <InvoiceForm onSubmit={handleSubmit} submitting={submitting} />
      <RegistrationModal open={regOpen} steps={regSteps} />
    </Frame>
  );
}

function Frame({
  heading,
  number,
  children,
}: {
  heading: string;
  number: string;
  children: React.ReactNode;
}) {
  return (
    <main className="min-h-screen relative pb-32">
      {/* Top nav */}
      <nav className="sticky top-0 z-10 backdrop-blur-sm bg-ink/70 border-b border-line/60">
        <div className="flex items-center justify-between px-6 md:px-12 py-5">
          <a href="/" className="font-serif text-xl tracking-[0.22em] link-under">
            VEIL
          </a>
          <div className="flex items-center gap-6">
            <span className="mono-chip hidden md:inline">№ {number}</span>
            <a href="/dashboard" className="mono-chip link-under hidden md:inline">
              Dashboard ↗
            </a>
            <ClientWalletMultiButton />
          </div>
        </div>
      </nav>

      {/* Title */}
      <header className="pt-24 md:pt-32 px-6 md:px-12 max-w-5xl">
        <div className="flex items-baseline gap-5 mb-5">
          <span className="section-no">Specimen {number}</span>
          <span className="h-px w-20 bg-line" />
        </div>
        <h1 className="font-serif text-5xl md:text-7xl tracking-tightest animate-fade-up">
          {heading}
        </h1>
      </header>

      {/* Body */}
      <section className="mt-16 md:mt-20 px-6 md:px-12 max-w-3xl">{children}</section>
    </main>
  );
}
