// ---------------------------------------------------------------------------
// Next.js middleware — privacy hardening for /verify/* routes.
//
// What this does:
//   - Sets Cache-Control: no-store, no-cache, must-revalidate on all
//     responses for /verify/*. Verifier verdicts are per-PDA, often
//     short-lived (an invoice flips Pending → Paid), and CDNs caching
//     them would surface stale verdicts to auditors.
//
// What this CANNOT do (limitation worth being explicit about):
//   - Server access logs (Vercel, Railway, Netlify, etc.) typically log
//     the request URL path before middleware runs. Redacting those logs
//     requires the hosting platform's request-log transform configuration
//     — not something app code can control. The capability token in the
//     URL fragment never reaches the server (per W3C TAG capability-URL
//     guidance), so token-level confidentiality is preserved; PDA-level
//     access patterns may still appear in platform logs.
// ---------------------------------------------------------------------------

import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const response = NextResponse.next();

  if (pathname.startsWith("/verify/")) {
    response.headers.set(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate",
    );
    response.headers.set("Pragma", "no-cache");
    response.headers.set("Expires", "0");
    // Defence-in-depth: while the layout exports `robots: { index: false }`,
    // a header copy ensures crawlers that respect the header but not the
    // meta tag also stay out.
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
  }

  return response;
}

export const config = {
  matcher: ["/verify/:path*"],
};
