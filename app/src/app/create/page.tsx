"use client";

import { useEffect } from "react";

import { CreatePageInner } from "@/components/CreatePageInner";
import { prewarmZkAssets } from "@/lib/payroll-claim-links";

/**
 * /create route — thin wrapper around <CreatePageInner>. The wrapper
 * exists because Next.js's generated PageProps type validation forbids
 * arbitrary props or named exports on page files. CreatePageInner lives
 * in `src/components/` and accepts an optional test-only `__forceState`
 * prop for jsdom render assertions; production rendering passes nothing.
 *
 * ZK asset prefetch fires AT the page level (not inside PayrollFlow's
 * mount) so the ~30 MB zkey downloads start the instant the route
 * resolves — before the user has filled the form, picked a wallet, or
 * connected. By the time they click Submit (typically 30-60s later),
 * the assets are in IndexedDB and the per-row register call resolves
 * in ~15-25s instead of the cold-cache 60-90s. This is what keeps the
 * batched flow at 1 popup in practice without needing durable nonces:
 * register finishes inside the regular blockhash's 60-second validity
 * window, so deposits signed at t=0 land before they expire.
 *
 * `prewarmZkAssets` is module-level memoised — calling it here AND
 * inside PayrollFlow's mount coalesces into a single in-flight fetch.
 * The PayrollFlow-mount call stays as a fallback for users who deep-
 * link into the flow without going through /create (e.g. via a
 * dashboard "Pay invoice" button that mounts the form directly).
 */
export default function CreatePage() {
  useEffect(() => {
    void prewarmZkAssets();
  }, []);
  return <CreatePageInner />;
}
