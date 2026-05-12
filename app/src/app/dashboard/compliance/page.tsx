"use client";

// ---------------------------------------------------------------------------
// /dashboard/compliance — generate a scoped auditor link.
//
// EDITORIAL-LEDGER REDESIGN (2026-05-04 v2).
//
// The prior page was a utility-form: bare date inputs, a giant mint
// textbox, plus a confusing "legacy on-chain grants" section that read
// as noise to non-technical operators. The redesign mirrors the rest of
// the app's editorial-ledger language:
//
//   1. Preset pill row at the top — tax years, recent quarters, last 30
//      / 90 days, all-time, custom — plus an inline mint pill.
//   2. A live transaction picker below — the same row layout, sticky
//      date headers, and "Earlier" collapse the activity page uses, but
//      with checkboxes so the operator can include / exclude rows on
//      top of the preset.
//   3. A live "Generate auditor link → N invoices · X.XX SOL" CTA.
//   4. Result state replaces the picker, with copy / mailto / QR.
//   5. The "what scoped means" copy is preserved as a default-collapsed
//      "How this works" expander below the action.
//
// FLOW (unchanged below the UI):
//   - Fetch all of Alice's invoices on-chain.
//   - Apply mint + (preset or custom) date scope client-side.
//   - Operator can deselect specific rows in the picker.
//   - One wallet sign popup (cached after first use) loads the metadata
//     master sig — used in-process only, never embedded in the URL.
//   - Re-encrypt selected invoices under a fresh ephemeral key K and
//     upload to Arweave (`generateScopedGrant` in auditor-links.ts).
//   - Build the URL: /audit/grant/<grantId>#k=<base58 K>&inv=<csv>.
//   - The link is the only credential.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { VeilLogo } from "@/components/VeilLogo";
import { InvoiceRow } from "@/components/InvoiceRow";
import {
  DateGroupHeader,
  bucketByCreatedAt,
  DATE_BUCKET_ORDER,
} from "@/components/DateGroupHeader";
import { fetchInvoicesByCreator } from "@/lib/anchor";
import {
  decryptJson,
  deriveKeyFromMasterSig,
  getOrCreateMetadataMasterSig,
} from "@/lib/encryption";
import { fetchCiphertext } from "@/lib/arweave";
import {
  buildScopedGrantUrl,
  generateScopedGrant,
  type InScopeInvoice,
} from "@/lib/auditor-links";
import type { InvoiceMetadata } from "@/lib/types";
import { USDC_MINT, PAYMENT_SYMBOL, PAYMENT_DECIMALS } from "@/lib/constants";
import {
  PresetPills,
  buildPresets,
  type PresetId,
  type MintOption,
} from "./_components/PresetPills";
import { GrantResultCard } from "./_components/GrantResultCard";
import {
  loadCachedPayrollRuns,
  type CachedPayrollRun,
} from "@/lib/payroll-runs-storage";
import {
  encodePayrollPacket,
  formatPayrollAmount,
} from "@/lib/private-payroll";

// ---------------------------------------------------------------------------
// Types — internal helpers carried through render.
// ---------------------------------------------------------------------------

interface InvoiceLabel {
  payer: string;
  description: string;
  amountStr: string;
  amountUnits: bigint; // raw smallest-unit, used for picker totals
  decimals: number;
  symbol: string;
}

interface PickerRow {
  pda: string;
  status: string;
  createdAt: number;
  mint: string;
  // Reference back to the on-chain account so we can pass it to
  // `generateScopedGrant` without a second fetch.
  raw: { metadataUri: string; metadataHash: Uint8Array };
}

interface GrantResult {
  url: string;
  invoiceCount: number;
  skippedCount: number;
  totalAmount: string;
  symbol: string;
  mintLabel: string;
}

// Payroll grant result. Each selected payroll batch becomes its own
// self-contained packet URL — they're not aggregable the way invoices
// are because each packet is a single signed artifact scoped to one
// batch.
interface PayrollGrantLink {
  batchId: string;
  url: string;
  recipientCount: number;
  totalAmount: string;
  symbol: string;
}

interface PayrollGrantResult {
  links: PayrollGrantLink[];
  mintLabel: string;
}

type ViewMode = "invoices" | "payroll";

// ---------------------------------------------------------------------------
// Page.
// ---------------------------------------------------------------------------

const RECENT_BUCKETS: ReadonlyArray<string> = ["Today", "Yesterday"];

export default function CompliancePage() {
  const wallet = useWallet();
  const router = useRouter();
  const searchParams = useSearchParams();

  // ?seed=<invoicePda> — pre-fills the picker with a single-row
  // selection on first mount. Wired from the row-overflow menu's
  // "Send compliance grant" action so the operator lands on a
  // ready-to-generate state instead of having to find the row.
  // Payroll-batch seeds are intentionally NOT supported today: the
  // compliance flow is invoice-scoped, and payroll runs don't have
  // associated Invoice PDAs. v2 wires per-run grants natively.
  const seedPda = searchParams?.get("seed") ?? null;

  // ?mode=payroll — landing in payroll mode from a payroll drill-in.
  // We honour this once on first render; user toggles afterwards.
  const seedMode = searchParams?.get("mode") ?? null;

  // Outgoing-transition state. The "← Activity" back link sets this
  // before pushing the next route so the current surface fades out
  // before /dashboard's `.reveal` animation paints the destination.
  // Effect: a continuous opacity hand-off rather than a hard cut.
  const [leaving, setLeaving] = useState(false);
  const handleBackToActivity = useCallback(() => {
    if (leaving) return; // double-click protection
    setLeaving(true);
    // 180ms matches the fade-out duration on the wrapper below — long
    // enough to read as a transition, short enough that the user
    // doesn't perceive a stall before the route swap.
    window.setTimeout(() => router.push("/dashboard"), 180);
  }, [leaving, router]);

  // Scope inputs — preset pills + mint dropdown.
  const [activePresetId, setActivePresetId] = useState<PresetId>("ytd");
  const [customFromDate, setCustomFromDate] = useState<string>("");
  const [customToDate, setCustomToDate] = useState<string>("");
  const [activeMint, setActiveMint] = useState<string>(USDC_MINT.toBase58());

  // View mode — invoices vs. payroll batches. Invoices keep their full
  // re-encryption + Arweave grant flow; payroll batches reuse the
  // self-contained signed-packet URL the publishing modal already
  // emits (no re-encryption needed; each packet is signed end-to-end).
  const [viewMode, setViewMode] = useState<ViewMode>(
    seedMode === "payroll" ? "payroll" : "invoices",
  );

  // Invoice fetch state.
  const [invoices, setInvoices] = useState<PickerRow[]>([]);
  const [labels, setLabels] = useState<Map<string, InvoiceLabel>>(new Map());
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Payroll-run state — hydrated from the local cache on connect.
  const [payrollRuns, setPayrollRuns] = useState<CachedPayrollRun[]>([]);
  const [selectedPayroll, setSelectedPayroll] = useState<Set<string>>(new Set());
  const [payrollResult, setPayrollResult] = useState<PayrollGrantResult | null>(null);

  // Selection state. We default to "all currently in-scope" — flipping
  // a preset pill resets selection to the new in-scope set so the
  // operator's mental model is "preset = my starting set, uncheck to
  // exclude".
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Tracks whether the `?seed=` pre-fill has fired. We only apply once
  // per page load: subsequent preset / mint changes use the normal
  // "select all in scope" reset behaviour.
  const [seedApplied, setSeedApplied] = useState(false);

  // Generation state.
  const [submitting, setSubmitting] = useState(false);
  const [progressMsg, setProgressMsg] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [grantResult, setGrantResult] = useState<GrantResult | null>(null);

  // ---------------- Fetch invoices on connect ----------------

  const refreshInvoices = useCallback(async () => {
    if (!wallet.publicKey) return;
    setFetching(true);
    setFetchError(null);
    try {
      const all = await fetchInvoicesByCreator(wallet as any, wallet.publicKey);
      const mapped: PickerRow[] = all
        .map((inv) => ({
          pda: inv.publicKey.toBase58(),
          status: Object.keys(inv.account.status)[0] ?? "pending",
          createdAt: Number(inv.account.createdAt),
          mint: inv.account.mint.toBase58(),
          raw: {
            metadataUri: inv.account.metadataUri,
            metadataHash: inv.account.metadataHash,
          },
        }))
        .sort((a, b) => {
          if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
          return a.pda < b.pda ? -1 : a.pda > b.pda ? 1 : 0;
        });
      setInvoices(mapped);

      // Best-effort metadata decrypt — same one-popup pattern as the
      // dashboard. Failures are silent; the row falls back to the
      // truncated PDA.
      void loadLabels(wallet, all).then((nextLabels) => setLabels(nextLabels));
    } catch (err: any) {
      setFetchError(`Couldn't load invoices: ${err.message ?? String(err)}`);
    } finally {
      setFetching(false);
    }
  }, [wallet]);

  useEffect(() => {
    if (wallet.connected) void refreshInvoices();
  }, [wallet.connected, refreshInvoices]);

  // Hydrate cached payroll runs whenever the wallet changes. Cheap
  // localStorage read — no network. We also subscribe to the storage
  // event so a payroll run signed in another tab shows up live.
  useEffect(() => {
    if (!wallet.publicKey) return;
    const walletBase58 = wallet.publicKey.toBase58();
    setPayrollRuns(loadCachedPayrollRuns(walletBase58));
    const onStorage = (e: StorageEvent) => {
      if (!e.key || e.key.includes(walletBase58)) {
        setPayrollRuns(loadCachedPayrollRuns(walletBase58));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [wallet.publicKey]);

  // ---------------- Compute current scope window ----------------

  const scopeWindow = useMemo(() => {
    if (activePresetId === "custom") {
      const fromTs = customFromDate
        ? Math.floor(Date.parse(`${customFromDate}T00:00:00Z`) / 1000)
        : null;
      const toTs = customToDate
        ? Math.floor(Date.parse(`${customToDate}T23:59:59Z`) / 1000)
        : null;
      return { fromTs, toTs };
    }
    const now = new Date();
    const presets = buildPresets(now);
    const found = presets.find((p) => p.id === activePresetId);
    if (!found) return { fromTs: null, toTs: null };
    return found.scope;
  }, [activePresetId, customFromDate, customToDate]);

  const inScopeRows = useMemo(() => {
    return invoices.filter((inv) => {
      if (activeMint && inv.mint !== activeMint) return false;
      if (scopeWindow.fromTs != null && inv.createdAt < scopeWindow.fromTs)
        return false;
      if (scopeWindow.toTs != null && inv.createdAt > scopeWindow.toTs)
        return false;
      return true;
    });
  }, [invoices, activeMint, scopeWindow]);

  // In-scope payroll runs — same mint + date semantics as invoices.
  // The packet's createdAt is an ISO string, so we parse to a unix
  // second for the bounds comparison.
  const inScopePayroll = useMemo(() => {
    return payrollRuns.filter((entry) => {
      const packet = entry.signed.packet;
      if (activeMint && packet.mint !== activeMint) return false;
      const createdSec = Math.floor(Date.parse(packet.createdAt) / 1000);
      if (Number.isNaN(createdSec)) return false;
      if (scopeWindow.fromTs != null && createdSec < scopeWindow.fromTs)
        return false;
      if (scopeWindow.toTs != null && createdSec > scopeWindow.toTs)
        return false;
      return true;
    });
  }, [payrollRuns, activeMint, scopeWindow]);

  // ---------------- Selection effect ----------------
  //
  // When the in-scope set changes (preset / mint / fetched data),
  // reset selection to "all in-scope". The user then unchecks rows to
  // exclude. This matches the natural mental model of "preset = my
  // starting set" and avoids a stale selection that no longer
  // intersects the visible rows.
  const inScopeKey = useMemo(
    () => inScopeRows.map((r) => r.pda).join(","),
    [inScopeRows],
  );
  useEffect(() => {
    // Seed pre-fill — runs ONCE after the invoices fetch lands and the
    // seed PDA is in the in-scope set. After this, normal "select all
    // in-scope" semantics apply for any further preset / mint changes.
    if (seedPda && !seedApplied && inScopeRows.length > 0) {
      const inScope = inScopeRows.find((r) => r.pda === seedPda);
      if (inScope) {
        setSelected(new Set([seedPda]));
        setSeedApplied(true);
        return;
      }
      // Seed not in current scope — could be a different mint or out
      // of the active preset window. Fall through to the default
      // "select all" behaviour and mark the seed handled so we don't
      // keep re-trying on every scope change.
      setSeedApplied(true);
    }
    setSelected(new Set(inScopeRows.map((r) => r.pda)));
  }, [inScopeKey, seedPda, seedApplied]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mirror the invoice "select all in scope" effect for payroll runs.
  // When the active mint / preset changes, reset the selection set to
  // "everything in the new scope" — same mental model as invoices.
  const inScopePayrollKey = useMemo(
    () => inScopePayroll.map((e) => e.signed.packet.batchId).join(","),
    [inScopePayroll],
  );
  useEffect(() => {
    setSelectedPayroll(
      new Set(inScopePayroll.map((e) => e.signed.packet.batchId)),
    );
  }, [inScopePayrollKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------- Selection helpers ----------------

  function toggleSelect(pda: string, next: boolean) {
    setSelected((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(pda);
      else copy.delete(pda);
      return copy;
    });
  }

  function toggleSelectAll() {
    setSelected((prev) => {
      // If everything in scope is currently selected, clear; otherwise
      // select all in scope. The button label below switches based on
      // this same state.
      const allSelected = inScopeRows.every((r) => prev.has(r.pda));
      if (allSelected) return new Set();
      return new Set(inScopeRows.map((r) => r.pda));
    });
  }

  // ---------------- Live picker totals ----------------

  const selectedCount = useMemo(
    () => inScopeRows.filter((r) => selected.has(r.pda)).length,
    [inScopeRows, selected],
  );

  const selectedTotal = useMemo(() => {
    let sumUnits = 0n;
    let decimals = PAYMENT_DECIMALS;
    let symbol = PAYMENT_SYMBOL;
    for (const r of inScopeRows) {
      if (!selected.has(r.pda)) continue;
      const lbl = labels.get(r.pda);
      if (!lbl) continue;
      sumUnits += lbl.amountUnits;
      decimals = lbl.decimals;
      symbol = lbl.symbol;
    }
    return {
      formatted: formatBigintAmount(sumUnits, decimals),
      symbol,
    };
  }, [inScopeRows, selected, labels]);

  const allInScopeSelected =
    inScopeRows.length > 0 && inScopeRows.every((r) => selected.has(r.pda));

  // ---------------- Generate ----------------

  async function handleGenerate() {
    if (!wallet.publicKey) return;
    if (selectedCount === 0) return;
    setSubmitting(true);
    setGenerateError(null);
    setProgressMsg(`Re-encrypting ${selectedCount} invoice${selectedCount === 1 ? "" : "s"}…`);
    try {
      const masterSig = await getOrCreateMetadataMasterSig(
        wallet as any,
        wallet.publicKey.toBase58(),
      );

      const inScopeArg: InScopeInvoice[] = inScopeRows
        .filter((r) => selected.has(r.pda))
        .map((r) => ({
          invoicePda: r.pda,
          metadataUri: r.raw.metadataUri,
          metadataHash: r.raw.metadataHash,
        }));

      const payload = await generateScopedGrant({
        masterSig,
        invoices: inScopeArg,
      });

      const grantId = `grant_${Date.now().toString(36)}`;
      const origin =
        typeof window !== "undefined" ? window.location.origin : "";
      const url = buildScopedGrantUrl({ origin, grantId, payload });

      // Same totals as the live counter — we already know what the
      // operator confirmed, so re-render the result card with the
      // values they saw on the CTA.
      setGrantResult({
        url,
        invoiceCount: payload.invoiceUris.length,
        skippedCount: inScopeArg.length - payload.invoiceUris.length,
        totalAmount: selectedTotal.formatted,
        symbol: selectedTotal.symbol,
        mintLabel: mintLabel(activeMint),
      });
      setProgressMsg(null);
    } catch (err: any) {
      setGenerateError(err.message ?? String(err));
      setProgressMsg(null);
    } finally {
      setSubmitting(false);
    }
  }

  function resetGrant() {
    setGrantResult(null);
    setGenerateError(null);
    setPayrollResult(null);
  }

  // ---------------- Payroll selection helpers ----------------

  function togglePayrollSelect(batchId: string, next: boolean) {
    setSelectedPayroll((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(batchId);
      else copy.delete(batchId);
      return copy;
    });
  }

  function togglePayrollSelectAll() {
    setSelectedPayroll((prev) => {
      const allSelected = inScopePayroll.every((e) =>
        prev.has(e.signed.packet.batchId),
      );
      if (allSelected) return new Set();
      return new Set(inScopePayroll.map((e) => e.signed.packet.batchId));
    });
  }

  const selectedPayrollCount = useMemo(
    () =>
      inScopePayroll.filter((e) => selectedPayroll.has(e.signed.packet.batchId))
        .length,
    [inScopePayroll, selectedPayroll],
  );

  const allPayrollInScopeSelected =
    inScopePayroll.length > 0 &&
    inScopePayroll.every((e) => selectedPayroll.has(e.signed.packet.batchId));

  // ---------------- Generate payroll links ----------------
  //
  // Each selected payroll batch becomes its own self-contained signed-
  // packet URL. The /payroll/packet page already decodes a base64-url
  // SignedPayrollPacket from the fragment — we reuse that path so the
  // disclosure surface is the same one the publishing modal already
  // hands the user after a run.
  function handleGeneratePayroll() {
    if (selectedPayrollCount === 0) return;
    const origin =
      typeof window !== "undefined" ? window.location.origin : "";
    const links: PayrollGrantLink[] = [];
    for (const entry of inScopePayroll) {
      const batchId = entry.signed.packet.batchId;
      if (!selectedPayroll.has(batchId)) continue;
      const packet = entry.signed.packet;
      const blob = encodePayrollPacket(entry.signed);
      const url = `${origin}/payroll/packet#${blob}`;
      let totalUnits = 0n;
      for (const row of packet.rows) {
        try {
          totalUnits += BigInt(row.amount);
        } catch {
          // skip malformed amount strings
        }
      }
      links.push({
        batchId,
        url,
        recipientCount: packet.rows.length,
        totalAmount: formatPayrollAmount(totalUnits, packet.decimals),
        symbol: packet.symbol,
      });
    }
    setPayrollResult({ links, mintLabel: mintLabel(activeMint) });
  }

  // ---------------- Mint options ----------------
  //
  // Today the app is configured for one payment mint per environment
  // (PAYMENT_MINT). Surface that as a single-option pill so the picker
  // reads as scope-aware without forcing a multi-token UI we don't
  // actually need yet. Future: add additional mints here as we add
  // multi-mint support.
  const mintOptions: MintOption[] = useMemo(
    () => [{ base58: USDC_MINT.toBase58(), symbol: PAYMENT_SYMBOL }],
    [],
  );

  // ---------------- Render ----------------

  // Wrapper class for the outgoing transition. Pairs with the 180ms
  // window in `handleBackToActivity` above. Tailwind doesn't have a
  // 180ms duration token, so we use the arbitrary-value bracket form.
  const surfaceClass = [
    "transition-[opacity,transform] duration-[180ms] ease-out",
    leaving ? "opacity-0 -translate-y-[2px]" : "opacity-100 translate-y-0",
  ].join(" ");

  if (!wallet.connected) {
    return (
      <Shell>
        <div className={surfaceClass}>
          <BackToActivityLink onLeave={handleBackToActivity} />
          <div className="max-w-lg reveal">
            <span className="eyebrow">Auditor links</span>
            <h1 className="mt-4 font-display text-ink text-[44px] md:text-[56px] leading-[1.02] tracking-[-0.02em]">
              Connect to grant scoped read access.
            </h1>
            <p className="mt-5 text-[15px] leading-[1.55] text-ink/70 max-w-md">
              Pick the invoices an auditor needs to see. We re-encrypt only
              those under a fresh per-grant key — your wallet&apos;s master
              key never leaves the browser.
            </p>
            <div className="mt-8">
              <ClientWalletMultiButton />
            </div>
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className={surfaceClass}>
        <BackToActivityLink onLeave={handleBackToActivity} />

        {/* Pre-grant intro is hidden once the grant is generated, so
            the success card sits alone — the leftover "Auditor links /
            Grant scoped read access. / Pick a date range…" text bug
            from the prior build is gone here. The GrantResultCard
            carries its own "Auditor link ready" eyebrow, so removing
            this block doesn't leave the success state header-less. */}
        {!grantResult && !payrollResult && (
          <div className="max-w-3xl reveal">
            <span className="eyebrow">Auditor links</span>
            <h1 className="mt-3 font-display text-ink text-[40px] md:text-[52px] leading-[1.04] tracking-[-0.02em]">
              Grant scoped read access.
            </h1>
            <p className="mt-5 text-[15px] leading-[1.55] text-ink/70 max-w-xl">
              Pick a date range and the rows your auditor needs to see. We
              re-encrypt only those invoices under a fresh per-grant key and
              give you a link to share. The link is the only way to read
              this scope.
            </p>
          </div>
        )}

        {fetchError && (
          <div className="max-w-3xl">
            <ErrorBanner message={fetchError} />
          </div>
        )}

        {grantResult ? (
          // Success state: centre the result card. The card has its own
          // `max-w-2xl`; wrapping in a flex centring container puts it
          // mid-column — the page is no longer fighting the picker's
          // left-aligned column when there's nothing else on the page.
          <div className="flex justify-center pt-2">
            <GrantResultCard
              url={grantResult.url}
              invoiceCount={grantResult.invoiceCount}
              totalAmount={grantResult.totalAmount}
              symbol={grantResult.symbol}
              mintLabel={grantResult.mintLabel}
              skippedCount={grantResult.skippedCount}
              onReset={resetGrant}
            />
          </div>
        ) : payrollResult ? (
          <div className="flex justify-center pt-2">
            <PayrollGrantResultCard
              result={payrollResult}
              onReset={resetGrant}
            />
          </div>
        ) : (
          <div className="max-w-3xl">
            <div className="mt-9">
              <ViewModeToggle
                viewMode={viewMode}
                onChange={setViewMode}
                invoiceCount={invoices.length}
                payrollCount={payrollRuns.length}
              />
              <div className="mt-5">
                <PresetPills
                  activePresetId={activePresetId}
                  onSelectPreset={setActivePresetId}
                  customFromDate={customFromDate}
                  customToDate={customToDate}
                  onChangeCustomFromDate={setCustomFromDate}
                  onChangeCustomToDate={setCustomToDate}
                  mintOptions={mintOptions}
                  activeMint={activeMint}
                  onSelectMint={setActiveMint}
                />
              </div>
            </div>

            {viewMode === "invoices" ? (
              <>
                <PickerHeader
                  selectedCount={selectedCount}
                  totalSelected={selectedTotal.formatted}
                  symbol={selectedTotal.symbol}
                  allInScopeSelected={allInScopeSelected}
                  onToggleAll={toggleSelectAll}
                  inScopeCount={inScopeRows.length}
                />

                <PickerList
                  fetching={fetching}
                  rows={inScopeRows}
                  labels={labels}
                  selected={selected}
                  onToggle={toggleSelect}
                />

                {generateError && (
                  <ErrorBanner message={generateError} />
                )}

                <div className="mt-8 flex flex-col sm:flex-row sm:items-center gap-4">
                  <button
                    type="button"
                    disabled={submitting || selectedCount === 0}
                    onClick={handleGenerate}
                    className="btn-primary md:min-w-[340px] justify-center"
                  >
                    {submitting ? (
                      <span className="inline-flex items-center gap-3">
                        <span className="h-1.5 w-1.5 rounded-full bg-paper animate-slow-pulse" />
                        {progressMsg ?? "Generating link…"}
                      </span>
                    ) : selectedCount === 0 ? (
                      <span>Select invoices to grant access</span>
                    ) : (
                      <span>
                        Generate auditor link <span aria-hidden>→</span>
                        <span className="ml-2 opacity-80 tabular-nums">
                          {selectedCount} invoice{selectedCount === 1 ? "" : "s"}
                          {" · "}
                          {selectedTotal.formatted} {selectedTotal.symbol}
                        </span>
                      </span>
                    )}
                  </button>
                </div>
              </>
            ) : (
              <>
                <PayrollPickerHeader
                  selectedCount={selectedPayrollCount}
                  allInScopeSelected={allPayrollInScopeSelected}
                  onToggleAll={togglePayrollSelectAll}
                  inScopeCount={inScopePayroll.length}
                />
                <PayrollPickerList
                  rows={inScopePayroll}
                  selected={selectedPayroll}
                  onToggle={togglePayrollSelect}
                />
                <div className="mt-8 flex flex-col sm:flex-row sm:items-center gap-4">
                  <button
                    type="button"
                    disabled={selectedPayrollCount === 0}
                    onClick={handleGeneratePayroll}
                    className="btn-primary md:min-w-[340px] justify-center"
                  >
                    {selectedPayrollCount === 0 ? (
                      <span>Select payroll batches to grant access</span>
                    ) : (
                      <span>
                        Generate auditor link <span aria-hidden>→</span>
                        <span className="ml-2 opacity-80 tabular-nums">
                          {selectedPayrollCount} batch
                          {selectedPayrollCount === 1 ? "" : "es"}
                        </span>
                      </span>
                    )}
                  </button>
                </div>
              </>
            )}

            <HowThisWorksNote />
          </div>
        )}
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// BackToActivityLink — sleek "← Activity" affordance at the top-left
// of the content column. Renders as a real <Link> so middle-click /
// cmd-click open in a new tab, but intercepts plain clicks to play
// the surface fade-out before the route swap (set by `onLeave`).
//
// The chevron does a small slide-left on hover (3px, 200ms ease-out)
// to telegraph the "go back" direction without being theatrical. The
// label uses the same mono-uppercase chip language as the rest of the
// app's secondary nav cues.
// ---------------------------------------------------------------------------

function BackToActivityLink({ onLeave }: { onLeave: () => void }) {
  return (
    <Link
      href="/dashboard"
      onClick={(e) => {
        // Allow modifier-clicks (open in new tab) to fall through to
        // the browser's default navigation. Only intercept the plain
        // primary-button click — that's the path that should fade.
        if (
          e.metaKey ||
          e.ctrlKey ||
          e.shiftKey ||
          e.altKey ||
          (e as any).button === 1
        ) {
          return;
        }
        e.preventDefault();
        onLeave();
      }}
      aria-label="Back to Activity"
      className={[
        "group inline-flex items-center gap-2.5",
        "mt-1 mb-7",
        "font-mono text-[10.5px] tracking-[0.16em] uppercase",
        "text-ink/55 hover:text-ink",
        "transition-colors duration-200",
        "focus:outline-none focus-visible:text-ink",
      ].join(" ")}
    >
      <span
        aria-hidden
        className={[
          "inline-flex items-center justify-center w-[18px] h-[18px]",
          "rounded-full border border-line/80",
          "transition-[transform,border-color,background-color] duration-200 ease-out",
          "group-hover:-translate-x-[3px] group-hover:border-ink/60 group-hover:bg-paper-3",
          "group-focus-visible:-translate-x-[3px] group-focus-visible:border-ink/60",
        ].join(" ")}
      >
        <svg
          width="9"
          height="9"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M6.5 2.5L3 5l3.5 2.5" />
        </svg>
      </span>
      <span>Activity</span>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Picker header — "Select all" + live counter.
// ---------------------------------------------------------------------------

function PickerHeader({
  selectedCount,
  totalSelected,
  symbol,
  allInScopeSelected,
  onToggleAll,
  inScopeCount,
}: {
  selectedCount: number;
  totalSelected: string;
  symbol: string;
  allInScopeSelected: boolean;
  onToggleAll: () => void;
  inScopeCount: number;
}) {
  return (
    <div className="mt-8 mb-2 flex items-center justify-between gap-4 px-4 py-3 border-b border-line/60">
      <button
        type="button"
        onClick={onToggleAll}
        disabled={inScopeCount === 0}
        aria-pressed={allInScopeSelected}
        className="inline-flex items-center gap-2.5 font-mono text-[10.5px] tracking-[0.14em] uppercase text-ink/55 hover:text-ink transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <span
          aria-hidden
          className={[
            "inline-flex h-[16px] w-[16px] items-center justify-center rounded-[3px] border transition-colors",
            allInScopeSelected
              ? "bg-ink border-ink text-paper"
              : selectedCount > 0
                ? "bg-paper-3 border-ink/50"
                : "bg-paper-3 border-line",
          ].join(" ")}
        >
          {allInScopeSelected ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path
                d="M2 5l2 2 4-4"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : selectedCount > 0 ? (
            <span className="block h-[2px] w-[8px] bg-ink/70" />
          ) : null}
        </span>
        <span>
          {allInScopeSelected ? "Deselect all" : "Select all"}
        </span>
      </button>

      <div className="font-mono text-[11px] tracking-[0.14em] uppercase text-ink/55 tabular-nums">
        <span className="text-ink">{selectedCount}</span>
        <span className="text-ink/40"> · </span>
        <span className="tabular-nums">{totalSelected} {symbol}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Picker list — bucketed rows + "Earlier" collapse.
// ---------------------------------------------------------------------------

function PickerList({
  fetching,
  rows,
  labels,
  selected,
  onToggle,
}: {
  fetching: boolean;
  rows: PickerRow[];
  labels: Map<string, InvoiceLabel>;
  selected: Set<string>;
  onToggle: (pda: string, next: boolean) => void;
}) {
  if (fetching && rows.length === 0) {
    return (
      <ul className="divide-y divide-ink/5">
        {[0, 1, 2].map((i) => (
          <li key={i} className="px-4 py-4">
            <div className="skeleton-bar h-3 w-3/4" />
          </li>
        ))}
      </ul>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="border border-dashed border-line rounded-[4px] py-12 px-6 text-center mt-2">
        <p className="font-display italic text-ink/80 text-[20px] leading-[1.3]">
          Nothing in this scope.
        </p>
        <p className="mt-2 text-[13px] text-ink/55 max-w-md mx-auto">
          Adjust the preset above (or pick a different mint) to widen
          what you&apos;re sharing with your auditor.
        </p>
      </div>
    );
  }

  // Bucket by createdAt — same logic as the dashboard ledger.
  const buckets = new Map<string, PickerRow[]>();
  for (const inv of rows) {
    const key = bucketByCreatedAt(inv.createdAt);
    const arr = buckets.get(key) ?? [];
    arr.push(inv);
    buckets.set(key, arr);
  }
  const recentBuckets = DATE_BUCKET_ORDER.filter(
    (label) =>
      RECENT_BUCKETS.includes(label) && (buckets.get(label)?.length ?? 0) > 0,
  );
  const olderBuckets = DATE_BUCKET_ORDER.filter(
    (label) =>
      !RECENT_BUCKETS.includes(label) && (buckets.get(label)?.length ?? 0) > 0,
  );
  const olderCount = olderBuckets.reduce(
    (sum, label) => sum + (buckets.get(label)?.length ?? 0),
    0,
  );

  return (
    <PickerBucketedList
      buckets={buckets}
      recentBuckets={recentBuckets}
      olderBuckets={olderBuckets}
      olderCount={olderCount}
      labels={labels}
      selected={selected}
      onToggle={onToggle}
    />
  );
}

function PickerBucketedList({
  buckets,
  recentBuckets,
  olderBuckets,
  olderCount,
  labels,
  selected,
  onToggle,
}: {
  buckets: Map<string, PickerRow[]>;
  recentBuckets: string[];
  olderBuckets: string[];
  olderCount: number;
  labels: Map<string, InvoiceLabel>;
  selected: Set<string>;
  onToggle: (pda: string, next: boolean) => void;
}) {
  // Default open when there are NO recent buckets — same logic as the
  // dashboard ledger, mirroring the PayPal-style accordion.
  const [olderOpen, setOlderOpen] = useState(recentBuckets.length === 0);

  // Re-evaluate the default-open intent when the bucket shape shifts
  // (e.g. user widens scope from "today" to "last 90 days"). We only
  // honour this for transitions that flip the recent-empty bit; once
  // the user manually toggles, their click wins.
  const lastRecentEmpty = useRef<boolean>(recentBuckets.length === 0);
  useEffect(() => {
    const nowEmpty = recentBuckets.length === 0;
    if (lastRecentEmpty.current !== nowEmpty) {
      setOlderOpen(nowEmpty);
      lastRecentEmpty.current = nowEmpty;
    }
  }, [recentBuckets.length]);

  let runningIndex = 0;
  function renderBucket(bucketLabel: string): JSX.Element[] {
    const list = buckets.get(bucketLabel);
    if (!list || list.length === 0) return [];
    const out: JSX.Element[] = [
      <DateGroupHeader key={`hdr-${bucketLabel}`} label={bucketLabel} />,
    ];
    for (const inv of list) {
      const lbl = labels.get(inv.pda);
      const idx = runningIndex++;
      const delay = Math.min(idx * 40, 480);
      out.push(
        <InvoiceRow
          key={inv.pda}
          pda={inv.pda}
          status={inv.status}
          createdAt={inv.createdAt}
          label={
            lbl
              ? {
                  payer: lbl.payer,
                  amount: `${lbl.amountStr} ${lbl.symbol}`,
                  description: lbl.description,
                }
              : undefined
          }
          animationDelayMs={delay}
          selectable
          selected={selected.has(inv.pda)}
          onSelectChange={onToggle}
        />,
      );
    }
    return out;
  }

  return (
    <div>
      {recentBuckets.length > 0 && (
        <ul className="divide-y divide-ink/5">
          {recentBuckets.flatMap(renderBucket)}
        </ul>
      )}

      {recentBuckets.length === 0 && olderBuckets.length > 0 && (
        <p className="font-display italic text-ink/50 text-[15px] py-6 px-4">
          Nothing today or yesterday.
        </p>
      )}

      {olderBuckets.length > 0 && (
        <div className="mt-2 border-t border-line/60">
          <button
            type="button"
            onClick={() => setOlderOpen((v) => !v)}
            aria-expanded={olderOpen}
            aria-controls="picker-older-section"
            className={[
              "group w-full flex items-center justify-between",
              "px-2 py-4 rounded-[3px]",
              "font-mono text-[12.5px] tracking-[0.16em] uppercase",
              "text-ink/70 hover:text-ink hover:bg-paper-2/60",
              "transition-colors duration-150",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/30",
            ].join(" ")}
          >
            <span className="inline-flex items-center gap-3">
              <span>{olderOpen ? "Hide earlier" : "Earlier"}</span>
              <span className="text-ink/30">·</span>
              <span className="tabular-nums text-ink/55">
                {String(olderCount).padStart(2, "0")} invoice
                {olderCount === 1 ? "" : "s"}
              </span>
            </span>
            <ChevronIcon open={olderOpen} />
          </button>
          {olderOpen && (
            <ul
              id="picker-older-section"
              className="divide-y divide-ink/5 mt-1 animate-fade-up"
            >
              {olderBuckets.flatMap(renderBucket)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Misc UI bits.
// ---------------------------------------------------------------------------

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="mt-6 flex items-start gap-4 border-l-2 border-brick pl-4 py-2 max-w-xl">
      <span className="mono-chip text-brick shrink-0 pt-0.5">Error</span>
      <span className="text-[13.5px] text-ink leading-relaxed flex-1">
        {message}
      </span>
    </div>
  );
}

function HowThisWorksNote() {
  return (
    <details className="mt-12 max-w-xl border-t border-line/60 pt-6">
      <summary className="cursor-pointer list-none font-mono text-[10.5px] tracking-[0.16em] uppercase text-muted hover:text-ink transition-colors inline-flex items-center gap-2">
        <span>How this works</span>
        <span aria-hidden>↓</span>
      </summary>
      <div className="mt-3 space-y-3 text-[13px] text-ink/75 leading-relaxed">
        <p>
          The link only references the invoices you selected — we
          re-encrypt them under a one-off key and upload those
          re-encrypted blobs. The auditor cannot reach invoices outside
          the scope from this link.
        </p>
        <p>
          What we don&apos;t implement: zero-knowledge selective
          disclosure or cryptographic time-bounding. Arweave is
          permanent, so anyone who retains the URL retains read access.
          To &ldquo;revoke&rdquo; a grant, stop sharing the link; the
          per-grant key has no other purpose.
        </p>
      </div>
    </details>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`}
      aria-hidden
    >
      <path d="M2 3.5l3 3 3-3" />
    </svg>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen relative pb-32">
      <nav className="sticky top-0 z-20 backdrop-blur-sm bg-paper/80 border-b border-line">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between px-6 md:px-8 py-4">
          <VeilLogo />
          <div className="flex items-center gap-1 md:gap-2">
            <a
              href="/create"
              className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors"
            >
              Create
            </a>
            <a
              href="/dashboard"
              className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors"
            >
              Activity
            </a>
            <a
              href="https://github.com/michal-marcinko/veil"
              target="_blank"
              rel="noreferrer noopener"
              className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors"
            >
              Docs
            </a>
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

// ---------------------------------------------------------------------------
// Helpers — labels + formatting.
// ---------------------------------------------------------------------------

async function loadLabels(
  wallet: { publicKey: { toBase58: () => string } | null } & Record<string, any>,
  invoices: Awaited<ReturnType<typeof fetchInvoicesByCreator>>,
): Promise<Map<string, InvoiceLabel>> {
  // Decrypt as many invoices' metadata as possible without triggering
  // popups beyond the one-time master-sig sign. Failures are silent;
  // those rows render with the truncated PDA.
  const next = new Map<string, InvoiceLabel>();
  if (invoices.length === 0) return next;
  if (!wallet.publicKey) return next;
  let masterSig: Uint8Array;
  try {
    masterSig = await getOrCreateMetadataMasterSig(
      // useWallet() shape — the encryption helper reads .signMessage.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet as any,
      wallet.publicKey.toBase58(),
    );
  } catch {
    // User declined the popup — skip labels entirely.
    return next;
  }
  await Promise.all(
    invoices.map(async (inv: any) => {
      try {
        const pda = inv.publicKey.toBase58();
        const uri: string = inv.account.metadataUri;
        if (!uri) return;
        const ciphertext = await fetchCiphertext(uri);
        const key = await deriveKeyFromMasterSig(masterSig, pda);
        const md = (await decryptJson(ciphertext, key)) as InvoiceMetadata;
        const total = BigInt(md.total);
        const decimals = md.currency?.decimals ?? PAYMENT_DECIMALS;
        const symbol = md.currency?.symbol ?? PAYMENT_SYMBOL;
        const description = (md.line_items ?? [])
          .map((li) => li.description)
          .filter(Boolean)
          .join(" · ");
        next.set(pda, {
          payer: md.payer?.display_name || "Unknown payer",
          description,
          amountStr: formatBigintAmount(total, decimals),
          amountUnits: total,
          decimals,
          symbol,
        });
      } catch {
        // Silent — falls back to truncated PDA in the row.
      }
    }),
  );
  return next;
}

// ---------------------------------------------------------------------------
// ViewModeToggle — segmented control deciding which surface the picker
// renders: invoices (re-encrypted scoped grant) vs. payroll batches
// (self-contained signed-packet link). The visual register matches the
// preset pills so the toolbar reads as one row of controls.
// ---------------------------------------------------------------------------

function ViewModeToggle({
  viewMode,
  onChange,
  invoiceCount,
  payrollCount,
}: {
  viewMode: ViewMode;
  onChange: (next: ViewMode) => void;
  invoiceCount: number;
  payrollCount: number;
}) {
  return (
    <div
      role="tablist"
      aria-label="Switch between invoices and payroll batches"
      className="inline-flex items-center gap-1 border border-line rounded-full p-1 bg-paper-3"
    >
      <ViewModeButton
        active={viewMode === "invoices"}
        onClick={() => onChange("invoices")}
        label="Invoices"
        count={invoiceCount}
      />
      <ViewModeButton
        active={viewMode === "payroll"}
        onClick={() => onChange("payroll")}
        label="Payroll batches"
        count={payrollCount}
      />
    </div>
  );
}

function ViewModeButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={[
        "px-3.5 py-1.5 rounded-full",
        "font-mono text-[10.5px] tracking-[0.14em] uppercase",
        "transition-colors duration-150 inline-flex items-center gap-2",
        active
          ? "bg-ink text-paper"
          : "text-ink/55 hover:text-ink hover:bg-paper-2/40",
      ].join(" ")}
    >
      <span>{label}</span>
      <span
        className={[
          "text-[10px] tabular-nums",
          active ? "text-paper/70" : "text-ink/35",
        ].join(" ")}
      >
        {count}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// PayrollPickerHeader — matches PickerHeader visually; no per-row total
// because each payroll batch is a self-contained packet, so the
// aggregate "amount" line would conflate distinct currencies / runs.
// ---------------------------------------------------------------------------

function PayrollPickerHeader({
  selectedCount,
  allInScopeSelected,
  onToggleAll,
  inScopeCount,
}: {
  selectedCount: number;
  allInScopeSelected: boolean;
  onToggleAll: () => void;
  inScopeCount: number;
}) {
  return (
    <div className="mt-8 mb-2 flex items-center justify-between gap-4 px-4 py-3 border-b border-line/60">
      <button
        type="button"
        onClick={onToggleAll}
        disabled={inScopeCount === 0}
        aria-pressed={allInScopeSelected}
        className="inline-flex items-center gap-2.5 font-mono text-[10.5px] tracking-[0.14em] uppercase text-ink/55 hover:text-ink transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <span
          aria-hidden
          className={[
            "inline-flex h-[16px] w-[16px] items-center justify-center rounded-[3px] border transition-colors",
            allInScopeSelected
              ? "bg-ink border-ink text-paper"
              : selectedCount > 0
                ? "bg-paper-3 border-ink/50"
                : "bg-paper-3 border-line",
          ].join(" ")}
        >
          {allInScopeSelected ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path
                d="M2 5l2 2 4-4"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : selectedCount > 0 ? (
            <span className="block h-[2px] w-[8px] bg-ink/70" />
          ) : null}
        </span>
        <span>{allInScopeSelected ? "Deselect all" : "Select all"}</span>
      </button>

      <div className="font-mono text-[11px] tracking-[0.14em] uppercase text-ink/55 tabular-nums">
        <span className="text-ink">{selectedCount}</span>
        <span className="text-ink/40"> / </span>
        <span>{inScopeCount}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PayrollPickerList — renders one row per cached payroll batch in
// scope. Each row mirrors the InvoiceRow visual language: a checkbox
// affordance, a date, a primary label (batch id truncated), and an
// amount on the right.
// ---------------------------------------------------------------------------

function PayrollPickerList({
  rows,
  selected,
  onToggle,
}: {
  rows: CachedPayrollRun[];
  selected: Set<string>;
  onToggle: (batchId: string, next: boolean) => void;
}) {
  if (rows.length === 0) {
    return (
      <div className="border border-dashed border-line rounded-[4px] py-12 px-6 text-center mt-2">
        <p className="font-display italic text-ink/80 text-[20px] leading-[1.3]">
          No payroll batches in this scope.
        </p>
        <p className="mt-2 text-[13px] text-ink/55 max-w-md mx-auto">
          Run a private payroll batch and it&apos;ll appear here, ready to
          share with your auditor.
        </p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-ink/5">
      {rows.map((entry) => {
        const packet = entry.signed.packet;
        const batchId = packet.batchId;
        const isSelected = selected.has(batchId);
        const paidCount = packet.rows.filter((r) => r.status === "paid").length;
        let totalUnits = 0n;
        for (const r of packet.rows) {
          try {
            totalUnits += BigInt(r.amount);
          } catch {
            // skip
          }
        }
        const totalLabel = formatPayrollAmount(totalUnits, packet.decimals);
        const created = new Date(packet.createdAt);
        const dateLabel = isNaN(created.getTime())
          ? "—"
          : created.toLocaleDateString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
            });
        const truncatedBatch =
          batchId.length > 22
            ? `${batchId.slice(0, 14)}…${batchId.slice(-6)}`
            : batchId;
        return (
          <li key={batchId}>
            <button
              type="button"
              role="checkbox"
              aria-checked={isSelected}
              aria-label={`${isSelected ? "Deselect" : "Select"} payroll batch ${batchId}`}
              onClick={() => onToggle(batchId, !isSelected)}
              className="w-full text-left px-4 py-4 hover:bg-paper-2/40 transition-colors duration-150 flex items-center gap-4"
            >
              <span
                aria-hidden
                className={[
                  "inline-flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-[3px] border transition-colors",
                  isSelected
                    ? "bg-ink border-ink text-paper"
                    : "bg-paper-3 border-line",
                ].join(" ")}
              >
                {isSelected && (
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path
                      d="M2 5l2 2 4-4"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </span>
              <div className="flex-1 min-w-0 grid grid-cols-[6rem_1fr_auto] gap-4 items-baseline">
                <span className="font-mono text-[11px] tracking-[0.06em] uppercase text-ink/55 tabular-nums">
                  {dateLabel}
                </span>
                <div className="min-w-0">
                  <div className="font-mono text-[13px] text-ink truncate">
                    {truncatedBatch}
                  </div>
                  <div className="mt-0.5 text-[12px] text-muted">
                    {packet.rows.length} recipient
                    {packet.rows.length === 1 ? "" : "s"}
                    {" · "}
                    {paidCount} paid
                  </div>
                </div>
                <span className="font-mono text-[13px] text-ink tabular-nums">
                  {totalLabel} {packet.symbol}
                </span>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// PayrollGrantResultCard — success state for the payroll path. We can
// emit multiple links (one per selected batch), so the layout adapts:
// single-link surfaces a Copy button next to the URL the way the
// invoice flow does; multi-link surfaces a stacked list.
// ---------------------------------------------------------------------------

function PayrollGrantResultCard({
  result,
  onReset,
}: {
  result: PayrollGrantResult;
  onReset: () => void;
}) {
  const single = result.links.length === 1 ? result.links[0] : null;

  async function copyText(text: string) {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
    } catch {
      // ignore
    }
  }

  return (
    <section
      className="reveal mt-10 max-w-2xl border border-sage/30 bg-paper-3 rounded-[4px] p-6 md:p-8"
      aria-labelledby="payroll-grant-ready-heading"
    >
      <div className="flex items-baseline justify-between gap-4 mb-1">
        <span id="payroll-grant-ready-heading" className="eyebrow text-sage">
          {result.links.length === 1
            ? "Payroll auditor link ready"
            : `Payroll auditor links ready · ${result.links.length}`}
        </span>
        <button
          type="button"
          onClick={onReset}
          className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-ink/55 hover:text-ink transition-colors inline-flex items-center gap-1"
        >
          <span>Generate another grant</span>
          <span aria-hidden>&rarr;</span>
        </button>
      </div>

      <p className="mt-4 text-[15px] text-ink/85 leading-[1.55]">
        {result.links.length === 1 && single ? (
          <>
            Auditor sees{" "}
            <span className="tabular-nums font-medium text-ink">
              {single.recipientCount}
            </span>{" "}
            recipient{single.recipientCount === 1 ? "" : "s"} ·{" "}
            <span className="tabular-nums font-medium text-ink">
              {single.totalAmount}
            </span>{" "}
            {single.symbol} · scoped to{" "}
            <span className="font-mono text-[12px]">{result.mintLabel}</span>.
          </>
        ) : (
          <>
            One link per batch — each is a self-contained signed packet
            scoped to a single payroll run on{" "}
            <span className="font-mono text-[12px]">{result.mintLabel}</span>.
          </>
        )}
      </p>

      <div className="mt-6 space-y-5">
        {result.links.map((link) => (
          <div
            key={link.batchId}
            className="border-t border-line/60 pt-4 first:border-t-0 first:pt-0"
          >
            <div className="flex items-baseline justify-between gap-3 mb-2">
              <span className="font-mono text-[11px] tracking-[0.08em] uppercase text-ink/70 truncate">
                {link.batchId}
              </span>
              <span className="font-mono text-[10.5px] text-muted tabular-nums shrink-0">
                {link.recipientCount} recipient
                {link.recipientCount === 1 ? "" : "s"} · {link.totalAmount}{" "}
                {link.symbol}
              </span>
            </div>
            <div className="flex items-stretch gap-2">
              <input
                readOnly
                value={link.url}
                onFocus={(e) => e.currentTarget.select()}
                onClick={(e) => e.currentTarget.select()}
                className="flex-1 input-editorial font-mono text-[12px] select-all"
                aria-label={`Payroll auditor URL for ${link.batchId}`}
              />
              <button
                type="button"
                onClick={() => copyText(link.url)}
                className="shrink-0 px-4 border border-line rounded-[3px] font-mono text-[10.5px] tracking-[0.14em] uppercase text-ink hover:bg-ink hover:text-paper transition-colors"
              >
                Copy
              </button>
            </div>
          </div>
        ))}
      </div>

      <p className="mt-6 font-mono text-[10.5px] leading-relaxed text-muted max-w-md">
        Each URL carries the full signed packet in its fragment — the
        decryption isn&apos;t needed because the packet was signed by your
        wallet at run time. Share over a trusted channel; anyone with the
        link can read the batch.
      </p>
    </section>
  );
}

function mintLabel(base58: string): string {
  if (base58 === USDC_MINT.toBase58()) return PAYMENT_SYMBOL;
  return `${base58.slice(0, 6)}…${base58.slice(-6)}`;
}

function formatBigintAmount(amount: bigint, decimals: number): string {
  if (amount === 0n) return "0";
  const divisor = 10n ** BigInt(decimals);
  const whole = amount / divisor;
  const frac = amount % divisor;
  const display = Math.min(4, decimals);
  const padded = frac.toString().padStart(decimals, "0").slice(0, display);
  return `${whole.toString()}.${padded}`;
}
