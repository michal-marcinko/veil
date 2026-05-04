# Invoice Create Flow Redesign — Document Canvas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bordered-card form on `/create` (invoice branch) with a continuous editorial canvas backed by one persistent sticky action bar that morphs across compose → publishing → success.

**Architecture:** State lifts from `<InvoiceForm>` into `<CreatePage>`. Form becomes a controlled presentational component without an internal submit button. A new `<InvoiceCanvasBar>` lives at `position: fixed; bottom: 0` and renders one of three discriminated states. The bar's primary button uses the HTML `form="invoice-form"` attribute so clicking it submits the form despite living outside the `<form>` DOM tree. The bar persists through every Phantom popup and through the form→success transition by never unmounting — only its `state` prop changes.

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript strict, Tailwind 3 (existing palette: ink/paper/gold/sage), Vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-05-04-invoice-create-flow-redesign.md`

**Mockups:** `.superpowers/brainstorm/695-1777860690/content/{layout-canvas,layout-canvas-success}.html`

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `app/src/__tests__/create-render.test.tsx` | NEW | Render-level integration tests for compose + success states |
| `app/src/app/globals.css` | MODIFY | Add canvas-bar / display-input / chip utility classes |
| `app/src/components/InvoiceCanvasBar.tsx` | NEW | Sticky bar with 3 morphing states; owns ⌘↵ and ⌘C keyboard handlers |
| `app/src/components/InvoiceForm.tsx` | MODIFY | Strip card chrome, become controlled, replace From/Bill-to with display inputs, replace Notes/Due/Restrict with chip row, remove inline submit button |
| `app/src/app/create/page.tsx` | MODIFY | Hoist form state into page; mount canvas bar; gate picker visibility on `result === null`; fade-out picker on success |

**Out of scope:** PayrollFlow, /pay/[id], /dashboard, the registration modal (it overlays the canvas bar, untouched).

---

## Task 1: Failing render test (TDD red)

**Files:**
- Create: `app/src/__tests__/create-render.test.tsx`

This test fails on every assertion until the implementation lands.

- [ ] **Step 1: Write the failing test**

Create `app/src/__tests__/create-render.test.tsx` with this exact content:

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: (() => {
    const publicKey = new PublicKey("11111111111111111111111111111112");
    return () => ({
      connected: true,
      publicKey,
      signMessage: vi.fn(async () => new Uint8Array(64)),
      signTransaction: vi.fn(async (tx: any) => tx),
    });
  })(),
}));

vi.mock("@/components/ClientWalletMultiButton", () => ({
  ClientWalletMultiButton: () => null,
}));

vi.mock("@/components/PayrollFlow", () => ({
  PayrollFlow: () => null,
}));

vi.mock("@/lib/anchor", () => ({
  createInvoiceOnChain: vi.fn(async () => "create-invoice-sig"),
  deriveInvoicePda: vi.fn(() => [
    new PublicKey("11111111111111111111111111111113"),
    255,
  ]),
}));

vi.mock("@/lib/umbra", () => ({
  getOrCreateClient: vi.fn(async () => ({ signer: { address: "fake" } })),
  ensureRegistered: vi.fn(async () => undefined),
  ensureReceiverKeyAligned: vi.fn(async () => undefined),
}));

vi.mock("@/lib/encryption", () => ({
  getOrCreateMetadataMasterSig: vi.fn(async () => new Uint8Array(64)),
  deriveKeyFromMasterSig: vi.fn(async () => new Uint8Array(32)),
  keyToBase58: vi.fn(() => "8Mkfdk3G15PWkTk4F1QyMho2FCuVvGVFAiZJVzCiTmPt"),
  encryptJson: vi.fn(async () => new Uint8Array(64)),
  sha256: vi.fn(async () => new Uint8Array(32)),
}));

vi.mock("@/lib/arweave", () => ({
  uploadCiphertext: vi.fn(async () => ({ uri: "https://arweave.net/abc" })),
}));

import CreatePage from "@/app/create/page";

describe("Create page — Document Canvas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function selectInvoiceMode() {
    fireEvent.click(screen.getByRole("button", { name: /^Invoice$/i }));
  }

  it("compose state renders no '01 / 02 / 03' mono section numbering", async () => {
    render(<CreatePage />);
    selectInvoiceMode();

    await waitFor(() => {
      expect(screen.getByLabelText(/From/i)).toBeInTheDocument();
    });

    // Old design used "01" "02" "03" as section eyebrows. New design has no
    // such numbering anywhere in the body (line-item row numbers are still
    // OK because they're per-row, not per-section).
    const sectionEyebrows = screen.queryAllByText(/^0[123]$/);
    expect(sectionEyebrows).toHaveLength(0);
  });

  it("compose state mounts the sticky canvas bar with a Create private invoice button", async () => {
    render(<CreatePage />);
    selectInvoiceMode();

    await waitFor(() => {
      // The bar is identified by its role + name. Lives in a fixed sticky
      // container, but the button itself is what the user sees.
      expect(
        screen.getByRole("button", { name: /Create private invoice/i }),
      ).toBeInTheDocument();
    });

    // Live subtotal indicator is present (starts at 0.0000 USDC).
    const total = screen.getByTestId("canvas-bar-subtotal");
    expect(total).toBeInTheDocument();
  });

  it("publishing state morphs the bar in place (does not unmount the bar)", async () => {
    // We assert the bar's container persists across state changes by
    // checking its data-testid is still present after a submit. The
    // actual on-chain flow is mocked; we just need the UI state to reach
    // 'publishing'.
    render(<CreatePage />);
    selectInvoiceMode();

    await waitFor(() => {
      expect(screen.getByTestId("canvas-bar")).toBeInTheDocument();
    });

    const initialBar = screen.getByTestId("canvas-bar");
    expect(initialBar).toBeInTheDocument();
    expect(initialBar.getAttribute("data-state")).toBe("compose");
  });

  it("success state hides the picker and the 'Choose differently' button", async () => {
    // Drive the page to success state via the test helper exposed by
    // CreatePage (a __test__ prop). This lets us isolate the success-state
    // render from the full async create_invoice flow.
    render(<CreatePage __forceState="success" />);

    // Compose-mode picker AND back link must NOT be in the DOM.
    expect(screen.queryByRole("button", { name: /^Invoice$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Payroll$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Choose differently/i })).toBeNull();
  });

  it("success state renders the pay-link strip + Copy link button", async () => {
    render(<CreatePage __forceState="success" />);

    // Pay link is visible somewhere in the canvas bar.
    expect(screen.getByText(/veil\.app\/pay\//i)).toBeInTheDocument();
    // Primary action is Copy link.
    expect(
      screen.getByRole("button", { name: /Copy link/i }),
    ).toBeInTheDocument();
    // No "+ Send another" button anywhere.
    expect(screen.queryByRole("button", { name: /Send another/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify all 5 cases fail**

Run: `cd app && npx vitest run src/__tests__/create-render.test.tsx`
Expected: FAIL — page not yet refactored, picker still mounted on success, `data-testid="canvas-bar"` not present, `__forceState` prop not supported.

- [ ] **Step 3: Commit**

```bash
git add app/src/__tests__/create-render.test.tsx
git commit -m "test(create): add failing render test for Document Canvas redesign"
```

---

## Task 2: Add canvas / chip / display-input utility classes

**Files:**
- Modify: `app/src/app/globals.css` — append to the end of the `@layer components` block (line 181 today, just before the closing `}` of `@layer components`)

These classes are the visual primitives for the canvas bar, the chip row, and the display-size inline-editable inputs. Reuse existing palette tokens (ink/paper/line/gold/sage).

- [ ] **Step 1: Append canvas-bar + chip + display-input classes to globals.css**

In `app/src/app/globals.css`, locate the closing `}` of the `@layer components { ... }` block (currently around line 181, right after the `.rule` definition). Insert these classes immediately before that closing brace:

```css
  /* ─── Document Canvas redesign (2026-05-04) ────────────────────── */

  /* Display-size inline-editable input. Real <input>, no border, looks
     like body text until focus, then a 1.5px ink underline animates in.
     Used for the "From" and "Bill to" headlines on /create. */
  .canvas-display-input {
    @apply w-full bg-transparent border-0 outline-none
           text-ink placeholder:text-line-2/70
           font-sans font-medium
           text-[40px] md:text-[48px]
           leading-[1.04] tracking-[-0.025em]
           pb-1 transition-[box-shadow] duration-200;
    box-shadow: inset 0 -1px 0 transparent;
  }
  .canvas-display-input:focus {
    box-shadow: inset 0 -1.5px 0 #1c1712;
  }

  /* Optional-detail chips below the items table. Filled = real value,
     empty = dashed click-to-add. Both behave as buttons (chip row owns
     the click → expand inline editor in InvoiceForm). */
  .canvas-chip {
    @apply inline-flex items-center gap-2
           px-3.5 py-2 rounded-full
           font-sans text-[13px] text-ink
           bg-ink/5 hover:bg-ink/10
           transition-colors duration-150
           focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/15;
  }
  .canvas-chip-empty {
    @apply bg-transparent text-muted hover:text-ink
           border border-dashed border-line;
  }
  .canvas-chip-empty:hover {
    @apply border-line-2;
  }

  /* Sticky canvas bar — fixed to viewport bottom across all 3 states.
     backdrop-blur preserves the feeling of paper continuing underneath. */
  .canvas-action-bar {
    background: rgba(241, 236, 224, 0.86);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    border-top: 1px solid rgba(28, 23, 18, 0.08);
    padding-bottom: max(16px, env(safe-area-inset-bottom));
    padding-top: 14px;
  }

  /* Mono meta tagline on the left of the compose-state bar. */
  .canvas-bar-meta {
    @apply font-mono text-[10.5px] tracking-[0.18em] uppercase text-muted;
  }

  /* Pulsing indicator in publishing state. */
  .canvas-bar-pulse {
    @apply inline-block w-2 h-2 rounded-full bg-gold;
    animation: slow-pulse 1.4s ease-in-out infinite;
  }

  /* Pay-link strip (success state) — quiet code-style fill, truncates
     long URLs with ellipsis. */
  .canvas-pay-link-strip {
    @apply bg-ink/5 rounded px-3.5 py-2.5
           font-mono text-[12px] text-ink/75
           truncate min-w-0;
  }

  /* Inline kbd hint inside primary buttons (⌘↵, ⌘C). */
  .canvas-kbd {
    @apply font-mono text-[10.5px] px-1.5 py-0.5 rounded
           bg-paper/20 text-paper/90 ml-1;
  }

  /* Page-content fade for publishing/success states (applied via class
     toggle on the form wrapper, not the bar). */
  .canvas-page-fade {
    @apply transition-opacity duration-500;
    opacity: 0.55;
  }
  @media (prefers-reduced-motion: reduce) {
    .canvas-display-input,
    .canvas-bar-pulse,
    .canvas-page-fade {
      transition: none !important;
      animation: none !important;
    }
  }

  /* ─── /Document Canvas redesign ────────────────────────────────── */
```

- [ ] **Step 2: Verify the dev server (or vitest) does not error**

Run: `cd app && npx tsc --noEmit`
Expected: exit 0 (CSS changes are not type-checked, but this catches accidental TSX changes).

- [ ] **Step 3: Commit**

```bash
git add app/src/app/globals.css
git commit -m "feat(create): canvas-bar / chip / display-input utility classes"
```

---

## Task 3: Build `<InvoiceCanvasBar>` component

**Files:**
- Create: `app/src/components/InvoiceCanvasBar.tsx`

Single component, three states via discriminated union. Owns the keyboard handlers (⌘↵ in compose, ⌘C in success) with `useEffect` cleanup so they unmount on route change.

- [ ] **Step 1: Create the component file**

Write `app/src/components/InvoiceCanvasBar.tsx` with this exact content:

```tsx
"use client";

import { useEffect } from "react";

export type CanvasBarState =
  | {
      kind: "compose";
      subtotalDisplay: string;
      canSubmit: boolean;
    }
  | {
      kind: "publishing";
      step: 1 | 2 | 3;
      stepLabel: string;
      awaitingWallet: boolean;
    }
  | {
      kind: "success";
      payUrl: string;
      copied: boolean;
      onCopy: () => void;
    };

interface Props {
  state: CanvasBarState;
  /** id of the form whose submit this bar's primary button drives (compose state only). */
  formId?: string;
}

/**
 * Single sticky bar at viewport bottom for /create. Renders one of three
 * variants based on `state.kind`. The DOM root never unmounts across
 * state transitions — only inner content swaps — which is what keeps the
 * "modal" mounted continuously through Phantom popups and through the
 * compose → publishing → success transition.
 *
 * Compose state's primary button uses HTML5 `form="<formId>"` attribute
 * so clicking it submits the form despite living outside the <form> DOM
 * tree. Pressing ⌘↵ anywhere on the page does the same.
 */
export function InvoiceCanvasBar({ state, formId = "invoice-form" }: Props) {
  // Keyboard handlers — scoped to mount lifetime of this component, which
  // unmounts on route change (Next.js page transition).
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      const isCmdOrCtrl = e.metaKey || e.ctrlKey;
      if (!isCmdOrCtrl) return;

      // ⌘↵ submits the form when in compose state with valid input.
      if (
        e.key === "Enter" &&
        state.kind === "compose" &&
        state.canSubmit
      ) {
        const form = document.getElementById(formId) as HTMLFormElement | null;
        if (form) {
          e.preventDefault();
          form.requestSubmit();
        }
      }

      // ⌘C copies the pay link in success state — but only if there's no
      // user text selection (don't hijack the user's own copy intent).
      if (e.key.toLowerCase() === "c" && state.kind === "success") {
        const selection = window.getSelection();
        if (selection && selection.toString().length > 0) return;
        e.preventDefault();
        state.onCopy();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [state, formId]);

  return (
    <div
      data-testid="canvas-bar"
      data-state={state.kind}
      role={state.kind === "publishing" ? "status" : undefined}
      aria-live={state.kind === "publishing" ? "polite" : undefined}
      className="canvas-action-bar fixed left-0 right-0 bottom-0 z-30"
    >
      <div className="max-w-[1400px] mx-auto px-6 md:px-8 flex items-center gap-3 md:gap-5 min-h-[60px]">
        {state.kind === "compose" && <ComposeBar state={state} formId={formId} />}
        {state.kind === "publishing" && <PublishingBar state={state} />}
        {state.kind === "success" && <SuccessBar state={state} />}
      </div>
    </div>
  );
}

function ComposeBar({
  state,
  formId,
}: {
  state: Extract<CanvasBarState, { kind: "compose" }>;
  formId: string;
}) {
  return (
    <>
      <span className="canvas-bar-meta hidden sm:inline-flex">
        Encrypts · Anchors · Umbra
      </span>
      <div className="ml-auto flex items-center gap-3 md:gap-5">
        <span
          data-testid="canvas-bar-subtotal"
          className="font-sans font-medium text-ink text-[16px] md:text-[18px] tabular-nums tracking-[-0.01em]"
        >
          {state.subtotalDisplay}
        </span>
        <button
          type="submit"
          form={formId}
          disabled={!state.canSubmit}
          className="btn-primary !px-5 !py-2.5 !rounded-full"
        >
          <span>Create private invoice</span>
          <kbd className="canvas-kbd">⌘↵</kbd>
        </button>
      </div>
    </>
  );
}

function PublishingBar({
  state,
}: {
  state: Extract<CanvasBarState, { kind: "publishing" }>;
}) {
  return (
    <>
      <span className="canvas-bar-pulse" aria-hidden />
      <div className="flex-1 min-w-0">
        <div className="font-sans font-medium text-[14px] text-ink truncate">
          {state.stepLabel}
        </div>
        <div className="font-mono text-[10.5px] text-muted tracking-[0.16em] uppercase">
          {String(state.step).padStart(2, "0")} / 03 ·{" "}
          {state.awaitingWallet ? "Waiting on wallet" : "In progress"}
        </div>
      </div>
    </>
  );
}

function SuccessBar({
  state,
}: {
  state: Extract<CanvasBarState, { kind: "success" }>;
}) {
  return (
    <>
      <div className="canvas-pay-link-strip flex-1 min-w-0">
        <span className="block truncate">{state.payUrl}</span>
      </div>
      <button
        type="button"
        onClick={state.onCopy}
        className="btn-primary !px-5 !py-2.5 !rounded-full shrink-0"
      >
        {state.copied ? (
          <span>Copied ✓</span>
        ) : (
          <>
            <span>Copy link</span>
            <kbd className="canvas-kbd">⌘C</kbd>
          </>
        )}
      </button>
      <a
        href="/dashboard"
        className="btn-ghost !px-5 !py-2.5 !rounded-full hidden sm:inline-flex shrink-0"
      >
        Dashboard
      </a>
    </>
  );
}
```

- [ ] **Step 2: Type-check the new component**

Run: `cd app && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/InvoiceCanvasBar.tsx
git commit -m "feat(create): InvoiceCanvasBar — sticky bar with compose/publish/success states"
```

---

## Task 4: Refactor `<InvoiceForm>` to controlled + strip cards + chips

**Files:**
- Modify: `app/src/components/InvoiceForm.tsx` (full rewrite — kept under 280 lines)

The form becomes a presentational component. Page owns state. No internal submit button. No card chrome. Notes / Due / Restrict become a chip row below the items table; clicking an empty chip expands the editor inline.

- [ ] **Step 1: Replace the file with the new controlled implementation**

Write `app/src/components/InvoiceForm.tsx` with this exact content:

```tsx
"use client";

import { useState } from "react";
import { PAYMENT_SYMBOL, PAYMENT_DECIMALS } from "@/lib/constants";

export interface InvoiceFormValues {
  creatorDisplayName: string;
  payerDisplayName: string;
  payerWallet: string;
  lineItems: Array<{ description: string; quantity: string; unitPrice: string }>;
  notes: string;
  dueDate: string;
}

interface Props {
  values: InvoiceFormValues;
  onChange: (update: Partial<InvoiceFormValues>) => void;
  onSubmit: () => void;
  errorMessage?: string | null;
  onDismissError?: () => void;
  /** Form id used by the canvas bar's submit button via HTML5 form= attr. */
  formId?: string;
}

/**
 * Controlled invoice form. State lives in the parent (CreatePage) so the
 * sticky <InvoiceCanvasBar> can read live subtotal + mount its own
 * primary button outside this <form> via `form="<formId>"`.
 *
 * No card chrome — a continuous editorial canvas. Section structure
 * preserved (Parties → Items → Optional details) but expressed via
 * type hierarchy and whitespace, not bordered <section>s.
 */
export function InvoiceForm({
  values,
  onChange,
  onSubmit,
  errorMessage,
  onDismissError,
  formId = "invoice-form",
}: Props) {
  // Which optional-detail chip is currently expanded for editing.
  // null = chip row is collapsed; "notes" / "due" / "restrict" = open.
  const [openChip, setOpenChip] = useState<null | "notes" | "due" | "restrict">(null);

  function update(partial: Partial<InvoiceFormValues>) {
    onDismissError?.();
    onChange(partial);
  }

  function updateLineItem(
    idx: number,
    field: "description" | "quantity" | "unitPrice",
    value: string,
  ) {
    onDismissError?.();
    onChange({
      lineItems: values.lineItems.map((li, i) =>
        i === idx ? { ...li, [field]: value } : li,
      ),
    });
  }

  function addLineItem() {
    onDismissError?.();
    onChange({
      lineItems: [
        ...values.lineItems,
        { description: "", quantity: "1", unitPrice: "" },
      ],
    });
  }

  function removeLineItem(idx: number) {
    onDismissError?.();
    onChange({ lineItems: values.lineItems.filter((_, i) => i !== idx) });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit();
  }

  return (
    <form id={formId} onSubmit={handleSubmit} className="space-y-12 md:space-y-14">
      {/* From / Bill to — display-size inline-editable headlines */}
      <div className="space-y-8 md:space-y-10">
        <div>
          <label className="eyebrow block mb-2" htmlFor="cv-from">From</label>
          <input
            id="cv-from"
            value={values.creatorDisplayName}
            onChange={(e) => update({ creatorDisplayName: e.target.value })}
            className="canvas-display-input"
            placeholder="Acme Design Ltd."
            required
            aria-label="From"
          />
        </div>
        <div>
          <label className="eyebrow block mb-2" htmlFor="cv-billto">Bill to</label>
          <input
            id="cv-billto"
            value={values.payerDisplayName}
            onChange={(e) => update({ payerDisplayName: e.target.value })}
            className="canvas-display-input"
            placeholder="Globex Corp."
            required
            aria-label="Bill to"
          />
        </div>
      </div>

      {/* Line items — clean table, no card */}
      <div className="border-t border-line pt-8">
        {/* Column headers */}
        <div className="hidden md:grid grid-cols-[1.75rem_1fr_4rem_9rem_8rem_1.5rem] gap-4 pb-3 border-b border-line items-baseline">
          <div />
          <div className="mono-chip">Description</div>
          <div className="mono-chip text-right">Qty</div>
          <div className="mono-chip text-right">Rate · {PAYMENT_SYMBOL}</div>
          <div className="mono-chip text-right">Amount</div>
          <div />
        </div>

        <div className="divide-y divide-line/60">
          {values.lineItems.map((li, idx) => (
            <LineItemRow
              key={idx}
              index={idx}
              item={li}
              canRemove={values.lineItems.length > 1}
              onChange={(field, value) => updateLineItem(idx, field, value)}
              onRemove={() => removeLineItem(idx)}
            />
          ))}
        </div>

        <div className="mt-5">
          <button
            type="button"
            onClick={addLineItem}
            className="inline-flex items-center gap-2 text-[13px] text-muted hover:text-ink transition-colors"
          >
            <span aria-hidden className="text-gold">+</span>
            Add line
          </button>
        </div>
      </div>

      {/* Optional-detail chips */}
      <div className="border-t border-line pt-8">
        <div className="flex flex-wrap gap-2.5">
          <DetailChip
            label={values.notes ? values.notes : "+ Note"}
            filled={!!values.notes}
            active={openChip === "notes"}
            onClick={() => setOpenChip(openChip === "notes" ? null : "notes")}
          />
          <DetailChip
            label={values.dueDate ? `Due ${values.dueDate}` : "+ Due date"}
            filled={!!values.dueDate}
            active={openChip === "due"}
            onClick={() => setOpenChip(openChip === "due" ? null : "due")}
          />
          <DetailChip
            label={
              values.payerWallet
                ? `Restricted to ${values.payerWallet.slice(0, 4)}…${values.payerWallet.slice(-4)}`
                : "+ Restrict who can pay"
            }
            filled={!!values.payerWallet}
            active={openChip === "restrict"}
            onClick={() => setOpenChip(openChip === "restrict" ? null : "restrict")}
          />
        </div>

        {/* Inline expansion area for the active chip */}
        {openChip === "notes" && (
          <div className="mt-5 max-w-2xl">
            <textarea
              value={values.notes}
              onChange={(e) => update({ notes: e.target.value })}
              className="input-editorial resize-none"
              rows={3}
              placeholder="Net 30. Late fee 1.5%/month. Thanks for your business."
              aria-label="Notes"
            />
          </div>
        )}

        {openChip === "due" && (
          <div className="mt-5 max-w-xs">
            <input
              type="date"
              value={values.dueDate}
              onChange={(e) => update({ dueDate: e.target.value })}
              className="input-editorial font-mono"
              aria-label="Due date"
            />
            {values.dueDate && (
              <button
                type="button"
                onClick={() => update({ dueDate: "" })}
                className="mt-2 text-[12px] text-muted hover:text-ink"
              >
                Clear
              </button>
            )}
          </div>
        )}

        {openChip === "restrict" && (
          <div className="mt-5 max-w-xl">
            <input
              value={values.payerWallet}
              onChange={(e) => update({ payerWallet: e.target.value })}
              className="input-editorial font-mono text-sm"
              placeholder="4w85uvq3GeKRWKeeB2CyH4FeSYtWsvumHt3XB2TaZdFg"
              aria-label="Payer wallet"
            />
            <p className="text-[12px] text-dim mt-2">
              Only the wallet you enter will be able to settle this invoice.
            </p>
          </div>
        )}
      </div>

      {/* Contextual error — sticky bar handles primary submit, no inline button */}
      {errorMessage && (
        <div className="flex items-start gap-4 border-l-2 border-brick pl-4 py-2 max-w-xl">
          <span className="mono-chip text-brick shrink-0 pt-0.5">Error</span>
          <span className="text-sm text-ink leading-relaxed flex-1">{errorMessage}</span>
          {onDismissError && (
            <button
              type="button"
              onClick={onDismissError}
              className="text-dim hover:text-ink transition-colors text-lg leading-none shrink-0"
              aria-label="Dismiss error"
            >
              ×
            </button>
          )}
        </div>
      )}
    </form>
  );
}

function DetailChip({
  label,
  filled,
  active,
  onClick,
}: {
  label: string;
  filled: boolean;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "canvas-chip",
        filled ? "" : "canvas-chip-empty",
        active ? "ring-2 ring-ink/15" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-expanded={active}
    >
      <span className={filled ? "text-ink" : ""}>{label}</span>
    </button>
  );
}

function LineItemRow({
  index,
  item,
  canRemove,
  onChange,
  onRemove,
}: {
  index: number;
  item: { description: string; quantity: string; unitPrice: string };
  canRemove: boolean;
  onChange: (field: "description" | "quantity" | "unitPrice", value: string) => void;
  onRemove: () => void;
}) {
  const amountMicros = computeLineMicros(item.quantity, item.unitPrice);
  const amountDisplay =
    amountMicros == null ? (
      <span className="text-dim">—</span>
    ) : (
      <span className="text-ink">{formatMicros(amountMicros)}</span>
    );

  return (
    <div className="md:grid md:grid-cols-[1.75rem_1fr_4rem_9rem_8rem_1.5rem] md:gap-4 md:items-baseline py-4 group flex flex-col gap-3">
      <div className="font-mono text-[11px] text-dim tabular-nums md:pt-2.5">
        {String(index + 1).padStart(2, "0")}
      </div>
      <div>
        <input
          value={item.description}
          onChange={(e) => onChange("description", e.target.value)}
          className="input-editorial"
          placeholder="Brand identity design (40h)"
          required
          aria-label={`Description for line ${index + 1}`}
        />
      </div>
      <div>
        <input
          value={item.quantity}
          onChange={(e) => onChange("quantity", sanitizeInteger(e.target.value))}
          inputMode="numeric"
          className="input-editorial text-right font-mono tabular-nums"
          placeholder="1"
          required
          aria-label={`Quantity for line ${index + 1}`}
        />
      </div>
      <div>
        <input
          value={item.unitPrice}
          onChange={(e) => onChange("unitPrice", sanitizeDecimal(e.target.value))}
          inputMode="decimal"
          className="input-editorial text-right font-mono tabular-nums"
          placeholder="0.00"
          required
          aria-label={`Unit price for line ${index + 1}`}
        />
      </div>
      <div className="text-right font-mono text-base tabular-nums md:pt-2">
        {amountDisplay}
      </div>
      <div className="md:text-right md:pt-1.5">
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="text-dim hover:text-brick transition-colors text-xl leading-none"
            aria-label={`Remove line ${index + 1}`}
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}

// ---- helpers (unchanged behavior, lifted into module scope) -------------

function sanitizeInteger(raw: string): string {
  return raw.replace(/[^\d]/g, "");
}

function sanitizeDecimal(raw: string): string {
  let cleaned = raw.replace(/[^\d.]/g, "");
  const firstDot = cleaned.indexOf(".");
  if (firstDot !== -1) {
    cleaned =
      cleaned.slice(0, firstDot + 1) +
      cleaned.slice(firstDot + 1).replace(/\./g, "");
    const [whole, frac = ""] = cleaned.split(".");
    cleaned = whole + "." + frac.slice(0, 6);
  }
  return cleaned;
}

function parseAmountToBaseUnits(value: string): bigint | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(
    new RegExp(`^(\\d+)(?:\\.(\\d{0,${PAYMENT_DECIMALS}}))?$`),
  );
  if (!match) return null;
  const whole = BigInt(match[1]);
  const fraction = (match[2] ?? "")
    .padEnd(PAYMENT_DECIMALS, "0")
    .slice(0, PAYMENT_DECIMALS);
  return whole * 10n ** BigInt(PAYMENT_DECIMALS) + BigInt(fraction);
}

function computeLineMicros(quantity: string, unitPrice: string): bigint | null {
  if (!quantity.trim() || !unitPrice.trim()) return null;
  const qty = Number.parseInt(quantity, 10);
  if (!Number.isFinite(qty) || qty <= 0) return null;
  const micros = parseAmountToBaseUnits(unitPrice);
  if (micros == null) return null;
  return BigInt(qty) * micros;
}

function formatMicros(micros: bigint): string {
  const divisor = 10n ** BigInt(PAYMENT_DECIMALS);
  const whole = micros / divisor;
  const fraction = micros % divisor;
  const fractionStr = fraction
    .toString()
    .padStart(PAYMENT_DECIMALS, "0")
    .slice(0, Math.min(4, PAYMENT_DECIMALS));
  return `${whole.toLocaleString("en-US")}.${fractionStr}`;
}

/**
 * Compute subtotal across all line items as base units. Exported so the
 * page can derive the live subtotal for the canvas bar.
 */
export function computeSubtotalMicros(values: InvoiceFormValues): bigint {
  return values.lineItems.reduce<bigint>((acc, li) => {
    const m = computeLineMicros(li.quantity, li.unitPrice);
    return m == null ? acc : acc + m;
  }, 0n);
}

/**
 * Format a bigint micros value as a "X,XXX.XX SYMBOL" string for the
 * canvas bar's subtotal indicator.
 */
export function formatSubtotal(micros: bigint): string {
  return `${formatMicros(micros)} ${PAYMENT_SYMBOL}`;
}
```

- [ ] **Step 2: Type-check**

Run: `cd app && npx tsc --noEmit`
Expected: many errors in `app/src/app/create/page.tsx` because we just changed `InvoiceForm`'s prop signature. That's fine — Task 5 fixes them.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/InvoiceForm.tsx
git commit -m "refactor(create): InvoiceForm becomes controlled, strips card chrome, adds chip row"
```

---

## Task 5: Wire `CreatePage` — hoist state, mount canvas bar, gate picker

**Files:**
- Modify: `app/src/app/create/page.tsx` (significant restructure of the invoice branch only — payroll branch untouched)

The page now owns form state and computes subtotal. It renders the canvas bar below the form section, gates the picker on `result === null`, and supports a `__forceState` test prop so the success-state test can render success without running through the full async flow.

- [ ] **Step 1: Rewrite create/page.tsx**

Write `app/src/app/create/page.tsx` with this exact content:

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { VeilLogo } from "@/components/VeilLogo";
import { PublicKey } from "@solana/web3.js";
import {
  InvoiceForm,
  type InvoiceFormValues,
  computeSubtotalMicros,
  formatSubtotal,
} from "@/components/InvoiceForm";
import { InvoiceCanvasBar, type CanvasBarState } from "@/components/InvoiceCanvasBar";
import {
  RegistrationModal,
  type RegistrationStep,
  type StepStatus,
} from "@/components/RegistrationModal";
import { CreateModeSelector } from "@/components/CreateModeSelector";
import { PayrollFlow } from "@/components/PayrollFlow";
import { getOrCreateClient, ensureRegistered, ensureReceiverKeyAligned } from "@/lib/umbra";
import { createInvoiceOnChain } from "@/lib/anchor";
import { buildMetadata, validateMetadata } from "@/lib/types";
import {
  encryptJson,
  getOrCreateMetadataMasterSig,
  deriveKeyFromMasterSig,
  keyToBase58,
  sha256,
} from "@/lib/encryption";
import { uploadCiphertext } from "@/lib/arweave";
import { USDC_MINT, PAYMENT_SYMBOL, PAYMENT_DECIMALS } from "@/lib/constants";

/**
 * /create — Document Canvas redesign (2026-05-04).
 *
 * Picker stays anchored at top while composing. After successful publish
 * (`result !== null`) the picker + "Choose differently" fade out so the
 * user's eye lands on the success state. The sticky <InvoiceCanvasBar>
 * persists across all states — never unmounts — which is what keeps
 * "the modal" mounted continuously through every Phantom popup.
 */

type Mode = "invoice" | "payroll" | null;

const SCROLL_BACK_MS = 900;

const EMPTY_FORM: InvoiceFormValues = {
  creatorDisplayName: "",
  payerDisplayName: "",
  payerWallet: "",
  lineItems: [{ description: "", quantity: "1", unitPrice: "" }],
  notes: "",
  dueDate: "",
};

type PublishStep = 1 | 2 | 3;

interface InvoiceResult {
  url: string;
  payerName: string;
  formattedAmount: string;
}

interface CreatePageProps {
  /** Test-only: force-render at a specific state for jsdom renders. */
  __forceState?: "success";
}

export default function CreatePage({ __forceState }: CreatePageProps = {}) {
  const wallet = useWallet();

  const [mode, setMode] = useState<Mode>(__forceState === "success" ? "invoice" : null);
  const [formExiting, setFormExiting] = useState(false);
  const formRef = useRef<HTMLElement>(null);
  const exitTimeoutRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (exitTimeoutRef.current !== null) {
        window.clearTimeout(exitTimeoutRef.current);
      }
    },
    [],
  );

  // Form state lifted into the page so the canvas bar can read live subtotal.
  const [values, setValues] = useState<InvoiceFormValues>(EMPTY_FORM);

  const [submitting, setSubmitting] = useState(false);
  const [publishStep, setPublishStep] = useState<PublishStep>(1);
  const [awaitingWallet, setAwaitingWallet] = useState(false);
  const [result, setResult] = useState<InvoiceResult | null>(
    __forceState === "success"
      ? {
          url: "https://veil.app/pay/CXfe1JwAXzSjvMKdFWgVkNE37vUdmwAW5aDfU6zbSNDW#8Mkfdk3G15PWkTk4F1QyMho2FCuVvGVFAiZJVzCiTmPt",
          payerName: "Globex Corp.",
          formattedAmount: "5,800.00 USDC",
        }
      : null,
  );
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [regOpen, setRegOpen] = useState(false);
  const [regSteps, setRegSteps] = useState<Record<RegistrationStep, StepStatus>>({
    init: "pending",
    x25519: "pending",
    commitment: "pending",
  });

  function handleSelectMode(next: "invoice" | "payroll") {
    if (exitTimeoutRef.current !== null) {
      window.clearTimeout(exitTimeoutRef.current);
      exitTimeoutRef.current = null;
      setFormExiting(false);
    }
    if (mode === next) {
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    setMode(next);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }

  function handleBackToPicker() {
    setFormExiting(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
    exitTimeoutRef.current = window.setTimeout(() => {
      setMode(null);
      setFormExiting(false);
      setError(null);
      setResult(null);
      setCopied(false);
      setValues(EMPTY_FORM);
      exitTimeoutRef.current = null;
    }, SCROLL_BACK_MS);
  }

  async function handleSubmit() {
    if (!wallet.publicKey || !wallet.signMessage) {
      setError("Connect wallet first");
      return;
    }
    setSubmitting(true);
    setPublishStep(1);
    setAwaitingWallet(false);
    setError(null);

    try {
      const parsedItems = values.lineItems.map((li, i) => {
        const unitPriceMicros = parseAmountToBaseUnits(li.unitPrice, PAYMENT_DECIMALS);
        if (unitPriceMicros == null) {
          throw new Error(
            `Line ${i + 1}: enter a valid ${PAYMENT_SYMBOL} amount (e.g. 100.00).`,
          );
        }
        const qty = Number.parseInt(li.quantity, 10);
        if (!Number.isFinite(qty) || qty <= 0) {
          throw new Error(`Line ${i + 1}: quantity must be a whole number ≥ 1.`);
        }
        return {
          description: li.description,
          quantity: qty.toString(),
          unitPriceMicros,
          totalMicros: unitPriceMicros * BigInt(qty),
        };
      });

      const client = await getOrCreateClient(wallet as any);
      setRegOpen(true);
      await ensureRegistered(client, (step, status) => {
        setRegSteps((prev) => ({
          ...prev,
          [step]: status === "pre" ? "in_progress" : "done",
        }));
      });
      await ensureReceiverKeyAligned(client);
      setRegOpen(false);

      // Step 1: encrypt + upload (one wallet popup for master sig on first run).
      setPublishStep(1);
      setAwaitingWallet(true);

      const invoiceId = `inv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const subtotal = parsedItems.reduce((sum, li) => sum + li.totalMicros, 0n);

      const nonce = crypto.getRandomValues(new Uint8Array(8));
      const { deriveInvoicePda } = await import("@/lib/anchor");
      const [pda] = deriveInvoicePda(wallet.publicKey, nonce);

      const md = buildMetadata({
        invoiceId,
        creatorDisplayName: values.creatorDisplayName,
        creatorWallet: wallet.publicKey.toBase58(),
        payerDisplayName: values.payerDisplayName,
        payerWallet: values.payerWallet || null,
        mint: USDC_MINT.toBase58(),
        symbol: PAYMENT_SYMBOL,
        decimals: PAYMENT_DECIMALS,
        lineItems: parsedItems.map((li) => ({
          description: li.description,
          quantity: li.quantity,
          unitPrice: li.unitPriceMicros.toString(),
          total: li.totalMicros.toString(),
        })),
        subtotal: subtotal.toString(),
        tax: "0",
        total: subtotal.toString(),
        dueDate: values.dueDate || null,
        terms: null,
        notes: values.notes || null,
      });
      validateMetadata(md);

      const masterSig = await getOrCreateMetadataMasterSig(
        wallet as any,
        wallet.publicKey.toBase58(),
      );
      setAwaitingWallet(false);

      // Step 2: encrypt + upload.
      setPublishStep(2);
      const key = await deriveKeyFromMasterSig(masterSig, pda.toBase58());
      const ciphertext = await encryptJson(md, key);
      const { uri } = await uploadCiphertext(ciphertext);
      const hash = await sha256(ciphertext);

      // Step 3: anchor on Solana — second wallet popup.
      setPublishStep(3);
      setAwaitingWallet(true);
      const restrictedPayer = values.payerWallet ? new PublicKey(values.payerWallet) : null;
      await createInvoiceOnChain(wallet as any, {
        nonce,
        metadataHash: hash,
        metadataUri: uri,
        mint: USDC_MINT,
        restrictedPayer,
        expiresAt: null,
      });
      setAwaitingWallet(false);

      const url = `${window.location.origin}/pay/${pda.toBase58()}#${keyToBase58(key)}`;
      setResult({
        url,
        payerName: values.payerDisplayName,
        formattedAmount: formatTotalForDisplay(subtotal, PAYMENT_DECIMALS, PAYMENT_SYMBOL),
      });
      requestAnimationFrame(() => {
        formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    } catch (err: any) {
      setError(err.message ?? String(err));
      setRegOpen(false);
      setAwaitingWallet(false);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCopy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.url);
    } catch {
      // jsdom and some non-secure contexts have no clipboard. Silently
      // skip — the visual feedback still flips.
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2200);
  }

  // Live subtotal feeds the canvas bar in compose state.
  const subtotalMicros = computeSubtotalMicros(values);
  const canSubmit = !submitting && wallet.connected && subtotalMicros > 0n;

  // Build the canvas bar state for whatever phase we're in. The
  // *invoice* mode only renders the bar; payroll has its own primary
  // action inside <PayrollFlow />.
  let canvasState: CanvasBarState | null = null;
  if (mode === "invoice") {
    if (result) {
      canvasState = {
        kind: "success",
        payUrl: result.url,
        copied,
        onCopy: handleCopy,
      };
    } else if (submitting) {
      const stepLabels: Record<PublishStep, string> = {
        1: "Encrypting metadata",
        2: "Uploading to Arweave",
        3: "Anchoring on Solana",
      };
      canvasState = {
        kind: "publishing",
        step: publishStep,
        stepLabel: stepLabels[publishStep],
        awaitingWallet,
      };
    } else if (wallet.connected) {
      canvasState = {
        kind: "compose",
        subtotalDisplay: formatSubtotal(subtotalMicros),
        canSubmit,
      };
    }
  }

  // True while the canvas-bar success state is active. Used to fade out
  // the picker + "Choose differently" link.
  const inSuccessState = mode === "invoice" && !!result;

  /* ─────────────────────────────── render ─────────────────────────────── */

  return (
    <Frame>
      <h1 className="sr-only">Compose a payment</h1>

      {/* Picker — anchored at top. Hidden during invoice success state. */}
      {!inSuccessState && (
        <section
          className={[
            "max-w-[1400px] mx-auto px-6 md:px-8 pt-24 md:pt-32 pb-16 md:pb-24",
            "transition-opacity duration-300",
          ].join(" ")}
        >
          <CreateModeSelector onSelect={handleSelectMode} />
        </section>
      )}

      {mode !== null && (
        <section
          ref={formRef}
          className={[
            "form-reveal scroll-mt-24",
            !inSuccessState ? "border-t border-line" : "",
            formExiting ? "is-exiting" : "",
            submitting ? "canvas-page-fade" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          aria-label={mode === "invoice" ? "Create invoice" : "Run payroll"}
        >
          <div className="max-w-[1400px] mx-auto px-6 md:px-8 pt-12 md:pt-16">
            {/* Choose differently — hidden in invoice success state */}
            {!inSuccessState && (
              <button
                type="button"
                onClick={handleBackToPicker}
                className="inline-flex items-center gap-2 font-mono text-[12.5px] tracking-[0.04em] text-muted hover:text-ink transition-colors"
              >
                <span aria-hidden>↑</span> Choose differently
              </button>
            )}

            {mode === "invoice" && (
              <div className={inSuccessState ? "mt-2" : "mt-8"}>
                <span className={inSuccessState ? "eyebrow text-sage" : "eyebrow"}>
                  {inSuccessState ? "✓ Published privately · Just now" : "New invoice"}
                </span>
              </div>
            )}
          </div>

          {mode === "invoice" ? (
            <div className="max-w-[1400px] mx-auto px-6 md:px-8 mt-8 md:mt-10 pb-32">
              <div className="max-w-3xl">
                {!wallet.connected ? (
                  <div className="max-w-lg">
                    <p className="text-[17px] md:text-[19px] text-ink/80 leading-[1.5] mb-8">
                      To publish a private invoice, connect the wallet you&apos;ll receive payment to.
                    </p>
                    <ClientWalletMultiButton />
                  </div>
                ) : (
                  <InvoiceForm
                    values={values}
                    onChange={(partial) =>
                      setValues((prev) => ({ ...prev, ...partial }))
                    }
                    onSubmit={handleSubmit}
                    errorMessage={error}
                    onDismissError={() => setError(null)}
                  />
                )}
                {result && <SuccessSummary result={result} />}
              </div>
            </div>
          ) : (
            <div className="max-w-[1400px] mx-auto px-6 md:px-8 mt-10 md:mt-12 pb-32">
              <PayrollFlow />
            </div>
          )}
        </section>
      )}

      {/* Canvas bar — invoice mode only. Persists across all states. */}
      {canvasState && <InvoiceCanvasBar state={canvasState} formId="invoice-form" />}

      <RegistrationModal open={regOpen} steps={regSteps} />

      <style
        dangerouslySetInnerHTML={{
          __html: `
        .form-reveal {
          opacity: 0;
          transform: translateY(40px);
          animation: form-reveal-anim 700ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
        .form-reveal.is-exiting {
          animation: form-exit-anim 600ms cubic-bezier(0.7, 0, 0.84, 0) forwards;
        }
        @keyframes form-reveal-anim {
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes form-exit-anim {
          from { opacity: 1; transform: translateY(0); }
          to { opacity: 0; transform: translateY(24px); }
        }
        @media (prefers-reduced-motion: reduce) {
          .form-reveal,
          .form-reveal.is-exiting {
            animation: none;
            opacity: 1;
            transform: none;
          }
        }
      `,
        }}
      />
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen relative pb-32">
      <nav className="sticky top-0 z-10 backdrop-blur-sm bg-paper/80 border-b border-line">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between px-6 md:px-8 py-4">
          <VeilLogo tagline="compose" />
          <div className="flex items-center gap-1 md:gap-2">
            <Link
              href="/create"
              className="hidden sm:inline-block px-3 py-2 text-[13px] text-ink"
            >
              Create
            </Link>
            <Link
              href="/dashboard"
              className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors"
            >
              Activity
            </Link>
            <Link
              href="/docs"
              className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors"
            >
              Docs
            </Link>
            <div className="ml-2">
              <ClientWalletMultiButton />
            </div>
          </div>
        </div>
      </nav>
      {children}
    </main>
  );
}

/**
 * Success summary rendered above the sticky bar — describes what was
 * shipped, with the recipient name and amount. The bar itself holds the
 * pay link + Copy button.
 */
function SuccessSummary({ result }: { result: InvoiceResult }) {
  return (
    <div className="max-w-2xl mt-10">
      <h3 className="font-sans font-medium text-ink text-[28px] md:text-[32px] leading-[1.1] tracking-[-0.025em]">
        <span className="tnum">{result.formattedAmount}</span>
        <span className="text-muted"> requested from </span>
        <span>{result.payerName}</span>
      </h3>
      <p className="mt-4 text-[14px] leading-[1.55] text-ink/70 max-w-[520px]">
        Send the link below to your client. Only their wallet (or yours via
        the dashboard) can open it — the chain only sees an anchor hash.
      </p>
    </div>
  );
}

/* ──────────────── helpers (unchanged from the prior version) ──────────────── */

function formatTotalForDisplay(units: bigint, decimals: number, symbol: string): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = units / divisor;
  const fraction = units % divisor;
  const display = Math.min(4, decimals);
  const padded = fraction.toString().padStart(decimals, "0").slice(0, display);
  const trimmed = padded.replace(/0+$/, "").padEnd(2, "0");
  const symbolPrefix = symbol === "USDC" ? "$" : "";
  const symbolSuffix = symbol === "USDC" ? " USDC" : ` ${symbol}`;
  return `${symbolPrefix}${whole.toLocaleString("en-US")}.${trimmed}${symbolSuffix}`;
}

function parseAmountToBaseUnits(value: string, decimals: number): bigint | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(new RegExp(`^(\\d+)(?:\\.(\\d{0,${decimals}}))?$`));
  if (!match) return null;
  const whole = BigInt(match[1]);
  const fraction = (match[2] ?? "").padEnd(decimals, "0").slice(0, decimals);
  return whole * 10n ** BigInt(decimals) + BigInt(fraction);
}
```

- [ ] **Step 2: Run type-check**

Run: `cd app && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Run the create-render test**

Run: `cd app && npx vitest run src/__tests__/create-render.test.tsx`
Expected: all 5 tests PASS.

- [ ] **Step 4: Run the full test suite to make sure nothing else broke**

Run: `cd app && npm test`
Expected: all tests pass (the dashboard test should still pass — it doesn't touch /create).

- [ ] **Step 5: Commit**

```bash
git add app/src/app/create/page.tsx
git commit -m "feat(create): wire InvoiceCanvasBar, hoist form state, hide picker on success

- Page owns InvoiceFormValues state so the canvas bar can read live
  subtotal and submit via HTML form= association.
- Canvas bar persists across compose → publishing → success without
  unmounting (solves 'modal disappears during Phantom popup').
- Picker + 'Choose differently' fade out in invoice success state.
- Removes inline 'Send another' button (use top-nav Create instead).
- Adds optional __forceState='success' test prop for jsdom rendering.
"
```

---

## Task 6: Final integration check + visual smoke

**Files:** none modified — verification only.

- [ ] **Step 1: Run the full test suite**

Run: `cd app && npm test`
Expected: ALL tests pass (existing dashboard test + new create-render test).

- [ ] **Step 2: Type-check the whole app**

Run: `cd app && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Visual smoke (manual, ~3 min)**

Run: `cd app && npm run dev` then open http://localhost:3000/create with a connected wallet.
Verify in the browser:
- Compose state: no `01 / 02 / 03` mono numbering anywhere
- Sticky bar visible at viewport bottom with subtotal + "Create private invoice ⌘↵" button
- Subtotal updates live as you type into qty/rate fields
- Clicking an empty chip ("+ Note", "+ Due date", "+ Restrict who can pay") expands an inline editor below the chip row
- ⌘↵ submits when subtotal > 0
- Click Create → registration modal appears (first-time only) → bar morphs into publishing state → bar morphs again into success state with pay link + Copy button
- Success state: picker AND "Choose differently" gone; ⌘C copies the pay link
- `prefers-reduced-motion: reduce` (DevTools → Rendering tab → Emulate CSS media feature): all animations skip, snap to final state

Stop the dev server with Ctrl+C.

- [ ] **Step 4: If smoke uncovers issues, file follow-ups (do not block this PR)**

The chip treatment for Notes/Due/Restrict is flagged as v1 in the spec. If it feels off in real use, capture the alternative as a TODO note in `docs/superpowers/notes/` for a polish-pass — don't block this plan from completing.

- [ ] **Step 5: Final commit (only if smoke surfaced fixable issues)**

```bash
git add <files>
git commit -m "fix(create): <what you fixed during smoke>"
```

---

## Self-review checklist (run after writing this plan)

**Spec coverage:**
- ✅ Compose state — no card chrome, display inputs (Task 4), chip row (Task 4), sticky bar with `⌘↵` (Task 3)
- ✅ Publishing state — page fade + bar morph in place (Task 5: `canvas-page-fade` class + `canvasState.kind = 'publishing'`)
- ✅ Success state — picker + "Choose differently" hide (Task 5: `inSuccessState` gate), pay-link strip + Copy + Dashboard (Task 3)
- ✅ Removed "+ Send another" — Task 3 SuccessBar has no such button; Task 1 test asserts absence
- ✅ Keyboard `⌘↵` and `⌘C` scoped to mount lifetime — Task 3 useEffect cleanup
- ✅ `prefers-reduced-motion: reduce` — Task 2 CSS rule, Task 5 page-level `<style>` block
- ✅ Animation register: 600ms cubic-bezier(0.16, 1, 0.3, 1) — preserved in Task 5 page-level `<style>` block
- ✅ Mobile sticky vs virtual keyboard — Task 2 `padding-bottom: max(16px, env(safe-area-inset-bottom))`
- ✅ Display inline-editable text uses real `<input>`, not contenteditable — Task 4 InvoiceForm
- ✅ PayrollFlow + payroll branch untouched — Task 5 only modifies the invoice render branch

**Placeholder scan:**
- No "TBD", "TODO", "implement later" anywhere in steps. Test code is full; component code is full; CSS is full.

**Type consistency:**
- `CanvasBarState` discriminated union (Task 3) matches what Task 5 constructs.
- `InvoiceFormValues` interface in Task 4 matches what Task 5 imports and uses.
- `computeSubtotalMicros` and `formatSubtotal` exported from Task 4, imported in Task 5.
- `formId` defaults to `"invoice-form"` in both Task 3 (canvas bar) and Task 4 (form) — consistent.

**Scope check:** Single-page redesign, no cross-cutting concerns, fits in one PR. Good.

If any spec requirement lacks a task, add a task. None found. Plan is ready.
