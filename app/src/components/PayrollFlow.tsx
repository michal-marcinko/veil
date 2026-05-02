"use client";

import { useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
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
}

const SAMPLE_CSV =
  "wallet,amount,memo\n" +
  "4w85uvq3GeKRWKeeB2CyH4FeSYtWsvumHt3XB2TaZdFg,100.00,April contractor retainer\n" +
  "8hQ5k9sDZQx7WkZpPRM6MeQpM9tYfWnGf6bYj1Gx9zQm,250.00,Design sprint bonus";

export function PayrollFlow() {
  const wallet = useWallet();

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

  const parsed = useMemo(() => parsePayrollCsv(csvText), [csvText]);
  const total = useMemo(() => {
    let sum = 0n;
    for (const row of parsed.rows) {
      const amount = parseAmountToBaseUnits(row.amount, PAYMENT_DECIMALS);
      if (amount != null) sum += amount;
    }
    return sum;
  }, [parsed.rows]);

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
        setRows([...resultRows, { ...prepared, status: "paid", txSignature: null, error: null }]);
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
          });
        } catch (err: any) {
          resultRows.push({
            ...prepared,
            status: "failed",
            mode: useShieldedForRun ? "shielded" : "public",
            txSignature: null,
            error: err.message ?? String(err),
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
        rows: resultRows.map(({ amountDisplay, ...row }) => row),
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
      await downloadPayrollPacketPdf(signed);
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
            onChange={(e) => setCsvText(e.target.value)}
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
              onClick={() => setCsvText(SAMPLE_CSV)}
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
          <div className="px-5 md:px-6 py-4 border-b border-line flex items-baseline justify-between gap-4">
            <span className="eyebrow">Run ledger</span>
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
                    {(row.txSignature || disclosureUrl) && (
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
