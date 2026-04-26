# Homepage Hero Promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the `<CipherAmount>` "seen two ways" panel from a below-the-fold side note into the hero centerpiece, anchor the empty right-hero with a decorative logo float, and replace the redundant closing CTA with an editorial PIVY pull-quote — without touching any other route or component.

**Architecture:** All changes are confined to `app/src/app/page.tsx` (the landing page) plus one keyframe addition in `app/src/app/globals.css`. The hero becomes a 12-column grid: text + CTAs occupy the left ~5 cols, `<CipherAmount>` occupies the right ~7 cols. A decorative logo image floats absolutely positioned in the top-right of the page with `mix-blend-multiply` and a –4° rotation. The closing CTA section becomes a Boska-italic pull-quote with a single subtle CTA chip below the attribution.

**Tech Stack:** Next.js 14 App Router · React 18 · Tailwind CSS · Switzer (font-sans) · Boska (font-display) · Fragment Mono (font-mono). No new deps.

**Spec source:** Brainstorming notes from 2026-04-26 critique. The three brainstormed changes were:
1. Hero promotion — split panel becomes the visual centerpiece, headline + CTAs in the left column.
2. Floating decorative logo (–4° rotation, opacity ~0.5, mix-blend-multiply) anchors the empty hero right-of-center space.
3. Replace closing CTA copy with the PIVY pull-quote (`"Public crypto payroll is a roadmap for social engineering."` — PIVY, 2026) plus a single small CTA chip.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `app/src/app/page.tsx` | Modify | Hero restructure (12-col grid), floating logo, replaced closing CTA |
| `app/src/app/globals.css` | Modify | Add `slow-tilt` keyframe for the floating logo's subtle motion (optional polish) |

No new files. No deleted files.

---

## Visual reference — current vs target

**Current hero:**
- Single centered column, max-width 720px
- Headline + body + CTAs occupy the entire hero
- `<CipherAmount>` lives 80–96px BELOW the hero CTAs as a separate moment

**Target hero:**
- 12-column grid at `max-w-[1200px]`
- Left columns 1–5: eyebrow row, headline, body paragraph, CTAs, hint text
- Right columns 6–12: `<CipherAmount>` panel directly inline with the hero, vertically centered to the headline
- Decorative logo: absolute top-right of the section, ~280px wide, `rotate(-4deg)`, opacity 0.5, `mix-blend-multiply`, `pointer-events-none`, hidden on `< md`

**Current closing CTA:**
- "What you charge isn't anyone else's business." headline
- Body paragraph
- "Send an invoice" + "Open dashboard →" CTAs (duplicate of hero)

**Target closing CTA:**
- Boska italic pull-quote (~36–44px): *"Public crypto payroll is a roadmap for social engineering."*
- `— PIVY, 2026` attribution in small mono
- Single inline CTA chip: `Send your first invoice →` linking to `/create`

---

## Task 1: Restructure hero into a 12-column grid

**Files:**
- Modify: `app/src/app/page.tsx:56-100` (the entire `{/* Hero */}` section)

- [ ] **Step 1: Read the current hero block to confirm starting line numbers**

Open `app/src/app/page.tsx`. The hero section starts at the comment `{/* Hero */}` (line 56) and ends at the closing `</section>` for the hero. Note the existing `<CipherAmount>` lives inside the hero section but visually below the headline at `mt-20 md:mt-24`.

- [ ] **Step 2: Replace the hero `<section>` with a 12-column grid layout**

Find this block (lines 56–100):

```tsx
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
```

Replace with:

```tsx
      {/* Hero — 12-col grid: text on left, CipherAmount panel inline on right.
          Decorative logo float sits absolute in the section's top-right,
          hidden below md breakpoint so mobile stays uncluttered. */}
      <section className="relative z-10 max-w-[1200px] mx-auto px-6 md:px-8 pt-20 md:pt-24 pb-24 md:pb-28">
        {/* Decorative logo — atmosphere, not interactive */}
        <img
          src="/veil-icon.png"
          alt=""
          aria-hidden
          className="hidden lg:block absolute top-8 right-6 md:right-8 w-[280px] h-[280px] object-contain opacity-50 mix-blend-multiply pointer-events-none select-none -rotate-[4deg] origin-top-right"
          draggable={false}
        />

        <div className="grid grid-cols-12 gap-8 lg:gap-12 items-center">
          {/* Left column — headline, body, CTAs */}
          <div className="col-span-12 lg:col-span-5 reveal">
            <div className="flex items-center gap-3 mb-8">
              <span className="eyebrow">Solana · USDC</span>
              <span className="h-px w-8 bg-line" />
              <span className="eyebrow text-dim">Devnet today · mainnet with Umbra</span>
            </div>

            <h1 className="font-sans font-medium text-ink text-[40px] sm:text-[48px] lg:text-[56px] xl:text-[64px] leading-[1.03] tracking-[-0.035em]">
              Invoice clients in USDC.
              <br />
              <span className="text-muted">Without broadcasting what you charge.</span>
            </h1>

            <p className="mt-7 max-w-[480px] text-[16.5px] leading-[1.55] text-ink/80">
              You see the amount. Your client sees the amount. Everyone else —
              competitors, scrapers, on-chain bots — sees noise.
            </p>

            <div className="mt-9 flex flex-wrap items-center gap-3">
              <a href="/create" className="btn-primary">
                Send an invoice
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden>
                  <path d="M2 5.5h7M6 2.5l3 3-3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </a>
              <a href="/dashboard" className="btn-ghost">Open dashboard</a>
            </div>
            <p className="mt-4 text-[12.5px] text-dim">
              Wallet required · takes about a minute
            </p>
          </div>

          {/* Right column — the brand demo moment, inline with the headline */}
          <div
            className="col-span-12 lg:col-span-7 reveal"
            style={{ animationDelay: "120ms" }}
          >
            <div className="flex items-baseline justify-between mb-3">
              <span className="eyebrow">One invoice, seen two ways</span>
            </div>
            <CipherAmount amount="$4,200.00" />
          </div>
        </div>
      </section>
```

- [ ] **Step 3: Run the dev server and visual-verify the hero**

```bash
cd app && npm run dev
```

Open `http://localhost:3000` and confirm:
- Headline text and CTAs occupy the left ~40% of the hero region on screens ≥1024px wide
- `<CipherAmount>` panel sits to the right of the headline, vertically centered against it
- A faint Veil icon appears in the top-right at ~280px, slightly tilted, semi-transparent, NOT clickable
- On mobile (< lg), the layout collapses to single column: text first, then panel below; the decorative icon is hidden
- No layout overflow, no horizontal scroll
- Existing reveal animation still fires on page load

If the panel appears below the text instead of beside it on a wide screen, check that the parent grid is `lg:col-span-X` (not `md:col-span-X`).

- [ ] **Step 4: Commit**

```bash
git add app/src/app/page.tsx
git commit -m "feat(home): promote CipherAmount panel into hero — 12-col grid + decorative logo float"
```

---

## Task 2: Replace closing CTA with PIVY pull-quote

**Files:**
- Modify: `app/src/app/page.tsx:151-168` (the `{/* Closing CTA */}` section)

- [ ] **Step 1: Find the existing closing CTA block**

In `app/src/app/page.tsx`, locate the section starting with `{/* Closing CTA */}`. It currently contains:

```tsx
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
```

- [ ] **Step 2: Replace with editorial pull-quote**

Replace the entire block above with:

```tsx
      {/* Closing — editorial pull-quote, not a duplicate of the hero CTA.
          Boska italic carries the brand voice; the source citation grounds
          the claim in real research (PIVY, 2026). One small chip CTA so the
          quote doesn't compete with the hero's primary CTAs. */}
      <section className="relative z-10 border-t border-line">
        <div className="max-w-[1200px] mx-auto px-6 md:px-8 py-24 md:py-32">
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
```

- [ ] **Step 3: Visual-verify in dev server**

Reload `http://localhost:3000`. Scroll to the bottom of the page (just above the footer). Confirm:
- A large italic Boska quote dominates the closing section
- "PIVY · 2026" attribution sits below in small mono caps with a "Source" link to the PIVY URL
- Single oxblood "Send your first invoice" CTA below the attribution
- No second `Open dashboard →` quiet button (we deliberately removed it)
- Quote font is Boska italic (the same family as the wordmark in the navbar)

If the quote renders in regular Switzer instead of Boska italic, verify the `font-display` class is being applied — open DevTools, inspect the `<blockquote>`, confirm `font-family: "Boska", ui-serif, ...` is set.

- [ ] **Step 4: Commit**

```bash
git add app/src/app/page.tsx
git commit -m "feat(home): replace duplicate closing CTA with PIVY pull-quote in Boska italic"
```

---

## Task 3: Verify TypeScript + tests + prod build still clean

**Files:** N/A — verification only.

- [ ] **Step 1: Run TypeScript check**

```bash
cd app && npx tsc --noEmit
echo "tsc exit: $?"
```

Expected: `tsc exit: 0` (no errors).

If errors appear, they're almost certainly typos in the JSX you just edited. Fix and rerun.

- [ ] **Step 2: Run unit tests**

```bash
cd app && npm test
```

Expected: existing 81 tests pass (no new tests added, no existing tests modified).

If a test fails, it must be a regression you introduced — investigate before continuing.

- [ ] **Step 3: Run production build**

```bash
cd app && npx next build
```

Expected: build completes with no errors. The `/` route should appear in the route table at the same size or smaller than before (we removed JSX, didn't add components).

If the build fails for an unrelated reason (e.g. previously-known `pino-pretty` warning), that's acceptable as long as `/` itself compiles. The pino warning is harmless noise.

- [ ] **Step 4: Commit gate**

If all three checks pass, no commit needed (Task 3 produces no code changes). Move to Task 4.

If any check failed, return to Task 1 or Task 2 and fix before proceeding.

---

## Task 4: Manual visual smoke test on dev server

**Files:** N/A — manual verification only.

- [ ] **Step 1: Open dev server in three viewport sizes**

```bash
cd app && npm run dev
```

Open `http://localhost:3000`. Resize the browser window (or use DevTools device toolbar) to test:

| Viewport | Expected layout |
|---|---|
| ≥ 1280px wide | Two-column hero; floating Veil icon visible top-right; quote + CTA in closing section |
| 1024–1279px | Two-column hero (slightly narrower); floating icon visible |
| 768–1023px | Single-column hero (text first, panel below); floating icon hidden; quote stays large |
| 375–767px (mobile) | Single-column hero; CTAs stack on a new row; quote scales down to ~32px |

- [ ] **Step 2: Hover the Veil logo in the navbar**

Confirm the typewriter still fires (Veil → Private invoicing → Veil) — no regression from the page restructure.

- [ ] **Step 3: Click "Send an invoice" both in hero and in closing**

Confirm both CTAs route to `/create`. The closing CTA copy says "Send your first invoice" (different label from hero's "Send an invoice") — that's intentional.

- [ ] **Step 4: Click the PIVY "Source" link**

Confirm it opens `https://pivy.me/blog/3dc66fc2-bf12-4924-95c2-7550d7dd4501` in a new tab.

- [ ] **Step 5: Scroll the page and confirm reveal animations fire on initial load**

Hard-refresh (Ctrl+Shift+R). On first paint:
- Left column of the hero fades up
- Right column (CipherAmount panel) fades up ~120ms later (delay still applied via inline style)

If the panel doesn't have its delayed fade-up, verify the inline `style={{ animationDelay: "120ms" }}` survived the edit on the right-column wrapper.

- [ ] **Step 6: Confirm the CipherAmount cipher still rotates every ~3s**

Sit on the page for 4 seconds. The "From / To / Amount" lines on the right pane of the panel should refresh with new randomized values. (This is existing behavior from `CipherAmount.tsx`'s `setInterval`. If it stopped, the panel didn't survive being moved — investigate.)

- [ ] **Step 7: No commit — manual smoke is verification only**

If all six checks pass, the implementation is complete. If any fail, fix the relevant task and re-verify.

---

## Task 5: Take a screenshot of the new homepage and save it for the demo video

**Files:**
- Create: `docs/screenshots/2026-04-26-homepage-hero.png` (manual screenshot — no code)

- [ ] **Step 1: Resize browser to 1440×900 (the standard demo recording size)**

Use the OS or DevTools to set the viewport to 1440×900.

- [ ] **Step 2: Hard-refresh + wait 1 second for the reveal animation to complete**

```text
Ctrl+Shift+R
(wait ~1s)
```

- [ ] **Step 3: Capture full-page or above-the-fold screenshot**

Windows: `Win + Shift + S` → drag to capture the hero region (logo nav bar through end of CipherAmount panel).

Save as `docs/screenshots/2026-04-26-homepage-hero.png` in the repo (create the `docs/screenshots/` directory if needed).

- [ ] **Step 4: Commit**

```bash
mkdir -p docs/screenshots
# (manual: copy the screenshot file into docs/screenshots/)
git add docs/screenshots/2026-04-26-homepage-hero.png
git commit -m "docs(screenshots): capture new homepage hero for demo video reference"
```

If you skipped this task (no screenshot needed yet), no commit. The plan completes after Task 4.

---

## Self-review — coverage check

Cross-checking against the brainstorm:

| Brainstorm item | Implemented in | Status |
|---|---|---|
| Promote `<CipherAmount>` into the hero centerpiece | Task 1 | ✅ |
| Two-column 12-grid hero (left text, right panel) | Task 1 step 2 | ✅ |
| Floating Veil icon in the top-right of the hero | Task 1 step 2 | ✅ |
| Mix-blend-multiply + opacity 50% + –4° rotation | Task 1 step 2 (`opacity-50 mix-blend-multiply -rotate-[4deg]`) | ✅ |
| Hide floating icon on mobile | Task 1 step 2 (`hidden lg:block`) | ✅ |
| Replace closing CTA with PIVY pull-quote | Task 2 | ✅ |
| Boska italic for the quote | Task 2 step 2 (`font-display italic`) | ✅ |
| `— PIVY · 2026` attribution + Source link | Task 2 step 2 | ✅ |
| Single CTA chip below quote (not duplicate hero pair) | Task 2 step 2 | ✅ |
| Verify tsc/tests/build all stay green | Task 3 | ✅ |
| Manual responsive smoke | Task 4 | ✅ |

Brainstorm items NOT in this plan (deferred — explicitly scoped out):
- Animated amount swap on hover/scroll (`$4,200.00` → `61adcfd9f1def114` typewriter). Reason: `<CipherAmount>` already auto-rotates the cipher every 3.2s via `setInterval`. Adding hover-driven animation requires deeper refactor of that component. If the user wants this added, write a follow-up plan.
- Animated stats row (marquee). Explicit non-recommendation in the brainstorm — gimmicky for financial UI.
- Decorative giant icon behind the "How it works" section. Lower priority than the hero promotion; can ship as a follow-up.

## Self-review — placeholder scan

Searched for: `TODO`, `TBD`, `placeholder`, `add error handling`, `similar to`, `etc.`. None found in the task code blocks.

## Self-review — type/prop consistency

- `<CipherAmount>` invoked with `amount="$4,200.00"` in both the original hero and the new hero — props unchanged, no signature mismatch.
- All Tailwind classes used (`reveal`, `eyebrow`, `btn-primary`, `btn-ghost`, `btn-quiet`, `font-display`, `font-mono`) already exist in `app/src/app/globals.css` and `app/tailwind.config.ts`.
- `text-ink`, `text-muted`, `text-dim`, `bg-paper`, `border-line` — all defined in `tailwind.config.ts:12-26`.
- `font-display` is `var(--font-display)` → Boska, defined in `globals.css:13`.
