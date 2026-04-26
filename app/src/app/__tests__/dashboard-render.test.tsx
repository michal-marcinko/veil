import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => ({
    connected: true,
    publicKey: new PublicKey("11111111111111111111111111111112"),
    signMessage: vi.fn(),
    signTransaction: vi.fn(),
  }),
}));

vi.mock("@/components/ClientWalletMultiButton", () => ({
  ClientWalletMultiButton: () => null,
}));

vi.mock("@/lib/anchor", () => ({
  fetchInvoicesByCreator: vi.fn(async () => [
    {
      publicKey: new PublicKey("11111111111111111111111111111113"),
      account: {
        version: 1,
        creator: new PublicKey("11111111111111111111111111111112"),
        payer: null,
        mint: new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
        metadataHash: new Uint8Array(32),
        metadataUri: "https://arweave.net/abc",
        utxoCommitment: null,
        status: { pending: {} },
        createdAt: new BN(1713657600), // 2026-04-21 as i64 BN
        paidAt: null,
        expiresAt: null,
        nonce: new Uint8Array(8),
        bump: 255,
      },
    },
  ]),
  markPaidOnChain: vi.fn(async () => "mark-paid-sig"),
}));

vi.mock("@/lib/umbra", () => ({
  getOrCreateClient: vi.fn(async () => ({ signer: { address: "fake" } })),
  isFullyRegistered: vi.fn(async () => true),
  scanClaimableUtxos: vi.fn(async () => ({ received: [], publicReceived: [] })),
  claimUtxos: vi.fn(async () => undefined),
  getEncryptedBalance: vi.fn(async () => 1_500_000n), // 1.5 USDC in micros as bigint
}));

import DashboardPage from "@/app/dashboard/page";

describe("Dashboard page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the happy path without throwing BigInt/number mixing errors", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByText(/Your invoices/i)).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText(/Private USDC balance/i)).toBeInTheDocument();
    });

    // No red error banner — there should be no element containing the exact
    // substring "Cannot mix BigInt".
    const banners = screen.queryAllByText(/Cannot mix BigInt/i);
    expect(banners).toHaveLength(0);

    const calls = errorSpy.mock.calls.map((c) => String(c[0] ?? ""));
    const mixingErrors = calls.filter((m) => /Cannot mix BigInt/i.test(m));
    expect(mixingErrors).toEqual([]);

    errorSpy.mockRestore();
  });

  it("renders the row date without throwing when createdAt is an anchor BN", async () => {
    render(<DashboardPage />);
    await waitFor(() => {
      // 1713657600 → 2024-04-20 (or similar) — assert *some* YYYY-MM-DD string
      // appears in a row, which can only happen if Number(BN) conversion worked.
      const dateRe = /\d{4}-\d{2}-\d{2}/;
      expect(screen.getByText(dateRe)).toBeInTheDocument();
    });
  });

  it("renders each invoice row as a link to /invoice/[pda]", async () => {
    render(<DashboardPage />);
    await waitFor(() => {
      const link = screen.getByRole("link", {
        name: /Open invoice 11111111111111111111111111111113/i,
      });
      expect(link).toHaveAttribute("href", "/invoice/11111111111111111111111111111113");
    });
  });
});
