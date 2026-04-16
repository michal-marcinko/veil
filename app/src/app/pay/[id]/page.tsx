"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import { InvoiceView } from "@/components/InvoiceView";
import { decryptJson, sha256, extractKeyFromFragment } from "@/lib/encryption";
import { fetchCiphertext } from "@/lib/arweave";
import { fetchInvoice } from "@/lib/anchor";
import type { InvoiceMetadata } from "@/lib/types";

export default function PayPage({ params }: { params: { id: string } }) {
  const wallet = useWallet();
  const [metadata, setMetadata] = useState<InvoiceMetadata | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const key = extractKeyFromFragment(window.location.hash);
        if (!key) {
          setError("This invoice link is incomplete. The decryption key is missing.");
          return;
        }

        // Fetch on-chain record (uses read-only provider via connected wallet or stub)
        if (!wallet.publicKey) {
          // We need any wallet to construct a provider; use a dummy read-only
          // approach: create a minimal connection and skip wallet-dependent fetches.
          // For now, require wallet to be connected to read.
          setError("Connect wallet to load invoice");
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

  if (error) {
    return (
      <main className="min-h-screen p-8 max-w-2xl mx-auto">
        <div className="bg-red-900/30 border border-red-700 p-4 rounded">{error}</div>
      </main>
    );
  }

  if (!wallet.connected) {
    return (
      <main className="min-h-screen p-8 max-w-2xl mx-auto">
        <h1 className="text-3xl font-bold mb-6">Pay Invoice</h1>
        <p className="mb-4">Connect your wallet to view and pay this invoice.</p>
        <WalletMultiButton />
      </main>
    );
  }

  if (!metadata) {
    return (
      <main className="min-h-screen p-8 max-w-2xl mx-auto">
        <p className="text-gray-400">Loading invoice...</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen p-8 max-w-2xl mx-auto">
      <InvoiceView metadata={metadata} />
      <div className="mt-6">
        <button
          disabled
          className="w-full px-6 py-3 bg-indigo-600 rounded-lg disabled:opacity-50"
        >
          Pay (enabled in Task 22)
        </button>
      </div>
      {status && <div className="mt-4 text-gray-400">{status}</div>}
    </main>
  );
}
