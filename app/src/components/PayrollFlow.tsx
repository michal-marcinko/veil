"use client";

import { useMemo, useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import {
  RegistrationModal,
  type RegistrationStep,
  type StepStatus,
} from "@/components/RegistrationModal";
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
 * PayrollFlow — self-contained outgoing-payroll experience.
 *
 * Encapsulates: wallet gate, CSV intake, funding-mode selector, run dispatch,
 * registration modal, per-row results ledger, signed-packet export.
 *
 * Designed to be embedded inline (e.g. inside /create's narrow column) OR
 * rendered standalone on /payroll/outgoing — the layout is single-column
 * vertical so it works in any width down to ~max-w-3xl.
 *
 * Animation register matches /create: 700ms cubic-bezier(0.16, 1, 0.3, 1)
 * (Apple ease-out-expo) per-section reveals, staggered. prefers-reduced-motion
 * short-circuits to final state.
 */

type RunMode = "auto" | "shielded" | "public";

interface PayrollRunRow extends PayrollPacketRow {
  amountDisplay: string;
  /** Set when this row was paid via the claim-link path. The URL must be
   *  shared with the recipient (downloadable CSV or PDF). */
  claimUrl?: string;
  /** Set when this row used the claim-link path — surfaced in the
   *  ledger so the employer knows extra setup happened. */
  registrationStatus?: RegistrationStatus;
}

interface RegistrationDetectionResult {
  /** Aligned 1:1 with parsed.rows. */
  rowStatuses: RegistrationStatus[];
  /** Indexes of rows that need claim links. */
  unregisteredIndexes: number[];
  unknownIndexes: number[];
}

const SAMPLE_CSV =
  "wallet,amount,memo\n" +
  "4w85uvq3GeKRWKeeB2CyH4FeSYtWsvumHt3XB2TaZdFg,100.00,April contractor retainer\n" +
  "8hQ5k9sDZQx7WkZpPRM6MeQpM9tYfWnGf6bYj1Gx9zQm,250.00,Design sprint bonus";

export function PayrollFlow() {
  const wallet = useWallet();
  const { connection } = useConnection();

  const [companyName, setCompanyName] = useState("");
  const [csvText, setCsvText] = useState("");
  const [mode, setMode] = useState<RunMode>("auto");
  const [running, setRunning] = useState(false);
  const [signingPacket, setSigningPacket] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rows, setRows] = useState<PayrollRunRow[]>([]);
  const [packet, setPacket] = useState<PayrollPacket | null>(null);
  const [signedPacket, setSignedPacket] = useState<SignedPayrollPacket | null>(null);
  const [packetUrl, setPacketUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [regOpen, setRegOpen] = useState(false);
  const [regSteps, setRegSteps] = useState<Record<RegistrationStep, StepStatus>>({
    init: "pending",
    x25519: "pending",
    commitment: "pending",
  });

  // Registration-detection state. Populated by handleDetectRegistration
  // (called after CSV is valid, before payroll run starts). Lets us
  // show the per-row status BEFORE the employer commits to the run, so
  // the cost of unregistered recipients (≈ 0.01 SOL each) is upfront.
  const [detection, setDetection] = useState<RegistrationDetectionResult | null>(null);
  const [detecting, setDetecting] = useState(false);

  const parsed = useMemo(() => parsePayrollCsv(csvText), [csvText]);
  const total = useMemo(() => {
    let sum = 0n;
    for (const row of parsed.rows) {
      const amount = parseAmountToBaseUnits(row.amount, PAYMENT_DECIMALS);
      if (amount != null) sum += amount;
    }
    return sum;
  }, [parsed.rows]);

  /**
   * Read-only on-chain query: which recipients are already Umbra-
   * registered, and which need a claim link? Cheap (no popups, just RPC
   * reads). Result drives the inline preview status chips and the
   * "extra setup cost" disclosure.
   */
  async function handleDetectRegistration() {
    if (!wallet.publicKey || parsed.rows.length === 0) return;
    setDetecting(true);
    setError(null);
    try {
      // Re-uses the user's already-loaded Umbra client. The querier
      // accepts any address — we don't need to spin up another client
      // per recipient.
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

  // Whenever the CSV changes the previous detection is stale.
  // We invalidate eagerly via this callback rather than useEffect
  // so the user can't accidentally re-use a cached detection over
  // a different recipient set.
  function onCsvTextChange(next: string) {
    setCsvText(next);
    setDetection(null);
  }

  async function runPayroll() {
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
    setError(null);
    setNotice(null);
    setRows([]);
    setPacket(null);
    setSignedPacket(null);
    setPacketUrl(null);

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

        // Branch A: recipient is unregistered → claim-link path. We
        // generate a one-shot shadow account, fund it, register it,
        // deposit the payout, then bake the URL into the run result.
        // The sender pays for everything; the recipient just clicks.
        if (status === "unregistered") {
          setRows([
            ...resultRows,
            { ...prepared, status: "paid", txSignature: null, error: null, registrationStatus: "unregistered" },
          ]);
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

        // Branch B: recipient is registered (or detection wasn't run / was
        // "unknown" — we optimistically attempt direct send, the SDK will
        // throw if the recipient really has no account).
        setRows([
          ...resultRows,
          { ...prepared, status: "paid", txSignature: null, error: null, registrationStatus: status },
        ]);
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

      const nextPacket: PayrollPacket = {
        version: 1,
        kind: "veil.private-payroll",
        batchId,
        payer: wallet.publicKey.toBase58(),
        mint: USDC_MINT.toBase58(),
        symbol: PAYMENT_SYMBOL,
        decimals: PAYMENT_DECIMALS,
        createdAt: new Date().toISOString(),
        // Strip the run-only fields (amountDisplay, claimUrl,
        // registrationStatus) before signing the packet — the canonical
        // PayrollPacketRow shape is fixed by the verifier on the
        // disclosure side, and adding fields here would invalidate
        // existing receipts.
        rows: resultRows.map(({ amountDisplay, claimUrl, registrationStatus, ...row }) => row),
      };
      setPacket(nextPacket);
      setNotice("Payroll run complete. Sign one packet to create receipts and disclosure links.");
    } catch (err: any) {
      setRegOpen(false);
      setError(err.message ?? String(err));
    } finally {
      setRunning(false);
    }
  }

  /**
   * Claim-link path: register a one-shot shadow account, fund it,
   * deposit the payout into its encrypted balance, and return the URL
   * Bob will click. Wraps the helpers in payroll-claim-links.ts so the
   * sequencing + error reporting lives close to the run loop.
   *
   * Throws if any sub-step fails. The caller catches and marks the row
   * as failed in the run ledger.
   */
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

    // Step 1: fund the shadow with enough SOL to cover its own rent
    // + register/deposit/withdraw fees. Single Phantom popup for Alice.
    await fundShadowAccount({
      payerWallet: args.payerWallet,
      shadowAddress: ephemeral.address,
      lamports: SHADOW_FUNDING_LAMPORTS,
      connection: args.connection,
    });

    // Step 2: build an in-memory Umbra client signed by the ephemeral
    // keypair, then run registration. No popups (the SDK uses the
    // shadow's keypair directly).
    const shadowClient = await buildShadowClient(ephemeral.privateKey);
    await registerShadowAccount({ shadowClient });

    // Step 3: deposit Alice's USDC into the shadow's encrypted balance.
    // Signer = Alice (her ATA pays); destination = shadow. ONE Phantom
    // popup for Alice (the deposit tx).
    const deposit = await depositToShadow({
      payerClient: args.payerClient,
      shadowAddress: ephemeral.address,
      mint: USDC_MINT.toBase58(),
      amount: BigInt(args.prepared.amount),
    });

    // Step 4: build the URL Bob will click. Include the amount + sender
    // in the fragment so the claim page renders something meaningful
    // before Bob connects a wallet.
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

    return { claimUrl, depositSignature: deposit.depositSignature, shadowAddress: ephemeral.address };
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

  async function signPacket() {
    if (!packet) return;
    setSigningPacket(true);
    setError(null);
    try {
      const signed = await signPayrollPacket(packet, wallet as any);
      const blob = encodePayrollPacket(signed);
      const url = `${window.location.origin}/payroll/packet#${blob}`;
      setSignedPacket(signed);
      setPacketUrl(url);
      downloadPayrollPacketJson(signed);
      // If any rows used the claim-link path, build a fresh PDF that
      // includes a "Claim links" appendix. We bypass the standard
      // downloader (downloadPayrollPacketPdf) when claim URLs exist
      // so we can pass them through to the PDF document — the standard
      // downloader doesn't accept claim URLs as a parameter.
      const claimUrls: Record<number, string> = {};
      rows.forEach((r, idx) => {
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
      setError(err.message ?? String(err));
    } finally {
      setSigningPacket(false);
    }
  }

  async function copyText(key: string, text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 1800);
  }

  /**
   * Download a CSV of every claim link in the run. Lets the employer
   * hand-deliver the URLs through whatever channel they prefer (their
   * payroll portal, BambooHR, manual emails). Empty rows in the
   * `claim_url` column correspond to recipients who were already
   * registered and got paid directly — included so the file matches
   * the run ledger 1:1 (same ordering as the input CSV).
   */
  function downloadClaimLinksCsv() {
    const claimRows: ClaimLinkRow[] = rows.map((row) => ({
      recipient: row.recipient,
      amount: row.amountDisplay,
      status: row.error
        ? "failed"
        : row.claimUrl
          ? "claim-link"
          : "direct",
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

  // Wallet gate. The gate IS the first state — we don't render an empty form.
  if (!wallet.connected) {
    return (
      <div className="payroll-flow-reveal max-w-2xl">
        <span className="eyebrow">Private payroll</span>
        <h2 className="mt-3 font-display font-medium text-ink text-[40px] md:text-[52px] leading-[1.03] tracking-[-0.025em]">
          Connect to run payroll.
        </h2>
        <p className="mt-6 text-[17px] md:text-[19px] text-ink/80 leading-[1.5]">
          This mode sends private Umbra payments out to contractors. It does not
          create invoice PDAs.
        </p>
        <div className="mt-8">
          <ClientWalletMultiButton />
        </div>
        <PayrollFlowStyles />
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      {/* Heading */}
      <header className="payroll-flow-reveal" style={{ animationDelay: "0ms" }}>
        <span className="eyebrow">Private payroll</span>
        <h2 className="mt-3 font-display font-medium text-ink text-[40px] md:text-[52px] leading-[1.03] tracking-[-0.025em]">
          Pay contractors without publishing salaries.
        </h2>
        <p className="mt-6 text-[14px] text-ink/75 leading-relaxed max-w-xl">
          Upload a payroll CSV, send each payment through Umbra, then sign one
          receipt packet your accountant can verify.
        </p>
      </header>

      {/* Form */}
      <section
        className="mt-10 md:mt-12 payroll-flow-reveal space-y-8"
        style={{ animationDelay: "60ms" }}
      >
        <div className="space-y-2">
          <label className="mono-chip">Company / payer</label>
          <input
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            className="input-editorial"
            placeholder="Acme Payroll Ops"
          />
        </div>

        <div className="space-y-2">
          <label className="mono-chip">CSV — wallet,amount,memo</label>
          <textarea
            value={csvText}
            onChange={(e) => onCsvTextChange(e.target.value)}
            rows={11}
            className="input-editorial font-mono text-[13px] resize-y"
            placeholder={SAMPLE_CSV}
          />
          <div className="flex flex-wrap items-center justify-between gap-3 text-[12px]">
            <span className="text-dim">
              {parsed.rows.length} row(s), total{" "}
              {formatPayrollAmount(total, PAYMENT_DECIMALS)} {PAYMENT_SYMBOL}
            </span>
            <button
              type="button"
              onClick={() => onCsvTextChange(SAMPLE_CSV)}
              className="btn-quiet"
            >
              Load sample
            </button>
          </div>
        </div>

        <div className="border border-line bg-paper-3 rounded-[3px] p-5">
          <div className="flex items-baseline justify-between gap-4 mb-4">
            <span className="eyebrow">Funding source</span>
            <span className="font-mono text-[10.5px] text-dim tracking-[0.1em] uppercase">
              How this batch gets funded
            </span>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setMode("auto")}
              className={`px-4 py-2.5 rounded-[3px] border text-[13.5px] transition-colors ${
                mode === "auto"
                  ? "border-sage bg-sage/10 text-sage"
                  : "border-line bg-paper text-muted hover:text-ink hover:border-ink/30"
              }`}
            >
              Smart
            </button>
            <button
              type="button"
              onClick={() => setMode("shielded")}
              className={`px-4 py-2.5 rounded-[3px] border text-[13.5px] transition-colors ${
                mode === "shielded"
                  ? "border-sage bg-sage/10 text-sage"
                  : "border-line bg-paper text-muted hover:text-ink hover:border-ink/30"
              }`}
            >
              Private balance
            </button>
            <button
              type="button"
              onClick={() => setMode("public")}
              className={`px-4 py-2.5 rounded-[3px] border text-[13.5px] transition-colors ${
                mode === "public"
                  ? "border-sage bg-sage/10 text-sage"
                  : "border-line bg-paper text-muted hover:text-ink hover:border-ink/30"
              }`}
            >
              Wallet
            </button>
          </div>

          <p className="mt-4 text-[13px] text-ink/70 leading-relaxed">
            {mode === "auto" && (
              <>
                <span className="text-ink font-medium">Smart.</span> Pulls from
                your encrypted Umbra balance when there&apos;s enough; falls back
                to your wallet otherwise. Recommended for most batches.
              </>
            )}
            {mode === "shielded" && (
              <>
                <span className="text-ink font-medium">Private balance only.</span>
                {" "}Spends your encrypted Umbra balance. No public deposit appears
                on-chain — only the existing balance is rotated through Umbra&apos;s
                mixer.
              </>
            )}
            {mode === "public" && (
              <>
                <span className="text-ink font-medium">Wallet only.</span> Pulls
                funds from your public ATA at run time. A deposit transaction
                appears on-chain; the recipient leg of each payment is still
                private.
              </>
            )}
          </p>
        </div>

        {/* Registration detection — read-only on-chain probe per row.
            Cheap (no popups) and gives the employer an honest cost
            estimate BEFORE they kick off the run. The "Detect" button
            is intentionally manual — auto-detect on every keystroke
            would hammer the RPC for half-typed CSVs. */}
        <div className="border border-line bg-paper-3 rounded-[3px] p-5">
          <div className="flex items-baseline justify-between gap-4 mb-3">
            <span className="eyebrow">Recipient registration</span>
            <button
              type="button"
              onClick={handleDetectRegistration}
              disabled={detecting || parsed.rows.length === 0}
              className="btn-quiet text-[11px]"
            >
              {detecting
                ? "Checking..."
                : detection
                  ? "Re-check"
                  : "Check who needs claim links"}
            </button>
          </div>
          {!detection && (
            <p className="text-[13px] text-ink/70 leading-relaxed">
              Recipients without an existing Umbra registration will be paid
              via a one-shot claim link. Click above to see who needs one.
            </p>
          )}
          {detection && (
            <RegistrationSummary
              detection={detection}
              rows={parsed.rows}
            />
          )}
        </div>

        {error && (
          <div className="flex items-start gap-4 border-l-2 border-brick pl-4 py-2">
            <span className="mono-chip text-brick shrink-0 pt-0.5">Error</span>
            <span className="text-[13.5px] text-ink leading-relaxed">{error}</span>
          </div>
        )}
        {notice && (
          <div className="flex items-start gap-4 border-l-2 border-sage pl-4 py-2">
            <span className="mono-chip text-sage shrink-0 pt-0.5">Note</span>
            <span className="text-[13.5px] text-ink leading-relaxed">{notice}</span>
          </div>
        )}
      </section>

      {/* Run button */}
      <div
        className="mt-8 payroll-flow-reveal"
        style={{ animationDelay: "120ms" }}
      >
        <button
          type="button"
          onClick={runPayroll}
          disabled={running || parsed.rows.length === 0}
          className="btn-primary w-full"
        >
          {running
            ? "Running private payroll..."
            : `Run ${parsed.rows.length || "N"} private payment${
                parsed.rows.length === 1 ? "" : "s"
              }`}
        </button>
      </div>

      {/* Explorer comparison + Run ledger */}
      <section
        className="mt-12 border-t border-line pt-10 payroll-flow-reveal"
        style={{ animationDelay: "180ms" }}
      >
        <ExplorerComparison />

        <div className="mt-8 border border-line bg-paper-3 rounded-[4px]">
          <div className="px-5 md:px-6 py-4 border-b border-line flex items-baseline justify-between gap-4 flex-wrap">
            <span className="eyebrow">Run ledger</span>
            <div className="flex items-baseline gap-3">
              {rows.some((r) => r.claimUrl) && (
                <button
                  type="button"
                  onClick={downloadClaimLinksCsv}
                  className="btn-ghost px-4 py-2 text-[12px]"
                >
                  Download claim links (CSV)
                </button>
              )}
              {packet && (
                <button
                  type="button"
                  onClick={signPacket}
                  disabled={signingPacket}
                  className="btn-ghost px-4 py-2 text-[12px]"
                >
                  {signingPacket ? "Signing..." : "Sign receipt packet"}
                </button>
              )}
            </div>
          </div>

          {rows.length === 0 ? (
            <div className="p-8 text-center text-[14px] text-muted">
              Payroll txs will appear here as each Umbra payment settles.
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {rows.map((row, idx) => {
                const disclosureUrl =
                  signedPacket && typeof window !== "undefined"
                    ? `${window.location.origin}/disclose/payroll#${encodePayrollDisclosure(
                        buildPayrollDisclosure(signedPacket, idx),
                      )}`
                    : null;
                return (
                  <li
                    key={`${row.recipient}-${idx}`}
                    className="px-5 md:px-6 py-4 payroll-row-reveal"
                  >
                    <div className="grid grid-cols-[1.5rem_1fr_auto] gap-4 items-baseline">
                      <span className="font-mono text-[11px] text-dim tnum">
                        {String(idx + 1).padStart(2, "0")}
                      </span>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                          <span className="font-mono text-[13px] text-ink truncate">
                            {row.recipient.slice(0, 8)}...{row.recipient.slice(-5)}
                          </span>
                          <span className="text-[13px] text-ink/80 tnum">
                            {row.amountDisplay}
                          </span>
                          <span className="mono-chip text-dim">{row.mode}</span>
                          {row.claimUrl && (
                            <span className="mono-chip text-sage">claim-link</span>
                          )}
                        </div>
                        <div className="mt-1 text-[12.5px] text-muted truncate">
                          {row.memo || "No memo"}
                        </div>
                        {row.error && (
                          <div className="mt-2 text-[12px] text-brick">{row.error}</div>
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
                            className="btn-quiet text-[12px]"
                          >
                            Explorer tx
                          </a>
                        )}
                        {disclosureUrl && (
                          <button
                            type="button"
                            onClick={() => copyText(`disclosure-${idx}`, disclosureUrl)}
                            className="btn-quiet text-[12px]"
                          >
                            {copied === `disclosure-${idx}`
                              ? "Copied disclosure"
                              : "Copy disclosure link"}
                          </button>
                        )}
                        {row.claimUrl && (
                          <button
                            type="button"
                            onClick={() => copyText(`claim-${idx}`, row.claimUrl!)}
                            className="btn-quiet text-[12px]"
                          >
                            {copied === `claim-${idx}`
                              ? "Copied claim URL"
                              : "Copy claim URL"}
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {packetUrl && (
          <div className="mt-6 border border-sage/40 bg-sage/5 rounded-[4px] p-5 payroll-row-reveal">
            <div className="flex items-baseline gap-2 mb-1">
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                className="text-sage shrink-0 translate-y-[1px]"
              >
                <path
                  d="M3 7.5l3 3 5-6"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="eyebrow text-sage">Signed packet ready</span>
            </div>
            <p className="mt-2 text-[13.5px] text-ink/75 leading-relaxed">
              This verifier link reveals the full payroll packet to whoever receives it.
              Use per-row disclosure links for selective reveal.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => copyText("packet", packetUrl)}
                className="btn-ghost px-4 py-2 text-[12px]"
              >
                {copied === "packet" ? "Copied" : "Copy packet link"}
              </button>
              <a href={packetUrl} className="btn-quiet text-[12px]">
                Open packet verifier
              </a>
            </div>
          </div>
        )}
      </section>

      <RegistrationModal open={regOpen} steps={regSteps} />

      <PayrollFlowStyles />
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────
   Sub-components — Explorer comparison block + status badge.
   ────────────────────────────────────────────────────────────────────── */

function ExplorerComparison() {
  return (
    <div className="border border-line bg-paper-3 rounded-[4px] p-5 md:p-6">
      <div className="flex items-baseline justify-between gap-4 border-b border-line pb-4">
        <span className="eyebrow">Explorer comparison</span>
        <span className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-sage">
          Judge demo shot
        </span>
      </div>
      <div className="mt-5 grid md:grid-cols-2 gap-4">
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

/**
 * Per-row registration summary with an honest cost estimate. Shows
 * up after the user clicks "Check who needs claim links". The
 * lamports → SOL conversion uses the `SHADOW_FUNDING_LAMPORTS`
 * constant directly so the number Alice sees matches the number we
 * actually transfer.
 */
function RegistrationSummary({
  detection,
  rows,
}: {
  detection: RegistrationDetectionResult;
  rows: PayrollRow[];
}) {
  const unregisteredCount = detection.unregisteredIndexes.length;
  const unknownCount = detection.unknownIndexes.length;
  const registeredCount =
    detection.rowStatuses.filter((s) => s === "registered").length;
  const extraSolPerRow = Number(SHADOW_FUNDING_LAMPORTS) / 1e9;
  const totalExtraSol = (extraSolPerRow * unregisteredCount).toFixed(3);

  return (
    <div>
      <div className="grid grid-cols-3 gap-3 mb-4 text-[12.5px]">
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
          <span className="font-mono">{extraSolPerRow.toFixed(3)} SOL</span> for
          the shadow account&apos;s rent + tx fees{" "}
          (<span className="font-mono">~{totalExtraSol} SOL</span> total).
          They click the link, connect a wallet, and the funds land directly.
        </p>
      )}
      <ul className="divide-y divide-line text-[12.5px]">
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
      ? "border-sage/40 bg-sage/5 text-sage"
      : tone === "gold"
        ? "border-gold/40 bg-gold/5 text-gold-dim"
        : "border-line bg-paper text-dim";
  return (
    <div className={`border rounded-[2px] px-3 py-2 ${cls}`}>
      <div className="font-mono text-[10px] tracking-[0.12em] uppercase opacity-80">
        {label}
      </div>
      <div className="text-[18px] font-medium mt-0.5">{count}</div>
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

function StatusBadge({ status }: { status: PayrollPacketRow["status"] }) {
  const cls =
    status === "paid"
      ? "border-sage/40 text-sage bg-sage/5"
      : "border-brick/40 text-brick bg-brick/5";
  return (
    <span
      className={`inline-block px-2.5 py-1 border rounded-[2px] font-mono text-[10.5px] tracking-[0.12em] uppercase ${cls}`}
    >
      {status}
    </span>
  );
}

/* ──────────────────────────────────────────────────────────────────────
   Reveal animations — Apple ease-out-expo. Honors prefers-reduced-motion.

   payroll-flow-reveal: 700ms cubic-bezier(0.16, 1, 0.3, 1), translateY(40px)→0
   payroll-row-reveal:  240ms ease-out, plain fade. Used for ledger rows
                        and the success packet block so newly-arriving rows
                        don't visually jump.
   ────────────────────────────────────────────────────────────────────── */

function PayrollFlowStyles() {
  return (
    <style>{`
      .payroll-flow-reveal {
        opacity: 0;
        transform: translateY(40px);
        animation: payroll-flow-reveal-anim 700ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
      }
      @keyframes payroll-flow-reveal-anim {
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
      .payroll-row-reveal {
        animation: payroll-row-reveal-anim 240ms ease-out both;
      }
      @keyframes payroll-row-reveal-anim {
        from { opacity: 0; transform: translateY(4px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      @media (prefers-reduced-motion: reduce) {
        .payroll-flow-reveal,
        .payroll-row-reveal {
          animation: none;
          opacity: 1;
          transform: none;
        }
      }
    `}</style>
  );
}
