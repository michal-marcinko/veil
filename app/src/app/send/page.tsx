"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { VeilLogo } from "@/components/VeilLogo";
import { GiftShareCard } from "./_components/GiftShareCard";
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
 * /send — gift creation form.
 *
 * Editorial Ledger surface for the SENDER side. Single-column form on the
 * left, live preview of the gift card on the right (fades in as the user
 * fills the form). On submit:
 *
 *   1. ensureRegistered(sender)  — Umbra registration of the sender if
 *      they haven't done it before. Skipped if already registered.
 *   2. createGift(...)           — funds the shadow, deposits into its
 *      encrypted balance, returns the share URL.
 *   3. Replace the form with the GiftShareCard (success state).
 *
 * Insufficient-SOL handling: we read the wallet balance against
 * GIFT_FUNDING_LAMPORTS + the gift amount (when SOL) BEFORE creating the
 * shadow, so a sender with not enough SOL gets a clear error rather than
 * a half-funded zombie shadow.
 */
export default function SendGiftPage() {
  const wallet = useWallet();
  const { connection } = useConnection();

  const [amount, setAmount] = useState("");
  const [message, setMessage] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [senderName, setSenderName] = useState("");

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
  const messageOver = message.length > GIFT_MESSAGE_MAX_CHARS;
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
        message: message.trim() || undefined,
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
    setError(null);
  }

  return (
    <Shell>
      {result ? (
        <div className="reveal">
          <span className="eyebrow">Gift sent</span>
          <h1 className="mt-3 font-sans font-medium text-ink text-[40px] md:text-[52px] leading-[1.03] tracking-[-0.025em]">
            One gift, ready to hand over.
          </h1>
          <p className="mt-5 max-w-[640px] text-[16px] text-ink/75 leading-relaxed">
            The gift is funded on-chain. The recipient claims by opening the
            link below — they don&apos;t need a Veil account, just a Solana
            wallet.
          </p>

          <div className="mt-14">
            <GiftShareCard
              giftUrl={result.giftUrl}
              amountDisplay={result.metadata.amount}
              symbol={result.metadata.symbol}
              message={result.metadata.message}
              senderName={result.metadata.sender}
              recipientName={result.metadata.recipientName}
              onReset={handleReset}
            />
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-start">
          {/* Form column. */}
          <form
            onSubmit={handleSubmit}
            className="col-span-1 lg:col-span-7 reveal"
          >
            <span className="eyebrow">Send a gift</span>
            <h1 className="mt-3 font-sans font-medium text-ink text-[40px] md:text-[52px] leading-[1.03] tracking-[-0.025em]">
              Wrap some SOL.
              <br />
              <span className="text-muted">
                Hand it to anyone with a wallet.
              </span>
            </h1>
            <p className="mt-5 max-w-[560px] text-[15.5px] text-ink/75 leading-relaxed">
              Funds sit in a one-time-use private account until they&apos;re
              claimed. The recipient connects any Solana wallet — no Veil
              registration needed on their side.
            </p>

            <fieldset className="mt-12 space-y-7" disabled={busy}>
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
                hint="Optional. Shown on the gift card the recipient sees."
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

              <Field label="From" hint="Optional. Shown as the gift's sender.">
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
                Setting up a one-time gift link costs ~{GIFT_FUNDING_SOL} SOL
                in rent + tx fees. The recipient pays nothing.
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
                        {busyLabel(step)}
                      </span>
                    ) : (
                      <span>
                        Generate gift link <span aria-hidden>→</span>
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
                muted={!amountValid}
              />
            </div>
          </aside>
        </div>
      )}
    </Shell>
  );
}

function busyLabel(step: "compose" | "registering" | "funding" | "depositing" | "done"): string {
  switch (step) {
    case "registering":
      return "Setting up your account…";
    case "funding":
      return "Funding the gift link…";
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
 * Subdued live preview of the gift card. Distinct from GiftShareCard:
 *
 *   - The full GiftShareCard is the "post-send share artifact" — it has the
 *     copy/share controls and the success framing.
 *   - This is a "what the recipient sees" preview, with no controls and a
 *     dimmed treatment until the form is valid. Same visual language so
 *     senders aren't surprised by what they're sharing.
 */
function PreviewCard({
  amountDisplay,
  symbol,
  message,
  senderName,
  recipientName,
  muted,
}: {
  amountDisplay: string;
  symbol: string;
  message: string;
  senderName: string;
  recipientName: string;
  muted: boolean;
}) {
  return (
    <div
      className={`relative bg-paper-3 border border-line rounded-[4px] px-7 md:px-9 py-9 transition-opacity ${
        muted ? "opacity-50" : "opacity-100"
      }`}
    >
      <div className="absolute left-0 top-0 h-1 w-full bg-gold/80" />

      <span className="eyebrow">A gift</span>
      {recipientName && (
        <p className="mt-3 text-[13px] text-muted">
          For <span className="text-ink font-medium">{recipientName}</span>
        </p>
      )}

      <div className="mt-5 flex items-baseline gap-2.5">
        <span className="font-display font-medium text-gold text-[44px] md:text-[56px] leading-[0.95] tracking-[-0.025em]">
          {amountDisplay}
        </span>
        <span className="font-mono text-[12px] tracking-[0.1em] uppercase text-muted">
          {symbol}
        </span>
      </div>

      {message && (
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
          Veil · private gift
        </span>
      </div>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen relative pb-32">
      <nav className="sticky top-0 z-10 backdrop-blur-sm bg-paper/80 border-b border-line">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between px-6 md:px-8 py-4">
          <VeilLogo />
          <div className="flex items-center gap-1 md:gap-2">
            <Link
              href="/create"
              prefetch
              className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors"
            >
              Create
            </Link>
            <Link
              href="/dashboard"
              prefetch
              className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors"
            >
              Activity
            </Link>
            <div className="ml-2">
              <ClientWalletMultiButton />
            </div>
          </div>
        </div>
      </nav>

      <section className="max-w-[1400px] mx-auto px-6 md:px-8 pt-16 md:pt-20">
        {children}
      </section>
    </main>
  );
}
