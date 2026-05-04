import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: (() => {
    const publicKey = new PublicKey("11111111111111111111111111111112");
    return () => ({
      connected: true,
      publicKey,
      signMessage: vi.fn(),
      signTransaction: vi.fn(),
    });
  })(),
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
  diagnoseUmbraReceiver: vi.fn(async () => ({ tokenX25519Matches: true })),
  repairUmbraReceiverKey: vi.fn(async () => []),
  scanClaimableUtxos: vi.fn(async () => ({
    received: [],
    publicReceived: [],
    selfBurnable: [],
    publicSelfBurnable: [],
  })),
  claimUtxos: vi.fn(async () => undefined),
  getEncryptedBalance: vi.fn(async () => 1_500_000n), // 1.5 USDC in micros as bigint
}));

import DashboardPage from "@/app/dashboard/page";

describe("Dashboard page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The editorial redesign persists the receipt-textarea draft to
    // localStorage per wallet; clear it so prior tests don't bleed
    // state into later ones.
    if (typeof window !== "undefined") {
      try {
        window.localStorage.clear();
      } catch {
        // ignore
      }
    }
  });

  it("renders the happy path without throwing BigInt/number mixing errors", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<DashboardPage />);

    await waitFor(() => {
      // Page was renamed Dashboard → Activity; the editorial-ledger
      // redesign (2026-05-04) uses Boska "Activity" as the H1 with the
      // subtitle "Read directly from Solana. Encrypted for you." Match
      // the first sentence — stable marker for "page rendered" across
      // future copy tweaks to the second sentence.
      expect(screen.getByText(/Read directly from Solana\./i)).toBeInTheDocument();
    });

    await waitFor(() => {
      // Mint-agnostic match — env default is wSOL on devnet (post-2026-05-04
       // alignment), USDC on mainnet, possibly other tokens in the future.
       expect(screen.getByText(/Private (USDC|SOL|wSOL) balance/i)).toBeInTheDocument();
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
      // The editorial redesign (2026-05-04) renders dates as "Apr 21"
      // (or "Apr 21 '25" for off-year). 1713657600 → 2024-04-21 UTC →
      // "Apr 21 '24". Match a 3-letter month + 1-2 digit day, which can
      // only render if Number(BN) conversion worked end-to-end.
      const dateRe = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}/;
      expect(screen.getAllByText(dateRe).length).toBeGreaterThan(0);
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

  it("no longer exposes a one-click 'Confirm paid' button (Codex 2026-05-04 fix)", async () => {
    // The previous build let any creator flip an invoice to Paid with one
    // click — and the auto-claim handler did the same en-masse for every
    // pending invoice on any incoming UTXO. Both are gone. The receipt-
    // import flow is the only path to mark_paid now.
    render(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByText(/Read directly from Solana\./i)).toBeInTheDocument();
    });

    const confirmButton = screen.queryByRole("button", { name: /^Confirm paid$/i });
    expect(confirmButton).toBeNull();

    // Receipt-import UI replaces it. After the editorial-ledger redesign
    // (2026-05-04) the apply-receipt UI lives in a slide-over panel —
    // open it by clicking the toolbar "Bind receipt" trigger first.
    const trigger = await screen.findByRole("button", {
      name: /Open the apply-receipt panel/i,
    });
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Apply receipt/i })).toBeInTheDocument();
    });
    expect(
      screen.getByPlaceholderText(/https:\/\/veil\.app\/receipt/i),
    ).toBeInTheDocument();
  });

  it("Apply receipt button is disabled until the textarea has input", async () => {
    render(<DashboardPage />);

    // Open the slide-over so the inner Apply receipt button + textarea
    // become discoverable to RTL queries (closed panels set aria-hidden
    // on the wrapper which masks descendants from getByRole).
    const trigger = await screen.findByRole("button", {
      name: /Open the apply-receipt panel/i,
    });
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Apply receipt/i })).toBeInTheDocument();
    });

    const button = screen.getByRole("button", { name: /Apply receipt/i });
    // Hydrated draft from a previous test run can pollute localStorage —
    // explicitly clear the textarea to assert the disabled-when-empty
    // contract reliably.
    const textarea = screen.getByPlaceholderText(/https:\/\/veil\.app\/receipt/i);
    fireEvent.change(textarea, { target: { value: "" } });
    expect(button).toBeDisabled();
  });

  it("rejects malformed receipt input with a Receipt error chip", async () => {
    const anchor = await import("@/lib/anchor");
    render(<DashboardPage />);

    const trigger = await screen.findByRole("button", {
      name: /Open the apply-receipt panel/i,
    });
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Apply receipt/i })).toBeInTheDocument();
    });

    const textarea = screen.getByPlaceholderText(/https:\/\/veil\.app\/receipt/i);
    fireEvent.change(textarea, { target: { value: "this-is-definitely-not-a-receipt" } });

    fireEvent.click(screen.getByRole("button", { name: /Apply receipt/i }));

    await waitFor(() => {
      expect(screen.getByText(/Receipt:/i)).toBeInTheDocument();
    });

    // No on-chain mark_paid call should have happened on bad input.
    expect(anchor.markPaidOnChain).not.toHaveBeenCalled();
  });
});
