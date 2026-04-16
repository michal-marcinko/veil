import "./globals.css";
import type { Metadata } from "next";
import { VeilWalletProvider } from "@/components/WalletProvider";

export const metadata: Metadata = {
  title: "Veil — Private Invoicing on Solana",
  description: "Business-grade privacy for Solana payments.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <VeilWalletProvider>{children}</VeilWalletProvider>
      </body>
    </html>
  );
}
