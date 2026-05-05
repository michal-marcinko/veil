"use client";

import { useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { VeilLogo } from "@/components/VeilLogo";
import {
  buildShadowClient,
  claimToRecipient,
  parseClaimUrlFragment,
  withdrawFromShadow,
  type ClaimUrlMetadata,
} from "@/lib/payroll-claim-links";
import {
  ensureRegistered,
  getOrCreateClient,
  isFullyRegistered,
} from "@/lib/umbra";
import { formatTxError, type SdkErrorDetail } from "@/lib/sdk-error";
import {
  persistReceivedPayment,
  type ReceivedPayment,
} from "@/lib/received-payments-storage";

// Claim-page sub-steps surface what's happening under the button so
// long ZK / Arcium waits read as "happening" rather than frozen.
//
// Phase A privacy upgrade — the claim flow no longer ends with a
// shadow→recipient sweep (which leaks the link on-chain). Instead the
// shadow re-encrypts its balance into a NEW pool UTXO addressed to
// the recipient's view key, and the recipient claims + withdraws on
// their own client. The new sub-steps that surface to the user:
//   - "registering"   : recipient is brand-new, run one-time Umbra
//                       setup (~2 wallet popups) before claiming.
//   - "scanning"      : shadow is looking for the deposit UTXO.
//   - "claiming"      : shadow claims its deposit into encrypted balance.
//   - "reencrypting"  : shadow re-encrypts → pool UTXO → recipient.
//                       This is the privacy-preserving hop.
//   - "withdrawing"   : recipient withdraws their shielded balance to
//                       their connected wallet (native SOL/USDC).
type ClaimStep =
  | "idle"
  | "registering"
  | "scanning"
  | "claiming"
  | "reencrypting"
  | "withdrawing";

function claimStepLabel(step: ClaimStep): string {
  switch (step) {
    case "registering":
      return "Setting up your private payments… (1 wallet popup)";
    case "scanning":
      return "Looking for your funds…";
    case "claiming":
      return "Claiming UTXO into encrypted balance…";
    case "reencrypting":
      return "Forwarding via privacy pool…";
    case "withdrawing":
      return "Withdrawing to your wallet…";
    default:
      return "Claiming…";
  }
}

/**
 * Failed-claim banner with optional logs disclosure. Mirrors the
 * `RowErrorChip` on the sender side — same shape so the diagnostic
 * affordances feel like one product. Empty-scan failures get a
 * specific recovery hint because they're the most likely transient
 * cause (Arcium hadn't finalised by the polling deadline).
 */
function ClaimErrorPanel({
  error,
  detail,
}: {
  error: string;
  detail: SdkErrorDetail | null;
}) {
  const [open, setOpen] = useState(false);
  const hasLogs = !!(detail?.logs && detail.logs.length > 0);
  const hasMore = hasLogs || (detail?.rawMessage && detail.rawMessage !== error);

  return (
    <div className="mt-6 border-l-2 border-brick pl-5 py-3">
      <div className="flex items-start gap-4">
        <span className="mono-chip text-brick shrink-0 pt-0.5">Error</span>
        <div className="text-[13.5px] text-ink leading-relaxed flex-1 whitespace-pre-wrap break-words">
          {error}
        </div>
      </div>
      {hasMore && (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="mt-2 ml-[68px] font-mono text-[10.5px] tracking-[0.16em] uppercase text-ink/55 hover:text-ink transition-colors inline-flex items-center gap-1.5"
          >
            <span>{open ? "Hide details" : "Show details"}</span>
            <span aria-hidden className={`transition-transform duration-150 ${open ? "rotate-180" : ""}`}>↓</span>
          </button>
          {open && (
            <pre className="mt-2 ml-[68px] max-h-[260px] overflow-auto whitespace-pre-wrap break-words border border-line bg-paper-2/60 rounded-[3px] p-3 font-mono text-[11px] text-ink leading-[1.55]">
              {detail?.rawMessage && (
                <div className="text-muted mb-2">{detail.rawMessage}</div>
              )}
              {hasLogs && detail!.logs!.join("\n")}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

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
 *   4. If Bob is brand new to Umbra, the page surfaces a one-time
 *      "Set up private payments" consent prompt (see
 *      `RegistrationConsentPrompt`). The recommended path runs Umbra
 *      registration on Bob's wallet (~2 popups, ~0.005 SOL one-time)
 *      so the claim can finish through the privacy mixer. Bob can
 *      opt out and take the legacy "quick claim" path, which works
 *      but reduces the row's privacy (publicly visible shadow→Bob
 *      sweep on-chain).
 *   5. Bob clicks "Claim". The page now runs the mixer-based path:
 *        a. Build an in-memory shadow Umbra client (signer = ephemeral
 *           key from the URL fragment).
 *        b. Build Bob's wallet-backed Umbra client.
 *        c. Shadow scans + claims its deposit into encrypted balance.
 *        d. Shadow re-encrypts that balance into a NEW UTXO in the
 *           Umbra pool, locked to Bob's view key. (This is the hop
 *           that breaks the on-chain link from sender → Bob.)
 *        e. Bob's client scans the pool, claims the UTXO into his
 *           own encrypted balance, and withdraws to his wallet.
 *      Native SOL/USDC lands directly in Bob's wallet on the last
 *      step — the SDK's withdraw helper closes to the SIGNER's
 *      address, so no manual sweep is needed.
 *   6. On success, the tx signature is shown along with a link to
 *      Solana Explorer.
 *
 * Wallet popups Bob sees:
 *   - First-time recipient (mixer path):  ~3 popups
 *       * 2× registration (signMessage + signAllTransactions for
 *         register sub-txs) — only on the very first claim ever.
 *       * 1× claim (signs the recipient's claim-into-ETA tx).
 *       * 1× withdraw (signs the recipient's withdraw tx).
 *   - Returning recipient (mixer path):   ~2 popups (claim + withdraw).
 *   - Quick-claim fallback:                0 popups (legacy sweep
 *     path, signed by the in-memory shadow keypair).
 */
export default function ClaimPage({
  params,
}: {
  params: { batchId: string; row: string };
}) {
  const wallet = useWallet();
  const { connection } = useConnection();

  const [parseError, setParseError] = useState<string | null>(null);
  const [ephemeralPrivateKey, setEphemeralPrivateKey] = useState<Uint8Array | null>(null);
  const [metadata, setMetadata] = useState<ClaimUrlMetadata | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claimErrorDetail, setClaimErrorDetail] = useState<SdkErrorDetail | null>(null);
  const [claimSignature, setClaimSignature] = useState<string | null>(null);
  // Sub-step state — drives the progress copy under the button so a
  // long Arcium-MPC wait or a multi-second ZK proof read as
  // "happening" rather than "frozen".
  const [claimStep, setClaimStep] = useState<ClaimStep>("idle");
  // Registration probe state. We run a one-time check after the wallet
  // connects so we can show the consent prompt BEFORE the user clicks
  // claim. `null` = not yet probed; `true` / `false` = the answer.
  const [recipientRegistered, setRecipientRegistered] = useState<boolean | null>(
    null,
  );

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

  // Probe the recipient's Umbra registration once the wallet connects.
  // We do this as soon as the wallet is available so the consent prompt
  // can render before the user clicks claim — surprising them with a
  // popup AFTER they've committed to claiming would feel coercive.
  useEffect(() => {
    let cancelled = false;
    if (!wallet.connected || !wallet.publicKey) return;
    (async () => {
      try {
        const recipientClient = await getOrCreateClient(wallet);
        const registered = await isFullyRegistered(recipientClient);
        if (!cancelled) setRecipientRegistered(registered);
        // eslint-disable-next-line no-console
        console.log(
          `[claim] recipient registration probe: ${registered ? "registered" : "unregistered"}`,
        );
      } catch (err) {
        // Probe failure is non-fatal — treat as "unknown" and let the
        // user decide. We default to showing the prompt (treat as
        // unregistered) so they're aware setup might be needed.
        // eslint-disable-next-line no-console
        console.warn("[claim] registration probe failed", err);
        if (!cancelled) setRecipientRegistered(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wallet.connected, wallet.publicKey, wallet]);

  /**
   * Run the claim flow. `mode` controls whether we take the privacy-
   * preserving mixer path (default; recommended) or the legacy public
   * sweep fallback (only when the user explicitly opts out of setup).
   *
   * Two scenarios this function handles:
   *
   *   (a) Recipient is already registered. The mixer path runs end-to-
   *       end without registration. ~2 popups (recipient claim +
   *       withdraw). Sender→shadow→pool→recipient with no on-chain
   *       link from shadow to recipient.
   *
   *   (b) Recipient is brand-new. We run `ensureRegistered` first,
   *       which surfaces ~2 popups (signMessage to derive master seed,
   *       signAllTransactions for the 3 register sub-txs). Then the
   *       mixer path runs as in (a).
   *
   *   (c) Recipient declined the prompt → mode === "sweep". We skip
   *       registration entirely and call the legacy `withdrawFromShadow`,
   *       which performs a publicly-visible shadow→recipient transfer.
   *       Worse for privacy, but completes without setup popups.
   */
  async function handleClaim(mode: "mixer" | "sweep" = "mixer") {
    if (!wallet.publicKey || !ephemeralPrivateKey || !metadata) return;
    setClaiming(true);
    setClaimError(null);
    setClaimErrorDetail(null);
    setClaimSignature(null);
    try {
      const shadowClient = await buildShadowClient(ephemeralPrivateKey);

      if (mode === "sweep") {
        // Legacy quick-claim path — opt-out for users who don't want
        // to register. Reduces privacy for this row (sender → shadow
        // → recipient becomes publicly traceable). Kept as an escape
        // hatch so the row never blocks on the user's setup choice.
        // eslint-disable-next-line no-console
        console.warn(
          "[claim] taking legacy sweep path — privacy reduced for this row",
        );
        setClaimStep("withdrawing");
        const result = await withdrawFromShadow({
          shadowClient,
          ephemeralPrivateKey,
          connection,
          recipientAddress: wallet.publicKey.toBase58(),
          mint: metadata.mint,
          amount: BigInt(metadata.amountBaseUnits),
        });
        const finalSig = result.callbackSignature ?? result.queueSignature;
        setClaimSignature(finalSig);
        // Persist for the recipient dashboard — the sweep path leaves a
        // ReceivedPayment with `mode: "sweep"` so the payslip footnote
        // explains the publicly-visible shadow→wallet hop.
        await persistClaimToReceivedPayments({
          wallet,
          batchId: params.batchId,
          rowIndex: parseInt(params.row, 10) || 0,
          metadata,
          mode: "sweep",
          claimSignature: finalSig,
          sweepSignature: finalSig,
        });
        setClaimStep("idle");
        return;
      }

      // Mixer path — privacy-preserving.
      const recipientClient = await getOrCreateClient(wallet);

      // 1. Ensure the recipient is registered with Umbra. We probed
      //    this on wallet connect, but `ensureRegistered` is safe to
      //    re-run — it short-circuits when already registered.
      const alreadyRegistered = await isFullyRegistered(recipientClient);
      if (!alreadyRegistered) {
        setClaimStep("registering");
        // eslint-disable-next-line no-console
        console.log(
          "[claim] recipient unregistered — running ensureRegistered (will surface ~2 wallet popups)",
        );
        await ensureRegistered(recipientClient, (step, status) => {
          // eslint-disable-next-line no-console
          console.log(`[claim] register progress: ${step}/${status}`);
        });
        setRecipientRegistered(true);
      }

      // 2. Run the mixer path: shadow scan+claim → re-encrypt to
      //    recipient → recipient scan+claim → recipient withdraw.
      //    The lib reports its current phase via `onPhase` so the
      //    progress copy under the button stays in sync with the
      //    long Arcium-MPC waits.
      setClaimStep("scanning");
      const result = await claimToRecipient({
        shadowClient,
        recipientClient,
        ephemeralPrivateKey,
        connection,
        recipientAddress: wallet.publicKey.toBase58(),
        mint: metadata.mint,
        amount: BigInt(metadata.amountBaseUnits),
        // The mixer path explicitly does NOT auto-fall-back to sweep
        // here — the user already picked their path via the consent
        // prompt. If something goes wrong inside claimToRecipient,
        // surface the error and let them retry or pick "Quick claim".
        fallbackToSweep: false,
        onPhase: (phase) => setClaimStep(phase),
      });
      // eslint-disable-next-line no-console
      console.log(
        `[claim] claimToRecipient succeeded via path=${result.path}, finalSig=${result.finalSignature}`,
      );
      setClaimSignature(result.finalSignature);
      // Persist for the recipient dashboard. The mixer path may have
      // transparently fallen back to a sweep inside `claimToRecipient`
      // (state-3 recovery — see lib/payroll-claim-links.ts:1256), so
      // we mirror the result.path back into the persisted record.
      await persistClaimToReceivedPayments({
        wallet,
        batchId: params.batchId,
        rowIndex: parseInt(params.row, 10) || 0,
        metadata,
        mode: result.path,
        claimSignature: result.finalSignature,
        withdrawSignature:
          result.path === "mixer" ? result.finalSignature : undefined,
        reencryptSignature: result.reencryptSignature,
        sweepSignature:
          result.path === "sweep" ? result.finalSignature : undefined,
      });
      setClaimStep("idle");
    } catch (err) {
      // Use the shared SDK error formatter so wrapper messages don't
      // bury the inner cause + program logs. Sender + recipient now
      // share the same diagnostic plumbing.
      const detail = await formatTxError(err, {
        phase: claimStep,
        connection,
        consoleLabel: "[claim] failed",
      });
      setClaimError(detail.summary);
      setClaimErrorDetail(detail);
      setClaimStep("idle");
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
              ) : recipientRegistered === null ? (
                // Probing the recipient's registration state. Brief
                // — usually <1s — but worth a placeholder so the page
                // doesn't appear to "do nothing" between connect and
                // the next state.
                <p className="text-[13.5px] text-muted">
                  Checking your wallet…
                </p>
              ) : recipientRegistered === false && !claiming ? (
                // Brand-new recipient — surface the consent prompt
                // BEFORE they click claim so they understand the
                // setup popups before they happen. Picking "Quick
                // claim" routes through the legacy sweep path; the
                // recommended button runs the mixer path with
                // registration up-front.
                <RegistrationConsentPrompt
                  recipient={wallet.publicKey?.toBase58() ?? ""}
                  onPrivate={() => handleClaim("mixer")}
                  onQuick={() => handleClaim("sweep")}
                  disabled={!metadata}
                  amount={metadata?.amount}
                  symbol={metadata?.symbol}
                />
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
                    onClick={() => handleClaim("mixer")}
                    disabled={claiming || !metadata}
                    className="btn-primary w-full md:w-auto md:min-w-[340px]"
                  >
                    {claiming ? (
                      <span className="inline-flex items-center gap-3">
                        <span className="h-1.5 w-1.5 rounded-full bg-paper animate-slow-pulse" />
                        {claimStepLabel(claimStep)}
                      </span>
                    ) : (
                      <span>
                        Claim {metadata?.amount} {metadata?.symbol}{" "}
                        <span aria-hidden>→</span>
                      </span>
                    )}
                  </button>
                  <p className="mt-3 text-[12px] font-mono tracking-[0.12em] uppercase text-dim">
                    Routed through the privacy pool. Two wallet popups (claim + withdraw).
                  </p>
                </div>
              )}
            </div>

            {claimError && (
              <ClaimErrorPanel error={claimError} detail={claimErrorDetail} />
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

/**
 * Build a `ReceivedPayment` from the current claim's metadata + result
 * signatures and persist it to the recipient's local cache + Arweave.
 * Phase B addition — fires after either claim path succeeds so the
 * dashboard's "Received private payments" section sees the row on the
 * recipient's next visit.
 *
 * Best-effort: a persistence failure does NOT roll back the claim.
 * The funds are already in the recipient's wallet; the dashboard will
 * miss this row until they re-claim (impossible — UTXO is gone) or
 * receive future payments. We log the error but otherwise swallow.
 */
async function persistClaimToReceivedPayments(args: {
  wallet: { publicKey?: { toBase58: () => string } | null; signMessage?: (msg: Uint8Array) => Promise<Uint8Array> };
  batchId: string;
  rowIndex: number;
  metadata: ClaimUrlMetadata;
  mode: "mixer" | "sweep";
  claimSignature: string;
  withdrawSignature?: string;
  reencryptSignature?: string;
  sweepSignature?: string;
}) {
  if (!args.wallet.publicKey) return;
  const walletBase58 = args.wallet.publicKey.toBase58();
  const payment: ReceivedPayment = {
    batchId: args.batchId,
    rowIndex: args.rowIndex,
    senderWallet: "",
    senderDisplayName: args.metadata.sender ?? "",
    amount: args.metadata.amountBaseUnits,
    amountDisplay: args.metadata.amount,
    symbol: args.metadata.symbol,
    mint: args.metadata.mint,
    memo: null,
    claimSignature: args.claimSignature,
    withdrawSignature: args.withdrawSignature,
    reencryptSignature: args.reencryptSignature,
    sweepSignature: args.sweepSignature,
    mode: args.mode,
    receivedAt: new Date().toISOString(),
  };
  try {
    await persistReceivedPayment({
      wallet: args.wallet as any,
      walletBase58,
      payment,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[claim] persistReceivedPayment failed (non-fatal)", err);
  }
}

/**
 * Consent prompt shown to brand-new recipients before the claim runs.
 *
 * The recipient hasn't registered with Umbra yet, so to take the
 * privacy-preserving (mixer-routed) claim path we need ~2 wallet
 * popups + ~0.005 SOL of one-time on-chain setup. We surface this up
 * front rather than ambushing the user mid-claim.
 *
 * The "less private" escape hatch is the legacy sweep path
 * (`withdrawFromShadow`), kept available for users who don't want to
 * register or whose wallets can't comfortably afford the setup cost.
 * It's still a successful claim — just visibly traceable on-chain.
 */
function RegistrationConsentPrompt({
  recipient,
  amount,
  symbol,
  onPrivate,
  onQuick,
  disabled,
}: {
  recipient: string;
  amount?: string;
  symbol?: string;
  onPrivate: () => void;
  onQuick: () => void;
  disabled?: boolean;
}) {
  const recipientShort = recipient
    ? `${recipient.slice(0, 8)}…${recipient.slice(-6)}`
    : "your wallet";
  return (
    <div className="border border-line rounded-[3px] p-6 bg-paper-2/40">
      <span className="eyebrow">One-time setup</span>
      <h2 className="mt-3 font-sans font-medium text-ink text-[20px] md:text-[22px] leading-[1.25] tracking-[-0.01em]">
        Set up private payments?
      </h2>
      <p className="mt-3 text-[13.5px] text-ink/75 leading-relaxed">
        This is your first time receiving on Veil. To keep this row
        un-linkable on-chain, we&apos;ll register{" "}
        <span className="font-mono text-ink">{recipientShort}</span> with
        Umbra — a one-time ~0.005 SOL setup that pays for itself in
        future privacy.
      </p>
      <ul className="mt-4 space-y-1.5 text-[12.5px] text-ink/70">
        <li>
          <span className="text-dim mr-2">·</span>
          About 2 wallet popups for setup, then 1-2 popups for the claim.
        </li>
        <li>
          <span className="text-dim mr-2">·</span>
          Subsequent payments to this wallet stay fully private with no
          re-setup.
        </li>
      </ul>
      <div className="mt-7 flex flex-col md:flex-row gap-3 md:items-center">
        <button
          type="button"
          onClick={onPrivate}
          disabled={disabled}
          className="btn-primary md:min-w-[300px]"
        >
          <span>
            Set up &amp; claim privately
            <span className="ml-2 text-[11px] font-mono tracking-[0.12em] uppercase opacity-70">
              recommended
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={onQuick}
          disabled={disabled}
          className="btn-quiet text-[13px]"
        >
          Quick claim {amount} {symbol} (less private)
        </button>
      </div>
      <p className="mt-4 text-[11.5px] font-mono tracking-[0.1em] uppercase text-dim leading-relaxed">
        Quick claim is publicly traceable shadow → wallet. Use only if
        you can&apos;t spare the setup cost right now.
      </p>
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
