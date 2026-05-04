"use client";

// ---------------------------------------------------------------------------
// /audit/[granter] — DEPRECATED ROUTE.
//
// The original audit URL embedded the granter's 64-byte metadata master
// signature in the URL fragment, which derived the per-invoice AES key
// for *every* invoice the granter had ever created. That undercut every
// claim about scoped/revocable viewing.
//
// The replacement lives at `/audit/grant/[grantId]` and embeds an
// ephemeral per-grant key + an explicit list of in-scope Arweave URIs.
// See `lib/auditor-links.ts` for the implementation.
//
// Anyone reaching this page from an old link gets a clear deprecation
// notice. We deliberately do NOT honour the old fragment payload here —
// that would silently re-enable the leak.
// ---------------------------------------------------------------------------

import { useParams } from "next/navigation";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { VeilLogo } from "@/components/VeilLogo";

export default function DeprecatedAuditPage() {
  const params = useParams();
  const granterParam =
    typeof params?.granter === "string"
      ? params.granter
      : Array.isArray(params?.granter)
        ? params.granter[0]
        : "";

  return (
    <Shell>
      <div className="max-w-2xl reveal">
        <span className="eyebrow text-brick">Deprecated link</span>
        <h1 className="mt-4 font-sans font-medium text-ink text-[36px] md:text-[44px] leading-[1.05] tracking-[-0.025em]">
          This audit link is no longer supported.
        </h1>
        <p className="mt-6 text-[14.5px] text-ink/75 leading-relaxed">
          The original audit URL format embedded the granter&apos;s wallet master
          signature in the link, which would have given the holder access to
          every invoice that wallet has ever created — past, present, and
          future. We replaced it with a scoped flow that only covers the
          invoices the granter explicitly chose to share.
        </p>
        <p className="mt-4 text-[14.5px] text-ink/75 leading-relaxed">
          Ask the granter
          {granterParam ? (
            <>
              {" "}
              <span className="font-mono text-ink">{truncate(granterParam, 6)}</span>
            </>
          ) : null}{" "}
          to issue a new auditor link from{" "}
          <span className="font-mono text-ink">/dashboard/compliance</span>. The
          new link will live at <span className="font-mono text-ink">/audit/grant/&lt;id&gt;</span>.
        </p>

        <div className="mt-10 border-l-2 border-line/60 pl-4">
          <span className="font-mono text-[11.5px] tracking-[0.12em] uppercase text-muted">
            Why we changed this
          </span>
          <ul className="mt-3 space-y-2 text-[13px] text-ink/70 leading-relaxed list-disc pl-4">
            <li>
              The fragment-embedded master sig decrypted everything, not just
              the agreed scope.
            </li>
            <li>
              Revocation was theatre — the auditor still held the key after
              an on-chain &ldquo;revoke&rdquo;.
            </li>
            <li>
              Scoped grants narrow access to a chosen mint and date range and
              use a fresh per-grant key that has no purpose outside the link.
            </li>
          </ul>
        </div>
      </div>
    </Shell>
  );
}

function truncate(s: string, keep = 6): string {
  if (s.length <= keep * 2 + 1) return s;
  return `${s.slice(0, keep)}…${s.slice(-keep)}`;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen relative pb-32">
      <nav className="sticky top-0 z-10 backdrop-blur-sm bg-paper/80 border-b border-line">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between px-6 md:px-8 py-4">
          <VeilLogo tagline="auditor view" />
          <ClientWalletMultiButton />
        </div>
      </nav>
      <section className="max-w-[1400px] mx-auto px-6 md:px-8 pt-16">{children}</section>
    </main>
  );
}
