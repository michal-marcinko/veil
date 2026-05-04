"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { QRCodeSVG } from "qrcode.react";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { ProductFrame } from "@/app/products/_components/ProductFrame";
import {
  RegistrationModal,
  type RegistrationStep,
  type StepStatus,
} from "@/components/RegistrationModal";
import {
  PaymentProgressModal,
  type PayStep,
  type PayStepStatus,
} from "@/components/PaymentProgressModal";
import {
  fetchProductSpec,
  formatProductAmount,
  type ProductSpec,
} from "@/lib/products";
import {
  getOrCreateClient,
  ensureRegistered,
  ensureReceiverKeyAligned,
  payInvoice,
  __veilResetPopupCounter,
  __veilPopupCountSnapshot,
} from "@/lib/umbra";

/**
 * /buy/<arweaveTxId> — customer-facing checkout for a Stripe-style
 * product link.
 *
 * Flow:
 *   1. Resolve `arweaveTxId` → fetch product spec from Arweave.
 *   2. Render product details + a Buy button.
 *   3. On Buy: connect wallet (if not), ensure they're registered with
 *      Umbra, then call `payInvoice` targeting `spec.ownerWallet`. The
 *      VeilPay CPI single-popup path applies the same as for invoices.
 *   4. Show success state.
 *
 * Edge cases handled:
 *   - Bad / non-existent Arweave id → readable error.
 *   - Spec validation failure (someone uploaded random bytes to /buy/<id>)
 *     → readable error explaining the link is malformed.
 *   - Self-buy: if the connected wallet IS the owner, show a friendly
 *     "this is your own product" message rather than letting them pay
 *     themselves.
 *
 * Out of scope for v1 (mentioned in the brief):
 *   - Signed receipt URL — we'd need a synthetic invoice id derived from
 *     the product txId. Skipping; the merchant's dashboard reflects the
 *     incoming UTXO within ~30s anyway.
 *   - Optional-data binding so the merchant can match a UTXO to a
 *     product. Future work.
 */
export default function BuyPage({
  params,
}: {
  params: { arweaveTxId: string };
}) {
  const wallet = useWallet();

  const [spec, setSpec] = useState<ProductSpec | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [paid, setPaid] = useState(false);
  const [showQr, setShowQr] = useState(false);

  const [regOpen, setRegOpen] = useState(false);
  const [regSteps, setRegSteps] = useState<Record<RegistrationStep, StepStatus>>({
    init: "pending",
    x25519: "pending",
    commitment: "pending",
  });
  const [payOpen, setPayOpen] = useState(false);
  const [payProgress, setPayProgress] = useState<Record<PayStep, PayStepStatus>>({
    build: "pending",
    "sign-proof": "pending",
    "sign-deposit": "pending",
    confirm: "pending",
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoadError(null);
        const fetched = await fetchProductSpec(params.arweaveTxId);
        if (!cancelled) setSpec(fetched);
      } catch (err: any) {
        if (!cancelled) {
          setLoadError(
            err?.message ??
              "Couldn't load this product. The link may be malformed.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params.arweaveTxId]);

  async function handleBuy() {
    if (!spec || !wallet.publicKey) return;
    setPayError(null);
    setPaying(true);
    __veilResetPopupCounter();

    try {
      const client = await getOrCreateClient(wallet as any);

      // The customer needs to be a registered Umbra user before we can
      // route a UTXO to them OR send one from their public balance. The
      // SDK's payInvoice covers both flows; we just need ensureRegistered
      // to have run for the SIGNER. (The merchant's registration is
      // independently required at claim time, not at deposit time.)
      setRegOpen(true);
      await ensureRegistered(client, (step, status) => {
        setRegSteps((prev) => ({
          ...prev,
          [step]: status === "pre" ? "in_progress" : "done",
        }));
      });
      await ensureReceiverKeyAligned(client);
      setRegOpen(false);

      setPayProgress({
        build: "in_progress",
        "sign-proof": "pending",
        "sign-deposit": "pending",
        confirm: "pending",
      });
      setPayOpen(true);

      const ticker = window.setInterval(() => {
        const snap = __veilPopupCountSnapshot();
        if (snap.count === 0) return;
        if (snap.count === 1) {
          setPayProgress((p) =>
            p["sign-proof"] === "pending"
              ? { ...p, build: "done", "sign-proof": "in_progress" }
              : p,
          );
        } else if (snap.count === 2) {
          setPayProgress((p) =>
            p["sign-deposit"] === "pending"
              ? {
                  ...p,
                  build: "done",
                  "sign-proof": "done",
                  "sign-deposit": "in_progress",
                }
              : p,
          );
        }
      }, 200);

      try {
        await payInvoice({
          client,
          recipientAddress: spec.ownerWallet,
          mint: spec.mint,
          amount: BigInt(spec.amountBaseUnits),
        });
      } finally {
        window.clearInterval(ticker);
      }

      setPayProgress({
        build: "done",
        "sign-proof": "done",
        "sign-deposit": "done",
        confirm: "done",
      });
      setPaid(true);
      window.setTimeout(() => setPayOpen(false), 1200);
    } catch (err: any) {
      setPayError(err?.message ?? String(err));
      setRegOpen(false);
      setPayOpen(false);
    } finally {
      setPaying(false);
    }
  }

  const isOwner =
    !!spec && !!wallet.publicKey && wallet.publicKey.toBase58() === spec.ownerWallet;

  const customerUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/buy/${params.arweaveTxId}`
      : `/buy/${params.arweaveTxId}`;

  if (loadError) {
    return (
      <ProductFrame>
        <section className="max-w-[1400px] mx-auto px-6 md:px-8 pt-20">
          <div className="max-w-xl mx-auto">
            <span className="eyebrow text-brick">Error</span>
            <h1 className="mt-4 font-display font-medium text-ink text-[36px] leading-[1.05] tracking-[-0.02em]">
              We couldn&apos;t load this product.
            </h1>
            <p className="mt-4 text-[14.5px] text-ink/80 leading-relaxed">
              {loadError}
            </p>
            <p className="mt-3 text-[12.5px] text-muted leading-relaxed font-mono break-all">
              id: {params.arweaveTxId}
            </p>
          </div>
        </section>
      </ProductFrame>
    );
  }

  if (!spec) {
    return (
      <ProductFrame>
        <section className="max-w-[1400px] mx-auto px-6 md:px-8 pt-20">
          <div className="max-w-xl mx-auto">
            <p className="text-[13.5px] text-muted">Loading product…</p>
          </div>
        </section>
      </ProductFrame>
    );
  }

  return (
    <ProductFrame>
      <section className="max-w-[1400px] mx-auto px-6 md:px-8 pt-16 md:pt-20 pb-16">
        <div className="max-w-2xl mx-auto">
          {paid ? (
            <PaidState
              spec={spec}
              amountDisplay={`${formatProductAmount(spec.amountBaseUnits, spec.decimals)} ${spec.symbol}`}
            />
          ) : (
            <>
              <header>
                <span className="eyebrow">Private payment</span>
                <h1 className="mt-4 font-display font-medium text-ink text-[44px] md:text-[56px] leading-[1.02] tracking-[-0.02em]">
                  {spec.name}
                </h1>
                {spec.description && (
                  <p className="mt-5 text-[15px] text-ink/80 leading-[1.6] whitespace-pre-wrap">
                    {spec.description}
                  </p>
                )}
              </header>

              {spec.imageUrl && (
                <div className="mt-8 border border-line rounded-[3px] overflow-hidden bg-paper-3/40">
                  {/*
                    eslint-disable-next-line @next/next/no-img-element
                    Linking to merchant-supplied images intentionally — we
                    don't host them. next/image would proxy through our
                    server, defeating the "not our content" property.
                  */}
                  <img
                    src={spec.imageUrl}
                    alt={spec.name}
                    className="w-full h-auto max-h-[420px] object-cover"
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.display = "none";
                    }}
                  />
                </div>
              )}

              <div className="mt-10 grid grid-cols-1 md:grid-cols-2 gap-8 items-start">
                <div>
                  <span className="eyebrow">Price</span>
                  <div className="mt-2 font-sans font-medium text-ink text-[36px] md:text-[44px] leading-[1.05] tracking-[-0.025em] tnum">
                    {formatProductAmount(spec.amountBaseUnits, spec.decimals)}{" "}
                    <span className="text-muted text-[24px] md:text-[28px]">
                      {spec.symbol}
                    </span>
                  </div>
                </div>
                <div>
                  <span className="eyebrow">Recipient</span>
                  <div className="mt-2 font-mono text-[12px] text-muted break-all leading-relaxed">
                    {spec.ownerWallet}
                  </div>
                  <p className="mt-2 text-[12px] text-muted leading-relaxed">
                    Funds settle privately via Umbra. The amount and recipient
                    don&apos;t appear on the public ledger.
                  </p>
                </div>
              </div>

              <div className="mt-10">
                {!wallet.connected ? (
                  <div>
                    <p className="text-[14px] text-ink/80 leading-relaxed mb-4">
                      Connect your wallet to pay.
                    </p>
                    <ClientWalletMultiButton />
                  </div>
                ) : isOwner ? (
                  <div className="border-l-2 border-line-2 pl-4 py-3">
                    <p className="text-[13.5px] text-ink/80 leading-relaxed">
                      This is your own product — connect a different wallet to
                      simulate a customer purchase, or share the URL with one.
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-4">
                    <button
                      type="button"
                      onClick={handleBuy}
                      disabled={paying}
                      className="btn-primary md:min-w-[280px]"
                    >
                      {paying ? (
                        <span className="inline-flex items-center gap-3">
                          <span className="h-1.5 w-1.5 rounded-full bg-paper animate-slow-pulse" />
                          Processing…
                        </span>
                      ) : (
                        <span>
                          Pay {formatProductAmount(spec.amountBaseUnits, spec.decimals)}{" "}
                          {spec.symbol} <span aria-hidden>→</span>
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowQr((v) => !v)}
                      className="btn-quiet"
                    >
                      {showQr ? "Hide QR" : "Show QR"}
                    </button>
                  </div>
                )}

                {showQr && (
                  <div className="mt-6 inline-flex flex-col items-center p-5 border border-line rounded-[3px] bg-paper-3/30">
                    <QRCodeSVG
                      value={customerUrl}
                      size={196}
                      bgColor="transparent"
                      fgColor="#1c1712"
                      level="M"
                      marginSize={0}
                    />
                    <p className="mt-3 text-[11px] font-mono tracking-[0.08em] uppercase text-muted">
                      Scan to open this page
                    </p>
                  </div>
                )}

                {payError && (
                  <div className="mt-5 border-l-2 border-brick pl-4 py-2 text-[13.5px] text-ink leading-relaxed">
                    {payError}
                  </div>
                )}
              </div>

              <RegistrationModal open={regOpen} steps={regSteps} />
              <PaymentProgressModal
                open={payOpen}
                steps={payProgress}
                amountLabel={`${formatProductAmount(spec.amountBaseUnits, spec.decimals)} ${spec.symbol}`}
                recipientLabel={spec.ownerWallet.slice(0, 8)}
                isShielded={false}
              />
            </>
          )}
        </div>
      </section>
    </ProductFrame>
  );
}

function PaidState({
  spec,
  amountDisplay,
}: {
  spec: ProductSpec;
  amountDisplay: string;
}) {
  return (
    <div className="space-y-8">
      <header>
        <span className="eyebrow text-sage">✓ Payment sent</span>
        <h1 className="mt-4 font-display font-medium text-ink text-[40px] md:text-[52px] leading-[1.02] tracking-[-0.02em]">
          Thanks — you&apos;re done.
        </h1>
        <p className="mt-4 text-[15px] leading-[1.6] text-ink/80 max-w-lg">
          Your private payment is on its way. The merchant will see it in their
          dashboard within ~30 seconds — no further action from you.
        </p>
      </header>

      <div className="border border-line rounded-[3px] p-5 bg-paper-3/40">
        <div className="flex items-baseline justify-between gap-4 flex-wrap">
          <div>
            <div className="text-[15.5px] text-ink font-medium leading-tight">
              {spec.name}
            </div>
            <div className="mt-1 font-mono text-[12px] tracking-[0.04em] text-muted tnum">
              {amountDisplay}
            </div>
          </div>
          <span className="mono-chip text-sage">paid</span>
        </div>
      </div>

      <p className="text-[12.5px] text-muted leading-relaxed max-w-md">
        Need a record? Save this page — your wallet&apos;s tx history shows the
        deposit, and the merchant&apos;s dashboard will show the matching
        incoming UTXO.
      </p>
    </div>
  );
}
