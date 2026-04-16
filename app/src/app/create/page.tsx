"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { PublicKey } from "@solana/web3.js";
import { InvoiceForm, type InvoiceFormValues } from "@/components/InvoiceForm";
import { RegistrationModal, type RegistrationStep, type StepStatus } from "@/components/RegistrationModal";
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
      // 1. Ensure registered
      const client = await getOrCreateClient(wallet as any);
      setRegOpen(true);
      await ensureRegistered(client, (step, status) => {
        setRegSteps((prev) => ({
          ...prev,
          [step]: status === "pre" ? "in_progress" : "done",
        }));
      });
      setRegOpen(false);

      // 2. Build + validate metadata
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

      // 3. Encrypt + upload
      const key = generateKey();
      const ciphertext = await encryptJson(md, key);
      const { uri } = await uploadCiphertext(ciphertext);
      const hash = await sha256(ciphertext);

      // 4. Anchor create_invoice
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

      // 5. Build shareable URL
      const url = `${window.location.origin}/pay/${pda.toBase58()}#${keyToBase58(key)}`;
      setResult({ url });
    } catch (err: any) {
      setError(err.message ?? String(err));
      setRegOpen(false);
    } finally {
      setSubmitting(false);
    }
  }

  if (!wallet.connected) {
    return (
      <main className="min-h-screen p-8 max-w-2xl mx-auto">
        <h1 className="text-3xl font-bold mb-6">Create Invoice</h1>
        <p className="mb-4">Connect your wallet to continue.</p>
        <ClientWalletMultiButton />
      </main>
    );
  }

  if (result) {
    return (
      <main className="min-h-screen p-8 max-w-2xl mx-auto">
        <h1 className="text-3xl font-bold mb-6">✓ Invoice Created</h1>
        <p className="mb-4">Share this link with the payer:</p>
        <div className="bg-gray-800 p-4 rounded break-all mb-4 font-mono text-sm">{result.url}</div>
        <button
          onClick={() => navigator.clipboard.writeText(result.url)}
          className="px-4 py-2 bg-indigo-600 rounded hover:bg-indigo-700"
        >
          Copy link
        </button>
      </main>
    );
  }

  return (
    <main className="min-h-screen p-8 max-w-2xl mx-auto">
      <h1 className="text-3xl font-bold mb-6">Create Invoice</h1>
      {error && (
        <div className="bg-red-900/30 border border-red-700 p-3 rounded mb-4 text-red-200">{error}</div>
      )}
      <InvoiceForm onSubmit={handleSubmit} submitting={submitting} />
      <RegistrationModal open={regOpen} steps={regSteps} />
    </main>
  );
}
