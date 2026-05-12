import type { InvoiceMetadata } from "./types";

/**
 * Lazy-load the PDF renderer + invoice document and trigger a browser
 * download of the rendered invoice. Dynamic import keeps the ~600KB
 * @react-pdf bundle out of the initial route payload — only users who
 * click "Download PDF" pay the load cost.
 *
 * Filename defaults to `veil-<invoice_id>.pdf`; pass a custom string
 * to override (e.g. for accountant packets).
 *
 * Backwards-compatible signature — keep using the original lightweight
 * `lib/invoicePdf.tsx` template for the legacy callers in `/invoice/[id]`
 * and `/pay/[id]`. The audit-mode variants ship as `downloadHeavyInvoicePdf`
 * and `downloadReceiptPdf` below.
 */
export async function downloadInvoicePdf(
  metadata: InvoiceMetadata,
  invoicePda: string,
  filename?: string,
): Promise<void> {
  const [{ pdf }, { InvoicePdfDocument }] = await Promise.all([
    import("@react-pdf/renderer"),
    import("./invoicePdf"),
  ]);

  const blob = await pdf(InvoicePdfDocument({ metadata, invoicePda })).toBlob();
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename ?? `veil-${metadata.invoice_id}.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Heavy PDF variants — invoice (with optional audit footer) + receipt.
// ---------------------------------------------------------------------------

export interface DownloadHeavyInvoiceArgs {
  metadata: InvoiceMetadata;
  invoicePda: string;
  /** When true, append the AuditFooter with on-chain refs + verifier QR. */
  auditMode?: boolean;
  /** Required when auditMode is true. From the on-chain Invoice account. */
  metadataHash?: Uint8Array;
  network?: "devnet" | "mainnet";
  slot?: number | null;
  createdAtIso?: string;
  chainStatus?: "Pending" | "Paid";
  documentSignature?: string;
  filename?: string;
}

export async function downloadHeavyInvoicePdf(
  args: DownloadHeavyInvoiceArgs,
): Promise<void> {
  const [{ pdf }, { InvoicePdfDocument }] = await Promise.all([
    import("@react-pdf/renderer"),
    import("./pdf/invoicePdf"),
  ]);

  const blob = await pdf(
    InvoicePdfDocument({
      metadata: args.metadata,
      invoicePda: args.invoicePda,
      auditMode: args.auditMode ?? false,
      metadataHash: args.metadataHash,
      network: args.network,
      slot: args.slot,
      createdAtIso: args.createdAtIso,
      chainStatus: args.chainStatus,
      documentSignature: args.documentSignature,
    }),
  ).toBlob();

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download =
    args.filename ??
    `veil-invoice-${args.metadata.invoice_id}${args.auditMode ? "-audit" : ""}.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export interface DownloadReceiptArgs {
  metadata: InvoiceMetadata;
  invoicePda: string;
  metadataHash: Uint8Array;
  network?: "devnet" | "mainnet";
  slot?: number | null;
  createdAtIso?: string;
  /** Lock + payment refs. */
  lockPda: string;
  payerWallet: string;
  lockedAtIso: string;
  paymentTxSig?: string | null;
  markPaidTxSig?: string | null;
  documentSignature?: string;
  filename?: string;
}

export async function downloadReceiptPdf(args: DownloadReceiptArgs): Promise<void> {
  const [{ pdf }, { ReceiptPdfDocument }] = await Promise.all([
    import("@react-pdf/renderer"),
    import("./pdf/receiptPdf"),
  ]);

  const blob = await pdf(
    ReceiptPdfDocument({
      metadata: args.metadata,
      invoicePda: args.invoicePda,
      metadataHash: args.metadataHash,
      network: args.network,
      slot: args.slot,
      createdAtIso: args.createdAtIso,
      lockPda: args.lockPda,
      payerWallet: args.payerWallet,
      lockedAtIso: args.lockedAtIso,
      paymentTxSig: args.paymentTxSig,
      markPaidTxSig: args.markPaidTxSig,
      documentSignature: args.documentSignature,
    }),
  ).toBlob();

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = args.filename ?? `veil-receipt-${args.metadata.invoice_id}.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
