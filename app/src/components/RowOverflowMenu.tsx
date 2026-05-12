"use client";

// ---------------------------------------------------------------------------
// RowOverflowMenu — three-dot menu attached to invoice / payroll / payslip
// rows in the dashboard. Houses the per-row reconciliation actions that
// would otherwise crowd the row header.
//
// Items shown depend on which props the parent passes — invoice rows pass
// `invoicePda`, payroll rows pass `payrollBatchId` (+/- recipient wallet
// for sent-side rows; the sender knows which recipient a given row points
// to from the packet they signed).
//
// Keyboard:
//   - Trigger button is a real <button>, focusable + clickable
//   - Esc closes the open menu
//   - Tab advances through items naturally; clicking a non-link item
//     closes the menu
//
// Visual register: thin border, paper background, small font, single-line
// rows. No chunky list items — this is a dense reconciliation tool, not
// a settings panel.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { explorerAddressUrl } from "@/lib/explorer";

interface RowOverflowMenuProps {
  /** Invoice PDA (base58). When set, exposes invoice-scoped actions:
   *  download invoice PDF, download receipt PDF (if locked/paid),
   *  send compliance grant. */
  invoicePda?: string;
  /** Payroll batch ID. When set, exposes "open payroll drill-in" + a
   *  link to the compliance picker (run-scoped grants are v2). */
  payrollBatchId?: string;
  /** Wallet of the recipient on a payroll row. Used to enable the
   *  payslip-PDF action when present. */
  payrollRecipientWallet?: string;
  /** Optional: the invoice has a payment lock or status === Paid.
   *  Determines whether the "Download receipt PDF" item is enabled. */
  invoiceHasLock?: boolean;
  /** Callbacks fired when the user picks a download action. The parent
   *  owns the actual PDF generation (it has the on-chain context the
   *  PDFs need — metadata, lock state, etc.). When omitted, the menu
   *  hides the corresponding item. */
  onDownloadInvoicePdf?: () => void;
  onDownloadReceiptPdf?: () => void;
  onDownloadPayslipPdf?: () => void;
}

export function RowOverflowMenu(props: RowOverflowMenuProps) {
  const {
    invoicePda,
    payrollBatchId,
    payrollRecipientWallet,
    invoiceHasLock = false,
    onDownloadInvoicePdf,
    onDownloadReceiptPdf,
    onDownloadPayslipPdf,
  } = props;

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click + Esc.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Compose the compliance grant URL — pre-fill `seed` only for
  // invoice-scoped opens. Payroll rows go to /dashboard/compliance with
  // no seed (run-scoped grants are v2 — see drill-in page).
  const complianceHref = invoicePda
    ? `/dashboard/compliance?seed=${encodeURIComponent(invoicePda)}`
    : "/dashboard/compliance";

  const explorerHref = invoicePda
    ? explorerAddressUrl(invoicePda)
    : payrollRecipientWallet
      ? explorerAddressUrl(payrollRecipientWallet)
      : null;

  const items = useMemo(() => {
    const list: Array<{
      key: string;
      label: string;
      onClick?: () => void;
      href?: string;
      target?: string;
      disabled?: boolean;
    }> = [];

    if (invoicePda && onDownloadInvoicePdf) {
      list.push({
        key: "invoice-pdf",
        label: "Download invoice PDF",
        onClick: () => {
          setOpen(false);
          onDownloadInvoicePdf();
        },
      });
    }

    if (invoicePda && onDownloadReceiptPdf) {
      list.push({
        key: "receipt-pdf",
        label: invoiceHasLock
          ? "Download receipt PDF"
          : "Download receipt PDF (no payment yet)",
        onClick: invoiceHasLock
          ? () => {
              setOpen(false);
              onDownloadReceiptPdf();
            }
          : undefined,
        disabled: !invoiceHasLock,
      });
    }

    if (payrollBatchId && payrollRecipientWallet && onDownloadPayslipPdf) {
      list.push({
        key: "payslip-pdf",
        label: "Download payslip PDF",
        onClick: () => {
          setOpen(false);
          onDownloadPayslipPdf();
        },
      });
    }

    if (payrollBatchId) {
      list.push({
        key: "drill-in",
        label: "Open payroll run",
        href: `/dashboard/payroll/${encodeURIComponent(payrollBatchId)}`,
      });
    }

    if (invoicePda || payrollBatchId) {
      list.push({
        key: "compliance",
        label: "Send compliance grant",
        href: complianceHref,
      });
    }

    if (explorerHref) {
      list.push({
        key: "explorer",
        label: "View on Solana Explorer",
        href: explorerHref,
        target: "_blank",
      });
    }

    return list;
  }, [
    invoicePda,
    payrollBatchId,
    payrollRecipientWallet,
    invoiceHasLock,
    onDownloadInvoicePdf,
    onDownloadReceiptPdf,
    onDownloadPayslipPdf,
    complianceHref,
    explorerHref,
  ]);

  // Don't render the trigger if there's nothing to show.
  if (items.length === 0) return null;

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        type="button"
        aria-label="Row actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="inline-flex h-6 w-6 items-center justify-center rounded text-dim hover:text-ink hover:bg-line/40 focus:outline-none focus:ring-1 focus:ring-line"
      >
        <span aria-hidden="true" className="font-mono text-[14px] leading-none">&hellip;</span>
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 min-w-[200px] border border-line bg-paper shadow-sm"
        >
          {items.map((item) => {
            const cls =
              "block w-full text-left px-3 py-1.5 text-[12px] tracking-[0.01em] text-ink hover:bg-line/40 disabled:text-dim disabled:hover:bg-transparent disabled:cursor-not-allowed focus:outline-none focus:bg-line/40";
            if (item.href) {
              return (
                <Link
                  key={item.key}
                  href={item.href}
                  target={item.target}
                  className={cls}
                  role="menuitem"
                  onClick={() => setOpen(false)}
                >
                  {item.label}
                </Link>
              );
            }
            return (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={item.onClick}
                className={cls}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
