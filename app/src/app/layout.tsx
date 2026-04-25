import "./globals.css";
import type { Metadata } from "next";
import { VeilWalletProvider } from "@/components/WalletProvider";

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
    <html lang="en">
      <body className="antialiased font-sans bg-paper text-ink min-h-screen">
        <VeilWalletProvider>{children}</VeilWalletProvider>
      </body>
    </html>
  );
}
