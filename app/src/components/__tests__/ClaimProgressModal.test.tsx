import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ClaimProgressModal } from "@/components/ClaimProgressModal";

describe("ClaimProgressModal", () => {
  it("renders nothing when open=false", () => {
    const { container } = render(
      <ClaimProgressModal open={false} current={0} total={6} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows initial state when current=0 and total>0", () => {
    render(<ClaimProgressModal open current={0} total={6} />);
    // Headline is split across child <span>s for the tnum count, so
    // assert via the ARIA dialog label + the standalone count chip.
    expect(
      screen.getByRole("dialog", { name: /Claiming incoming payments/i }),
    ).toBeInTheDocument();
    // The count text "incoming payments" (plural) shows up as a
    // sibling text node — match the suffix specifically.
    expect(screen.getByText(/incoming payments/i)).toBeInTheDocument();
    // Lede explains the per-claim wallet signature requirement.
    expect(
      screen.getByText(/Each claim is one wallet signature/i),
    ).toBeInTheDocument();
    // Progress bar reflects current=0 (not yet started).
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "6");
  });

  it("singularises copy when total === 1", () => {
    render(<ClaimProgressModal open current={0} total={1} />);
    // Singular: "incoming payment" (no trailing s). The trailing
    // text node is separate from the headline's count span.
    expect(
      screen.getByText((_content, node) => {
        if (!node) return false;
        const t = node.textContent ?? "";
        return /incoming payment$/i.test(t.trim());
      }),
    ).toBeInTheDocument();
  });

  it("renders the success state when current === total", () => {
    render(<ClaimProgressModal open current={6} total={6} />);
    expect(
      screen.getByText(/All 6 claims complete/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Funds are in your encrypted balance/i),
    ).toBeInTheDocument();
  });

  it("renders the error state when errorMessage is set", () => {
    render(
      <ClaimProgressModal
        open
        current={2}
        total={6}
        errorMessage="Relayer 503"
      />,
    );
    expect(screen.getByText(/Claim interrupted/i)).toBeInTheDocument();
    expect(screen.getByText(/Relayer 503/)).toBeInTheDocument();
    // Progress bar still reflects how many succeeded before the failure.
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "2");
  });

  it("renders one step row per UTXO with correct status copy", () => {
    render(<ClaimProgressModal open current={2} total={4} />);
    // 2 done, 1 in progress, 1 queued.
    expect(screen.getAllByText(/Claimed/i)).toHaveLength(2);
    expect(
      screen.getByText(/Awaiting wallet signature/i),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/Queued/i)).toHaveLength(1);
  });
});
