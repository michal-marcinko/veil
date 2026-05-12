import type { SignedPayrollPacket } from "./private-payroll";

export function downloadPayrollPacketJson(signed: SignedPayrollPacket): void {
  const blob = new Blob([JSON.stringify(signed, null, 2)], { type: "application/json" });
  downloadBlob(blob, `${signed.packet.batchId}-veil-payroll-packet.json`);
}

export async function downloadPayrollPacketPdf(signed: SignedPayrollPacket): Promise<void> {
  const [{ pdf }, { PayrollPacketPdfDocument }] = await Promise.all([
    import("@react-pdf/renderer"),
    import("./payrollPacketPdf"),
  ]);
  const blob = await pdf(PayrollPacketPdfDocument({ signed })).toBlob();
  downloadBlob(blob, `${signed.packet.batchId}-veil-payroll-packet.pdf`);
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
