/**
 * Global route-loading boundary. Rendered by Next.js automatically when
 * navigating between routes if the destination's component tree is still
 * resolving. Brand-matched (cream paper, ink line) so the transition
 * doesn't look like an abrupt blank flash — it reads as the same site,
 * just gathering itself.
 */
export default function Loading() {
  return (
    <main className="min-h-screen bg-paper">
      <div className="max-w-[1400px] mx-auto px-6 md:px-8 pt-24 md:pt-32">
        <div className="flex items-center gap-3 text-[12px] font-mono tracking-[0.14em] uppercase text-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-gold animate-slow-pulse" />
          <span>Loading</span>
        </div>
        <div className="mt-10 h-12 w-2/3 max-w-[640px] bg-line/40 rounded-sm animate-slow-pulse" />
        <div className="mt-4 h-12 w-1/2 max-w-[480px] bg-line/30 rounded-sm animate-slow-pulse" />
      </div>
    </main>
  );
}
