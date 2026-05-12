"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { GiftShareCard } from "@/app/send/_components/GiftShareCard";
import { parseAmountToBaseUnits } from "@/lib/csv";
import {
  PAYMENT_DECIMALS,
  PAYMENT_SYMBOL,
  USDC_MINT,
} from "@/lib/constants";
import {
  createGift,
  GIFT_FUNDING_LAMPORTS,
  GIFT_FUNDING_SOL,
  GIFT_MESSAGE_MAX_CHARS,
  type CreateGiftResult,
} from "@/lib/gift-cards";
import { ensureRegistered, getOrCreateClient } from "@/lib/umbra";

/**
 * SendGiftFlow — the pure body of the private-transfer surface,
 * hoisted out of `app/src/app/send/page.tsx` so /create can embed the
 * exact same form inline (like Invoice and Payroll do).
 *
 * Two tones inside the same flow:
 *   - "Private transfer" (default): bare amount + optional names, no
 *     message, sober share card. The primary use case — paying a
 *     contractor / refunding a customer / paying someone who hasn't
 *     onboarded to Veil yet.
 *   - "Send as a gift" (opt-in toggle): adds a message field, swaps
 *     the preview + success card to the celebratory gift treatment
 *     (gold rule, italic Boska blockquote, "A gift" eyebrow).
 *
 * The underlying mechanism (`createGift()`, shadow keypair, deposit
 * into encrypted balance) is identical for both. Only the metadata +
 * visual treatment differ — the gift framing is now one MODE of the
 * primitive, not the only framing.
 *
 * Design contract:
 *   - Returns ONLY the column/grid content. No <main>, <Shell>, nav, or
 *     max-width wrapper — the caller provides the surrounding chrome.
 *   - All state is internal; unmounting the component resets it (which
 *     is what lets /create's chevron-back "discard and pick a different
 *     mode" feel correct).
 *   - "Back to activity" link inside the CTA row is preserved because
 *     senders sometimes want to bail to the dashboard mid-compose.
 */
export function SendGiftFlow() {
  const wallet = useWallet();
  const { connection } = useConnection();

  const [amount, setAmount] = useState("");
  const [message, setMessage] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [senderName, setSenderName] = useState("");
  // Default off: "Private transfer" is the primary primitive; gift is
  // an opt-in framing. Flipping the toggle reveals the message field
  // and switches preview + success card to the celebratory treatment.
  const [isGift, setIsGift] = useState(false);

  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<"compose" | "registering" | "funding" | "depositing" | "done">(
    "compose",
  );
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateGiftResult | null>(null);

  const amountBaseUnits = useMemo(
    () => parseAmountToBaseUnits(amount, PAYMENT_DECIMALS),
    [amount],
  );
  const amountValid = amountBaseUnits !== null && amountBaseUnits > 0n;
  // Message length only matters in gift mode (transfer mode hides the
  // field entirely). Guard the check so a stale message from a
  // toggle-flip doesn't block submission.
  const messageOver = isGift && message.length > GIFT_MESSAGE_MAX_CHARS;
  const canSubmit = wallet.connected && amountValid && !busy && !messageOver;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || amountBaseUnits === null) return;
    if (!wallet.publicKey) return;

    setError(null);
    setBusy(true);
    try {
      // Pre-check: does the sender have enough SOL? Funding the shadow is
      // 0.01 SOL; if the gift IS SOL, the deposit also needs that many
      // lamports in the sender's wallet. Surface this BEFORE we generate
      // a shadow so a half-funded ghost account isn't left on chain.
      const balance = await connection.getBalance(wallet.publicKey);
      const isSolGift = USDC_MINT.toBase58() === "So11111111111111111111111111111111111111112";
      const needed = Number(GIFT_FUNDING_LAMPORTS) + (isSolGift ? Number(amountBaseUnits) : 0);
      if (balance < needed) {
        const needSol = (needed / 1e9).toFixed(3);
        const haveSol = (balance / 1e9).toFixed(3);
        throw new Error(
          `Not enough SOL. You need ${needSol} SOL (${GIFT_FUNDING_SOL} for the gift link setup${
            isSolGift ? ` + ${amount} for the gift itself` : ""
          }). Your wallet has ${haveSol} SOL.`,
        );
      }

      // ensureRegistered will pop the sender's Phantom 0-3 times depending
      // on how much of the registration ceremony they've already completed.
      // First-time senders see all three; returning senders see none.
      setStep("registering");
      const senderClient = await getOrCreateClient(wallet as any);
      await ensureRegistered(senderClient);

      setStep("funding");
      const r = await createGift({
        payerWallet: wallet,
        payerClient: senderClient,
        connection,
        amount: amountBaseUnits,
        mint: USDC_MINT.toBase58(),
        amountDisplay: amount,
        symbol: PAYMENT_SYMBOL,
        // Only persist the message when the sender opted into gift
        // framing — otherwise the recipient claim page would show a
        // gift-styled card the sender didn't ask for.
        message: isGift ? message.trim() || undefined : undefined,
        senderName: senderName.trim() || undefined,
        recipientName: recipientName.trim() || undefined,
      });
      setStep("done");
      setResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep("compose");
    } finally {
      setBusy(false);
    }
  }

  function handleReset() {
    setResult(null);
    setStep("compose");
    setAmount("");
    setMessage("");
    setRecipientName("");
    setSenderName("");
    setIsGift(false);
    setError(null);
  }

  if (result) {
    return (
      <div className="reveal">
        <span className="eyebrow">{isGift ? "Gift sent" : "Transfer ready"}</span>
        <h1 className="mt-3 font-sans font-medium text-ink text-[40px] md:text-[52px] leading-[1.03] tracking-[-0.025em]">
          {isGift
            ? "One gift, ready to hand over."
            : "One transfer, ready to send."}
        </h1>
        <p className="mt-5 max-w-[640px] text-[16px] text-ink/75 leading-relaxed">
          {isGift
            ? "The gift is funded on-chain. The recipient claims by opening the link below — they don’t need a Veil account, just a Solana wallet."
            : "The funds are sitting in a one-time-use private account. Send the link below — the recipient claims with any Solana wallet, no Veil registration."}
        </p>

        <div className="mt-14">
          <GiftShareCard
            giftUrl={result.giftUrl}
            amountDisplay={result.metadata.amount}
            symbol={result.metadata.symbol}
            message={result.metadata.message}
            senderName={result.metadata.sender}
            recipientName={result.metadata.recipientName}
            tone={isGift ? "gift" : "transfer"}
            onReset={handleReset}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-start">
      {/* Form column. */}
      <form
        onSubmit={handleSubmit}
        className="col-span-1 lg:col-span-7 reveal"
      >
        <span className="eyebrow">{isGift ? "Send a gift" : "Private transfer"}</span>
        <h1 className="mt-3 font-sans font-medium text-ink text-[40px] md:text-[52px] leading-[1.03] tracking-[-0.025em]">
          {isGift ? (
            <>
              Wrap some SOL.
              <br />
              <span className="text-muted">Hand it to anyone with a wallet.</span>
            </>
          ) : (
            <>
              Send privately.
              <br />
              <span className="text-muted">To anyone with a wallet.</span>
            </>
          )}
        </h1>
        <p className="mt-5 max-w-[560px] text-[15.5px] text-ink/75 leading-relaxed">
          Funds sit in a one-time-use private account until they&apos;re
          claimed. The recipient connects any Solana wallet — no Veil
          registration needed on their side.
        </p>

        {/* Tone toggle. Default is "Private transfer" (sober) — the
            primary use case is paying contractors / refunding customers
            / sending to someone who hasn't onboarded yet. Flipping the
            toggle reveals the message field and switches preview +
            success card to the celebratory gift treatment. */}
        <div className="mt-10">
          <GiftToneToggle isGift={isGift} onChange={setIsGift} disabled={busy} />
        </div>

        <fieldset className="mt-10 space-y-7" disabled={busy}>
          <Field
            label="Amount"
            hint={`In ${PAYMENT_SYMBOL}. The recipient sees exactly this number.`}
          >
            <div className="flex items-baseline gap-3">
              <input
                type="text"
                inputMode="decimal"
                placeholder="0.50"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="input-editorial flex-1 font-display text-[28px] py-3"
                aria-invalid={amount.length > 0 && !amountValid}
              />
              <span className="font-mono text-[12px] tracking-[0.12em] uppercase text-muted">
                {PAYMENT_SYMBOL}
              </span>
            </div>
            {amount.length > 0 && !amountValid && (
              <p className="mt-2 text-[12.5px] text-brick/90">
                Enter a positive amount with up to {PAYMENT_DECIMALS}{" "}
                decimal places.
              </p>
            )}
          </Field>

          <Field
            label="To"
            hint={
              isGift
                ? "Optional. Shown on the gift card the recipient sees."
                : "Optional. Shown on the transfer card the recipient sees."
            }
          >
            <input
              type="text"
              placeholder="Sarah"
              value={recipientName}
              onChange={(e) => setRecipientName(e.target.value)}
              className="input-editorial"
              maxLength={64}
            />
          </Field>

          {/* Message field is gift-mode only. Transfer mode skips this
              entirely so the form reads as 3 fields not 4 (lower
              cognitive load when you're "just sending money"). The
              message-state value is preserved across toggle flips so
              re-enabling gift mode restores what the sender wrote. */}
          {isGift && (
            <Field
              label="Message"
              hint={`Optional. Up to ${GIFT_MESSAGE_MAX_CHARS} characters.`}
            >
              <textarea
                rows={3}
                placeholder="Happy birthday — go pick something nice."
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                className="input-editorial"
                maxLength={GIFT_MESSAGE_MAX_CHARS + 50}
              />
              <div className="mt-2 flex justify-between text-[12px] text-dim">
                <span>
                  {messageOver ? (
                    <span className="text-brick">
                      {message.length} / {GIFT_MESSAGE_MAX_CHARS} — trim
                      before sending
                    </span>
                  ) : (
                    <span>
                      {message.length} / {GIFT_MESSAGE_MAX_CHARS}
                    </span>
                  )}
                </span>
              </div>
            </Field>
          )}

          <Field
            label="From"
            hint={
              isGift
                ? "Optional. Shown as the gift's sender."
                : "Optional. Shown as the sender on the transfer."
            }
          >
            <input
              type="text"
              placeholder="Alice"
              value={senderName}
              onChange={(e) => setSenderName(e.target.value)}
              className="input-editorial"
              maxLength={64}
            />
          </Field>
        </fieldset>

        <div className="mt-12 border-t border-line pt-8">
          <p className="text-[13px] text-muted leading-relaxed max-w-[520px]">
            Setting up a one-time {isGift ? "gift" : "transfer"} link costs
            ~{GIFT_FUNDING_SOL} SOL in rent + tx fees. The recipient pays
            nothing.
          </p>

          <div className="mt-7 flex items-center gap-5">
            {wallet.connected ? (
              <button
                type="submit"
                disabled={!canSubmit}
                className="btn-primary"
              >
                {busy ? (
                  <span className="inline-flex items-center gap-3">
                    <span className="h-1.5 w-1.5 rounded-full bg-paper animate-slow-pulse" />
                    {busyLabel(step, isGift)}
                  </span>
                ) : (
                  <span>
                    {isGift ? "Generate gift link" : "Generate transfer link"}{" "}
                    <span aria-hidden>→</span>
                  </span>
                )}
              </button>
            ) : (
              <ClientWalletMultiButton />
            )}
            <Link
              href="/dashboard"
              prefetch
              className="text-[13.5px] text-muted hover:text-ink underline-offset-4 hover:underline transition-colors"
            >
              Back to activity
            </Link>
          </div>

          {error && (
            <div className="mt-7 flex items-start gap-4 border-l-2 border-brick pl-5 py-3">
              <span className="mono-chip text-brick shrink-0 pt-0.5">
                Error
              </span>
              <span className="text-[13.5px] text-ink leading-relaxed">
                {error}
              </span>
            </div>
          )}
        </div>
      </form>

      {/* Live preview column. */}
      <aside
        className="col-span-1 lg:col-span-5 reveal"
        style={{ animationDelay: "120ms" }}
      >
        <span className="eyebrow">Preview</span>
        <p className="mt-3 text-[13.5px] text-muted leading-relaxed">
          What the recipient will see when they open the link.
        </p>
        <div className="mt-6">
          <PreviewCard
            amountDisplay={amount || "0.00"}
            symbol={PAYMENT_SYMBOL}
            message={message}
            senderName={senderName}
            recipientName={recipientName}
            isGift={isGift}
            muted={!amountValid}
          />
        </div>
      </aside>
    </div>
  );
}

/**
 * GiftToneToggle — sleek inline switch between transfer (default) and
 * gift modes. Sliding-thumb pill so the choice reads as a *mode*
 * rather than a checkbox.
 *
 * Layout note (the v1 had a bug here): the thumb is positioned with
 * `w-[calc(50%-0.25rem)]` which only lines up correctly when the two
 * labels render at equal width. Auto-sized buttons make
 * "Transfer" (~80px) and a long second label drift apart, so the
 * thumb sits under one-and-a-bit labels instead of one cleanly. Fix
 * is two-fold:
 *   1. Use `grid grid-cols-2` on the container so each button cell
 *      gets exactly 50% regardless of text length.
 *   2. Use a short, parallel label pair ("Transfer" / "Gift") so the
 *      visible text doesn't strain the cell — the cells could absorb
 *      a long label, but the readability is better with a balanced
 *      pair.
 *
 * Active label flips to `text-paper` so it reads on the ink thumb;
 * inactive fades to ink/55 with a hover lift. 240ms ease-out on the
 * thumb pairs with the message field's mount/unmount underneath so
 * the form feels like it physically swings into a new mode.
 */
function GiftToneToggle({
  isGift,
  onChange,
  disabled,
}: {
  isGift: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="tablist"
      aria-label="Transfer tone"
      className={[
        "relative grid grid-cols-2 items-stretch",
        "rounded-full border border-line bg-paper-3/60",
        "p-1 select-none w-fit",
        disabled ? "opacity-50 pointer-events-none" : "",
      ].join(" ")}
    >
      {/* Sliding thumb — exactly one cell wide. translate-x-full now
          equals one full thumb width because the grid forces both
          cells to identical sizing. No more 50%-vs-button-width
          mismatch. */}
      <span
        aria-hidden
        className={[
          "absolute top-1 bottom-1 left-1 w-[calc(50%-0.25rem)]",
          "rounded-full bg-ink",
          "transition-transform duration-[240ms] ease-out",
          isGift ? "translate-x-full" : "translate-x-0",
        ].join(" ")}
      />
      <button
        type="button"
        role="tab"
        aria-selected={!isGift}
        onClick={() => onChange(false)}
        className={[
          "relative z-[1] px-7 py-1.5 text-center",
          "font-mono text-[10.5px] tracking-[0.16em] uppercase",
          "transition-colors duration-200",
          !isGift ? "text-paper" : "text-ink/55 hover:text-ink",
        ].join(" ")}
      >
        Transfer
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={isGift}
        onClick={() => onChange(true)}
        className={[
          "relative z-[1] px-7 py-1.5 text-center",
          "font-mono text-[10.5px] tracking-[0.16em] uppercase",
          "transition-colors duration-200",
          isGift ? "text-paper" : "text-ink/55 hover:text-ink",
        ].join(" ")}
      >
        Gift
      </button>
    </div>
  );
}

function busyLabel(
  step: "compose" | "registering" | "funding" | "depositing" | "done",
  isGift: boolean,
): string {
  switch (step) {
    case "registering":
      return "Setting up your account…";
    case "funding":
      return isGift ? "Funding the gift link…" : "Funding the transfer link…";
    case "depositing":
      return "Depositing privately…";
    case "done":
      return "Done";
    default:
      return "Working…";
  }
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="eyebrow">{label}</span>
      {hint && (
        <span className="block mt-1.5 text-[12.5px] text-dim leading-relaxed">
          {hint}
        </span>
      )}
      <div className="mt-3">{children}</div>
    </label>
  );
}

/**
 * Subdued live preview of the recipient-facing card. Distinct from
 * GiftShareCard:
 *
 *   - The full GiftShareCard is the "post-send share artifact" — it has the
 *     copy/share controls and the success framing.
 *   - This is a "what the recipient sees" preview, with no controls and a
 *     dimmed treatment until the form is valid. Same visual language so
 *     senders aren't surprised by what they're sharing.
 *
 * Two tones tracked from the parent toggle:
 *   - isGift=false (default): no gold rule, "Private transfer" eyebrow,
 *     ink-coloured display amount, no message blockquote, "Veil · private
 *     transfer" footer. Sober.
 *   - isGift=true: gold rule, "A gift" eyebrow, gold display amount,
 *     italic Boska blockquote for the message, "Veil · private gift"
 *     footer. Celebratory.
 */
function PreviewCard({
  amountDisplay,
  symbol,
  message,
  senderName,
  recipientName,
  isGift,
  muted,
}: {
  amountDisplay: string;
  symbol: string;
  message: string;
  senderName: string;
  recipientName: string;
  isGift: boolean;
  muted: boolean;
}) {
  return (
    <div
      className={`relative bg-paper-3 border border-line rounded-[4px] px-7 md:px-9 py-9 transition-opacity ${
        muted ? "opacity-50" : "opacity-100"
      }`}
    >
      {isGift && <div className="absolute left-0 top-0 h-1 w-full bg-gold/80" />}

      <span className="eyebrow">{isGift ? "A gift" : "Private transfer"}</span>
      {recipientName && (
        <p className="mt-3 text-[13px] text-muted">
          {isGift ? "For" : "To"}{" "}
          <span className="text-ink font-medium">{recipientName}</span>
        </p>
      )}

      <div className="mt-5 flex items-baseline gap-2.5">
        <span
          className={[
            "font-display font-medium text-[44px] md:text-[56px] leading-[0.95] tracking-[-0.025em]",
            isGift ? "text-gold" : "text-ink",
          ].join(" ")}
        >
          {amountDisplay}
        </span>
        <span className="font-mono text-[12px] tracking-[0.1em] uppercase text-muted">
          {symbol}
        </span>
      </div>

      {isGift && message && (
        <blockquote className="mt-7 font-display italic text-ink text-[16px] md:text-[18px] leading-[1.4]">
          <span aria-hidden className="text-muted mr-1">&ldquo;</span>
          {message}
          <span aria-hidden className="text-muted ml-1">&rdquo;</span>
        </blockquote>
      )}

      {senderName && (
        <p className="mt-7 text-[12px] text-muted">
          From <span className="text-ink font-medium">{senderName}</span>
        </p>
      )}

      <div className="mt-9 pt-5 border-t border-line/70">
        <span className="font-mono text-[10px] tracking-[0.16em] uppercase text-dim">
          {isGift ? "Veil · private gift" : "Veil · private transfer"}
        </span>
      </div>
    </div>
  );
}
