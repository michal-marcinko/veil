// ---------------------------------------------------------------------------
// Recipient-side payslip PDF (Phase B).
//
// Mirrors `payrollPacketPdf.tsx`'s visual language so a payslip looks
// like part of the same product as the sender's payroll packet:
//   - same paper background (#f8f4e9), same ink color (#1c1712)
//   - same eyebrow + title typography (uppercase mono small-caps eyebrow,
//     large display title)
//   - same hairline borders (#d6ceba) on the data table
//
// One-page A4 by design. The recipient gets a single archival document
// per claim with the on-chain anchors needed to verify the row.
// ---------------------------------------------------------------------------

import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { ReceivedPayment } from "./received-payments-storage";

const styles = StyleSheet.create({
  page: {
    padding: 36,
    fontSize: 10,
    fontFamily: "Helvetica",
    color: "#1c1712",
    backgroundColor: "#f8f4e9",
  },
  eyebrow: {
    fontSize: 8,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    color: "#736b57",
    marginBottom: 8,
  },
  title: {
    fontSize: 24,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 10,
    color: "#736b57",
    lineHeight: 1.45,
    marginBottom: 24,
  },
  // Veil Descent Mark — tiny inline header glyph rendered in pure SVG-
  // free flat drawing primitives so we don't pull `@react-pdf/svg-renderer`
  // in. A square framed page with a single "veil" line under the figure
  // — visually echoes the dashboard logo without trying to redraw the
  // full animated SVG mark.
  markRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 18,
  },
  markBox: {
    width: 32,
    height: 32,
    border: "1.4 solid #1c1712",
  },
  markBar: {
    height: 2,
    backgroundColor: "#1c1712",
    marginTop: 14,
    marginLeft: 4,
    marginRight: 4,
  },
  markLabel: {
    fontSize: 8,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    color: "#1c1712",
  },
  table: {
    border: "1 solid #d6ceba",
    marginBottom: 18,
  },
  row: {
    flexDirection: "row",
    borderBottom: "1 solid #d6ceba",
    minHeight: 22,
    alignItems: "stretch",
  },
  lastRow: {
    borderBottom: "0 solid transparent",
  },
  labelCell: {
    width: "26%",
    padding: 7,
    fontSize: 7,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: "#736b57",
    borderRight: "1 solid #d6ceba",
  },
  valueCell: {
    width: "74%",
    padding: 7,
    fontSize: 9,
    lineHeight: 1.35,
  },
  link: {
    color: "#1c1712",
    textDecoration: "underline",
  },
  txList: {
    border: "1 solid #d6ceba",
    padding: 8,
    marginBottom: 18,
  },
  txRow: {
    fontSize: 8,
    color: "#1c1712",
    marginBottom: 3,
  },
  footnote: {
    marginTop: 10,
    paddingTop: 10,
    borderTop: "1 solid #d6ceba",
    fontSize: 7.5,
    color: "#736b57",
    lineHeight: 1.4,
  },
});

export interface PayslipPdfProps {
  payment: ReceivedPayment;
  /** Connected recipient wallet — shown in the "Recipient" row. The
   *  payment record itself doesn't carry this because the recipient
   *  IS the holder of the cache; passing it explicitly avoids assuming
   *  a wallet adapter is in scope at render time. */
  recipientWallet?: string;
  /** Optional human-friendly name the SENDER labelled the recipient
   *  with (e.g. "Alice"). Surfaced in the "To" row of the fact-table
   *  block when present; the row is omitted entirely when this is
   *  empty/undefined so legacy payslips render unchanged. */
  recipientName?: string;
  /** Network the tx signatures belong to. Only used for the explorer
   *  links — defaults to devnet matching the rest of the app. */
  network?: "devnet" | "mainnet";
}

function explorerUrl(sig: string, network: "devnet" | "mainnet"): string {
  return `https://explorer.solana.com/tx/${sig}${
    network === "devnet" ? "?cluster=devnet" : ""
  }`;
}

function truncate(value: string, head = 8, tail = 7): string {
  if (!value) return "";
  if (value.length <= head + tail + 2) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function formatDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t);
  // ISO-day (YYYY-MM-DD) plus HH:MM in local time. Recipients may
  // print these for tax archives — keeping it locale-independent.
  const date = d.toISOString().slice(0, 10);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${date} ${hh}:${mm}`;
}

/**
 * Single-row body table — keeps the layout under 200 LOC of styling by
 * reusing one row component for all the fact pairs.
 */
function Fact({
  label,
  value,
  isLast,
}: {
  label: string;
  value: string;
  isLast?: boolean;
}) {
  return (
    <View style={[styles.row, isLast ? styles.lastRow : {}]}>
      <Text style={styles.labelCell}>{label}</Text>
      <Text style={styles.valueCell}>{value}</Text>
    </View>
  );
}

export function PayslipPdfDocument({
  payment,
  recipientWallet,
  recipientName,
  network = "devnet",
}: PayslipPdfProps) {
  const trimmedRecipientName = recipientName?.trim();
  const senderDisplay = payment.senderDisplayName?.trim()
    ? `${payment.senderDisplayName} (${truncate(payment.senderWallet)})`
    : payment.senderWallet
    ? truncate(payment.senderWallet)
    : "Sender hidden (mixer)";

  const memo = payment.memo?.trim() ? payment.memo : "—";
  const modeLabel =
    payment.mode === "mixer" ? "Mixer-protected" : "Direct sweep";
  const amountText = `${payment.amountDisplay} ${payment.symbol}`;

  // On-chain anchors the recipient may want to verify. Only include the
  // signatures that exist for this row's `mode`.
  const txAnchors: Array<{ label: string; sig: string }> = [];
  txAnchors.push({ label: "Final claim", sig: payment.claimSignature });
  if (payment.withdrawSignature) {
    txAnchors.push({ label: "Withdraw", sig: payment.withdrawSignature });
  }
  if (payment.reencryptSignature) {
    txAnchors.push({
      label: "Re-encrypt (mixer hop)",
      sig: payment.reencryptSignature,
    });
  }
  if (payment.sweepSignature) {
    txAnchors.push({ label: "Sweep", sig: payment.sweepSignature });
  }

  return (
    <Document
      title={`Veil payslip ${payment.batchId} row ${payment.rowIndex}`}
      author="Veil"
      subject="Recipient-side payslip for a private payment"
    >
      <Page size="A4" style={styles.page}>
        {/* Veil Descent Mark — minimal flat-drawing analog of the
            dashboard logo. Frame represents the page; the bar across
            the middle reads as the descended veil. */}
        <View style={styles.markRow}>
          <View style={styles.markBox}>
            <View style={styles.markBar} />
          </View>
          <Text style={styles.markLabel}>Veil · Payslip</Text>
        </View>
        <Text style={styles.eyebrow}>Veil received-payment receipt</Text>
        <Text style={styles.title}>Payslip</Text>
        <Text style={styles.subtitle}>
          Confirmation that {amountText} arrived in your wallet via a Veil
          private payment. The on-chain transactions below let you verify
          the claim independently.
        </Text>

        <View style={styles.table}>
          <Fact label="Amount" value={amountText} />
          <Fact label="Sender" value={senderDisplay} />
          {trimmedRecipientName ? (
            <Fact label="To" value={trimmedRecipientName} />
          ) : null}
          <Fact
            label="Recipient"
            value={recipientWallet ? truncate(recipientWallet) : "—"}
          />
          <Fact
            label="Date received"
            value={formatDate(payment.receivedAt)}
          />
          <Fact label="Memo" value={memo} />
          <Fact label="Mint" value={truncate(payment.mint)} />
          <Fact label="Batch" value={payment.batchId} />
          <Fact label="Row" value={String(payment.rowIndex)} />
          <Fact label="Mode" value={modeLabel} isLast />
        </View>

        <Text style={styles.eyebrow}>On-chain anchors</Text>
        <View style={styles.txList}>
          {txAnchors.map((a) => (
            <Text key={a.label} style={styles.txRow}>
              <Text>{a.label}: </Text>
              <Text style={styles.link}>{explorerUrl(a.sig, network)}</Text>
            </Text>
          ))}
        </View>

        <Text style={styles.footnote}>
          {payment.mode === "mixer"
            ? "Mixer-protected: this payment was routed through the Umbra " +
              "stealth pool. Observers can see funds entering and leaving " +
              "the pool but cannot link the sender to you on-chain."
            : "Direct sweep: this payment took the legacy fallback path " +
              "(sender → shadow → wallet). The shadow → wallet hop is " +
              "publicly visible; future claims to this wallet will run " +
              "through the mixer for full privacy."}
          {"\n"}
          Verify on chain by following the transaction links above to
          Solana Explorer ({network}).
        </Text>
      </Page>
    </Document>
  );
}

/**
 * Trigger a browser download of the payslip PDF for this payment.
 * Mirrors `downloadPayrollPacketPdf` — code-splits `@react-pdf/renderer`
 * out of the initial route so the dashboard's first paint isn't paying
 * the ~150 KB renderer cost up-front.
 */
export async function downloadPayslipPdf(
  payment: ReceivedPayment,
  options: {
    recipientWallet?: string;
    /** Optional name the sender labelled the recipient with. When
     *  present, surfaces a "To" row in the payslip's fact-table; the
     *  row is omitted entirely when empty. Threaded through here so
     *  callers that have learned the name from packet metadata can
     *  pass it without reaching into the renderer's prop shape. */
    recipientName?: string;
    network?: "devnet" | "mainnet";
  } = {},
): Promise<void> {
  const { pdf } = await import("@react-pdf/renderer");
  const blob = await pdf(
    PayslipPdfDocument({
      payment,
      recipientWallet: options.recipientWallet,
      recipientName: options.recipientName,
      network: options.network ?? "devnet",
    }),
  ).toBlob();
  const filename = `${payment.batchId}-row${payment.rowIndex}-payslip.pdf`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
