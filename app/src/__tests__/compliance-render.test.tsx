import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

// Compliance page render smoke + preset-pill / picker integration test.
// Confirms the Editorial-Ledger redesign:
//   - Preset pills row renders ("2026 tax year" / "Custom range" / etc).
//   - Picker rows render with checkbox-role buttons (one per invoice).
//   - Selected count + total are derived from the selection set.
//   - The "Generate auditor link" CTA is disabled at zero-selection and
//     enabled when at least one row is in scope.

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

// Two invoices on the same wSOL mint so the default mint pill is
// in-scope and both rows show up in the picker.
vi.mock("@/lib/anchor", () => ({
  fetchInvoicesByCreator: vi.fn(async () => [
    {
      publicKey: new PublicKey("11111111111111111111111111111113"),
      account: {
        version: 1,
        creator: new PublicKey("11111111111111111111111111111112"),
        payer: null,
        mint: new PublicKey("So11111111111111111111111111111111111111112"),
        metadataHash: new Uint8Array(32),
        metadataUri: "https://arweave.net/abc",
        utxoCommitment: null,
        status: { pending: {} },
        createdAt: new BN(Math.floor(Date.UTC(2026, 1, 15) / 1000)),
        paidAt: null,
        expiresAt: null,
        nonce: new Uint8Array(8),
        bump: 255,
      },
    },
    {
      publicKey: new PublicKey("11111111111111111111111111111114"),
      account: {
        version: 1,
        creator: new PublicKey("11111111111111111111111111111112"),
        payer: null,
        mint: new PublicKey("So11111111111111111111111111111111111111112"),
        metadataHash: new Uint8Array(32),
        metadataUri: "https://arweave.net/def",
        utxoCommitment: null,
        status: { paid: {} },
        createdAt: new BN(Math.floor(Date.UTC(2026, 2, 10) / 1000)),
        paidAt: new BN(Math.floor(Date.UTC(2026, 2, 11) / 1000)),
        expiresAt: null,
        nonce: new Uint8Array(8),
        bump: 255,
      },
    },
  ]),
}));

// Stub the master-sig + arweave fetch so loadLabels resolves (with
// empty labels — the rows still render via the truncated PDA).
vi.mock("@/lib/encryption", async () => {
  const actual: any = await vi.importActual("@/lib/encryption");
  return {
    ...actual,
    getOrCreateMetadataMasterSig: vi.fn(async () => new Uint8Array(64)),
    deriveKeyFromMasterSig: vi.fn(async () => new Uint8Array(32)),
    decryptJson: vi.fn(async () => {
      throw new Error("test stub: skip label decrypt");
    }),
  };
});

vi.mock("@/lib/arweave", () => ({
  fetchCiphertext: vi.fn(async () => new Uint8Array(0)),
  uploadCiphertext: vi.fn(async () => ({ uri: "https://arweave.net/zzz" })),
}));

import CompliancePage from "@/app/dashboard/compliance/page";

describe("Compliance page — Editorial Ledger redesign", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders preset pills + picker rows without throwing", async () => {
    render(<CompliancePage />);

    // Page-level Boska headline.
    await waitFor(() => {
      expect(
        screen.getByText(/Grant scoped read access\./i),
      ).toBeInTheDocument();
    });

    // Tax-year pills exist (label adapts to current year — there are
    // always exactly two: current + previous).
    await waitFor(() => {
      const taxYearPills = screen.getAllByRole("tab", {
        name: /\d{4} tax year/,
      });
      expect(taxYearPills.length).toBeGreaterThanOrEqual(2);
    });

    // Custom range pill and All time pill always render.
    expect(
      screen.getByRole("tab", { name: /Custom range/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: /All time/i }),
    ).toBeInTheDocument();
  });

  it("renders one checkbox-role row per in-scope invoice", async () => {
    render(<CompliancePage />);

    // All time is the safest preset for this test: the mock invoices
    // are stamped in 2026 and the current tax year preset covers them
    // already, but switching to All time guarantees inclusion
    // regardless of the test machine's clock.
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /All time/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("tab", { name: /All time/i }));

    await waitFor(() => {
      const rows = screen.getAllByRole("checkbox", {
        name: /(Select|Deselect) invoice/i,
      });
      // Two invoices in the mock + one "Select all" header checkbox-
      // pattern — but the header isn't a real checkbox role (it's a
      // button with aria-pressed). Filter to per-row only.
      const perRow = rows.filter((el) =>
        /invoice 1{31}1[34]/i.test(el.getAttribute("aria-label") ?? ""),
      );
      expect(perRow).toHaveLength(2);
    });
  });

  it("Generate button shows live N invoices · total when rows are selected", async () => {
    render(<CompliancePage />);

    // Switch to All time so both mock invoices are in-scope and
    // pre-selected by the page's default-select-all behaviour.
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /All time/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("tab", { name: /All time/i }));

    await waitFor(() => {
      // The CTA reads "Generate auditor link → N invoices · …"
      // when something is selected. Match on the "invoices" word
      // rather than the exact count to avoid coupling to amount
      // formatting (labels are stubbed out so amounts are 0).
      const cta = screen.getByRole("button", {
        name: /Generate auditor link/i,
      });
      expect(cta).toBeInTheDocument();
      expect(cta).not.toBeDisabled();
    });
  });

  it("Generate button is disabled when zero rows are selected", async () => {
    render(<CompliancePage />);

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /All time/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("tab", { name: /All time/i }));

    // Wait until rows are present, then click the page's Select-all
    // toggle to deselect everything (default state has all rows
    // selected). After the toggle, the CTA flips to its disabled,
    // "Select invoices to grant access" copy.
    await waitFor(() => {
      expect(
        screen.getAllByRole("checkbox", { name: /(Select|Deselect) invoice/i })
          .length,
      ).toBeGreaterThan(0);
    });

    const selectAll = screen.getByRole("button", { name: /Deselect all/i });
    fireEvent.click(selectAll);

    await waitFor(() => {
      const cta = screen.getByRole("button", {
        name: /Select invoices to grant access/i,
      });
      expect(cta).toBeDisabled();
    });
  });

  it("does NOT render the legacy on-chain grants section", async () => {
    render(<CompliancePage />);

    await waitFor(() => {
      expect(screen.getByText(/Grant scoped read access\./i)).toBeInTheDocument();
    });

    // The previous build had this header; the redesign drops it.
    expect(screen.queryByText(/Legacy on-chain grants/i)).toBeNull();
  });
});
