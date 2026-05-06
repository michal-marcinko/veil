"use client";

import Link from "next/link";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { VeilLogo } from "@/components/VeilLogo";
import { CipherAmount } from "@/components/CipherAmount";

const STEPS = [
  {
    k: "01",
    title: "Compose privately",
    body: "Your browser encrypts the recipient, amount, and memo locally. Nothing leaves your screen as plaintext.",
  },
  {
    k: "02",
    title: "Pay through Umbra",
    body: "The payment settles via Umbra's private UTXO pool. Amounts and recipient graph stay off the public ledger.",
  },
  {
    k: "03",
    title: "Confirm receipt",
    body: "Incoming payments arrive in the recipient's encrypted balance. They acknowledge from their wallet.",
  },
  {
    k: "04",
    title: "Selectively reveal",
    body: "Share scoped access with auditors, accountants, or specific counterparties. Per-invoice or full-history.",
  },
];

export default function LandingPage() {
  return (
    <main className="relative min-h-screen">
      {/* Sticky top nav. Backdrop blur over the cream paper preserves the
          editorial calm while still pinning navigation. "Activity" replaces
          the old "Dashboard" label; the route stays /dashboard. */}
      <nav className="sticky top-0 z-20 backdrop-blur-sm bg-paper/80 border-b border-line">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between px-6 md:px-8 py-4">
          <VeilLogo />
          <div className="flex items-center gap-1 md:gap-2">
            <Link
              href="/create"
              prefetch
              className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors"
            >
              Create
            </Link>
            <Link
              href="/dashboard"
              prefetch
              className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors"
            >
              Activity
            </Link>
            <a
              href="https://github.com/michal-marcinko/veil"
              target="_blank"
              rel="noreferrer noopener"
              className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors"
            >
              Docs
            </a>
            <div className="ml-2">
              <ClientWalletMultiButton />
            </div>
          </div>
        </div>
      </nav>

      {/* Hero — 12-col asymmetric grid. Left column carries the editorial
          headline and a single primary CTA (plus one secondary text link);
          right column re-uses CipherAmount unchanged so the strongest brand
          moment lives above the fold. */}
      <section className="relative z-10 max-w-[1400px] mx-auto px-6 md:px-8 pt-28 md:pt-36 pb-32 md:pb-40">
        <div className="grid grid-cols-12 gap-10 lg:gap-20 items-center">
          {/* Left column — headline, subhead, CTA group. Eyebrow removed:
              the wordmark + tagline in the nav already establishes context,
              and a redundant "Private payments on Solana" label above the
              headline read as belt-and-suspenders. The headline does the
              work alone. */}
          <div className="col-span-12 lg:col-span-6 reveal">
            <h1 className="font-sans font-medium text-ink text-[28px] sm:text-[34px] lg:text-[40px] xl:text-[44px] leading-[1.08] tracking-[-0.02em]">
              Invoice clients. Run payroll.
              <br />
              <span className="text-muted">Privately.</span>
            </h1>

            <p className="mt-7 max-w-[520px] text-[17px] leading-[1.6] text-ink/80">
              Only you and the recipient see the amount.
            </p>

            <div className="mt-10 flex items-center gap-5">
              <Link href="/create" prefetch className="btn-primary">
                <span className="inline-flex items-center gap-2.5">
                  Create payment
                  <span aria-hidden>→</span>
                </span>
              </Link>
              <Link
                href="/dashboard"
                prefetch
                className="text-[14px] text-muted hover:text-ink underline-offset-4 hover:underline transition-colors"
              >
                View activity
              </Link>
            </div>
          </div>

          {/* Right column — the dual cipher panel, unchanged */}
          <div
            className="col-span-12 lg:col-span-6 reveal"
            style={{ animationDelay: "120ms" }}
          >
            <CipherAmount amount="$4,200.00" />
          </div>
        </div>
      </section>

      {/* How it works — eyebrow + heading on the left, four numbered steps
          in a 2-col grid on the right. Tabular mono numerals in sage so the
          ordinals read as labels, not display. */}
      <section className="relative z-10 border-t border-line bg-paper-2/40">
        <div className="max-w-[1400px] mx-auto px-6 md:px-8 py-28 md:py-32">
          <div className="grid grid-cols-12 gap-6 md:gap-10">
            <div className="col-span-12 md:col-span-4">
              <span className="eyebrow">How it works</span>
              <h2 className="mt-4 font-sans font-medium text-[28px] md:text-[36px] leading-[1.1] tracking-[-0.025em] text-ink">
                Four steps.
                <br />
                <span className="text-muted">One private payment.</span>
              </h2>
            </div>

            <ol className="col-span-12 md:col-span-8 grid grid-cols-1 sm:grid-cols-2 gap-x-10 gap-y-10 md:gap-y-12">
              {STEPS.map(({ k, title, body }) => (
                <li key={k} className="flex flex-col">
                  <span className="font-mono tnum text-[13px] tracking-[0.08em] text-sage">
                    {k}
                  </span>
                  <h3 className="mt-3 font-sans font-medium text-ink text-[22px] tracking-[-0.015em] leading-[1.2]">
                    {title}
                  </h3>
                  <p className="mt-3 text-[15px] leading-[1.6] text-ink/75 max-w-[420px]">
                    {body}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      {/* Capability bar — 4 columns of label/value pairs. Mono uppercase
          eyebrow over a Switzer ink value. Stacks to 2-col on mobile. */}
      <section className="relative z-10 border-t border-line">
        <div className="max-w-[1400px] mx-auto px-6 md:px-8 py-16 md:py-20">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-10 md:gap-14">
            <Fact label="Settles on" value="Solana · USDC" />
            <Fact label="Encryption" value="X25519 · AES-256-GCM" />
            <Fact label="Privacy layer" value="Umbra private UTXOs" />
            <Fact label="Sharing" value="Auditor keys, scoped" />
          </div>
        </div>
      </section>

      {/* Quote band — preserved PIVY pull-quote. Boska italic carries the
          brand voice; the source citation grounds the claim in real research. */}
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
        </div>
      </section>

      {/* Footer — tagline, closing CTA link, right-aligned nav, brand row. */}
      <footer className="relative z-10 border-t border-line">
        <div className="max-w-[1400px] mx-auto px-6 md:px-8 py-16 md:py-20">
          <div className="grid grid-cols-12 gap-10 md:gap-12">
            <div className="col-span-12 md:col-span-7">
              <p className="font-sans text-[18px] md:text-[20px] leading-[1.45] text-ink tracking-[-0.01em] max-w-[560px]">
                Private invoices, payroll, and accountant access for Solana
                businesses.
              </p>
              <div className="mt-6">
                <Link
                  href="/create"
                  prefetch
                  className="font-sans text-[14px] text-gold hover:text-ink underline-offset-4 hover:underline transition-colors"
                >
                  Create your first payment →
                </Link>
              </div>
            </div>
            <div className="col-span-12 md:col-span-5 md:flex md:justify-end">
              <div className="flex items-center gap-5 text-[12.5px] text-muted">
                <Link href="/create" prefetch className="hover:text-ink transition-colors">
                  Create
                </Link>
                <Link href="/dashboard" prefetch className="hover:text-ink transition-colors">
                  Activity
                </Link>
                <a
                  href="https://github.com/michal-marcinko/veil"
                  target="_blank"
                  rel="noreferrer noopener"
                  className="hover:text-ink transition-colors"
                >
                  Docs
                </a>
              </div>
            </div>
          </div>

          <div className="mt-14 pt-6 border-t border-line flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[12px] text-muted">
            <span className="font-semibold text-ink">Veil</span>
            <span className="text-dim">·</span>
            <span>Colosseum Frontier 26</span>
            <span className="text-dim">·</span>
            <span>v0.1</span>
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
      <span className="font-sans text-[14px] text-ink tracking-[-0.005em]">
        {value}
      </span>
    </div>
  );
}
