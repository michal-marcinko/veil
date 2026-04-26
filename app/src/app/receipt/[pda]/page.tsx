"use client";

import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import {
  decodeReceipt,
  verifyReceiptSignature,
  type SignedReceipt,
} from "@/lib/receipt";
import { fetchInvoicePublic } from "@/lib/anchor";
import { VeilLogo } from "@/components/VeilLogo";

type VerifyState =
  | { kind: "loading" }
  | { kind: "ok"; signed: SignedReceipt }
  | { kind: "error"; reason: string };

function explorerTxUrl(sig: string): string {
  // Devnet by default — a `?cluster=devnet` query string makes the link work
  // regardless of which cluster the user's Solana Explorer remembers.
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

function formatTimestamp(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function truncate(s: string, keep = 6): string {
  if (s.length <= keep * 2 + 3) return s;
  return `${s.slice(0, keep)}…${s.slice(-keep)}`;
}

export default function ReceiptPage({ params }: { params: { pda: string } }) {
  const [state, setState] = useState<VerifyState>({ kind: "loading" });

  useEffect(() => {
    (async () => {
      try {
        // 1. Parse the blob from the URL fragment.
        const hash = window.location.hash;
        if (!hash || hash.length < 2) {
          setState({ kind: "error", reason: "Receipt link is missing its signed blob (no URL fragment)." });
          return;
        }
        let signed: SignedReceipt;
        try {
          signed = decodeReceipt(hash.slice(1));
        } catch (err: any) {
          setState({ kind: "error", reason: `Malformed receipt blob: ${err.message ?? String(err)}` });
          return;
        }

        // 2. Route param must match the receipt's invoicePda.
        if (signed.receipt.invoicePda !== params.pda) {
          setState({
            kind: "error",
            reason: "Receipt is for a different invoice than the URL path claims.",
          });
          return;
        }

        // 3. Verify the ed25519 signature.
        const sigOk = await verifyReceiptSignature(signed);
        if (!sigOk) {
          setState({ kind: "error", reason: "Signature is invalid — this receipt was not signed by the claimed payer." });
          return;
        }

        // 4. Fetch the on-chain invoice (no wallet required).
        let invoice: any;
        try {
          invoice = await fetchInvoicePublic(new PublicKey(params.pda));
        } catch (err: any) {
          setState({
            kind: "error",
            reason: `Could not fetch invoice from chain: ${err.message ?? String(err)}`,
          });
          return;
        }

        // 5. Status must be Paid.
        if (!("paid" in (invoice.status as any))) {
          setState({
            kind: "error",
            reason: "Invoice on-chain status is not Paid — receipt cannot be validated.",
          });
          return;
        }

        // 6. utxo_commitment must be non-zero (i.e. the creator acknowledged a claim).
        const rawCommitment = invoice.utxoCommitment;
        const commitment = rawCommitment ? new Uint8Array(rawCommitment as any) : new Uint8Array();
        const allZero = commitment.length === 0 || commitment.every((b) => b === 0);
        if (allZero) {
          setState({
            kind: "error",
            reason: "Invoice is marked paid but utxo_commitment is empty.",
          });
          return;
        }

        setState({ kind: "ok", signed });
      } catch (err: any) {
        setState({ kind: "error", reason: `Unexpected error: ${err.message ?? String(err)}` });
      }
    })();
  }, [params.pda]);

  return (
    <main className="min-h-screen relative pb-32">
      <nav className="sticky top-0 z-10 backdrop-blur-sm bg-paper/80 border-b border-line">
        <div className="max-w-[1100px] mx-auto flex items-center justify-between px-6 md:px-8 py-4">
          <VeilLogo tagline="payment receipt verifier" />
        </div>
      </nav>

      <section className="max-w-[1100px] mx-auto px-6 md:px-8 pt-16 md:pt-20">
        <div className="max-w-xl mx-auto">
          {state.kind === "loading" && (
            <div className="text-[13.5px] text-muted">Verifying receipt…</div>
          )}

          {state.kind === "error" && (
            <div>
              <div className="border-l-2 border-brick pl-5 py-3">
                <div className="mono-chip text-brick mb-2">Invalid receipt</div>
                <div className="text-[14.5px] text-ink leading-relaxed">{state.reason}</div>
              </div>
              <p className="mt-6 text-[12px] font-mono tracking-[0.1em] uppercase text-dim">
                Invoice PDA · {truncate(params.pda)}
              </p>
            </div>
          )}

          {state.kind === "ok" && (
            <div>
              <span className="eyebrow">Receipt verified</span>
              <h1 className="mt-4 font-sans font-medium text-ink text-[32px] md:text-[38px] leading-[1.05] tracking-[-0.025em]">
                Valid receipt.
              </h1>
              <p className="mt-4 text-[14.5px] text-ink/70 leading-relaxed">
                This receipt signature is valid and the invoice is marked paid on-chain.
                Amount not disclosed.
              </p>

              <dl className="mt-10 border-t border-line divide-y divide-line">
                <div className="py-4 grid grid-cols-[140px_1fr] gap-4">
                  <dt className="text-[12px] font-mono tracking-[0.1em] uppercase text-dim">Invoice</dt>
                  <dd className="text-[13.5px] font-mono text-ink break-all">
                    {state.signed.receipt.invoicePda}
                  </dd>
                </div>
                <div className="py-4 grid grid-cols-[140px_1fr] gap-4">
                  <dt className="text-[12px] font-mono tracking-[0.1em] uppercase text-dim">Paid by</dt>
                  <dd className="text-[13.5px] font-mono text-ink break-all">
                    {state.signed.receipt.payerPubkey}
                  </dd>
                </div>
                <div className="py-4 grid grid-cols-[140px_1fr] gap-4">
                  <dt className="text-[12px] font-mono tracking-[0.1em] uppercase text-dim">Timestamp</dt>
                  <dd className="text-[13.5px] text-ink">
                    {formatTimestamp(state.signed.receipt.timestamp)}
                  </dd>
                </div>
                <div className="py-4 grid grid-cols-[140px_1fr] gap-4">
                  <dt className="text-[12px] font-mono tracking-[0.1em] uppercase text-dim">Payment intent</dt>
                  <dd className="text-[13.5px] font-mono text-ink break-all">
                    <a
                      href={explorerTxUrl(state.signed.receipt.markPaidTxSig)}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-2 hover:text-sage"
                    >
                      {truncate(state.signed.receipt.markPaidTxSig, 10)}
                    </a>
                  </dd>
                </div>
                <div className="py-4 grid grid-cols-[140px_1fr] gap-4">
                  <dt className="text-[12px] font-mono tracking-[0.1em] uppercase text-dim">Amount</dt>
                  <dd className="text-[13.5px] text-ink italic">
                    Not disclosed by receipt verifier
                  </dd>
                </div>
              </dl>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
