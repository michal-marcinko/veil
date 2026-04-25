"use client";

import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { CipherAmount } from "@/components/CipherAmount";

const STEPS = [
  {
    k: "01",
    title: "Your browser encrypts the amount",
    body: "Before anything reaches Solana, the amount is sealed with a key only you and your client can open.",
  },
  {
    k: "02",
    title: "Settled while still encrypted",
    body: "Arcium's MPC network verifies the transfer without any single node ever decrypting the amount. Your USDC arrives. Nobody else learns how much.",
  },
  {
    k: "03",
    title: "You decide who else can read it",
    body: "Generate an auditor key for your accountant, a client, or a regulator. They see exactly the invoices you grant — nothing more.",
  },
];

export default function LandingPage() {
  return (
    <main className="relative min-h-screen">
      {/* Nav */}
      <nav className="relative z-20 max-w-[1200px] mx-auto px-6 md:px-8 pt-6 flex items-center justify-between">
        <a href="/" className="flex items-baseline gap-3">
          <span className="font-sans font-semibold text-[17px] tracking-[-0.02em] text-ink">
            Veil
          </span>
          <span className="hidden sm:inline font-mono text-[10.5px] tracking-[0.08em] text-muted">
            — private invoicing
          </span>
        </a>
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
          <a
            href="https://github.com"
            className="hidden md:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors"
          >
            Docs
          </a>
          <div className="ml-2">
            <ClientWalletMultiButton />
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative z-10 max-w-[1200px] mx-auto px-6 md:px-8 pt-20 md:pt-28 pb-20 md:pb-28">
        <div className="max-w-[720px] reveal">
          <div className="flex items-center gap-3 mb-8">
            <span className="eyebrow">Solana · USDC</span>
            <span className="h-px w-8 bg-line" />
            <span className="eyebrow text-dim">Devnet today · mainnet with Umbra</span>
          </div>

          <h1 className="font-sans font-medium text-ink text-[44px] sm:text-[56px] md:text-[68px] leading-[1.02] tracking-[-0.035em]">
            Invoice clients in USDC.
            <br />
            <span className="text-muted">Without broadcasting what you charge.</span>
          </h1>

          <p className="mt-8 max-w-[560px] text-[17px] leading-[1.55] text-ink/80">
            You see the amount. Your client sees the amount. Everyone else —
            competitors, scrapers, on-chain bots — sees noise.
          </p>

          <div className="mt-10 flex flex-wrap items-center gap-3">
            <a href="/create" className="btn-primary">
              Send an invoice
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden>
                <path d="M2 5.5h7M6 2.5l3 3-3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </a>
            <a href="/dashboard" className="btn-ghost">Open dashboard</a>
            <span className="ml-1 text-[12.5px] text-dim">
              Wallet required · takes about a minute
            </span>
          </div>
        </div>

        {/* Demo card — the product, not a decoration */}
        <div
          className="mt-20 md:mt-24 reveal"
          style={{ animationDelay: "120ms" }}
        >
          <div className="flex items-baseline justify-between mb-3">
            <span className="eyebrow">One invoice, seen two ways</span>
          </div>
          <CipherAmount amount="$4,200.00" />
        </div>
      </section>

      {/* How it works */}
      <section className="relative z-10 border-t border-line bg-paper-2/40">
        <div className="max-w-[1200px] mx-auto px-6 md:px-8 py-20 md:py-24">
          <div className="grid grid-cols-12 gap-6 md:gap-10">
            <div className="col-span-12 md:col-span-4">
              <span className="eyebrow">How it works</span>
              <h2 className="mt-4 font-sans font-medium text-[28px] md:text-[34px] leading-[1.1] tracking-[-0.02em] text-ink">
                Three steps.
                <br />
                <span className="text-muted">One private invoice.</span>
              </h2>
            </div>

            <ol className="col-span-12 md:col-span-8 flex flex-col divide-y divide-line">
              {STEPS.map(({ k, title, body }) => (
                <li
                  key={k}
                  className="py-6 md:py-7 first:pt-0 last:pb-0 grid grid-cols-[48px_1fr] md:grid-cols-[64px_1fr] gap-4 md:gap-6"
                >
                  <span className="font-mono text-[11px] tracking-[0.1em] text-muted pt-1 tnum">
                    {k}
                  </span>
                  <div>
                    <h3 className="font-sans font-medium text-[17px] text-ink tracking-[-0.01em]">
                      {title}
                    </h3>
                    <p className="mt-2 text-[14.5px] leading-[1.55] text-ink/70 max-w-[540px]">
                      {body}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      {/* Trust row — single quiet band */}
      <section className="relative z-10 border-t border-line">
        <div className="max-w-[1200px] mx-auto px-6 md:px-8 py-14">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-10 md:gap-14">
            <Fact label="Settles on" value="Solana · USDC" />
            <Fact label="Encryption" value="X25519 · AES-256-GCM" />
            <Fact label="Privacy layer" value="Umbra · Arcium MPC" />
            <Fact label="Sharing" value="Auditor keys, per-invoice" />
          </div>
        </div>
      </section>

      {/* Closing CTA */}
      <section className="relative z-10 border-t border-line">
        <div className="max-w-[1200px] mx-auto px-6 md:px-8 py-20 md:py-24">
          <div className="max-w-[640px]">
            <h2 className="font-sans font-medium text-[32px] md:text-[40px] leading-[1.05] tracking-[-0.025em] text-ink">
              What you charge isn't anyone else's business.
            </h2>
            <p className="mt-5 text-[16px] leading-[1.55] text-ink/70 max-w-[520px]">
              Send your first invoice in about a minute. Devnet works today —
              mainnet lands when Umbra does.
            </p>
            <div className="mt-8 flex items-center gap-3">
              <a href="/create" className="btn-primary">Send an invoice</a>
              <a href="/dashboard" className="btn-quiet">Open dashboard →</a>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="relative z-10 border-t border-line">
        <div className="max-w-[1200px] mx-auto px-6 md:px-8 py-8 flex flex-wrap items-baseline justify-between gap-4">
          <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[12.5px] text-muted">
            <span className="font-semibold text-ink">Veil</span>
            <span className="text-dim">·</span>
            <span>Colosseum Frontier 26</span>
            <span className="text-dim">·</span>
            <span>v0.1</span>
          </div>
          <div className="flex items-center gap-5 text-[12.5px] text-muted">
            <a href="/create" className="hover:text-ink transition-colors">Create</a>
            <a href="/dashboard" className="hover:text-ink transition-colors">Dashboard</a>
            <a href="#" className="hover:text-ink transition-colors">Docs</a>
          </div>
        </div>
      </footer>
    </main>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="eyebrow">{label}</span>
      <span className="font-sans text-[14.5px] text-ink tracking-[-0.005em]">
        {value}
      </span>
    </div>
  );
}
