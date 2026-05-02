"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { VeilLogo } from "@/components/VeilLogo";
import { PublicKey } from "@solana/web3.js";
import { InvoiceView } from "@/components/InvoiceView";
import {
  decryptJson,
  sha256,
  deriveKeyFromWalletSignature,
  getOrCreateMetadataMasterSig,
  deriveKeyFromMasterSig,
} from "@/lib/encryption";
import { fetchCiphertext } from "@/lib/arweave";
import { fetchInvoice } from "@/lib/anchor";
import { downloadInvoicePdf } from "@/lib/pdfDownload";
import type { InvoiceMetadata } from "@/lib/types";

export default function InvoiceCreatorPage({ params }: { params: { id: string } }) {
  const wallet = useWallet();
  const [metadata, setMetadata] = useState<InvoiceMetadata | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("idle");

  useEffect(() => {
    (async () => {
      try {
        setError(null);
        if (!wallet.publicKey) return;

        setStatus("Loading invoice from chain…");
        const invoicePda = new PublicKey(params.id);
        const invoice = await fetchInvoice(wallet as any, invoicePda);

        if (invoice.creator.toBase58() !== wallet.publicKey.toBase58()) {
          setError(
            "This invoice was created by a different wallet. Only the original creator can re-open it this way.",
          );
          setStatus("idle");
          return;
        }

        setStatus("Fetching encrypted metadata…");
        const ciphertext = await fetchCiphertext(invoice.metadataUri);
        const computedHash = await sha256(ciphertext);
        const onChainHash = new Uint8Array(invoice.metadataHash as any);
        const hashMatches = computedHash.every((b, i) => b === onChainHash[i]);
        if (!hashMatches) {
          setError("This invoice has been tampered with. Do NOT trust its contents.");
          setStatus("idle");
          return;
        }

        // Cached metadata master sig (one Phantom popup ever per wallet).
        // Used for invoices created after we shipped the cached-master-sig
        // flow. Older invoices were keyed by per-PDA signMessage — those
        // still work via the legacy fallback below.
        setStatus("Deriving decryption key…");
        let md: InvoiceMetadata | null = null;
        try {
          const masterSig = await getOrCreateMetadataMasterSig(
            wallet as any,
            wallet.publicKey.toBase58(),
          );
          const key = await deriveKeyFromMasterSig(masterSig, invoicePda.toBase58());
          md = (await decryptJson(ciphertext, key)) as InvoiceMetadata;
        } catch {
          // Decryption failure most likely means this invoice predates the
          // cached master-sig migration. Fall back to the legacy per-PDA
          // sign — one extra Phantom popup, but only for old invoices.
          setStatus("Awaiting wallet signature (legacy invoice key)…");
          const legacyKey = await deriveKeyFromWalletSignature(
            wallet as any,
            invoicePda.toBase58(),
          );
          md = (await decryptJson(ciphertext, legacyKey)) as InvoiceMetadata;
        }
        setMetadata(md);
        setStatus("done");
      } catch (err: any) {
        // eslint-disable-next-line no-console
        console.error("[Veil invoice re-open] failed:", err);
        setError(err.message ?? String(err));
        setStatus("idle");
      }
    })();
  }, [params.id, wallet.publicKey]);

  if (error) {
    return (
      <Shell>
        <div className="max-w-2xl mx-auto reveal">
          <div className="flex items-start gap-4 border-l-2 border-brick pl-5 py-3">
            <span className="mono-chip text-brick shrink-0 pt-0.5">Error</span>
            <span className="text-[14.5px] text-ink leading-relaxed flex-1">{error}</span>
          </div>
          <div className="mt-6">
            <a href="/dashboard" className="btn-quiet">
              ← Back to dashboard
            </a>
          </div>
        </div>
      </Shell>
    );
  }

  if (!wallet.connected) {
    return (
      <Shell>
        <div className="max-w-lg mx-auto reveal">
          <span className="eyebrow">Invoice</span>
          <h1 className="mt-4 font-sans font-medium text-ink text-[36px] md:text-[44px] leading-[1.05] tracking-[-0.025em]">
            Connect the creator wallet to view this invoice.
          </h1>
          <p className="mt-5 text-[15px] leading-[1.55] text-ink/70 max-w-md">
            Only the wallet that created this invoice can re-derive its decryption key.
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
          <p className="text-[13.5px] text-muted">{status}</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="max-w-2xl mx-auto reveal">
        <InvoiceView metadata={metadata} />
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => downloadInvoicePdf(metadata, params.id)}
            className="btn-ghost"
          >
            Download PDF
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden>
              <path d="M5.5 1v7M2.5 5.5l3 3 3-3M1.5 10h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <a href="/dashboard" className="btn-quiet">
            ← Back to dashboard
          </a>
        </div>
      </div>
    </Shell>
  );
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
