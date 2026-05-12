"use client";

import { ProductFrame } from "@/app/products/_components/ProductFrame";
import { NewProductFlow } from "@/components/NewProductFlow";

/**
 * /products/new — merchant creates a reusable payment link.
 *
 * Thin wrapper around <NewProductFlow />. The same flow is also
 * embedded inline by /create's Payment-link mode, so the two surfaces
 * share one form implementation.
 */
export default function NewProductPage() {
  return (
    <ProductFrame tagline="products">
      <section className="max-w-[1400px] mx-auto px-6 md:px-8 pt-16 md:pt-20 pb-16">
        <NewProductFlow />
      </section>
    </ProductFrame>
  );
}
