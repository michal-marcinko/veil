"use client";

import Link from "next/link";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { VeilLogo } from "@/components/VeilLogo";
import { CipherAmount } from "@/components/CipherAmount";

// ---------------------------------------------------------------------------
// "Auditor exhibit" — the rows shown in the For-accountants section. Same
// underlying payments rendered two ways: public chain view (redacted/cipher)
// vs auditor-with-grant view (decrypted memo + amount + date). The pairs
// are kept in lockstep order so a reader can scan across rows and see the
// same payment translated.
// ---------------------------------------------------------------------------
const EXHIBIT_ROWS: ReadonlyArray<{
  date: string;
  payer: string;
  memo: string;
  amount: string;
  cipher: string;
  signature: string;
}> = [
  {
    date: "2026-03-04",
    payer: "Globex Corp.",
    memo: "Q1 retainer · design system",
    amount: "$8,400.00",
    cipher: "a71e3f9c0d4b8e27",
    signature: "5h3p…rT9k",
  },
  {
    date: "2026-03-12",
    payer: "Initech Holdings",
    memo: "Invoice #0118 · audit support",
    amount: "$2,150.00",
    cipher: "f2a8b91c47e0d3a6",
    signature: "9zXd…m4Vp",
  },
  {
    date: "2026-03-19",
    payer: "Hooli Cloud",
    memo: "March payroll · 4 contractors",
    amount: "$14,820.00",
    cipher: "c08d4f6b21a973ee",
    signature: "Q7tw…N2ek",
  },
  {
    date: "2026-03-27",
    payer: "Stark & Pym LLC",
    memo: "Pen-test deliverable",
    amount: "$3,600.00",
    cipher: "1ed5a4c80fb237d9",
    signature: "Lk6r…b1Yh",
  },
];

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

      {/* For accountants — editorial "exhibit" comparing the public chain
          view (redacted ciphertext, opaque signatures) against an auditor
          opening a scoped grant URL (decrypted memos, dates, amounts).
          Same four payments, two views. The hairline-bordered table reads
          as a piece of forensic-accounting paper, not a fintech card.

          Placement is deliberate: it sits after CipherAmount has already
          taught the "two views" idea on a single payment, and lifts the
          same metaphor up to ledger scale before the four-step explainer.
          The strongest Umbra-track differentiator gets a dedicated band
          on the marketing surface, not a buried dashboard link. */}
      <section
        id="for-accountants"
        className="relative z-10 border-t border-line"
      >
        <div className="max-w-[1400px] mx-auto px-6 md:px-8 py-28 md:py-36">
          <div className="grid grid-cols-12 gap-10 lg:gap-16 items-start">
            {/* Left rail — eyebrow, headline, body, CTAs. Slightly narrower
                than usual so the exhibit on the right gets visual weight. */}
            <div className="col-span-12 lg:col-span-5 reveal">
              <span className="eyebrow">For accountants</span>
              <h2 className="mt-4 font-sans font-medium text-ink text-[28px] md:text-[36px] lg:text-[40px] leading-[1.08] tracking-[-0.025em]">
                Selective disclosure
                <br />
                <span className="font-display italic text-muted">
                  for the people who need it.
                </span>
              </h2>

              <p className="mt-7 max-w-[460px] text-[15.5px] leading-[1.6] text-ink/80">
                Issue a viewing key scoped to one auditor, one date range,
                one mint. They open a single URL and see decrypted invoices
                and payroll for exactly that slice.{" "}
                <span className="text-ink">Nothing more. Revoke any time.</span>
              </p>

              <ul className="mt-7 space-y-2.5 text-[13.5px] text-ink/75">
                {[
                  "Per-grant ephemeral key — never your wallet master",
                  "Mint + date scope, enforced at generation",
                  "Out-of-scope invoices stay unreachable from the link",
                ].map((item) => (
                  <li key={item} className="flex items-start gap-3">
                    <span
                      aria-hidden
                      className="mt-[8px] h-px w-3 bg-line-2 shrink-0"
                    />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-3">
                <Link
                  href="/dashboard/compliance"
                  prefetch
                  className="btn-primary"
                >
                  <span className="inline-flex items-center gap-2.5">
                    Issue a grant
                    <span aria-hidden>→</span>
                  </span>
                </Link>
                <span className="text-[13px] text-dim">
                  Sample auditor view{" "}
                  <span className="text-muted">— coming with submission</span>
                </span>
              </div>
            </div>

            {/* Right rail — the exhibit. */}
            <div
              className="col-span-12 lg:col-span-7 reveal"
              style={{ animationDelay: "120ms" }}
            >
              <Exhibit />
            </div>
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

/**
 * The auditor exhibit. Editorial newspaper-style two-column ledger:
 * left column is what a public chain analyst sees (signature + redacted
 * cipher amount + lock glyph); right column is what an auditor with a
 * scoped grant URL sees (memo + date + amount). Rows are kept in
 * lockstep so a reader can scan across.
 *
 * Visual notes:
 *   - Sharp 0px corners on the outer frame to read as ledger paper, not
 *     as a card. The rest of the app uses rounded-[3px–4px]; this is a
 *     deliberate one-off for the exhibit.
 *   - A typewritten "Re: 2026-Q1 audit · Acme Corp." header sits above
 *     the right column to frame the auditor as the recipient, not Veil.
 *   - The left column uses paper-3 fill (the "deeper paper" used for
 *     CipherAmount's right pane) so the public-side reads as the colder
 *     of the two surfaces. Right column stays on plain paper.
 */
function Exhibit() {
  return (
    <figure className="border border-line bg-paper rounded-[3px] overflow-hidden shadow-[0_1px_0_rgba(0,0,0,0.02),0_24px_70px_-40px_rgba(26,24,20,0.28)]">
      {/* Paper-style top strip: case reference on the left, scope chip on
          the right. Sets the "this is an exhibit, not a UI card" tone. */}
      <header className="flex items-baseline justify-between gap-4 px-5 md:px-6 py-3.5 border-b border-line bg-paper-2/60">
        <div className="flex items-baseline gap-3 min-w-0">
          <span className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-muted shrink-0">
            Exhibit A
          </span>
          <span className="text-line-2 shrink-0">·</span>
          <span className="font-mono text-[11.5px] text-ink/80 truncate">
            Re: 2026-Q1 audit, Acme Corp.
          </span>
        </div>
        <span className="hidden sm:inline-flex items-center gap-2 font-mono text-[10.5px] tracking-[0.14em] uppercase text-muted shrink-0">
          <span className="h-1 w-1 rounded-full bg-sage" aria-hidden />
          Scope · Mar 2026 · USDC
        </span>
      </header>

      {/* Two column headers — keeps the parallel explicit before the rows. */}
      <div className="grid grid-cols-2 border-b border-line">
        <div className="px-5 md:px-6 py-3 border-r border-line">
          <span className="eyebrow">Public ledger</span>
        </div>
        <div className="px-5 md:px-6 py-3">
          <span className="eyebrow text-sage">Auditor with grant</span>
        </div>
      </div>

      {/* Rows — divide-y for the hairline rules between, no rounded corners
          inside so it reads as a printed ledger, not a list of cards. */}
      <ul className="divide-y divide-line">
        {EXHIBIT_ROWS.map((row, i) => (
          <li key={row.signature} className="grid grid-cols-2">
            {/* Public side — signature, redacted memo bar, cipher amount. */}
            <div className="px-5 md:px-6 py-4 md:py-5 border-r border-line bg-paper-3/60 flex items-center gap-4">
              <span
                aria-hidden
                className="font-mono tnum text-[10.5px] text-dim tracking-[0.04em] w-12 shrink-0"
              >
                {String(i + 1).padStart(2, "0")}
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[11.5px] text-ink/70 truncate">
                  tx · {row.signature}
                </div>
                <div className="mt-1.5 flex items-center gap-2.5">
                  <span
                    aria-hidden
                    className="block h-[7px] w-24 bg-line rounded-[1px]"
                  />
                  <span
                    aria-hidden
                    className="block h-[7px] w-12 bg-line rounded-[1px]"
                  />
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 12 12"
                  fill="none"
                  aria-hidden
                  className="text-line-2"
                >
                  <rect
                    x="2.5"
                    y="5.5"
                    width="7"
                    height="5"
                    rx="0.5"
                    stroke="currentColor"
                    strokeWidth="1.2"
                  />
                  <path
                    d="M4 5.5V4a2 2 0 014 0v1.5"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                  />
                </svg>
                <span className="font-mono tnum text-[11.5px] text-muted tracking-[0.04em]">
                  {row.cipher.slice(0, 8)}…
                </span>
              </div>
            </div>

            {/* Auditor side — date, payer, memo, decrypted amount. */}
            <div className="px-5 md:px-6 py-4 md:py-5 flex items-center gap-4">
              <span className="font-mono tnum text-[11px] text-muted tracking-[0.02em] w-[78px] shrink-0">
                {row.date}
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-sans text-[14px] text-ink truncate">
                  {row.payer}
                </div>
                <div className="font-mono text-[11.5px] text-muted truncate mt-0.5">
                  {row.memo}
                </div>
              </div>
              <div className="font-sans tnum text-[15px] md:text-[16px] font-medium text-ink tracking-[-0.01em] shrink-0">
                {row.amount}
              </div>
            </div>
          </li>
        ))}
      </ul>

      {/* Footer caption — figcaption-style, mono small caps. */}
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 px-5 md:px-6 py-3.5 border-t border-line bg-paper-2/40 font-mono text-[10.5px] tracking-[0.12em] uppercase">
        <span className="text-muted">
          Same four payments, two views.
        </span>
        <span className="text-dim">
          Out of scope · 47 invoices unreachable
        </span>
      </figcaption>
    </figure>
  );
}
