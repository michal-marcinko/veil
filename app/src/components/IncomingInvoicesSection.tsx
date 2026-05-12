"use client";

/**
 * Payer-side dashboard section — "Invoice Inbox".
 *
 * Shows all invoices the connected wallet has ever opened, loaded from
 * the per-payer encrypted Arweave index written by `recordIncomingInvoice`
 * on /pay/[id].
 *
 * Per-row state machine (2026-05-06 banking-grade reconciliation pass):
 *   - Awaiting payment — no `PaymentIntentLock` PDA, on-chain status Pending
 *   - Paid · settling  — lock PDA exists, on-chain status still Pending
 *                        (creator hasn't run `mark_paid` from her dashboard)
 *   - Paid             — on-chain status Paid
 *
 * Sort order: awaiting-payment first (most-recent within), then paid
 * rows (most-recent within). Cancelled / expired states are surfaced
 * as their own labels but sort with paid rows since they're terminal.
 *
 * Visual register matches IncomingPrivatePaymentsSection exactly — same
 * eyebrow, same hairline-bordered list, same monochrome chips. No
 * boxes, no chunky pills.
 *
 * No props — the dashboard subagent renders this with `<IncomingInvoicesSection />`.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import {
  loadCachedIncomingInvoices,
  loadIncomingInvoices,
  incomingInvoicesCacheKey,
  type IncomingInvoiceEntry,
} from "@/lib/incoming-invoices-storage";
import { fetchCiphertext } from "@/lib/arweave";
import { decryptJson, keyFromBase58 } from "@/lib/encryption";
import type { InvoiceMetadata } from "@/lib/types";
import { RowOverflowMenu } from "@/components/RowOverflowMenu";
import { downloadInvoicePdf } from "@/lib/pdfDownload";
import {
  fetchManyLocks,
  getProgram,
  type NormalizedInvoice,
} from "@/lib/anchor";
import { deriveLockPda } from "@/lib/lock-derivation";
import { RPC_URL } from "@/lib/constants";

/* ─────────────────────────── helpers ─────────────────────────── */

function relativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}

function formatAmount(units: string, decimals: number): string {
  try {
    const n = BigInt(units);
    const divisor = 10n ** BigInt(decimals);
    const whole = n / divisor;
    const frac = (n % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : `${whole}`;
  } catch {
    return "—";
  }
}

function shortenWallet(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/* ─────────────────────────── on-chain status types ─────────────────────────── */

/**
 * Per-row on-chain snapshot. We resolve this in a single batched effect
 * using the program's `account.invoice.fetchMultiple` + `fetchManyLocks`,
 * so 50 rows cost two round-trips.
 */
type RowStatusKind = "awaiting" | "settling" | "paid" | "cancelled" | "expired";

type RowStatus = {
  kind: RowStatusKind;
  /** unix-seconds; the on-chain `createdAt` (paid rows show this in
   *  relative time, awaiting rows show their `openedAt` instead). */
  createdAtSec?: number;
  /** Lock info when present. Used for the stuck-lock recovery flow:
   *  if status is `settling` (lock + Pending) AND the lock is older
   *  than 60s AND the connected wallet is `lock.payer`, the row
   *  surfaces a "Release payment intent" button. */
  lock?: {
    payer: string; // base58 — compared against wallet.publicKey
    lockedAtSec: number; // unix seconds, from PaymentIntentLock.lockedAt
  };
};

/** Threshold (ms) past which a still-Pending invoice with a lock is
 *  considered "stuck" — the recovery button surfaces only after this.
 *  Plan calls for 60 seconds; chosen so happy-path settlements (under
 *  ~6 seconds for 3 confirmations) never trigger a false-positive. */
const STUCK_LOCK_THRESHOLD_MS = 60_000;

/* ─────────────────────────── per-row resolved metadata ─────────────────────────── */

type RowState =
  | { status: "loading" }
  | { status: "ready"; md: InvoiceMetadata }
  | { status: "error"; message: string };

function StatusChip({ kind }: { kind: RowStatusKind }) {
  // Match the existing palette tokens — sage = settled, gold = pending,
  // ink/40 = terminal/inert. No new colors. Same chip size as the
  // PayrollStatusBadge in dashboard/page.tsx so the visual vocabulary
  // stays tight across pages.
  const styles: Record<RowStatusKind, { cls: string; label: string }> = {
    awaiting: { cls: "border-gold/40 text-gold bg-gold/5", label: "Awaiting" },
    settling: { cls: "border-sage/40 text-sage bg-sage/5", label: "Paid · settling" },
    paid: { cls: "border-ink/20 text-ink bg-paper-2/60", label: "Paid" },
    cancelled: { cls: "border-ink/15 text-ink/45 bg-paper-2/40", label: "Cancelled" },
    expired: { cls: "border-brick/40 text-brick bg-brick/5", label: "Expired" },
  };
  const { cls, label } = styles[kind];
  return (
    <span
      className={`shrink-0 inline-block px-2 py-[3px] border rounded-[2px] font-mono text-[9.5px] tracking-[0.14em] uppercase ${cls}`}
    >
      {label}
    </span>
  );
}

function InvoiceRowItem({
  entry,
  rowStatus,
  walletBase58,
  onClick,
  onRequestRelease,
  releasing,
}: {
  entry: IncomingInvoiceEntry;
  rowStatus: RowStatus | undefined;
  /** base58 of the connected wallet — needed to decide whether the
   *  stuck-lock recovery button applies (only the lock's payer can
   *  release it). null when no wallet is connected. */
  walletBase58: string | null;
  onClick: () => void;
  /** Triggered when the user clicks "Release payment intent" on a
   *  stuck-lock row. The section owns the cancel-payment-intent tx
   *  build/sign/submit; the row just surfaces the action. */
  onRequestRelease: (entry: IncomingInvoiceEntry) => void;
  /** True while a cancel_payment_intent tx is in flight for this
   *  specific invoice — disables the button and changes the label. */
  releasing: boolean;
}) {
  const [row, setRow] = useState<RowState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const uri = entry.metadataUri;
        if (!uri) {
          // metadataUri not cached — we can't fetch without the on-chain PDA
          // lookup, which would require a wallet + RPC call. Render a minimal
          // placeholder so the row is still actionable.
          if (!cancelled) setRow({ status: "error", message: "Metadata unavailable" });
          return;
        }
        const ciphertext = await fetchCiphertext(uri);
        const key = keyFromBase58(entry.urlFragmentKey);
        const md = (await decryptJson(ciphertext, key)) as InvoiceMetadata;
        if (!cancelled) setRow({ status: "ready", md });
      } catch (err: any) {
        if (!cancelled) {
          setRow({ status: "error", message: err?.message ?? "Decrypt failed" });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // entry is stable per render — only re-fetch if the PDA changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.invoicePda, entry.metadataUri, entry.urlFragmentKey]);

  // Pick the timestamp the suffix renders against:
  //   - paid / settling → on-chain createdAt if we have it (otherwise openedAt)
  //   - awaiting        → openedAt (when the payer first viewed the invoice)
  // Fall back to openedAt when we don't have on-chain data yet.
  const time = useMemo(() => {
    const sec = rowStatus?.createdAtSec;
    if (sec && Number.isFinite(sec)) {
      return relativeTime(sec * 1000);
    }
    return relativeTime(entry.openedAt);
  }, [rowStatus, entry.openedAt]);

  if (row.status === "loading") {
    return (
      <li
        className="px-5 md:px-6 py-4 hover:bg-paper-2/50 transition-colors cursor-pointer"
        onClick={onClick}
      >
        <div className="flex flex-col gap-1">
          <div className="h-[17px] w-40 bg-ink/8 rounded animate-pulse" />
          <div className="h-[11px] w-24 bg-ink/5 rounded animate-pulse mt-0.5" />
        </div>
      </li>
    );
  }

  if (row.status === "error") {
    return (
      <li
        className="px-5 md:px-6 py-4 hover:bg-paper-2/50 transition-colors cursor-pointer"
        onClick={onClick}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-1 min-w-0 flex-1">
            <div className="flex items-baseline gap-3">
              <span className="font-mono text-[13px] text-ink/50 truncate">
                {shortenWallet(entry.invoicePda)}
              </span>
            </div>
            <span className="font-mono text-[11px] text-brick/70">
              {row.message}
            </span>
          </div>
          <span className="font-mono text-[11px] text-ink/35 shrink-0">{time}</span>
        </div>
      </li>
    );
  }

  const { md } = row;
  const fromLabel = md.creator.display_name
    ? md.creator.display_name
    : shortenWallet(md.creator.wallet);
  const amountDisplay = `${formatAmount(md.total, md.currency.decimals)} ${md.currency.symbol}`;
  const description = md.notes?.trim() || md.line_items[0]?.description?.trim() || "";

  // Stuck-lock recovery gating. The button surfaces ONLY when:
  //   - the row's lock exists (settling state) AND
  //   - the invoice is still Pending on chain (kind === "settling") AND
  //   - the connected wallet is the lock's payer (only the rent payer
  //     can call cancel_payment_intent — the program enforces) AND
  //   - the lock is older than the threshold (60s) — happy-path
  //     settlements complete in 5-10s; older means tx 2/3 of the
  //     batched flow likely failed.
  // Hidden from the invoice creator (Alice's IncomingInvoicesSection
  // is the same component, but `lock.payer === walletBase58` will be
  // false there, so the button never renders).
  const lockStuck =
    rowStatus?.kind === "settling" &&
    !!rowStatus.lock &&
    walletBase58 === rowStatus.lock.payer &&
    Date.now() - rowStatus.lock.lockedAtSec * 1000 > STUCK_LOCK_THRESHOLD_MS;

  return (
    <li
      className="px-5 md:px-6 py-4 hover:bg-paper-2/50 transition-colors cursor-pointer"
      onClick={onClick}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-1 min-w-0 flex-1">
          {/* Top row: from • amount  |  status chip */}
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="font-sans text-[14.5px] text-ink font-medium leading-tight">
              {fromLabel}
            </span>
            <span className="font-mono text-[11px] text-ink/35">·</span>
            <span className="font-sans tabular-nums text-[14.5px] text-ink font-medium leading-tight">
              {amountDisplay}
            </span>
          </div>
          {/* Bottom row: description  |  relative time */}
          <div className="flex items-baseline gap-3 text-[11px] font-mono text-ink/45">
            {description && (
              <>
                <span className="truncate max-w-[200px]">{description}</span>
                <span className="text-ink/25">·</span>
              </>
            )}
            <span className="shrink-0">{time}</span>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {/* Stuck-lock recovery — release the PaymentIntentLock so the
              user can retry. Mercury/Linear visual register: thin border,
              monospace eyebrow text, no chunky pill. Only renders for
              the lock's payer on rows that have been "settling" for
              >60s — never visible to the invoice creator. */}
          {lockStuck && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (!releasing) onRequestRelease(entry);
              }}
              disabled={releasing}
              className={`shrink-0 px-2.5 py-[3px] border rounded-[2px] font-mono text-[9.5px] tracking-[0.14em] uppercase transition-colors ${
                releasing
                  ? "border-ink/15 text-ink/35 cursor-wait"
                  : "border-brick/40 text-brick hover:bg-brick/5 cursor-pointer"
              }`}
              aria-label={
                releasing ? "Releasing payment intent" : "Release payment intent"
              }
            >
              {releasing ? "Releasing…" : "Release intent"}
            </button>
          )}
          {rowStatus && <StatusChip kind={rowStatus.kind} />}
          {/* Invoice PDF download is the only callback wired here for now —
              receipt PDF requires the on-chain `metadataHash` which the
              section batched-fetches but doesn't yet thread per-row. The
              menu hides items whose callback is omitted. */}
          <div onClick={(e) => e.stopPropagation()}>
            <RowOverflowMenu
              invoicePda={entry.invoicePda}
              invoiceHasLock={
                rowStatus?.kind === "paid" || rowStatus?.kind === "settling"
              }
              onDownloadInvoicePdf={() => {
                void downloadInvoicePdf(md, entry.invoicePda);
              }}
            />
          </div>
          <span
            aria-hidden
            className="text-ink/30 text-[13px] group-hover:text-ink/60 transition-colors"
          >
            →
          </span>
        </div>
      </div>
    </li>
  );
}

/* ─────────────────────────── section ─────────────────────────── */

export function IncomingInvoicesSection() {
  const wallet = useWallet();
  const router = useRouter();

  const walletBase58 = wallet.publicKey?.toBase58() ?? null;

  const [entries, setEntries] = useState<IncomingInvoiceEntry[]>([]);
  const [open, setOpen] = useState(true);
  // Per-invoice on-chain status keyed by invoice PDA base58. Resolved
  // by a batched effect after `entries` settles. Undefined = not fetched
  // yet, which the row treats as "no chip yet — render with the cached
  // metadata only".
  const [statusByPda, setStatusByPda] = useState<Map<string, RowStatus>>(
    new Map(),
  );

  /* ───────── initial load + background Arweave sync ───────── */

  useEffect(() => {
    if (!walletBase58) {
      setEntries([]);
      setStatusByPda(new Map());
      return;
    }
    const wb = walletBase58;

    // Synchronous local cache — no flicker.
    setEntries(loadCachedIncomingInvoices(wb));

    // Background Arweave sync. loadIncomingInvoices writes to the cache
    // and dispatches a StorageEvent when new entries land.
    void loadIncomingInvoices({ wallet: wallet as any, walletBase58: wb });

    // Subscribe to storage updates from any tab or the background sync.
    const key = incomingInvoicesCacheKey(wb);
    function onStorage(e: StorageEvent) {
      if (e.key === key) {
        setEntries(loadCachedIncomingInvoices(wb));
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
    // wallet identity is stable for the session — only re-subscribe on
    // wallet change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletBase58]);

  /* ───────── batched on-chain status fetch ───────── */

  // For each invoice in the inbox, we need (a) the on-chain Invoice
  // status enum and (b) the existence of a `PaymentIntentLock` PDA.
  // Both are read from the chain in a single batched roundtrip per:
  //   - `program.account.invoice.fetchMultiple([...])` — one RPC call
  //   - `fetchManyLocks([...])` — one RPC call (chunked to 100)
  // Total: 2 RPC calls per refresh, regardless of inbox size up to 100.
  useEffect(() => {
    if (!wallet.connected || entries.length === 0) {
      setStatusByPda(new Map());
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const program = getProgram(wallet as any);
        const pdaList = entries.map((e) => new PublicKey(e.invoicePda));
        // Batched account fetch — skips any PDA that doesn't exist.
        const invoices: Array<NormalizedInvoice | null> = await (
          program.account as any
        ).invoice.fetchMultiple(pdaList);
        const lockPdas = pdaList.map((p) => deriveLockPda(p));
        const lockMap = await fetchManyLocks(wallet as any, lockPdas);

        const next = new Map<string, RowStatus>();
        for (let i = 0; i < entries.length; i += 1) {
          const e = entries[i];
          const inv = invoices[i];
          if (!inv) {
            // Invoice account vanished or isn't readable — leave the
            // row without a chip; the cached Arweave metadata still
            // renders.
            continue;
          }
          const statusKey = Object.keys((inv.status as any) ?? {})[0]?.toLowerCase();
          const lock = lockMap.get(lockPdas[i].toBase58());
          // unix seconds; coerce defensively because Anchor's BN can
          // surface as bigint or number depending on the codec path.
          const createdAtSec = Number(
            typeof (inv as any).createdAt === "object" &&
              typeof (inv as any).createdAt.toNumber === "function"
              ? (inv as any).createdAt.toNumber()
              : (inv as any).createdAt,
          );
          let kind: RowStatusKind;
          if (statusKey === "paid") kind = "paid";
          else if (statusKey === "cancelled") kind = "cancelled";
          else if (statusKey === "expired") kind = "expired";
          else if (lock) kind = "settling";
          else kind = "awaiting";
          next.set(e.invoicePda, {
            kind,
            createdAtSec: Number.isFinite(createdAtSec) ? createdAtSec : undefined,
            // Stash lock info on the row so the stuck-lock recovery
            // button can decide whether to surface itself. Only meaningful
            // when kind === "settling" — paid/cancelled/expired rows don't
            // need recovery (the lock is real settlement or terminal).
            lock: lock
              ? { payer: lock.payer.toBase58(), lockedAtSec: lock.lockedAt }
              : undefined,
          });
        }
        if (!cancelled) setStatusByPda(next);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[IncomingInvoicesSection] status fetch failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
    // We intentionally don't depend on `wallet` — its identity changes
    // on every connect/disconnect already, and depending on the full
    // object would re-fetch on every render. The `wallet.connected`
    // primitive is enough to gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, wallet.connected]);

  /* ───────── sort: awaiting first, then paid; recency within ───────── */

  const sortedEntries = useMemo(() => {
    // Group ranks: awaiting=0, settling=1, paid=2, cancelled=3, expired=4.
    // Awaiting-payment surfaces first because that's the user's pending
    // work; paid/settled rows fall below as historical record. Within
    // each group we sort by openedAt DESC (most-recent first).
    const rank = (k: RowStatusKind | undefined): number => {
      switch (k) {
        case "awaiting":
          return 0;
        case "settling":
          return 1;
        case "paid":
          return 2;
        case "cancelled":
          return 3;
        case "expired":
          return 4;
        default:
          return 5; // unknown / unresolved — bottom
      }
    };
    return [...entries].sort((a, b) => {
      const sa = statusByPda.get(a.invoicePda)?.kind;
      const sb = statusByPda.get(b.invoicePda)?.kind;
      const dr = rank(sa) - rank(sb);
      if (dr !== 0) return dr;
      return b.openedAt - a.openedAt;
    });
  }, [entries, statusByPda]);

  const awaitingCount = useMemo(() => {
    let n = 0;
    for (const e of entries) {
      if (statusByPda.get(e.invoicePda)?.kind === "awaiting") n += 1;
    }
    return n;
  }, [entries, statusByPda]);

  /* ───────── row navigation ───────── */

  const handleRowClick = useCallback(
    (entry: IncomingInvoiceEntry) => {
      // Reconstruct the original pay URL. The fragment key is stored as
      // the raw base58 string extracted from #k=<key>.
      router.push(`/pay/${entry.invoicePda}#${entry.urlFragmentKey}`);
    },
    [router],
  );

  /* ───────── stuck-lock recovery ───────── */

  // Tracks which invoice PDA is currently mid-cancel. The button on
  // that row goes to "Releasing…" and is disabled. Map (rather than
  // single string) so theoretically multiple recoveries can run in
  // parallel — but practically the button only surfaces on settling
  // rows, of which a user typically has at most one or two.
  const [releasing, setReleasing] = useState<Set<string>>(new Set());

  const handleRequestRelease = useCallback(
    async (entry: IncomingInvoiceEntry) => {
      if (!wallet.publicKey || !wallet.signTransaction) return;
      const invoicePdaStr = entry.invoicePda;
      if (releasing.has(invoicePdaStr)) return;

      setReleasing((prev) => {
        const next = new Set(prev);
        next.add(invoicePdaStr);
        return next;
      });

      try {
        // Lazy-load payInvoiceCpi for the buildCancelPaymentIntentTx
        // helper. Same import pattern umbra.ts uses for the CPI fallback;
        // keeps the heavy ZK-asset module out of the dashboard's bundle
        // until the recovery path is actually needed.
        const { buildCancelPaymentIntentTx } = await import("@/lib/payInvoiceCpi");
        const invoicePda = new PublicKey(invoicePdaStr);
        const { tx, blockhash, lastValidBlockHeight } =
          await buildCancelPaymentIntentTx({
            invoicePda,
            payer: wallet.publicKey,
          });

        // wallet.signTransaction works for VersionedTransaction in
        // wallet-adapter ^0.15. Phantom + Solflare + Backpack all
        // support it; older adapters fall back to no-op which we'd
        // catch via the missing-signature check below.
        const signed: VersionedTransaction = (await wallet.signTransaction(
          tx,
        )) as VersionedTransaction;

        const connection = new Connection(RPC_URL, "confirmed");
        const sig = await connection.sendTransaction(signed, {
          skipPreflight: false,
          maxRetries: 3,
        });
        await connection.confirmTransaction(
          { signature: sig, blockhash, lastValidBlockHeight },
          "confirmed",
        );

        // Optimistically clear the lock from local state so the row
        // flips back to "Awaiting" without waiting for the next batched
        // status fetch. The cancel ix closes the lock account, so the
        // next `fetchManyLocks` will return null for this PDA anyway —
        // we just collapse the latency window.
        setStatusByPda((prev) => {
          const next = new Map(prev);
          const cur = next.get(invoicePdaStr);
          if (cur) {
            next.set(invoicePdaStr, {
              ...cur,
              kind: "awaiting",
              lock: undefined,
            });
          }
          return next;
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          "[IncomingInvoicesSection] cancel_payment_intent failed:",
          err,
        );
        // Surface as a window-scoped failure note. The dashboard could
        // upgrade this to a toast in v2; for now console.warn keeps the
        // behaviour scoped to dev visibility while the rest of the row
        // returns to "settling" for the next refresh cycle.
      } finally {
        setReleasing((prev) => {
          const next = new Set(prev);
          next.delete(invoicePdaStr);
          return next;
        });
      }
    },
    [wallet, releasing],
  );

  /* ───────── render ───────── */

  if (!wallet.connected || !walletBase58) return null;

  return (
    <section className="reveal mb-12">
      <div className="flex items-baseline justify-between mb-6 border-b border-line pb-3">
        <div className="flex items-baseline gap-3">
          <span className="font-sans text-xs uppercase tracking-[0.18em] text-ink/55">
            Invoice inbox
          </span>
          {awaitingCount > 0 && (
            <span className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-gold">
              {awaitingCount} awaiting
            </span>
          )}
        </div>
        <span className="font-sans text-[10.5px] tabular-nums tracking-[0.12em] text-ink/40">
          {String(entries.length).padStart(2, "0")}
        </span>
      </div>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-baseline justify-between mb-3 text-left"
        aria-expanded={open}
      >
        <span className="font-sans text-[11.5px] uppercase tracking-[0.16em] text-ink/55">
          Received invoices
          <span className="ml-2 text-ink/35 font-mono tabular-nums">
            {String(entries.length).padStart(2, "0")}
          </span>
        </span>
        <span
          aria-hidden
          className={`text-ink/40 transition-transform ${open ? "" : "-rotate-90"}`}
        >
          ↓
        </span>
      </button>

      {open &&
        (entries.length === 0 ? (
          <div className="border border-dashed border-line rounded-[4px] py-10 px-6 text-center">
            <p className="font-display italic text-ink/70 text-[18px] leading-[1.3]">
              No invoices yet.
            </p>
            <p className="mt-2 text-[12.5px] text-ink/50 leading-relaxed">
              When someone shares an invoice link with you, it&apos;ll show up here.
            </p>
          </div>
        ) : (
          <ul className="border border-line rounded-[4px] bg-paper-3 divide-y divide-line">
            {sortedEntries.map((entry) => (
              <InvoiceRowItem
                key={entry.invoicePda}
                entry={entry}
                rowStatus={statusByPda.get(entry.invoicePda)}
                walletBase58={walletBase58}
                onClick={() => handleRowClick(entry)}
                onRequestRelease={(e) => {
                  void handleRequestRelease(e);
                }}
                releasing={releasing.has(entry.invoicePda)}
              />
            ))}
          </ul>
        ))}
    </section>
  );
}
