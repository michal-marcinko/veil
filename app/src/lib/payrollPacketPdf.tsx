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

export function PayrollPacketPdfDocument({ signed }: { signed: SignedPayrollPacket }) {
  const packet = signed.packet;
  const paid = packet.rows.filter((row) => row.status === "paid").length;
  const failed = packet.rows.length - paid;
  const total = packet.rows.reduce((sum, row) => sum + BigInt(row.amount), 0n);

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
            <Text style={[styles.headerCell, { width: "6%" }]}>#</Text>
            <Text style={[styles.headerCell, { width: "29%" }]}>Recipient</Text>
            <Text style={[styles.headerCell, { width: "14%" }]}>Amount</Text>
            <Text style={[styles.headerCell, { width: "25%" }]}>Memo</Text>
            <Text style={[styles.headerCell, { width: "10%" }]}>Mode</Text>
            <Text style={[styles.headerCell, styles.lastCell, { width: "16%" }]}>Tx</Text>
          </View>
          {packet.rows.map((row, index) => (
            <View key={`${row.recipient}-${index}`} style={styles.row}>
              <Text style={[styles.cell, { width: "6%" }]}>{index + 1}</Text>
              <Text style={[styles.cell, { width: "29%" }]}>{truncate(row.recipient)}</Text>
              <Text style={[styles.cell, { width: "14%" }]}>
                {formatPayrollAmount(row.amount, packet.decimals)} {packet.symbol}
              </Text>
              <Text style={[styles.cell, { width: "25%" }]}>{row.memo || "No memo"}</Text>
              <Text style={[styles.cell, { width: "10%" }]}>{row.mode}</Text>
              <Text style={[styles.cell, styles.lastCell, { width: "16%" }]}>
                {row.txSignature ? truncate(row.txSignature) : row.status}
              </Text>
            </View>
          ))}
        </View>

        <Text style={styles.signature}>
          Payer signature: {signed.signature}
        </Text>
      </Page>
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
