// ---------------------------------------------------------------------------
// /verify/[pda] — public verifier route.
//
// Capability-URL gate: the route renders a verdict only when the URL fragment
// `#k=<token>` matches `base58(metadataHash[0..6])` for the on-chain Invoice
// account. Without it, we render an empty "paste a Veil verification link"
// form. Per W3C TAG capability-URL guidance, the fragment never reaches the
// server — it stays client-side, so server access logs cannot record it.
//
// IMPORTANT — server access logs may still record the URL PATH (the PDA).
// Full log redaction requires the hosting platform's request-log transform
// (Vercel headers or Railway log transforms — out of scope for app code).
// We add `Cache-Control: no-store` via middleware so CDNs don't cache verdicts,
// and `<meta name="robots" content="noindex,nofollow">` to prevent search-
// engine indexing (the documented leak vector for capability URLs).
//
// The route does NOT decrypt invoice contents. It attests on-chain status
// only. For amounts and line items, the invoice creator should issue a
// compliance grant via /dashboard/compliance.
// ---------------------------------------------------------------------------
"use client";

import { useEffect, useMemo, useState } from "react";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { VeilLogo } from "@/components/VeilLogo";
import { explorerTxUrl, explorerAddressUrl } from "@/lib/explorer";
import { INVOICE_REGISTRY_PROGRAM_ID, NETWORK, RPC_URL } from "@/lib/constants";
import { deriveLockPda } from "@/lib/lock-derivation";
import idl from "@/lib/invoice_registry.json";
import type { InvoiceRegistry } from "@/lib/invoice_registry";

// Force dynamic rendering — we read the URL fragment client-side and the
// Cache-Control header gets set in middleware. Static generation here would
// just be wrong for a per-PDA verdict page.
export const dynamic = "force-dynamic";

type Verdict =
  | { kind: "loading" }
  | { kind: "no_token" }
  | { kind: "bad_token" }
  | { kind: "missing_invoice" }
  | { kind: "error"; reason: string }
  | {
      kind: "ok";
      status: "paid" | "settling" | "unpaid";
      payerPubkey: string | null;
      lockedAt: number | null;
      createdAt: number;
      paidAt: number | null;
      // Best-effort tx signatures: we do not always have the payment-tx
      // signature for the lock (it lives in the lock-creating tx, which
      // we'd need to discover via getSignaturesForAddress). For a hackathon
      // verifier the lock + invoice statuses alone are the verdict.
    };

function shortPda(s: string, head = 6, tail = 6): string {
  if (s.length <= head + tail + 2) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function formatTimestamp(unixSeconds: number): string {
  return (
    new Date(unixSeconds * 1000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19) + " UTC"
  );
}

function bnToNumber(val: any): number {
  if (val == null) return 0;
  if (typeof val === "number") return val;
  if (typeof val === "bigint") return Number(val);
  if (typeof val.toNumber === "function") return val.toNumber();
  return Number(val);
}

/**
 * Read-only Anchor program. Mirrors the helper in `lib/anchor.ts` but
 * stays inline here to avoid making the verifier depend on the
 * wallet-flavoured module (which Subagent A owns).
 */
function getReadOnlyProgram() {
  const connection = new Connection(RPC_URL, "confirmed");
  const readOnlyWallet = {
    publicKey: PublicKey.default,
    signTransaction: async () => {
      throw new Error("verify: read-only provider");
    },
    signAllTransactions: async () => {
      throw new Error("verify: read-only provider");
    },
  };
  const provider = new AnchorProvider(connection as any, readOnlyWallet as any, {
    commitment: "confirmed",
  });
  // @ts-ignore Anchor 0.30 reads program id from idl.address
  return { connection, program: new Program(idl as any, provider) as Program<InvoiceRegistry> };
}

export default function VerifyPage({ params }: { params: { pda: string } }) {
  const [verdict, setVerdict] = useState<Verdict>({ kind: "loading" });
  const [pasteUrl, setPasteUrl] = useState("");

  const network = NETWORK;
  const lastVerifiedIso = useMemo(() => new Date().toISOString(), [verdict]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 1. Validate the PDA shape early.
        let pdaKey: PublicKey;
        try {
          pdaKey = new PublicKey(params.pda);
        } catch {
          if (!cancelled) setVerdict({ kind: "missing_invoice" });
          return;
        }

        // 2. Read the capability token from the URL fragment.
        const hash = typeof window !== "undefined" ? window.location.hash : "";
        const tokenMatch = hash.match(/[#&]k=([^&]+)/);
        if (!tokenMatch) {
          if (!cancelled) setVerdict({ kind: "no_token" });
          return;
        }
        const token = decodeURIComponent(tokenMatch[1]);

        // 3. Fetch the on-chain Invoice. INVOICE_REGISTRY_PROGRAM_ID is
        //    derived from env so we don't have to trust the URL.
        const { connection, program } = getReadOnlyProgram();
        let invoice: any;
        try {
          invoice = await (program.account as any).invoice.fetch(pdaKey);
        } catch (err: any) {
          const msg = (err?.message ?? String(err)).toLowerCase();
          if (
            msg.includes("account does not exist") ||
            msg.includes("could not find") ||
            msg.includes("accountnotfound")
          ) {
            if (!cancelled) setVerdict({ kind: "missing_invoice" });
            return;
          }
          if (!cancelled) {
            setVerdict({
              kind: "error",
              reason: `Could not fetch invoice from chain: ${err.message ?? String(err)}`,
            });
          }
          return;
        }

        // 4. Compare the token to base58(metadataHash[0..6]).
        const metadataHash: Uint8Array = new Uint8Array(invoice.metadataHash ?? []);
        if (metadataHash.length < 6) {
          if (!cancelled) setVerdict({ kind: "bad_token" });
          return;
        }
        const expected = bs58.encode(metadataHash.slice(0, 6));
        if (token !== expected) {
          if (!cancelled) setVerdict({ kind: "bad_token" });
          return;
        }

        // 5. Fetch the lock account (raw, then decode via Anchor coder).
        const lockPda = deriveLockPda(pdaKey);
        const lockInfo = await connection.getAccountInfo(lockPda, "confirmed");
        let payerPubkey: string | null = null;
        let lockedAt: number | null = null;
        if (lockInfo?.data) {
          try {
            const coder: any = (program.account as any).paymentIntentLock.coder.accounts;
            const decoded: any = coder.decode("paymentIntentLock", Buffer.from(lockInfo.data));
            payerPubkey = (decoded.payer as PublicKey).toBase58();
            lockedAt = bnToNumber(decoded.lockedAt);
          } catch (err) {
            // Decoding failed — the account exists but isn't shaped like a
            // lock. Treat as no lock.
            // eslint-disable-next-line no-console
            console.warn("[verify] failed to decode lock", err);
          }
        }

        // 6. Compose verdict.
        const status: "paid" | "settling" | "unpaid" =
          "paid" in (invoice.status as any)
            ? "paid"
            : payerPubkey
              ? "settling"
              : "unpaid";

        if (!cancelled) {
          setVerdict({
            kind: "ok",
            status,
            payerPubkey,
            lockedAt,
            createdAt: bnToNumber(invoice.createdAt),
            paidAt: invoice.paidAt == null ? null : bnToNumber(invoice.paidAt),
          });
        }
      } catch (err: any) {
        if (!cancelled) {
          setVerdict({
            kind: "error",
            reason: `Unexpected: ${err.message ?? String(err)}`,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params.pda]);

  function handlePasteSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!pasteUrl.trim()) return;
    try {
      const u = new URL(pasteUrl.trim());
      // Same-origin or absolute — either way, navigate.
      window.location.href = u.toString();
    } catch {
      // If the user pasted just a fragment, prefix with current path.
      window.location.href = `${window.location.pathname}${pasteUrl.trim().startsWith("#") ? "" : "#"}${pasteUrl.trim()}`;
    }
  }

  return (
    <main className="min-h-screen relative pb-32">
      {/* noindex / nofollow are set on the route-level layout via the
          static `metadata` export. Cache-Control: no-store is set in
          middleware so CDNs don't cache verdicts. */}
      <nav className="sticky top-0 z-10 backdrop-blur-sm bg-paper/80 border-b border-line">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between px-6 md:px-8 py-4">
          <VeilLogo tagline="payment verifier" />
        </div>
      </nav>

      <section className="max-w-[1400px] mx-auto px-6 md:px-8 pt-16 md:pt-20">
        <div className="max-w-xl mx-auto">
          {verdict.kind === "loading" && (
            <div className="text-[13.5px] text-muted">Verifying on-chain status…</div>
          )}

          {(verdict.kind === "no_token" || verdict.kind === "bad_token") && (
            <div>
              <span className="eyebrow">Verifier</span>
              <h1 className="mt-4 font-sans font-medium text-ink text-[28px] md:text-[34px] leading-[1.05] tracking-[-0.025em]">
                Paste a Veil verification link.
              </h1>
              <p className="mt-4 text-[13.5px] text-muted">
                {verdict.kind === "bad_token"
                  ? "This link's verification token doesn't match the invoice on-chain. The link may be malformed or for a different invoice."
                  : "Verification links carry a one-way capability token after the # in the URL. Without that token, this page cannot verify a payment."}
              </p>
              <form onSubmit={handlePasteSubmit} className="mt-8 flex flex-col gap-3">
                <textarea
                  value={pasteUrl}
                  onChange={(e) => setPasteUrl(e.target.value)}
                  placeholder="Paste the full /verify/<pda>#k=<token> URL"
                  className="w-full min-h-[80px] rounded border border-line bg-paper px-3 py-2 text-[13px] font-mono text-ink"
                />
                <button
                  type="submit"
                  className="self-start rounded border border-ink bg-ink text-paper px-4 py-2 text-[12.5px] tracking-[0.04em]"
                >
                  Verify
                </button>
              </form>
              <p className="mt-12 text-[12px] text-dim">
                Invoice PDA · {shortPda(params.pda, 8, 8)}
              </p>
            </div>
          )}

          {verdict.kind === "missing_invoice" && (
            <div>
              <div className="border-l-2 border-brick pl-5 py-3">
                <div className="mono-chip text-brick mb-2">Invoice not found</div>
                <div className="text-[14.5px] text-ink leading-relaxed">
                  No invoice with this PDA was found on {network}. The link may be malformed,
                  or the invoice may have been created on a different cluster.
                </div>
              </div>
              <p className="mt-6 text-[12px] font-mono tracking-[0.1em] uppercase text-dim">
                Invoice PDA · {shortPda(params.pda, 8, 8)}
              </p>
            </div>
          )}

          {verdict.kind === "error" && (
            <div>
              <div className="border-l-2 border-brick pl-5 py-3">
                <div className="mono-chip text-brick mb-2">Verifier error</div>
                <div className="text-[14.5px] text-ink leading-relaxed">{verdict.reason}</div>
              </div>
            </div>
          )}

          {verdict.kind === "ok" && (
            <div>
              <span className="eyebrow">On-chain verification</span>
              <h1 className="mt-4 font-sans font-medium text-ink text-[32px] md:text-[38px] leading-[1.05] tracking-[-0.025em]">
                {verdict.status === "paid"
                  ? "Paid · settled."
                  : verdict.status === "settling"
                    ? "Paid · settlement pending."
                    : "Not paid yet."}
              </h1>

              <div className="mt-5 inline-flex items-center gap-2.5">
                {verdict.status === "paid" ? (
                  <>
                    <span className="h-1.5 w-1.5 rounded-full bg-sage" />
                    <span className="font-mono text-[11px] tracking-[0.14em] uppercase text-sage">
                      Verified · paid
                    </span>
                  </>
                ) : verdict.status === "settling" ? (
                  <>
                    <span className="h-1.5 w-1.5 rounded-full bg-gold animate-slow-pulse" />
                    <span className="font-mono text-[11px] tracking-[0.14em] uppercase text-gold">
                      Verified · payment received
                    </span>
                  </>
                ) : (
                  <>
                    <span className="h-1.5 w-1.5 rounded-full bg-brick" />
                    <span className="font-mono text-[11px] tracking-[0.14em] uppercase text-brick">
                      Not paid
                    </span>
                  </>
                )}
              </div>

              <p className="mt-5 text-[14.5px] text-ink/70 leading-relaxed">
                {verdict.status === "paid"
                  ? `On-chain status is Paid${
                      verdict.payerPubkey
                        ? ` · payer ${shortPda(verdict.payerPubkey, 4, 4)}`
                        : ""
                    }${
                      verdict.lockedAt
                        ? ` · locked ${formatTimestamp(verdict.lockedAt).slice(0, 10)}`
                        : ""
                    }.`
                  : verdict.status === "settling"
                    ? `Payment lock recorded by ${
                        verdict.payerPubkey ? shortPda(verdict.payerPubkey, 4, 4) : "the payer"
                      }${
                        verdict.lockedAt
                          ? ` at ${formatTimestamp(verdict.lockedAt)}`
                          : ""
                      }. The creator's mark_paid transaction is still pending.`
                    : `The invoice was created at ${formatTimestamp(
                        verdict.createdAt,
                      )}. No payment has been recorded yet.`}
              </p>

              <dl className="mt-10 border-t border-line divide-y divide-line">
                <div className="py-4 grid grid-cols-[140px_1fr] gap-4">
                  <dt className="text-[12px] font-mono tracking-[0.1em] uppercase text-dim">
                    Invoice
                  </dt>
                  <dd className="text-[13.5px] font-mono text-ink break-all">
                    <a
                      href={explorerAddressUrl(params.pda)}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-2 hover:text-sage"
                    >
                      {params.pda}
                    </a>
                  </dd>
                </div>
                <div className="py-4 grid grid-cols-[140px_1fr] gap-4">
                  <dt className="text-[12px] font-mono tracking-[0.1em] uppercase text-dim">
                    Network
                  </dt>
                  <dd className="text-[13.5px] text-ink">{network}</dd>
                </div>
                <div className="py-4 grid grid-cols-[140px_1fr] gap-4">
                  <dt className="text-[12px] font-mono tracking-[0.1em] uppercase text-dim">
                    Created
                  </dt>
                  <dd className="text-[13.5px] text-ink">
                    {formatTimestamp(verdict.createdAt)}
                  </dd>
                </div>
                {verdict.payerPubkey && (
                  <div className="py-4 grid grid-cols-[140px_1fr] gap-4">
                    <dt className="text-[12px] font-mono tracking-[0.1em] uppercase text-dim">
                      Payer
                    </dt>
                    <dd className="text-[13.5px] font-mono text-ink break-all">
                      <a
                        href={explorerAddressUrl(verdict.payerPubkey)}
                        target="_blank"
                        rel="noreferrer"
                        className="underline underline-offset-2 hover:text-sage"
                      >
                        {verdict.payerPubkey}
                      </a>
                    </dd>
                  </div>
                )}
                {verdict.lockedAt && (
                  <div className="py-4 grid grid-cols-[140px_1fr] gap-4">
                    <dt className="text-[12px] font-mono tracking-[0.1em] uppercase text-dim">
                      Locked at
                    </dt>
                    <dd className="text-[13.5px] text-ink">
                      {formatTimestamp(verdict.lockedAt)}
                    </dd>
                  </div>
                )}
                {verdict.paidAt && (
                  <div className="py-4 grid grid-cols-[140px_1fr] gap-4">
                    <dt className="text-[12px] font-mono tracking-[0.1em] uppercase text-dim">
                      Paid at
                    </dt>
                    <dd className="text-[13.5px] text-ink">
                      {formatTimestamp(verdict.paidAt)}
                    </dd>
                  </div>
                )}
                <div className="py-4 grid grid-cols-[140px_1fr] gap-4">
                  <dt className="text-[12px] font-mono tracking-[0.1em] uppercase text-dim">
                    Last verified
                  </dt>
                  <dd className="text-[13.5px] text-ink">{lastVerifiedIso}</dd>
                </div>
              </dl>

              <p className="mt-12 text-[12px] text-dim leading-relaxed">
                This verifier confirms on-chain status only. For amounts and line-item details,
                the invoice creator can issue a compliance grant.
              </p>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
