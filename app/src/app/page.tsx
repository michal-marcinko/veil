"use client";

import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";

export default function LandingPage() {
  return (
    <main className="min-h-screen relative overflow-hidden">
      {/* Top-left: wordmark */}
      <div className="absolute top-8 left-8 z-10 flex items-baseline gap-4">
        <span className="font-serif text-2xl tracking-[0.22em]">VEIL</span>
        <span className="mono-chip hidden md:inline">private invoicing, shipped on mainnet</span>
      </div>

      {/* Top-right: specimen marker */}
      <div className="absolute top-8 right-8 z-10 text-right">
        <div className="mono-chip">№ 01 — Specimen</div>
      </div>

      {/* Hero */}
      <section className="min-h-screen flex items-center px-6 md:px-16 lg:px-24 pt-28 pb-36">
        <div className="max-w-[920px]">
          <h1 className="font-serif leading-[0.94] tracking-tightest text-[56px] sm:text-[76px] md:text-[104px] animate-fade-up">
            <span className="block">Private</span>
            <span className="block italic">invoicing,</span>
            <span className="block">built for Solana's</span>
            <span className="block">payroll economy.</span>
          </h1>

          <p
            className="mt-10 max-w-xl text-muted text-lg md:text-xl leading-[1.55] animate-fade-up"
            style={{ animationDelay: "220ms" }}
          >
            Business-grade confidentiality on mainnet. Amounts encrypted under{" "}
            <span className="text-cream">Arcium MPC</span>, counterparty linkage broken by a{" "}
            <span className="text-cream">ZK mixer</span>, selective disclosure for accountants and regulators.
          </p>

          <ol
            className="mt-14 space-y-3.5 font-mono text-[13px] animate-fade-up"
            style={{ animationDelay: "420ms" }}
          >
            {[
              ["I", "Amounts hidden onchain via Umbra + Arcium MPC."],
              ["II", "Counterparty unlinkability through a UTXO mixer."],
              ["III", "Auditor access via X25519 compliance grants."],
            ].map(([n, label]) => (
              <li key={n} className="flex gap-6 items-baseline">
                <span className="text-gold w-8 shrink-0 tabular-nums">{n}</span>
                <span className="text-muted">{label}</span>
              </li>
            ))}
          </ol>

          <div
            className="mt-16 flex flex-wrap items-center gap-4 animate-fade-up"
            style={{ animationDelay: "620ms" }}
          >
            <a href="/create" className="btn-primary">
              Create invoice <span aria-hidden>→</span>
            </a>
            <a href="/dashboard" className="btn-ghost">
              Dashboard
            </a>
          </div>
        </div>
      </section>

      {/* Bottom-left: colophon */}
      <div className="absolute bottom-8 left-8 z-10 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-[11px] font-mono tracking-[0.15em] uppercase text-dim">
        <span>Colosseum Frontier 26</span>
        <span className="text-line-2">·</span>
        <span>Devnet · mainnet pending</span>
        <span className="text-line-2">·</span>
        <span>v0.1 α</span>
      </div>

      {/* Bottom-right: connect */}
      <div className="absolute bottom-6 right-6 md:bottom-8 md:right-8 z-10">
        <ClientWalletMultiButton />
      </div>
    </main>
  );
}
