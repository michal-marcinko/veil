"use client";

// ---------------------------------------------------------------------------
// /dashboard/compliance — generate a scoped auditor link.
//
// FLOW (replaces the prior X25519-pubkey + master-sig-in-URL form):
//   1. Alice picks mint (defaults to PAYMENT_MINT) + a date range.
//   2. Click "Generate auditor link":
//      a. Fetch all of Alice's invoices on-chain.
//      b. Filter to (mint, createdAt within range).
//      c. Pop one wallet sign (cached) to load the metadata master sig.
//      d. Re-encrypt those invoices' metadata under a fresh ephemeral key K
//         and upload to Arweave (auditor-links.generateScopedGrant).
//      e. Render the URL: /audit/grant/<grantId>#k=<base58 K>&inv=<csv>
//   3. Alice clicks "Copy" and sends the URL to her auditor over Signal /
//      encrypted email. The on-chain Umbra grant from the prior flow is
//      no longer required for access — the URL stands on its own.
//
// The legacy on-chain grant list (`GrantList` + `revokeComplianceGrant`)
// is preserved below as a historical record of grants issued through
// the prior flow. New grants no longer mint an on-chain Umbra grant by
// default; the URL is the access mechanism.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { VeilLogo } from "@/components/VeilLogo";
import { GrantList } from "@/components/GrantList";
import {
  getOrCreateClient,
  listComplianceGrants,
  revokeComplianceGrant,
  type GrantWithStatus,
} from "@/lib/umbra";
import { getOrCreateMetadataMasterSig } from "@/lib/encryption";
import { fetchInvoicesByCreator } from "@/lib/anchor";
import {
  buildScopedGrantUrl,
  generateScopedGrant,
  type InScopeInvoice,
} from "@/lib/auditor-links";
import { USDC_MINT, PAYMENT_SYMBOL } from "@/lib/constants";

interface GrantPreview {
  /** Generated audit URL with ephemeral key in the fragment. */
  url: string;
  /** How many invoices are reachable from this URL. */
  invoiceCount: number;
  /** How many in-scope invoices were skipped (e.g. fetch failure). */
  skippedCount: number;
  /** What scope produced this grant (echoed in UI for clarity). */
  scope: { mint: string; from: string; to: string };
}

export default function CompliancePage() {
  const wallet = useWallet();
  const [submitting, setSubmitting] = useState(false);
  const [progressMsg, setProgressMsg] = useState<string | null>(null);
  const [preview, setPreview] = useState<GrantPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Scope inputs.
  const [mint, setMint] = useState<string>(USDC_MINT.toBase58());
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");

  // Legacy on-chain grant ledger.
  const [grants, setGrants] = useState<GrantWithStatus[]>([]);
  const [grantsLoading, setGrantsLoading] = useState(false);
  const [revokingKey, setRevokingKey] = useState<string | null>(null);

  const refreshGrants = useCallback(async () => {
    if (!wallet.connected) {
      setGrants([]);
      return;
    }
    setGrantsLoading(true);
    try {
      const client = await getOrCreateClient(wallet as any);
      const list = await listComplianceGrants({ client });
      setGrants(list);
    } catch (err: any) {
      setError(`Failed to load on-chain grants: ${err.message ?? String(err)}`);
    } finally {
      setGrantsLoading(false);
    }
  }, [wallet]);

  useEffect(() => {
    void refreshGrants();
  }, [refreshGrants]);

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    if (!wallet.publicKey) return;
    setSubmitting(true);
    setError(null);
    setPreview(null);
    setProgressMsg("Loading your invoices…");
    try {
      // 1. Read all of the granter's invoices from chain.
      const allInvoices = await fetchInvoicesByCreator(
        wallet as any,
        wallet.publicKey,
      );

      // 2. Apply the chosen scope (mint + createdAt range). Date inputs
      //    are local-zone strings (YYYY-MM-DD); we convert to UTC unix
      //    seconds and treat both bounds inclusively when present.
      const fromTs = fromDate ? Math.floor(Date.parse(`${fromDate}T00:00:00Z`) / 1000) : null;
      const toTs = toDate ? Math.floor(Date.parse(`${toDate}T23:59:59Z`) / 1000) : null;
      const inScope = allInvoices.filter((inv) => {
        if (mint && inv.account.mint.toBase58() !== mint) return false;
        const ts = inv.account.createdAt;
        if (fromTs != null && ts < fromTs) return false;
        if (toTs != null && ts > toTs) return false;
        return true;
      });

      if (inScope.length === 0) {
        setError(
          "No invoices match the selected scope. Adjust the mint or date range and try again.",
        );
        setProgressMsg(null);
        return;
      }

      setProgressMsg(
        `Re-encrypting ${inScope.length} invoice${inScope.length === 1 ? "" : "s"}…`,
      );

      // 3. Master sig (1 popup, cached after first use). Used in-process
      //    only — never embedded in the URL.
      const masterSig = await getOrCreateMetadataMasterSig(
        wallet as any,
        wallet.publicKey.toBase58(),
      );

      // 4. Re-encrypt + upload to Arweave under a fresh ephemeral key.
      const inScopeArg: InScopeInvoice[] = inScope.map((inv) => ({
        invoicePda: inv.publicKey.toBase58(),
        metadataUri: inv.account.metadataUri,
        metadataHash: inv.account.metadataHash,
      }));
      const payload = await generateScopedGrant({
        masterSig,
        invoices: inScopeArg,
      });

      // 5. Build a URL that carries the ephemeral key in the fragment.
      const grantId = `grant_${Date.now().toString(36)}`;
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      const url = buildScopedGrantUrl({ origin, grantId, payload });

      setPreview({
        url,
        invoiceCount: payload.invoiceUris.length,
        skippedCount: inScope.length - payload.invoiceUris.length,
        scope: {
          mint,
          from: fromDate || "(any)",
          to: toDate || "(any)",
        },
      });
      setProgressMsg(null);
    } catch (err: any) {
      setError(err.message ?? String(err));
      setProgressMsg(null);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRevoke(grant: GrantWithStatus) {
    const key = `${grant.receiverX25519Base58}:${grant.nonce}`;
    setRevokingKey(key);
    setError(null);
    try {
      const client = await getOrCreateClient(wallet as any);
      await revokeComplianceGrant({ client, grant });
      await refreshGrants();
    } catch (err: any) {
      setError(`Revoke failed: ${err.message ?? String(err)}`);
    } finally {
      setRevokingKey(null);
    }
  }

  if (!wallet.connected) {
    return (
      <Shell>
        <div className="max-w-lg reveal">
          <span className="eyebrow">Auditor links</span>
          <h1 className="mt-4 font-sans font-medium text-ink text-[36px] md:text-[44px] leading-[1.05] tracking-[-0.025em]">
            Connect to generate auditor links.
          </h1>
          <div className="mt-8">
            <ClientWalletMultiButton />
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="max-w-2xl reveal">
        <span className="eyebrow">Auditor links</span>
        <h1 className="mt-3 font-sans font-medium text-ink text-[36px] md:text-[44px] leading-[1.05] tracking-[-0.025em]">
          Grant scoped read access.
        </h1>
        <p className="mt-5 text-[15px] leading-[1.55] text-ink/70 max-w-xl">
          Pick a mint and a date range. We re-encrypt only the matching invoices
          under a fresh per-grant key and give you a link to share with your
          auditor. The link is the only way to read this scope; your wallet&apos;s
          master key never leaves the browser.
        </p>

        {error && (
          <div className="mt-8 flex items-start gap-4 border-l-2 border-brick pl-4 py-2 max-w-xl">
            <span className="mono-chip text-brick shrink-0 pt-0.5">Error</span>
            <span className="text-[13.5px] text-ink leading-relaxed flex-1">{error}</span>
          </div>
        )}

        <form onSubmit={handleGenerate} className="mt-10 space-y-8">
          <Field label="Mint">
            <input
              value={mint}
              onChange={(e) => setMint(e.target.value)}
              placeholder="base58 SPL mint"
              className="input-editorial font-mono text-sm"
              required
            />
            <FieldHint>
              Defaults to your configured payment mint ({PAYMENT_SYMBOL}). Change
              to scope the grant to invoices in a different token.
            </FieldHint>
          </Field>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Field label="From (UTC)" optional>
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="input-editorial font-mono text-sm"
              />
            </Field>
            <Field label="To (UTC)" optional>
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="input-editorial font-mono text-sm"
              />
            </Field>
          </div>

          <div className="flex items-center gap-4">
            <button
              type="submit"
              disabled={submitting}
              className="btn-primary md:min-w-[280px]"
            >
              {submitting ? (
                <span className="inline-flex items-center gap-3">
                  <span className="h-1.5 w-1.5 rounded-full bg-paper animate-slow-pulse" />
                  {progressMsg ?? "Generating link…"}
                </span>
              ) : (
                <span>
                  Generate auditor link <span aria-hidden>→</span>
                </span>
              )}
            </button>
            {progressMsg && !submitting && (
              <span className="font-mono text-[12px] text-muted">{progressMsg}</span>
            )}
          </div>
        </form>

        {preview && <PreviewCard preview={preview} />}

        <ScopeNote />

        <div className="mt-12 pt-8 border-t border-line">
          <span className="eyebrow">Legacy on-chain grants</span>
          <p className="mt-3 text-[13px] text-ink/70 max-w-xl">
            On-chain Umbra compliance grants issued through the prior flow.
            Revoking these prevents future on-chain shielded-pool disclosures
            but does not affect any auditor URLs you have already generated.
          </p>
          <div className="mt-6">
            {grantsLoading ? (
              <div className="text-[13px] text-dim">Loading grants…</div>
            ) : (
              <GrantList
                grants={grants}
                onRevoke={handleRevoke}
                revokingKey={revokingKey}
              />
            )}
          </div>
        </div>
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// UI bits
// ---------------------------------------------------------------------------

function PreviewCard({ preview }: { preview: GrantPreview }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(preview.url);
      } else if (typeof document !== "undefined") {
        const ta = document.createElement("textarea");
        ta.value = preview.url;
        ta.setAttribute("readonly", "");
        ta.style.position = "absolute";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="mt-10 border border-sage/40 bg-sage/5 rounded-[3px] p-5 md:p-6 max-w-xl">
      <div className="flex items-baseline justify-between mb-4">
        <span className="eyebrow text-sage">Auditor link ready</span>
        <span className="font-mono text-[11px] text-dim tnum">
          {String(preview.invoiceCount).padStart(2, "0")} invoice
          {preview.invoiceCount === 1 ? "" : "s"}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <input
          readOnly
          value={preview.url}
          onFocus={(e) => e.currentTarget.select()}
          onClick={(e) => e.currentTarget.select()}
          className="flex-1 input-editorial font-mono text-[12px] select-all"
          aria-label="Auditor URL"
        />
        <button
          type="button"
          onClick={copy}
          className="shrink-0 px-4 py-2 border border-line rounded-[3px] font-mono text-[11px] tracking-[0.12em] uppercase text-ink hover:bg-ink hover:text-paper transition-colors"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <dl className="mt-5 space-y-2 text-[12.5px] font-mono border-t border-line pt-4">
        <ResultRow
          label="Scope"
          value={`mint ${truncateMid(preview.scope.mint)} · ${preview.scope.from} → ${preview.scope.to}`}
        />
        {preview.skippedCount > 0 && (
          <ResultRow
            label="Skipped"
            value={`${preview.skippedCount} invoice${preview.skippedCount === 1 ? "" : "s"} (fetch or hash mismatch)`}
          />
        )}
      </dl>
      <p className="mt-4 font-mono text-[11px] leading-relaxed text-muted">
        Send this link to your auditor over a trusted channel (Signal, encrypted
        email). The fragment after <span className="text-ink">#</span> carries
        the decryption key and never reaches our servers.
      </p>
    </div>
  );
}

function ScopeNote() {
  return (
    <details className="mt-8 max-w-xl border-l-2 border-line/60 pl-4">
      <summary className="cursor-pointer font-mono text-[11.5px] tracking-[0.12em] uppercase text-muted hover:text-ink transition-colors">
        What &ldquo;scoped&rdquo; means here
      </summary>
      <div className="mt-3 space-y-2 text-[12.5px] text-ink/75 leading-relaxed">
        <p>
          The link only references the invoices you selected — we re-encrypt
          them under a one-off key and upload those re-encrypted blobs. The
          auditor cannot reach invoices outside the scope from this link.
        </p>
        <p>
          What we don&apos;t implement: zero-knowledge selective disclosure or
          cryptographic time-bounding. Arweave is permanent, so anyone who
          retains the URL retains read access. To &ldquo;revoke&rdquo; a grant,
          stop sharing the link; the per-grant key has no other purpose.
        </p>
      </div>
    </details>
  );
}

function ResultRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-4">
      <dt className="text-dim uppercase tracking-[0.12em] text-[10.5px] w-20 shrink-0">
        {label}
      </dt>
      <dd className="text-ink break-all flex-1">{value}</dd>
    </div>
  );
}

function Field({
  label,
  optional,
  children,
}: {
  label: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-3">
        <label className="mono-chip">{label}</label>
        {optional && (
          <span className="font-mono text-[10px] tracking-[0.16em] uppercase text-dim">
            Optional
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function FieldHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[12px] text-dim font-sans leading-relaxed mt-1.5">
      {children}
    </div>
  );
}

function truncateMid(s: string, keep = 6): string {
  if (s.length <= keep * 2 + 1) return s;
  return `${s.slice(0, keep)}…${s.slice(-keep)}`;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen relative pb-32">
      <nav className="sticky top-0 z-10 backdrop-blur-sm bg-paper/80 border-b border-line">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between px-6 md:px-8 py-4">
          <VeilLogo />
          <div className="flex items-center gap-1 md:gap-2">
            <a
              href="/create"
              className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors"
            >
              Create
            </a>
            <a
              href="/dashboard"
              className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors"
            >
              Dashboard
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
