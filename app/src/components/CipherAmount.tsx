"use client";

import { useEffect, useState } from "react";

const HEX = "0123456789abcdef";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function randomCipher(len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += HEX[Math.floor(Math.random() * HEX.length)];
  return s;
}

function randomB58(len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += B58[Math.floor(Math.random() * B58.length)];
  return s;
}

function shortAddr(): string {
  return `${randomB58(4)}…${randomB58(4)}`;
}

/**
 * The brand demo moment. Two panes, IDENTICAL row structure (From / To /
 * Amount), DIFFERENT visibility — left is what the client sees on the
 * invoice (human names + dollars), right is what the chain exposes to
 * the world (wallet addresses + cipher). The semantic parallel is the
 * point: same payment, two views, only one of them leaks signal.
 */
export function CipherAmount({ amount = "$4,200.00" }: { amount?: string }) {
  const [from, setFrom] = useState("8xK2…pN3q");
  const [to, setTo] = useState("2NYX…P4Nw");
  const [cipher, setCipher] = useState("a71e3f9c0d4b8e27");

  useEffect(() => {
    const t = window.setInterval(() => {
      setFrom(shortAddr());
      setTo(shortAddr());
      setCipher(randomCipher(16));
    }, 3200);
    return () => window.clearInterval(t);
  }, []);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 border border-line bg-paper-3 rounded-[4px] overflow-hidden shadow-[0_1px_0_rgba(0,0,0,0.02),0_20px_60px_-30px_rgba(26,24,20,0.25)]">
      {/* Left pane — client view */}
      <div className="p-7 md:p-8 border-b md:border-b-0 md:border-r border-line">
        <div className="mb-6">
          <span className="eyebrow">What your client sees</span>
        </div>

        <dl className="space-y-4 text-[13.5px]">
          <div className="flex items-baseline justify-between">
            <dt className="text-muted">From</dt>
            <dd className="text-ink font-medium">Acme Design Ltd.</dd>
          </div>
          <div className="flex items-baseline justify-between">
            <dt className="text-muted">To</dt>
            <dd className="text-ink font-medium">Globex Corp.</dd>
          </div>
          <div className="h-px bg-line" />
          <div className="pt-1">
            <dt className="text-ink font-medium mb-3">Amount</dt>
            <dd className="font-sans tnum text-ink text-[24px] md:text-[26px] font-medium tracking-[-0.02em] leading-none">
              {amount}
            </dd>
          </div>
        </dl>

        <div className="mt-6 inline-flex items-center gap-2 text-[12px] text-sage">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 6l3 3 5-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>Settled via USDC</span>
        </div>
      </div>

      {/* Right pane — public chain view */}
      <div className="p-7 md:p-8 bg-paper-2/50">
        <div className="mb-6">
          <span className="eyebrow">What the world sees</span>
        </div>

        <dl className="space-y-4 text-[13.5px]">
          <div className="flex items-baseline justify-between">
            <dt className="text-muted">From</dt>
            <dd className="font-mono tnum text-ink">{from}</dd>
          </div>
          <div className="flex items-baseline justify-between">
            <dt className="text-muted">To</dt>
            <dd className="font-mono tnum text-ink">{to}</dd>
          </div>
          <div className="h-px bg-line" />
          <div className="pt-1">
            <dt className="text-ink font-medium mb-3">Amount</dt>
            <dd className="font-mono tnum text-ink text-[24px] md:text-[26px] font-normal tracking-[0.04em] leading-none break-all">
              {cipher}
            </dd>
          </div>
        </dl>

        <div className="mt-6 inline-flex items-center gap-2 text-[12px] text-gold">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
            <rect x="2.5" y="5.5" width="7" height="5" rx="0.5" stroke="currentColor" strokeWidth="1.2" />
            <path d="M4 5.5V4a2 2 0 014 0v1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          <span>Encrypted · Umbra private UTXO</span>
        </div>
      </div>
    </div>
  );
}
