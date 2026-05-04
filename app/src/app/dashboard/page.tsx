"use client";

import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { VeilLogo } from "@/components/VeilLogo";
import { DashboardList } from "@/components/DashboardList";
import { ClaimProgressModal } from "@/components/ClaimProgressModal";
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
  const [labels, setLabels] = useState<Map<string, { payer: string; amount: string }>>(
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
      return;
    }
    if (clientResult.status === "rejected") {
      // eslint-disable-next-line no-console
      console.error("[Veil dashboard] umbra client init failed:", clientResult.reason);
      setError(`Umbra: ${(clientResult.reason as any)?.message ?? clientResult.reason}`);
      setLoading(false);
      return;
    }

    const all = invoicesResult.value;
    const client = clientResult.value;
    setInvoices(all.map((a: any) => ({ pda: a.publicKey, account: a.account })));
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
    const next = new Map<string, { payer: string; amount: string }>();
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
          next.set(pda, {
            payer: md.payer?.display_name || "Unknown payer",
            amount: `${formatBigintAmount(total, decimals)} ${symbol}`,
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

  const payrollRunSummaries = useMemo<PayrollRunSummary[]>(() => {
    return payrollRuns
      .map(summarizePayrollRun)
      .sort((a, b) => b.createdAtMs - a.createdAtMs);
  }, [payrollRuns]);

  if (!wallet.connected) {
    return (
      <Shell>
        <div className="max-w-lg reveal">
          <span className="eyebrow">Activity</span>
          <h1 className="mt-4 font-sans font-medium text-ink text-[40px] md:text-[48px] leading-[1.05] tracking-[-0.03em]">
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

  const incoming = invoices.map((i) => ({
    pda: i.pda.toBase58(),
    creator: i.account.creator.toBase58(),
    metadataUri: i.account.metadataUri,
    status: Object.keys(i.account.status)[0] as any,
    createdAt: Number(i.account.createdAt),
  }));
  const pendingInvoices = incoming.filter((invoice) => invoice.status === "pending");

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

  return (
    <Shell>
      <ClaimProgressModal
        open={claimModal.open}
        current={claimModal.current}
        total={claimModal.total}
        errorMessage={claimModal.error}
      />
      <div className="flex items-baseline justify-between mb-10 reveal">
        <div>
          <span className="eyebrow">Activity</span>
          <h1 className="mt-3 font-sans font-medium text-ink text-[36px] md:text-[44px] leading-[1.05] tracking-[-0.025em]">
            Your private payment activity.
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
                  <span className="eyebrow">Private {PAYMENT_SYMBOL} balance</span>
                  <div className="mt-3 font-sans tnum text-ink text-[32px] md:text-[40px] font-medium tracking-[-0.02em] leading-none">
                    {formatBigintAmount(balance, PAYMENT_DECIMALS)}
                    <span className="ml-3 font-mono text-[12px] text-muted tracking-[0.14em] uppercase">
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

          <DashboardList title="Invoices you created" invoices={incoming} labels={labels} />

          {pendingInvoices.length > 0 && (
            <div className="mt-10 border border-gold/30 bg-gold/5 rounded-[4px] p-5 max-w-3xl">
              <div className="flex items-start justify-between gap-6">
                <div className="flex-1">
                  <span className="eyebrow">Apply payer receipt</span>
                  <p className="mt-2 text-[13.5px] leading-relaxed text-ink/75">
                    To mark a Pending invoice Paid, paste the signed receipt
                    URL or blob your payer generated on the pay page. The
                    receipt cryptographically binds one specific payment to
                    one specific invoice — this dashboard verifies the
                    payer&apos;s ed25519 signature before submitting on-chain.
                  </p>
                </div>
              </div>
              <div className="mt-4 flex flex-col gap-3">
                <textarea
                  value={receiptInput}
                  onChange={(e) => setReceiptInput(e.target.value)}
                  placeholder="https://veil.app/receipt/<pda>#<blob>  —  or just the blob"
                  rows={3}
                  className="w-full font-mono text-[12px] bg-paper border border-line rounded-[3px] p-3 text-ink placeholder:text-dim resize-y focus:outline-none focus:border-ink"
                  disabled={applyingReceipt}
                />
                <div className="flex items-center justify-between gap-4">
                  <span className="text-[11.5px] font-mono tracking-[0.08em] text-dim uppercase">
                    {pendingInvoices.length} invoice
                    {pendingInvoices.length === 1 ? "" : "s"} pending
                  </span>
                  <button
                    type="button"
                    onClick={handleApplyReceipt}
                    disabled={applyingReceipt || receiptInput.trim().length === 0}
                    className="btn-ghost text-[12px] px-4 py-2 shrink-0 disabled:opacity-40"
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
              </div>
            </div>
          )}

          {batchList.length > 0 && (
            <div className="mt-14">
              <div className="flex items-baseline justify-between mb-6 border-b border-line pb-3">
                <span className="eyebrow">Invoice batches</span>
                <div className="flex items-center gap-4">
                  <a href="/payroll/outgoing" className="btn-quiet text-[12px]">
                    Run private payroll
                  </a>
                  <a href="/payroll/new" className="btn-quiet text-[12px]">
                    + New batch
                  </a>
                </div>
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

function PayrollRunsView({ runs }: { runs: PayrollRunSummary[] }) {
  if (runs.length === 0) {
    return (
      <div className="reveal">
        <div className="flex items-baseline justify-between mb-4">
          <span className="eyebrow">Outgoing payroll runs</span>
          <span className="font-mono text-[11px] text-dim tnum">00</span>
        </div>
        <div className="border border-dashed border-line rounded-[4px] p-12 text-center max-w-2xl">
          <p className="font-sans text-ink text-[18px] leading-[1.45] tracking-[-0.01em] max-w-md mx-auto">
            No payroll runs yet.
          </p>
          <p className="mt-2 text-[13.5px] text-muted leading-relaxed max-w-md mx-auto">
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
        <span className="eyebrow">Outgoing payroll runs</span>
        <span className="font-mono text-[11px] text-dim tnum">
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
          <span className="font-mono text-[11px] text-dim tnum shrink-0">
            {dateLabel}
          </span>
          <div className="flex items-baseline gap-3 min-w-0 flex-1">
            <span className="font-mono text-[13px] text-ink truncate">
              {batchShort}
            </span>
            <span className="text-[12px] text-muted shrink-0 tnum">·</span>
            <span className="text-[13px] text-ink/80 tnum shrink-0">
              {totalDisplay}
            </span>
            <span className="font-mono text-[10.5px] text-dim tracking-[0.05em] truncate hidden md:inline">
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

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen relative pb-32">
      <nav className="sticky top-0 z-10 backdrop-blur-sm bg-paper/80 border-b border-line">
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
              className="hidden sm:inline-block px-3 py-2 text-[13px] text-ink"
            >
              Activity
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
