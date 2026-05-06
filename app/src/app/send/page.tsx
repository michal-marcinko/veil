"use client";

import Link from "next/link";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { VeilLogo } from "@/components/VeilLogo";
import { SendGiftFlow } from "@/components/SendGiftFlow";

/**
 * /send — gift creation route.
 *
 * Thin wrapper: provides the standalone Shell (top nav + max-width
 * section) and renders <SendGiftFlow />. The same flow component is
 * embedded inline by /create's Gift card mode, so /send and /create
 * share one source of truth for the form.
 */
export default function SendGiftPage() {
  return (
    <Shell>
      <SendGiftFlow />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen relative pb-32">
      <nav className="sticky top-0 z-10 backdrop-blur-sm bg-paper/80 border-b border-line">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between px-6 md:px-8 py-4">
          <VeilLogo />
          <div className="flex items-center gap-1 md:gap-2">
            <Link
              href="/create"
              prefetch
              className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors"
            >
              Create
            </Link>
            <Link
              href="/dashboard"
              prefetch
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

      <section className="max-w-[1400px] mx-auto px-6 md:px-8 pt-16 md:pt-20">
        {children}
      </section>
    </main>
  );
}
