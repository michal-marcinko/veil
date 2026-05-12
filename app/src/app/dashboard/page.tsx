"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { VeilLogo } from "@/components/VeilLogo";
import { ClaimProgressModal } from "@/components/ClaimProgressModal";
import { InvoiceRow } from "@/components/InvoiceRow";
import {
  DateGroupHeader,
  bucketByCreatedAt,
  DATE_BUCKET_ORDER,
} from "@/components/DateGroupHeader";
import { SlideOverPanel } from "@/components/SlideOverPanel";
import { RefreshButton } from "@/components/RefreshButton";
import {
  fetchInvoicesByCreator,
  fetchManyLocks,
  markPaidOnChain,
  type LockState,
} from "@/lib/anchor";
import { deriveLockPda } from "@/lib/lock-derivation";
import {
  sha256,
  decryptJson,
  getOrCreateMetadataMasterSig,
  deriveKeyFromMasterSig,
} from "@/lib/encryption";
import {
  parseReceiptInput,
  verifyReceiptSignature,
  type SignedReceipt,
} from "@/lib/receipt";
import { fetchCiphertext } from "@/lib/arweave";
import type { InvoiceMetadata } from "@/lib/types";
import {
  getOrCreateClient,
  isFullyRegistered,
  diagnoseUmbraReceiver,
  repairUmbraReceiverKey,
  scanClaimableUtxos,
  claimUtxos,
  getEncryptedBalance,
  withdrawShielded,
  depositToShielded,
} from "@/lib/umbra";
import { parseAmountToBaseUnits } from "@/lib/csv";
import { USDC_MINT, PAYMENT_SYMBOL, PAYMENT_DECIMALS } from "@/lib/constants";
import {
  formatPayrollAmount,
  type SignedPayrollPacket,
} from "@/lib/private-payroll";
import {
  loadCachedSignedPackets,
  syncPayrollRunsFromArweave,
} from "@/lib/payroll-runs-storage";
import { IncomingPrivatePaymentsSection } from "@/components/IncomingPrivatePaymentsSection";
// Inbound side of the invoice flow — invoices a payer has been ASKED
// to settle. Owned by a parallel subagent; renders with no props
// (internally wallet-aware via useWallet, mirroring
// IncomingPrivatePaymentsSection). Lives in the Inbox tab next to the
// private-payments section.
import { IncomingInvoicesSection } from "@/components/IncomingInvoicesSection";
import { RowOverflowMenu } from "@/components/RowOverflowMenu";
import bs58 from "bs58";

type DashboardTab = "inbox" | "sent" | "balance";

/**
 * Type filter for the merged Sent feed (Task B). "All" interleaves
 * invoices + payroll runs by createdAt; the other two narrow to a
 * single source. Lifted to module scope so the chip strip + the feed
 * row can share the union type.
 */
type SentTypeFilter = "all" | "invoice" | "payroll";

// Status filter values — lifted to module scope so child components
// (FilterBar, LedgerSection) can type their props against the same union
// the page does. Keep in sync with the on-chain Status enum's variants.
type StatusFilter = "all" | "pending" | "paid" | "cancelled";

// localStorage key for the apply-receipt textarea draft. Per-wallet so a
// draft from another wallet doesn't leak. The slide-over hydrates from
// this on open and writes back on every change — never lose progress
// when the user closes the panel mid-paste.
const RECEIPT_DRAFT_STORAGE_PREFIX = "veil:receiptDraft:";

// Recency window for the receipt-suggest banner (Task A). Only Pending
// invoices created within this window are eligible matches; anything
// older is treated as stale (the user has likely lost track of the
// invoice <> payment correspondence and we don't want to nudge them
// toward the wrong one). 7 days is the spec default — bump or shrink
// in one place without grepping the section.
const RECEIPT_SUGGEST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Storage convention + cross-device sync for signed payroll packets
// lives in `lib/payroll-runs-storage.ts`. The dashboard imports
// `loadCachedSignedPackets` (instant fast-path read) and
// `syncPayrollRunsFromArweave` (background reconcile) from there.
// The cache key prefix kept here as a constant so the storage-event
// subscription can still filter to it.
const PAYROLL_RUNS_STORAGE_PREFIX = "veil:payrollRuns:";

function payrollRunsStorageKey(walletBase58: string): string {
  return `${PAYROLL_RUNS_STORAGE_PREFIX}${walletBase58}`;
}

/**
 * One entry in the merged Sent feed (Task B). Discriminated union so
 * the renderer can pick between an invoice row and a payroll row
 * without losing static type information at the call site.
 */
type SentFeedEntry =
  | {
      kind: "invoice";
      /** Stable React key — invoice PDA. */
      id: string;
      createdAtMs: number;
      invoice: SentInvoiceShape;
    }
  | {
      kind: "payroll";
      /** Stable React key — batch id. */
      id: string;
      createdAtMs: number;
      run: PayrollRunSummary;
    };

/** Mirrors what `incoming` produces — see the useMemo for `incoming`. */
type SentInvoiceShape = {
  pda: string;
  creator: string;
  metadataUri: string;
  status: string;
  createdAt: number;
};

type PayrollRunSummary = {
  signed: SignedPayrollPacket;
  totalUnits: bigint;
  paid: number;
  failed: number;
  status: "settled" | "partial" | "failed";
  createdAtMs: number;
};

function summarizePayrollRun(signed: SignedPayrollPacket): PayrollRunSummary {
  const rows = signed.packet.rows;
  let total = 0n;
  let paid = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      total += BigInt(row.amount);
    } catch {
      // Malformed amount string — skip in total but keep counting status.
    }
    if (row.status === "paid") paid += 1;
    else if (row.status === "failed") failed += 1;
  }
  let status: PayrollRunSummary["status"];
  if (paid > 0 && failed === 0) status = "settled";
  else if (paid === 0 && failed > 0) status = "failed";
  else status = "partial";
  const createdAtMs = Date.parse(signed.packet.createdAt);
  return {
    signed,
    totalUnits: total,
    paid,
    failed,
    status,
    createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0,
  };
}

function isPendingInvoice(invoice: any): boolean {
  return "pending" in (invoice.account.status as any);
}

// Note: previous versions of this file had a localStorage cache of
// "known-reserved" UTXO IDs to filter before each claim attempt. That's
// now superseded by the watermark-based scan in `scanClaimableUtxos`
// (umbra.ts), which uses the SDK's `nextScanStartIndex` to skip already-
// processed UTXOs at scan time — preventing them from ever reaching
// the claim step.

/**
 * Walk an opaque claim-result blob and collect every base58 string that
 * decodes to a 64-byte buffer (i.e. looks like a Solana tx signature).
 * Used to build the in-session "claimed UTXO" set so receipts that quote
 * a signature we actually claimed are accepted, while strangers' receipts
 * that happen to verify cryptographically are still rejected.
 */
function collectStableSignatures(
  value: unknown,
  out: Set<string> = new Set(),
  seen = new Set<object>(),
): Set<string> {
  if (typeof value === "string") {
    try {
      if (bs58.decode(value).length === 64) out.add(value);
    } catch {
      // not base58 — skip
    }
    return out;
  }
  if (!value || typeof value !== "object") return out;
  if (seen.has(value)) return out;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) collectStableSignatures(item, out, seen);
    return out;
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    collectStableSignatures(item, out, seen);
  }
  return out;
}

export default function DashboardPage() {
  const wallet = useWallet();
  const [invoices, setInvoices] = useState<any[]>([]);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasFetchedOnce, setHasFetchedOnce] = useState(false);
  const [repairingReceiverKey, setRepairingReceiverKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [receiverKeyMismatch, setReceiverKeyMismatch] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  // Deposit-to-shielded modal state. The modal opens when the user
  // clicks "Deposit from wallet → private" on the balance card.
  // `depositOpen` toggles the modal; `depositAmount` is the form input
  // (display string, parsed at submit); `depositing` blocks resubmits
  // and surfaces a spinner inside the button.
  const [depositOpen, setDepositOpen] = useState(false);
  const [depositAmount, setDepositAmount] = useState("");
  const [depositing, setDepositing] = useState(false);
  // Per-invoice labels decrypted lazily. Keyed by PDA base58. We populate
  // this after the initial fetch so the table can show "Acme · $4,200 USDC"
  // instead of "9TjX77RP…9Yeh". Decrypt failures (legacy invoices with the
  // old per-PDA signMessage scheme) leave the entry absent — the list
  // falls back to the truncated PDA in that case.
  // `amount` is the formatted display string ("4,200.00 USDC"); `totalRaw`
  // is the same value as a base-unit string ("4200000000") so the
  // receipt-suggest matcher in IncomingPrivatePaymentsSection can compare
  // against a UTXO's bigint amount without having to re-parse the display.
  // `createdAtMs` mirrors the metadata's ISO `created_at` — the on-chain
  // `account.createdAt` is unix-seconds and good enough for the "last 7
  // days" gate, so callers can use either.
  const [labels, setLabels] = useState<
    Map<
      string,
      {
        payer: string;
        amount: string;
        description: string;
        totalRaw: string;
        invoiceId: string;
      }
    >
  >(new Map());
  // One-time-per-session cache: skip the registered/aligned diagnostics
  // on subsequent refreshes once we've verified once. Saves ~800ms of
  // RPC + key-derivation work per refresh in steady state.
  const [keysVerified, setKeysVerified] = useState(false);
  // Top-level tab. Defaults to Inbox so a user who's primarily a
  // recipient (payroll worker, freelancer with no own invoices yet)
  // sees their incoming activity first. Pure useState — no URL sync —
  // since deep-linking specific tabs isn't a hackathon-week priority.
  const [tab, setTab] = useState<DashboardTab>("inbox");
  // Type filter for the merged Sent feed (Task B). "all" interleaves
  // invoice + payroll rows by createdAt; the chip strip flips this.
  const [sentTypeFilter, setSentTypeFilter] = useState<SentTypeFilter>("all");
  // Signed payroll packets read from localStorage. Loaded reactively
  // when the wallet changes; storage event listener keeps the count
  // current if a sibling tab signs a new batch.
  const [payrollRuns, setPayrollRuns] = useState<SignedPayrollPacket[]>([]);

  // In-session claim history. Every time we successfully claim incoming
  // UTXOs, we record any 64-byte base58 strings we can pull out of the
  // SDK's opaque result blob. When a payer pastes a receipt, we accept
  // it only if its `markPaidTxSig` is in this set OR matches one of the
  // pending invoices' PDAs (belt-and-suspenders for receipts that quote
  // the payment-intent sig but the SDK didn't surface it in the result).
  // Unmatched receipts get a soft warning but can still be applied —
  // the receipt's ed25519 signature is the cryptographic binding.
  const [claimedUtxoSigs, setClaimedUtxoSigs] = useState<Set<string>>(new Set());
  // Number of incoming UTXOs we've claimed this session minus the
  // number of receipts a creator has applied. Drives the
  // "X received UTXOs unmatched" indicator at the top of the page.
  const [claimedCount, setClaimedCount] = useState(0);
  const [matchedReceiptCount, setMatchedReceiptCount] = useState(0);

  // Receipt-apply UI state.
  const [receiptInput, setReceiptInput] = useState("");
  const [applyingReceipt, setApplyingReceipt] = useState(false);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  // Slide-over visibility. Opens via the trigger button or the per-row
  // "bind receipt" hover action; closes via backdrop click + ESC + the
  // close button + a successful apply.
  const [receiptPanelOpen, setReceiptPanelOpen] = useState(false);

  // Claim-progress modal state. Shown the moment we discover N
  // claimable UTXOs and are about to walk through them sequentially.
  // `claimModal.total === 0` (the default) keeps the modal closed.
  type ClaimModalState = {
    open: boolean;
    current: number;
    total: number;
    error: string | null;
  };
  const [claimModal, setClaimModal] = useState<ClaimModalState>({
    open: false,
    current: 0,
    total: 0,
    error: null,
  });

  // Invoice list controls — stable sort + filter + search. The raw
  // `invoices` state is the source of truth; these inputs filter the
  // displayed slice without refetching. `StatusFilter` lives at module
  // scope so the FilterBar component can share the type.
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");

  // Per-invoice on-chain `PaymentIntentLock` snapshot. Keyed by invoice
  // PDA base58 → LockState if the lock account exists, null if it
  // doesn't, undefined if we haven't fetched yet. The lock IS the
  // on-chain proof of payment; rendering "Paid · settling" is purely a
  // function of this Map and on-chain status. Refresh writes a new Map
  // so a status flip causes a re-render.
  const [locksByInvoice, setLocksByInvoice] = useState<
    Map<string, LockState | null>
  >(new Map());
  // Per-load dedupe: invoice PDAs we've already fired a lazy mark_paid
  // for in this React session. Prevents duplicate sends when the 30s
  // refresh interval re-runs over the same lock-present row before the
  // next on-chain fetch reflects the flip. Held in a ref so updates
  // don't trigger renders.
  const lazyMarkPaidFired = useRef<Set<string>>(new Set());
  // Toast state for the auto-flip success banner. Set by the lazy
  // mark_paid handler; auto-clears after 4 seconds.
  const [autoFlipToast, setAutoFlipToast] = useState<string | null>(null);
  // Sent-tab "More ▾" overflow dropdown state. Encloses the
  // import-receipt entry that used to live as a primary chip in the
  // FilterBar — now demoted to a recovery affordance per the
  // banking-grade UX plan.
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);

  async function refresh() {
    if (!wallet.publicKey) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    setReceiverKeyMismatch(false);

    // Run independent reads concurrently. fetchInvoicesByCreator hits our
    // own program; getOrCreateClient is cached and effectively free. The
    // scan + balance run later, also in parallel, after the optional
    // first-session key verification.
    const [invoicesResult, clientResult] = await Promise.allSettled([
      fetchInvoicesByCreator(wallet as any, wallet.publicKey),
      getOrCreateClient(wallet as any),
    ]);

    if (invoicesResult.status === "rejected") {
      // eslint-disable-next-line no-console
      console.error("[Veil dashboard] fetchInvoicesByCreator failed:", invoicesResult.reason);
      setError(`Invoice list: ${(invoicesResult.reason as any)?.message ?? invoicesResult.reason}`);
      setLoading(false);
      setHasFetchedOnce(true);
      return;
    }
    if (clientResult.status === "rejected") {
      // eslint-disable-next-line no-console
      console.error("[Veil dashboard] umbra client init failed:", clientResult.reason);
      setError(`Umbra: ${(clientResult.reason as any)?.message ?? clientResult.reason}`);
      setLoading(false);
      setHasFetchedOnce(true);
      return;
    }

    const all = invoicesResult.value;
    const client = clientResult.value;
    setInvoices(all.map((a: any) => ({ pda: a.publicKey, account: a.account })));
    setHasFetchedOnce(true);
    // Background label decryption — never blocks the spinner.
    void loadInvoiceLabels(all);

    try {
      // First-refresh-of-session key verification. After we've confirmed
      // once that the wallet is registered AND its on-chain X25519 key
      // matches the locally-derived one, every subsequent refresh in
      // the same React session can skip these RPC calls + key
      // derivations (saves ~800ms per refresh in steady state).
      if (!keysVerified) {
        if (await isFullyRegistered(client)) {
          const diagnostics = await diagnoseUmbraReceiver(client);
          if (diagnostics.tokenX25519Matches === false) {
            setReceiverKeyMismatch(true);
            setError(
              "Umbra receiver key mismatch: your on-chain receiver key does not match this wallet session. Repair it once, then retry refresh.",
            );
            return;
          }
          if (process.env.NEXT_PUBLIC_VEIL_DEBUG === "1") {
            // eslint-disable-next-line no-console
            console.log(
              `[Veil] keys aligned ✓ token=${diagnostics.tokenX25519Matches} mvk=${diagnostics.masterViewingKeyX25519Matches}`,
            );
          }
          setKeysVerified(true);
        }
      }

      // Kick off the balance fetch in parallel with the scan. If the
      // scan finds nothing to claim, this is the only balance fetch
      // we'll do — net win of one round-trip latency. If the scan
      // does claim something, we re-fetch the balance after, since
      // the parallel one is stale at that point.
      const initialBalancePromise = getEncryptedBalance(
        client,
        USDC_MINT.toBase58(),
      ).catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[Veil dashboard] initial getEncryptedBalance failed:", err);
        return null as bigint | null;
      });
      let claimedThisRefresh = false;

      try {
        // Auto-claim disabled (2026-05-05). The new
        // <IncomingPrivatePaymentsSection /> displays pending UTXOs as
        // an explicit list with a per-row "Claim" button — that flow
        // is the canonical surface for incoming payments now.
        //
        // Why disable the auto-claim: it races with the new section
        // (both call scanClaimableUtxos and try to claim the same
        // UTXOs). Worse, the auto-claim fires from `refresh()` which
        // runs on mount + focus + interval, and Phantom's popup
        // blocker silently kills `signTransaction` calls that don't
        // originate from a direct user gesture — leading to the modal
        // hanging on "Awaiting wallet signature…" with no popup ever
        // appearing. The new section requires a direct click which
        // satisfies the popup-blocker rule.
        //
        // We still scan here so `refresh()` sees the watermark advance
        // (the indexer's tree position) and the dashboard's other
        // counts stay correct. We just don't claim from this code
        // path; that's the section's job now.
        await scanClaimableUtxos(client);
        // The auto-claim block that used to live here has been
        // removed. If you need to restore it, see git history before
        // 2026-05-05; the body opened a progress modal, called
        // `claimUtxos`, retried per-UTXO on 409s, and recorded
        // signatures for receipt-binding. Receipt-binding is now
        // unaffected — the new section's `persistReceivedPayment`
        // captures the same signature data into the recipient's
        // received-payments storage.
      } catch (err: any) {
          // eslint-disable-next-line no-console
          console.error("[Veil dashboard] scan/claim failed:", err);
          // Surface the failure inside the modal if we'd already opened
          // it. Auto-close after a longer pause so the user can read.
          setClaimModal((prev) =>
            prev.open
              ? { ...prev, error: err?.message ?? String(err) }
              : prev,
          );
          setTimeout(() => {
            setClaimModal((prev) =>
              prev.error ? { open: false, current: 0, total: 0, error: null } : prev,
            );
          }, 4000);
        }

      try {
        // Steady state (no claim happened): use the parallel pre-fetch
        // we kicked off above — the balance hasn't changed. After a
        // claim: do a fresh fetch since the pre-fetched value is stale.
        let bal: bigint | null;
        if (claimedThisRefresh) {
          bal = await getEncryptedBalance(client, USDC_MINT.toBase58());
        } else {
          bal = await initialBalancePromise;
        }
        if (bal != null) setBalance(bal);
      } catch (err: any) {
        // eslint-disable-next-line no-console
        console.error("[Veil dashboard] getEncryptedBalance failed:", err);
        setError(`Balance: ${err.message ?? String(err)}`);
      }
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error("[Veil dashboard] refresh failed:", err);
      setError(`Refresh: ${err.message ?? String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  // Decrypt as many invoices' metadata as possible without triggering
  // popups beyond the one-time master-sig sign. Per-invoice work is
  // independent so we do it in parallel; failures (legacy invoice key,
  // network blip, malformed metadata) leave that PDA out of the map and
  // the list falls back to the truncated PDA.
  async function loadInvoiceLabels(
    invoices: Awaited<ReturnType<typeof fetchInvoicesByCreator>>,
  ) {
    if (!wallet.publicKey) return;
    let masterSig: Uint8Array;
    try {
      masterSig = await getOrCreateMetadataMasterSig(
        wallet as any,
        wallet.publicKey.toBase58(),
      );
    } catch {
      // User declined the one-time signature — skip labels entirely.
      return;
    }
    const next = new Map<
      string,
      {
        payer: string;
        amount: string;
        description: string;
        totalRaw: string;
        invoiceId: string;
      }
    >();
    await Promise.all(
      invoices.map(async (inv: any) => {
        try {
          const pda = inv.publicKey.toBase58();
          const uri: string = inv.account.metadataUri;
          if (!uri) return;
          const ciphertext = await fetchCiphertext(uri);
          const key = await deriveKeyFromMasterSig(masterSig, pda);
          const md = (await decryptJson(ciphertext, key)) as InvoiceMetadata;
          const total = BigInt(md.total);
          const decimals = md.currency?.decimals ?? PAYMENT_DECIMALS;
          const symbol = md.currency?.symbol ?? PAYMENT_SYMBOL;
          // Concatenate every line-item description for search. Most
          // invoices have one item; payroll batches and itemised invoices
          // can have many. Joined with " · " so a substring match on any
          // single item still hits.
          const description = (md.line_items ?? [])
            .map((li) => li.description)
            .filter(Boolean)
            .join(" · ");
          next.set(pda, {
            payer: md.payer?.display_name || "Unknown payer",
            amount: `${formatBigintAmount(total, decimals)} ${symbol}`,
            description,
            totalRaw: total.toString(),
            invoiceId: md.invoice_id,
          });
        } catch {
          // Legacy invoice (per-PDA signMessage key) or fetch/parse error.
          // No popup, no entry — list shows truncated PDA for this row.
        }
      }),
    );
    setLabels(next);
  }

  async function handleWithdrawAll() {
    if (!wallet.publicKey) return;
    if (!balance || balance <= 0n) {
      setError("Nothing to withdraw — encrypted balance is 0.");
      return;
    }
    // Confirm with the user — withdrawal is irreversible (well, reversible
    // with another deposit, but it's a real on-chain action that costs SOL
    // and pays the 35 bps Umbra protocol fee).
    const formatted = formatBigintAmount(balance, PAYMENT_DECIMALS);
    const ok = window.confirm(
      `Withdraw ${formatted} ${PAYMENT_SYMBOL} to your public wallet?\n\n` +
        `Umbra will deduct a 35 bps protocol fee (≈ ${formatBigintAmount(
          (balance * 35n) / 16384n,
          PAYMENT_DECIMALS,
        )} ${PAYMENT_SYMBOL}). The withdrawal runs through Arcium MPC and ` +
        `usually settles in ~30 seconds.`,
    );
    if (!ok) return;

    setWithdrawing(true);
    setError(null);
    setNotice("Withdrawing — waiting for Arcium MPC callback…");
    try {
      const client = await getOrCreateClient(wallet as any);
      const result = await withdrawShielded(client, USDC_MINT.toBase58(), balance);
      const sig = result.callbackSignature ?? result.queueSignature;
      setNotice(
        `Withdrawal complete. Tx: ${sig.slice(0, 12)}…${sig.slice(-8)}` +
          (result.callbackElapsedMs
            ? ` (settled in ${(result.callbackElapsedMs / 1000).toFixed(1)}s)`
            : ""),
      );
      // Refresh balance + invoice list to reflect the new state.
      await refresh();
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error("[Veil dashboard] withdraw failed:", err);
      setError(`Withdraw: ${err.message ?? String(err)}`);
      setNotice(null);
    } finally {
      setWithdrawing(false);
    }
  }

  async function handleDepositToShielded() {
    if (!wallet.publicKey) return;
    const baseUnits = parseAmountToBaseUnits(depositAmount, PAYMENT_DECIMALS);
    if (baseUnits == null || baseUnits <= 0n) {
      setError("Enter a valid amount, e.g. 1.0");
      return;
    }
    setDepositing(true);
    setError(null);
    setNotice("Depositing into your private balance — waiting for Arcium MPC callback…");
    try {
      const client = await getOrCreateClient(wallet as any);
      const result = await depositToShielded(
        client,
        USDC_MINT.toBase58(),
        baseUnits,
      );
      const sig = result.callbackSignature ?? result.queueSignature;
      setNotice(
        `Shielded deposit complete. Tx: ${sig.slice(0, 12)}…${sig.slice(-8)}`,
      );
      setDepositOpen(false);
      setDepositAmount("");
      // Refresh balance display + invoice list to reflect the new state.
      await refresh();
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error("[Veil dashboard] deposit-to-shielded failed:", err);
      setError(`Deposit: ${err.message ?? String(err)}`);
      setNotice(null);
    } finally {
      setDepositing(false);
    }
  }

  async function handleRepairReceiverKey() {
    if (!wallet.publicKey) return;
    setRepairingReceiverKey(true);
    setError(null);
    try {
      const client = await getOrCreateClient(wallet as any);
      const signatures = await repairUmbraReceiverKey(client);
      setReceiverKeyMismatch(false);
      await refresh();
      setNotice(
        signatures.length > 0
          ? `Umbra receiver key repaired: ${signatures[0]}`
          : "Umbra receiver key already matches this wallet.",
      );
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error("[Veil dashboard] repair receiver key failed:", err);
      setError(`Repair receiver key: ${err.message ?? String(err)}`);
    } finally {
      setRepairingReceiverKey(false);
    }
  }

  /**
   * Apply a payer-signed receipt to bind ONE specific invoice to
   * ONE specific payment. Replaces the old "Confirm paid" button —
   * the creator alone can no longer flip an invoice to Paid; they
   * need cryptographic proof the payer authorised it.
   *
   * Verification chain:
   *   1. Parse URL or raw blob via parseReceiptInput (frozen format).
   *   2. Verify ed25519 signature over the canonical receipt bytes
   *      against the receipt's claimed payerPubkey.
   *   3. Check receipt.invoicePda matches a Pending invoice the
   *      connected creator owns.
   *   4. Soft-check receipt.markPaidTxSig is a UTXO this dashboard
   *      claimed this session — if missing, surface a warning but
   *      still allow the apply (the ed25519 signature is the binding).
   *   5. Submit mark_paid on-chain using sha256(payment-intent sig)
   *      as the utxo_commitment, so the public verifier at
   *      /receipt/[pda] can later cross-check.
   */
  async function handleApplyReceipt() {
    if (!wallet.publicKey) return;
    setReceiptError(null);
    setNotice(null);

    let signed: SignedReceipt;
    let pathPda: string | null = null;
    try {
      const parsed = parseReceiptInput(receiptInput);
      signed = parsed.signed;
      pathPda = parsed.pathPda;
    } catch (err: any) {
      setReceiptError(`Receipt: ${err.message ?? String(err)}`);
      return;
    }

    if (pathPda && pathPda !== signed.receipt.invoicePda) {
      setReceiptError(
        "Receipt URL path PDA does not match the receipt body. Refusing to apply.",
      );
      return;
    }

    setApplyingReceipt(true);
    try {
      const sigOk = await verifyReceiptSignature(signed);
      if (!sigOk) {
        setReceiptError(
          "Receipt signature is invalid — it was not signed by the claimed payer.",
        );
        return;
      }

      // Find the matching Pending invoice. Receipts for non-existent or
      // already-paid invoices get a clear error rather than spamming
      // mark_paid and watching the program reject with InvalidStatus.
      const target = invoices.find(
        (i) =>
          i.pda.toBase58() === signed.receipt.invoicePda &&
          isPendingInvoice(i),
      );
      if (!target) {
        setReceiptError(
          "No matching Pending invoice on this dashboard for receipt PDA " +
            `${signed.receipt.invoicePda.slice(0, 8)}…${signed.receipt.invoicePda.slice(-4)}.`,
        );
        return;
      }

      // Soft check: did this dashboard actually claim a UTXO whose
      // signature appears in the receipt? Mismatch is suspicious but
      // not fatal — Umbra's relayer-side claim path may surface a
      // different signature than the payer's pay-tx, and the SDK's
      // result blob is opaque. The cryptographic binding is the
      // ed25519 signature over the receipt body, which we already
      // verified.
      const claimMatched = claimedUtxoSigs.has(signed.receipt.markPaidTxSig);

      // utxo_commitment = sha256(payment-intent signature). Same
      // derivation the public /receipt/[pda] verifier expects for
      // its sanity check.
      const sigBytes = bs58.decode(signed.receipt.markPaidTxSig);
      const commitment = await sha256(sigBytes);

      try {
        await markPaidOnChain(wallet as any, target.pda, commitment);
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        const alreadyPaid =
          /InvalidStatus/i.test(msg) ||
          /0x1771/i.test(msg) ||
          /Error Number: 6001/i.test(msg);
        if (!alreadyPaid) throw err;
        // Treat already-paid as a no-op success — receipt is still bound.
      }

      setMatchedReceiptCount((c) => c + 1);
      setReceiptInput("");
      // Clear the persisted draft on successful apply.
      try {
        if (typeof window !== "undefined" && wallet.publicKey) {
          window.localStorage.removeItem(
            `${RECEIPT_DRAFT_STORAGE_PREFIX}${wallet.publicKey.toBase58()}`,
          );
        }
      } catch {
        // localStorage unavailable — ignore
      }
      setReceiptPanelOpen(false);
      setNotice(
        claimMatched
          ? `Receipt applied — invoice marked Paid (claim signature matched).`
          : `Receipt applied — invoice marked Paid. Note: payment signature was not in this session's claim history; relying on receipt signature alone.`,
      );
      await refresh();
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error("[Veil dashboard] apply receipt failed:", err);
      setReceiptError(`Apply receipt: ${err.message ?? String(err)}`);
    } finally {
      setApplyingReceipt(false);
    }
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30000);
    return () => clearInterval(interval);
  }, [wallet.publicKey]);

  // Hydrate payroll runs from localStorage whenever the wallet changes.
  // We also subscribe to the `storage` event so a sibling tab signing a
  // new packet shows up here without a manual refresh.
  useEffect(() => {
    if (!wallet.publicKey) {
      setPayrollRuns([]);
      return;
    }
    const walletBase58 = wallet.publicKey.toBase58();
    const key = payrollRunsStorageKey(walletBase58);
    setPayrollRuns(loadCachedSignedPackets(walletBase58));
    function onStorage(event: StorageEvent) {
      if (event.key === key) {
        setPayrollRuns(loadCachedSignedPackets(walletBase58));
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [wallet.publicKey]);

  // Cross-device sync — reconcile the local cache with payroll runs
  // we may have uploaded from another browser/device. The master sig
  // is cached after first use (most likely already populated by the
  // invoice-metadata flow on this same dashboard), so this rarely
  // requires an extra Phantom popup. Best-effort: errors don't block
  // the local-only render. Re-runs whenever the wallet changes.
  useEffect(() => {
    if (!wallet.publicKey) return;
    const walletBase58 = wallet.publicKey.toBase58();
    let cancelled = false;
    (async () => {
      try {
        const result = await syncPayrollRunsFromArweave({
          wallet: wallet as any,
          walletBase58,
        });
        if (!cancelled && result.added > 0) {
          // The sync helper writes to localStorage and dispatches a
          // synthetic StorageEvent, so the hydration effect's
          // onStorage handler will pick up the new entries. Forcing
          // a state set here as a belt-and-braces measure for the
          // rare case where the same-tab dispatch is suppressed.
          setPayrollRuns(loadCachedSignedPackets(walletBase58));
        }
      } catch {
        // syncPayrollRunsFromArweave is internally defensive; this
        // catch is just for any unexpected throw.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wallet.publicKey, wallet]);

  // Hydrate the receipt-apply textarea draft from localStorage on
  // wallet change. Per-wallet so a draft from another wallet doesn't
  // leak. Writes back happen inside the textarea onChange.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!wallet.publicKey) return;
    try {
      const key = `${RECEIPT_DRAFT_STORAGE_PREFIX}${wallet.publicKey.toBase58()}`;
      const draft = window.localStorage.getItem(key);
      if (draft) setReceiptInput(draft);
    } catch {
      // localStorage unavailable / blocked — silently ignore.
    }
  }, [wallet.publicKey]);

  const payrollRunSummaries = useMemo<PayrollRunSummary[]>(() => {
    return payrollRuns
      .map(summarizePayrollRun)
      .sort((a, b) => b.createdAtMs - a.createdAtMs);
  }, [payrollRuns]);

  /**
   * Receipt-suggest matcher (Task A). Resolves a claimed UTXO amount to
   * exactly one Pending invoice the connected wallet has SENT, created
   * within the recency window. Returns null when zero or multiple
   * invoices match — the section is intentionally conservative because
   * a wrong suggestion would steer the user toward binding the wrong
   * receipt.
   *
   * Closes over `invoices` + `labels`, so it gets re-derived whenever
   * either changes. We hand it to IncomingPrivatePaymentsSection as a
   * plain function rather than a precomputed candidate because the
   * section doesn't know the claimed amount until the SDK call returns.
   */
  const findReceiptCandidate = useMemo(() => {
    return (claimedAmount: bigint) => {
      // Compute the cutoff at call time, not at memo creation, so a
      // dashboard left open across the day-boundary still uses an
      // accurate "last 7 days" window.
      const cutoffMs = Date.now() - RECEIPT_SUGGEST_WINDOW_MS;
      const matches: Array<{ pda: string; shortId: string }> = [];
      for (const inv of invoices) {
        if (!isPendingInvoice(inv)) continue;
        // on-chain createdAt is unix-seconds
        const createdMs = Number(inv.account.createdAt) * 1000;
        if (!Number.isFinite(createdMs) || createdMs < cutoffMs) continue;
        const pda = inv.pda.toBase58();
        const label = labels.get(pda);
        if (!label || !label.totalRaw) continue;
        let total: bigint;
        try {
          total = BigInt(label.totalRaw);
        } catch {
          continue;
        }
        if (total !== claimedAmount) continue;
        matches.push({
          pda,
          // Prefer the human invoice_id from metadata; fall back to a
          // truncated PDA so the banner copy still reads naturally for
          // legacy invoices that didn't capture an invoice_id.
          shortId: label.invoiceId || `${pda.slice(0, 6)}…${pda.slice(-4)}`,
        });
        // Short-circuit on the second match — we already know we'll
        // return null, no need to keep walking.
        if (matches.length > 1) return null;
      }
      return matches.length === 1 ? matches[0] : null;
    };
  }, [invoices, labels]);

  // NOTE: All `useMemo` calls below MUST stay above the `if (!wallet.connected)`
  // early return. Moving them below violates Rules of Hooks (different render
  // paths call different numbers of hooks → "Rendered more hooks than during
  // the previous render" runtime error on wallet connect/disconnect).

  // Stable sort by createdAt DESC. Memoized so a re-render that
  // doesn't change the underlying invoice list never reshuffles the
  // visible rows (the underlying `getProgramAccounts` returns no
  // guaranteed order). PDA tiebreaker on equal timestamps gives a
  // deterministic order even on rapidly-issued invoices.
  const incoming = useMemo(() => {
    const mapped = invoices.map((i) => ({
      pda: i.pda.toBase58(),
      creator: i.account.creator.toBase58(),
      metadataUri: i.account.metadataUri,
      status: Object.keys(i.account.status)[0] as any,
      createdAt: Number(i.account.createdAt),
    }));
    mapped.sort((a, b) => {
      if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
      return a.pda < b.pda ? -1 : a.pda > b.pda ? 1 : 0;
    });
    return mapped;
  }, [invoices]);
  // Pending count drives the Shell's nav badge + the "Bind receipt" CTA
  // visibility. We no longer split the list visually by paid/pending —
  // status dot+label per row carries the per-invoice state — but the
  // count is still useful for the surrounding chrome.
  const pendingInvoices = useMemo(
    () => incoming.filter((invoice) => invoice.status === "pending"),
    [incoming],
  );

  // Batch-fetch `PaymentIntentLock` PDAs for every Pending invoice once
  // per `incoming` change. Paid rows already settled don't need a lock
  // probe (the on-chain status is already the canonical truth);
  // cancelled/expired rows obviously don't pay either. We fetch everything
  // in a single `getMultipleAccountsInfo` call (chunked to 100 by the
  // helper) — for typical dashboards (≤50 invoices) that's exactly one
  // RPC call per refresh.
  //
  // After the lock fetch resolves, AND the connected wallet is the
  // creator of a row with status==Pending and lock!=null, we fire-and-
  // forget `markPaidOnChain` to flip on-chain status. We dedupe by PDA
  // in `lazyMarkPaidFired` so the 30s refresh interval doesn't
  // re-trigger before the next fetch reflects the flip; the on-chain
  // program rejects duplicates with `InvalidStatus` anyway, but skipping
  // them client-side saves SOL fees and Phantom popup noise.
  useEffect(() => {
    if (!wallet.publicKey) return;
    const pendingPdaList = incoming
      .filter((inv) => inv.status === "pending")
      .map((inv) => inv.pda);
    if (pendingPdaList.length === 0) {
      // Clear stale lock state when there's nothing pending — keeps
      // the Map small as paid invoices accumulate.
      if (locksByInvoice.size > 0) setLocksByInvoice(new Map());
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        // Defensive try/catch around deriveLockPda — `findProgramAddressSync`
        // can throw "Unable to find a viable program address nonce" for
        // synthetic PDAs (notably in tests). Real on-chain invoice PDAs
        // always admit a valid bump, so in production this never fires.
        const lockPdas: PublicKey[] = [];
        const lockSourcePdas: string[] = [];
        for (const pda of pendingPdaList) {
          try {
            lockPdas.push(deriveLockPda(new PublicKey(pda)));
            lockSourcePdas.push(pda);
          } catch {
            // Skip — the row will render without a settling chip.
          }
        }
        if (lockPdas.length === 0) {
          if (locksByInvoice.size > 0) setLocksByInvoice(new Map());
          return;
        }
        const lockMap = await fetchManyLocks(wallet as any, lockPdas);
        if (cancelled) return;
        // Re-key by invoice PDA for the renderer (the renderer doesn't
        // care about the lock's own PDA — it just wants "does this
        // invoice have a lock?").
        const next = new Map<string, LockState | null>();
        for (let i = 0; i < lockSourcePdas.length; i += 1) {
          const invoicePda = lockSourcePdas[i];
          const lockPda = lockPdas[i].toBase58();
          next.set(invoicePda, lockMap.get(lockPda) ?? null);
        }
        setLocksByInvoice(next);

        // Lazy mark_paid: fire-and-forget once per session per PDA.
        // utxo_commitment uses zeros — the lock PDA is the canonical
        // proof of payment, the utxo_commitment is informational-only
        // for receipts older than the lock-PDA design (pre-Fix 2).
        // Documented in the README + this comment block.
        const creatorBase58 = wallet.publicKey?.toBase58();
        if (!creatorBase58) return;
        for (const inv of incoming) {
          if (inv.status !== "pending") continue;
          if (inv.creator !== creatorBase58) continue;
          if (lazyMarkPaidFired.current.has(inv.pda)) continue;
          const lock = next.get(inv.pda);
          if (!lock) continue;
          lazyMarkPaidFired.current.add(inv.pda);
          (async () => {
            try {
              await markPaidOnChain(
                wallet as any,
                new PublicKey(inv.pda),
                new Uint8Array(32),
              );
              if (cancelled) return;
              setAutoFlipToast("Invoice marked paid — verified on-chain");
              // Trigger one short refresh so the on-chain status flip
              // shows up immediately instead of after the next 30s tick.
              await refresh();
            } catch (err: any) {
              const msg = String(err?.message ?? err);
              const alreadyPaid =
                /InvalidStatus/i.test(msg) ||
                /0x1771/i.test(msg) ||
                /Error Number: 6001/i.test(msg);
              if (alreadyPaid) {
                // Another tab beat us to it — silently fine.
                return;
              }
              // eslint-disable-next-line no-console
              console.warn(
                `[Veil dashboard] lazy mark_paid for ${inv.pda} failed:`,
                err,
              );
            }
          })();
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[Veil dashboard] fetchManyLocks failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
    // We intentionally don't depend on `locksByInvoice` (it's the output)
    // or on `refresh` (stable closure over wallet).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming, wallet.publicKey]);

  // Auto-clear the toast 4 seconds after it appears. Uses a small
  // stable-key effect so consecutive auto-flips reset the timer rather
  // than stack timers. Non-blocking — toast doesn't trap focus or
  // require user interaction.
  useEffect(() => {
    if (!autoFlipToast) return;
    const t = setTimeout(() => setAutoFlipToast(null), 4000);
    return () => clearTimeout(t);
  }, [autoFlipToast]);

  // Merged Sent feed (Task B). Invoices + payroll runs interleaved by
  // createdAt DESC. Each entry carries a `kind` discriminator so the
  // row component can pick the right rendering. We DON'T refetch
  // anything — both sources are already in state above.
  //
  // Tiebreaker on equal timestamps: invoices first then payroll, so
  // when a single payroll batch creates a swarm of invoices in the
  // same second the per-invoice rows still appear above the run
  // summary (matches the user's mental model — they signed the run,
  // then it produced these invoices).
  const sentFeed = useMemo<SentFeedEntry[]>(() => {
    const entries: SentFeedEntry[] = [];
    for (const inv of incoming) {
      entries.push({
        kind: "invoice",
        id: inv.pda,
        createdAtMs: inv.createdAt * 1000,
        invoice: inv,
      });
    }
    for (const run of payrollRunSummaries) {
      entries.push({
        kind: "payroll",
        id: run.signed.packet.batchId,
        createdAtMs: run.createdAtMs,
        run,
      });
    }
    entries.sort((a, b) => {
      if (b.createdAtMs !== a.createdAtMs) return b.createdAtMs - a.createdAtMs;
      // Stable secondary: invoice before payroll.
      if (a.kind !== b.kind) return a.kind === "invoice" ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return entries;
  }, [incoming, payrollRunSummaries]);

  const filteredSentFeed = useMemo(() => {
    if (sentTypeFilter === "all") return sentFeed;
    return sentFeed.filter((e) => e.kind === sentTypeFilter);
  }, [sentFeed, sentTypeFilter]);

  // Filter + search applied to the displayed list. ~30 invoices is
  // small enough that filtering on every keystroke is essentially free
  // — no debounce needed. Search matches:
  //   - the decrypted payer/recipient display name (from labels)
  //   - the decrypted line-item descriptions (from labels)
  //   - the invoice PDA (first 8 chars suffices for typical paste-prefix)
  const filteredInvoices = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return incoming.filter((inv) => {
      if (statusFilter !== "all" && inv.status !== statusFilter) return false;
      if (!q) return true;
      const label = labels.get(inv.pda);
      const haystack = [
        inv.pda.toLowerCase(),
        label?.payer?.toLowerCase() ?? "",
        label?.description?.toLowerCase() ?? "",
        label?.amount?.toLowerCase() ?? "",
      ].join(" ");
      return haystack.includes(q);
    });
  }, [incoming, statusFilter, searchQuery, labels]);

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

  const invoiceCount = incoming.length;
  const payrollRunCount = payrollRunSummaries.length;
  // Soft indicator for the dashboard header — claims that have come in
  // this session but have no payer receipt bound to an invoice yet.
  // Floor at 0 in case the operator applied more receipts than UTXOs
  // they personally claimed (rare: receipt for a UTXO claimed in an
  // older session that was outside the in-session set).
  const unmatchedClaims = Math.max(0, claimedCount - matchedReceiptCount);

  // Wallet-disconnected guard. MUST come AFTER all useMemo/useState/useEffect
  // hooks above so React's hook-call order stays stable across renders
  // (connect/disconnect would otherwise flip the hook count and trigger
  // "Rendered more hooks than during the previous render").
  if (!wallet.connected) {
    return (
      <Shell>
        <div className="max-w-lg reveal">
          <span className="eyebrow">Activity</span>
          <h1 className="mt-4 font-display text-ink text-[44px] md:text-[56px] leading-[1.02] tracking-[-0.02em]">
            Connect to view your activity.
          </h1>
          <p className="mt-5 text-[15px] leading-[1.55] text-ink/70 max-w-md">
            Your activity reads directly from Solana using the wallet you connect.
            Nothing is synced to a server.
          </p>
          <div className="mt-8">
            <ClientWalletMultiButton />
          </div>
        </div>
      </Shell>
    );
  }

  // Open the slide-over with the receipt input prefilled / hydrated.
  // Per-row "bind receipt" hover action is the entry from a specific
  // pending invoice; the standalone trigger button opens the panel
  // empty (or with the persisted draft).
  function openReceiptPanel(prefillPda?: string) {
    setReceiptError(null);
    if (prefillPda && receiptInput.trim() === "") {
      // Tiny convenience: drop the PDA into the textarea as a hint.
      // The receipt parser ignores it (a bare PDA is not a valid
      // receipt), but it gives the user a concrete starting point.
      setReceiptInput(`# Pasting receipt for invoice ${prefillPda}\n`);
    }
    setReceiptPanelOpen(true);
  }

  function onReceiptInputChange(value: string) {
    setReceiptInput(value);
    try {
      if (typeof window !== "undefined" && wallet.publicKey) {
        window.localStorage.setItem(
          `${RECEIPT_DRAFT_STORAGE_PREFIX}${wallet.publicKey.toBase58()}`,
          value,
        );
      }
    } catch {
      // ignore
    }
  }

  async function handlePasteFromClipboard() {
    try {
      const text = await navigator.clipboard?.readText();
      if (text) onReceiptInputChange(text);
    } catch {
      setReceiptError("Clipboard read blocked — paste manually with ⌘V / Ctrl+V.");
    }
  }

  return (
    <Shell pendingCount={pendingInvoices.length}>
      <ClaimProgressModal
        open={claimModal.open}
        current={claimModal.current}
        total={claimModal.total}
        errorMessage={claimModal.error}
      />

      {/* Apply-receipt slide-over panel. Always mounted so its textarea
          + apply button are findable in tests; transformed off-screen
          when closed. */}
      <SlideOverPanel
        open={receiptPanelOpen}
        onClose={() => setReceiptPanelOpen(false)}
        title="Import receipt"
        subtitle="Paste the signed receipt URL or blob your payer generated. We verify the ed25519 signature locally before submitting on-chain."
      >
        <div className="flex flex-col gap-4">
          {/* Recovery-flow note — surfaces this panel's role as a
              fallback. The primary flow is now lock-PDA auto-settle;
              this is the manual override for off-channel payments or
              auto-detection failures. */}
          <div className="border-l-2 border-line pl-3 py-1">
            <p className="text-[12.5px] text-ink/65 leading-[1.55]">
              Recovery flow. Most invoices auto-settle when the on-chain
              payment lock is detected — no manual import needed. Use this
              if you received a payment outside the invoice link or if
              auto-detection failed.
            </p>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="font-sans text-xs uppercase tracking-[0.18em] text-ink/50">
              Receipt
            </span>
            <button
              type="button"
              onClick={handlePasteFromClipboard}
              className="font-sans text-[12px] text-gold hover:text-ink transition-colors"
            >
              Paste from clipboard
            </button>
          </div>
          <textarea
            value={receiptInput}
            onChange={(e) => onReceiptInputChange(e.target.value)}
            placeholder="https://veil.app/receipt/<pda>#<blob>  —  or just the blob"
            rows={8}
            className="w-full font-mono text-[12px] bg-paper-3 border border-line rounded-[3px] p-3 text-ink placeholder:text-dim resize-y focus:outline-none focus:border-ink min-h-[180px]"
            disabled={applyingReceipt}
          />
          <div className="flex items-center justify-between gap-3">
            <span className="font-sans text-[11.5px] tracking-[0.08em] text-ink/40 uppercase">
              {pendingInvoices.length} pending invoice
              {pendingInvoices.length === 1 ? "" : "s"}
            </span>
            <button
              type="button"
              onClick={handleApplyReceipt}
              disabled={applyingReceipt || receiptInput.trim().length === 0}
              className="btn-ghost text-[13px] px-5 py-2 shrink-0 disabled:opacity-40"
            >
              {applyingReceipt ? "Verifying…" : "Apply receipt"}
            </button>
          </div>
          {receiptError && (
            <div className="flex items-start gap-3 border-l-2 border-brick pl-3 py-1.5">
              <span className="mono-chip text-brick shrink-0 pt-0.5">
                Receipt
              </span>
              <span className="text-[12.5px] text-ink leading-relaxed flex-1">
                {receiptError}
              </span>
            </div>
          )}
          <p className="mt-2 text-[12px] text-ink/50 leading-[1.55]">
            The receipt cryptographically binds one specific payment to one
            specific invoice. Drafts are saved automatically — close this
            panel without losing your work.
          </p>
        </div>
      </SlideOverPanel>

      {/* Page header — Boska serif on the H1 ONLY (per editorial spec).
          2026-05-04 v4: dropped the wallet-shorthand eyebrow above the
          H1 (the user already sees their wallet in the top nav and the
          balance card; repeating it here read as noise). Subtitle copy
          tightened from "Encrypted to you" → "Encrypted for you" — "to"
          read directional/awkward; "for" reads beneficiary-natural. */}
      <div className="flex items-start justify-between gap-6 mb-10 reveal">
        <div>
          <h1 className="font-display text-ink text-[44px] md:text-[60px] leading-[1.0] tracking-[-0.02em]">
            Activity
          </h1>
          <p className="mt-3 text-[14.5px] text-ink/55 max-w-lg leading-[1.5]">
            Read directly from Solana. Encrypted for you.
          </p>
        </div>
        {/* Right-side action cluster. "Run payroll" was removed
            2026-05-05 — it was redundant with the global nav's
            Create entry, which can route to Payroll mode directly.
            Auditor grants kept since it's a less-discoverable
            advanced flow that benefits from a header anchor. */}
        <div className="pt-2 shrink-0 flex items-center gap-5">
          <a
            href="/dashboard/compliance"
            className="hidden md:inline-flex items-center gap-1.5 font-mono text-[11px] tracking-[0.16em] uppercase text-ink/60 hover:text-ink transition-colors"
          >
            <span>Auditor grants</span>
            <span className="text-gold" aria-hidden>&rarr;</span>
          </a>
          <RefreshButton onClick={refresh} loading={loading} />
        </div>
      </div>

      {/* Top-level tab bar — Inbox / Sent / Balance. Mercury/Linear
          register: hairline underline on the row, 2px ink underline on
          the active tab. No chunky pills. Counts are quietly tabular
          right after the label so a fresh user with empty state sees
          structure rather than three identical chrome stubs. */}
      <div className="border-b border-line mb-10">
        <div className="flex gap-8">
          <DashboardTabButton
            label="Inbox"
            active={tab === "inbox"}
            onClick={() => setTab("inbox")}
          />
          <DashboardTabButton
            label="Sent"
            count={invoiceCount + payrollRunCount}
            active={tab === "sent"}
            onClick={() => setTab("sent")}
          />
          <DashboardTabButton
            label="Balance"
            active={tab === "balance"}
            onClick={() => setTab("balance")}
          />
        </div>
      </div>

      {/* Errors + notices live above the tab content so they aren't
          hidden behind a tab switch. The receiver-key repair affordance
          rides along with the error block since it's strictly an Umbra-
          channel issue surfaced during refresh. */}
      {error && (
        <div className="mb-8 flex items-start gap-4 border-l-2 border-brick pl-4 py-2 max-w-2xl">
          <span className="mono-chip text-brick shrink-0 pt-0.5">Error</span>
          <span className="text-[13.5px] text-ink leading-relaxed flex-1">{error}</span>
          {receiverKeyMismatch && (
            <button
              type="button"
              onClick={handleRepairReceiverKey}
              disabled={repairingReceiverKey}
              className="btn-ghost text-[12px] px-3 py-1.5 shrink-0"
            >
              {repairingReceiverKey ? "Repairing..." : "Repair Umbra key"}
            </button>
          )}
        </div>
      )}

      {notice && (
        <div className="mb-8 flex items-start gap-4 border-l-2 border-sage pl-4 py-2 max-w-2xl">
          <span className="mono-chip text-sage shrink-0 pt-0.5">Note</span>
          <span className="text-[13.5px] text-ink leading-relaxed flex-1">{notice}</span>
        </div>
      )}

      {/* Auto-flip toast — surfaces the lazy mark_paid that fires when
          the dashboard detects a `PaymentIntentLock` on a Pending row.
          Non-blocking, dismisses on its own after 4s. Same visual
          register as the persistent notice above so the styling stays
          consistent. */}
      {autoFlipToast && (
        <div
          role="status"
          aria-live="polite"
          className="mb-8 flex items-start gap-4 border-l-2 border-sage pl-4 py-2 max-w-2xl"
        >
          <span className="mono-chip text-sage shrink-0 pt-0.5">Settled</span>
          <span className="text-[13.5px] text-ink leading-relaxed flex-1">
            {autoFlipToast}
          </span>
        </div>
      )}

      {tab === "inbox" && (
        <>
          {/* Recipient-side private payments — pending claims + history.
              Now passes the receipt-suggest matcher so the section can
              surface a "matches invoice X — bind receipt?" banner after
              a successful claim. */}
          <IncomingPrivatePaymentsSection
            wallet={wallet}
            findReceiptCandidate={findReceiptCandidate}
            onBindReceipt={(pda) => openReceiptPanel(pda)}
          />
          {/* Inbound invoices — invoices a payer has been asked to settle.
              Component lives in a parallel subagent's PR; we render it
              with no props (integration assumption: internally wallet-
              aware via useWallet, mirrors the IncomingPrivatePaymentsSection
              pattern). */}
          <IncomingInvoicesSection />
        </>
      )}

      {tab === "sent" && (
        <>
          {unmatchedClaims > 0 && (
            <div className="mb-6 flex items-start gap-4 border-l-2 border-gold pl-4 py-2 max-w-2xl">
              <span className="mono-chip text-gold shrink-0 pt-0.5">Unmatched</span>
              <span className="text-[13.5px] text-ink leading-relaxed flex-1">
                {unmatchedClaims} received UTXO{unmatchedClaims === 1 ? "" : "s"}{" "}
                claimed this session without a matching payer receipt. Funds are
                in your private balance, but no invoice is bound until a receipt
                arrives. Ask the payer to share their signed receipt link.
              </span>
            </div>
          )}

          {/* Type chip strip — All / Invoices / Payroll. Sits above the
              merged feed; identical visual register to the FilterBar
              status pills below for invoice-status filtering. The
              "More ▾" dropdown sits to its right and gates the
              recovery-flow receipt-import affordance (per the
              banking-grade reconciliation UX plan: most invoices now
              auto-settle, so manual import is no longer primary). */}
          <div className="mb-6 flex items-center justify-between gap-4 flex-wrap">
            <SentTypeChips
              value={sentTypeFilter}
              setValue={setSentTypeFilter}
              invoiceCount={invoiceCount}
              payrollCount={payrollRunCount}
            />
            <SentMoreMenu
              open={moreMenuOpen}
              setOpen={setMoreMenuOpen}
              onImportReceipt={() => {
                setMoreMenuOpen(false);
                openReceiptPanel();
              }}
            />
          </div>

          {/* Status filter + search applies to invoice-typed rows in the
              feed. Hidden when the active type filter is "payroll" (no
              invoices to filter) and when the underlying invoice list
              is empty. */}
          {sentTypeFilter !== "payroll" && incoming.length > 0 && (
            <FilterBar
              statusFilter={statusFilter}
              setStatusFilter={setStatusFilter}
              searchQuery={searchQuery}
              setSearchQuery={setSearchQuery}
            />
          )}

          {/* Merged feed body. Empty/skeleton states branch on whether
              we've fetched yet AND whether either source has data. */}
          {(() => {
            if (loading && !hasFetchedOnce) return <LedgerSkeleton />;

            if (sentFeed.length === 0) {
              return <SentEmptyState />;
            }

            // Pre-filter the feed by:
            //  - the type chip ("all" | "invoice" | "payroll")
            //  - status + search ONLY for invoice rows (payroll runs
            //    are surfaced as-is regardless of those controls —
            //    they have their own state model)
            const visible = filteredSentFeed.filter((entry) => {
              if (entry.kind !== "invoice") return true;
              return filteredInvoices.some((fi) => fi.pda === entry.invoice.pda);
            });

            if (visible.length === 0) {
              return (
                <LedgerEmptyState
                  kind="filtered"
                  onClear={() => {
                    setSentTypeFilter("all");
                    setStatusFilter("all");
                    setSearchQuery("");
                  }}
                />
              );
            }

            return (
              <SentFeed
                entries={visible}
                labels={labels}
                locksByInvoice={locksByInvoice}
                onBindReceipt={(pda) => openReceiptPanel(pda)}
              />
            );
          })()}

          {batchList.length > 0 && sentTypeFilter !== "payroll" && (
            <div className="mt-14">
              <div className="flex items-baseline justify-between mb-6 border-b border-line pb-3">
                <span className="font-sans text-xs uppercase tracking-[0.18em] text-ink/50">
                  Invoice batches
                </span>
                <div className="flex items-center gap-4">
                  <a href="/payroll/new" className="btn-quiet text-[12px]">
                    + New batch
                  </a>
                </div>
              </div>
              <ul className="divide-y divide-ink/5">
                {batchList.map((b) => (
                  <li
                    key={b.batchId}
                    className="py-4 grid grid-cols-[1fr_auto_auto] gap-4 items-baseline"
                  >
                    <a
                      href={`/payroll/${b.batchId}`}
                      className="font-mono text-[13px] text-ink hover:text-gold transition-colors truncate"
                    >
                      {b.batchId}
                    </a>
                    <span className="font-sans text-[12px] text-ink/45 tabular-nums">
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

          {/* Footer fallback (mobile only). Desktop has the auditor-grants
              link in the page header next to Refresh. "Run private payroll"
              dropped 2026-05-05 — Create in the global nav goes there. */}
          <div className="mt-10 pt-8 border-t border-line flex md:hidden">
            <a href="/dashboard/compliance" className="btn-quiet">
              Manage auditor grants →
            </a>
          </div>
        </>
      )}

      {tab === "balance" && (
        <BalanceTab
          balance={balance}
          depositOpen={depositOpen}
          setDepositOpen={setDepositOpen}
          depositAmount={depositAmount}
          setDepositAmount={setDepositAmount}
          depositing={depositing}
          withdrawing={withdrawing}
          onDeposit={handleDepositToShielded}
          onWithdrawAll={handleWithdrawAll}
        />
      )}
    </Shell>
  );
}

/**
 * Ledger section — title + grouped editorial rows.
 *
 * Rows are bucketed by createdAt into Today/Yesterday/This week/...
 * with thin DateGroupHeader for each non-empty bucket. Stagger
 * fade-up on initial mount (animation-delay per index, capped at
 * 600ms).
 *
 * 2026-05-04 refinement: PayPal-style collapse — Today + Yesterday are
 * always shown inline. Everything older (This week / This month /
 * Earlier) collapses behind a single "Earlier · N invoices ▾" toggle,
 * which when expanded reveals those buckets in their natural order.
 * Default is collapsed because most users only care about the recent
 * window; older invoices are reachable in a single click.
 */
type LedgerInvoice = {
  pda: string;
  status: string;
  createdAt: number;
};

const RECENT_BUCKETS: ReadonlyArray<string> = ["Today", "Yesterday"];

function LedgerSection({
  invoices,
  labels,
  onBindReceipt,
}: {
  invoices: Array<LedgerInvoice>;
  labels: Map<
    string,
    {
      payer: string;
      amount: string;
      description: string;
      totalRaw: string;
      invoiceId: string;
    }
  >;
  onBindReceipt: (pda: string) => void;
}) {
  // Bucket the (already sorted DESC by createdAt) list. Empty buckets
  // are skipped at render time but the order is fixed by
  // DATE_BUCKET_ORDER.
  const buckets = new Map<string, LedgerInvoice[]>();
  for (const inv of invoices) {
    const key = bucketByCreatedAt(inv.createdAt);
    const arr = buckets.get(key) ?? [];
    arr.push(inv);
    buckets.set(key, arr);
  }

  // Split into recent (always shown inline) vs older (behind the
  // collapse toggle). The order within each group still follows
  // DATE_BUCKET_ORDER so Today appears above Yesterday, This week above
  // This month, etc.
  const recentBuckets = DATE_BUCKET_ORDER.filter(
    (label) => RECENT_BUCKETS.includes(label) && (buckets.get(label)?.length ?? 0) > 0,
  );
  const olderBuckets = DATE_BUCKET_ORDER.filter(
    (label) => !RECENT_BUCKETS.includes(label) && (buckets.get(label)?.length ?? 0) > 0,
  );
  const olderCount = olderBuckets.reduce(
    (sum, label) => sum + (buckets.get(label)?.length ?? 0),
    0,
  );

  // Default closed when there ARE recent invoices — most usage is
  // checking what came in today. When there's nothing recent, default
  // open so the user isn't staring at a single italic line + a
  // collapsed toggle (which would feel broken). The PayPal pattern
  // that landed well in the spec assumes the recent slice is the
  // headline; if it's empty the older slice IS the headline.
  const [olderOpen, setOlderOpen] = useState(recentBuckets.length === 0);

  // `runningIndex` drives the stagger animation delay across BOTH the
  // recent and older sections so when older expands the rows continue
  // the visual cascade rather than restart at index 0.
  let runningIndex = 0;

  function renderBucket(bucketLabel: string): JSX.Element[] {
    const rows = buckets.get(bucketLabel);
    if (!rows || rows.length === 0) return [];
    const out: JSX.Element[] = [
      <DateGroupHeader
        key={`hdr-${bucketLabel}`}
        label={bucketLabel}
      />,
    ];
    for (const inv of rows) {
      const idx = runningIndex++;
      const delay = Math.min(idx * 50, 600);
      out.push(
        <InvoiceRow
          key={inv.pda}
          pda={inv.pda}
          status={inv.status}
          createdAt={inv.createdAt}
          label={labels.get(inv.pda)}
          animationDelayMs={delay}
          onBindReceipt={onBindReceipt}
        />,
      );
    }
    return out;
  }

  return (
    <div>
      {/* Recent section — Today + Yesterday inline, no surrounding chrome.
          The DateGroupHeaders are now thin enough that they can carry the
          structure without an outer section title. */}
      {recentBuckets.length > 0 && (
        <ul className="divide-y divide-ink/5">
          {recentBuckets.flatMap(renderBucket)}
        </ul>
      )}

      {/* Empty-recent fallback: if the user has older invoices but
          nothing today/yesterday, show a small italic line so the page
          doesn't look broken — the toggle right below it surfaces the
          older history. 2026-05-04 v4: dropped the bottom border (the
          Earlier toggle's own border-t carries the separator; having
          both produced a perceived 'double line' on the Paid filter
          where Today/Yesterday are usually empty). */}
      {recentBuckets.length === 0 && olderBuckets.length > 0 && (
        <p className="font-display italic text-ink/50 text-[15px] py-6 px-4">
          Nothing today or yesterday.
        </p>
      )}

      {/* Older toggle — PayPal-style accordion. Default collapsed.
          2026-05-04 v3 refinement (user feedback): the prior toggle was
          too quiet to discover (text-ink/50 mono 10.5px). Bumped to
          12.5px, paired with a hairline top border so it reads as a
          deliberate section affordance, increased contrast on hover,
          and the chevron is now slightly larger so the click target is
          unmistakable. Still mono small-caps so it sits in the
          editorial language. */}
      {olderBuckets.length > 0 && (
        <div className="mt-2 border-t border-line/60">
          <button
            type="button"
            onClick={() => setOlderOpen((v) => !v)}
            aria-expanded={olderOpen}
            aria-controls="ledger-older-section"
            className={[
              "group w-full flex items-center justify-between",
              "px-2 py-4 rounded-[3px]",
              "font-mono text-[12.5px] tracking-[0.16em] uppercase",
              "text-ink/70 hover:text-ink hover:bg-paper-2/60",
              "transition-colors duration-150",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/30",
            ].join(" ")}
          >
            <span className="inline-flex items-center gap-3">
              <span>{olderOpen ? "Hide earlier" : "Earlier"}</span>
              <span className="text-ink/30">·</span>
              <span className="tabular-nums text-ink/55">
                {String(olderCount).padStart(2, "0")} invoice{olderCount === 1 ? "" : "s"}
              </span>
            </span>
            <ChevronIcon open={olderOpen} />
          </button>
          {olderOpen && (
            <ul
              id="ledger-older-section"
              className="divide-y divide-ink/5 mt-1 animate-fade-up"
            >
              {olderBuckets.flatMap(renderBucket)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Filter bar — modern command-bar layout.
 *
 * Status as inline pill segments (no <select>), search as icon + bottom
 * underline (no boxed input), Bind receipt as quiet text link with
 * arrow. The whole row reads airy — typography, not borders, carries
 * the structure.
 */
function FilterBar({
  statusFilter,
  setStatusFilter,
  searchQuery,
  setSearchQuery,
}: {
  statusFilter: StatusFilter;
  setStatusFilter: (v: StatusFilter) => void;
  searchQuery: string;
  setSearchQuery: (v: string) => void;
}) {
  const segments: ReadonlyArray<{ value: StatusFilter; label: string }> = [
    { value: "all", label: "All" },
    { value: "pending", label: "Pending" },
    { value: "paid", label: "Paid" },
    { value: "cancelled", label: "Cancelled" },
  ];
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6 max-w-3xl">
      {/* Status pill segments — bg-paper-2/70 on the active pill, mono
          small-caps for label, rounded-full. Click to switch. */}
      <div
        role="tablist"
        aria-label="Filter invoices by status"
        className="inline-flex items-center gap-1 self-start sm:self-auto"
      >
        {segments.map((seg) => {
          const active = statusFilter === seg.value;
          return (
            <button
              key={seg.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setStatusFilter(seg.value)}
              className={[
                "px-3 py-1.5 rounded-full",
                "font-mono text-[10.5px] tracking-[0.14em] uppercase",
                "transition-colors duration-150",
                active
                  ? "bg-paper-2 text-ink"
                  : "text-ink/45 hover:text-ink hover:bg-paper-2/40",
              ].join(" ")}
            >
              {seg.label}
            </button>
          );
        })}
      </div>

      {/* Search — icon + underline only. No box. The bottom rule
          deepens to ink on focus; gold caret. */}
      <label className="group relative flex-1 flex items-center gap-2 border-b border-line/70 pb-1.5 focus-within:border-ink transition-colors duration-150">
        <SearchIcon className="text-ink/35 group-focus-within:text-ink/65 transition-colors" />
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search…"
          aria-label="Search invoices"
          className="w-full bg-transparent border-0 outline-none font-sans text-[13.5px] text-ink placeholder:text-ink/30 caret-gold py-0.5"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => setSearchQuery("")}
            aria-label="Clear search"
            className="font-mono text-[10px] tracking-[0.14em] uppercase text-ink/35 hover:text-ink transition-colors shrink-0"
          >
            Clear
          </button>
        )}
      </label>

      {/* Import-receipt button used to live here. Moved 2026-05-06 to a
          "More ▾" overflow menu in the Sent tab header — most invoices
          now auto-settle from the on-chain `PaymentIntentLock`, so
          manual receipt import is a recovery flow, not a primary
          affordance. */}
    </div>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`}
      aria-hidden
    >
      <path d="M2 3.5l3 3 3-3" />
    </svg>
  );
}

function SearchIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 13 13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <circle cx="5.5" cy="5.5" r="3.5" />
      <path d="M11.5 11.5L8 8" />
    </svg>
  );
}

/**
 * Editorial empty state — Boska italic centered, "No invoices match
 * your filters." or "No invoices yet." NO cartoonish illustration.
 */
function LedgerEmptyState({
  kind,
  onClear,
}: {
  kind: "zero" | "filtered";
  onClear?: () => void;
}) {
  if (kind === "zero") {
    return (
      <div className="border border-dashed border-line rounded-[4px] py-16 px-8 text-center max-w-2xl mx-auto">
        <p className="font-display italic text-ink/80 text-[24px] leading-[1.3]">
          A blank page.
        </p>
        <p className="mt-3 text-[14px] text-ink/55 leading-relaxed max-w-md mx-auto">
          You haven&apos;t created any invoices yet. The first one shows up
          here the moment it lands on Solana.
        </p>
        <a href="/create" className="mt-6 inline-block btn-quiet text-[13px]">
          Create your first invoice →
        </a>
      </div>
    );
  }
  return (
    <div className="border border-dashed border-line rounded-[4px] py-14 px-8 text-center max-w-2xl mx-auto">
      <p className="font-display italic text-ink/80 text-[22px] leading-[1.3]">
        No invoices match your filters.
      </p>
      <p className="mt-3 text-[13.5px] text-ink/55 leading-relaxed max-w-md mx-auto">
        Try a different status or clear the search to see everything again.
      </p>
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          className="mt-5 btn-quiet text-[13px]"
        >
          Clear filters →
        </button>
      )}
    </div>
  );
}

/**
 * Loading skeleton — three placeholder rows matching the editorial-row
 * layout. bg-paper-2 + animate-pulse. Holds the layout open during the
 * initial fetch so the page doesn't reflow when invoices arrive.
 */
function LedgerSkeleton() {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-4">
        <span className="font-sans text-xs uppercase tracking-[0.18em] text-ink/30">
          Loading
        </span>
        <span className="font-sans text-[10.5px] tabular-nums tracking-[0.12em] text-ink/25">
          ··
        </span>
      </div>
      <ul className="divide-y divide-ink/5">
        {Array.from({ length: 3 }).map((_, i) => (
          <li key={i} className="px-4 py-3">
            <div className="hidden sm:grid sm:grid-cols-[88px_1fr_140px_auto_auto] sm:items-center sm:gap-5">
              <div className="skeleton-bar h-[12px] w-[60px]" />
              <div className="skeleton-bar h-[14px] w-[55%]" />
              <div className="skeleton-bar h-[10px] w-[100px]" />
              <div className="skeleton-bar h-[14px] w-[80px] justify-self-end" />
              <div className="skeleton-bar h-[12px] w-[70px]" />
            </div>
            <div className="sm:hidden flex flex-col gap-2">
              <div className="skeleton-bar h-[14px] w-[60%]" />
              <div className="skeleton-bar h-[12px] w-[40%]" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Top-level dashboard tab button — Mercury/Linear register.
 * Hairline base + 2px ink underline on active. Mono small-caps. The
 * active tab gets `text-ink`, inactive gets `text-muted` with hover
 * fading toward `text-ink`. `count` is rendered as a quiet tabular
 * suffix when present (used by Sent so the user sees how much "stuff"
 * is queued without opening the tab).
 */
function DashboardTabButton({
  label,
  active,
  count,
  onClick,
}: {
  label: string;
  active: boolean;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        "pb-3 -mb-[2px] border-b-2",
        "text-[13px] font-mono tracking-[0.1em] uppercase",
        "transition-colors",
        active
          ? "border-ink text-ink"
          : "border-transparent text-muted hover:text-ink",
      ].join(" ")}
    >
      <span>{label}</span>
      {typeof count === "number" && (
        <span
          className={`ml-2 tabular-nums ${
            active ? "text-ink/55" : "text-ink/30"
          }`}
        >
          {count}
        </span>
      )}
    </button>
  );
}

/**
 * Type chip strip for the Sent feed. All / Invoices / Payroll. Same
 * pill register as the FilterBar status chips below — keeps the visual
 * vocabulary tight (one chip style across the page).
 */
function SentTypeChips({
  value,
  setValue,
  invoiceCount,
  payrollCount,
}: {
  value: SentTypeFilter;
  setValue: (v: SentTypeFilter) => void;
  invoiceCount: number;
  payrollCount: number;
}) {
  const segments: ReadonlyArray<{
    value: SentTypeFilter;
    label: string;
    count?: number;
  }> = [
    { value: "all", label: "All", count: invoiceCount + payrollCount },
    { value: "invoice", label: "Invoices", count: invoiceCount },
    { value: "payroll", label: "Payroll", count: payrollCount },
  ];
  return (
    <div
      role="tablist"
      aria-label="Filter sent items by type"
      className="inline-flex items-center gap-1"
    >
      {segments.map((seg) => {
        const active = value === seg.value;
        return (
          <button
            key={seg.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => setValue(seg.value)}
            className={[
              "px-3 py-1.5 rounded-full",
              "font-mono text-[10.5px] tracking-[0.14em] uppercase",
              "transition-colors duration-150 inline-flex items-center gap-2",
              active
                ? "bg-paper-2 text-ink"
                : "text-ink/45 hover:text-ink hover:bg-paper-2/40",
            ].join(" ")}
          >
            <span>{seg.label}</span>
            {typeof seg.count === "number" && (
              <span className="tabular-nums text-ink/35">{seg.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Sent-tab "More ▾" overflow dropdown.
 *
 * Demoted home for the receipt-import affordance — pre-2026-05-06 it
 * lived as a primary chip in the FilterBar toolbar, but most invoices
 * now auto-settle from the on-chain `PaymentIntentLock`, so manual
 * import has been moved to a recovery-only surface here.
 *
 * Click-toggle dropdown — no portal, no new dependency. Closes on
 * outside click via a body-level listener that reads
 * `event.composedPath()` so the menu's own buttons don't dismiss it
 * before the click handler fires.
 */
function SentMoreMenu({
  open,
  setOpen,
  onImportReceipt,
}: {
  open: boolean;
  setOpen: (next: boolean | ((prev: boolean) => boolean)) => void;
  onImportReceipt: () => void;
}) {
  // Outside-click + Escape close. Listeners only mount while the menu
  // is open so they don't compete with other body-level handlers in the
  // happy path. We test `instanceof Element` before calling `.closest`
  // because `ev.target` can be a Document or Window in edge cases (e.g.
  // clicks dispatched via DevTools).
  useEffect(() => {
    if (!open) return;
    function onDocClick(ev: MouseEvent) {
      const t = ev.target;
      if (t instanceof Element && !t.closest("[data-sent-more-menu]")) {
        setOpen(false);
      }
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen]);

  return (
    <div className="relative" data-sent-more-menu>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        className={[
          "inline-flex items-center gap-1.5",
          "font-mono text-[11px] tracking-[0.14em] uppercase",
          "text-ink/55 hover:text-ink transition-colors",
          "px-2 py-1.5 rounded-[3px]",
          open ? "bg-paper-2/60 text-ink" : "",
        ].join(" ")}
      >
        <span>More</span>
        <span aria-hidden className={`transition-transform ${open ? "rotate-180" : ""}`}>
          ▾
        </span>
      </button>
      {open && (
        <div
          role="menu"
          className={[
            "absolute right-0 top-full mt-1 z-30 min-w-[200px]",
            "border border-line bg-paper rounded-[3px]",
            "shadow-[0_2px_12px_-4px_rgba(28,23,18,0.18)]",
            "py-1",
          ].join(" ")}
        >
          <button
            type="button"
            role="menuitem"
            onClick={onImportReceipt}
            aria-label="Open the apply-receipt panel"
            className="w-full text-left px-3 py-2 font-sans text-[13px] text-ink/75 hover:bg-paper-2 hover:text-ink transition-colors"
          >
            Import receipt
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Type badge for Sent feed rows — small mono chip indicating whether
 * the row is an Invoice or a Payroll run. Uses the existing accent
 * tokens (gold for invoices, sage for payroll) so the badge sits in
 * the established visual language without adding new design tokens.
 */
function SentTypeBadge({ kind }: { kind: "invoice" | "payroll" }) {
  const cls =
    kind === "invoice"
      ? "border-ink/15 text-ink/65 bg-paper-2/60"
      : "border-sage/40 text-sage bg-sage/5";
  const label = kind === "invoice" ? "Invoice" : "Payroll";
  return (
    <span
      className={`shrink-0 inline-block px-2 py-[3px] border rounded-[2px] font-mono text-[9.5px] tracking-[0.14em] uppercase ${cls}`}
    >
      {label}
    </span>
  );
}

/**
 * Merged Sent feed body. Walks the discriminated union of entries and
 * renders the right row component per kind. Both row variants live
 * inside the same hairline-bordered container so the eye sees one
 * continuous ledger rather than two stacked sections.
 */
function SentFeed({
  entries,
  labels,
  locksByInvoice,
  onBindReceipt,
}: {
  entries: SentFeedEntry[];
  labels: Map<
    string,
    {
      payer: string;
      amount: string;
      description: string;
      totalRaw: string;
      invoiceId: string;
    }
  >;
  locksByInvoice: Map<string, LockState | null>;
  onBindReceipt: (pda: string) => void;
}) {
  // Outer container is a <div>, not a <ul>: InvoiceRow and
  // PayrollRunRow each render their own <li> internally, so each entry
  // gets its own single-item <ul> wrapper to keep the <li> validly
  // parented. Previously this was <ul><li><InvoiceRow/></li></ul> which
  // produced <li> directly inside <li> (React DOM-nesting warning).
  // Divide-y on the outer <div> keeps the visual register identical.
  return (
    <div className="border border-line rounded-[4px] bg-paper-3 divide-y divide-line">
      {entries.map((entry, idx) => {
        if (entry.kind === "invoice") {
          const inv = entry.invoice;
          // settling = on-chain lock present but invoice status still
          // Pending. The lock is the canonical proof of payment; the
          // invoice account hasn't been mark_paid'd yet (creator hasn't
          // settled it, or the lazy mark_paid is in-flight).
          const settling =
            inv.status === "pending" && !!locksByInvoice.get(inv.pda);
          const invoiceHasLock = settling || inv.status === "paid";
          return (
            <div
              key={`inv:${entry.id}`}
              className="px-2 sm:px-3 py-1 flex items-center gap-3"
            >
              <SentTypeBadge kind="invoice" />
              <ul className="flex-1 min-w-0 m-0 p-0 list-none">
                <InvoiceRow
                  pda={inv.pda}
                  status={inv.status}
                  createdAt={inv.createdAt}
                  label={labels.get(inv.pda)}
                  settling={settling}
                  animationDelayMs={Math.min(idx * 40, 400)}
                  onBindReceipt={onBindReceipt}
                />
              </ul>
              {/* Row-level reconciliation actions. PDF downloads live on
                  the invoice detail page (/invoice/[pda]) where the full
                  decrypted metadata is in scope; from the Sent feed the
                  menu surfaces compliance + explorer, which only need the
                  PDA. Stops propagation so clicking the menu doesn't bubble
                  up to the row-level navigation. */}
              <div onClick={(e) => e.stopPropagation()} className="shrink-0">
                <RowOverflowMenu
                  invoicePda={inv.pda}
                  invoiceHasLock={invoiceHasLock}
                />
              </div>
            </div>
          );
        }
        return (
          <div
            key={`run:${entry.id}`}
            className="flex items-stretch gap-3 px-2 sm:px-3"
          >
            <span className="self-center">
              <SentTypeBadge kind="payroll" />
            </span>
            <ul className="flex-1 min-w-0 m-0 p-0 list-none">
              <PayrollRunRow run={entry.run} />
            </ul>
            <div onClick={(e) => e.stopPropagation()} className="shrink-0 self-center">
              <RowOverflowMenu payrollBatchId={entry.run.signed.packet.batchId} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Sent-feed empty state. Single page, no per-source split — the user
 * sees one prompt covering both invoices and payroll runs.
 */
function SentEmptyState() {
  return (
    <div className="border border-dashed border-line rounded-[4px] py-16 px-8 text-center max-w-2xl mx-auto">
      <p className="font-display italic text-ink/80 text-[24px] leading-[1.3]">
        Nothing sent yet.
      </p>
      <p className="mt-3 text-[14px] text-ink/55 leading-relaxed max-w-md mx-auto">
        Invoices and payroll runs you create show up here in chronological
        order. Start with a single invoice or a payroll batch.
      </p>
      <a href="/create" className="mt-6 inline-block btn-quiet text-[13px]">
        Go to Create →
      </a>
    </div>
  );
}

/**
 * Balance tab — Mercury-style card with Deposit / Withdraw. Lifted
 * verbatim from the previous in-tab placement; the wrapper props let
 * the dashboard keep its state at the page level so cross-tab refresh
 * loops keep updating it even when the tab isn't visible.
 */
function BalanceTab({
  balance,
  depositOpen,
  setDepositOpen,
  depositAmount,
  setDepositAmount,
  depositing,
  withdrawing,
  onDeposit,
  onWithdrawAll,
}: {
  balance: bigint | null;
  depositOpen: boolean;
  setDepositOpen: (next: boolean | ((prev: boolean) => boolean)) => void;
  depositAmount: string;
  setDepositAmount: (next: string) => void;
  depositing: boolean;
  withdrawing: boolean;
  onDeposit: () => void;
  onWithdrawAll: () => void;
}) {
  return (
    <div className="border border-line bg-paper-3 rounded-[4px] p-6 md:p-8 reveal">
      <div className="flex items-start justify-between gap-6 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5 mb-1">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-sage" />
            <span className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-ink/55">
              Private balance
            </span>
          </div>
          <div className="mt-3 flex items-baseline gap-3">
            <span className="font-sans tabular-nums tracking-tight text-ink text-[40px] md:text-[52px] font-medium leading-none">
              {formatBigintAmount(balance, PAYMENT_DECIMALS)}
            </span>
            <span className="font-mono text-[12px] tracking-[0.14em] text-ink/45 uppercase">
              {PAYMENT_SYMBOL}
            </span>
          </div>
          <p className="mt-2.5 text-[12px] text-ink/45 leading-relaxed">
            Encrypted at rest. Decryptable only by your wallet.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() =>
              setDepositOpen((v: boolean) => !v)
            }
            disabled={depositing}
            aria-expanded={depositOpen}
            className="inline-flex items-center gap-2 border border-line rounded-[3px] px-4 py-2.5 text-[12.5px] tracking-[0.04em] text-ink hover:bg-paper-2 disabled:opacity-50 transition-colors"
          >
            <span aria-hidden className="text-ink/55">↓</span>
            <span>{depositing ? "Depositing…" : "Deposit"}</span>
          </button>
          <button
            type="button"
            onClick={onWithdrawAll}
            disabled={withdrawing || balance == null || balance <= 0n}
            className="inline-flex items-center gap-2 border border-line rounded-[3px] px-4 py-2.5 text-[12.5px] tracking-[0.04em] text-ink hover:bg-paper-2 disabled:opacity-40 transition-colors"
          >
            <span aria-hidden className="text-ink/55">↑</span>
            <span>{withdrawing ? "Withdrawing…" : "Withdraw"}</span>
          </button>
        </div>
      </div>

      {depositOpen && (
        <div className="mt-6 pt-6 border-t border-line">
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-2">
              <span className="font-mono text-[10.5px] tracking-[0.16em] uppercase text-ink/55">
                Amount to shield
              </span>
              <div className="relative">
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="1.0"
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  disabled={depositing}
                  autoFocus
                  className="font-sans tabular-nums text-[20px] bg-paper-2 border border-line rounded-[3px] pl-3 pr-12 py-2.5 w-44 focus:outline-none focus:border-ink/40 transition-colors"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[10.5px] tracking-[0.14em] uppercase text-ink/45 pointer-events-none">
                  {PAYMENT_SYMBOL}
                </span>
              </div>
            </label>
            <button
              type="button"
              onClick={onDeposit}
              disabled={depositing || !depositAmount}
              className="btn-primary text-[12.5px] px-5 py-2.5 disabled:opacity-40"
            >
              {depositing ? "Depositing…" : "Shield privately"}
            </button>
            <button
              type="button"
              onClick={() => {
                setDepositOpen(false);
                setDepositAmount("");
              }}
              disabled={depositing}
              className="text-[12.5px] text-ink/55 hover:text-ink underline-offset-4 hover:underline transition-colors"
            >
              Cancel
            </button>
          </div>
          <p className="mt-4 text-[12px] text-ink/50 leading-[1.55] max-w-xl">
            Moves SOL from your public wallet into your encrypted balance
            through Umbra&apos;s mixer. This deposit tx is publicly visible
            — every payment system has to anchor to real money somewhere.
            But every subsequent payroll run sourced from this balance hides
            the amount on chain. Settles in ~10–30 s through Arcium MPC.
          </p>
        </div>
      )}
    </div>
  );
}

function PayrollRunRow({ run }: { run: PayrollRunSummary }) {
  const { packet } = run.signed;
  const totalDisplay = `${formatPayrollAmount(run.totalUnits, packet.decimals)} ${packet.symbol}`;
  const recipients = packet.rows.length;
  const dateLabel = formatPayrollRunDate(run.createdAtMs);
  const batchShort = `${packet.batchId.slice(0, 14)}…${packet.batchId.slice(-4)}`;

  // When any row carries a recipientName, surface the first few names
  // inline ("3 recipients · Alice, Bob, Carol") so the run row reads
  // like a real payroll instead of "3 recipients · 7onP… · 9nW8…".
  // Falls back gracefully when no row has a name, matching legacy
  // packets and name-less CSVs.
  const namedRecipients = packet.rows
    .map((r) => r.recipientName?.trim())
    .filter((s): s is string => !!s);
  const previewNames = namedRecipients.slice(0, 3).join(", ");
  const remainingNamed = namedRecipients.length - 3;
  const recipientCopy = (() => {
    const base = `${recipients} recipient${recipients === 1 ? "" : "s"}`;
    if (namedRecipients.length === 0) {
      return `${base} · ${run.paid} paid${run.failed > 0 ? ` · ${run.failed} failed` : ""}`;
    }
    const including =
      remainingNamed > 0
        ? `including ${previewNames} +${remainingNamed} more`
        : `including ${previewNames}`;
    return `${base} ${including} · ${run.paid} paid${run.failed > 0 ? ` · ${run.failed} failed` : ""}`;
  })();

  return (
    <li>
      <a
        href={`/payroll/${packet.batchId}`}
        className="flex items-center justify-between gap-6 px-5 md:px-6 py-4 hover:bg-paper-2/40 transition-colors cursor-pointer"
        aria-label={`Open payroll run ${packet.batchId}`}
      >
        <div className="flex items-baseline gap-5 min-w-0 flex-1">
          <span className="font-sans tabular-nums text-[12px] text-ink/45 shrink-0 tracking-tight">
            {dateLabel}
          </span>
          <div className="flex items-baseline gap-3 min-w-0 flex-1">
            <span className="font-mono text-[12px] text-ink/55 truncate">
              {batchShort}
            </span>
            <span className="text-[12px] text-ink/40 shrink-0">·</span>
            <span className="font-sans tabular-nums tracking-tight text-[15px] text-ink shrink-0">
              {totalDisplay}
            </span>
            <span className="font-sans text-[10.5px] text-ink/40 tracking-tight truncate hidden md:inline">
              {recipientCopy}
            </span>
          </div>
        </div>
        <PayrollStatusBadge status={run.status} />
      </a>
    </li>
  );
}

function PayrollStatusBadge({ status }: { status: PayrollRunSummary["status"] }) {
  // Mirrors DashboardList's invoice StatusBadge — same sizing, same
  // tracking, same color tokens. Sage/gold/brick are the only accent
  // colors in the system; we re-use them here for run state.
  const styles: Record<PayrollRunSummary["status"], { cls: string; label: string }> = {
    settled: { cls: "border-sage/40 text-sage bg-sage/5", label: "Settled" },
    partial: { cls: "border-gold/40 text-gold bg-gold/5", label: "Partial" },
    failed: { cls: "border-brick/40 text-brick bg-brick/5", label: "Failed" },
  };
  const { cls, label } = styles[status];
  return (
    <span
      className={`inline-block px-2.5 py-1 border rounded-[2px] font-mono text-[10.5px] tracking-[0.12em] uppercase ${cls}`}
    >
      {label}
    </span>
  );
}

function formatPayrollRunDate(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

function extractBatchIdFromUri(uri: string): string | null {
  const q = uri.indexOf("?");
  if (q === -1) return null;
  const search = new URLSearchParams(uri.slice(q + 1));
  return search.get("batch");
}

function Shell({
  children,
  pendingCount = 0,
}: {
  children: React.ReactNode;
  /**
   * Number of pending invoices on the connected wallet's dashboard.
   * Rendered as `Activity (N pending)` next to the nav link so the
   * user can spot unhandled work without opening the page. Hidden
   * when zero to avoid noise.
   */
  pendingCount?: number;
}) {
  return (
    <main className="min-h-screen relative pb-32">
      <nav className="sticky top-0 z-20 backdrop-blur-sm bg-paper/80 border-b border-line">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between px-6 md:px-8 py-4">
          <VeilLogo tagline="activity" />
          <div className="flex items-center gap-1 md:gap-2">
            <a
              href="/create"
              className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors"
            >
              Create
            </a>
            <a
              href="/dashboard"
              className="hidden sm:inline-flex items-center gap-2 px-3 py-2 text-[13px] text-ink"
            >
              <span>Activity</span>
              {pendingCount > 0 && (
                <span
                  className="font-mono text-[10px] tracking-[0.06em] tnum text-gold border border-gold/40 bg-gold/5 rounded-full px-1.5 py-[1px] leading-none"
                  aria-label={`${pendingCount} pending invoices`}
                  title={`${pendingCount} pending invoice${pendingCount === 1 ? "" : "s"}`}
                >
                  {pendingCount} pending
                </span>
              )}
            </a>
            <a
              href="https://github.com/michal-marcinko/veil"
              target="_blank"
              rel="noreferrer noopener"
              className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors"
            >
              Docs
            </a>
            <div className="ml-2">
              <ClientWalletMultiButton />
            </div>
          </div>
        </div>
      </nav>

      <section className="max-w-[1400px] mx-auto px-6 md:px-8 pt-16 md:pt-20">{children}</section>
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
