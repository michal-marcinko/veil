"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { VeilLogo } from "@/components/VeilLogo";
import {
  buildShadowClient,
  withdrawFromShadow,
} from "@/lib/payroll-claim-links";
import {
  deriveGiftShadow,
  parseGiftUrlFragment,
  type GiftMetadata,
} from "@/lib/gift-cards";
import { NETWORK } from "@/lib/constants";

/**
 * /gift/[token] — recipient claim page (celebratory).
 *
 * The path token is the ephemeral pubkey the sender published. The
 * fragment carries the secret material:
 *
 *   /gift/<ephemeralPubkey>#k=<base64-priv>&m=<base64-meta>
 *
 * Three states:
 *
 *   1. Pre-connect: a celebratory "card" with the amount in display
 *      serif, the optional message in Boska italic, the sender's name.
 *      One CTA: "Connect wallet to claim". Subtle gold halo, gold dot
 *      drift behind the card.
 *   2. Claiming: spinner + status line ("withdrawing privately"). The
 *      gift card stays visible; we never blank the page during a Phantom
 *      popup or MPC settlement.
 *   3. Claimed: card transitions to a quieter "✓ It's in your wallet"
 *      state with a Solana Explorer link. The drift animation amps up to
 *      a slow ascending stream — small, tasteful, not a confetti cannon.
 *
 * Wallet popups: ZERO during claim. The shadow signs in-memory; the
 * recipient's wallet is used only to provide the destination address.
 */
export default function GiftClaimPage({
  params,
}: {
  params: { token: string };
}) {
  const wallet = useWallet();

  const [parseError, setParseError] = useState<string | null>(null);
  const [privateKey, setPrivateKey] = useState<Uint8Array | null>(null);
  const [metadata, setMetadata] = useState<GiftMetadata | null>(null);
  const [tokenMismatch, setTokenMismatch] = useState(false);

  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claimSignature, setClaimSignature] = useState<string | null>(null);

  // Read the URL fragment (client-only — server never sees it). The
  // fragment is the entire security model: it's the only source of the
  // shadow's private key.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const parsed = parseGiftUrlFragment(window.location.hash);
      setPrivateKey(parsed.privateKey);
      setMetadata(parsed.metadata);

      // Sanity-check: the URL token should match the pubkey derived from
      // the private key. Mismatch isn't fatal (we trust the in-fragment
      // key for the actual claim), but warn the user — could indicate a
      // mangled URL or a phishing attempt where someone swapped the path
      // token without updating the fragment.
      if (params.token) {
        const derived = deriveGiftShadow(parsed.privateKey);
        if (derived.address !== params.token) {
          setTokenMismatch(true);
        }
      }
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err));
    }
  }, [params.token]);

  async function handleClaim() {
    if (!wallet.publicKey || !privateKey || !metadata) return;
    setClaiming(true);
    setClaimError(null);
    setClaimSignature(null);
    try {
      const shadowClient = await buildShadowClient(privateKey);
      const result = await withdrawFromShadow({
        shadowClient,
        recipientAddress: wallet.publicKey.toBase58(),
        mint: metadata.mint,
        amount: BigInt(metadata.amountBaseUnits),
      });
      setClaimSignature(result.callbackSignature ?? result.queueSignature);
    } catch (err) {
      setClaimError(err instanceof Error ? err.message : String(err));
    } finally {
      setClaiming(false);
    }
  }

  const explorerUrl = useMemo(() => {
    if (!claimSignature) return null;
    const cluster = NETWORK === "devnet" ? "?cluster=devnet" : "";
    return `https://explorer.solana.com/tx/${claimSignature}${cluster}`;
  }, [claimSignature]);

  if (parseError) {
    return (
      <Shell>
        <div className="max-w-2xl mx-auto reveal">
          <span className="eyebrow">Gift</span>
          <h1 className="mt-3 font-sans font-medium text-ink text-[40px] md:text-[52px] leading-[1.03] tracking-[-0.025em]">
            That link looks incomplete.
          </h1>
          <p className="mt-6 max-w-[480px] text-[15px] text-ink/75 leading-relaxed">
            We couldn&apos;t read the gift from this URL. Most often this means
            the link wrapped across multiple lines and only the first line
            was copied. Try opening the original message and pasting the
            FULL URL — including everything after the{" "}
            <code className="font-mono">#</code>.
          </p>
          <p className="mt-4 text-[12.5px] text-dim font-mono">
            {parseError}
          </p>
        </div>
      </Shell>
    );
  }

  if (!privateKey) {
    return (
      <Shell>
        <div className="max-w-xl mx-auto reveal">
          <p className="text-[13.5px] text-muted">Unwrapping your gift…</p>
        </div>
      </Shell>
    );
  }

  const claimed = !!claimSignature;

  return (
    <Shell celebratory={!claimed}>
      <div className="max-w-3xl mx-auto reveal">
        {tokenMismatch && (
          <div className="mb-8 flex items-start gap-4 border-l-2 border-brick pl-5 py-3">
            <span className="mono-chip text-brick shrink-0 pt-0.5">
              Heads up
            </span>
            <span className="text-[13px] text-ink leading-relaxed">
              The URL path doesn&apos;t match the gift&apos;s ephemeral key.
              We&apos;ll still process the claim from the in-fragment key,
              but double-check the link came from someone you trust.
            </span>
          </div>
        )}

        {/* The card. */}
        <article className="relative">
          <div className="relative bg-paper-3 border border-line rounded-[5px] px-8 md:px-14 py-12 md:py-16 overflow-hidden">
            {/* Top gold rule. */}
            <div className="absolute left-0 top-0 h-1 w-full bg-gold" />

            {/* The eyebrow + recipient line — tight, editorial. */}
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <span className="eyebrow">
                {claimed ? "Gift claimed" : "A gift for you"}
              </span>
              {metadata?.recipientName && (
                <span className="text-[12px] font-mono tracking-[0.14em] uppercase text-dim">
                  To: {metadata.recipientName}
                </span>
              )}
            </div>

            {!claimed ? (
              <>
                <p className="mt-7 max-w-[520px] text-[16px] md:text-[18px] text-ink/80 leading-relaxed">
                  {metadata?.sender ? (
                    <>
                      <span className="text-ink font-medium">{metadata.sender}</span>{" "}
                      sent you{" "}
                    </>
                  ) : (
                    <>Someone sent you </>
                  )}
                  a private gift. Connect any Solana wallet and it&apos;s yours.
                </p>

                <div className="mt-10 flex items-baseline gap-4">
                  <span className="font-display font-medium text-gold text-[88px] md:text-[120px] leading-[0.92] tracking-[-0.025em]">
                    {metadata?.amount ?? "—"}
                  </span>
                  <span className="font-mono text-[15px] tracking-[0.12em] uppercase text-muted">
                    {metadata?.symbol ?? ""}
                  </span>
                </div>

                {metadata?.message && (
                  <blockquote className="mt-12 max-w-[600px] font-display italic text-ink text-[24px] md:text-[30px] leading-[1.32] tracking-[-0.005em]">
                    <span aria-hidden className="text-muted mr-1">
                      &ldquo;
                    </span>
                    {metadata.message}
                    <span aria-hidden className="text-muted ml-1">
                      &rdquo;
                    </span>
                  </blockquote>
                )}

                {/* Action area inside the card. */}
                <div className="mt-14 pt-7 border-t border-line/70">
                  {!wallet.connected ? (
                    <div>
                      <p className="text-[14px] text-ink/75 mb-5 leading-relaxed max-w-[480px]">
                        Connect any Solana wallet (Phantom, Backpack,
                        Solflare). The gift will land directly there — you
                        don&apos;t need to set up Veil.
                      </p>
                      <ClientWalletMultiButton />
                    </div>
                  ) : (
                    <div>
                      <p className="text-[13.5px] text-ink/70 mb-5 leading-relaxed">
                        It&apos;ll arrive in{" "}
                        <span className="font-mono text-ink">
                          {wallet.publicKey?.toBase58().slice(0, 8)}…
                          {wallet.publicKey?.toBase58().slice(-6)}
                        </span>
                        .
                      </p>
                      <button
                        type="button"
                        onClick={handleClaim}
                        disabled={claiming || !metadata}
                        className="btn-primary w-full md:w-auto md:min-w-[340px]"
                      >
                        {claiming ? (
                          <span className="inline-flex items-center gap-3">
                            <span className="h-1.5 w-1.5 rounded-full bg-paper animate-slow-pulse" />
                            Sending it to your wallet…
                          </span>
                        ) : (
                          <span>
                            Claim {metadata?.amount} {metadata?.symbol}{" "}
                            <span aria-hidden>→</span>
                          </span>
                        )}
                      </button>
                      <p className="mt-3 text-[11.5px] font-mono tracking-[0.12em] uppercase text-dim">
                        No wallet popup — the gift signs itself.
                      </p>
                    </div>
                  )}

                  {claimError && (
                    <div className="mt-7 flex items-start gap-4 border-l-2 border-brick pl-5 py-3">
                      <span className="mono-chip text-brick shrink-0 pt-0.5">
                        Error
                      </span>
                      <span className="text-[13.5px] text-ink leading-relaxed">
                        {claimError}
                      </span>
                    </div>
                  )}
                </div>
              </>
            ) : (
              /* Claimed state — quieter, with a confirmation. */
              <>
                <h1 className="mt-7 font-display italic font-medium text-ink text-[36px] md:text-[44px] leading-[1.1] tracking-[-0.015em]">
                  It&apos;s in your wallet.
                </h1>
                <p className="mt-5 max-w-[480px] text-[15px] text-ink/80 leading-relaxed">
                  {metadata?.amount} {metadata?.symbol}{" "}
                  {metadata?.sender ? (
                    <>
                      from{" "}
                      <span className="text-ink font-medium">
                        {metadata.sender}
                      </span>
                    </>
                  ) : (
                    <>from your sender</>
                  )}
                  . Arcium MPC finalisation can take a few extra seconds —
                  refresh your wallet balance in a moment.
                </p>

                <div className="mt-10 flex items-center gap-5 flex-wrap">
                  {explorerUrl && (
                    <a
                      href={explorerUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="btn-ghost"
                    >
                      View on Solana Explorer
                    </a>
                  )}
                  <Link
                    href="/send"
                    prefetch
                    className="btn-quiet text-[13.5px]"
                  >
                    Send a gift back →
                  </Link>
                </div>
              </>
            )}
          </div>

          {/* Drift dots behind the card — soft, slow, decorative.
              Hidden under reduced-motion (CSS handles it). */}
          {!claimed && (
            <div
              aria-hidden
              className="pointer-events-none absolute -inset-x-6 -top-12 -bottom-2 -z-10 overflow-hidden"
            >
              {[
                { left: "8%", delay: "0s", size: 6 },
                { left: "26%", delay: "1.4s", size: 4 },
                { left: "62%", delay: "0.6s", size: 5 },
                { left: "84%", delay: "2.1s", size: 4 },
              ].map((d, i) => (
                <span
                  key={i}
                  className="gift-drift absolute bottom-0 rounded-full bg-gold/40"
                  style={{
                    left: d.left,
                    width: d.size,
                    height: d.size,
                    animationDelay: d.delay,
                  }}
                />
              ))}
            </div>
          )}
        </article>

        {/* Footer-ish meta — quieter, factual. */}
        <div className="mt-10 grid grid-cols-2 md:grid-cols-3 gap-y-4 gap-x-10 max-w-2xl">
          <Meta label="Network" value={NETWORK === "mainnet" ? "Solana mainnet" : "Solana devnet"} />
          <Meta label="Privacy" value="Umbra encrypted balance" />
          <Meta
            label="Cost to you"
            value="0 SOL — sender prepaid"
          />
        </div>
      </div>
    </Shell>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="eyebrow">{label}</span>
      <span className="text-[13px] text-ink leading-snug">{value}</span>
    </div>
  );
}

function Shell({
  children,
  celebratory = false,
}: {
  children: React.ReactNode;
  celebratory?: boolean;
}) {
  return (
    <main className="min-h-screen relative pb-32">
      {/* Optional gold halo behind the hero — ONLY on the unclaimed state. */}
      {celebratory && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-[600px] gift-halo -z-10"
        />
      )}

      <nav className="sticky top-0 z-10 backdrop-blur-sm bg-paper/80 border-b border-line">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between px-6 md:px-8 py-4">
          <VeilLogo />
          <ClientWalletMultiButton />
        </div>
      </nav>

      <section className="max-w-[1400px] mx-auto px-6 md:px-8 pt-16 md:pt-24">
        {children}
      </section>
    </main>
  );
}
