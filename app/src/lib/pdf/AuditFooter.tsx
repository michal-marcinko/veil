// ---------------------------------------------------------------------------
// Audit footer for receipt / payslip PDFs.
//
// Surfaces the on-chain anchors an auditor needs to independently verify a
// payment: invoice PDA, lock PDA, payer wallet, tx signatures, plus a QR
// code linking back to /verify/<pda>#k=<token>.
//
// Design contract:
//   - Pure-React component, no I/O. All data is pre-fetched by the caller
//     and threaded through props so the renderer stays deterministic and
//     can run in any worker / SSR context.
//   - QR is drawn as native @react-pdf/renderer <Svg><Rect /></Svg> cells
//     so the PDF stays vector (no canvas / no PNG) and renders crisply at
//     any zoom level. We use `qrcode-svg` to compute the module grid.
//   - The token in the verify URL is `base58(metadataHash[0..6])` — a 6-byte
//     prefix is enough to gate the verifier (1 in 2^48 collision rate is
//     well past the threshold for accidental URL discovery).
// ---------------------------------------------------------------------------
/* eslint-disable react/jsx-key */
import React from "react";
import { Path, StyleSheet, Svg, Text, View } from "@react-pdf/renderer";
import bs58 from "bs58";
import QRCode from "qrcode-svg";

const PAPER = "#f8f4e9";
const INK = "#1c1712";
const MUTED = "#736b57";
const LINE = "#d6ceba";

const styles = StyleSheet.create({
  container: {
    marginTop: 24,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: LINE,
    flexDirection: "row",
    gap: 18,
  },
  factsCol: {
    flex: 1,
  },
  qrCol: {
    width: 110,
  },
  eyebrow: {
    fontSize: 7,
    color: MUTED,
    textTransform: "uppercase",
    letterSpacing: 1.2,
    marginBottom: 4,
  },
  factRow: {
    flexDirection: "row",
    marginBottom: 3,
  },
  factLabel: {
    width: 90,
    fontSize: 7.5,
    color: MUTED,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  factValue: {
    flex: 1,
    fontSize: 8,
    color: INK,
    fontFamily: "Courier",
  },
  qrCaption: {
    fontSize: 7,
    color: MUTED,
    marginTop: 4,
    textAlign: "center",
    lineHeight: 1.3,
  },
});

export interface AuditFooterFact {
  label: string;
  value: string;
}

export interface AuditFooterProps {
  /** Verifier URL the QR encodes — e.g. https://veil.app/verify/<pda>#k=<token> */
  verifyUrl: string;
  /** Pre-formatted fact rows. Caller decides which fields apply per mode. */
  facts: AuditFooterFact[];
  /** Optional: short eyebrow above the facts column ("Audit anchors", "Payslip anchors"). */
  eyebrow?: string;
}

/**
 * Build the capability-URL token for an invoice's verifier link.
 * `metadataHash` is the 32-byte sha256 stored on the Invoice account;
 * we take the first 6 bytes and base58-encode them. 6 bytes ≈ 8-9 base58
 * chars — short enough to embed in a QR without ballooning, long enough
 * that random URL guessers can't brute-force it.
 */
export function buildVerifyToken(metadataHash: Uint8Array): string {
  if (metadataHash.length < 6) {
    throw new Error(
      `metadataHash too short to derive verify token: ${metadataHash.length}`,
    );
  }
  const prefix = metadataHash.slice(0, 6);
  // bs58.encode in this codebase is fed Uint8Array elsewhere — keep that.
  return bs58.encode(prefix);
}

/**
 * Build the full /verify/<pda>#k=<token> URL.
 *
 * Host resolution order:
 *   1. explicit `host` arg (caller can override for tests / SSR)
 *   2. `window.location.origin` if running in the browser
 *   3. `process.env.NEXT_PUBLIC_HOST` fallback for SSR / scheduled jobs
 *   4. `https://veil.app` last-ditch placeholder
 */
export function buildVerifyUrl(args: {
  invoicePda: string;
  metadataHash: Uint8Array;
  host?: string;
}): string {
  const token = buildVerifyToken(args.metadataHash);
  const browserOrigin =
    typeof window !== "undefined" ? window.location?.origin : null;
  const host =
    args.host ??
    browserOrigin ??
    process.env.NEXT_PUBLIC_HOST ??
    "https://veil.app";
  return `${host.replace(/\/$/, "")}/verify/${args.invoicePda}#k=${token}`;
}

// ---------------------------------------------------------------------------
// QR rendering — convert qrcode-svg's module matrix to react-pdf <Path>s.
// ---------------------------------------------------------------------------

/**
 * qrcode-svg returns a single `<svg>` element with a `<path d="…"/>` for
 * each dark module. We extract the path data and ship it through to
 * react-pdf's `<Path>` directly. No DOM parsing required — qrcode-svg
 * exposes a stable text output we can regex against.
 *
 * We use a very tolerant regex (`d="..."` with anything inside) so the
 * exact escaping qrcode-svg picks doesn't break us across versions.
 */
function extractQrPath(svg: string): string | null {
  // qrcode-svg 1.1.0 emits a single `<path d="M…Z"/>` for all dark cells.
  const match = svg.match(/<path[^>]*\bd="([^"]+)"/);
  return match ? match[1] : null;
}

function QrSvg({ data, size = 100 }: { data: string; size?: number }) {
  // Contain ≈ 70 chars URL @ ECC L gives a 25×25 grid (Version 2). We let
  // qrcode-svg autosize; passing `padding: 0` removes the quiet-zone so
  // we control the visual margin via the surrounding container.
  const qr = new QRCode({
    content: data,
    padding: 0,
    width: size,
    height: size,
    color: INK,
    background: PAPER,
    ecl: "M",
    join: true, // single <path> covering all dark modules
    container: "svg-viewbox",
  });
  const svgString = qr.svg();
  const pathD = extractQrPath(svgString);

  if (!pathD) {
    // Defensive — every qrcode-svg release we've seen emits the path. If
    // a future version changes the output, render a placeholder rather
    // than hanging the PDF render.
    return (
      <Svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
        <Path d={`M0 0 L${size} 0 L${size} ${size} L0 ${size} Z`} fill={PAPER} stroke={INK} strokeWidth={1} />
      </Svg>
    );
  }

  // qrcode-svg sizes its own viewBox to (width × height). Pull that and
  // pass it through to <Svg> so the QR scales correctly within the QR
  // column box.
  const viewBoxMatch = svgString.match(/viewBox="([^"]+)"/);
  const viewBox = viewBoxMatch ? viewBoxMatch[1] : `0 0 ${size} ${size}`;
  return (
    <Svg viewBox={viewBox} width={size} height={size}>
      <Path d={pathD} fill={INK} />
    </Svg>
  );
}

// ---------------------------------------------------------------------------
// Public component.
// ---------------------------------------------------------------------------

export function AuditFooter({ verifyUrl, facts, eyebrow }: AuditFooterProps) {
  return (
    <View style={styles.container}>
      <View style={styles.factsCol}>
        {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
        {facts.map((f, i) => (
          <View key={i} style={styles.factRow}>
            <Text style={styles.factLabel}>{f.label}</Text>
            <Text style={styles.factValue}>{f.value}</Text>
          </View>
        ))}
      </View>
      <View style={styles.qrCol}>
        <QrSvg data={verifyUrl} size={100} />
        <Text style={styles.qrCaption}>Scan to verify on Veil</Text>
      </View>
    </View>
  );
}
