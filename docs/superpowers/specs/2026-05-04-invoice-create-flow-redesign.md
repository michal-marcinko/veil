# Invoice Create Flow Redesign — Document Canvas

**Date:** 2026-05-04
**Scope:** `/create` invoice flow only. Payroll branch unchanged.
**Mockup reference:** `.superpowers/brainstorm/695-1777860690/content/{layout-canvas,layout-canvas-success}.html`

---

## Goal

Modernize the invoice creation page. The current design uses 2018-2020 fintech card-with-mono-eyebrow register (`01 Parties / 02 Items / 03 Terms` bordered cards on cream paper) — research confirmed this is the dated giveaway pattern explicitly avoided by Linear's 2026 refresh, Mercury, Cron, and the 2026 fintech design playbook.

The redesign turns the page into a **Document Canvas**: the form IS the invoice, no card chrome, hierarchy from typography and whitespace. **One persistent sticky action bar at the bottom of the viewport** handles all four states — composing → publishing → success → reset — by morphing in place. That single move solves three user complaints in one stroke:

1. Layout feels modern and sleek (matches Linear / Mercury / Cron register).
2. The "modal disappears when Phantom popup opens" problem (the bar IS the modal, and it just sits there).
3. The hard-cut transition from form to success state (the bar morphs, the page above never reflows).

## Out of scope

- Payroll flow (`/create` payroll branch and `<PayrollFlow />`) — not touched.
- `/pay/[id]` recipient view — not touched.
- Top-level nav (`Create / Activity / Docs` and wallet button) — stays as-is on every state.
- Chip treatment for optional fields (Notes / Due / Restrict) — ships as v1 with a polish-pass tag; alternatives noted but not implemented now.

## State-by-state behavior

### Compose

- No bordered cards. No `01 / 02 / 03` mono eyebrows. Continuous editorial canvas.
- "From" (creator name) and "Bill to" (payer name) render as **display-size inline-editable text** (44-56px). Real `<input>` underneath; visual treatment is body-text-then-underline-on-focus, not bordered field.
- Line items: existing 5-col table preserved (`#`, description, qty, rate, amount, remove). No card around it; just a top hairline rule. Existing column widths and validation stay.
- Optional fields below subtotal as **chips**:
  - `Notes` — filled chip shows the text; empty chip = `+ Note`.
  - `Due date` — filled chip shows `Due 2026-06-04`; empty = `+ Due date`.
  - `Restrict who can pay` — filled = `Restricted to 4w85…ZdFg`; empty = `+ Restrict to wallet`.
  - Empty chips are dashed-border / muted; filled chips are subtle solid bg.
- Sticky bottom action bar: `ENCRYPTS · ANCHORS · UMBRA` mono meta on the left, live subtotal and `Create private invoice ⌘↵` button on the right.
- The `Compose a payment` picker section above stays mounted in compose state (existing behavior).

### Publishing

- Page content above the bar fades to `opacity: 0.55`. Becomes a recap, not interactive.
- Sticky bar morphs in place (no unmount, no DOM swap). Renders pulsing dot + step label + step counter.
  - Step labels track the existing flow: `Encrypting metadata · uploading to Arweave` → `Anchoring on Solana`.
  - Step counter renders `02 / 03 · WAITING ON WALLET` while a Phantom popup is open; flips to active text otherwise.
- The bar persists across all wallet popups: `signMessage` for the master sig, `signTransaction` for `create_invoice`.
- `RegistrationModal` (existing) still appears on first-time-user path during `ensureRegistered` — that's a separate concern (the 3-step setup) and overlays the canvas. After registration completes, the canvas bar continues with the publishing flow.

### Success

- Bar morphs once more into pay-link surface:
  - Left (flex-1): muted code-style strip showing the pay link with the PDA bolded and the host + key fragment muted.
  - Center: `Copy link ⌘C` primary button. Click swaps to `Copied ✓` for 2.2s.
  - Right: `Dashboard` ghost button.
- **No "+ Send another" button.** Removed. To create another invoice the user clicks `Create` in the top nav.
- Eyebrow above the invoice changes to `✓ Published privately · Just now` (sage green check, mono caps tail).
- Invoice content stays visible above (not dimmed) so the user sees what was just shipped.
- The `Compose a payment` picker section AND the `Choose differently` button **fade out and unmount** (300ms fade-out, then conditional unmount). Top nav stays.

### Reset path

- Clicking `Create` in the top nav from the success state navigates to `/create` fresh — page-level remount via Next.js routing. No SPA state preservation needed.
- Clicking the browser back button after success returns the user to wherever they came from; no special handling.

## Animation register

- All state transitions: 600ms `cubic-bezier(0.16, 1, 0.3, 1)` — the existing `form-reveal` ease-out-expo curve already used elsewhere in the codebase.
- Picker fade-out on success: 300ms ease-out, then unmount.
- Subtotal value transition: micro-interaction, 250ms tween between values when line items change. (Optional polish — skip if it adds complexity.)
- `prefers-reduced-motion: reduce`: all animations disabled, snap to final state.

## Keyboard

- `⌘↵` / `Ctrl+Enter` while focus is anywhere in the form → submit (only when subtotal > 0).
- `⌘C` while focus is in the success-state bar → copy pay link.
- Both are scoped to the `/create` page (mounted via `useEffect` keydown handler that unmounts on route change). They MUST NOT register globally.

## Files to change

1. **`app/src/app/create/page.tsx`** — restructure render: kill card chrome on the invoice branch, mount the new canvas bar, gate picker visibility on `result === null`, fade out picker + back button on success. Keep payroll branch untouched.
2. **`app/src/components/InvoiceForm.tsx`** — strip the three `<section>` card wrappers; replace the bordered "From" and "Bill to" inputs with display-size inline-editable inputs (`.canvas-display-input` class); remove the inline submit button (lives in canvas bar now); replace the optional payer-restriction collapse with a chip in the chip row; move the Notes + Due Date fields to chip-row interaction (chip click → expand inline editor).
3. **NEW: `app/src/components/InvoiceCanvasBar.tsx`** — single sticky-bottom component. Renders compose / publishing / success variants from a discriminated-union `state` prop. Owns the morph animations. Hosts the keyboard handlers (or accepts `onSubmit` and `onCopy` callbacks).
4. **CSS** — extend the existing `<style>` block in `create/page.tsx` (and/or `globals.css` for reusable classes) with: `.canvas-display-input`, `.canvas-chip` (filled + empty variants), `.canvas-action-bar`, `.canvas-bar-publish`, `.canvas-bar-success`. Match the existing cream/ink/gold palette.
5. **NEW (light): `app/src/__tests__/create-render.test.tsx`** — verifies (a) compose state renders no `01 / 02 / 03` mono numbering, (b) success state hides the `Compose a payment` picker and `Choose differently` button, (c) success state renders the pay-link strip and `Copy link` button. Reuses the wallet/anchor mock pattern from `dashboard-render.test.tsx`.

## Risks / trade-offs

- **Mobile sticky bar vs keyboard.** Sticky `position: fixed; bottom: 0` will overlap the iOS/Android virtual keyboard when an input is focused. Mitigation: `padding-bottom: env(safe-area-inset-bottom)` plus a `@media (max-width: 640px) { ... }` rule that switches the bar to `position: sticky` and lets it scroll out of the way when a chip editor expands.
- **Display-size inline-editable text.** The 44-56px "From" / "Bill to" inputs are real `<input>` elements styled to look like display text. Must keep `aria-label`, focus-visible ring, and proper baseline alignment. Cannot be a `contenteditable` div (loses form semantics + breaks Tailwind's `placeholder` styling).
- **Keyboard shortcut leakage.** `⌘↵` and `⌘C` are scoped to the `/create` page; failure to unmount the listener on route change would intercept browser shortcuts elsewhere. Use a `useEffect` cleanup function and verify in the new test.
- **Chip treatment v1.** User flagged ambivalence about chips for Notes/Due/Restrict. Spec ships them; if the live implementation feels off, fall-back is inline body-text rows below the subtotal (`Net 30. Late fee 1.5%/mo. ↗ Edit`). Polish-pass tag in the plan.

## Open questions

None. Approvals captured: Document Canvas direction (yes), no `+ Send another` (yes), top nav stays (implied — no contradiction raised after I asked).

## Success criteria

- `/create` invoice branch renders with no `01 / 02 / 03` numbering anywhere; no bordered card backgrounds for the form sections.
- Sticky bar visible at viewport bottom in all three states. State transitions are smooth (no flash of unstyled content, no DOM unmount-remount of the bar).
- Pressing the publish button keeps the bar mounted continuously through the entire signing flow including all Phantom popups.
- Success state hides the picker and `Choose differently` button.
- All existing tests pass; new `create-render.test.tsx` passes.
- `npx tsc --noEmit` exits 0.
