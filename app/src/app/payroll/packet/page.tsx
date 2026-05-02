"use client";

import { useEffect, useState } from "react";
import { VeilLogo } from "@/components/VeilLogo";
import {
  decodePayrollPacket,
  formatPayrollAmount,
  payrollExplorerTxUrl,
  verifyPayrollPacket,
  type SignedPayrollPacket,
} from "@/lib/private-payroll";
import { NETWORK } from "@/lib/constants";

type State =
  | { kind: "loading" }
  | { kind: "error"; reason: string }
  | { kind: "ok"; signed: SignedPayrollPacket; valid: boolean };

export default function PayrollPacketPage() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    (async () => {
      try {
        const hash = window.location.hash.slice(1);
        if (!hash) {
          setState({ kind: "error", reason: "Payroll packet link is missing its URL fragment." });
          return;
        }
        const signed = decodePayrollPacket(hash);
        const valid = await verifyPayrollPacket(signed);
        setState({ kind: "ok", signed, valid });
      } catch (err: any) {
        setState({ kind: "error", reason: err.message ?? String(err) });
      }
    })();
  }, []);

  return (
    <main className="min-h-screen relative pb-32">
      <nav className="sticky top-0 z-10 backdrop-blur-sm bg-paper/80 border-b border-line">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between px-6 md:px-8 py-4">
          <VeilLogo tagline="payroll packet verifier" />
        </div>
      </nav>

      <section className="max-w-[1400px] mx-auto px-6 md:px-8 pt-16 md:pt-20">
        {state.kind === "loading" && <p className="text-[13.5px] text-muted">Verifying packet...</p>}

        {state.kind === "error" && (
          <div className="max-w-xl border-l-2 border-brick pl-5 py-3">
            <span className="mono-chip text-brick">Invalid packet</span>
            <p className="mt-3 text-[14px] text-ink/80">{state.reason}</p>
          </div>
        )}

        {state.kind === "ok" && (
          <div className="max-w-4xl reveal">
            <span className={state.valid ? "eyebrow text-sage" : "eyebrow text-brick"}>
              {state.valid ? "Signature verified" : "Signature invalid"}
            </span>
            <h1 className="mt-3 font-sans font-medium text-ink text-[36px] md:text-[46px] leading-[1.04] tracking-[-0.03em]">
              Private payroll packet.
            </h1>
            <p className="mt-5 max-w-2xl text-[14.5px] text-ink/70 leading-relaxed">
              Full disclosure packet for batch{" "}
              <span className="font-mono text-ink">{state.signed.packet.batchId}</span>. This
              view intentionally reveals every recipient, amount, memo, and Umbra payment
              transaction contained in the signed packet.
            </p>

            <div className="mt-10 grid grid-cols-1 md:grid-cols-4 gap-4">
              <Stat label="Payer" value={truncate(state.signed.packet.payer, 7)} />
              <Stat label="Rows" value={state.signed.packet.rows.length.toString()} />
              <Stat label="Paid" value={state.signed.packet.rows.filter((r) => r.status === "paid").length.toString()} />
              <Stat label="Mint" value={state.signed.packet.symbol} />
            </div>

            <ul className="mt-10 border border-line bg-paper-3 rounded-[4px] divide-y divide-line">
              {state.signed.packet.rows.map((row, idx) => (
                <li key={`${row.recipient}-${idx}`} className="px-5 md:px-6 py-4">
                  <div className="grid grid-cols-[1.5rem_1fr_auto] gap-4 items-baseline">
                    <span className="font-mono text-[11px] text-dim tnum">
                      {String(idx + 1).padStart(2, "0")}
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap gap-x-3 gap-y-1 items-baseline">
                        <span className="font-mono text-[13px] text-ink truncate">
                          {row.recipient}
                        </span>
                        <span className="text-[13px] text-ink/80 tnum">
                          {formatPayrollAmount(row.amount, state.signed.packet.decimals)}{" "}
                          {state.signed.packet.symbol}
                        </span>
                        <span className="mono-chip text-dim">{row.mode}</span>
                      </div>
                      <p className="mt-1 text-[12.5px] text-muted">{row.memo || "No memo"}</p>
                      {row.error && <p className="mt-2 text-[12px] text-brick">{row.error}</p>}
                    </div>
                    <span className={row.status === "paid" ? "mono-chip text-sage" : "mono-chip text-brick"}>
                      {row.status}
                    </span>
                  </div>
                  {row.txSignature && (
                    <a
                      href={payrollExplorerTxUrl(row.txSignature, NETWORK)}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-3 ml-10 inline-block btn-quiet text-[12px]"
                    >
                      Open Umbra tx
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-line bg-paper-3 rounded-[4px] p-5">
      <span className="eyebrow">{label}</span>
      <div className="mt-2 font-mono text-[13px] text-ink truncate">{value}</div>
    </div>
  );
}

function truncate(value: string, keep: number): string {
  return value.length <= keep * 2 + 3 ? value : `${value.slice(0, keep)}...${value.slice(-keep)}`;
}
