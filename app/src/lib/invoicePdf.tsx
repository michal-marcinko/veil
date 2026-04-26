/* eslint-disable react/jsx-key */
import React from "react";
import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import type { InvoiceMetadata } from "./types";

// Brand palette — keep in sync with tailwind.config.ts
const PAPER = "#f8f4e9";
const INK = "#1c1712";
const MUTED = "#736b57";
const DIM = "#a59c84";
const LINE = "#d6ceba";
const GOLD = "#6a2420";
const SAGE = "#3a6b4a";

const styles = StyleSheet.create({
  page: {
    backgroundColor: PAPER,
    color: INK,
    padding: 56,
    fontFamily: "Helvetica",
    fontSize: 10,
    lineHeight: 1.5,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 32,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: LINE,
  },
  brand: {
    flexDirection: "column",
  },
  brandName: {
    fontSize: 16,
    fontFamily: "Helvetica-Bold",
    color: INK,
    letterSpacing: -0.4,
  },
  brandTagline: {
    fontSize: 8,
    color: MUTED,
    marginTop: 2,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  invoiceMeta: {
    flexDirection: "column",
    alignItems: "flex-end",
  },
  eyebrow: {
    fontSize: 7,
    color: MUTED,
    textTransform: "uppercase",
    letterSpacing: 1.2,
    marginBottom: 3,
  },
  invoiceId: {
    fontSize: 11,
    fontFamily: "Courier",
    color: INK,
  },
  partyRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 28,
  },
  party: {
    flexDirection: "column",
    width: "48%",
  },
  partyName: {
    fontSize: 13,
    fontFamily: "Helvetica-Bold",
    color: INK,
    marginTop: 4,
  },
  partyContact: {
    fontSize: 9,
    color: MUTED,
    marginTop: 3,
  },
  dateRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 32,
  },
  dateBlock: {
    flexDirection: "column",
    width: "48%",
  },
  dateValue: {
    fontSize: 11,
    fontFamily: "Courier",
    color: INK,
    marginTop: 4,
  },
  itemsHeader: {
    flexDirection: "row",
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: LINE,
    marginBottom: 8,
  },
  itemsHeaderCell: {
    fontSize: 7,
    color: MUTED,
    textTransform: "uppercase",
    letterSpacing: 1.2,
  },
  itemRow: {
    flexDirection: "row",
    paddingVertical: 8,
    borderBottomWidth: 0.5,
    borderBottomColor: LINE,
  },
  cellDescription: { width: "55%", color: INK, fontSize: 10 },
  cellQty: { width: "10%", textAlign: "right", color: MUTED, fontFamily: "Courier", fontSize: 10 },
  cellRate: { width: "17%", textAlign: "right", color: MUTED, fontFamily: "Courier", fontSize: 10 },
  cellAmount: { width: "18%", textAlign: "right", color: INK, fontFamily: "Courier", fontSize: 10 },
  totalsContainer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: 24,
  },
  totalsBlock: {
    width: "45%",
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
  },
  totalRowFinal: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: 12,
    marginTop: 8,
    borderTopWidth: 1,
    borderTopColor: INK,
  },
  totalLabel: { fontSize: 9, color: MUTED, textTransform: "uppercase", letterSpacing: 1 },
  totalLabelFinal: { fontSize: 10, color: INK, fontFamily: "Helvetica-Bold", textTransform: "uppercase", letterSpacing: 1 },
  totalValue: { fontSize: 11, color: INK, fontFamily: "Courier" },
  totalValueFinal: { fontSize: 16, color: INK, fontFamily: "Helvetica-Bold" },
  notesBlock: {
    marginTop: 36,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: LINE,
  },
  notesText: {
    fontSize: 10,
    color: INK,
    marginTop: 6,
  },
  footer: {
    position: "absolute",
    bottom: 32,
    left: 56,
    right: 56,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: LINE,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  footerText: {
    fontSize: 7,
    color: DIM,
    textTransform: "uppercase",
    letterSpacing: 1.2,
  },
  settledBadge: {
    fontSize: 7,
    color: SAGE,
    textTransform: "uppercase",
    letterSpacing: 1.2,
  },
});

/**
 * Format a base-units amount string ("4200000000") into a human-readable
 * string ("$4,200.00") given the currency's decimals. Mirrors the
 * formatting used in app/src/components/InvoiceView.tsx so the PDF and
 * the on-screen view show identical numbers.
 */
function formatAmount(units: string, decimals: number, symbol: string): string {
  const bn = BigInt(units);
  const divisor = BigInt(10) ** BigInt(decimals);
  const whole = bn / divisor;
  const fraction = bn % divisor;
  const display = Math.min(4, decimals);
  const padded = fraction.toString().padStart(decimals, "0").slice(0, display);
  const trimmed = padded.replace(/0+$/, "").padEnd(2, "0");
  const symbolPrefix = symbol === "USDC" ? "$" : "";
  const symbolSuffix = symbol === "USDC" ? "" : ` ${symbol}`;
  return `${symbolPrefix}${whole.toLocaleString("en-US")}.${trimmed}${symbolSuffix}`;
}

function formatIssued(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

function truncatePda(pda: string): string {
  if (pda.length <= 16) return pda;
  return `${pda.slice(0, 8)}…${pda.slice(-8)}`;
}

interface InvoicePdfDocumentProps {
  metadata: InvoiceMetadata;
  invoicePda: string;
}

export function InvoicePdfDocument({ metadata, invoicePda }: InvoicePdfDocumentProps) {
  const { creator, payer, currency, line_items, subtotal, tax, total, notes, due_date, invoice_id, created_at } = metadata;
  const hasTax = BigInt(tax) > 0n;
  const generatedAt = new Date().toISOString().slice(0, 10);

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {/* Header — brand + invoice ID */}
        <View style={styles.header}>
          <View style={styles.brand}>
            <Text style={styles.brandName}>Veil</Text>
            <Text style={styles.brandTagline}>Private invoicing</Text>
          </View>
          <View style={styles.invoiceMeta}>
            <Text style={styles.eyebrow}>Invoice</Text>
            <Text style={styles.invoiceId}>{invoice_id}</Text>
          </View>
        </View>

        {/* Parties */}
        <View style={styles.partyRow}>
          <View style={styles.party}>
            <Text style={styles.eyebrow}>From</Text>
            <Text style={styles.partyName}>{creator.display_name}</Text>
            {creator.contact ? <Text style={styles.partyContact}>{creator.contact}</Text> : null}
          </View>
          <View style={styles.party}>
            <Text style={styles.eyebrow}>Bill to</Text>
            <Text style={styles.partyName}>{payer.display_name}</Text>
            {payer.contact ? <Text style={styles.partyContact}>{payer.contact}</Text> : null}
          </View>
        </View>

        {/* Dates */}
        <View style={styles.dateRow}>
          <View style={styles.dateBlock}>
            <Text style={styles.eyebrow}>Issued</Text>
            <Text style={styles.dateValue}>{formatIssued(created_at)}</Text>
          </View>
          <View style={styles.dateBlock}>
            <Text style={styles.eyebrow}>{due_date ? "Due" : "Settlement"}</Text>
            <Text style={styles.dateValue}>{due_date ?? currency.symbol}</Text>
          </View>
        </View>

        {/* Line items */}
        <View>
          <View style={styles.itemsHeader}>
            <Text style={[styles.cellDescription, styles.itemsHeaderCell]}>Description</Text>
            <Text style={[styles.cellQty, styles.itemsHeaderCell]}>Qty</Text>
            <Text style={[styles.cellRate, styles.itemsHeaderCell]}>Rate</Text>
            <Text style={[styles.cellAmount, styles.itemsHeaderCell]}>Amount</Text>
          </View>
          {line_items.map((li, i) => (
            <View key={i} style={styles.itemRow}>
              <Text style={styles.cellDescription}>{li.description}</Text>
              <Text style={styles.cellQty}>{li.quantity}</Text>
              <Text style={styles.cellRate}>{formatAmount(li.unit_price, currency.decimals, currency.symbol)}</Text>
              <Text style={styles.cellAmount}>{formatAmount(li.total, currency.decimals, currency.symbol)}</Text>
            </View>
          ))}
        </View>

        {/* Totals */}
        <View style={styles.totalsContainer}>
          <View style={styles.totalsBlock}>
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Subtotal</Text>
              <Text style={styles.totalValue}>{formatAmount(subtotal, currency.decimals, currency.symbol)}</Text>
            </View>
            {hasTax && (
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Tax</Text>
                <Text style={styles.totalValue}>{formatAmount(tax, currency.decimals, currency.symbol)}</Text>
              </View>
            )}
            <View style={styles.totalRowFinal}>
              <Text style={styles.totalLabelFinal}>Total Due</Text>
              <Text style={styles.totalValueFinal}>{formatAmount(total, currency.decimals, currency.symbol)}</Text>
            </View>
          </View>
        </View>

        {/* Notes */}
        {notes ? (
          <View style={styles.notesBlock}>
            <Text style={styles.eyebrow}>Notes</Text>
            <Text style={styles.notesText}>{notes}</Text>
          </View>
        ) : null}

        {/* Footer */}
        <View style={styles.footer}>
          <Text style={styles.footerText}>
            Veil · PDA {truncatePda(invoicePda)} · Generated {generatedAt}
          </Text>
          <Text style={styles.settledBadge}>Settled via {currency.symbol}</Text>
        </View>
      </Page>
    </Document>
  );
}
