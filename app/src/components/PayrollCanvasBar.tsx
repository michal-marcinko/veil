"use client";

import { useEffect, useState } from "react";

/**
 * Detect Mac after mount. Same pattern as InvoiceCanvasBar's hook.
 * SSR returns null so we don't hydrate a wrong symbol; first client
 * render flips to the platform-correct value.
 */
function useModKey(): "⌘" | "Ctrl" | null {
  const [key, setKey] = useState<"⌘" | "Ctrl" | null>(null);
  useEffect(() => {
    const platform = typeof navigator !== "undefined" ? navigator.platform : "";
    setKey(/Mac|iPhone|iPad|iPod/.test(platform) ? "⌘" : "Ctrl");
  }, []);
  return key;
}

export type PayrollCanvasBarState =
  | {
      kind: "compose";
      rowCount: number;
      totalDisplay: string;
      canRun: boolean;
    }
  | {
      kind: "running";
      sentCount: number;
      totalCount: number;
      phase: "sending" | "signing";
      awaitingWallet: boolean;
    }
  | {
      kind: "success";
      packetUrl: string | null;
      paymentCount: number;
      totalDisplay: string;
      copied: boolean;
      onCopy: () => void;
      onDownloadClaimLinks?: () => void;
    };

interface Props {
  state: PayrollCanvasBarState;
  /** id of the form whose submit drives the compose-state primary button. */
  formId?: string;
}

/**
 * Sticky-bottom canvas bar for the /create payroll branch. Mirrors
 * InvoiceCanvasBar's morph-in-place pattern across compose → running
 * → success. The DOM root never unmounts; only inner content swaps.
 *
 * Compose state's primary button uses HTML5 `form="<formId>"` to
 * submit despite living outside the form. ⌘↵ does the same; ⌘C
 * copies the packet URL when the success state is mounted.
 */
export function PayrollCanvasBar({ state, formId = "payroll-form" }: Props) {
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      const isCmdOrCtrl = e.metaKey || e.ctrlKey;
      if (!isCmdOrCtrl) return;

      if (
        e.key === "Enter" &&
        state.kind === "compose" &&
        state.canRun
      ) {
        const form = document.getElementById(formId) as HTMLFormElement | null;
        if (form) {
          e.preventDefault();
          form.requestSubmit();
        }
      }

      if (
        e.key.toLowerCase() === "c" &&
        state.kind === "success" &&
        state.packetUrl
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
      data-testid="payroll-canvas-bar"
      data-state={state.kind}
      role={state.kind === "running" ? "status" : undefined}
      aria-live={state.kind === "running" ? "polite" : undefined}
      className="canvas-action-bar fixed left-0 right-0 bottom-0 z-30"
    >
      <div className="max-w-[1400px] mx-auto px-6 md:px-8 flex items-center gap-3 md:gap-5 min-h-[60px]">
        {state.kind === "compose" && <ComposeBar state={state} formId={formId} />}
        {state.kind === "running" && <RunningBar state={state} />}
        {state.kind === "success" && <SuccessBar state={state} />}
      </div>
    </div>
  );
}

function ComposeBar({
  state,
  formId,
}: {
  state: Extract<PayrollCanvasBarState, { kind: "compose" }>;
  formId: string;
}) {
  const modKey = useModKey();
  const buttonLabel =
    state.rowCount === 0
      ? "Run private payroll"
      : `Run ${state.rowCount} private payment${state.rowCount === 1 ? "" : "s"}`;

  return (
    <>
      <span className="canvas-bar-meta hidden sm:inline-flex">
        Private payroll · Umbra
      </span>
      <div className="ml-auto flex items-center gap-3 md:gap-5">
        <span
          data-testid="payroll-canvas-bar-total"
          className="font-sans font-medium text-ink text-[16px] md:text-[18px] tabular-nums tracking-[-0.01em]"
        >
          {state.totalDisplay}
        </span>
        <button
          type="submit"
          form={formId}
          disabled={!state.canRun}
          className="btn-primary !px-5 !py-2.5 !rounded-full"
        >
          <span>{buttonLabel}</span>
          {modKey && <kbd className="canvas-kbd">{modKey} ↵</kbd>}
        </button>
      </div>
    </>
  );
}

function RunningBar({
  state,
}: {
  state: Extract<PayrollCanvasBarState, { kind: "running" }>;
}) {
  const stepLabel =
    state.phase === "sending"
      ? `Sending payment ${state.sentCount + 1} of ${state.totalCount}`
      : "Signing receipt packet";
  const stepCounter =
    state.phase === "sending"
      ? `${String(state.sentCount).padStart(2, "0")} / ${String(state.totalCount).padStart(2, "0")} ·`
      : "FINAL ·";
  const walletState = state.awaitingWallet ? "Waiting on wallet" : "In progress";
  return (
    <>
      <span className="canvas-bar-pulse" aria-hidden />
      <div className="flex-1 min-w-0">
        <div className="font-sans font-medium text-[14px] text-ink truncate">
          {stepLabel}
        </div>
        <div className="font-mono text-[10.5px] text-muted tracking-[0.16em] uppercase">
          {stepCounter} {walletState}
        </div>
      </div>
    </>
  );
}

function SuccessBar({
  state,
}: {
  state: Extract<PayrollCanvasBarState, { kind: "success" }>;
}) {
  const modKey = useModKey();
  return (
    <>
      {state.packetUrl ? (
        <div className="canvas-pay-link-strip flex-1 min-w-0">
          <span className="block truncate">{state.packetUrl}</span>
        </div>
      ) : (
        <div className="canvas-bar-meta flex-1">
          {state.paymentCount} payment{state.paymentCount === 1 ? "" : "s"} sent ·{" "}
          {state.totalDisplay}
        </div>
      )}
      {state.packetUrl && (
        <button
          type="button"
          onClick={state.onCopy}
          className="btn-primary !px-5 !py-2.5 !rounded-full shrink-0"
        >
          {state.copied ? (
            <span>Copied ✓</span>
          ) : (
            <>
              <span>Copy packet</span>
              {modKey && <kbd className="canvas-kbd">{modKey} C</kbd>}
            </>
          )}
        </button>
      )}
      {state.onDownloadClaimLinks && (
        <button
          type="button"
          onClick={state.onDownloadClaimLinks}
          className="btn-ghost !px-5 !py-2.5 !rounded-full hidden md:inline-flex shrink-0"
        >
          Claim links
        </button>
      )}
      <a
        href="/dashboard"
        className="btn-ghost !px-5 !py-2.5 !rounded-full hidden sm:inline-flex shrink-0"
      >
        Dashboard
      </a>
    </>
  );
}
