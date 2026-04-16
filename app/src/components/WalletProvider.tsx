"use client";

import {
  ConnectionProvider as _ConnectionProvider,
  WalletProvider as _SolanaWalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider as _WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import { useMemo, type ComponentType } from "react";
import { RPC_URL } from "@/lib/constants";

import "@solana/wallet-adapter-react-ui/styles.css";

// Cast wallet-adapter providers to ComponentType<any> to work around a
// TypeScript incompatibility between @types/react@18.3.0's ReactNode
// (which now includes Promise<ReactNode> for RSC) and the older FC<Props>
// signatures exported by @solana/wallet-adapter-react@0.15.x. The runtime
// is unaffected; this is purely a type-system coercion.
const ConnectionProvider = _ConnectionProvider as ComponentType<any>;
const SolanaWalletProvider = _SolanaWalletProvider as ComponentType<any>;
const WalletModalProvider = _WalletModalProvider as ComponentType<any>;

export function VeilWalletProvider({ children }: { children: React.ReactNode }) {
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    [],
  );

  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <SolanaWalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
}
