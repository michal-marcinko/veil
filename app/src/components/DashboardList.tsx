"use client";

interface DashboardInvoice {
  pda: string;
  creator: string;
  metadataUri: string;
  status: "Pending" | "Paid" | "Cancelled" | "Expired";
  createdAt: number;
}

export function DashboardList({
  title,
  invoices,
}: {
  title: string;
  invoices: DashboardInvoice[];
}) {
  if (invoices.length === 0) {
    return (
      <div className="mb-8">
        <h2 className="text-xl font-semibold mb-3">{title}</h2>
        <p className="text-gray-500 text-sm">No invoices yet.</p>
      </div>
    );
  }
  return (
    <div className="mb-8">
      <h2 className="text-xl font-semibold mb-3">{title}</h2>
      <div className="space-y-2">
        {invoices.map((inv) => (
          <div
            key={inv.pda}
            className="bg-gray-900 border border-gray-800 rounded p-4 flex justify-between items-center"
          >
            <div className="font-mono text-sm text-gray-400">{inv.pda.slice(0, 8)}...</div>
            <StatusBadge status={inv.status} />
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    Pending: "bg-yellow-900 text-yellow-300",
    Paid: "bg-green-900 text-green-300",
    Cancelled: "bg-gray-800 text-gray-400",
    Expired: "bg-red-900 text-red-300",
  };
  return (
    <span className={`px-2 py-1 rounded text-xs ${colors[status] ?? ""}`}>{status}</span>
  );
}
