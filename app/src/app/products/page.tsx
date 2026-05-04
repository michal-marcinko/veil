"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { ProductFrame } from "@/app/products/_components/ProductFrame";
import { ProductCard } from "@/app/products/_components/ProductCard";
import {
  readProductsCache,
  removeProductFromCache,
  type ProductCacheEntry,
} from "@/lib/products";

/**
 * /products — merchant's list of created products.
 *
 * Source of truth: localStorage cache scoped per wallet, hydrated on
 * mount. The Arweave entry is permanent (we can't truly "delete" a
 * product), so the delete action here only hides the row from the
 * merchant's dashboard. Anyone holding the URL can still pay.
 */
export default function ProductsListPage() {
  const wallet = useWallet();
  const [entries, setEntries] = useState<ProductCacheEntry[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!wallet.publicKey) {
      setEntries([]);
      setHydrated(true);
      return;
    }
    const list = readProductsCache(wallet.publicKey.toBase58());
    setEntries(list);
    setHydrated(true);
  }, [wallet.publicKey]);

  function handleRemove(arweaveTxId: string) {
    if (!wallet.publicKey) return;
    if (
      !window.confirm(
        "Remove this product from your dashboard? The Arweave entry stays permanent — anyone with the URL can still pay.",
      )
    ) {
      return;
    }
    const next = removeProductFromCache(wallet.publicKey.toBase58(), arweaveTxId);
    setEntries(next);
  }

  return (
    <ProductFrame tagline="products">
      <section className="max-w-[1400px] mx-auto px-6 md:px-8 pt-16 md:pt-20 pb-16">
        <div className="max-w-3xl mx-auto">
          {!wallet.connected ? (
            <div>
              <span className="eyebrow">Products</span>
              <h1 className="mt-4 font-display font-medium text-ink text-[44px] md:text-[56px] leading-[1.02] tracking-[-0.02em]">
                Your payment links.
              </h1>
              <p className="mt-5 text-[15.5px] leading-[1.55] text-ink/70 max-w-md">
                Connect your wallet to see and manage products you&apos;ve
                published.
              </p>
              <div className="mt-8">
                <ClientWalletMultiButton />
              </div>
            </div>
          ) : (
            <>
              <header className="flex items-end justify-between gap-6 flex-wrap">
                <div>
                  <span className="eyebrow">Products</span>
                  <h1 className="mt-4 font-display font-medium text-ink text-[40px] md:text-[52px] leading-[1.02] tracking-[-0.02em]">
                    Your payment links.
                  </h1>
                </div>
                <Link
                  href="/products/new"
                  prefetch
                  className="btn-primary"
                >
                  + New product
                </Link>
              </header>

              <div className="mt-12">
                {!hydrated ? (
                  <p className="text-[13.5px] text-muted">Loading…</p>
                ) : entries.length === 0 ? (
                  <EmptyState />
                ) : (
                  <ul className="space-y-3">
                    {entries.map((entry) => (
                      <li key={entry.arweaveTxId}>
                        <ProductCard
                          entry={entry}
                          onRemove={() => handleRemove(entry.arweaveTxId)}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {entries.length > 0 && (
                <p className="mt-10 text-[12px] text-muted leading-relaxed max-w-md">
                  This list is cached in your browser only. Open the same wallet
                  on a different machine and you&apos;ll only see products
                  created from there. The Arweave URLs always work.
                </p>
              )}
            </>
          )}
        </div>
      </section>
    </ProductFrame>
  );
}

function EmptyState() {
  return (
    <div className="border border-dashed border-line rounded-[4px] p-10 text-center">
      <p className="text-[15px] text-ink/80 leading-relaxed">
        No products yet.
      </p>
      <p className="mt-1 text-[13.5px] text-muted leading-relaxed max-w-md mx-auto">
        Create one and we&apos;ll mint a private payment link your customers
        can use any number of times.
      </p>
      <div className="mt-6 inline-flex">
        <Link href="/products/new" prefetch className="btn-primary">
          + New product
        </Link>
      </div>
    </div>
  );
}
