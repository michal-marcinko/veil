"use client";

import Link from "next/link";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { VeilLogo } from "@/components/VeilLogo";
import { PayrollFlow } from "@/components/PayrollFlow";

/**
 * /payroll/outgoing — thin shell wrapping <PayrollFlow />.
 *
 * All state, async dispatch, and form UI live in `components/PayrollFlow.tsx`
 * so the same flow can be embedded inline on /create (Phase 2 of the refactor).
 *
 * The component provides its own internal heading ("Pay contractors without
 * publishing salaries.") and wallet gate, so this page only renders the nav
 * frame around it.
 */

export default function OutgoingPayrollPage() {
  return (
    <main className="min-h-screen relative pb-32">
      <nav className="sticky top-0 z-10 backdrop-blur-sm bg-paper/80 border-b border-line">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between px-6 md:px-8 py-4">
          <VeilLogo />
          <div className="flex items-center gap-1 md:gap-2">
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
            <Link
              href="/docs"
              className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors"
            >
              Docs
            </Link>
            <div className="ml-2">
              <ClientWalletMultiButton />
            </div>
          </div>
        </div>
      </nav>

      <section className="max-w-[1400px] mx-auto px-6 md:px-8 pt-16 md:pt-20">
        <PayrollFlow />
      </section>
    </main>
  );
}
