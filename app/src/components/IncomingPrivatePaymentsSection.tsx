"use client";

/**
 * Recipient-side dashboard section (Phase B).
 *
 * Mirrors the visual structure of the sender's "Outgoing payroll runs"
 * section in `app/src/app/dashboard/page.tsx` so a user who both sends
 * and receives sees one coherent surface — same eyebrow, same hairline-
 * bordered list, same monochrome status chips.
 *
 * Two collapsible sub-sections:
 *
 *   1. Pending claims — UTXOs in the Umbra pool currently encrypted to
 *      this recipient's view key (received + publicReceived buckets
 *      from `scanClaimableUtxos`). Each row offers a "Claim" button
 *      that runs `claimUtxos` then `withdrawShielded`, then persists
 *      a `ReceivedPayment` record.
 *   2. History — `ReceivedPayment[]` records persisted via
 *      `persistReceivedPayment`. Each row gets a "Download payslip"
 *      button that produces a single-page A4 PDF via `payslipPdf.tsx`.
 *
 * The section renders nothing until the wallet is connected — the
 * dashboard's wallet-disconnected branch already shows a stand-in
 * Connect prompt.
 */

import { useEffect, useMemo, useState } from "react";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import {
  claimUtxos,
  commitScanWatermark,
  getOrCreateClient,
  scanClaimableUtxos,
} from "@/lib/umbra";
import { PAYMENT_DECIMALS, PAYMENT_SYMBOL, USDC_MINT } from "@/lib/constants";
import {
  loadCachedReceivedPaymentsFlat,
  persistReceivedPayment,
  syncReceivedPaymentsFromArweave,
  type ReceivedPayment,
} from "@/lib/received-payments-storage";
import { downloadPayslipPdf } from "@/lib/payslipPdf";
import { formatPayrollAmount } from "@/lib/private-payroll";

type PendingUtxo = {
  /** The opaque SDK UTXO object — passed straight back to claimUtxos. */
  raw: any;
  /** Stable key for React lists. We use whatever the SDK exposes that's
   *  unique-per-UTXO; insertionIndex falls through to a counter. */
  key: string;
  amount: bigint;
  /** Best-effort sender display. Empty when the metadata doesn't carry
   *  one (privacy mode "working as intended" — show the friendly
   *  "Sender hidden (mixer)" copy in the UI). */
  senderDisplayName: string;
  /** Best-effort sender wallet. May be the shadow address if that's all
   *  the SDK exposes. */
  senderWallet: string;
  bucket: "received" | "publicReceived";
};

const RECEIVED_PAYMENTS_STORAGE_PREFIX = "veil:receivedPayments:";

function receivedPaymentsStorageKey(walletBase58: string): string {
  return `${RECEIVED_PAYMENTS_STORAGE_PREFIX}${walletBase58}`;
}

/**
 * Best-effort extraction of any sender hint from a UTXO. The SDK's
 * UTXO shape is opaque; we look at a small list of common fields and
 * fall back to "" when none are present. The dashboard renders the
 * fallback as "Sender hidden (mixer)" — that's the privacy property
 * working as intended.
 */
function extractUtxoSenderHints(raw: any): {
  senderWallet: string;
  senderDisplayName: string;
} {
  const wallet =
    (typeof raw?.depositorAddress === "string" && raw.depositorAddress) ||
    (typeof raw?.senderAddress === "string" && raw.senderAddress) ||
    (typeof raw?.fromAddress === "string" && raw.fromAddress) ||
    (typeof raw?.payerAddress === "string" && raw.payerAddress) ||
    "";
  const name =
    (typeof raw?.senderDisplayName === "string" && raw.senderDisplayName) ||
    (typeof raw?.metadata?.sender === "string" && raw.metadata.sender) ||
    "";
  return { senderWallet: wallet, senderDisplayName: name };
}

function utxoStableKey(raw: any, fallbackIndex: number): string {
  if (typeof raw?.commitment === "string") return raw.commitment;
  if (typeof raw?.id === "string") return raw.id;
  if (typeof raw?.insertionIndex === "bigint") {
    return raw.insertionIndex.toString();
  }
  if (typeof raw?.insertionIndex === "number") {
    return String(raw.insertionIndex);
  }
  return `utxo-${fallbackIndex}`;
}

function utxoAmountBigint(raw: any): bigint {
  const v = raw?.amount;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string") {
    try {
      return BigInt(v);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

/**
 * Receipt-bind candidate surfaced after a successful claim.
 *
 * The dashboard owns the (decrypted) invoice list, so it's the only
 * surface that can resolve "did the user just receive payment for an
 * invoice they sent?". The section delegates that match logic upward
 * via `findReceiptCandidate`, then renders an inline banner with a
 * primary button that calls `onBindReceipt(pda)` — wired in the parent
 * to open the existing apply-receipt slide-over with the PDA prefilled.
 */
export type ReceiptBindCandidate = {
  /** On-chain invoice PDA — what the bind flow ultimately needs. */
  pda: string;
  /** Short human id surfaced in the banner copy. */
  shortId: string;
};

export interface IncomingPrivatePaymentsSectionProps {
  /** The connected wallet from `useWallet()`. The section internally
   *  guards on `wallet.connected`/`wallet.publicKey` so the parent
   *  doesn't have to re-derive the gate. */
  wallet: WalletContextState;
  /**
   * Called after a successful claim with the claimed UTXO's amount in
   * base units. Returns the single matching pending-and-recent invoice
   * the user has SENT, or null when there are zero or multiple matches
   * (in which case the section shows nothing). Resolved in the parent
   * because that's where the decrypted invoice metadata lives.
   */
  findReceiptCandidate?: (claimedAmount: bigint) => ReceiptBindCandidate | null;
  /**
   * Called when the user clicks the banner's primary button. Wired in
   * the parent to open the apply-receipt slide-over with the matched
   * invoice's PDA prefilled.
   */
  onBindReceipt?: (pda: string) => void;
}

export function IncomingPrivatePaymentsSection({
  wallet,
  findReceiptCandidate,
  onBindReceipt,
}: IncomingPrivatePaymentsSectionProps) {
  const walletBase58 = wallet.publicKey?.toBase58() ?? null;

  // History state — loaded from localStorage immediately, reconciled
  // with Arweave in the background.
  const [history, setHistory] = useState<ReceivedPayment[]>([]);

  // Pending UTXOs scanned from the Umbra pool. Refreshed on mount + on
  // explicit user action; the dashboard's existing scan loop already
  // claims these for invoices, but we surface them here too so the
  // recipient can see + manually claim with payslip generation in one
  // step.
  const [pending, setPending] = useState<PendingUtxo[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  // Most-recent scan's nextScanStartIndex. Held here so the per-row
  // claim handler can advance the watermark only AFTER a successful
  // claim/withdraw/persist round-trip (see commitScanWatermark in
  // lib/umbra.ts for the rationale — passive scans must not advance
  // the watermark, only consumed scans).
  const [latestScanNextStart, setLatestScanNextStart] =
    useState<bigint | null>(null);

  // Per-row claim state. Keyed by the same stable key the row uses.
  const [claimingKey, setClaimingKey] = useState<string | null>(null);
  const [claimSubStep, setClaimSubStep] = useState<string>("");
  const [claimError, setClaimError] = useState<string | null>(null);

  // Collapse state. Both sub-sections default open so the user sees
  // their content above-the-fold; collapsing is a low-cost affordance
  // for users with long histories.
  const [pendingOpen, setPendingOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(true);

  // Receipt-suggest banner. Set by `handleClaimPending` after a
  // successful claim when `findReceiptCandidate` returns a unique match.
  // Null otherwise — the banner only renders for the unambiguous case.
  const [receiptSuggestion, setReceiptSuggestion] =
    useState<ReceiptBindCandidate | null>(null);

  /* ───────── history hydration + storage-event subscription ───────── */

  useEffect(() => {
    if (!walletBase58) {
      setHistory([]);
      return;
    }
    // Capture into a non-nullable local so the inner closure (which
    // outlives this render) keeps the narrowed type — without the
    // alias, TS widens `walletBase58` back to `string | null` inside
    // `onStorage`.
    const wb = walletBase58;
    setHistory(loadCachedReceivedPaymentsFlat(wb));
    const key = receivedPaymentsStorageKey(wb);
    function onStorage(event: StorageEvent) {
      if (event.key === key) {
        setHistory(loadCachedReceivedPaymentsFlat(wb));
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [walletBase58]);

  // Background Arweave reconcile — best-effort, fires on wallet change.
  // The result is folded into the cache by `syncReceivedPaymentsFromArweave`,
  // which dispatches a synthetic StorageEvent so the hook above re-reads.
  useEffect(() => {
    if (!walletBase58 || !wallet) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await syncReceivedPaymentsFromArweave({
          wallet: wallet as any,
          walletBase58,
        });
        // Force-refresh in the rare case the synthetic StorageEvent
        // doesn't propagate inside the same tab.
        if (!cancelled && result.added > 0) {
          setHistory(loadCachedReceivedPaymentsFlat(walletBase58));
        }
      } catch {
        // Silent — local cache stays valid.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [walletBase58, wallet]);

  /* ───────── pending UTXO scan ───────── */

  async function refreshPending() {
    if (!walletBase58) return;
    setScanning(true);
    setScanError(null);
    try {
      const client = await getOrCreateClient(wallet as any);
      const scan = await scanClaimableUtxos(client);
      const combined = [
        ...scan.received.map((u) => ({ raw: u, bucket: "received" as const })),
        ...scan.publicReceived.map((u) => ({
          raw: u,
          bucket: "publicReceived" as const,
        })),
      ];
      const mapped: PendingUtxo[] = combined.map((c, i) => {
        const hints = extractUtxoSenderHints(c.raw);
        return {
          raw: c.raw,
          key: utxoStableKey(c.raw, i),
          amount: utxoAmountBigint(c.raw),
          senderDisplayName: hints.senderDisplayName,
          senderWallet: hints.senderWallet,
          bucket: c.bucket,
        };
      });
      setPending(mapped);
      // Remember the watermark advance the SDK suggests, but DO NOT
      // commit it yet — see the comment on `latestScanNextStart`. The
      // commit happens inside `handleClaimPending` after the row's
      // claim+withdraw+persist round-trip succeeds.
      setLatestScanNextStart(scan.nextScanStartIndex);
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error("[Veil dashboard] pending scan failed:", err);
      setScanError(err?.message ?? String(err));
    } finally {
      setScanning(false);
    }
  }

  // Initial scan once on wallet connect. The dashboard's main refresh
  // loop also runs scanClaimableUtxos but it auto-claims into the
  // user's encrypted balance, which makes the UTXO disappear from
  // future scans. To show "pending claims", we run our own scan here
  // BEFORE that auto-claim has a chance to consume the UTXOs — in
  // practice the watermark-based scan is fast enough that whichever
  // effect runs first owns the row, and a manual Refresh button is
  // available for the user to re-scan after the dashboard auto-claim
  // settles.
  useEffect(() => {
    if (!walletBase58) {
      setPending([]);
      return;
    }
    void refreshPending();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletBase58]);

  /* ───────── claim a single pending UTXO ───────── */

  async function handleClaimPending(utxo: PendingUtxo) {
    if (!walletBase58 || !wallet.publicKey) return;
    setClaimingKey(utxo.key);
    setClaimError(null);
    // A new claim starts — drop any stale match suggestion from a
    // previous claim so the banner doesn't carry over to the next one.
    setReceiptSuggestion(null);
    setClaimSubStep("Claiming UTXO into your encrypted balance…");
    try {
      const client = await getOrCreateClient(wallet as any);
      // 1. Claim the single UTXO into the recipient's encrypted balance.
      //    The funds stay private — the user can spend them on Veil
      //    via shielded sends, or click "Withdraw" on the balance
      //    card to move them to their public wallet.
      //
      //    Earlier versions auto-withdrew here, which silently moved
      //    funds out of encrypted balance and onto the public chain
      //    without the user's consent. That defeated the privacy
      //    property the user is buying into. Now claim and withdraw
      //    are two distinct, explicit user actions.
      const claimResult = await claimUtxos({ client, utxos: [utxo.raw] });
      const mint = USDC_MINT.toBase58();
      const finalSig =
        (claimResult as any)?.callbackSignature ??
        (claimResult as any)?.queueSignature ??
        "";

      // 2. Persist a ReceivedPayment so the row joins history.
      const now = new Date().toISOString();
      const payment: ReceivedPayment = {
        // Pending UTXOs may not have a batchId in their metadata. The
        // dashboard generates a synthetic one prefixed `pool-` so the
        // payslip filename and dedupe key remain stable; if a UTXO
        // truly comes from a payroll batch this should be replaced by
        // metadata-driven population in a future iteration.
        batchId: `pool-${utxo.key.slice(0, 16)}`,
        rowIndex: 0,
        senderWallet: utxo.senderWallet,
        senderDisplayName: utxo.senderDisplayName,
        amount: utxo.amount.toString(),
        amountDisplay: formatPayrollAmount(utxo.amount, PAYMENT_DECIMALS),
        symbol: PAYMENT_SYMBOL,
        mint,
        memo: null,
        claimSignature: finalSig,
        // No withdraw happened — funds stay in the recipient's
        // encrypted balance until they explicitly click Withdraw
        // on the balance card.
        withdrawSignature: undefined,
        // Pending-pool UTXOs that the recipient claims directly via the
        // mixer-protected path are by definition mixer-routed: someone
        // posted a re-encrypted UTXO to the pool, the recipient just
        // pulled it down into their own encrypted balance. Mark as
        // "mixer" so the payslip explains the privacy property correctly.
        mode: "mixer",
        receivedAt: now,
      };
      await persistReceivedPayment({
        wallet: wallet as any,
        walletBase58,
        payment,
      });
      // Only NOW — after claimUtxos + withdrawShielded +
      // persistReceivedPayment have all landed — is it safe to advance
      // the scan watermark. If any of those steps had thrown, we'd
      // leave the watermark unchanged so the next refresh re-surfaces
      // this UTXO. See `commitScanWatermark` in lib/umbra.ts.
      if (latestScanNextStart != null) {
        commitScanWatermark(client, latestScanNextStart);
      }
      // Drop the row from `pending` so the UI reflects the change
      // without waiting for a full re-scan.
      setPending((prev) => prev.filter((p) => p.key !== utxo.key));
      setHistory(loadCachedReceivedPaymentsFlat(walletBase58));

      // Receipt auto-suggest. If the parent can resolve this claimed
      // amount to exactly one recent invoice the user has SENT, surface
      // a banner offering to bind the receipt. Zero or multiple matches
      // → no banner (we don't want to nudge the user toward a guess).
      if (findReceiptCandidate) {
        try {
          const candidate = findReceiptCandidate(utxo.amount);
          if (candidate) setReceiptSuggestion(candidate);
        } catch {
          // Defensive: a throw in the parent shouldn't break the claim
          // success path. Silently skip the suggestion.
        }
      }
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error("[Veil dashboard] pending claim failed:", err);
      setClaimError(err?.message ?? String(err));
    } finally {
      setClaimingKey(null);
      setClaimSubStep("");
    }
  }

  /* ───────── derived counts for the section header ───────── */

  const totalCount = pending.length + history.length;

  /* ───────── render ───────── */

  if (!wallet.connected || !walletBase58) {
    // Section is mounted but blank for disconnected wallets — the
    // dashboard's outer guard already shows a connect prompt above.
    return null;
  }

  return (
    <section className="reveal mb-12">
      <div className="flex items-baseline justify-between mb-6 border-b border-line pb-3">
        <div className="flex items-baseline gap-3">
          <span className="font-sans text-xs uppercase tracking-[0.18em] text-ink/55">
            Private payments
          </span>
          {pending.length > 0 && (
            <span className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-gold">
              {pending.length} pending
            </span>
          )}
        </div>
        <span className="font-sans text-[10.5px] tabular-nums tracking-[0.12em] text-ink/40">
          {String(totalCount).padStart(2, "0")}
        </span>
      </div>

      {/* Pending claims sub-section */}
      <div className="mb-8">
        <button
          type="button"
          onClick={() => setPendingOpen((v) => !v)}
          className="w-full flex items-baseline justify-between mb-3 text-left"
          aria-expanded={pendingOpen}
        >
          <span className="font-sans text-[11.5px] uppercase tracking-[0.16em] text-ink/55">
            Payments to claim
            <span className="ml-2 text-ink/35 font-mono tabular-nums">
              {String(pending.length).padStart(2, "0")}
            </span>
          </span>
          <span className="flex items-center gap-3">
            <span
              className="font-mono text-[11px] tracking-[0.12em] uppercase text-gold hover:text-ink transition-colors"
              role="button"
              onClick={(e) => {
                // Click-stopping inside the parent button so the
                // section doesn't toggle when the user just wants to
                // refresh.
                e.stopPropagation();
                if (!scanning) void refreshPending();
              }}
            >
              {scanning ? "Scanning…" : "Refresh"}
            </span>
            <span
              aria-hidden
              className={`text-ink/40 transition-transform ${
                pendingOpen ? "" : "-rotate-90"
              }`}
            >
              ↓
            </span>
          </span>
        </button>

        {pendingOpen && (
          <>
            {scanError && (
              <div className="mb-3 flex items-start gap-3 border-l-2 border-brick pl-3 py-1.5">
                <span className="mono-chip text-brick shrink-0 pt-0.5">
                  Scan
                </span>
                <span className="text-[12.5px] text-ink leading-relaxed flex-1">
                  {scanError}
                </span>
              </div>
            )}
            {claimError && (
              <div className="mb-3 flex items-start gap-3 border-l-2 border-brick pl-3 py-1.5">
                <span className="mono-chip text-brick shrink-0 pt-0.5">
                  Claim
                </span>
                <span className="text-[12.5px] text-ink leading-relaxed flex-1">
                  {claimError}
                </span>
              </div>
            )}
            {receiptSuggestion && (
              <div className="mb-3 flex items-start gap-3 border-l-2 border-gold pl-3 py-2 pr-3">
                <span className="mono-chip text-gold shrink-0 pt-0.5">
                  Match
                </span>
                <span className="text-[12.5px] text-ink leading-relaxed flex-1">
                  Looks like this matches invoice{" "}
                  <span className="font-mono text-ink/85">
                    {receiptSuggestion.shortId}
                  </span>{" "}
                  — bind receipt?
                </span>
                <div className="flex items-center gap-3 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      const target = receiptSuggestion;
                      setReceiptSuggestion(null);
                      if (onBindReceipt && target) onBindReceipt(target.pda);
                    }}
                    className="font-mono text-[11px] tracking-[0.14em] uppercase text-gold hover:text-ink transition-colors inline-flex items-center gap-1.5"
                  >
                    <span>Bind receipt</span>
                    <span aria-hidden>→</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setReceiptSuggestion(null)}
                    aria-label="Dismiss receipt suggestion"
                    className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-ink/40 hover:text-ink transition-colors"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}
            {pending.length === 0 ? (
              <div className="border border-dashed border-line rounded-[4px] py-10 px-6 text-center">
                <p className="font-display italic text-ink/70 text-[18px] leading-[1.3]">
                  No incoming payments yet.
                </p>
                <p className="mt-2 text-[12.5px] text-ink/50 leading-relaxed">
                  When a sender posts a private payment to your wallet, it
                  will appear here for one-click claim.
                </p>
              </div>
            ) : (
              <ul className="border border-line rounded-[4px] bg-paper-3 divide-y divide-line">
                {pending.map((u) => {
                  const hasSender =
                    u.senderDisplayName || u.senderWallet;
                  const senderLabel = u.senderDisplayName
                    ? u.senderDisplayName
                    : u.senderWallet
                    ? `${u.senderWallet.slice(0, 6)}…${u.senderWallet.slice(-4)}`
                    : null;
                  const amount = `${formatPayrollAmount(
                    u.amount,
                    PAYMENT_DECIMALS,
                  )} ${PAYMENT_SYMBOL}`;
                  const isClaiming = claimingKey === u.key;
                  return (
                    <li
                      key={u.key}
                      className="flex items-center justify-between gap-6 px-5 md:px-6 py-4 hover:bg-paper-2/50 transition-colors"
                    >
                      <div className="flex flex-col gap-1 min-w-0 flex-1">
                        <div className="flex items-baseline gap-3">
                          <span className="font-sans tabular-nums tracking-tight text-[17px] text-ink font-medium">
                            {amount}
                          </span>
                          <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-gold">
                            via mixer
                          </span>
                        </div>
                        <span className="font-mono text-[11px] text-ink/45">
                          {hasSender
                            ? `From ${senderLabel}`
                            : "Sender hidden by privacy mixer"}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleClaimPending(u)}
                        disabled={isClaiming || claimingKey !== null}
                        className="inline-flex items-center gap-2 border border-line rounded-[3px] px-4 py-2 text-[12.5px] tracking-[0.04em] text-ink hover:bg-paper-2 disabled:opacity-40 transition-colors shrink-0"
                      >
                        {isClaiming ? (
                          <>
                            <span
                              aria-hidden
                              className="h-1.5 w-1.5 rounded-full bg-ink/45 animate-slow-pulse"
                            />
                            <span>{claimSubStep || "Claiming…"}</span>
                          </>
                        ) : (
                          <>
                            <span>Claim</span>
                            <span aria-hidden className="text-ink/55">→</span>
                          </>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>

      {/* History sub-section */}
      <div>
        <button
          type="button"
          onClick={() => setHistoryOpen((v) => !v)}
          className="w-full flex items-baseline justify-between mb-3 text-left"
          aria-expanded={historyOpen}
        >
          <span className="font-sans text-[11.5px] uppercase tracking-[0.16em] text-ink/55">
            History
            <span className="ml-2 text-ink/35 font-mono tabular-nums">
              {String(history.length).padStart(2, "0")}
            </span>
          </span>
          <span
            aria-hidden
            className={`text-ink/40 transition-transform ${
              historyOpen ? "" : "-rotate-90"
            }`}
          >
            ↓
          </span>
        </button>

        {historyOpen &&
          (history.length === 0 ? (
            <div className="border border-dashed border-line rounded-[4px] py-10 px-6 text-center">
              <p className="font-display italic text-ink/70 text-[18px] leading-[1.3]">
                No incoming payments yet.
              </p>
              <p className="mt-2 text-[12.5px] text-ink/50 leading-relaxed">
                Once you claim a payment, it shows up here with a payslip
                you can download for your records.
              </p>
            </div>
          ) : (
            <ul className="border border-line rounded-[4px] bg-paper-3 divide-y divide-line">
              {history.map((p) => (
                <HistoryRow
                  key={`${p.batchId}::${p.rowIndex}`}
                  payment={p}
                  recipientWallet={walletBase58}
                />
              ))}
            </ul>
          ))}
      </div>
    </section>
  );
}

function HistoryRow({
  payment,
  recipientWallet,
}: {
  payment: ReceivedPayment;
  recipientWallet: string;
}) {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  async function handleDownload() {
    setDownloading(true);
    setDownloadError(null);
    try {
      await downloadPayslipPdf(payment, { recipientWallet });
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error("[Veil dashboard] payslip download failed:", err);
      setDownloadError(err?.message ?? String(err));
    } finally {
      setDownloading(false);
    }
  }

  const date = useMemo(() => formatHistoryDate(payment.receivedAt), [
    payment.receivedAt,
  ]);
  const hasSender = payment.senderDisplayName || payment.senderWallet;
  const senderLabel = payment.senderDisplayName
    ? payment.senderDisplayName
    : payment.senderWallet
    ? `${payment.senderWallet.slice(0, 6)}…${payment.senderWallet.slice(-4)}`
    : null;
  const amount = `${payment.amountDisplay} ${payment.symbol}`;
  const memoText = payment.memo?.trim() ? payment.memo : "";

  return (
    <li className="px-5 md:px-6 py-4 hover:bg-paper-2/50 transition-colors">
      <div className="flex items-center justify-between gap-6">
        <div className="flex flex-col gap-1 min-w-0 flex-1">
          <div className="flex items-baseline gap-3 flex-wrap">
            <span className="font-sans tabular-nums tracking-tight text-[17px] text-ink font-medium">
              {amount}
            </span>
            <span
              className={`font-mono text-[10px] tracking-[0.14em] uppercase ${
                payment.mode === "sweep" ? "text-brick" : "text-sage"
              }`}
            >
              {payment.mode === "sweep" ? "Public sweep" : "Via mixer"}
            </span>
            {memoText && (
              <span className="font-sans italic text-[12px] text-ink/55 truncate hidden md:inline">
                “{memoText}”
              </span>
            )}
          </div>
          <div className="flex items-baseline gap-3 text-[11px] font-mono text-ink/45">
            <span>{date}</span>
            <span className="text-ink/25">·</span>
            <span>
              {hasSender
                ? `From ${senderLabel}`
                : "Sender hidden by privacy mixer"}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={handleDownload}
          disabled={downloading}
          className="inline-flex items-center gap-2 border border-line rounded-[3px] px-4 py-2 text-[12px] tracking-[0.04em] text-ink/75 hover:text-ink hover:bg-paper-2 disabled:opacity-40 transition-colors shrink-0"
        >
          {downloading ? (
            <>
              <span
                aria-hidden
                className="h-1.5 w-1.5 rounded-full bg-ink/45 animate-slow-pulse"
              />
              <span>Generating…</span>
            </>
          ) : (
            <>
              <span aria-hidden className="text-ink/55">↓</span>
              <span>Payslip</span>
            </>
          )}
        </button>
      </div>
      {downloadError && (
        <div className="mt-2 flex items-start gap-3 border-l-2 border-brick pl-3 py-1">
          <span className="mono-chip text-brick shrink-0 pt-0.5">
            Payslip
          </span>
          <span className="text-[12px] text-ink leading-relaxed flex-1">
            {downloadError}
          </span>
        </div>
      )}
    </li>
  );
}

function formatHistoryDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}
