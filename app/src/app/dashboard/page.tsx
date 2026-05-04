"use client";

import { useEffect, useMemo, useState } from "react";
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
import { fetchInvoicesByCreator, markPaidOnChain } from "@/lib/anchor";
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
} from "@/lib/umbra";
import { USDC_MINT, PAYMENT_SYMBOL, PAYMENT_DECIMALS } from "@/lib/constants";
import {
  formatPayrollAmount,
  type SignedPayrollPacket,
} from "@/lib/private-payroll";
import bs58 from "bs58";

type DashboardTab = "invoices" | "payroll";

// Status filter values — lifted to module scope so child components
// (FilterBar, LedgerSection) can type their props against the same union
// the page does. Keep in sync with the on-chain Status enum's variants.
type StatusFilter = "all" | "pending" | "paid" | "cancelled";

// localStorage key for the apply-receipt textarea draft. Per-wallet so a
// draft from another wallet doesn't leak. The slide-over hydrates from
// this on open and writes back on every change — never lose progress
// when the user closes the panel mid-paste.
const RECEIPT_DRAFT_STORAGE_PREFIX = "veil:receiptDraft:";

// Storage convention for signed payroll packets. Codex's
// /payroll/outgoing flow currently emits a verifier URL hash + a JSON/PDF
// download — it does NOT persist to localStorage today. We adopt this
// key prospectively so when the outgoing page (or any future flow) starts
// writing signed packets per wallet, the Activity → Payroll runs tab
// picks them up automatically with no further coordination.
const PAYROLL_RUNS_STORAGE_PREFIX = "veil:payrollRuns:";

function payrollRunsStorageKey(walletBase58: string): string {
  return `${PAYROLL_RUNS_STORAGE_PREFIX}${walletBase58}`;
}

function loadPayrollRuns(walletBase58: string): SignedPayrollPacket[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(payrollRunsStorageKey(walletBase58));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive shape check — we don't want a stale/corrupt entry to
    // crash the dashboard render. Each entry must look like
    // { packet: { batchId, rows[] }, signature }.
    return parsed.filter((entry: any): entry is SignedPayrollPacket => {
      return (
        entry &&
        typeof entry === "object" &&
        entry.packet &&
        typeof entry.packet === "object" &&
        typeof entry.packet.batchId === "string" &&
        Array.isArray(entry.packet.rows) &&
        typeof entry.signature === "string"
      );
    });
  } catch {
    return [];
  }
}

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
  // Per-invoice labels decrypted lazily. Keyed by PDA base58. We populate
  // this after the initial fetch so the table can show "Acme · $4,200 USDC"
  // instead of "9TjX77RP…9Yeh". Decrypt failures (legacy invoices with the
  // old per-PDA signMessage scheme) leave the entry absent — the list
  // falls back to the truncated PDA in that case.
  const [labels, setLabels] = useState<Map<string, { payer: string; amount: string; description: string }>>(
    new Map(),
  );
  // One-time-per-session cache: skip the registered/aligned diagnostics
  // on subsequent refreshes once we've verified once. Saves ~800ms of
  // RPC + key-derivation work per refresh in steady state.
  const [keysVerified, setKeysVerified] = useState(false);
  const [tab, setTab] = useState<DashboardTab>("invoices");
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
        const scan = await scanClaimableUtxos(client);
        // Both buckets represent "incoming payment from someone else."
        // Bob's payment lands in `received` if he paid via shielded path,
        // `publicReceived` if he funded from public ATA.
        const incoming = [...scan.received, ...scan.publicReceived];
          if (incoming.length > 0) {
            claimedThisRefresh = true;
            // Open the progress modal BEFORE the first Phantom popup
            // fires. With N=6 unclaimed UTXOs the unguarded path
            // unleashed six wallet prompts in a few seconds with no
            // context; the modal explains what's happening and ticks
            // the progress bar as each one lands.
            setClaimModal({
              open: true,
              current: 0,
              total: incoming.length,
              error: null,
            });
            // Watermark-based incremental scan in `scanClaimableUtxos`
            // means `incoming` should only contain UTXOs newer than
            // what we've already processed in past sessions. We still
            // keep the per-UTXO retry-on-409 below as belt-and-suspenders
            // — it covers the rare case where the watermark is reset
            // (e.g. cleared localStorage, switched browsers) and Alice's
            // already-claimed UTXOs reappear in the scan.
            let claimResult: Awaited<ReturnType<typeof claimUtxos>> | null = null;
            try {
              claimResult = await claimUtxos({
                client,
                utxos: incoming,
                onProgress: (current, total) => {
                  // Drive the modal's progress bar from inside umbra.ts.
                  // Because `claimUtxos` processes UTXOs sequentially
                  // when an `onProgress` callback is provided, this fires
                  // exactly once per claimed UTXO.
                  setClaimModal((prev) => ({
                    ...prev,
                    current,
                    total,
                  }));
                },
              });
            } catch (err: any) {
              const msg = String(err?.message ?? err);
              const alreadyReserved = /already reserved/i.test(msg) || /409/.test(msg);
              if (alreadyReserved) {
                // eslint-disable-next-line no-console
                console.warn(
                  "[Veil dashboard] bulk claim hit an already-reserved nullifier; retrying per-UTXO in parallel.",
                );
                // Parallel retry — each UTXO is an independent relayer
                // request. Should rarely fire now that the watermark
                // pre-filters seen UTXOs, but kept as belt-and-suspenders.
                const results = await Promise.allSettled(
                  incoming.map((utxo: any) => claimUtxos({ client, utxos: [utxo] })),
                );
                let claimedAny = 0;
                let skippedReserved = 0;
                let otherFailures = 0;
                for (const r of results) {
                  if (r.status === "fulfilled") {
                    if (!claimResult) claimResult = r.value;
                    claimedAny++;
                  } else {
                    const subMsg = String((r.reason as any)?.message ?? r.reason);
                    if (/already reserved/i.test(subMsg) || /409/.test(subMsg)) {
                      skippedReserved++;
                    } else {
                      otherFailures++;
                      // eslint-disable-next-line no-console
                      console.error(
                        "[Veil dashboard] per-UTXO claim failed (non-409):",
                        r.reason,
                      );
                    }
                  }
                }
                // eslint-disable-next-line no-console
                console.log(
                  `[Veil dashboard] per-UTXO claim done: claimed=${claimedAny} skippedReserved=${skippedReserved} otherFailures=${otherFailures} of total=${incoming.length}`,
                );
              } else {
                throw err;
              }
            }
            // CRITICAL CHANGE (2026-05-04 Codex review fix):
            // Previously this loop iterated every Pending invoice and
            // called markPaidOnChain() for each one whenever ANY UTXO
            // was claimed. That violated invoice ↔ payment binding —
            // a single payment from anyone would flip every outstanding
            // invoice to Paid. The on-chain `mark_paid` instruction does
            // not (and cannot) verify which Umbra UTXO funded which
            // invoice, so the binding has to live off-chain in a
            // payer-signed receipt.
            //
            // New flow: just record the claimed UTXO signatures we can
            // pull off the SDK result, and bump the unmatched-claim
            // counter. The creator must explicitly paste a payer-signed
            // receipt to mark a specific invoice paid (see
            // `handleApplyReceipt` below).
            const newSigs = collectStableSignatures(claimResult);
            if (newSigs.size > 0) {
              setClaimedUtxoSigs((prev) => {
                const merged = new Set(prev);
                for (const s of newSigs) merged.add(s);
                return merged;
              });
            }
            setClaimedCount((c) => c + incoming.length);
            // Pin the bar to 100% (the per-UTXO retry path may not
            // emit a final progress tick) and let the success state
            // breathe for ~1.5s before auto-closing.
            setClaimModal((prev) => ({
              ...prev,
              current: prev.total,
              error: null,
            }));
            setTimeout(() => {
              setClaimModal({ open: false, current: 0, total: 0, error: null });
            }, 1500);
          }
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
    const next = new Map<string, { payer: string; amount: string; description: string }>();
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
    setPayrollRuns(loadPayrollRuns(walletBase58));
    function onStorage(event: StorageEvent) {
      if (event.key === key) {
        setPayrollRuns(loadPayrollRuns(walletBase58));
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [wallet.publicKey]);

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
        title="Apply payer receipt"
        subtitle="Paste the signed receipt URL or blob your payer generated. We verify the ed25519 signature locally before submitting on-chain."
      >
        <div className="flex flex-col gap-4">
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
          2026-05-04 refinement: dropped the redundant "Activity" eyebrow
          (the H1 was already "Activity" — felt stuttered). The eyebrow
          now carries the connected wallet shorthand in mono small-caps,
          which is information the user actually needs at a glance. The
          subtitle was rewritten to drop the "Your private payment
          ledger" prefix (the H1 + nav already convey "this is yours")
          in favor of the cryptographic guarantee, which is the
          differentiator. */}
      <div className="flex items-start justify-between gap-6 mb-10 reveal">
        <div>
          {wallet.publicKey && (
            <span className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-ink/40 tabular-nums">
              {`${wallet.publicKey.toBase58().slice(0, 4)}…${wallet.publicKey.toBase58().slice(-4)}`}
            </span>
          )}
          <h1 className="mt-3 font-display text-ink text-[44px] md:text-[60px] leading-[1.0] tracking-[-0.02em]">
            Activity
          </h1>
          <p className="mt-3 text-[14.5px] text-ink/55 max-w-lg leading-[1.5]">
            Read directly from Solana. Encrypted to you.
          </p>
        </div>
        {/* Right-side action cluster. 2026-05-04 v3 (user feedback): the
            previous footer-only placement of "Run private payroll" /
            "Manage auditor grants" was below the fold for any user with
            a real invoice list — they read as "hidden" actions. Pulled
            up here next to refresh so the three primary actions a
            creator takes (refresh / payroll / grants) are always visible.
            Editorial mono small-caps; gold accent on the arrows so they
            register as actions, not labels. */}
        <div className="pt-2 shrink-0 flex items-center gap-5">
          <a
            href="/payroll/outgoing"
            className="hidden md:inline-flex items-center gap-1.5 font-mono text-[11px] tracking-[0.16em] uppercase text-ink/60 hover:text-ink transition-colors"
          >
            <span>Run payroll</span>
            <span className="text-gold" aria-hidden>&rarr;</span>
          </a>
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

      {/* Tab bar — austere mono, hairline rule, 2px ink underline on active */}
      <div className="border-b border-line mb-10">
        <div className="flex gap-8">
          <button
            type="button"
            onClick={() => setTab("invoices")}
            className={`pb-3 text-[13px] font-mono tracking-[0.1em] uppercase border-b-2 -mb-[2px] transition-colors ${
              tab === "invoices"
                ? "border-ink text-ink"
                : "border-transparent text-muted hover:text-ink"
            }`}
            aria-pressed={tab === "invoices"}
          >
            Invoices · {invoiceCount}
          </button>
          <button
            type="button"
            onClick={() => setTab("payroll")}
            className={`pb-3 text-[13px] font-mono tracking-[0.1em] uppercase border-b-2 -mb-[2px] transition-colors ${
              tab === "payroll"
                ? "border-ink text-ink"
                : "border-transparent text-muted hover:text-ink"
            }`}
            aria-pressed={tab === "payroll"}
          >
            Payroll runs · {payrollRunCount}
          </button>
        </div>
      </div>

      {tab === "invoices" && (
        <>
          {balance !== null && (
            <div className="mb-10 border border-line bg-paper-3 rounded-[4px] p-6 md:p-7 reveal">
              <div className="flex items-baseline justify-between gap-6">
                <div>
                  <span className="font-sans text-xs uppercase tracking-[0.18em] text-ink/50">
                    Private {PAYMENT_SYMBOL} balance
                  </span>
                  <div className="mt-3 font-sans tabular-nums tracking-tight text-ink text-[32px] md:text-[40px] font-medium leading-none">
                    {formatBigintAmount(balance, PAYMENT_DECIMALS)}
                    <span className="ml-3 font-sans text-[12px] tracking-[0.14em] text-ink/45 uppercase">
                      {PAYMENT_SYMBOL}
                    </span>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-3">
                  <span className="inline-flex items-center gap-2 text-[12px] text-sage">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                      <path d="M2 6l3 3 5-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <span>Encrypted · readable only by you</span>
                  </span>
                  <button
                    type="button"
                    onClick={handleWithdrawAll}
                    disabled={withdrawing || balance <= 0n}
                    className="btn-ghost text-[12px] px-4 py-2 disabled:opacity-50"
                  >
                    {withdrawing
                      ? "Withdrawing…"
                      : `Withdraw to wallet → ${formatBigintAmount(
                          balance,
                          PAYMENT_DECIMALS,
                        )} ${PAYMENT_SYMBOL}`}
                  </button>
                </div>
              </div>
            </div>
          )}

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

          {/* Filter + search controls — modern command-bar feel.
              2026-05-04 refinement: replaced the chunky <select> with
              inline pill segments (Linear / Phantom inspired); search
              shed its border for an icon + bottom-rule underline that
              deepens to gold on focus; "Bind receipt" demoted from a
              boxed btn-ghost to a quiet text link with arrow. The whole
              row reads airy now — typography carries the structure, not
              borders. */}
          {incoming.length > 0 && (
            <FilterBar
              statusFilter={statusFilter}
              setStatusFilter={setStatusFilter}
              searchQuery={searchQuery}
              setSearchQuery={setSearchQuery}
              pendingCount={pendingInvoices.length}
              onBindReceipt={() => openReceiptPanel()}
            />
          )}

          {/* List body. */}
          {(() => {
            // Initial-fetch skeleton (NN/G recommends skeleton over
            // spinner for content lists). Renders ~3 placeholder rows
            // matching the editorial-row layout while invoices load.
            if (loading && !hasFetchedOnce) {
              return <LedgerSkeleton />;
            }

            // Single chronological list. Date-group sticky headers carry
            // the structure; per-row status dot+label differentiates pending
            // vs paid. No pending/paid subsection split — the list reads as
            // one continuous ledger, not categorical buckets. (Status filter
            // dropdown above lets the user narrow by state when they want.)
            if (incoming.length === 0) {
              return <LedgerEmptyState kind="zero" />;
            }

            if (filteredInvoices.length === 0) {
              return (
                <LedgerEmptyState
                  kind="filtered"
                  onClear={() => {
                    setStatusFilter("all");
                    setSearchQuery("");
                  }}
                />
              );
            }

            // 2026-05-04 redesign: dropped the section title — the
            // FilterBar above already shows which status is active and
            // the date-group headers carry the structure inside the
            // list. Adding a "Pending invoices" caption right above
            // them was redundant noise.
            return (
              <LedgerSection
                invoices={filteredInvoices}
                labels={labels}
                onBindReceipt={(pda) => openReceiptPanel(pda)}
              />
            );
          })()}

          {batchList.length > 0 && (
            <div className="mt-14">
              <div className="flex items-baseline justify-between mb-6 border-b border-line pb-3">
                <span className="font-sans text-xs uppercase tracking-[0.18em] text-ink/50">
                  Invoice batches
                </span>
                <div className="flex items-center gap-4">
                  <a href="/payroll/outgoing" className="btn-quiet text-[12px]">
                    Run private payroll
                  </a>
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

          {/* Footer action duplicates removed — these now live in the
              right-side cluster of the page header (next to Refresh).
              Mobile (<md) keeps them here as a fallback so users on
              narrow screens still have access; desktop hides them via
              `hidden md:flex` since the header already shows them. */}
          <div className="mt-10 pt-8 border-t border-line flex md:hidden">
            <a href="/payroll/outgoing" className="btn-quiet mr-5">
              Run private payroll →
            </a>
            <a href="/dashboard/compliance" className="btn-quiet">
              Manage auditor grants →
            </a>
          </div>
        </>
      )}

      {tab === "payroll" && (
        <PayrollRunsView runs={payrollRunSummaries} />
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
  labels: Map<string, { payer: string; amount: string; description: string }>;
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
          older history. */}
      {recentBuckets.length === 0 && olderBuckets.length > 0 && (
        <p className="font-display italic text-ink/50 text-[15px] py-6 px-4 border-b border-ink/5">
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
  pendingCount,
  onBindReceipt,
}: {
  statusFilter: StatusFilter;
  setStatusFilter: (v: StatusFilter) => void;
  searchQuery: string;
  setSearchQuery: (v: string) => void;
  pendingCount: number;
  onBindReceipt: () => void;
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

      {/* Bind receipt — quiet text link with arrow, not a boxed
          button. Hidden when there are no pending invoices to bind. */}
      {pendingCount > 0 && (
        <button
          type="button"
          onClick={onBindReceipt}
          aria-label="Open the apply-receipt panel"
          className="self-start sm:self-auto font-mono text-[11px] tracking-[0.14em] uppercase text-gold hover:text-ink transition-colors inline-flex items-center gap-1.5 shrink-0"
        >
          <span>bind receipt</span>
          <span aria-hidden>&rarr;</span>
        </button>
      )}
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

function PayrollRunsView({ runs }: { runs: PayrollRunSummary[] }) {
  if (runs.length === 0) {
    return (
      <div className="reveal">
        <div className="flex items-baseline justify-between mb-4">
          <span className="font-sans text-xs uppercase tracking-[0.18em] text-ink/50">
            Outgoing payroll runs
          </span>
          <span className="font-sans text-[10.5px] tabular-nums tracking-[0.12em] text-ink/40">
            00
          </span>
        </div>
        <div className="border border-dashed border-line rounded-[4px] py-16 px-8 text-center max-w-2xl mx-auto">
          <p className="font-display italic text-ink/80 text-[22px] leading-[1.3]">
            No payroll runs yet.
          </p>
          <p className="mt-3 text-[13.5px] text-ink/55 leading-relaxed max-w-md mx-auto">
            Sign your first batch in Create &rarr; Payroll. Once signed, every
            run shows up here with its disclosure links and settlement status.
          </p>
          <a href="/create" className="mt-6 inline-block btn-ghost text-[13px] px-5 py-2.5">
            Go to Create &rarr;
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="reveal">
      <div className="flex items-baseline justify-between mb-4">
        <span className="font-sans text-xs uppercase tracking-[0.18em] text-ink/50">
          Outgoing payroll runs
        </span>
        <span className="font-sans text-[10.5px] tabular-nums tracking-[0.12em] text-ink/40">
          {String(runs.length).padStart(2, "0")}
        </span>
      </div>
      <ul className="border border-line rounded-[4px] bg-paper-3 divide-y divide-line">
        {runs.map((run) => (
          <PayrollRunRow key={run.signed.packet.batchId} run={run} />
        ))}
      </ul>
      <div className="mt-8">
        <a href="/create" className="btn-quiet">+ New payroll batch</a>
      </div>
    </div>
  );
}

function PayrollRunRow({ run }: { run: PayrollRunSummary }) {
  const { packet } = run.signed;
  const totalDisplay = `${formatPayrollAmount(run.totalUnits, packet.decimals)} ${packet.symbol}`;
  const recipients = packet.rows.length;
  const dateLabel = formatPayrollRunDate(run.createdAtMs);
  const batchShort = `${packet.batchId.slice(0, 14)}…${packet.batchId.slice(-4)}`;

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
              {recipients} recipient{recipients === 1 ? "" : "s"} · {run.paid} paid
              {run.failed > 0 ? ` · ${run.failed} failed` : ""}
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
              href="/payroll/outgoing"
              className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors"
            >
              Payroll
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
