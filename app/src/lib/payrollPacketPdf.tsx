import {
  Document,
  Page,
  StyleSheet,
  Text,
  View,
} from "@react-pdf/renderer";
import {
  formatPayrollAmount,
  type SignedPayrollPacket,
} from "./private-payroll";

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
  stats: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 22,
  },
  stat: {
    flexGrow: 1,
    border: "1 solid #d6ceba",
    padding: 10,
  },
  statLabel: {
    fontSize: 7,
    letterSpacing: 1.1,
    textTransform: "uppercase",
    color: "#736b57",
    marginBottom: 6,
  },
  statValue: {
    fontSize: 11,
  },
  table: {
    border: "1 solid #d6ceba",
  },
  row: {
    flexDirection: "row",
    borderBottom: "1 solid #d6ceba",
    minHeight: 34,
    alignItems: "stretch",
  },
  headerCell: {
    fontSize: 7,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: "#736b57",
    padding: 7,
    borderRight: "1 solid #d6ceba",
  },
  cell: {
    padding: 7,
    borderRight: "1 solid #d6ceba",
    fontSize: 8,
    lineHeight: 1.3,
  },
  lastCell: {
    borderRight: "0 solid transparent",
  },
  signature: {
    marginTop: 18,
    paddingTop: 12,
    borderTop: "1 solid #d6ceba",
    fontSize: 7,
    color: "#736b57",
    lineHeight: 1.35,
  },
});

/**
 * Optional supplementary data: a per-row map of claim URLs that were
 * generated during the run for unregistered recipients. Keyed by row
 * index because URLs aren't part of the signed packet (they belong to
 * the private off-band hand-off, not the auditable disclosure).
 *
 * When present, the PDF appends a final page listing every claim URL
 * so the employer has a single archival document to file or print.
 */
export type PayrollPacketClaimUrls = Readonly<Record<number, string>>;

export interface PayrollPacketPdfProps {
  signed: SignedPayrollPacket;
  /**
   * Optional per-row claim URLs. When provided, the PDF appends a
   * "Claim links" page with the URLs spelled out — the employer can
   * print + manually distribute, or archive alongside the signed
   * packet. Excluded from the signed payload because URLs contain
   * private-key material in the fragment (see payroll-claim-links.ts).
   */
  claimUrls?: PayrollPacketClaimUrls;
}

export function PayrollPacketPdfDocument({ signed, claimUrls }: PayrollPacketPdfProps) {
  const packet = signed.packet;
  const paid = packet.rows.filter((row) => row.status === "paid").length;
  const failed = packet.rows.length - paid;
  const total = packet.rows.reduce((sum, row) => sum + BigInt(row.amount), 0n);
  const claimEntries = claimUrls
    ? Object.entries(claimUrls)
        .map(([k, v]) => ({ index: Number(k), url: v }))
        .sort((a, b) => a.index - b.index)
    : [];

  return (
    <Document
      title={`Veil payroll packet ${packet.batchId}`}
      author="Veil"
      subject="Signed private payroll receipt packet"
    >
      <Page size="A4" style={styles.page}>
        <Text style={styles.eyebrow}>Veil private payroll packet</Text>
        <Text style={styles.title}>{packet.batchId}</Text>
        <Text style={styles.subtitle}>
          Signed payroll disclosure packet. Amounts and memos are shown here because
          the employer intentionally generated this packet for review.
        </Text>

        <View style={styles.stats}>
          <Stat label="Payer" value={truncate(packet.payer)} />
          <Stat label="Rows" value={packet.rows.length.toString()} />
          <Stat label="Paid" value={paid.toString()} />
          <Stat label="Failed" value={failed.toString()} />
          <Stat
            label="Total"
            value={`${formatPayrollAmount(total, packet.decimals)} ${packet.symbol}`}
          />
        </View>

        <View style={styles.table}>
          <View style={styles.row}>
            <Text style={[styles.headerCell, { width: "5%" }]}>#</Text>
            <Text style={[styles.headerCell, { width: "16%" }]}>Name</Text>
            <Text style={[styles.headerCell, { width: "23%" }]}>Recipient</Text>
            <Text style={[styles.headerCell, { width: "13%" }]}>Amount</Text>
            <Text style={[styles.headerCell, { width: "20%" }]}>Memo</Text>
            <Text style={[styles.headerCell, { width: "9%" }]}>Mode</Text>
            <Text style={[styles.headerCell, styles.lastCell, { width: "14%" }]}>Tx</Text>
          </View>
          {packet.rows.map((row, index) => (
            <View key={`${row.recipient}-${index}`} style={styles.row}>
              <Text style={[styles.cell, { width: "5%" }]}>{index + 1}</Text>
              <Text style={[styles.cell, { width: "16%" }]}>
                {row.recipientName ?? ""}
              </Text>
              <Text style={[styles.cell, { width: "23%" }]}>{truncate(row.recipient)}</Text>
              <Text style={[styles.cell, { width: "13%" }]}>
                {formatPayrollAmount(row.amount, packet.decimals)} {packet.symbol}
              </Text>
              <Text style={[styles.cell, { width: "20%" }]}>{row.memo || "No memo"}</Text>
              <Text style={[styles.cell, { width: "9%" }]}>{row.mode}</Text>
              <Text style={[styles.cell, styles.lastCell, { width: "14%" }]}>
                {row.txSignature ? truncate(row.txSignature) : row.status}
              </Text>
            </View>
          ))}
        </View>

        <Text style={styles.signature}>
          Payer signature: {signed.signature}
        </Text>
      </Page>

      {claimEntries.length > 0 && (
        <Page size="A4" style={styles.page}>
          <Text style={styles.eyebrow}>Claim links</Text>
          <Text style={styles.title}>One-shot links per unregistered recipient</Text>
          <Text style={styles.subtitle}>
            These URLs let the recipient claim funds without registering with
            Umbra in advance. The fragment after `#` contains a one-time
            private key — anyone with the URL can claim. Treat them like
            bearer tokens: send privately, never paste into a public channel.
            Each URL is single-use; once claimed, the shadow account is empty.
          </Text>
          <View style={styles.table}>
            <View style={styles.row}>
              <Text style={[styles.headerCell, { width: "5%" }]}>#</Text>
              <Text style={[styles.headerCell, { width: "15%" }]}>Name</Text>
              <Text style={[styles.headerCell, { width: "22%" }]}>Recipient</Text>
              <Text style={[styles.headerCell, styles.lastCell, { width: "58%" }]}>
                Claim URL
              </Text>
            </View>
            {claimEntries.map(({ index, url }) => {
              const row = packet.rows[index];
              return (
                <View key={`claim-${index}`} style={styles.row}>
                  <Text style={[styles.cell, { width: "5%" }]}>{index + 1}</Text>
                  <Text style={[styles.cell, { width: "15%" }]}>
                    {row?.recipientName ?? ""}
                  </Text>
                  <Text style={[styles.cell, { width: "22%" }]}>
                    {row ? truncate(row.recipient) : "(unknown row)"}
                  </Text>
                  <Text style={[styles.cell, styles.lastCell, { width: "58%" }]}>
                    {url}
                  </Text>
                </View>
              );
            })}
          </View>
        </Page>
      )}
    </Document>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

function truncate(value: string): string {
  if (value.length <= 18) return value;
  return `${value.slice(0, 8)}...${value.slice(-7)}`;
}
