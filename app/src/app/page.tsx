"use client";

import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { VeilLogo } from "@/components/VeilLogo";
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
      <nav className="relative z-20 max-w-[1400px] mx-auto px-6 md:px-8 pt-6 flex items-center justify-between">
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

      {/* Hero — 12-col grid: text on left, CipherAmount panel inline on right.
          Decorative logo float sits absolute in the section's top-right,
          hidden below md breakpoint so mobile stays uncluttered. */}
      <section className="relative z-10 max-w-[1400px] mx-auto px-6 md:px-8 pt-28 md:pt-36 pb-32 md:pb-40">
        <div className="grid grid-cols-12 gap-10 lg:gap-20 items-center">
          {/* Left column — headline, body, CTAs */}
          <div className="col-span-12 lg:col-span-6 reveal">
            <h1 className="font-sans font-medium text-ink text-[40px] sm:text-[48px] lg:text-[56px] xl:text-[64px] leading-[1.03] tracking-[-0.035em]">
              Invoice clients in USDC.
              <br />
              <span className="text-muted">Without broadcasting what you charge.</span>
            </h1>

            <p className="mt-10 max-w-[480px] text-[16.5px] leading-[1.55] text-ink/80">
              You see the amount. Your client sees the amount. Everyone else
              sees noise.
            </p>

            <div className="mt-12 flex flex-wrap items-center gap-3">
              <a href="/create" className="btn-primary">
                Send an invoice
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden>
                  <path d="M2 5.5h7M6 2.5l3 3-3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </a>
              <a href="/dashboard" className="btn-ghost">Open dashboard</a>
            </div>
          </div>

          {/* Right column — the brand demo moment, inline with the headline */}
          <div
            className="col-span-12 lg:col-span-6 reveal"
            style={{ animationDelay: "120ms" }}
          >
            <CipherAmount amount="$4,200.00" />
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="relative z-10 border-t border-line bg-paper-2/40">
        <div className="max-w-[1400px] mx-auto px-6 md:px-8 py-28 md:py-36">
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
        <div className="max-w-[1400px] mx-auto px-6 md:px-8 py-16 md:py-20">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-10 md:gap-14">
            <Fact label="Settles on" value="Solana · USDC" />
            <Fact label="Encryption" value="X25519 · AES-256-GCM" />
            <Fact label="Privacy layer" value="Umbra · Arcium MPC" />
            <Fact label="Sharing" value="Auditor keys, per-invoice" />
          </div>
        </div>
      </section>

      {/* Closing — editorial pull-quote, not a duplicate of the hero CTA.
          Boska italic carries the brand voice; the source citation grounds
          the claim in real research (PIVY, 2026). One small chip CTA so the
          quote doesn't compete with the hero's primary CTAs. */}
      <section className="relative z-10 border-t border-line">
        <div className="max-w-[1400px] mx-auto px-6 md:px-8 py-32 md:py-40">
          <figure className="max-w-[820px]">
            <span className="eyebrow">Why it matters</span>
            <blockquote className="mt-6 font-display italic font-medium text-ink text-[32px] sm:text-[40px] md:text-[48px] leading-[1.1] tracking-[-0.02em]">
              <span aria-hidden className="text-muted mr-1">&ldquo;</span>
              Public crypto payroll is a roadmap for targeted social engineering.
              <span aria-hidden className="text-muted ml-1">&rdquo;</span>
            </blockquote>
            <figcaption className="mt-7 flex flex-wrap items-baseline gap-x-4 gap-y-2 font-mono text-[11px] tracking-[0.14em] uppercase text-muted">
              <span>— PIVY · 2026</span>
              <span className="text-dim">·</span>
              <a
                href="https://pivy.me/blog/3dc66fc2-bf12-4924-95c2-7550d7dd4501"
                target="_blank"
                rel="noreferrer"
                className="text-dim hover:text-ink transition-colors"
              >
                Source
              </a>
            </figcaption>
          </figure>

          <div className="mt-12">
            <a href="/create" className="btn-primary">
              Send your first invoice
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden>
                <path d="M2 5.5h7M6 2.5l3 3-3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="relative z-10 border-t border-line">
        <div className="max-w-[1400px] mx-auto px-6 md:px-8 py-8 flex flex-wrap items-baseline justify-between gap-4">
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
