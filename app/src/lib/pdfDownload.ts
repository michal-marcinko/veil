import type { InvoiceMetadata } from "./types";

/**
 * Lazy-load the PDF renderer + invoice document and trigger a browser
 * download of the rendered invoice. Dynamic import keeps the ~600KB
 * @react-pdf bundle out of the initial route payload — only users who
 * click "Download PDF" pay the load cost.
 *
 * Filename defaults to `veil-<invoice_id>.pdf`; pass a custom string
 * to override (e.g. for accountant packets).
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
