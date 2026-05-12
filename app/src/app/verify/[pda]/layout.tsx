// ---------------------------------------------------------------------------
// Layout for /verify/[pda] — exists solely to host static metadata since
// the page itself is a "use client" component (and Next.js App Router
// disallows `metadata` exports from client components).
//
// `noindex, nofollow` is the documented mitigation for capability-URL
// search-engine indexing leaks (W3C TAG capability URL guidance).
// ---------------------------------------------------------------------------

export const metadata = {
  title: "Veil verifier",
  robots: {
    index: false,
    follow: false,
  },
};

export default function VerifyLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
