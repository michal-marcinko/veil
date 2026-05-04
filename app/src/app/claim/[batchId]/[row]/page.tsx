"use client";

import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { VeilLogo } from "@/components/VeilLogo";
import {
  buildShadowClient,
  parseClaimUrlFragment,
  withdrawFromShadow,
  type ClaimUrlMetadata,
} from "@/lib/payroll-claim-links";

/**
 * /claim/[batchId]/[row] — recipient-facing claim page.
 *
 * Bob lands here from a link Alice (his employer) shared. The page:
 *   1. Reads the ephemeral private key from the URL fragment (k=...)
 *      and the prefilled metadata (m=..., optional).
 *   2. Renders "You have <X> from <employer>. Connect your wallet to
 *      claim." Even before connecting, the metadata is visible so Bob
 *      knows what's being claimed.
 *   3. Bob connects any Solana wallet (Phantom, Backpack, Solflare,
 *      etc.) — the wallet adapter is shared with the rest of the app.
 *   4. Bob clicks "Claim". The page builds an in-memory Umbra client
 *      with the ephemeral key as signer, then withdraws the shadow's
 *      encrypted balance directly to Bob's connected wallet.
 *   5. On success, the tx signature is shown along with a link to
 *      Solana Explorer. Bob's wallet now holds native USDC/SOL.
 *
 * The wallet popups Bob sees are ZERO — the SDK signs every withdraw
 * tx with the in-memory ephemeral key (no Phantom involvement). Bob's
 * wallet is used purely as a destination address.
 */
export default function ClaimPage({
  params,
}: {
  params: { batchId: string; row: string };
}) {
  const wallet = useWallet();

  const [parseError, setParseError] = useState<string | null>(null);
  const [ephemeralPrivateKey, setEphemeralPrivateKey] = useState<Uint8Array | null>(null);
  const [metadata, setMetadata] = useState<ClaimUrlMetadata | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claimSignature, setClaimSignature] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      // The URL fragment is the ONLY place we get the private key from.
      // It MUST stay client-side — never sent to a server, never
      // logged, never persisted. This is the entire security model of
      // the claim-link pattern.
      const { privateKey, metadata: meta } = parseClaimUrlFragment(window.location.hash);
      setEphemeralPrivateKey(privateKey);
      setMetadata(meta);
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  async function handleClaim() {
    if (!wallet.publicKey || !ephemeralPrivateKey || !metadata) return;
    setClaiming(true);
    setClaimError(null);
    setClaimSignature(null);
    try {
      const shadowClient = await buildShadowClient(ephemeralPrivateKey);
      const result = await withdrawFromShadow({
        shadowClient,
        recipientAddress: wallet.publicKey.toBase58(),
        mint: metadata.mint,
        amount: BigInt(metadata.amountBaseUnits),
      });
      // Prefer callbackSignature when present — that's the tx the user
      // can look up to see "the tokens actually arrived in my ATA".
      // queueSignature is the deposit-into-MPC anchor; callback is the
      // Arcium finalization that mints into the destination ATA.
      setClaimSignature(result.callbackSignature ?? result.queueSignature);
    } catch (err) {
      setClaimError(err instanceof Error ? err.message : String(err));
    } finally {
      setClaiming(false);
    }
  }

  const explorerUrl = useMemo(() => {
    if (!claimSignature) return null;
    return `https://explorer.solana.com/tx/${claimSignature}?cluster=devnet`;
  }, [claimSignature]);

  if (parseError) {
    return (
      <Shell>
        <div className="max-w-2xl mx-auto reveal">
          <span className="eyebrow">Claim payroll</span>
          <h1 className="mt-3 font-sans font-medium text-ink text-[40px] md:text-[52px] leading-[1.03] tracking-[-0.025em]">
            Bad claim link.
          </h1>
          <p className="mt-6 text-[14px] text-brick/80 leading-relaxed">
            {parseError}
          </p>
          <p className="mt-4 text-[14px] text-ink/70 leading-relaxed">
            The link you opened is missing or has a malformed key fragment.
            Make sure you copy-pasted the FULL URL — including everything
            after the <code className="font-mono">#</code>. If your link
            wrapped across multiple lines in an email, lines after the first
            often get dropped.
          </p>
        </div>
      </Shell>
    );
  }

  if (!ephemeralPrivateKey) {
    return (
      <Shell>
        <div className="max-w-2xl mx-auto reveal">
          <p className="text-[13.5px] text-muted">Loading claim link…</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="max-w-2xl mx-auto reveal">
        <span className="eyebrow">Claim payroll</span>
        <h1 className="mt-3 font-sans font-medium text-ink text-[40px] md:text-[52px] leading-[1.03] tracking-[-0.025em]">
          {metadata
            ? `You have ${metadata.amount} ${metadata.symbol}.`
            : "You have a payment."}
        </h1>
        {metadata && (
          <p className="mt-6 text-[17px] md:text-[19px] text-ink/80 leading-[1.5]">
            From <span className="font-medium text-ink">{metadata.sender}</span>.
            Connect any Solana wallet to claim — the funds will land directly in
            your wallet.
          </p>
        )}

        <dl className="mt-10 border-t border-line pt-6 space-y-3 text-[13px]">
          <Row label="Batch" value={params.batchId} />
          <Row label="Row" value={params.row} />
          {metadata && <Row label="Mint" value={metadata.mint} />}
        </dl>

        {!claimSignature && (
          <>
            <div className="mt-10">
              {!wallet.connected ? (
                <div>
                  <p className="text-[14px] text-ink/70 mb-4 leading-relaxed">
                    Connect your wallet so we know where to send the funds.
                  </p>
                  <ClientWalletMultiButton />
                </div>
              ) : (
                <div>
                  <p className="text-[14px] text-ink/70 mb-4 leading-relaxed">
                    Funds will go to{" "}
                    <span className="font-mono text-ink">
                      {wallet.publicKey?.toBase58().slice(0, 8)}…
                      {wallet.publicKey?.toBase58().slice(-6)}
                    </span>
                    .
                  </p>
                  <button
                    onClick={handleClaim}
                    disabled={claiming || !metadata}
                    className="btn-primary w-full md:w-auto md:min-w-[340px]"
                  >
                    {claiming ? (
                      <span className="inline-flex items-center gap-3">
                        <span className="h-1.5 w-1.5 rounded-full bg-paper animate-slow-pulse" />
                        Claiming…
                      </span>
                    ) : (
                      <span>
                        Claim {metadata?.amount} {metadata?.symbol}{" "}
                        <span aria-hidden>→</span>
                      </span>
                    )}
                  </button>
                  <p className="mt-3 text-[12px] font-mono tracking-[0.12em] uppercase text-dim">
                    No wallet popups. The claim signs itself.
                  </p>
                </div>
              )}
            </div>

            {claimError && (
              <div className="mt-6 flex items-start gap-4 border-l-2 border-brick pl-5 py-3">
                <span className="mono-chip text-brick shrink-0 pt-0.5">Error</span>
                <span className="text-[13.5px] text-ink leading-relaxed">{claimError}</span>
              </div>
            )}
          </>
        )}

        {claimSignature && (
          <div className="mt-10 border border-sage/40 bg-sage/5 rounded-[3px] p-5">
            <div className="flex items-start gap-3">
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                className="shrink-0 mt-0.5 text-sage"
              >
                <path
                  d="M3 8l3.5 3.5L13 4.5"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <div className="flex-1">
                <div className="text-[14px] text-ink font-medium">
                  Claimed {metadata?.amount} {metadata?.symbol}.
                </div>
                <div className="text-[13px] text-muted mt-1 leading-relaxed">
                  Funds are in your wallet. Arcium MPC finalization may take a
                  few extra seconds — refresh your wallet balance in a moment.
                </div>
                {explorerUrl && (
                  <a
                    href={explorerUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-4 btn-quiet text-[12px] inline-block"
                  >
                    View on Solana Explorer
                  </a>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </Shell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-dim font-mono uppercase tracking-[0.12em] text-[10px]">
        {label}
      </dt>
      <dd className="text-ink font-mono truncate">{value}</dd>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen relative pb-32">
      <nav className="sticky top-0 z-10 backdrop-blur-sm bg-paper/80 border-b border-line">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between px-6 md:px-8 py-4">
          <VeilLogo />
          <ClientWalletMultiButton />
        </div>
      </nav>

      <section className="max-w-[1400px] mx-auto px-6 md:px-8 pt-16 md:pt-20">
        {children}
      </section>
    </main>
  );
}
