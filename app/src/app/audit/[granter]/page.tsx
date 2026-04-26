"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import {
  getMasterViewingKeyX25519KeypairDeriver,
} from "@umbra-privacy/sdk";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { VeilLogo } from "@/components/VeilLogo";
import { getOrCreateClient, ensureRegistered, readScopedInvoice } from "@/lib/umbra";
import { fetchInvoicesByCreator } from "@/lib/anchor";

interface AuditInvoiceRow {
  pda: string;
  metadataUri: string;
  createdAt: number;
  status: "Pending" | "Paid" | "Cancelled" | "Expired";
  decryption: DecryptionState;
}

type DecryptionState =
  | { kind: "idle" }
  | { kind: "requesting" }
  | { kind: "pending"; handlerSignature: string }
  | { kind: "failed"; error: string };

export default function AuditPage() {
  const params = useParams();
  const wallet = useWallet();
  const granterParam = typeof params.granter === "string" ? params.granter : "";

  const [rows, setRows] = useState<AuditInvoiceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [granterPubkey, setGranterPubkey] = useState<PublicKey | null>(null);

  // Validate the route param on mount.
  useEffect(() => {
    try {
      const pk = new PublicKey(granterParam);
      setGranterPubkey(pk);
      setError(null);
    } catch {
      setError(`Invalid granter address in URL: "${granterParam}"`);
      setGranterPubkey(null);
    }
  }, [granterParam]);

  const loadInvoices = useCallback(async () => {
    if (!wallet.connected || !granterPubkey) return;
    setLoading(true);
    setError(null);
    try {
      const raw = await fetchInvoicesByCreator(wallet as any, granterPubkey);
      const next: AuditInvoiceRow[] = raw.map((r: any) => ({
        pda: r.publicKey.toBase58(),
        metadataUri: r.account.metadataUri ?? "",
        createdAt: Number(r.account.createdAt ?? 0),
        status: normalizeStatus(r.account.status),
        decryption: { kind: "idle" },
      }));
      setRows(next);
    } catch (err: any) {
      setError(`Failed to load invoices: ${err.message ?? String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [wallet, granterPubkey]);

  useEffect(() => {
    void loadInvoices();
  }, [loadInvoices]);

  const requestDecryption = useCallback(
    async (row: AuditInvoiceRow) => {
      if (!granterPubkey) return;
      setRows((prev) =>
        prev.map((r) => (r.pda === row.pda ? { ...r, decryption: { kind: "requesting" } } : r)),
      );
      try {
        const client = await getOrCreateClient(wallet as any);
        await ensureRegistered(client);

        // Auditor derives their own X25519 pubkey (same function granter uses).
        const deriveMvk = getMasterViewingKeyX25519KeypairDeriver({ client });
        const mvkResult = await deriveMvk();
        const receiverX25519 = mvkResult.x25519Keypair.publicKey;

        // Granter X25519: fetched off the granter's on-chain user account via
        // the SDK's user-account querier. Done once per page load (memoized via
        // React state) — for brevity here we re-derive per invoice, which is
        // cheap (one getAccountInfo).
        const granterX25519 = await fetchGranterX25519(client, granterPubkey);

        // Ciphertexts + nonces: in this MVP the invoice metadata on Arweave is
        // itself AES-GCM encrypted with a per-invoice symmetric key that we
        // need to encrypt to the granter's X25519 key via Umbra shared-mode at
        // create-invoice time. That plumbing lives in a follow-up task;
        // for now the demo flow assumes the metadata hash (32 bytes) of the
        // invoice PDA is the "ciphertext" the auditor re-encrypts to prove the
        // grant wiring works end-to-end. Grant nonce and input nonce default
        // to the invoice's createdAt slot as a stable per-invoice value.
        const metadataHash = bs58.decode(row.pda); // 32 bytes
        const result = await readScopedInvoice({
          client,
          granterX25519PubKey: granterX25519,
          receiverX25519PubKey: receiverX25519,
          grantNonce: BigInt(row.createdAt),
          inputNonce: BigInt(row.createdAt),
          ciphertexts: [metadataHash],
        });

        setRows((prev) =>
          prev.map((r) =>
            r.pda === row.pda
              ? {
                  ...r,
                  decryption: { kind: "pending", handlerSignature: result.handlerSignature },
                }
              : r,
          ),
        );
      } catch (err: any) {
        setRows((prev) =>
          prev.map((r) =>
            r.pda === row.pda
              ? { ...r, decryption: { kind: "failed", error: err.message ?? String(err) } }
              : r,
          ),
        );
      }
    },
    [wallet, granterPubkey],
  );

  const header = useMemo(() => truncate(granterParam), [granterParam]);

  if (!wallet.connected) {
    return (
      <Shell>
        <div className="max-w-lg reveal">
          <span className="eyebrow">Audit view</span>
          <h1 className="mt-4 font-sans font-medium text-ink text-[36px] md:text-[44px] leading-[1.05] tracking-[-0.025em]">
            Connect to decrypt.
          </h1>
          <p className="mt-5 text-[14px] text-ink/70">
            You&apos;re viewing invoices issued by{" "}
            <span className="font-mono text-ink">{header}</span>. Connect your
            auditor wallet to decrypt entries covered by your grant.
          </p>
          <div className="mt-8">
            <ClientWalletMultiButton />
          </div>
        </div>
      </Shell>
    );
  }

  if (error) {
    return (
      <Shell>
        <div className="max-w-lg reveal">
          <span className="eyebrow text-brick">Error</span>
          <p className="mt-4 text-[14px] text-ink/80">{error}</p>
        </div>
      </Shell>
    );
  }

  if (loading) {
    return (
      <Shell>
        <div className="max-w-lg reveal">
          <p className="text-[14px] text-dim">Loading invoices…</p>
        </div>
      </Shell>
    );
  }

  if (rows.length === 0) {
    return (
      <Shell>
        <div className="max-w-lg reveal">
          <span className="eyebrow">Audit view</span>
          <h1 className="mt-4 font-sans font-medium text-ink text-[28px]">
            No invoices under your grant.
          </h1>
          <p className="mt-4 text-[13.5px] text-ink/70 leading-relaxed">
            The granter <span className="font-mono">{header}</span> has not issued
            invoices your grant can decrypt, or no grant exists for your wallet
            against this granter. Ask them to issue one at{" "}
            <span className="font-mono">/dashboard/compliance</span>.
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="max-w-3xl reveal">
        <span className="eyebrow">Audit view</span>
        <h1 className="mt-3 font-sans font-medium text-ink text-[36px] md:text-[44px] leading-[1.05] tracking-[-0.025em]">
          Granter <span className="font-mono text-[28px]">{header}</span>
        </h1>
        <p className="mt-5 text-[15px] leading-[1.55] text-ink/70 max-w-xl">
          {rows.length} invoices issued by this granter. Click a row to request
          re-encryption under your grant.
        </p>

        <ul className="mt-10 border border-line rounded-[4px] bg-paper-3 divide-y divide-line">
          {rows.map((r) => (
            <li key={r.pda} className="px-5 md:px-6 py-4">
              <div className="flex items-baseline justify-between gap-4">
                <div className="flex items-baseline gap-5 min-w-0">
                  <span className="font-mono text-[11px] text-dim tnum shrink-0">
                    {formatDate(r.createdAt)}
                  </span>
                  <span className="font-mono text-[13px] text-ink truncate">
                    {truncate(r.pda)}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <StatusBadge status={r.status} />
                  <DecryptionButton row={r} onClick={() => requestDecryption(r)} />
                </div>
              </div>
              {r.decryption.kind === "pending" && (
                <div className="mt-3 text-[12px] font-mono text-muted">
                  Re-encryption pending — handler sig {truncate(r.decryption.handlerSignature)}. The
                  Arcium MPC callback will populate the decrypted blob on the next
                  indexer refresh (follow-up task).
                </div>
              )}
              {r.decryption.kind === "failed" && (
                <div className="mt-3 text-[12px] text-brick">{r.decryption.error}</div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Shell>
  );
}

async function fetchGranterX25519(
  client: any,
  granter: PublicKey,
): Promise<Uint8Array> {
  // The granter's X25519 pubkey lives on their EncryptedUserAccount PDA.
  // The SDK's getUserAccountQuerierFunction returns the 32-byte key when the
  // account is fully registered.
  const { getUserAccountQuerierFunction } = await import("@umbra-privacy/sdk");
  const query = getUserAccountQuerierFunction({ client });
  const result: any = await query(granter.toBase58() as any);
  if (result.state !== "exists") {
    throw new Error("Granter has not registered with Umbra yet — cannot audit.");
  }
  // Field name on the SDK's EncryptedUserAccount type: `userAccountX25519PublicKey`.
  const key = result.data.userAccountX25519PublicKey;
  if (!(key instanceof Uint8Array) || key.length !== 32) {
    throw new Error("Granter's X25519 pubkey is not 32 bytes — account is corrupt.");
  }
  return key;
}

function normalizeStatus(raw: any): AuditInvoiceRow["status"] {
  if (!raw) return "Pending";
  if (typeof raw === "string") {
    const normalized = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
    if (["Pending", "Paid", "Cancelled", "Expired"].includes(normalized)) {
      return normalized as AuditInvoiceRow["status"];
    }
  }
  if (typeof raw === "object") {
    if ("pending" in raw) return "Pending";
    if ("paid" in raw) return "Paid";
    if ("cancelled" in raw) return "Cancelled";
    if ("expired" in raw) return "Expired";
  }
  return "Pending";
}

function truncate(s: string): string {
  if (s.length <= 10) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function formatDate(ts: number): string {
  const d = new Date(ts * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    Pending: "border-gold/40 text-gold bg-gold/5",
    Paid: "border-sage/40 text-sage bg-sage/5",
    Cancelled: "border-line-2 text-muted bg-paper-2/40",
    Expired: "border-brick/40 text-brick bg-brick/5",
  };
  return (
    <span
      className={`inline-block px-2.5 py-1 border rounded-[2px] font-mono text-[10.5px] tracking-[0.12em] uppercase ${styles[status] ?? ""}`}
    >
      {status}
    </span>
  );
}

function DecryptionButton({
  row,
  onClick,
}: {
  row: AuditInvoiceRow;
  onClick: () => void;
}) {
  if (row.decryption.kind === "requesting") {
    return (
      <span className="font-mono text-[11px] text-dim">Requesting…</span>
    );
  }
  if (row.decryption.kind === "pending") {
    return <span className="font-mono text-[11px] text-gold">Pending MPC</span>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="btn-quiet text-[12px]"
    >
      Decrypt
    </button>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen relative pb-32">
      <nav className="sticky top-0 z-10 backdrop-blur-sm bg-paper/80 border-b border-line">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between px-6 md:px-8 py-4">
          <VeilLogo tagline="audit view" />
          <ClientWalletMultiButton />
        </div>
      </nav>
      <section className="max-w-[1400px] mx-auto px-6 md:px-8 pt-16 md:pt-20">{children}</section>
    </main>
  );
}
