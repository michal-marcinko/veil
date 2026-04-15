export interface LineItem {
  description: string;
  quantity: string;
  unit_price: string;
  total: string;
}

export interface CreatorInfo {
  display_name: string;
  wallet: string;
  contact: string | null;
  logo_url: string | null;
}

export interface PayerInfo {
  display_name: string;
  wallet: string | null;
  contact: string | null;
}

export interface CurrencyInfo {
  mint: string;
  symbol: string;
  decimals: number;
}

export interface InvoiceMetadata {
  version: 1;
  invoice_id: string;
  created_at: string;
  creator: CreatorInfo;
  payer: PayerInfo;
  currency: CurrencyInfo;
  line_items: LineItem[];
  subtotal: string;
  tax: string;
  total: string;
  due_date: string | null;
  terms: string | null;
  notes: string | null;
}

export interface BuildMetadataArgs {
  invoiceId: string;
  creatorDisplayName: string;
  creatorWallet: string;
  creatorContact?: string | null;
  creatorLogoUrl?: string | null;
  payerDisplayName: string;
  payerWallet: string | null;
  payerContact?: string | null;
  mint: string;
  symbol: string;
  decimals: number;
  lineItems: Array<{ description: string; quantity: string; unitPrice: string; total: string }>;
  subtotal: string;
  tax: string;
  total: string;
  dueDate: string | null;
  terms: string | null;
  notes: string | null;
}

export function buildMetadata(args: BuildMetadataArgs): InvoiceMetadata {
  return {
    version: 1,
    invoice_id: args.invoiceId,
    created_at: new Date().toISOString(),
    creator: {
      display_name: args.creatorDisplayName,
      wallet: args.creatorWallet,
      contact: args.creatorContact ?? null,
      logo_url: args.creatorLogoUrl ?? null,
    },
    payer: {
      display_name: args.payerDisplayName,
      wallet: args.payerWallet,
      contact: args.payerContact ?? null,
    },
    currency: { mint: args.mint, symbol: args.symbol, decimals: args.decimals },
    line_items: args.lineItems.map((li) => ({
      description: li.description,
      quantity: li.quantity,
      unit_price: li.unitPrice,
      total: li.total,
    })),
    subtotal: args.subtotal,
    tax: args.tax,
    total: args.total,
    due_date: args.dueDate,
    terms: args.terms,
    notes: args.notes,
  };
}

export function validateMetadata(md: InvoiceMetadata): void {
  if (md.version !== 1) throw new Error("Unsupported metadata version");
  const sum = md.line_items.reduce((acc, li) => acc + BigInt(li.total), 0n);
  if (BigInt(md.subtotal) !== sum) {
    throw new Error(`subtotal ${md.subtotal} does not match sum of line items ${sum}`);
  }
  const expectedTotal = BigInt(md.subtotal) + BigInt(md.tax);
  if (BigInt(md.total) !== expectedTotal) {
    throw new Error(`total ${md.total} does not match subtotal + tax ${expectedTotal}`);
  }
}
