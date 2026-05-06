"use client";

import { useEffect, useState } from "react";
import { VeilLogo } from "@/components/VeilLogo";
import {
  decodePayrollDisclosure,
  formatPayrollAmount,
  payrollExplorerTxUrl,
  verifyPayrollDisclosure,
  type PayrollDisclosure,
} from "@/lib/private-payroll";
import { NETWORK } from "@/lib/constants";

type State =
  | { kind: "loading" }
  | { kind: "error"; reason: string }
  | { kind: "ok"; disclosure: PayrollDisclosure; valid: boolean };

export default function PayrollDisclosurePage() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    (async () => {
      try {
        const blob = window.location.hash.slice(1);
        if (!blob) {
          setState({ kind: "error", reason: "Disclosure link is missing its URL fragment." });
          return;
        }
        const disclosure = decodePayrollDisclosure(blob);
        const valid = await verifyPayrollDisclosure(disclosure);
        setState({ kind: "ok", disclosure, valid });
      } catch (err: any) {
        setState({ kind: "error", reason: err.message ?? String(err) });
      }
    })();
  }, []);

  const row =
    state.kind === "ok"
      ? state.disclosure.packet.rows[state.disclosure.rowIndex]
      : null;

  return (
    <main className="min-h-screen relative pb-32">
      <nav className="sticky top-0 z-10 backdrop-blur-sm bg-paper/80 border-b border-line">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between px-6 md:px-8 py-4">
          <VeilLogo tagline="selective disclosure" />
        </div>
      </nav>

      <section className="max-w-[1400px] mx-auto px-6 md:px-8 pt-16 md:pt-20">
        {state.kind === "loading" && <p className="text-[13.5px] text-muted">Verifying disclosure...</p>}

        {state.kind === "error" && (
          <div className="max-w-xl border-l-2 border-brick pl-5 py-3">
            <span className="mono-chip text-brick">Invalid disclosure</span>
            <p className="mt-3 text-[14px] text-ink/80">{state.reason}</p>
          </div>
        )}

        {state.kind === "ok" && row && (
          <div className="max-w-2xl reveal">
            <span className={state.valid ? "eyebrow text-sage" : "eyebrow text-brick"}>
              {state.valid ? "Employer signature verified" : "Employer signature invalid"}
            </span>
            <h1 className="mt-3 font-sans font-medium text-ink text-[36px] md:text-[46px] leading-[1.04] tracking-[-0.03em]">
              One payroll row disclosed.
            </h1>
            <p className="mt-5 text-[14.5px] text-ink/70 leading-relaxed">
              This link reveals one selected payment from batch{" "}
              <span className="font-mono text-ink">{state.disclosure.packet.batchId}</span>.
              Other payroll rows remain hidden from this view.
            </p>

            <dl className="mt-10 border border-line bg-paper-3 rounded-[4px] divide-y divide-line">
              <DisclosureRow label="Employer" value={state.disclosure.packet.payer} />
              {row.recipientName?.trim() && (
                <DisclosureRow label="Name" value={row.recipientName.trim()} />
              )}
              <DisclosureRow label="Recipient" value={row.recipient} />
              <DisclosureRow
                label="Amount"
                value={`${formatPayrollAmount(row.amount, state.disclosure.packet.decimals)} ${state.disclosure.packet.symbol}`}
              />
              <DisclosureRow label="Memo" value={row.memo || "No memo"} />
              <DisclosureRow label="Mode" value={row.mode} />
              <DisclosureRow label="Status" value={row.status} />
              {row.txSignature && (
                <div className="px-5 md:px-6 py-4 grid grid-cols-[130px_1fr] gap-4">
                  <dt className="mono-chip text-dim">Umbra tx</dt>
                  <dd className="font-mono text-[13px] break-all">
                    <a
                      href={payrollExplorerTxUrl(row.txSignature, NETWORK)}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-2 hover:text-sage"
                    >
                      {row.txSignature}
                    </a>
                  </dd>
                </div>
              )}
            </dl>
          </div>
        )}
      </section>
    </main>
  );
}

function DisclosureRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-5 md:px-6 py-4 grid grid-cols-[130px_1fr] gap-4">
      <dt className="mono-chip text-dim">{label}</dt>
      <dd className="font-mono text-[13px] text-ink break-all">{value}</dd>
    </div>
  );
}
