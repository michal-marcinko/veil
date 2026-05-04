"use client";

import { CreatePageInner } from "@/components/CreatePageInner";

/**
 * /create route — thin wrapper around <CreatePageInner>. The wrapper
 * exists because Next.js's generated PageProps type validation forbids
 * arbitrary props or named exports on page files. CreatePageInner lives
 * in `src/components/` and accepts an optional test-only `__forceState`
 * prop for jsdom render assertions; production rendering passes nothing.
 */
export default function CreatePage() {
  return <CreatePageInner />;
}
