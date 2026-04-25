import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { X25519HelpDialog } from "@/components/X25519HelpDialog";

describe("X25519HelpDialog", () => {
  it("does not render when open=false", () => {
    render(<X25519HelpDialog open={false} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders instructions mentioning getMasterViewingKeyX25519KeypairDeriver when open", () => {
    render(<X25519HelpDialog open={true} onClose={vi.fn()} />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    // Function name appears in both the <code> blurb and the <pre> snippet — use getAllByText.
    expect(screen.getAllByText(/getMasterViewingKeyX25519KeypairDeriver/).length).toBeGreaterThan(0);
    expect(screen.getByText(/32-byte base58 public key/i)).toBeTruthy();
  });

  it("calls onClose when Close button clicked", async () => {
    const close = vi.fn();
    const user = userEvent.setup();
    render(<X25519HelpDialog open={true} onClose={close} />);
    await user.click(screen.getByRole("button", { name: /close/i }));
    expect(close).toHaveBeenCalledOnce();
  });

  it("calls onClose when backdrop clicked", async () => {
    const close = vi.fn();
    const user = userEvent.setup();
    render(<X25519HelpDialog open={true} onClose={close} />);
    await user.click(screen.getByTestId("help-dialog-backdrop"));
    expect(close).toHaveBeenCalledOnce();
  });
});
