"use client";

import dynamic from "next/dynamic";

// Dynamic import with ssr:false avoids the hydration mismatch in
// BaseWalletConnectionButton, which renders a different <i> icon
// depending on wallet state (available only client-side).
export const ClientWalletMultiButton = dynamic(
  async () => {
    const mod = await import("@solana/wallet-adapter-react-ui");
    return { default: mod.WalletMultiButton };
  },
  { ssr: false },
);
