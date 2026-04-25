import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GrantList } from "@/components/GrantList";
import type { GrantWithStatus } from "@/lib/umbra";

const baseGrant: GrantWithStatus = {
  granterAddress: "Alice1111111111111111111111111111111111111",
  receiverAddress: "Bob222222222222222222222222222222222222222",
  granterX25519Base58: "G".repeat(32),
  receiverX25519Base58: "R".repeat(32),
  nonce: "1745251200000",
  issuedAt: 1745251200000,
  signature: "sig",
  status: "active",
};

describe("GrantList", () => {
  it("renders empty state when grants array is empty", () => {
    render(<GrantList grants={[]} onRevoke={vi.fn()} revokingKey={null} />);
    expect(screen.getByText(/no grants yet/i)).toBeTruthy();
  });

  it("renders one row per grant with truncated receiver", () => {
    render(<GrantList grants={[baseGrant]} onRevoke={vi.fn()} revokingKey={null} />);
    // Truncation: first 4 + last 4 of base58 address.
    expect(screen.getByText(/Bob2…2222/)).toBeTruthy();
    expect(screen.getByText("1745251200000")).toBeTruthy();
    expect(screen.getByText(/active/i)).toBeTruthy();
  });

  it("calls onRevoke with the grant when Revoke button clicked", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<GrantList grants={[baseGrant]} onRevoke={handler} revokingKey={null} />);
    await user.click(screen.getByRole("button", { name: /revoke/i }));
    expect(handler).toHaveBeenCalledWith(baseGrant);
  });

  it("disables Revoke button for revoked grants", () => {
    render(
      <GrantList
        grants={[{ ...baseGrant, status: "revoked" }]}
        onRevoke={vi.fn()}
        revokingKey={null}
      />,
    );
    const btn = screen.getByRole("button", { name: /revoke/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("shows Revoking… label when revokingKey matches the grant", () => {
    render(
      <GrantList
        grants={[baseGrant]}
        onRevoke={vi.fn()}
        revokingKey={`${baseGrant.receiverX25519Base58}:${baseGrant.nonce}`}
      />,
    );
    expect(screen.getByText(/revoking/i)).toBeTruthy();
  });
});
