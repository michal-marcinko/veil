"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
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
      // Per the 2026-04-16 design addendum, utxo_commitment in mark_paid is an
      // audit-only breadcrumb, not used for matching. The real PayInvoiceArgs
      // interface does not accept invoicePda and does not return a commitment,
      // so we pass 32 zero bytes as a placeholder.
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
      setError(err.message ?? String(err));
      setRegOpen(false);
    } finally {
      setPaying(false);
    }
  }

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
      {paid ? (
        <div className="mt-6 bg-green-900/30 border border-green-700 p-4 rounded">
          ✓ Payment sent. The recipient will receive this when they open their dashboard.
        </div>
      ) : (
        <div className="mt-6">
          <button
            onClick={handlePay}
            disabled={paying}
            className="w-full px-6 py-3 bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
          >
            {paying ? "Processing..." : `Pay ${BigInt(metadata.total) / 1_000_000n} USDC`}
          </button>
        </div>
      )}
      <RegistrationModal open={regOpen} steps={regSteps} />
      {status && <div className="mt-4 text-gray-400">{status}</div>}
    </main>
  );
}
