"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

/**
 * Primary CTA pill that gives instant click feedback (a tiny pulse +
 * shifted state) while React Router resolves the destination route.
 *
 * Why this exists: a plain <Link> still shows ~80–500ms of "nothing
 * visible happens after I clicked" because Next.js compiles the
 * destination route on demand in dev (and in prod, the network round-
 * trip can still be perceptible). Wrapping the navigation in
 * useTransition exposes a `pending` flag we can render against, so the
 * button immediately turns into a loading state — confirming the click
 * registered and bridging the perceptual gap.
 *
 * On hover, Next.js auto-prefetches the destination chunk, so production
 * navigation is near-instant; the pending state remains a safety net
 * for slow networks and dev mode.
 */
export function PrimaryCta({
  href,
  children,
  pendingChildren,
  className = "btn-primary",
}: {
  href: string;
  children: React.ReactNode;
  pendingChildren?: React.ReactNode;
  className?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function handleClick(e: React.MouseEvent<HTMLAnchorElement>) {
    // Honour modifier keys (cmd-click, middle-click, etc.) — let the browser
    // do its native thing and don't trigger our pending state.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    startTransition(() => {
      router.push(href);
    });
  }

  return (
    <Link
      href={href}
      prefetch
      onClick={handleClick}
      className={className}
      data-pending={pending ? "1" : undefined}
    >
      {pending ? (
        <span className="inline-flex items-center gap-2.5">
          <span className="h-1.5 w-1.5 rounded-full bg-paper animate-slow-pulse" />
          {pendingChildren ?? "Loading…"}
        </span>
      ) : (
        children
      )}
    </Link>
  );
}
