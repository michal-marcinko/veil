import "./globals.css";
import type { Metadata } from "next";
import { Instrument_Serif, Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import { VeilWalletProvider } from "@/components/WalletProvider";

const serif = Instrument_Serif({
  subsets: ["latin"],
  weight: ["400"],
  style: ["normal", "italic"],
  variable: "--font-serif",
  display: "swap",
});

const sans = Hanken_Grotesk({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Veil — Private invoicing on Solana",
  description:
    "Business-grade confidentiality for Solana payments. Amounts hidden via Umbra + Arcium MPC, counterparty unlinkability through ZK mixer, selective disclosure for auditors.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${serif.variable} ${sans.variable} ${mono.variable}`}
    >
      <body className="antialiased font-sans bg-ink text-cream min-h-screen">
        <VeilWalletProvider>{children}</VeilWalletProvider>
      </body>
    </html>
  );
}
