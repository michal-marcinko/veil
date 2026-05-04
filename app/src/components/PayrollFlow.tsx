"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
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
  buildShadowClient,
  checkRecipientsRegistration,
  depositToShadow,
  fundShadowAccount,
  generateClaimUrl,
  generateEphemeralKeypair,
  registerShadowAccount,
  rowsToClaimLinkCsv,
  SHADOW_FUNDING_LAMPORTS,
  type ClaimLinkRow,
  type RegistrationStatus,
} from "@/lib/payroll-claim-links";

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

export function PayrollFlow() {
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
          stepLabel:
            phase === "signing"
              ? "Signing receipt packet"
              : `Sending payment ${rows.length + 1} of ${totalCountForRun}`,
          stepCounter:
            phase === "signing"
              ? "FINAL"
              : `${String(rows.length).padStart(2, "0")} / ${String(totalCountForRun).padStart(2, "0")}`,
          awaitingWallet: true,
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
   * Drag-drop handlers for the recipients table. Two subtleties:
   *
   * 1. preventDefault on dragOver is what tells the browser this surface
   *    accepts drops — without it, the browser shows the "no-drop"
   *    cursor and the drop event never fires. We also explicitly set
   *    dropEffect so the cursor reads "copy" not "move".
   *
   * 2. dragLeave fires every time the cursor crosses a child boundary
   *    (each row, each input), not only when leaving the wrapper. We
   *    deactivate only when the relatedTarget is genuinely outside the
   *    wrapper (or null, which means leaving the window). Otherwise the
   *    overlay flickers off the moment the user moves over a row.
   */
  function handleDragEnter(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (running) return;
    setDragActive(true);
  }
  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (running) return;
    e.dataTransfer.dropEffect = "copy";
    setDragActive(true);
  }
  function handleDragLeave(e: React.DragEvent<HTMLDivElement>) {
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    setDragActive(false);
  }
  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    if (running) return;
    const file = e.dataTransfer.files?.[0];
    if (file) {
      ingestCsvFile(file).catch((err) =>
        setError(`CSV import failed: ${err?.message ?? String(err)}`),
      );
    }
  }

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

      for (let i = 0; i < parsed.rows.length; i++) {
        const row = parsed.rows[i];
        const prepared = prepareRow(row, i);
        const status = detection?.rowStatuses[i];

        if (status === "unregistered") {
          try {
            const claimResult = await sendViaClaimLink({
              prepared,
              payerClient: client,
              payerWallet: wallet,
              connection,
              companyName,
              batchId,
              rowIndex: i,
            });
            resultRows.push({
              ...prepared,
              status: "paid",
              mode: "public",
              txSignature: claimResult.depositSignature,
              error: null,
              claimUrl: claimResult.claimUrl,
              registrationStatus: "unregistered",
            });
          } catch (err: any) {
            resultRows.push({
              ...prepared,
              status: "failed",
              mode: "public",
              txSignature: null,
              error: `Claim-link path failed: ${err.message ?? String(err)}`,
              registrationStatus: "unregistered",
            });
          }
          setRows([...resultRows]);
          continue;
        }

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
          resultRows.push({
            ...prepared,
            status: "paid",
            mode: useShieldedForRun ? "shielded" : "public",
            txSignature: payResult.createUtxoSignature,
            error: null,
            registrationStatus: status,
          });
        } catch (err: any) {
          resultRows.push({
            ...prepared,
            status: "failed",
            mode: useShieldedForRun ? "shielded" : "public",
            txSignature: null,
            error: err.message ?? String(err),
            registrationStatus: status,
          });
        }
        setRows([...resultRows]);
      }

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
  }): Promise<{ claimUrl: string; depositSignature: string; shadowAddress: string }> {
    const ephemeral = generateEphemeralKeypair();
    await fundShadowAccount({
      payerWallet: args.payerWallet,
      shadowAddress: ephemeral.address,
      lamports: SHADOW_FUNDING_LAMPORTS,
      connection: args.connection,
    });
    const shadowClient = await buildShadowClient(ephemeral.privateKey);
    await registerShadowAccount({ shadowClient });
    const deposit = await depositToShadow({
      payerClient: args.payerClient,
      shadowAddress: ephemeral.address,
      mint: USDC_MINT.toBase58(),
      amount: BigInt(args.prepared.amount),
    });
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
    <div className="max-w-3xl pb-32">
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
            <div
              onDragEnter={handleDragEnter}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`mt-5 border-t border-line relative transition-colors duration-150 ${
                dragActive ? "bg-paper-3/70" : ""
              }`}
            >
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
              {dragActive && (
                <div className="absolute inset-0 bg-paper/85 backdrop-blur-sm flex items-center justify-center pointer-events-none border border-dashed border-ink/30 rounded-[3px]">
                  <span className="eyebrow text-ink">Drop CSV to import</span>
                </div>
              )}
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
          with the run ledger + collapsible explainer below. */}
      {inSuccessState && (
        <SuccessHero
          paymentCount={rows.filter((r) => r.status === "paid").length}
          totalDisplay={totalDisplay}
        />
      )}

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
          tucked away by default; expandable for skeptics + judges. */}
      <details className="mt-12 group">
        <summary className="cursor-pointer text-[13px] text-muted hover:text-ink transition-colors inline-flex items-center gap-2 list-none">
          <span className="canvas-disclosure-arrow">›</span>
          Why is this private?
        </summary>
        <div className="mt-5">
          <ExplorerComparison />
        </div>
      </details>

      <RegistrationModal open={regOpen} steps={regSteps} />
      <PayrollPublishingModal
        open={running}
        totalCount={runTotalCount || rowCount}
        sentCount={rows.length}
        phase={phase === "signing" ? "signing" : "sending"}
        awaitingWallet
      />
      <CanvasBar state={canvasBarState} formId="payroll-form" />

      <PayrollFlowStyles />
    </div>
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
            {row.claimUrl && <span className="mono-chip text-sage">claim-link</span>}
          </div>
          <div className="mt-1 text-[12.5px] text-muted truncate">
            {row.memo || "No memo"}
          </div>
          {row.error && <div className="mt-2 text-[12px] text-brick">{row.error}</div>}
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
  paymentCount,
  totalDisplay,
}: {
  paymentCount: number;
  totalDisplay: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center pt-4 md:pt-6 pb-8">
      <VeilDescentMark size={144} variant="batch" />
      <div className="mt-8 eyebrow text-sage">
        ✓ Payroll signed · packet ready
      </div>
      <div className="mt-3 font-sans font-medium text-ink text-[28px] md:text-[32px] leading-[1.1] tracking-[-0.025em]">
        <span className="tnum">{paymentCount}</span>
        <span className="text-muted"> payment{paymentCount === 1 ? "" : "s"} · </span>
        <span className="tnum">{totalDisplay}</span>
      </div>
      <p className="mt-4 text-[14px] leading-[1.55] text-muted max-w-[480px]">
        Each contractor was paid through Umbra. The packet below verifies the
        whole batch; per-row disclosure links reveal exactly one entry.
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
