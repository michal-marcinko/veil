"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, type Transaction, type VersionedTransaction } from "@solana/web3.js";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import {
  RegistrationModal,
  type RegistrationStep,
  type StepStatus,
} from "@/components/RegistrationModal";
import { CanvasBar, type CanvasBarState } from "@/components/CanvasBar";
import { PayrollPublishingModal } from "@/components/PayrollPublishingModal";
import { VeilDescentMark } from "@/components/VeilDescentMark";
import { parsePayrollCsv, parseAmountToBaseUnits, type PayrollRow } from "@/lib/csv";
import {
  getOrCreateClient,
  ensureRegistered,
  ensureReceiverKeyAligned,
  getEncryptedBalance,
  payInvoice,
  payInvoiceFromShielded,
} from "@/lib/umbra";
import { NETWORK, PAYMENT_DECIMALS, PAYMENT_SYMBOL, USDC_MINT } from "@/lib/constants";
import {
  buildPayrollDisclosure,
  encodePayrollDisclosure,
  encodePayrollPacket,
  formatPayrollAmount,
  generatePrivatePayrollBatchId,
  payrollExplorerTxUrl,
  signPayrollPacket,
  type PayrollPacket,
  type PayrollPacketRow,
  type SignedPayrollPacket,
} from "@/lib/private-payroll";
import {
  downloadPayrollPacketJson,
  downloadPayrollPacketPdf,
} from "@/lib/payrollPacketDownload";
import {
  buildBatchedFundTxV0,
  buildFundShadowTx,
  buildShadowClient,
  checkRecipientsRegistration,
  depositToShadow,
  deriveShadowRegistrationValues,
  fundShadowAccount,
  generateClaimUrl,
  generateEphemeralKeypair,
  lookupRegisteredReceiver,
  prewarmZkAssets,
  registerShadowAccount,
  resetRegisteredReceiverCache,
  rowsToClaimLinkCsv,
  SHADOW_FUNDING_LAMPORTS,
  submitSignedBatchedFundTxV0,
  submitSignedFundShadowTx,
  type BuiltBatchedFundTx,
  type BuiltFundShadowTx,
  type ClaimLinkRow,
  type EphemeralKeypair,
  type RegisteredReceiverValues,
  type RegistrationStatus,
  type ShadowRegistrationValues,
} from "@/lib/payroll-claim-links";
import { persistPayrollRun } from "@/lib/payroll-runs-storage";
import { formatTxError, type SdkErrorDetail } from "@/lib/sdk-error";

/**
 * PayrollFlow — Document Canvas redesign (2026-05-04).
 *
 * The form IS the canvas: continuous editorial layout, no card chrome.
 * Display-size "Company / payer" headline; CSV textarea with quiet
 * frame; chip row for advanced options (override funding, run a
 * registration check); inline run ledger that fills as the run
 * executes; collapsible explorer comparison ("Why is this private?")
 * for skeptics + judges.
 *
 * Persistent surfaces:
 *  - PayrollCanvasBar (sticky bottom, morphs across compose / running
 *    / success).
 *  - PayrollPublishingModal (full-screen overlay during the run + sign
 *    flow — never disappears across Phantom popups).
 *
 * Receipt-packet signing is bundled into the publishing flow: after
 * the last payment settles, the packet is built and signed
 * automatically. One signed packet, one PDF, one JSON — all dropped
 * to disk before the modal closes.
 */

type RunMode = "auto" | "shielded" | "public";
type RunPhase = "idle" | "sending" | "signing";
type ChipKey = null | "funding" | "registration";

interface PayrollRunRow extends PayrollPacketRow {
  amountDisplay: string;
  /** Set when this row was paid via the claim-link path. */
  claimUrl?: string;
  /** Set when this row used the claim-link path. */
  registrationStatus?: RegistrationStatus;
  /** Structured error info for the in-app disclosure UI. The packet's
   *  `error` field stays a single-line string for the signed packet
   *  shape (PayrollPacketRow), but the runtime row also carries the
   *  full logs + phase so a "Show details" expander can render them.
   *  Discarded when the packet is built (see `runRowToPacketRow`). */
  errorDetail?: SdkErrorDetail;
}

/**
 * Per-row pre-flight metadata for the direct-registered path (Phase C).
 * Built before the single-popup signAllTransactions call when the
 * recipient is already an Umbra user — bypasses the entire
 * shadow-funding + shadow-register dance and targets the recipient's
 * on-chain x25519 view key directly via `payInvoiceCpi`'s
 * `ProofOverrides`.
 *
 * Mirrors the shape of `prefundedShadows` entries for claim-link rows
 * but with neither an ephemeral keypair nor a fund step — the
 * recipient is the direct ix target, no indirection.
 */
interface DirectRegisteredEntry {
  /** Receiver values pulled fresh from chain by `lookupRegisteredReceiver`. */
  values: RegisteredReceiverValues;
  /** Build / sign error from the unified pre-flight, if any. When set,
   *  the row's processing branch surfaces this as the failure cause and
   *  doesn't attempt to submit. */
  buildError: string | null;
  /** Pre-signed VeilPay deposit tx + cached metadata for submission
   *  after the single-popup signAllTransactions returns. There's no
   *  register-wait gate for direct rows so submission runs as soon as
   *  signing completes. */
  signedDeposit?: {
    tx: VersionedTransaction;
    built: any; // BuiltPayInvoiceCpiTx
  };
}

interface RegistrationDetectionResult {
  rowStatuses: RegistrationStatus[];
  unregisteredIndexes: number[];
  unknownIndexes: number[];
}

interface RecipientRow {
  wallet: string;
  amount: string;
  memo: string;
}

const EMPTY_RECIPIENT: RecipientRow = { wallet: "", amount: "", memo: "" };

const SAMPLE_RECIPIENTS: RecipientRow[] = [
  {
    wallet: "4w85uvq3GeKRWKeeB2CyH4FeSYtWsvumHt3XB2TaZdFg",
    amount: "100.00",
    memo: "April contractor retainer",
  },
  {
    wallet: "8hQ5k9sDZQx7WkZpPRM6MeQpM9tYfWnGf6bYj1Gx9zQm",
    amount: "250.00",
    memo: "Design sprint bonus",
  },
];

/* ─────────────────────────────────────────────────────────────────────
   Payroll-run persistence — see `lib/payroll-runs-storage.ts` for the
   real implementation. The persistence + cross-device-sync logic
   lives there; this file just calls into it.
   ───────────────────────────────────────────────────────────────────── */

// (Per-row error detail is just SdkErrorDetail — no narrowing needed.
// The row chip renders `detail.phase` as a string, accepting any
// vocabulary the formatter emitted.)

/**
 * Parse multi-line text pasted into a wallet field. Accepts CSV
 * (`wallet,amount,memo`), TSV (tab-separated — what Google Sheets and
 * Excel deliver on cell-range copies), and forgives an optional header
 * row. Used by the row table's paste-explode handler so a paste from
 * the user's spreadsheet expands into N recipient rows automatically.
 */
function parsePastedRecipients(text: string): RecipientRow[] {
  const lines = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  // Skip a header row if the first line starts with "wallet" — handles
  // both `wallet,amount,memo` (CSV) and `wallet\tamount\tmemo` (TSV).
  const startIdx = /^wallet[,\t\s]/i.test(lines[0]) ? 1 : 0;
  return lines.slice(startIdx).map((line) => {
    const parts = line.split(/[,\t]/).map((p) => p.trim());
    return {
      wallet: parts[0] ?? "",
      amount: parts[1] ?? "",
      memo: parts[2] ?? "",
    };
  });
}

/**
 * Optional callback for the parent layout to react to PayrollFlow's
 * internal success state. Used by `CreatePageInner` to hide the
 * "back to picker" chevron once a packet has been signed — the
 * payroll success surface has its own bottom-bar nav and the chevron
 * sitting alone above the centred hero looks orphaned. Null means
 * "no parent cares about this signal".
 */
export interface PayrollFlowProps {
  onSuccessChange?: (inSuccess: boolean) => void;
}

export function PayrollFlow({ onSuccessChange }: PayrollFlowProps = {}) {
  const wallet = useWallet();
  const { connection } = useConnection();

  const [companyName, setCompanyName] = useState("");
  const [recipients, setRecipients] = useState<RecipientRow[]>([
    { ...EMPTY_RECIPIENT },
  ]);
  const [mode, setMode] = useState<RunMode>("auto");
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<RunPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rows, setRows] = useState<PayrollRunRow[]>([]);
  const [packet, setPacket] = useState<PayrollPacket | null>(null);
  const [signedPacket, setSignedPacket] = useState<SignedPayrollPacket | null>(null);
  const [packetUrl, setPacketUrl] = useState<string | null>(null);
  const [packetCopied, setPacketCopied] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [regOpen, setRegOpen] = useState(false);
  const [regSteps, setRegSteps] = useState<Record<RegistrationStep, StepStatus>>({
    init: "pending",
    x25519: "pending",
    commitment: "pending",
  });
  const [detection, setDetection] = useState<RegistrationDetectionResult | null>(null);
  const [detecting, setDetecting] = useState(false);

  const [openChip, setOpenChip] = useState<ChipKey>(null);
  // Snapshot of total count at run-start, so the modal sub-progress
  // doesn't jitter if csvText is somehow modified mid-run (it isn't,
  // because the form is fade-locked while running, but defensive).
  const [runTotalCount, setRunTotalCount] = useState(0);

  // Per-row sub-step tracking. Used by the publishing modal to show
  // honest progress copy ("Generating ZK proof for shadow registration…")
  // and to drive `awaitingWallet` accurately — it should be TRUE only
  // when a Phantom popup is genuinely open, not while we're crunching
  // ZK proofs locally. The prior version hardcoded awaitingWallet=true
  // throughout the run and lied to the user during the slowest step.
  // `null` means "no row is mid-step" (between rows or pre-loop).
  type RunSubStep = "fund" | "register" | "deposit" | "shielded" | "public" | null;
  const [runSubStep, setRunSubStep] = useState<RunSubStep>(null);
  const [runRowIndex, setRunRowIndex] = useState<number>(0);

  // Derive parsed result from the recipient rows by converting to CSV
  // and feeding the existing parser. Keeps runPayroll + the registration
  // detector unchanged (both consume parsed.rows / parsed.errors). Empty
  // rows (the trailing blank one users always have while typing) are
  // filtered out so we don't surface "Row 2: wallet is blank" mid-typing.
  const parsed = useMemo(() => {
    const nonEmpty = recipients.filter(
      (r) => r.wallet.trim() || r.amount.trim() || r.memo.trim(),
    );
    if (nonEmpty.length === 0) return { rows: [], errors: [] };
    const csv =
      "wallet,amount,memo\n" +
      nonEmpty
        .map((r) => {
          const wallet = r.wallet.trim();
          const amount = r.amount.trim();
          // Memos can't contain commas (parsePayrollCsv splits on comma);
          // sanitize by replacing with spaces so a paste from Sheets that
          // includes a comma in the description doesn't blow up parsing.
          const memo = (r.memo || "").trim().replace(/,/g, " ");
          return `${wallet},${amount},${memo}`;
        })
        .join("\n");
    return parsePayrollCsv(csv);
  }, [recipients]);
  const total = useMemo(() => {
    let sum = 0n;
    for (const row of parsed.rows) {
      const amount = parseAmountToBaseUnits(row.amount, PAYMENT_DECIMALS);
      if (amount != null) sum += amount;
    }
    return sum;
  }, [parsed.rows]);

  /* ───────────────────── derived state for surfaces ───────────────────── */

  const totalDisplay = `${formatPayrollAmount(total, PAYMENT_DECIMALS)} ${PAYMENT_SYMBOL}`;
  const rowCount = parsed.rows.length;
  const canRun =
    !running && wallet.connected && rowCount > 0 && companyName.trim().length > 0;
  const inSuccessState = !running && phase === "idle" && packetUrl !== null;

  // Notify the parent (CreatePageInner) so it can suppress its
  // "back to picker" chevron once the payroll surface enters its
  // own success state. Without this signal the parent has no way
  // to know — packetUrl lives entirely inside this component.
  useEffect(() => {
    onSuccessChange?.(inSuccessState);
  }, [inSuccessState, onSuccessChange]);

  // Map the local payroll state to the shared CanvasBar's discriminated
  // union. Same component is reused on /create invoice and /create
  // payroll; per-flow specifics (button copy, copy label, ghost extras)
  // live here in the consumer.
  const totalCountForRun = runTotalCount || rowCount;
  const canvasBarState: CanvasBarState = inSuccessState
    ? {
        kind: "success",
        shareUrl: packetUrl,
        copyLabel: "Copy packet",
        copied: packetCopied,
        onCopy: copyPacketUrl,
        fallbackMeta: `${rows.filter((r) => r.status === "paid").length} payment${
          rows.filter((r) => r.status === "paid").length === 1 ? "" : "s"
        } sent · ${totalDisplay}`,
        extras: rows.some((r) => r.claimUrl)
          ? [{ label: "Claim links", onClick: downloadClaimLinksCsv }]
          : undefined,
      }
    : running
      ? {
          kind: "publishing",
          // Step label honors the per-row substep so the bar mirrors
          // the publishing modal's copy. The bar is the only thing
          // visible on small viewports if the modal scrolls, so we
          // don't want it stuck on a generic "Sending payment 1 of 3"
          // while the modal shows "Generating ZK proof…".
          stepLabel: (() => {
            if (phase === "signing") return "Signing receipt packet";
            const human = (runRowIndex ?? 0) + 1;
            const tail = `row ${human} of ${totalCountForRun}`;
            switch (runSubStep) {
              case "fund":
                return `Funding shadow account · ${tail}`;
              case "register":
                return `Generating zero-knowledge proof · ${tail}`;
              case "deposit":
                return `Depositing into encrypted balance · ${tail}`;
              case "shielded":
                return `Sending shielded payment · ${tail}`;
              case "public":
                return `Sending public payment · ${tail}`;
              default:
                return `Sending payment ${rows.length + 1} of ${totalCountForRun}`;
            }
          })(),
          stepCounter:
            phase === "signing"
              ? "FINAL"
              : `${String(rows.length).padStart(2, "0")} / ${String(totalCountForRun).padStart(2, "0")}`,
          // Suppress the gold "Waiting on wallet" line during local-
          // only compute (the long ZK proof step is not waiting on a
          // popup — there isn't one open). The bar's "In progress"
          // copy is more honest there.
          awaitingWallet: phase === "signing" || runSubStep !== "register",
        }
      : {
          kind: "compose",
          totalDisplay,
          canSubmit: canRun,
          buttonLabel:
            rowCount === 0
              ? "Run private payroll"
              : `Run ${rowCount} private payment${rowCount === 1 ? "" : "s"}`,
        };

  /* ─────────────────────────── run-payroll ─────────────────────────── */

  /**
   * Read-only on-chain probe per row. Drives the registration chip
   * preview ("X need claim links"). Cheap (no popups, just RPC reads).
   */
  async function handleDetectRegistration() {
    if (!wallet.publicKey || parsed.rows.length === 0) return;
    setDetecting(true);
    setError(null);
    try {
      const client = await getOrCreateClient(wallet as any);
      const results = await checkRecipientsRegistration(
        client,
        parsed.rows.map((r) => r.wallet),
      );
      const rowStatuses = results.map((r) => r.status);
      const unregisteredIndexes: number[] = [];
      const unknownIndexes: number[] = [];
      rowStatuses.forEach((status, idx) => {
        if (status === "unregistered") unregisteredIndexes.push(idx);
        if (status === "unknown") unknownIndexes.push(idx);
      });
      setDetection({ rowStatuses, unregisteredIndexes, unknownIndexes });
    } catch (err: any) {
      setError(`Registration detection failed: ${err.message ?? String(err)}`);
    } finally {
      setDetecting(false);
    }
  }

  /* ───────────── recipient-row editing helpers ───────────── */

  /** Mutate one recipient row + invalidate cached registration detection. */
  function updateRecipient(idx: number, field: keyof RecipientRow, value: string) {
    setRecipients((rs) =>
      rs.map((r, i) => (i === idx ? { ...r, [field]: value } : r)),
    );
    setDetection(null);
  }

  /** Append a fresh blank row at the end. */
  function addRecipient() {
    setRecipients((rs) => [...rs, { ...EMPTY_RECIPIENT }]);
  }

  /** Drop one row (clamped to one-row minimum). */
  function removeRecipient(idx: number) {
    setRecipients((rs) =>
      rs.length === 1 ? [{ ...EMPTY_RECIPIENT }] : rs.filter((_, i) => i !== idx),
    );
    setDetection(null);
  }

  /**
   * Paste-explode: replace the row at `idx` with the parsed list, splicing
   * any subsequent rows after. Lets the user paste a multi-line CSV/TSV
   * from Excel or Sheets into any wallet field and have it expand into N
   * editable rows in place.
   */
  function explodeAt(idx: number, parsedRows: RecipientRow[]) {
    if (parsedRows.length === 0) return;
    setRecipients((rs) => {
      const before = rs.slice(0, idx);
      const after = rs.slice(idx + 1);
      // If the trailing row is the standard empty-trailing-blank, drop it
      // so the paste lands clean (no orphan empty row at the bottom).
      const tail =
        after.length > 0 &&
        !after[0].wallet.trim() &&
        !after[0].amount.trim() &&
        !after[0].memo.trim()
          ? after.slice(1)
          : after;
      return [...before, ...parsedRows, ...tail];
    });
    setDetection(null);
  }

  /** Replace the row list with the sample data. */
  function loadSample() {
    setRecipients(SAMPLE_RECIPIENTS.map((r) => ({ ...r })));
    setDetection(null);
  }

  /* ───────────── CSV file import (click + drag-drop) ───────────── */

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);

  async function ingestCsvFile(file: File) {
    const text = await file.text();
    const parsed = parsePastedRecipients(text);
    if (parsed.length > 0) {
      setRecipients(parsed);
      setDetection(null);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      ingestCsvFile(file).catch((err) =>
        setError(`CSV import failed: ${err?.message ?? String(err)}`),
      );
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  /**
   * Page-wide CSV drop zone. Listens at the window level so the user
   * can drop the file anywhere on the page (not just precisely over the
   * recipients table). When a file drag enters the window, a full-
   * viewport overlay lights up; on drop, the file is parsed and the
   * recipients[] state is replaced.
   *
   * Two subtleties:
   *
   * 1. preventDefault on dragover is mandatory — without it the browser
   *    shows the no-drop cursor and the drop event never fires. We also
   *    explicitly set dataTransfer.dropEffect = 'copy' so the cursor
   *    reads correctly across browsers.
   *
   * 2. dragenter/dragleave fire repeatedly as the cursor crosses inner
   *    elements. The standard fix is a counter: dragenter increments,
   *    dragleave decrements, overlay deactivates only when the counter
   *    hits zero (= the cursor genuinely left the window). This avoids
   *    the overlay flicker that happens when the cursor moves between
   *    children.
   *
   * 3. We filter on `e.dataTransfer.types.includes('Files')` so a regular
   *    text drag-select inside the form doesn't activate the overlay.
   *
   * The listeners attach on PayrollFlow mount and detach on unmount —
   * switching to invoice mode unmounts PayrollFlow, so the page-wide
   * drop zone goes away with it.
   */
  // Pre-warm Umbra's ZK proving assets the moment the user opens this
  // form. The first claim-link row of any batch otherwise eats a
  // ~60–90s download cost mid-prove (zkey alone is ~30 MB). Fired
  // once per mount; the helper is module-level memoised so re-mounts
  // and concurrent calls coalesce into a single in-flight fetch.
  // Best-effort: any failure leaves the SDK to fall back to its own
  // download path during proving.
  useEffect(() => {
    void prewarmZkAssets();
  }, []);

  useEffect(() => {
    if (running) return;
    let counter = 0;

    function isFileDrag(e: DragEvent): boolean {
      const types = e.dataTransfer?.types;
      if (!types) return false;
      // DataTransferItemList doesn't have .includes; iterate.
      for (let i = 0; i < types.length; i++) {
        if (types[i] === "Files") return true;
      }
      return false;
    }

    function onEnter(e: DragEvent) {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      counter++;
      setDragActive(true);
    }
    function onOver(e: DragEvent) {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    }
    function onLeave(e: DragEvent) {
      if (!isFileDrag(e)) return;
      counter = Math.max(0, counter - 1);
      if (counter === 0) setDragActive(false);
    }
    function onDrop(e: DragEvent) {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      counter = 0;
      setDragActive(false);
      const file = e.dataTransfer?.files?.[0];
      if (file) {
        ingestCsvFile(file).catch((err) =>
          setError(`CSV import failed: ${err?.message ?? String(err)}`),
        );
      }
    }

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [running]);

  async function handleSubmit() {
    if (!wallet.publicKey) {
      setError("Connect wallet first.");
      return;
    }
    if (!companyName.trim()) {
      setError("Company / payer name is required.");
      return;
    }
    if (parsed.errors.length > 0 || parsed.rows.length === 0) {
      setError(parsed.errors[0] ?? "Paste at least one payroll row.");
      return;
    }

    setRunning(true);
    setPhase("sending");
    setRunTotalCount(parsed.rows.length);
    setError(null);
    setNotice(null);
    setRows([]);
    setPacket(null);
    setSignedPacket(null);
    setPacketUrl(null);
    setPacketCopied(false);

    // Phase C: drop any registered-receiver lookups left over from a
    // prior run. Otherwise a recipient who registered between runs would
    // still be cached as `null` (= claim-link path) and we'd build an
    // unnecessary shadow for them.
    resetRegisteredReceiverCache();

    const batchId = generatePrivatePayrollBatchId();
    const resultRows: PayrollRunRow[] = [];

    try {
      const client = await getOrCreateClient(wallet as any);
      setRegOpen(true);
      await ensureRegistered(client, (step, status) => {
        setRegSteps((prev) => ({
          ...prev,
          [step]: status === "pre" ? "in_progress" : "done",
        }));
      });
      await ensureReceiverKeyAligned(client);
      setRegOpen(false);

      // Always make sure we know each recipient's registration status
      // before the loop starts. Without this, an undetected unregistered
      // recipient falls through to the direct-send path and Umbra rejects
      // it with 'Receiver is not registered'. Cached detection (set when
      // the user clicked the chip earlier) is reused; otherwise we run
      // the probe inline now. RPC-only, no popups.
      let activeDetection = detection;
      if (!activeDetection) {
        setDetecting(true);
        try {
          const results = await checkRecipientsRegistration(
            client,
            parsed.rows.map((r) => r.wallet),
          );
          const rowStatuses = results.map((r) => r.status);
          const unregisteredIndexes: number[] = [];
          const unknownIndexes: number[] = [];
          rowStatuses.forEach((s, idx) => {
            if (s === "unregistered") unregisteredIndexes.push(idx);
            if (s === "unknown") unknownIndexes.push(idx);
          });
          activeDetection = { rowStatuses, unregisteredIndexes, unknownIndexes };
          setDetection(activeDetection);
        } finally {
          setDetecting(false);
        }
      }

      const encryptedBalance = await getEncryptedBalance(client, USDC_MINT.toBase58()).catch(
        () => 0n,
      );
      const useShieldedForRun =
        mode === "shielded" || (mode === "auto" && encryptedBalance >= total && total > 0n);

      setNotice(
        useShieldedForRun
          ? `Using shielded ${PAYMENT_SYMBOL} balance for this payroll.`
          : `Using public wallet balance for this payroll.`,
      );

      // Parallel row execution.
      //
      // We run up to PAYROLL_PARALLEL_LIMIT rows concurrently. Each row
      // is independent — its own ephemeral keypair, its own ZK proof,
      // its own RPC submissions — so we can overlap the slowest steps
      // (ZK proof generation + Arcium MPC compute) across rows. On a
      // 3-row batch this drops wall-clock from ~4 min (all rows
      // serial) to ~90s (single-row cost dominates).
      //
      // Phantom serializes signTransaction calls automatically: when
      // the user signs popup #1, popup #2 opens, etc. So the popup UX
      // stays sequential — the user just keeps clicking through. The
      // win is purely background compute parallelism.
      //
      // Cap of 3 keeps memory/network tame and avoids overwhelming
      // Phantom's popup queue (which can occasionally drop popups
      // beyond ~5 in flight per the Phantom team's docs).
      //
      // Result ordering: we MUST preserve input order in resultRows
      // because the signed packet's row order is canonical. We
      // pre-allocate a length-N slot array and write by index — not
      // by completion order — so the packet shape stays deterministic.
      const PAYROLL_PARALLEL_LIMIT = 3;
      const slots: Array<PayrollRunRow | null> = parsed.rows.map(() => null);

      // Capture detection in a guaranteed-non-null const so the closure
      // below doesn't trip TypeScript's narrowing reset across closures.
      const detectionForRun = activeDetection;

      // Phase C: per-row direct-path eligibility lookup.
      //
      // For each row we fetch the recipient's on-chain x25519 token-
      // encryption key + userCommitment via `lookupRegisteredReceiver`.
      // When non-null, the recipient is fully registered with Umbra and
      // we can build a deposit ix that targets their wallet directly —
      // no shadow indirection, no claim URL, no shadow→recipient hop.
      //
      // Run in parallel (Promise.all): each lookup is one
      // `connection.getAccountInfo` round-trip. Failures bucket as
      // `null` (= row falls back to the shadow / claim-link path).
      //
      // The existing `detectionForRun.rowStatuses` is still used for
      // UI display ("X need claim links"). It runs the SAME chain
      // probe (`getUserAccountQuerierFunction`) but only reads the
      // status flags, not the field values — we need the actual
      // x25519 + userCommitment to feed `payInvoiceCpi` overrides.
      // Having both queries side-by-side is cheap on devnet RPC.
      // eslint-disable-next-line no-console
      console.time(`[payroll] direct-path lookup (${parsed.rows.length} rows)`);
      const lookupResults: Array<RegisteredReceiverValues | null> =
        await Promise.all(
          parsed.rows.map((row) =>
            lookupRegisteredReceiver(row.wallet, connection).catch(() => null),
          ),
        );
      // eslint-disable-next-line no-console
      console.timeEnd(`[payroll] direct-path lookup (${parsed.rows.length} rows)`);

      const registeredReceivers = new Map<number, RegisteredReceiverValues>();
      lookupResults.forEach((result, idx) => {
        if (result) registeredReceivers.set(idx, result);
      });

      // Deposit batching: when the wallet supports signAllTransactions
      // AND we're going to use the VeilPay CPI deposit path AND there
      // are 2+ claim-link rows (otherwise batching saves nothing), we
      // defer the per-row deposit and run a post-pool batched deposit
      // phase. Cuts N deposit popups to 1.
      //
      // The shielded direct path doesn't go through this — its txs
      // are encapsulated by the SDK's creator function and aren't
      // amenable to extraction without an SDK-internals refactor.
      const useVeilPayCpiForDeposits =
        process.env.NEXT_PUBLIC_USE_VEIL_PAY_CPI !== "false";
      // Phase C: claim-link path is now the "lookup returned null"
      // bucket. The rowStatuses-based count above is kept as a
      // sanity check during transition — they should agree (a row
      // whose lookup is null should also have status === "unregistered").
      const claimLinkCount = parsed.rows.filter(
        (_, idx) => !registeredReceivers.has(idx),
      ).length;
      const batchedDepositEnabled =
        !!wallet.signAllTransactions &&
        useVeilPayCpiForDeposits &&
        claimLinkCount >= 1;

      // Map keyed by row index — populated by claim-link workers when
      // they finish register and need to wait for the batched-deposit
      // phase. Each entry carries enough context to (a) build the
      // unsigned VeilPay tx and (b) finalise slots[i] after the batch
      // submits.
      const pendingDeposits = new Map<
        number,
        {
          shadowAddress: string;
          claimUrl: string;
          prepared: PayrollRunRow;
        }
      >();

      // ────────────────────────────────────────────────────────────────
      // SINGLE-POPUP PRE-FLIGHT (Phase 1 of the 1-popup plan).
      //
      // We sign EVERYTHING that needs Alice's signature in ONE
      // Phantom popup at t=0:
      //   - 1 batched fund tx (multi-instruction v0 — N transfers)
      //   - N VeilPay deposit txs (one per claim-link row)
      //
      // Building deposit txs at t=0 (BEFORE the shadow has been
      // registered on chain) is enabled by `deriveShadowRegistrationValues`
      // — we compute the shadow's x25519 + userCommitment locally
      // from its master seed using the SDK's own derivers. The values
      // exactly match what register would write to chain, so ZK
      // verification is unaffected.
      //
      // Submission is deferred per-row:
      //   1. Submit the batched fund tx, wait for confirm.
      //   2. Worker pool runs register sub-txs in parallel
      //      (signed by shadow's in-memory keypair, no popups).
      //   3. After all registers settle, submit the pre-signed
      //      deposit txs in parallel.
      //
      // Result: 1 popup for all-claim-link batches, regardless of N.
      //
      // Per-row error model: a build/sign/submit failure for one row
      // marks that row's slot failed; other rows still settle.
      //
      // Fallback: if `signAllTransactions` is missing on the wallet
      // adapter (rare), each row falls back to the per-row fund +
      // deposit pattern (the legacy 3-popup-per-row flow).
      const prefundedShadows = new Map<
        number,
        {
          ephemeral: EphemeralKeypair;
          shadowClient?: any;
          fundError: string | null;
          /** Pre-signed VeilPay deposit tx + metadata for submission
           *  after register completes. Populated only on successful
           *  build + sign in the unified pre-flight. */
          signedDeposit?: {
            tx: VersionedTransaction;
            built: any; // BuiltPayInvoiceCpiTx
          };
        }
      >();
      // Phase C: row classification is now driven by `registeredReceivers`
      // (= the lookup map) rather than the legacy registration-status
      // strings. A row with no lookup entry means we couldn't read a
      // fully-registered Umbra user account on chain → it must go
      // through the shadow / claim-link flow.
      const claimLinkIndexes = parsed.rows
        .map((_, idx) => idx)
        .filter((idx) => !registeredReceivers.has(idx));

      // Path A: shielded rows that should join the same single popup.
      // These are rows where (a) Alice is paying from her encrypted
      // balance (useShieldedForRun) AND (b) the recipient is already
      // a registered Umbra user (lookup returned values). Public-source
      // rows targeting registered recipients now go down the Phase C
      // direct path (see `directRegisteredIndexes` below) instead of
      // the legacy `payInvoice` flow.
      //
      // For each shielded row we build 2-3 unsigned txs via
      // payShieldedCpi (close-existing? + proof + utxo) and stash them
      // in `prebuiltShielded`. They join the main signAllTransactions
      // popup; submission runs sequentially in the worker pool's
      // direct path.
      const shieldedIndexes = useShieldedForRun
        ? parsed.rows
            .map((_, idx) => idx)
            .filter((idx) => registeredReceivers.has(idx))
        : [];

      // Phase C: registered recipients on the public-source pay path.
      // We pre-build the deposit ix here (just like claim-link rows)
      // using `payInvoiceCpi` with `ProofOverrides` so the chain fetch
      // of the receiver account is skipped (we already have the
      // x25519 + userCommitment from the earlier lookup). The deposit
      // joins the same single-popup signAllTransactions batch as
      // claim-link + shielded rows, then submits AS SOON AS the popup
      // returns — there's no fund/register sequencing to wait on
      // because there's no shadow.
      //
      // Mutually exclusive with shielded for a given row: if
      // useShieldedForRun is true, registered recipients take the
      // shielded path instead. Public-source registered recipients
      // are the ones who join this set.
      const directRegisteredIndexes = useShieldedForRun
        ? []
        : parsed.rows
            .map((_, idx) => idx)
            .filter((idx) => registeredReceivers.has(idx));

      // Per-row direct-path bookkeeping. Mirrors `prefundedShadows`
      // but with no ephemeral / fund / register state — just the
      // values pulled from chain plus the eventual signed deposit.
      const directRegistered = new Map<number, DirectRegisteredEntry>();

      // Map keyed by row index. Populated by pre-flight; consumed by
      // processRow's direct path when the row has a pre-built+
      // pre-signed shielded bundle.
      const prebuiltShielded = new Map<
        number,
        {
          built: any; // BuiltShieldedCpiTxs (lazy-imported below)
          signedClose?: VersionedTransaction;
          signedProof?: VersionedTransaction;
          signedUtxo?: VersionedTransaction;
          buildError?: string;
        }
      >();

      // Pre-flight runs whenever there's ANYTHING to batch — claim-link
      // rows, shielded rows, AND Phase C direct-registered rows.
      // Without a wallet that supports signAllTransactions we fall
      // back to the legacy per-row SDK paths (cold-cache fallback for
      // claim-link; direct payInvoiceFromShielded for shielded; and
      // payInvoice's own SDK orchestration for direct-registered).
      const hasBatchableRows =
        claimLinkIndexes.length +
          shieldedIndexes.length +
          directRegisteredIndexes.length >
        0;

      if (hasBatchableRows && wallet.signAllTransactions) {
        setRunSubStep("fund");
        setRunRowIndex(0);

        const { buildPayInvoiceCpiTx } = await import("@/lib/payInvoiceCpi");

        // Phase 2 (durable nonces) — DISABLED.
        //
        // The original plan: anchor each deposit tx to a per-wallet
        // durable nonce so the tx never expires regardless of how
        // long the shadow's register takes. This would have given
        // true 1-popup robustness even with a cold IDB cache (90s+
        // register).
        //
        // Why it doesn't fit:
        //   `nonceAdvance` invokes `SystemProgram` as its programId.
        //   Solana protocol requires invoked program IDs in the
        //   STATIC account list (the validator resolves BPF programs
        //   at message-deserialize time). `compileToV0Message` enforces
        //   this with the `!isInvoked` filter in extractTableLookup —
        //   even if SystemProgram is in the ALT entries, it can't be
        //   ALT-resolved. That forces a +32-byte SystemProgram pubkey
        //   into the deposit tx's static keys, pushing it 19 bytes
        //   over the 1232-byte cap. No client-side workaround exists.
        //
        // Path forward when revisiting:
        //   Have VeilPay program internalize nonceAdvance via CPI
        //   (eliminates the outer ix). Real protocol change; not
        //   hackathon-week scope.
        //
        // What we rely on instead:
        //   1. `prewarmZkAssets()` on page-load (see useEffect at
        //      mount) — keeps the IDB cache warm so register is fast
        //      (~15-25s) in nearly all real-world flows.
        //   2. Cold-cache fallback in `submit pre-signed deposits`
        //      below — if a blockhash does expire, refresh + re-sign
        //      in a single fallback popup.
        //
        // Net experience: 1 popup in the warm path (>99% of cases),
        // 2 popups when the cache is genuinely cold and register
        // outruns the blockhash window.
        const nonces: null = null;
        const nonceAltAddress: undefined = undefined;

        // Phase A: parallel setup per claim-link row.
        //   1. Generate ephemeral keypair + build shadow client.
        //   2. Derive registration values locally from the shadow's
        //      master seed.
        //   3. Build the deposit VeilPay tx using those values
        //      (chain fetch of receiver skipped via overrides).
        //
        // ZK proof generation is the slow part — we run them all in
        // parallel because each row has independent inputs (different
        // shadow x25519, different commitments).
        // eslint-disable-next-line no-console
        console.time(`[payroll] preflight setup (${claimLinkIndexes.length} rows)`);
        type RowSetup = {
          idx: number;
          ephemeral: EphemeralKeypair;
          shadowClient: any;
          depositBuilt: any; // BuiltPayInvoiceCpiTx
          buildError?: string;
        };
        const setups: RowSetup[] = await Promise.all(
          claimLinkIndexes.map(async (idx, rowIndexInClaimLink): Promise<RowSetup> => {
            const ephemeral = generateEphemeralKeypair();
            try {
              // `prepareRow` converts the display amount ("0.10") to
              // base units ("100000000") via parseAmountToBaseUnits +
              // also validates the recipient pubkey. We MUST use the
              // prepared amount here because BigInt() on a decimal
              // string ("0.10") throws SyntaxError. Earlier per-row
              // path used `BigInt(args.prepared.amount)` for the same
              // reason — the bug was in this pre-flight passing the
              // raw input row instead of the prepared row.
              const prepared = prepareRow(parsed.rows[idx], idx);
              const shadowClient = await buildShadowClient(ephemeral.privateKey);
              const regValues = await deriveShadowRegistrationValues(shadowClient);
              // Nonce config intentionally omitted — see Phase-2-disabled
              // comment block above. Deposits use regular blockhashes;
              // cold-cache fallback below catches the rare expiry case.
              // `nonces` and `nonceAltAddress` are kept in scope so a
              // future re-enable doesn't need to re-thread variables.
              void nonces;
              void nonceAltAddress;
              void rowIndexInClaimLink;
              const depositBuilt = await buildPayInvoiceCpiTx(
                {
                  client,
                  recipientAddress: ephemeral.address,
                  mint: USDC_MINT.toBase58(),
                  amount: BigInt(prepared.amount),
                },
                {
                  receiverX25519PublicKey: regValues.x25519PublicKey,
                  receiverUserCommitment: regValues.userCommitment,
                },
              );
              return { idx, ephemeral, shadowClient, depositBuilt };
            } catch (err: any) {
              return {
                idx,
                ephemeral,
                shadowClient: null,
                depositBuilt: null,
                buildError: err?.message ?? String(err),
              };
            }
          }),
        );
        // eslint-disable-next-line no-console
        console.timeEnd(`[payroll] preflight setup (${claimLinkIndexes.length} rows)`);

        // Stash all successfully-built setups into prefundedShadows,
        // failed builds go straight to fundError so processRow shorts.
        for (const s of setups) {
          prefundedShadows.set(s.idx, {
            ephemeral: s.ephemeral,
            shadowClient: s.shadowClient,
            fundError: s.buildError ? `deposit-build: ${s.buildError}` : null,
          });
        }

        const goodSetups = setups.filter((s) => !s.buildError);

        // Phase A.5: parallel shielded build (Path A). For each
        // shielded row (Alice paying from her encrypted balance,
        // recipient is registered) we use the proxied-client SDK
        // capture pattern in payShieldedCpi to produce 2-3 unsigned
        // VersionedTransactions (close-existing? + proof + utxo)
        // ready to join the same signAllTransactions popup as fund
        // + claim-link deposits.
        type ShieldedSetup = {
          idx: number;
          built: any | null; // BuiltShieldedCpiTxs
          buildError?: string;
        };
        let shieldedSetups: ShieldedSetup[] = [];
        if (shieldedIndexes.length > 0) {
          // eslint-disable-next-line no-console
          console.time(
            `[payroll] preflight shielded build (${shieldedIndexes.length} rows)`,
          );
          const { buildShieldedCpiTxs } = await import("@/lib/payShieldedCpi");
          shieldedSetups = await Promise.all(
            shieldedIndexes.map(async (idx): Promise<ShieldedSetup> => {
              try {
                const prepared = prepareRow(parsed.rows[idx], idx);
                const built = await buildShieldedCpiTxs({
                  client,
                  recipientAddress: prepared.recipient,
                  mint: USDC_MINT.toBase58(),
                  amount: BigInt(prepared.amount),
                });
                return { idx, built };
              } catch (err: any) {
                return {
                  idx,
                  built: null,
                  buildError: err?.message ?? String(err),
                };
              }
            }),
          );
          // eslint-disable-next-line no-console
          console.timeEnd(
            `[payroll] preflight shielded build (${shieldedIndexes.length} rows)`,
          );
          // Stash successful builds; failed ones fall through to the
          // legacy payInvoiceFromShielded path in processRow's direct
          // branch (so a bad ZK build doesn't block the whole batch).
          for (const s of shieldedSetups) {
            if (!s.buildError) {
              prebuiltShielded.set(s.idx, { built: s.built });
            } else {
              // eslint-disable-next-line no-console
              console.warn(
                `[payroll row ${s.idx + 1}] shielded build failed; falling back to legacy SDK path: ${s.buildError}`,
              );
            }
          }
        }
        const goodShielded = shieldedSetups.filter((s) => !s.buildError);

        // Phase A.6 — parallel direct-registered build (Phase C).
        // For each row whose recipient is fully Umbra-registered AND
        // the run isn't using shielded balance, we pre-fetch their
        // x25519 + userCommitment via `lookupRegisteredReceiver`
        // (already done above; cached in `registeredReceivers`) and
        // build a `payInvoiceCpi` deposit tx directly to the recipient
        // wallet — no shadow involved. The same `ProofOverrides`
        // mechanism the claim-link path uses lets us skip the chain
        // fetch inside `generateProofAndCommitments` since we already
        // hold the values.
        type DirectSetup = {
          idx: number;
          values: RegisteredReceiverValues;
          depositBuilt: any | null; // BuiltPayInvoiceCpiTx
          buildError?: string;
        };
        let directSetups: DirectSetup[] = [];
        if (directRegisteredIndexes.length > 0) {
          // eslint-disable-next-line no-console
          console.time(
            `[payroll] preflight direct-registered build (${directRegisteredIndexes.length} rows)`,
          );
          directSetups = await Promise.all(
            directRegisteredIndexes.map(async (idx): Promise<DirectSetup> => {
              const values = registeredReceivers.get(idx)!;
              try {
                const prepared = prepareRow(parsed.rows[idx], idx);
                const depositBuilt = await buildPayInvoiceCpiTx(
                  {
                    client,
                    recipientAddress: prepared.recipient,
                    mint: USDC_MINT.toBase58(),
                    amount: BigInt(prepared.amount),
                  },
                  {
                    receiverX25519PublicKey: values.x25519PublicKey,
                    receiverUserCommitment: values.userCommitment,
                  },
                );
                return { idx, values, depositBuilt };
              } catch (err: any) {
                return {
                  idx,
                  values,
                  depositBuilt: null,
                  buildError: err?.message ?? String(err),
                };
              }
            }),
          );
          // eslint-disable-next-line no-console
          console.timeEnd(
            `[payroll] preflight direct-registered build (${directRegisteredIndexes.length} rows)`,
          );
          for (const s of directSetups) {
            directRegistered.set(s.idx, {
              values: s.values,
              buildError: s.buildError
                ? `direct-deposit-build: ${s.buildError}`
                : null,
            });
          }
        }
        const goodDirect = directSetups.filter((s) => !s.buildError);

        // Mixed-batch entry condition: enter the popup branch if we
        // have at least ONE successful build (claim-link, shielded,
        // or direct-registered). The fund tx is conditional on having
        // claim-link rows.
        if (
          goodSetups.length > 0 ||
          goodShielded.length > 0 ||
          goodDirect.length > 0
        ) {
          // Build the batched fund tx (one v0 tx with N transfers).
          // Skipped when there are no claim-link rows — pure shielded
          // batches don't need to fund any shadow accounts.
          let fundBuilt: BuiltBatchedFundTx | null = null;
          if (goodSetups.length > 0) {
            try {
              fundBuilt = await buildBatchedFundTxV0({
                payerPubkey: wallet.publicKey!,
                shadows: goodSetups.map((s) => ({
                  address: s.ephemeral.address,
                  lamports: SHADOW_FUNDING_LAMPORTS,
                })),
                connection: connection as any,
              });
            } catch (err: any) {
              const msg = err?.message ?? String(err);
              for (const s of goodSetups) {
                const entry = prefundedShadows.get(s.idx);
                if (entry) entry.fundError = `fund-build: ${msg}`;
              }
            }
          }

          // We can proceed to sign as long as the build set isn't
          // entirely empty. The claim-link branch needs fundBuilt;
          // the shielded branch doesn't.
          const fundOk = goodSetups.length === 0 || fundBuilt !== null;
          if (fundOk) {
            // ── THE SINGLE POPUP ──
            // Phantom shows: (optional fund) + N claim-link deposits +
            // (close? + proof + utxo) per shielded row + N direct-
            // registered deposits. User signs once.
            //
            // Order matters for routing signed txs back: fund first,
            // then claim-link deposits in goodSetups order, then for
            // each shielded row in goodShielded order: close (if any),
            // proof, utxo, then direct-registered deposits in
            // goodDirect order. The cursor logic after signing mirrors
            // this.
            const txArray: VersionedTransaction[] = [];
            if (fundBuilt) txArray.push(fundBuilt.tx);
            for (const s of goodSetups) txArray.push(s.depositBuilt.tx);
            for (const s of goodShielded) {
              if (s.built.closeTx) txArray.push(s.built.closeTx);
              txArray.push(s.built.proofTx);
              txArray.push(s.built.utxoTx);
            }
            for (const s of goodDirect) txArray.push(s.depositBuilt.tx);
            const popupLabel = `[payroll] SINGLE POPUP signAll (${txArray.length} txs: ${fundBuilt ? "1 fund + " : ""}${goodSetups.length} claim-link + ${goodShielded.length} shielded + ${goodDirect.length} direct)`;
            // eslint-disable-next-line no-console
            console.time(popupLabel);
            let signedTxs: VersionedTransaction[] = [];
            try {
              signedTxs = await wallet.signAllTransactions(txArray);
            } catch (err: any) {
              const msg = err?.message ?? String(err);
              for (const s of goodSetups) {
                const entry = prefundedShadows.get(s.idx);
                if (entry) entry.fundError = `combined-sign: ${msg}`;
              }
              for (const s of goodShielded) {
                const entry = prebuiltShielded.get(s.idx);
                if (entry) entry.buildError = `combined-sign: ${msg}`;
              }
              for (const s of goodDirect) {
                const entry = directRegistered.get(s.idx);
                if (entry) entry.buildError = `combined-sign: ${msg}`;
              }
            } finally {
              // eslint-disable-next-line no-console
              console.timeEnd(popupLabel);
            }

            if (signedTxs.length === txArray.length) {
              // Walk the signed array with a cursor that mirrors the
              // build order above.
              let cursor = 0;
              const signedFund = fundBuilt ? signedTxs[cursor++] : null;
              for (let i = 0; i < goodSetups.length; i++) {
                const s = goodSetups[i];
                const entry = prefundedShadows.get(s.idx);
                if (entry) {
                  entry.signedDeposit = {
                    tx: signedTxs[cursor++],
                    built: s.depositBuilt,
                  };
                }
              }
              for (const s of goodShielded) {
                const entry = prebuiltShielded.get(s.idx);
                if (!entry) {
                  // Skip — failed build was filtered out earlier; if
                  // we reach here something's inconsistent.
                  if (s.built.closeTx) cursor++;
                  cursor += 2;
                  continue;
                }
                if (s.built.closeTx) entry.signedClose = signedTxs[cursor++];
                entry.signedProof = signedTxs[cursor++];
                entry.signedUtxo = signedTxs[cursor++];
              }
              for (const s of goodDirect) {
                const entry = directRegistered.get(s.idx);
                if (entry) {
                  entry.signedDeposit = {
                    tx: signedTxs[cursor++],
                    built: s.depositBuilt,
                  };
                }
              }

              // Submit the batched fund tx and confirm. After this
              // returns, every shadow has lamports — register can
              // run. Skipped on shielded-only batches.
              if (signedFund && fundBuilt) {
                try {
                  await submitSignedBatchedFundTxV0({
                    signedTx: signedFund,
                    built: fundBuilt,
                    connection: connection as any,
                  });
                } catch (err: any) {
                  const msg = err?.message ?? String(err);
                  for (const s of goodSetups) {
                    const entry = prefundedShadows.get(s.idx);
                    if (entry) entry.fundError = `fund-submit: ${msg}`;
                  }
                }
              }
            }
          }
        }
      }

      // Helper that processes ONE row to completion and writes its
      // result into `slots[i]`. Idempotent on retry. The setRows()
      // call after each completion drives the modal's sentCount
      // counter ("Sending payment N of M") — the count is computed
      // from non-null slot length.
      async function processRow(i: number): Promise<void> {
        const row = parsed.rows[i];
        const prepared = prepareRow(row, i);
        const status = detectionForRun.rowStatuses[i];
        // Phase C: row classification follows the lookup map. If we
        // couldn't read a fully-registered Umbra account on chain for
        // this recipient, the row goes through the shadow / claim-link
        // flow regardless of what the registration-status string says.
        const isRegistered = registeredReceivers.has(i);

        if (!isRegistered) {
          // If the pre-flight batched-fund step caught a fund-side
          // error for this row, short-circuit before sendViaClaimLink
          // tries to register a shadow with no lamports.
          const prefund = prefundedShadows.get(i);
          if (prefund?.fundError) {
            slots[i] = {
              ...prepared,
              status: "failed",
              mode: "public",
              path: "claim-link",
              txSignature: null,
              error: `Claim-link fund step failed: ${prefund.fundError}`,
              errorDetail: {
                summary: `Claim-link fund step failed: ${prefund.fundError}`,
                phase: "fund",
                rawMessage: prefund.fundError,
              },
              registrationStatus: "unregistered",
            };
            flushSlots();
            return;
          }
          try {
            const claimResult = await sendViaClaimLink({
              prepared,
              payerClient: client,
              payerWallet: wallet,
              connection,
              companyName,
              batchId,
              rowIndex: i,
              // Reuse the pre-funded ephemeral if one exists. When
              // present, sendViaClaimLink skips its own fund step
              // entirely (the shadow already has lamports from the
              // batched pre-flight popup) and goes straight to
              // register + deposit.
              prefundedEphemeral: prefund?.ephemeral,
              // Skip the per-row deposit if the coordinator will
              // batch all deposits across rows in one signAllTxs
              // popup after registers complete. Only enabled when
              // we have a wallet with signAllTransactions support
              // AND there's at least one claim-link row to batch.
              deferDeposit: batchedDepositEnabled,
            });
            // When deferDeposit is true, the call above returned
            // before depositing. Stage the row for the post-pool
            // batched-deposit phase. Slot stays null until the
            // batched phase actually settles the deposit.
            if (claimResult.deferred) {
              pendingDeposits.set(i, {
                shadowAddress: claimResult.shadowAddress,
                claimUrl: claimResult.claimUrl,
                prepared,
              });
              flushSlots();
              return;
            }
            slots[i] = {
              ...prepared,
              status: "paid",
              mode: "public",
              path: "claim-link",
              txSignature: claimResult.depositSignature,
              error: null,
              claimUrl: claimResult.claimUrl,
              registrationStatus: "unregistered",
            };
          } catch (err: any) {
            const detail = await formatTxError(err, {
              phase: err?.__veilPhase ?? undefined,
              connection,
            });
            const phaseLabel = detail.phase
              ? `Claim-link ${detail.phase} step failed`
              : "Claim-link path failed";
            slots[i] = {
              ...prepared,
              status: "failed",
              mode: "public",
              path: "claim-link",
              txSignature: null,
              error: `${phaseLabel}: ${detail.summary}`,
              errorDetail: { ...detail, summary: `${phaseLabel}: ${detail.summary}` },
              registrationStatus: "unregistered",
            };
          }
          flushSlots();
          return;
        }

        // Phase C: direct-registered path. The recipient is already a
        // fully-registered Umbra user; the deposit ix targets their
        // wallet directly and was pre-built + pre-signed in the
        // single-popup pre-flight. We just submit the cached signed
        // tx — no fund/register dance, no claim URL.
        if (!useShieldedForRun) {
          const direct = directRegistered.get(i);
          if (direct?.buildError) {
            slots[i] = {
              ...prepared,
              status: "failed",
              mode: "public",
              path: "direct-registered",
              txSignature: null,
              error: `Direct path build/sign failed: ${direct.buildError}`,
              errorDetail: {
                summary: `Direct path build/sign failed: ${direct.buildError}`,
                phase: "deposit",
                rawMessage: direct.buildError,
              },
              registrationStatus: status,
            };
            flushSlots();
            return;
          }
          if (direct?.signedDeposit) {
            // eslint-disable-next-line no-console
            console.time(`[payroll row ${i + 1}] direct-registered submit pre-signed`);
            try {
              const { submitSignedPayInvoiceCpiTx } = await import(
                "@/lib/payInvoiceCpi"
              );
              const result = await submitSignedPayInvoiceCpiTx({
                signedTx: direct.signedDeposit.tx,
                built: direct.signedDeposit.built,
              });
              slots[i] = {
                ...prepared,
                status: "paid",
                mode: "public",
                path: "direct-registered",
                txSignature: result.createUtxoSignature,
                error: null,
                registrationStatus: status,
              };
            } catch (err: any) {
              const detail = await formatTxError(err, {
                phase: "deposit",
                connection,
              });
              slots[i] = {
                ...prepared,
                status: "failed",
                mode: "public",
                path: "direct-registered",
                txSignature: null,
                error: `Direct path deposit-submit failed: ${detail.summary}`,
                errorDetail: detail,
                registrationStatus: status,
              };
            } finally {
              // eslint-disable-next-line no-console
              console.timeEnd(`[payroll row ${i + 1}] direct-registered submit pre-signed`);
            }
            flushSlots();
            return;
          }
          // No pre-built bundle (e.g. wallet adapter without
          // signAllTransactions). Fall through to the legacy
          // payInvoice path below — it'll produce the same on-chain
          // outcome, just at the cost of a per-row Phantom popup.
        }

        // Direct path (recipient is already a Veil/Umbra user).
        //
        // Path A integration: if this row is shielded AND the
        // pre-flight successfully built+signed its sub-txs, we just
        // submit the pre-signed bundle in order — NO popup is fired
        // here, the user already approved during the unified
        // signAllTransactions popup. Falls through to the legacy
        // payInvoiceFromShielded path on missing/failed bundle.
        const shieldedBundle = useShieldedForRun
          ? prebuiltShielded.get(i)
          : undefined;
        if (
          shieldedBundle &&
          !shieldedBundle.buildError &&
          shieldedBundle.signedProof &&
          shieldedBundle.signedUtxo
        ) {
          // eslint-disable-next-line no-console
          console.time(`[payroll row ${i + 1}] shielded submit pre-signed`);
          try {
            const { submitSignedShieldedTxsInOrder } = await import(
              "@/lib/payShieldedCpi"
            );
            const result = await submitSignedShieldedTxsInOrder({
              signedClose: shieldedBundle.signedClose,
              signedProof: shieldedBundle.signedProof,
              signedUtxo: shieldedBundle.signedUtxo,
              built: shieldedBundle.built,
            });
            slots[i] = {
              ...prepared,
              status: "paid",
              mode: "shielded",
              path: "shielded",
              txSignature: result.utxoSignature,
              error: null,
              registrationStatus: status,
            };
          } catch (err: any) {
            const detail = await formatTxError(err, {
              phase: "shielded",
              connection,
            });
            slots[i] = {
              ...prepared,
              status: "failed",
              mode: "shielded",
              path: "shielded",
              txSignature: null,
              error: detail.summary,
              errorDetail: detail,
              registrationStatus: status,
            };
          } finally {
            // eslint-disable-next-line no-console
            console.timeEnd(`[payroll row ${i + 1}] shielded submit pre-signed`);
          }
          flushSlots();
          return;
        }

        // Legacy SDK path — used for non-shielded direct pays AND
        // shielded rows whose pre-build failed or wasn't attempted
        // (wallet adapter without signAllTransactions support).
        // For non-shielded direct pays this is equivalent to the new
        // Phase C direct-registered path: same on-chain outcome,
        // just without the single-popup batching win (each row gets
        // its own popup).
        // eslint-disable-next-line no-console
        console.time(`[payroll row ${i + 1}] ${useShieldedForRun ? "shielded" : "public"} payInvoice`);
        try {
          const payResult = useShieldedForRun
            ? await payInvoiceFromShielded({
                client,
                recipientAddress: prepared.recipient,
                mint: USDC_MINT.toBase58(),
                amount: BigInt(prepared.amount),
              })
            : await payInvoice({
                client,
                recipientAddress: prepared.recipient,
                mint: USDC_MINT.toBase58(),
                amount: BigInt(prepared.amount),
              });
          slots[i] = {
            ...prepared,
            status: "paid",
            mode: useShieldedForRun ? "shielded" : "public",
            path: useShieldedForRun ? "shielded" : "direct-registered",
            txSignature: payResult.createUtxoSignature,
            error: null,
            registrationStatus: status,
          };
        } catch (err: any) {
          const detail = await formatTxError(err, {
            phase: useShieldedForRun ? "shielded" : "public",
            connection,
          });
          slots[i] = {
            ...prepared,
            status: "failed",
            mode: useShieldedForRun ? "shielded" : "public",
            path: useShieldedForRun ? "shielded" : "direct-registered",
            txSignature: null,
            error: detail.summary,
            errorDetail: detail,
            registrationStatus: status,
          };
        } finally {
          // eslint-disable-next-line no-console
          console.timeEnd(`[payroll row ${i + 1}] ${useShieldedForRun ? "shielded" : "public"} payInvoice`);
        }
        flushSlots();
      }

      // Push completed slots into the live `rows` state in order.
      // Trailing nulls are sliced off so the modal counter only sees
      // settled rows — partial state stays out of the canonical row
      // list until each row's processing function fully resolves.
      function flushSlots() {
        const settled: PayrollRunRow[] = [];
        for (const slot of slots) {
          if (slot != null) settled.push(slot);
          else break; // first null breaks the prefix; later filled
                       // slots will publish when earlier ones finish
        }
        setRows(settled);
      }

      // Worker-pool driver. Each "worker" pulls the next pending row
      // index from a shared cursor and processes it; when the queue
      // is empty the worker exits. Promise.all over the worker
      // promises waits for every row to settle before we move on to
      // packet signing.
      let cursor = 0;
      const worker = async () => {
        while (cursor < parsed.rows.length) {
          const i = cursor++;
          await processRow(i);
        }
      };
      const workers: Promise<void>[] = [];
      const workerCount = Math.min(PAYROLL_PARALLEL_LIMIT, parsed.rows.length);
      for (let w = 0; w < workerCount; w++) {
        workers.push(worker());
      }
      // Set rowIndex to 0 — with parallel rows the per-row pointer is
      // less meaningful, but we keep it set so the modal's "row N of
      // M" copy points at the first incomplete row. Not authoritative
      // for parallel mode; the count drives progress.
      setRunRowIndex(0);
      setRunSubStep(null); // clear single-row substep — meaningless in parallel
      await Promise.all(workers);

      // ────────────────────────────────────────────────────────────────
      // Submit pre-signed deposits, with cold-cache fallback (Phase 1).
      //
      // Happy path (warm cache): the deposit txs were signed in the
      // SAME Phantom popup as the fund tx during pre-flight. By now,
      // every shadow has been registered. We just submit the cached
      // signed txs in parallel — no popup, no signing.
      //
      // Cold-cache fallback: if register took >60s (cold IDB cache
      // makes the first row's register run ~90s on a brand-new
      // device), the pre-signed deposit tx's blockhash has expired
      // by the time we submit. Detected via "Blockhash not found"
      // in the submission error. Falls back to:
      //   1. Refresh just the blockhash on the affected deposit
      //      txs (reuses the cached ZK proof + codama instructions
      //      — fast, ~50ms vs. ~10-20s for a full rebuild).
      //   2. Sign all the refreshed deposits in ONE fallback popup
      //      via wallet.signAllTransactions.
      //   3. Submit the refreshed signed txs.
      //
      // Cold-cache thus pays a 2nd popup, but only the first time
      // ZK assets cold-load. Every subsequent run on the same
      // browser hits the warm path and the 1-popup goal stands.
      if (pendingDeposits.size > 0) {
        setRunSubStep("deposit");
        // eslint-disable-next-line no-console
        console.time(
          `[payroll] submit pre-signed deposits (${pendingDeposits.size} txs)`,
        );
        const {
          refreshPayInvoiceCpiTxBlockhash,
          submitSignedPayInvoiceCpiTx,
        } = await import("@/lib/payInvoiceCpi");

        type SubmitOutcome =
          | { ok: true; rowIndex: number; signature: string }
          | { ok: false; rowIndex: number; err: any; needsRefresh: boolean };

        // First pass — try the pre-signed txs.
        const firstPass: SubmitOutcome[] = await Promise.all(
          [...pendingDeposits.entries()].map(
            async ([rowIndex, info]): Promise<SubmitOutcome> => {
              const prefund = prefundedShadows.get(rowIndex);
              if (!prefund?.signedDeposit) {
                return {
                  ok: false,
                  rowIndex,
                  err: new Error(
                    "pre-flight signed-deposit slot was empty",
                  ),
                  needsRefresh: false,
                };
              }
              try {
                const result = await submitSignedPayInvoiceCpiTx({
                  signedTx: prefund.signedDeposit.tx,
                  built: prefund.signedDeposit.built,
                });
                return {
                  ok: true,
                  rowIndex,
                  signature: result.createUtxoSignature,
                };
              } catch (err: any) {
                // Detect blockhash-expiry → eligible for refresh.
                // The error object's message OR cause's message
                // typically carries "Blockhash not found".
                const msg = String(err?.message ?? err ?? "");
                const causeMsg = String(err?.cause?.message ?? "");
                const needsRefresh =
                  /Blockhash not found|BlockhashNotFound/i.test(msg) ||
                  /Blockhash not found|BlockhashNotFound/i.test(causeMsg);
                return { ok: false, rowIndex, err, needsRefresh };
              }
            },
          ),
        );

        // Settle the happy-path rows immediately.
        for (const r of firstPass) {
          if (r.ok) {
            const info = pendingDeposits.get(r.rowIndex)!;
            slots[r.rowIndex] = {
              ...info.prepared,
              status: "paid",
              mode: "public",
              path: "claim-link",
              txSignature: r.signature,
              error: null,
              claimUrl: info.claimUrl,
              registrationStatus: "unregistered",
            };
          }
        }
        flushSlots();

        // Collect rows that need a blockhash refresh.
        const refreshable = firstPass.filter(
          (r): r is Extract<SubmitOutcome, { ok: false }> =>
            !r.ok && r.needsRefresh,
        );
        const unrecoverable = firstPass.filter(
          (r): r is Extract<SubmitOutcome, { ok: false }> =>
            !r.ok && !r.needsRefresh,
        );

        // Surface unrecoverable failures (not blockhash-related).
        for (const r of unrecoverable) {
          const info = pendingDeposits.get(r.rowIndex)!;
          const detail = await formatTxError(r.err, {
            phase: "deposit",
            connection,
          });
          slots[r.rowIndex] = {
            ...info.prepared,
            status: "failed",
            mode: "public",
            path: "claim-link",
            txSignature: null,
            error: `Claim-link deposit-submit step failed: ${detail.summary}`,
            errorDetail: detail,
            claimUrl: info.claimUrl,
            registrationStatus: "unregistered",
          };
        }
        flushSlots();

        // Cold-cache fallback: refresh blockhashes + re-sign in one popup.
        if (refreshable.length > 0 && wallet.signAllTransactions) {
          // eslint-disable-next-line no-console
          console.time(
            `[payroll] cold-cache refresh signAll (${refreshable.length} txs)`,
          );
          const refreshed = await Promise.all(
            refreshable.map(async (r) => {
              const prefund = prefundedShadows.get(r.rowIndex)!;
              const fresh = await refreshPayInvoiceCpiTxBlockhash(
                prefund.signedDeposit!.built,
              );
              return { rowIndex: r.rowIndex, fresh };
            }),
          );

          let signedFresh: VersionedTransaction[] = [];
          let signError: string | null = null;
          try {
            signedFresh = await wallet.signAllTransactions(
              refreshed.map((r) => r.fresh.tx),
            );
          } catch (err: any) {
            signError = err?.message ?? String(err);
          } finally {
            // eslint-disable-next-line no-console
            console.timeEnd(
              `[payroll] cold-cache refresh signAll (${refreshable.length} txs)`,
            );
          }

          if (signError) {
            // User rejected fallback popup → mark all refresh rows failed.
            for (const r of refreshable) {
              const info = pendingDeposits.get(r.rowIndex)!;
              slots[r.rowIndex] = {
                ...info.prepared,
                status: "failed",
                mode: "public",
                path: "claim-link",
                txSignature: null,
                error: `Claim-link deposit-fallback-sign step failed: ${signError}`,
                errorDetail: {
                  summary: `Claim-link deposit-fallback-sign step failed: ${signError}`,
                  phase: "deposit",
                  rawMessage: signError,
                },
                claimUrl: info.claimUrl,
                registrationStatus: "unregistered",
              };
            }
          } else {
            // Submit the freshly-signed txs in parallel.
            await Promise.all(
              refreshed.map(async (r, idx) => {
                const info = pendingDeposits.get(r.rowIndex)!;
                const signed = signedFresh[idx];
                try {
                  const result = await submitSignedPayInvoiceCpiTx({
                    signedTx: signed,
                    built: r.fresh,
                  });
                  slots[r.rowIndex] = {
                    ...info.prepared,
                    status: "paid",
                    mode: "public",
                    path: "claim-link",
                    txSignature: result.createUtxoSignature,
                    error: null,
                    claimUrl: info.claimUrl,
                    registrationStatus: "unregistered",
                  };
                } catch (err: any) {
                  const detail = await formatTxError(err, {
                    phase: "deposit",
                    connection,
                  });
                  slots[r.rowIndex] = {
                    ...info.prepared,
                    status: "failed",
                    mode: "public",
                    path: "claim-link",
                    txSignature: null,
                    error: `Claim-link deposit-fallback-submit step failed: ${detail.summary}`,
                    errorDetail: detail,
                    claimUrl: info.claimUrl,
                    registrationStatus: "unregistered",
                  };
                }
              }),
            );
          }
          flushSlots();
        }

        // eslint-disable-next-line no-console
        console.timeEnd(
          `[payroll] submit pre-signed deposits (${pendingDeposits.size} txs)`,
        );
      }

      // After all rows settle, build the final ordered list. flushSlots
      // already published the prefix as it filled in; this final write
      // ensures any out-of-order completions are visible.
      const resultRowsFinal: PayrollRunRow[] = slots.filter(
        (s): s is PayrollRunRow => s != null,
      );
      // Replace the in-flight resultRows we previously pushed into; we
      // keep the variable name for the downstream packet-build code.
      resultRows.length = 0;
      resultRows.push(...resultRowsFinal);
      setRows([...resultRows]);
      // Loop done — clear sub-step so the modal flips to "Sign receipt
      // packet" instead of holding the last row's per-step copy.
      setRunSubStep(null);

      // Build packet from completed rows (strip run-only fields).
      const nextPacket: PayrollPacket = {
        version: 1,
        kind: "veil.private-payroll",
        batchId,
        payer: wallet.publicKey.toBase58(),
        mint: USDC_MINT.toBase58(),
        symbol: PAYMENT_SYMBOL,
        decimals: PAYMENT_DECIMALS,
        createdAt: new Date().toISOString(),
        rows: resultRows.map(
          ({ amountDisplay, claimUrl, registrationStatus, ...row }) => row,
        ),
      };
      setPacket(nextPacket);

      // Auto-sign + download the receipt packet as the final step. This
      // bundles signing into the publishing flow so the user gets one
      // continuous gate from "Run" to "Done" instead of needing a
      // separate manual click.
      setPhase("signing");
      try {
        const signed = await signPayrollPacket(nextPacket, wallet as any);
        const blob = encodePayrollPacket(signed);
        const url = `${window.location.origin}/payroll/packet#${blob}`;
        setSignedPacket(signed);
        setPacketUrl(url);
        // Persist locally + upload encrypted to Arweave so the dashboard's
        // "Activity → Payroll runs" tab picks it up on this device AND
        // any other device the wallet logs in from. The localStorage
        // cache is the fast path (renders instantly); Arweave is the
        // source of truth for cross-device sync. See
        // `lib/payroll-runs-storage.ts` for the crypto contract.
        // This call is fire-and-forget against the UI: the run is
        // already shown via the in-memory `signedPacket` state; the
        // upload + cache write happen in the background.
        if (wallet.publicKey) {
          const walletBase58 = wallet.publicKey.toBase58();
          void persistPayrollRun({
            wallet: wallet as any,
            walletBase58,
            signed,
          });
        }
        downloadPayrollPacketJson(signed);

        const claimUrls: Record<number, string> = {};
        resultRows.forEach((r, idx) => {
          if (r.claimUrl) claimUrls[idx] = r.claimUrl;
        });
        const hasClaimUrls = Object.keys(claimUrls).length > 0;
        if (hasClaimUrls) {
          const [{ pdf }, { PayrollPacketPdfDocument }] = await Promise.all([
            import("@react-pdf/renderer"),
            import("@/lib/payrollPacketPdf"),
          ]);
          const pdfBlob = await pdf(
            PayrollPacketPdfDocument({ signed, claimUrls }),
          ).toBlob();
          const pdfUrl = URL.createObjectURL(pdfBlob);
          const a = document.createElement("a");
          a.href = pdfUrl;
          a.download = `${signed.packet.batchId}-veil-payroll-packet.pdf`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(pdfUrl);
        } else {
          await downloadPayrollPacketPdf(signed);
        }
      } catch (err: any) {
        setError(`Packet signing failed: ${err.message ?? String(err)}`);
      }
    } catch (err: any) {
      setRegOpen(false);
      setError(err.message ?? String(err));
    } finally {
      setRunning(false);
      setPhase("idle");
      setRunSubStep(null);
      setRunRowIndex(0);
    }
  }

  async function sendViaClaimLink(args: {
    prepared: PayrollRunRow;
    payerClient: any;
    payerWallet: any;
    connection: any;
    companyName: string;
    batchId: string;
    rowIndex: number;
    /** Pre-funded ephemeral keypair, if the run() coordinator already
     *  funded this shadow via a batched signAllTransactions popup.
     *  When set, we skip the per-row fund step entirely. */
    prefundedEphemeral?: EphemeralKeypair;
    /** If true, return without doing the deposit step. The coordinator
     *  is going to batch all deposit txs across rows into one
     *  `wallet.signAllTransactions` popup after every row's register
     *  has completed. */
    deferDeposit?: boolean;
  }): Promise<{
    claimUrl: string;
    depositSignature: string;
    shadowAddress: string;
    /** True when the call returned early (deferDeposit) and the
     *  caller still needs to run the batched deposit phase. */
    deferred?: boolean;
  }> {
    const ephemeral = args.prefundedEphemeral ?? generateEphemeralKeypair();
    const isPrefunded = !!args.prefundedEphemeral;

    // Each step gets its own try/catch so the thrown error carries
    // a `phase` tag we can surface in the row UI. Without this,
    // every claim-link failure shows up as "Transaction simulation
    // failed" with no hint at WHICH step (fund / register / deposit)
    // tripped — and they hit different programs with different
    // failure modes (system program, Umbra registration, Umbra
    // deposit).
    //
    // Each step also flips `runSubStep` so the publishing modal can
    // (a) tell the user what's actually running and (b) drive
    // `awaitingWallet` correctly: TRUE only when a Phantom popup is
    // genuinely open. ZK proof generation in `registerShadowAccount`
    // takes 30–90s with no popup, and the prior UI was lying with
    // "Waiting on wallet" through the whole stretch.
    //
    // `console.time/timeEnd` markers around each step give us hard
    // wall-clock data in DevTools — useful when triaging "it's slow"
    // reports (e.g. is ZK eating 90s, or is the deposit Arcium-side
    // computation eating 60s?).
    const tag = (label: string) => `[payroll row ${args.rowIndex + 1}] ${label}`;

    if (isPrefunded) {
      // Coordinator already funded this shadow via the batched
      // signAllTransactions pre-flight popup. Skip the per-row fund
      // step entirely — going through fundShadowAccount here would
      // fire ANOTHER popup and undo the batching win.
      // eslint-disable-next-line no-console
      console.log(tag("fund — prefunded by coordinator, skipped"));
    } else {
      setRunSubStep("fund");
      // eslint-disable-next-line no-console
      console.time(tag("fund"));
      try {
        await fundShadowAccount({
          payerWallet: args.payerWallet,
          shadowAddress: ephemeral.address,
          lamports: SHADOW_FUNDING_LAMPORTS,
          connection: args.connection,
        });
      } catch (err: any) {
        err.__veilPhase = "fund";
        throw err;
      } finally {
        // eslint-disable-next-line no-console
        console.timeEnd(tag("fund"));
      }
    }

    const shadowClient = await buildShadowClient(ephemeral.privateKey);

    setRunSubStep("register");
    // eslint-disable-next-line no-console
    console.time(tag("register (ZK proof + 3 txs)"));
    try {
      await registerShadowAccount({ shadowClient });
    } catch (err: any) {
      err.__veilPhase = "register";
      throw err;
    } finally {
      // eslint-disable-next-line no-console
      console.timeEnd(tag("register (ZK proof + 3 txs)"));
    }

    // If the coordinator wants to batch deposits across rows in a
    // single signAllTransactions popup, it'll set deferDeposit=true.
    // We return WITHOUT firing the per-row deposit; the caller
    // collects the ready-for-deposit info and runs the batched
    // deposit phase after all rows have completed register.
    if (args.deferDeposit) {
      const claimUrl = generateClaimUrl({
        baseUrl: typeof window !== "undefined" ? window.location.origin : "",
        batchId: args.batchId,
        row: args.rowIndex,
        ephemeralPrivateKey: ephemeral.privateKey,
        metadata: {
          amount: args.prepared.amountDisplay.replace(` ${PAYMENT_SYMBOL}`, ""),
          symbol: PAYMENT_SYMBOL,
          sender: args.companyName || args.payerWallet.publicKey.toBase58(),
          mint: USDC_MINT.toBase58(),
          amountBaseUnits: args.prepared.amount,
        },
      });
      return {
        claimUrl,
        // Caller fills this in after the batched deposit phase.
        depositSignature: "",
        shadowAddress: ephemeral.address,
        deferred: true,
      };
    }

    setRunSubStep("deposit");
    // eslint-disable-next-line no-console
    console.time(tag("deposit"));
    let deposit: { depositSignature: string };
    try {
      deposit = await depositToShadow({
        payerClient: args.payerClient,
        shadowAddress: ephemeral.address,
        mint: USDC_MINT.toBase58(),
        amount: BigInt(args.prepared.amount),
      });
    } catch (err: any) {
      err.__veilPhase = "deposit";
      throw err;
    } finally {
      // eslint-disable-next-line no-console
      console.timeEnd(tag("deposit"));
    }
    const claimUrl = generateClaimUrl({
      baseUrl: typeof window !== "undefined" ? window.location.origin : "",
      batchId: args.batchId,
      row: args.rowIndex,
      ephemeralPrivateKey: ephemeral.privateKey,
      metadata: {
        amount: args.prepared.amountDisplay.replace(` ${PAYMENT_SYMBOL}`, ""),
        symbol: PAYMENT_SYMBOL,
        sender: args.companyName || args.payerWallet.publicKey.toBase58(),
        mint: USDC_MINT.toBase58(),
        amountBaseUnits: args.prepared.amount,
      },
    });
    return {
      claimUrl,
      depositSignature: deposit.depositSignature,
      shadowAddress: ephemeral.address,
    };
  }

  function prepareRow(row: PayrollRow, index: number): PayrollRunRow {
    let recipient: PublicKey;
    try {
      recipient = new PublicKey(row.wallet);
    } catch {
      throw new Error(`Row ${index + 1}: invalid recipient wallet`);
    }
    const amount = parseAmountToBaseUnits(row.amount, PAYMENT_DECIMALS);
    if (amount == null || amount <= 0n) {
      throw new Error(`Row ${index + 1}: invalid amount`);
    }
    return {
      recipient: recipient.toBase58(),
      amount: amount.toString(),
      amountDisplay: `${formatPayrollAmount(amount, PAYMENT_DECIMALS)} ${PAYMENT_SYMBOL}`,
      memo: row.memo,
      status: "paid",
      mode: "public",
      txSignature: null,
      error: null,
    };
  }

  async function copyPacketUrl() {
    if (!packetUrl) return;
    try {
      await navigator.clipboard.writeText(packetUrl);
    } catch {
      // jsdom / non-secure contexts. Visual feedback still flips.
    }
    setPacketCopied(true);
    setTimeout(() => setPacketCopied(false), 2200);
  }

  async function copyText(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignore
    }
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1800);
  }

  function downloadClaimLinksCsv() {
    const claimRows: ClaimLinkRow[] = rows.map((row) => ({
      recipient: row.recipient,
      amount: row.amountDisplay,
      status: row.error ? "failed" : row.claimUrl ? "claim-link" : "direct",
      claimUrl: row.claimUrl,
      error: row.error ?? undefined,
    }));
    const csv = rowsToClaimLinkCsv(claimRows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "veil-payroll-claim-links.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /* ─────────────────────────────── render ─────────────────────────────── */

  if (!wallet.connected) {
    return (
      <div className="max-w-2xl">
        <div className="payroll-flow-reveal">
          <span className="eyebrow">Private payroll</span>
          <h2 className="mt-3 font-sans font-medium text-ink text-[40px] md:text-[52px] leading-[1.04] tracking-[-0.025em]">
            Connect to run payroll.
          </h2>
          <p className="mt-6 text-[17px] md:text-[19px] text-ink/80 leading-[1.5]">
            This mode sends private Umbra payments to contractors. It does not
            create invoice PDAs.
          </p>
          <div className="mt-8">
            <ClientWalletMultiButton />
          </div>
        </div>
        <PayrollFlowStyles />
      </div>
    );
  }

  return (
    // Centre the column on success — the SuccessHero block is
    // text-center'd internally, so when the parent column is
    // left-aligned the centred icon + headline sit visually offset
    // from the left-aligned run ledger below them. `mx-auto` on
    // success state keeps the whole column visually balanced. Compose
    // mode keeps left-alignment because the editorial-form pattern
    // wants a stable left edge as the user types.
    <div className={`max-w-3xl pb-32${inSuccessState ? " mx-auto" : ""}`}>
      {/* Hero — display-size company name input */}
      {!inSuccessState && (
        <form
          id="payroll-form"
          onSubmit={(e) => {
            e.preventDefault();
            handleSubmit();
          }}
          className={running ? "canvas-page-fade pointer-events-none" : ""}
        >
          <div>
            <label className="eyebrow block mb-2" htmlFor="payroll-company">
              Company / payer
            </label>
            <input
              id="payroll-company"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              className="canvas-display-input"
              placeholder="Acme Payroll Ops"
              required
              disabled={running}
              aria-label="Company / payer"
            />
          </div>

          {/* Recipients — editable row table. Sablier-inspired structure
              in the Mercury editorial register: borderless rows, hairline
              separators, inline wallet validation chips. Three input
              paths: type a row, paste multi-line text from Sheets into
              any wallet field (explodes into N rows in place), or drop
              a CSV file on the table / click 'Import CSV'. */}
          <div className="mt-14">
            <div className="flex items-baseline justify-between gap-4 flex-wrap">
              <span className="eyebrow">Recipients</span>
              <div className="flex items-baseline gap-3 text-[12px]">
                <span className="text-dim tabular-nums">
                  {parsed.rows.length} row{parsed.rows.length === 1 ? "" : "s"} ·{" "}
                  {totalDisplay}
                </span>
                {parsed.errors.length > 0 && (
                  <span className="text-brick">
                    {parsed.errors.length} error
                    {parsed.errors.length === 1 ? "" : "s"}
                  </span>
                )}
              </div>
            </div>
            <div className="mt-5 border-t border-line relative">
              {recipients.map((row, idx) => (
                <RecipientEditorRow
                  key={idx}
                  row={row}
                  idx={idx}
                  canRemove={recipients.length > 1 || !!row.wallet || !!row.amount || !!row.memo}
                  disabled={running}
                  onChange={(field, value) => updateRecipient(idx, field, value)}
                  onRemove={() => removeRecipient(idx)}
                  onPasteMulti={(parsedRows) => explodeAt(idx, parsedRows)}
                />
              ))}
            </div>
            <div className="mt-4 flex items-center justify-between gap-4 flex-wrap text-[13px]">
              <button
                type="button"
                onClick={addRecipient}
                disabled={running}
                className="text-muted hover:text-ink transition-colors"
              >
                + Add row
              </button>
              <div className="flex items-center gap-3 text-[12px] text-muted">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={running}
                  className="hover:text-ink transition-colors"
                >
                  Import CSV
                </button>
                <span className="text-line-2">·</span>
                <button
                  type="button"
                  onClick={loadSample}
                  disabled={running}
                  className="hover:text-ink transition-colors"
                >
                  Load sample
                </button>
              </div>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.tsv,.txt"
              onChange={handleFileChange}
              className="hidden"
              aria-label="Import payroll CSV"
            />
          </div>

          {/* Optional chips: override funding / registration check */}
          <div className="mt-10 flex flex-wrap gap-2.5">
            <button
              type="button"
              onClick={() => setOpenChip(openChip === "funding" ? null : "funding")}
              disabled={running}
              className={`canvas-chip ${mode === "auto" ? "canvas-chip-empty" : ""}`}
              aria-expanded={openChip === "funding"}
            >
              {mode === "auto"
                ? "+ Override funding"
                : `Funding: ${mode === "shielded" ? "Private balance" : "Wallet"}`}
            </button>

            <button
              type="button"
              onClick={() => {
                setOpenChip(openChip === "registration" ? null : "registration");
                if (!detection && !detecting) handleDetectRegistration();
              }}
              disabled={running || rowCount === 0}
              className={`canvas-chip ${detection ? "" : "canvas-chip-empty"}`}
              aria-expanded={openChip === "registration"}
            >
              {detecting
                ? "Checking registration…"
                : detection
                  ? detection.unregisteredIndexes.length > 0
                    ? `Checked: ${detection.unregisteredIndexes.length} need claim link${detection.unregisteredIndexes.length === 1 ? "" : "s"}`
                    : "Checked: all registered"
                  : "+ Check recipient registration"}
            </button>
          </div>

          {/* Inline expansions */}
          {openChip === "funding" && (
            <FundingExpander mode={mode} onChange={setMode} />
          )}
          {openChip === "registration" && detection && (
            <div className="mt-5">
              <RegistrationSummary detection={detection} rows={parsed.rows} />
            </div>
          )}

          {error && (
            <div className="mt-8 flex items-start gap-4 border-l-2 border-brick pl-4 py-2">
              <span className="mono-chip text-brick shrink-0 pt-0.5">Error</span>
              <span className="text-[13.5px] text-ink leading-relaxed">{error}</span>
            </div>
          )}
          {notice && (
            <div className="mt-8 flex items-start gap-4 border-l-2 border-sage pl-4 py-2">
              <span className="mono-chip text-sage shrink-0 pt-0.5">Note</span>
              <span className="text-[13.5px] text-ink leading-relaxed">{notice}</span>
            </div>
          )}
        </form>
      )}

      {/* Success layout — replaces the form when packet is ready. Pairs
          with the run ledger + collapsible explainer below. Counts and
          totals reflect only SETTLED payments (status === 'paid');
          failures are surfaced separately so the hero doesn't lie. */}
      {inSuccessState && (() => {
        const settled = rows.filter((r) => r.status === "paid");
        const failed = rows.filter((r) => r.status === "failed");
        const settledTotalMicros = settled.reduce(
          (sum, r) => sum + BigInt(r.amount),
          0n,
        );
        const settledTotalDisplay = `${formatPayrollAmount(
          settledTotalMicros,
          PAYMENT_DECIMALS,
        )} ${PAYMENT_SYMBOL}`;
        // Phase C — count rows by sender-side delivery path. Only
        // counts settled rows so a failed direct/claim-link attempt
        // doesn't inflate the breakdown. Older rows missing `path`
        // (legacy in-memory state from a previous build) fall back
        // to the claim-URL heuristic.
        const directCount = settled.filter(
          (r) => r.path === "direct-registered",
        ).length;
        const claimLinkCount = settled.filter(
          (r) => r.path === "claim-link" || (!r.path && !!r.claimUrl),
        ).length;
        return (
          <SuccessHero
            settledCount={settled.length}
            failedCount={failed.length}
            totalCount={rows.length}
            settledTotalDisplay={settledTotalDisplay}
            directCount={directCount}
            claimLinkCount={claimLinkCount}
          />
        );
      })()}

      {/* Inline run ledger — always mounted (compose: empty placeholder
          rows; running: fills as txs settle; success: full receipt). */}
      <RunLedger
        rows={rows}
        plannedRows={parsed.rows}
        signedPacket={signedPacket}
        copiedKey={copiedKey}
        onCopy={copyText}
      />

      {/* Collapsible "Why is this private?" — explorer comparison
          tucked away for compose-mode skeptics + judges. Hidden on
          success because by then the user has the signed packet
          itself (the proof of privacy) and the surface is already
          long enough with the run ledger; an explainer disclosure
          below it just pads the page without adding value the
          packet's existence doesn't already convey. */}
      {!inSuccessState && (
        <details className="mt-12 group">
          <summary className="cursor-pointer text-[13px] text-muted hover:text-ink transition-colors inline-flex items-center gap-2 list-none">
            <span className="canvas-disclosure-arrow">›</span>
            Why is this private?
          </summary>
          <div className="mt-5">
            <ExplorerComparison />
          </div>
        </details>
      )}

      <RegistrationModal open={regOpen} steps={regSteps} />
      <PayrollPublishingModal
        open={running}
        totalCount={runTotalCount || rowCount}
        sentCount={rows.length}
        phase={phase === "signing" ? "signing" : "sending"}
        subStep={runSubStep}
        rowIndex={runRowIndex}
        // Pass `true` so the modal can decide per-step whether to show
        // "Waiting on wallet" — internally it suppresses that line
        // during the ZK proof step where no popup is genuinely open.
        awaitingWallet
      />
      <CanvasBar state={canvasBarState} formId="payroll-form" />
      <DropOverlay active={dragActive && !running} />

      <PayrollFlowStyles />
    </div>
  );
}

/**
 * Full-viewport translucent overlay shown when a file is dragged anywhere
 * on the page. Portal'd to document.body so an ancestor with a transform
 * (e.g. CreatePageInner's .form-reveal section) can't constrain its
 * position:fixed to a sub-region of the viewport.
 *
 * pointer-events:none lets drop events pass through to the window-level
 * listener — this is purely a visual affordance, not the drop target.
 */
function DropOverlay({ active }: { active: boolean }) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  useEffect(() => setContainer(document.body), []);

  if (!container || !active) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none"
      style={{
        background: "rgba(241, 236, 224, 0.78)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
      }}
      aria-hidden
    >
      <div className="border-2 border-dashed border-ink/35 rounded-[6px] px-12 py-10 bg-paper-3/85 max-w-md text-center">
        <span className="eyebrow text-ink">Drop CSV to import</span>
        <p className="mt-3 text-[13.5px] text-muted leading-relaxed">
          wallet, amount, memo
          <br />
          <span className="font-mono text-[11px] text-dim">
            (one row per line · CSV or TSV)
          </span>
        </p>
      </div>
    </div>,
    container,
  );
}

/* ─────────────────────────── sub-components ─────────────────────────── */

/**
 * One editable row in the recipients table. Three transparent inputs
 * (wallet / amount / memo) + a delete button + a wallet-validity dot.
 *
 * The wallet input intercepts multi-line paste events: when the user
 * pastes from a spreadsheet (CSV or TSV with N rows), the row table
 * explodes into N rows in place via `onPasteMulti`. Single-line pastes
 * fall through to default browser behavior.
 */
function RecipientEditorRow({
  row,
  idx,
  canRemove,
  disabled,
  onChange,
  onRemove,
  onPasteMulti,
}: {
  row: RecipientRow;
  idx: number;
  canRemove: boolean;
  disabled: boolean;
  onChange: (field: keyof RecipientRow, value: string) => void;
  onRemove: () => void;
  onPasteMulti: (rows: RecipientRow[]) => void;
}) {
  const isValidWallet = useMemo<null | boolean>(() => {
    const trimmed = row.wallet.trim();
    if (!trimmed) return null;
    try {
      new PublicKey(trimmed);
      return true;
    } catch {
      return false;
    }
  }, [row.wallet]);

  const isValidAmount = useMemo<null | boolean>(() => {
    const trimmed = row.amount.trim();
    if (!trimmed) return null;
    return parseAmountToBaseUnits(trimmed, PAYMENT_DECIMALS) !== null;
  }, [row.amount]);

  function handleWalletPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text");
    if (!text.includes("\n")) return; // single-line, normal browser paste
    e.preventDefault();
    const parsed = parsePastedRecipients(text);
    if (parsed.length > 0) onPasteMulti(parsed);
  }

  return (
    <div className="grid md:grid-cols-[1.5rem_1.4fr_7rem_1fr_1.5rem] gap-4 py-2.5 border-b border-line/40 items-baseline">
      <span className="font-mono text-[11px] text-dim tnum md:pt-2">
        {String(idx + 1).padStart(2, "0")}
      </span>
      <div className="flex items-baseline gap-2 min-w-0">
        <input
          value={row.wallet}
          onChange={(e) => onChange("wallet", e.target.value)}
          onPaste={handleWalletPaste}
          placeholder="Solana wallet address"
          className="recipient-input font-mono text-[13px] flex-1 min-w-0"
          disabled={disabled}
          aria-label={`Wallet for row ${idx + 1}`}
          spellCheck={false}
          autoComplete="off"
        />
        {isValidWallet === true && (
          <span className="recipient-dot bg-sage" aria-label="Valid wallet" />
        )}
        {isValidWallet === false && (
          <span className="recipient-dot bg-brick" aria-label="Invalid wallet" />
        )}
      </div>
      <input
        value={row.amount}
        onChange={(e) => onChange("amount", e.target.value)}
        placeholder="0.00"
        inputMode="decimal"
        className={`recipient-input text-right font-mono tabular-nums text-[13px] ${
          isValidAmount === false ? "text-brick" : ""
        }`}
        disabled={disabled}
        aria-label={`Amount for row ${idx + 1}`}
        spellCheck={false}
        autoComplete="off"
      />
      <input
        value={row.memo}
        onChange={(e) => onChange("memo", e.target.value)}
        placeholder="Optional"
        className="recipient-input text-[13px] text-ink/85"
        disabled={disabled}
        aria-label={`Memo for row ${idx + 1}`}
        spellCheck={false}
      />
      {canRemove && !disabled ? (
        <button
          type="button"
          onClick={onRemove}
          className="text-dim hover:text-brick transition-colors text-[18px] leading-none md:pt-0.5"
          aria-label={`Remove row ${idx + 1}`}
        >
          ×
        </button>
      ) : (
        <span aria-hidden />
      )}
    </div>
  );
}

function FundingExpander({
  mode,
  onChange,
}: {
  mode: RunMode;
  onChange: (next: RunMode) => void;
}) {
  return (
    <div className="mt-5 max-w-xl">
      <div className="flex flex-wrap gap-2">
        {(
          [
            { key: "auto" as const, label: "Smart" },
            { key: "shielded" as const, label: "Private balance" },
            { key: "public" as const, label: "Wallet" },
          ]
        ).map((opt) => (
          <button
            key={opt.key}
            type="button"
            onClick={() => onChange(opt.key)}
            className={`px-3.5 py-2 rounded-full border text-[12.5px] transition-colors ${
              mode === opt.key
                ? "border-ink bg-ink text-paper"
                : "border-line bg-paper text-muted hover:text-ink hover:border-line-2"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <p className="mt-3 text-[13px] text-muted leading-relaxed">
        {mode === "auto" &&
          "Pulls from your encrypted Umbra balance when there's enough; falls back to your wallet otherwise. Recommended for most batches."}
        {mode === "shielded" &&
          "Spends only your encrypted Umbra balance. No public deposit appears on-chain."}
        {mode === "public" &&
          "Pulls from your public ATA at run time. Each payment's recipient leg is still private."}
      </p>
    </div>
  );
}

function RunLedger({
  rows,
  plannedRows,
  signedPacket,
  copiedKey,
  onCopy,
}: {
  rows: PayrollRunRow[];
  plannedRows: PayrollRow[];
  signedPacket: SignedPayrollPacket | null;
  copiedKey: string | null;
  onCopy: (key: string, text: string) => void;
}) {
  // While the run hasn't started, render plannedRows as quiet
  // placeholders. Once rows.length > 0, render real result rows; for
  // any remaining planned-but-not-yet-run rows, keep the placeholder.
  const hasResults = rows.length > 0;
  const pendingPlaceholders = hasResults
    ? plannedRows.slice(rows.length)
    : plannedRows;

  if (plannedRows.length === 0 && !hasResults) return null;

  return (
    <div className="mt-14">
      <span className="eyebrow">Run ledger</span>
      <ul className="mt-4 divide-y divide-line/60">
        {rows.map((row, idx) => (
          <ResultRow
            key={`${row.recipient}-${idx}`}
            row={row}
            idx={idx}
            signedPacket={signedPacket}
            copiedKey={copiedKey}
            onCopy={onCopy}
          />
        ))}
        {pendingPlaceholders.map((row, idx) => (
          <PlaceholderRow
            key={`p-${idx}`}
            row={row}
            idx={hasResults ? rows.length + idx : idx}
          />
        ))}
      </ul>
    </div>
  );
}

function ResultRow({
  row,
  idx,
  signedPacket,
  copiedKey,
  onCopy,
}: {
  row: PayrollRunRow;
  idx: number;
  signedPacket: SignedPayrollPacket | null;
  copiedKey: string | null;
  onCopy: (key: string, text: string) => void;
}) {
  const disclosureUrl =
    signedPacket && typeof window !== "undefined"
      ? `${window.location.origin}/disclose/payroll#${encodePayrollDisclosure(
          buildPayrollDisclosure(signedPacket, idx),
        )}`
      : null;

  // Phase C: branch the path-chip + bottom-note rendering on the
  // sender-side delivery path. Direct-registered rows skipped the
  // entire shadow setup and target the recipient's on-chain x25519
  // key — they get a "direct" chip and a sage note explaining that
  // the recipient will see the payment in their dashboard's
  // pending-claims section (no claim URL was issued).
  const isDirectRegistered = row.path === "direct-registered";
  const isClaimLink = row.path === "claim-link" || (!row.path && !!row.claimUrl);

  return (
    <li className="py-4 payroll-row-reveal">
      <div className="grid grid-cols-[1.5rem_1fr_auto] gap-4 items-baseline">
        <span className="font-mono text-[11px] text-dim tnum">
          {String(idx + 1).padStart(2, "0")}
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-mono text-[13px] text-ink truncate">
              {row.recipient.slice(0, 8)}…{row.recipient.slice(-5)}
            </span>
            <span className="text-[13px] text-ink/80 tnum">{row.amountDisplay}</span>
            <span className="mono-chip text-dim">{row.mode}</span>
            {isDirectRegistered && (
              <span className="mono-chip text-sage">direct</span>
            )}
            {isClaimLink && (
              <span className="mono-chip text-sage">claim-link</span>
            )}
          </div>
          <div className="mt-1 text-[12.5px] text-muted truncate">
            {row.memo || "No memo"}
          </div>
          {isDirectRegistered && row.status === "paid" && (
            <div className="mt-1 text-[12px] text-sage/80">
              Sent directly to recipient&apos;s private balance.
            </div>
          )}
          {row.error && (
            <RowErrorChip error={row.error} detail={row.errorDetail} />
          )}
        </div>
        <StatusBadge status={row.status} />
      </div>
      {(row.txSignature || disclosureUrl || row.claimUrl) && (
        <div className="mt-3 flex flex-wrap gap-4 pl-10">
          {row.txSignature && (
            <a
              href={payrollExplorerTxUrl(row.txSignature, NETWORK)}
              target="_blank"
              rel="noreferrer"
              className="text-[12px] text-muted hover:text-ink transition-colors"
            >
              Explorer ↗
            </a>
          )}
          {disclosureUrl && (
            <button
              type="button"
              onClick={() => onCopy(`disclosure-${idx}`, disclosureUrl)}
              className="text-[12px] text-muted hover:text-ink transition-colors"
            >
              {copiedKey === `disclosure-${idx}` ? "Copied disclosure" : "Copy disclosure"}
            </button>
          )}
          {row.claimUrl && (
            <button
              type="button"
              onClick={() => onCopy(`claim-${idx}`, row.claimUrl!)}
              className="text-[12px] text-muted hover:text-ink transition-colors"
            >
              {copiedKey === `claim-${idx}` ? "Copied claim URL" : "Copy claim URL"}
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function PlaceholderRow({ row, idx }: { row: PayrollRow; idx: number }) {
  return (
    <li className="py-4">
      <div className="grid grid-cols-[1.5rem_1fr_auto] gap-4 items-baseline">
        <span className="font-mono text-[11px] text-dim tnum">
          {String(idx + 1).padStart(2, "0")}
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-mono text-[13px] text-ink/75 truncate">
              {row.wallet.slice(0, 8)}…{row.wallet.slice(-5)}
            </span>
            <span className="text-[13px] text-muted tnum">{row.amount}</span>
          </div>
          <div className="mt-1 text-[12.5px] text-muted truncate">
            {row.memo || "No memo"}
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] text-muted tracking-[0.14em] uppercase">
          <span className="inline-block w-1.5 h-1.5 rounded-full border border-line-2 bg-paper" />
          Pending
        </span>
      </div>
    </li>
  );
}

/**
 * RowErrorChip — failed-row error display with optional collapsible
 * details. The chip itself shows the summary (single-line, brick); a
 * "Show details" toggle reveals the full message + program logs in a
 * mono pre-block underneath. Logs are also written to console.error
 * by formatTxError so devtools-savvy users have the full object.
 *
 * Phase pill (when known) sits inline before the summary so the user
 * can see at a glance whether it was the SOL transfer, Umbra
 * registration, or the deposit that tripped — three different
 * remediation paths.
 */
function RowErrorChip({
  error,
  detail,
}: {
  error: string;
  detail?: SdkErrorDetail;
}) {
  const [open, setOpen] = useState(false);
  const hasLogs = !!(detail?.logs && detail.logs.length > 0);
  const hasMore = hasLogs || (detail?.rawMessage && detail.rawMessage !== error);

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-baseline gap-2 text-[12px] text-brick leading-relaxed">
        {detail?.phase && (
          <span className="font-mono text-[9.5px] tracking-[0.16em] uppercase px-1.5 py-0.5 border border-brick/40 rounded-[2px] text-brick/90 bg-brick/5">
            {detail.phase}
          </span>
        )}
        <span className="whitespace-pre-wrap break-words">{error}</span>
      </div>
      {hasMore && (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="mt-1.5 font-mono text-[10px] tracking-[0.16em] uppercase text-ink/55 hover:text-ink transition-colors inline-flex items-center gap-1.5"
          >
            <span>{open ? "Hide details" : "Show details"}</span>
            <span aria-hidden className={`transition-transform duration-150 ${open ? "rotate-180" : ""}`}>↓</span>
          </button>
          {open && (
            <pre className="mt-2 max-h-[260px] overflow-auto whitespace-pre-wrap break-words border border-line bg-paper-2/60 rounded-[3px] p-3 font-mono text-[11px] text-ink leading-[1.55]">
              {detail?.rawMessage && (
                <div className="text-muted mb-2">{detail.rawMessage}</div>
              )}
              {hasLogs && detail!.logs!.join("\n")}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: PayrollPacketRow["status"] }) {
  if (status === "paid") {
    return (
      <span className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-sage">
        Sent
      </span>
    );
  }
  return (
    <span className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-brick">
      Failed
    </span>
  );
}

function SuccessHero({
  settledCount,
  failedCount,
  totalCount,
  settledTotalDisplay,
  directCount,
  claimLinkCount,
}: {
  settledCount: number;
  failedCount: number;
  totalCount: number;
  settledTotalDisplay: string;
  /** Phase C — settled rows that took the direct-registered path. */
  directCount: number;
  /** Phase C — settled rows that took the shadow / claim-link path. */
  claimLinkCount: number;
}) {
  // "Partial" mode: at least one row settled but at least one failed.
  // Eyebrow shifts to gold (warn, not error) and the body explicitly
  // says "X of N settled" so the user can't misread the success state
  // as "everything went through."
  const partial = failedCount > 0 && settledCount > 0;
  const allFailed = settledCount === 0 && failedCount > 0;
  // Phase C breakdown line — only meaningful when at least one settled
  // row took the direct path (= recipient was already an Umbra user
  // and the sender skipped the shadow-funding hop). Surfaces the
  // privacy benefit: "X rows direct, Y rows via claim-link".
  const showPathBreakdown = directCount > 0 && settledCount > 0;

  return (
    <div className="flex flex-col items-center justify-center text-center pt-4 md:pt-6 pb-8">
      <VeilDescentMark size={144} variant="batch" />
      <div
        className={`mt-8 eyebrow ${
          allFailed ? "text-brick" : partial ? "text-gold" : "text-sage"
        }`}
      >
        {allFailed
          ? "Payroll signed · all payments failed"
          : partial
            ? `Payroll signed · ${settledCount} of ${totalCount} settled`
            : "✓ Payroll signed · packet ready"}
      </div>
      <div className="mt-3 font-sans font-medium text-ink text-[28px] md:text-[32px] leading-[1.1] tracking-[-0.025em]">
        <span className="tnum">{settledCount}</span>
        <span className="text-muted">
          {" "}
          payment{settledCount === 1 ? "" : "s"} settled ·{" "}
        </span>
        <span className="tnum">{settledTotalDisplay}</span>
      </div>
      {showPathBreakdown && (
        <p className="mt-3 text-[13px] text-muted tnum">
          <span className="text-sage">{directCount}</span>{" "}
          row{directCount === 1 ? "" : "s"} direct ·{" "}
          <span className="text-ink/80">{claimLinkCount}</span>{" "}
          row{claimLinkCount === 1 ? "" : "s"} via claim-link
        </p>
      )}
      {failedCount > 0 && (
        <p className="mt-3 text-[13.5px] text-brick">
          {failedCount} payment{failedCount === 1 ? "" : "s"} failed — see the
          run ledger below for per-row error details.
        </p>
      )}
      <p className="mt-4 text-[14px] leading-[1.55] text-muted max-w-[480px]">
        {allFailed
          ? "The packet still records every attempt with its error reason. Failed rows can be retried independently."
          : "Each settled contractor was paid through Umbra. The packet verifies the whole batch; per-row disclosure links reveal exactly one entry."}
      </p>
    </div>
  );
}

function ExplorerComparison() {
  return (
    <div>
      <div className="grid md:grid-cols-2 gap-4">
        <div className="border border-brick/30 bg-brick/5 rounded-[3px] p-4">
          <span className="mono-chip text-brick">Normal token payroll</span>
          <dl className="mt-4 space-y-3 text-[12.5px]">
            <Row label="Sender" value="Employer wallet" />
            <Row label="Receiver" value="Contractor wallet" />
            <Row label="Amount" value={`Visible ${PAYMENT_SYMBOL}`} />
          </dl>
        </div>
        <div className="border border-sage/35 bg-sage/5 rounded-[3px] p-4">
          <span className="mono-chip text-sage">Veil payroll via Umbra</span>
          <dl className="mt-4 space-y-3 text-[12.5px]">
            <Row label="Sender" value="Umbra operation" />
            <Row label="Receiver" value="Claimable UTXO" />
            <Row label="Amount" value="Not disclosed" />
          </dl>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-dim font-mono uppercase tracking-[0.12em] text-[10px]">
        {label}
      </dt>
      <dd className="text-ink font-mono truncate">{value}</dd>
    </div>
  );
}

function RegistrationSummary({
  detection,
  rows,
}: {
  detection: RegistrationDetectionResult;
  rows: PayrollRow[];
}) {
  const unregisteredCount = detection.unregisteredIndexes.length;
  const unknownCount = detection.unknownIndexes.length;
  const registeredCount = detection.rowStatuses.filter((s) => s === "registered").length;
  const extraSolPerRow = Number(SHADOW_FUNDING_LAMPORTS) / 1e9;
  const totalExtraSol = (extraSolPerRow * unregisteredCount).toFixed(3);

  return (
    <div>
      <div className="flex flex-wrap gap-3 mb-4 text-[12.5px]">
        <SummaryStat label="Ready" count={registeredCount} tone="sage" />
        <SummaryStat label="Need claim link" count={unregisteredCount} tone="gold" />
        {unknownCount > 0 && (
          <SummaryStat label="Unknown" count={unknownCount} tone="dim" />
        )}
      </div>
      {unregisteredCount > 0 && (
        <p className="text-[12.5px] text-ink/70 leading-relaxed mb-3">
          {unregisteredCount} recipient{unregisteredCount === 1 ? "" : "s"} will
          get a claim link. Each adds about{" "}
          <span className="font-mono">{extraSolPerRow.toFixed(3)} SOL</span>{" "}
          for the shadow account&apos;s rent + tx fees{" "}
          (<span className="font-mono">~{totalExtraSol} SOL</span> total).
        </p>
      )}
      <ul className="divide-y divide-line/60 text-[12.5px]">
        {rows.map((row, idx) => {
          const status = detection.rowStatuses[idx];
          return (
            <li
              key={`${row.wallet}-${idx}`}
              className="py-2 flex items-baseline justify-between gap-3"
            >
              <span className="font-mono text-ink truncate">
                {row.wallet.slice(0, 6)}…{row.wallet.slice(-4)}
              </span>
              <span className="text-dim">{row.amount}</span>
              <RegistrationChip status={status} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SummaryStat({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: "sage" | "gold" | "dim";
}) {
  const cls =
    tone === "sage"
      ? "text-sage"
      : tone === "gold"
        ? "text-gold-dim"
        : "text-dim";
  return (
    <div className="inline-flex items-baseline gap-2">
      <span className={`font-sans font-medium text-[16px] tnum ${cls}`}>{count}</span>
      <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
        {label}
      </span>
    </div>
  );
}

function RegistrationChip({ status }: { status: RegistrationStatus }) {
  if (status === "registered") {
    return <span className="mono-chip text-sage">ready</span>;
  }
  if (status === "unregistered") {
    return <span className="mono-chip text-gold-dim">claim link</span>;
  }
  return <span className="mono-chip text-dim">unknown</span>;
}

function PayrollFlowStyles() {
  return (
    <style>{`
      .payroll-flow-reveal {
        opacity: 0;
        transform: translateY(24px);
        animation: payroll-flow-reveal-anim 420ms cubic-bezier(0.165, 0.84, 0.44, 1) forwards;
      }
      @keyframes payroll-flow-reveal-anim {
        to { opacity: 1; transform: translateY(0); }
      }
      .payroll-row-reveal {
        animation: payroll-row-reveal-anim 240ms ease-out both;
      }
      @keyframes payroll-row-reveal-anim {
        from { opacity: 0; transform: translateY(4px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      /* Editable recipient-row inputs. Borderless at rest (read as
         inline text), subtle paper-tint background on focus to signal
         the active cell — no border, no box-shadow ring. Matches the
         canvas-display-input register from /create invoice. */
      .recipient-input {
        background: transparent;
        border: 0;
        outline: none;
        width: 100%;
        color: #1c1712;
        padding: 4px 6px;
        margin-left: -6px;
        border-radius: 2px;
        transition: background-color 120ms ease;
      }
      .recipient-input::placeholder {
        color: #a59c84;
      }
      .recipient-input:focus {
        background: rgba(28, 23, 18, 0.04);
      }
      .recipient-input:disabled {
        cursor: not-allowed;
      }
      /* Wallet-validity dot — sage when parseable, brick when not. */
      .recipient-dot {
        display: inline-block;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        flex-shrink: 0;
      }
      .canvas-disclosure-arrow {
        display: inline-block;
        transition: transform 200ms cubic-bezier(0.16, 1, 0.3, 1);
      }
      details[open] .canvas-disclosure-arrow {
        transform: rotate(90deg);
      }
      @media (prefers-reduced-motion: reduce) {
        .payroll-flow-reveal,
        .payroll-row-reveal,
        .canvas-disclosure-arrow {
          animation: none;
          transition: none;
          opacity: 1;
          transform: none;
        }
      }
    `}</style>
  );
}
