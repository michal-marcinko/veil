import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { InvoiceRow } from "@/components/InvoiceRow";

// Lightweight mock for next/link — the rest of the test suite stubs
// this elsewhere via wallet-adapter mocks; here we only need <a> so
// the InvoiceRow's link wrapper doesn't error on missing AppRouter
// context.
vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const PDA = "8wQ4Kx2hN7yAFm6jL3qZ1pV9rB5tE8vC0nXYzWaVuPdG";

function renderRow(overrides: any = {}) {
  return render(
    <ul>
      <InvoiceRow
        pda={PDA}
        status="pending"
        createdAt={1713657600}
        label={{ payer: "Acme", amount: "12.3400 SOL", description: "Q1 retainer" }}
        {...overrides}
      />
    </ul>,
  );
}

describe("InvoiceRow — default mode", () => {
  it("renders as a link to /invoice/<pda>", () => {
    renderRow();
    const link = screen.getByRole("link", {
      name: /Open invoice 8wQ4Kx2hN7yAFm6jL3qZ1pV9rB5tE8vC0nXYzWaVuPdG/i,
    });
    expect(link).toHaveAttribute("href", `/invoice/${PDA}`);
  });

  it("does not render a checkbox when selectable is false", () => {
    renderRow();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

describe("InvoiceRow — selectable mode", () => {
  it("renders a checkbox-role button instead of a navigation link", () => {
    const onSelectChange = vi.fn();
    renderRow({ selectable: true, selected: false, onSelectChange });

    // No Link wrapper
    expect(
      screen.queryByRole("link", { name: /Open invoice/i }),
    ).toBeNull();

    // Checkbox-role with aria-checked=false
    const checkbox = screen.getByRole("checkbox", { name: /Select invoice/i });
    expect(checkbox).toHaveAttribute("aria-checked", "false");
  });

  it("clicking calls onSelectChange with the inverse of `selected`", () => {
    const onSelectChange = vi.fn();
    renderRow({ selectable: true, selected: false, onSelectChange });

    const checkbox = screen.getByRole("checkbox", { name: /Select invoice/i });
    fireEvent.click(checkbox);
    expect(onSelectChange).toHaveBeenCalledWith(PDA, true);
  });

  it("renders aria-checked=true when selected", () => {
    const onSelectChange = vi.fn();
    renderRow({ selectable: true, selected: true, onSelectChange });

    const checkbox = screen.getByRole("checkbox", { name: /Deselect invoice/i });
    expect(checkbox).toHaveAttribute("aria-checked", "true");
  });

  it("clicking when selected emits a deselect (false)", () => {
    const onSelectChange = vi.fn();
    renderRow({ selectable: true, selected: true, onSelectChange });

    const checkbox = screen.getByRole("checkbox", { name: /Deselect invoice/i });
    fireEvent.click(checkbox);
    expect(onSelectChange).toHaveBeenCalledWith(PDA, false);
  });

  it("does not render the hover bind/copy/explorer actions in selectable mode", () => {
    renderRow({
      selectable: true,
      selected: false,
      onSelectChange: vi.fn(),
      onBindReceipt: vi.fn(),
    });
    // The bind-receipt action would appear under this aria-label when
    // the row is hovered in default mode; in selectable mode it must
    // not be rendered at all (avoid nested-interactive-control a11y
    // warnings on the row's checkbox button).
    expect(
      screen.queryByRole("button", { name: /Bind receipt to this invoice/i }),
    ).toBeNull();
    expect(
      screen.queryByRole("link", {
        name: /View invoice on Solana explorer/i,
      }),
    ).toBeNull();
  });
});
