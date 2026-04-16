"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { DashboardList } from "@/components/DashboardList";
import { fetchInvoicesByCreator } from "@/lib/anchor";
import {
  getOrCreateClient,
  isFullyRegistered,
  scanClaimableUtxos,
  claimUtxos,
  getEncryptedBalance,
} from "@/lib/umbra";
import { USDC_MINT } from "@/lib/constants";

export default function DashboardPage() {
  const wallet = useWallet();
  const [invoices, setInvoices] = useState<any[]>([]);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    if (!wallet.publicKey) return;
    setLoading(true);
    setError(null);
    try {
      // Fetch all invoices where this wallet is the creator
      const all = await fetchInvoicesByCreator(wallet as any, wallet.publicKey);
      setInvoices(all.map((a: any) => ({ pda: a.publicKey, account: a.account })));

      // If registered, scan and auto-claim ALL received UTXOs (no PDA filtering,
      // per the 2026-04-16 design addendum — UTXO↔invoice linkage happens
      // off-chain via markPaidOnChain, not via optionalData).
      const client = await getOrCreateClient(wallet as any);
      if (await isFullyRegistered(client)) {
        const scan = await scanClaimableUtxos(client);
        if (scan.publicReceived.length > 0) {
          await claimUtxos({ client, utxos: scan.publicReceived });
        }

        const bal = await getEncryptedBalance(client, USDC_MINT.toBase58());
        setBalance(bal);
      }
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30000);
    return () => clearInterval(interval);
  }, [wallet.publicKey]);

  if (!wallet.connected) {
    return (
      <main className="min-h-screen p-8 max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold mb-6">Dashboard</h1>
        <p className="mb-4">Connect your wallet to see your invoices.</p>
        <WalletMultiButton />
      </main>
    );
  }

  const incoming = invoices.map((i) => ({
    pda: i.pda.toBase58(),
    creator: i.account.creator.toBase58(),
    metadataUri: i.account.metadataUri,
    status: Object.keys(i.account.status)[0] as any,
    createdAt: Number(i.account.createdAt),
  }));

  return (
    <main className="min-h-screen p-8 max-w-4xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <button
          onClick={refresh}
          disabled={loading}
          className="px-4 py-2 bg-gray-800 rounded hover:bg-gray-700 disabled:opacity-50"
        >
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {balance !== null && (
        <div className="mb-6 bg-gray-900 border border-gray-800 rounded p-4">
          <div className="text-sm text-gray-500">Private USDC balance</div>
          <div className="text-2xl font-mono">{(Number(balance) / 1e6).toFixed(2)} USDC</div>
        </div>
      )}

      {error && (
        <div className="bg-red-900/30 border border-red-700 p-3 rounded mb-4 text-red-200">
          {error}
        </div>
      )}

      <DashboardList title="Invoices I created" invoices={incoming} />

      <div className="mt-6">
        <a
          href="/dashboard/compliance"
          className="text-indigo-400 hover:text-indigo-300"
        >
          → Manage compliance grants
        </a>
      </div>
    </main>
  );
}
