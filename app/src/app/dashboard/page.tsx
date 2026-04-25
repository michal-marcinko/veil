"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { DashboardList } from "@/components/DashboardList";
import { fetchInvoicesByCreator } from "@/lib/anchor";
import {
  getOrCreateClient,
  isFullyRegistered,
  scanClaimableUtxos,
  claimUtxos,
  getEncryptedBalance,
} from "@/lib/umbra";
import { USDC_MINT, PAYMENT_SYMBOL, PAYMENT_DECIMALS } from "@/lib/constants";

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
      const all = await fetchInvoicesByCreator(wallet as any, wallet.publicKey);
      setInvoices(all.map((a: any) => ({ pda: a.publicKey, account: a.account })));
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error("[Veil dashboard] fetchInvoicesByCreator failed:", err);
      setError(`Invoice list: ${err.message ?? String(err)}`);
      setLoading(false);
      return;
    }

    try {
      const client = await getOrCreateClient(wallet as any);
      if (await isFullyRegistered(client)) {
        try {
          const scan = await scanClaimableUtxos(client);
          if (scan.publicReceived.length > 0) {
            await claimUtxos({ client, utxos: scan.publicReceived });
          }
        } catch (err: any) {
          // eslint-disable-next-line no-console
          console.error("[Veil dashboard] scan/claim failed:", err);
        }

        try {
          const bal = await getEncryptedBalance(client, USDC_MINT.toBase58());
          setBalance(bal);
        } catch (err: any) {
          // eslint-disable-next-line no-console
          console.error("[Veil dashboard] getEncryptedBalance failed:", err);
          setError(`Balance: ${err.message ?? String(err)}`);
        }
      }
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error("[Veil dashboard] umbra client init failed:", err);
      setError(`Umbra: ${err.message ?? String(err)}`);
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
      <Shell>
        <div className="max-w-lg reveal">
          <span className="eyebrow">Dashboard</span>
          <h1 className="mt-4 font-sans font-medium text-ink text-[40px] md:text-[48px] leading-[1.05] tracking-[-0.03em]">
            Connect to view your invoices.
          </h1>
          <p className="mt-5 text-[15px] leading-[1.55] text-ink/70 max-w-md">
            Your dashboard reads directly from Solana using the wallet you connect.
            Nothing is synced to a server.
          </p>
          <div className="mt-8">
            <ClientWalletMultiButton />
          </div>
        </div>
      </Shell>
    );
  }

  const incoming = invoices.map((i) => ({
    pda: i.pda.toBase58(),
    creator: i.account.creator.toBase58(),
    metadataUri: i.account.metadataUri,
    status: Object.keys(i.account.status)[0] as any,
    createdAt: Number(i.account.createdAt),
  }));

  // Group by batch_id (carried on the URI as a ?batch= query param, stamped
  // there by /payroll/new). Invoices without batch=... are single invoices
  // from /create and are skipped here.
  const batches = new Map<string, { count: number; earliest: number }>();
  for (const inv of incoming) {
    const batchId = extractBatchIdFromUri(inv.metadataUri);
    if (!batchId) continue;
    const prev = batches.get(batchId);
    if (prev) {
      prev.count += 1;
      prev.earliest = Math.min(prev.earliest, inv.createdAt);
    } else {
      batches.set(batchId, { count: 1, earliest: inv.createdAt });
    }
  }
  const batchList = Array.from(batches.entries())
    .map(([batchId, info]) => ({ batchId, ...info }))
    .sort((a, b) => b.earliest - a.earliest);

  return (
    <Shell>
      <div className="flex items-baseline justify-between mb-10 reveal">
        <div>
          <span className="eyebrow">Dashboard</span>
          <h1 className="mt-3 font-sans font-medium text-ink text-[36px] md:text-[44px] leading-[1.05] tracking-[-0.025em]">
            Your invoices.
          </h1>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="btn-ghost text-[13px] px-4 py-2"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {balance !== null && (
        <div className="mb-10 border border-line bg-paper-3 rounded-[4px] p-6 md:p-7 reveal">
          <div className="flex items-baseline justify-between gap-6">
            <div>
              <span className="eyebrow">Private {PAYMENT_SYMBOL} balance</span>
              <div className="mt-3 font-sans tnum text-ink text-[32px] md:text-[40px] font-medium tracking-[-0.02em] leading-none">
                {formatBigintAmount(balance, PAYMENT_DECIMALS)}
                <span className="ml-3 font-mono text-[12px] text-muted tracking-[0.14em] uppercase">
                  {PAYMENT_SYMBOL}
                </span>
              </div>
            </div>
            <span className="inline-flex items-center gap-2 text-[12px] text-sage">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                <path d="M2 6l3 3 5-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>Encrypted · readable only by you</span>
            </span>
          </div>
        </div>
      )}

      {error && (
        <div className="mb-8 flex items-start gap-4 border-l-2 border-brick pl-4 py-2 max-w-2xl">
          <span className="mono-chip text-brick shrink-0 pt-0.5">Error</span>
          <span className="text-[13.5px] text-ink leading-relaxed flex-1">{error}</span>
        </div>
      )}

      <DashboardList title="Invoices you created" invoices={incoming} />

      {batchList.length > 0 && (
        <div className="mt-14">
          <div className="flex items-baseline justify-between mb-6 border-b border-line pb-3">
            <span className="eyebrow">Payrolls</span>
            <a href="/payroll/new" className="btn-quiet text-[12px]">
              + New batch
            </a>
          </div>
          <ul className="divide-y divide-line/60">
            {batchList.map((b) => (
              <li key={b.batchId} className="py-4 grid grid-cols-[1fr_auto_auto] gap-4 items-baseline">
                <a
                  href={`/payroll/${b.batchId}`}
                  className="font-mono text-[13px] text-ink hover:text-gold transition-colors truncate"
                >
                  {b.batchId}
                </a>
                <span className="font-mono text-[12px] text-dim tabular-nums">
                  {b.count} invoice{b.count === 1 ? "" : "s"}
                </span>
                <a href={`/payroll/${b.batchId}`} className="btn-quiet text-[12px]">
                  Open →
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-10 pt-8 border-t border-line">
        <a href="/dashboard/compliance" className="btn-quiet">
          Manage auditor grants →
        </a>
      </div>
    </Shell>
  );
}

function extractBatchIdFromUri(uri: string): string | null {
  const q = uri.indexOf("?");
  if (q === -1) return null;
  const search = new URLSearchParams(uri.slice(q + 1));
  return search.get("batch");
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
          <div className="flex items-center gap-1 md:gap-2">
            <a
              href="/create"
              className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors"
            >
              Create
            </a>
            <a
              href="/dashboard"
              className="hidden sm:inline-block px-3 py-2 text-[13px] text-ink"
            >
              Dashboard
            </a>
            <div className="ml-2">
              <ClientWalletMultiButton />
            </div>
          </div>
        </div>
      </nav>

      <section className="max-w-[1100px] mx-auto px-6 md:px-8 pt-16 md:pt-20">{children}</section>
    </main>
  );
}

function formatBigintAmount(amount: bigint | null, decimals: number): string {
  if (amount == null) return "0";
  const divisor = 10n ** BigInt(decimals);
  const whole = amount / divisor;
  const frac = amount % divisor;
  const display = Math.min(4, decimals);
  const padded = frac.toString().padStart(decimals, "0").slice(0, display);
  return `${whole.toString()}.${padded}`;
}
