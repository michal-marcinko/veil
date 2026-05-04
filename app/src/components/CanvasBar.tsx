"use client";

import { useEffect, useState } from "react";

/**
 * Detect Mac after mount. SSR returns null so we don't hydrate a wrong
 * symbol; first client render flips to the platform-correct value.
 * Brief absence of the kbd hint is preferable to a hydration mismatch
 * warning.
 */
function useModKey(): "⌘" | "Ctrl" | null {
  const [key, setKey] = useState<"⌘" | "Ctrl" | null>(null);
  useEffect(() => {
    const platform = typeof navigator !== "undefined" ? navigator.platform : "";
    setKey(/Mac|iPhone|iPad|iPod/.test(platform) ? "⌘" : "Ctrl");
  }, []);
  return key;
}

/**
 * Single source of truth for the sticky-bottom canvas bar used by both
 * the /create invoice flow and the /create payroll flow. Three states,
 * one DOM root that morphs in place — never unmounts mid-flow, which is
 * what keeps the bar visible across every Phantom popup.
 *
 * Per-flow specifics (button label, copy label, extra ghost buttons)
 * are passed via the discriminated state union, so the bar itself
 * stays oblivious to whether it's serving an invoice or a payroll.
 *
 * Compose state's primary button uses HTML5 `form="<formId>"` so a
 * click submits the host form despite living outside the form's DOM
 * tree. ⌘↵ does the same; ⌘C copies the success-state share URL.
 */
export type CanvasBarState =
  | {
      kind: "compose";
      /** Total to display next to the primary button (e.g. "5,800.00 USDC"). */
      totalDisplay: string;
      /** Whether the primary button is enabled. */
      canSubmit: boolean;
      /** Button label — varies per flow ("Create private invoice" / "Run N private payments"). */
      buttonLabel: string;
    }
  | {
      kind: "publishing";
      /** Title line — what's happening right now. */
      stepLabel: string;
      /** Mono caps counter — "02 / 03" or "03 / 12" or "FINAL". */
      stepCounter: string;
      awaitingWallet: boolean;
    }
  | {
      kind: "success";
      /** Share URL the user copies. Null falls back to `fallbackMeta`. */
      shareUrl: string | null;
      /** Primary-button copy label ("Copy link" / "Copy packet"). */
      copyLabel: string;
      copied: boolean;
      onCopy: () => void;
      /** Used when shareUrl is null — e.g. before a packet is signed. */
      fallbackMeta?: string;
      /** Optional ghost buttons before the Dashboard link (e.g. "Claim links"). */
      extras?: Array<{ label: string; onClick: () => void }>;
    };

interface Props {
  state: CanvasBarState;
  /** id of the form whose submit this bar's compose-state primary button drives. */
  formId?: string;
}

export function CanvasBar({ state, formId = "canvas-form" }: Props) {
  // Keyboard handlers — scoped to component mount lifetime, which
  // unmounts on route change (Next.js page transition).
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      const isCmdOrCtrl = e.metaKey || e.ctrlKey;
      if (!isCmdOrCtrl) return;

      if (e.key === "Enter" && state.kind === "compose" && state.canSubmit) {
        const form = document.getElementById(formId) as HTMLFormElement | null;
        if (form) {
          e.preventDefault();
          form.requestSubmit();
        }
      }

      if (
        e.key.toLowerCase() === "c" &&
        state.kind === "success" &&
        state.shareUrl
      ) {
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
        {state.kind === "compose" && <ComposeContent state={state} formId={formId} />}
        {state.kind === "publishing" && <PublishingContent state={state} />}
        {state.kind === "success" && <SuccessContent state={state} />}
      </div>
    </div>
  );
}

function ComposeContent({
  state,
  formId,
}: {
  state: Extract<CanvasBarState, { kind: "compose" }>;
  formId: string;
}) {
  const modKey = useModKey();
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
          {state.totalDisplay}
        </span>
        <button
          type="submit"
          form={formId}
          disabled={!state.canSubmit}
          className="btn-primary !px-5 !py-2.5 !rounded-full"
        >
          <span>{state.buttonLabel}</span>
          {modKey && <kbd className="canvas-kbd">{modKey} ↵</kbd>}
        </button>
      </div>
    </>
  );
}

function PublishingContent({
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
          {state.stepCounter} · {state.awaitingWallet ? "Waiting on wallet" : "In progress"}
        </div>
      </div>
    </>
  );
}

function SuccessContent({
  state,
}: {
  state: Extract<CanvasBarState, { kind: "success" }>;
}) {
  const modKey = useModKey();
  return (
    <>
      {state.shareUrl ? (
        <div className="canvas-pay-link-strip flex-1 min-w-0">
          <span className="block truncate">{state.shareUrl}</span>
        </div>
      ) : state.fallbackMeta ? (
        <div className="canvas-bar-meta flex-1 truncate">{state.fallbackMeta}</div>
      ) : null}

      {state.shareUrl && (
        <button
          type="button"
          onClick={state.onCopy}
          className="btn-primary !px-5 !py-2.5 !rounded-full shrink-0"
        >
          {state.copied ? (
            <span>Copied ✓</span>
          ) : (
            <>
              <span>{state.copyLabel}</span>
              {modKey && <kbd className="canvas-kbd">{modKey} C</kbd>}
            </>
          )}
        </button>
      )}

      {state.extras?.map((extra) => (
        <button
          key={extra.label}
          type="button"
          onClick={extra.onClick}
          className="btn-ghost !px-5 !py-2.5 !rounded-full hidden md:inline-flex shrink-0"
        >
          {extra.label}
        </button>
      ))}

      <a
        href="/dashboard"
        className="btn-ghost !px-5 !py-2.5 !rounded-full hidden sm:inline-flex shrink-0"
      >
        Dashboard
      </a>
    </>
  );
}
