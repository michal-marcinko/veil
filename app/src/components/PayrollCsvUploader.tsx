"use client";

import { useMemo, useState } from "react";
import { parsePayrollCsv, MAX_PAYROLL_ROWS, type PayrollRow } from "@/lib/csv";
import { PAYMENT_SYMBOL } from "@/lib/constants";

export interface PayrollFormValues {
  creatorDisplayName: string;
  rows: PayrollRow[];
}

interface Props {
  onSubmit: (values: PayrollFormValues) => Promise<void>;
  submitting: boolean;
  errorMessage?: string | null;
  onDismissError?: () => void;
}

type Mode = "csv" | "inline";

export function PayrollCsvUploader({ onSubmit, submitting, errorMessage, onDismissError }: Props) {
  const [mode, setMode] = useState<Mode>("csv");
  const [creatorDisplayName, setCreatorDisplayName] = useState("");
  const [csvText, setCsvText] = useState("");
  const [inlineRows, setInlineRows] = useState<PayrollRow[]>([
    { wallet: "", amount: "", memo: "" },
  ]);
  const [localErrors, setLocalErrors] = useState<string[]>([]);

  const csvParsed = useMemo(
    () => (mode === "csv" ? parsePayrollCsv(csvText) : { rows: [], errors: [] }),
    [mode, csvText],
  );

  const activeRows: PayrollRow[] = mode === "csv" ? csvParsed.rows : inlineRows;
  const activeErrors: string[] = mode === "csv" ? csvParsed.errors : [];

  function updateInlineRow(idx: number, field: keyof PayrollRow, value: string) {
    onDismissError?.();
    setInlineRows((rs) => rs.map((r, i) => (i === idx ? { ...r, [field]: value } : r)));
  }

  function addInlineRow() {
    onDismissError?.();
    setInlineRows((rs) =>
      rs.length >= MAX_PAYROLL_ROWS ? rs : [...rs, { wallet: "", amount: "", memo: "" }],
    );
  }

  function removeInlineRow(idx: number) {
    onDismissError?.();
    setInlineRows((rs) => (rs.length > 1 ? rs.filter((_, i) => i !== idx) : rs));
  }

  function validateInlineRows(): string[] {
    const errs: string[] = [];
    inlineRows.forEach((r, i) => {
      const n = i + 1;
      if (!r.wallet.trim()) errs.push(`Row ${n}: wallet is blank.`);
      if (!r.amount.trim()) errs.push(`Row ${n}: amount is blank.`);
      else if (!/^\d+(\.\d+)?$/.test(r.amount.trim())) {
        errs.push(`Row ${n}: amount "${r.amount}" is not a positive decimal.`);
      } else if (Number.parseFloat(r.amount) === 0) {
        errs.push(`Row ${n}: amount must be greater than zero.`);
      }
    });
    if (inlineRows.length > MAX_PAYROLL_ROWS) {
      errs.push(`Inline mode supports up to ${MAX_PAYROLL_ROWS} rows.`);
    }
    return errs;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onDismissError?.();

    if (!creatorDisplayName.trim()) {
      setLocalErrors(['From name is required.']);
      return;
    }
    if (activeRows.length === 0) {
      setLocalErrors(["Add at least one row."]);
      return;
    }
    const validationErrors = mode === "csv" ? activeErrors : validateInlineRows();
    if (validationErrors.length > 0) {
      setLocalErrors(validationErrors);
      return;
    }
    setLocalErrors([]);
    const rows: PayrollRow[] =
      mode === "csv"
        ? activeRows
        : inlineRows.map((r) => ({ wallet: r.wallet.trim(), amount: r.amount.trim(), memo: r.memo.trim() }));
    await onSubmit({ creatorDisplayName: creatorDisplayName.trim(), rows });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-14">
      {/* From */}
      <section className="space-y-7 animate-fade-up">
        <SectionHeader eyebrow="01" title="From" />
        <div className="space-y-2">
          <label className="mono-chip">From name</label>
          <input
            value={creatorDisplayName}
            onChange={(e) => {
              onDismissError?.();
              setCreatorDisplayName(e.target.value);
            }}
            className="input-editorial"
            placeholder="Acme Design Ltd."
            required
          />
          <div className="text-[12px] text-dim font-sans leading-relaxed mt-1.5">
            This name appears on every invoice in the batch.
          </div>
        </div>
      </section>

      {/* Recipients */}
      <section className="space-y-7 animate-fade-up" style={{ animationDelay: "100ms" }}>
        <SectionHeader eyebrow="02" title="Recipients" />

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setMode("csv")}
            className={mode === "csv" ? "btn-primary" : "btn-quiet"}
          >
            Paste CSV
          </button>
          <button
            type="button"
            onClick={() => setMode("inline")}
            className={mode === "inline" ? "btn-primary" : "btn-quiet"}
          >
            Inline rows
          </button>
        </div>

        {mode === "csv" ? (
          <div className="space-y-2">
            <label className="mono-chip">CSV — header: wallet,amount,memo</label>
            <textarea
              value={csvText}
              onChange={(e) => {
                onDismissError?.();
                setCsvText(e.target.value);
              }}
              rows={12}
              className="input-editorial font-mono text-[13px] resize-y"
              placeholder={"wallet,amount,memo\n4w85uvq3GeKRWKeeB2CyH4FeSYtWsvumHt3XB2TaZdFg,100.00,March retainer\n..."}
            />
            <div className="text-[12px] text-dim font-sans leading-relaxed">
              Up to {MAX_PAYROLL_ROWS} rows. One {PAYMENT_SYMBOL} invoice will be created per row.
              Commas inside memos are not supported in this release.
            </div>
            {csvParsed.errors.length === 0 && csvParsed.rows.length > 0 && (
              <div className="text-[12px] text-sage font-mono">
                {csvParsed.rows.length} row(s) ready.
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="hidden md:grid grid-cols-[1.75rem_1fr_8rem_1fr_1.5rem] gap-4 pb-3 border-b border-line items-baseline">
              <div />
              <div className="mono-chip">Wallet</div>
              <div className="mono-chip text-right">Amount · {PAYMENT_SYMBOL}</div>
              <div className="mono-chip">Memo</div>
              <div />
            </div>
            {inlineRows.map((r, idx) => (
              <div
                key={idx}
                className="md:grid md:grid-cols-[1.75rem_1fr_8rem_1fr_1.5rem] md:gap-4 md:items-baseline py-2 flex flex-col gap-3"
              >
                <div className="font-mono text-[11px] text-dim tabular-nums md:pt-2.5">
                  {String(idx + 1).padStart(2, "0")}
                </div>
                <input
                  value={r.wallet}
                  onChange={(e) => updateInlineRow(idx, "wallet", e.target.value)}
                  className="input-editorial font-mono text-sm"
                  placeholder="4w85uvq3GeKR..."
                />
                <input
                  value={r.amount}
                  onChange={(e) => updateInlineRow(idx, "amount", e.target.value)}
                  inputMode="decimal"
                  className="input-editorial text-right font-mono tabular-nums"
                  placeholder="100.00"
                />
                <input
                  value={r.memo}
                  onChange={(e) => updateInlineRow(idx, "memo", e.target.value)}
                  className="input-editorial"
                  placeholder="March retainer"
                />
                <div className="md:text-right md:pt-1.5">
                  {inlineRows.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeInlineRow(idx)}
                      className="text-dim hover:text-brick transition-colors text-xl leading-none"
                      aria-label={`Remove row ${idx + 1}`}
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>
            ))}
            <button
              type="button"
              onClick={addInlineRow}
              disabled={inlineRows.length >= MAX_PAYROLL_ROWS}
              className="btn-quiet"
            >
              + Add row
            </button>
            <div className="text-[12px] text-dim font-sans">
              {inlineRows.length}/{MAX_PAYROLL_ROWS} rows.
            </div>
          </div>
        )}

        {activeErrors.length > 0 && (
          <div className="border-l-2 border-brick pl-4 py-2 space-y-1 max-w-2xl">
            {activeErrors.map((e, i) => (
              <div key={i} className="text-[13px] text-ink font-mono">
                {e}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Submit */}
      <div className="pt-2 animate-fade-up space-y-5" style={{ animationDelay: "200ms" }}>
        {(errorMessage || localErrors.length > 0) && (
          <div className="flex items-start gap-4 border-l-2 border-brick pl-4 py-2 max-w-2xl">
            <span className="mono-chip text-brick shrink-0 pt-0.5">Error</span>
            <div className="text-sm text-ink leading-relaxed flex-1 space-y-1">
              {errorMessage && <div>{errorMessage}</div>}
              {localErrors.map((e, i) => (
                <div key={i}>{e}</div>
              ))}
            </div>
            {onDismissError && errorMessage && (
              <button
                type="button"
                onClick={onDismissError}
                className="text-dim hover:text-ink transition-colors text-lg leading-none shrink-0"
                aria-label="Dismiss error"
              >
                ×
              </button>
            )}
          </div>
        )}
        <button
          type="submit"
          disabled={submitting || activeRows.length === 0}
          className="btn-primary w-full md:w-auto md:min-w-[340px]"
        >
          {submitting ? (
            <span className="inline-flex items-center gap-3">
              <span className="h-1.5 w-1.5 rounded-full bg-paper animate-slow-pulse" />
              Publishing batch
            </span>
          ) : (
            <span>
              Generate {activeRows.length || "N"} invoice link{activeRows.length === 1 ? "" : "s"}{" "}
              <span aria-hidden>→</span>
            </span>
          )}
        </button>
        <p className="max-w-xl text-[12px] font-mono tracking-[0.12em] uppercase text-dim">
          One invoice · one {PAYMENT_SYMBOL} PDA · per row. Shared batch ID stamped on all.
        </p>
      </div>
    </form>
  );
}

function SectionHeader({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="flex items-baseline gap-5 border-b border-line pb-3">
      <span className="font-mono text-[10.5px] text-gold tracking-[0.18em] tabular-nums">
        {eyebrow}
      </span>
      <h2 className="font-sans font-medium text-ink text-[20px] md:text-[22px] tracking-[-0.015em] leading-none">
        {title}
      </h2>
      <span className="flex-1 h-px bg-line/50 mb-1.5" />
    </div>
  );
}
