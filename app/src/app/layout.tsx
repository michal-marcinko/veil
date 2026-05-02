import "./globals.css";
import type { Metadata } from "next";
import { VeilWalletProvider } from "@/components/WalletProvider";

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ??
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000"),
  ),
  title: "Veil — Private payments on Solana",
  description:
    "Private invoices, private payroll, and selective auditor access for Solana businesses. Settles on Solana via Umbra's encrypted UTXO pool.",
  openGraph: {
    title: "Veil — Private invoicing on Solana",
    description:
      "Encrypted invoices, private payments via the Umbra mixer, scoped auditor grants. Open-source.",
    images: [{ url: "/og-image.png", width: 1024, height: 1024, alt: "Veil" }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Veil — Private invoicing on Solana",
    description:
      "Encrypted invoices, private payments via the Umbra mixer, scoped auditor grants. Open-source.",
    images: ["/og-image.png"],
  },
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
