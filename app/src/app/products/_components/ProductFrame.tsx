"use client";

import Link from "next/link";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { VeilLogo } from "@/components/VeilLogo";

/**
 * Shared shell for all products surface pages. Mirrors the paper-cream
 * editorial frame used across /create, /pay, /dashboard so the products
 * surface feels native to the rest of the app. Tagline differs only at
 * the merchant entry points; customer-facing /buy uses no tagline so the
 * page reads as "a product, not Veil's UI".
 */
export function ProductFrame({
  children,
  tagline,
}: {
  children: React.ReactNode;
  tagline?: string;
}) {
  return (
    <main className="min-h-screen relative pb-32">
      <nav className="sticky top-0 z-10 backdrop-blur-sm bg-paper/80 border-b border-line">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between px-6 md:px-8 py-4">
          <VeilLogo tagline={tagline} />
          <div className="flex items-center gap-1 md:gap-2">
            <Link
              href="/products"
              className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors"
            >
              Products
            </Link>
            <Link
              href="/create"
              className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors"
            >
              Create
            </Link>
            <Link
              href="/dashboard"
              className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors"
            >
              Activity
            </Link>
            <a
              href="https://github.com/michal-marcinko/veil"
              target="_blank"
              rel="noreferrer noopener"
              className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors"
            >
              Docs
            </a>
            <div className="ml-2">
              <ClientWalletMultiButton />
            </div>
          </div>
        </div>
      </nav>
      {children}
    </main>
  );
}
