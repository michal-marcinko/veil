"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import { VeilLogo } from "@/components/VeilLogo";
import bs58 from "bs58";
import { getMasterViewingKeyX25519KeypairDeriver } from "@umbra-privacy/sdk";
import {
  ComplianceGrantForm,
  type ComplianceGrantFormValues,
} from "@/components/ComplianceGrantForm";
import { GrantList } from "@/components/GrantList";
import {
  getOrCreateClient,
  ensureRegistered,
  issueComplianceGrant,
  listComplianceGrants,
  revokeComplianceGrant,
  type GrantWithStatus,
} from "@/lib/umbra";
import { getOrCreateMetadataMasterSig } from "@/lib/encryption";
import { buildAuditUrl } from "@/lib/umbra-auditor";

interface GrantResult {
  receiverAddress: string;
  nonce: bigint;
  signature: string;
  auditUrl: string;
}

export default function CompliancePage() {
  const wallet = useWallet();
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<GrantResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [grants, setGrants] = useState<GrantWithStatus[]>([]);
  const [grantsLoading, setGrantsLoading] = useState(false);
  const [revokingKey, setRevokingKey] = useState<string | null>(null);

  const refreshGrants = useCallback(async () => {
    if (!wallet.connected) {
      setGrants([]);
      return;
    }
    setGrantsLoading(true);
    try {
      const client = await getOrCreateClient(wallet as any);
      const list = await listComplianceGrants({ client });
      setGrants(list);
    } catch (err: any) {
      setError(`Failed to load grants: ${err.message ?? String(err)}`);
    } finally {
      setGrantsLoading(false);
    }
  }, [wallet]);

  useEffect(() => {
    void refreshGrants();
  }, [refreshGrants]);

  async function handleGrant(values: ComplianceGrantFormValues) {
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const client = await getOrCreateClient(wallet as any);
      await ensureRegistered(client);

      const receiverBytes = bs58.decode(values.receiverX25519PubKey);
      if (receiverBytes.length !== 32) {
        throw new Error(
          `X25519 public key must be 32 bytes after base58 decode (got ${receiverBytes.length})`,
        );
      }

      const deriveMvk = getMasterViewingKeyX25519KeypairDeriver({ client });
      const mvkResult = await deriveMvk();
      const granterX25519 = mvkResult.x25519Keypair.publicKey;

      const nonce = BigInt(Date.now());

      const signature = await issueComplianceGrant({
        client,
        receiverAddress: values.receiverAddress,
        granterX25519PubKey: granterX25519,
        receiverX25519PubKey: new Uint8Array(receiverBytes),
        nonce,
      });

      // Generate the audit URL Alice will share with Carol out-of-band.
      // The on-chain grant above proves authorization; the URL fragment
      // carries the metadata master signature so Carol can derive each
      // per-invoice AES key. Fragments aren't transmitted to servers, so
      // the key never hits Veil's infrastructure.
      const granterWallet = wallet.publicKey?.toBase58();
      if (!granterWallet) throw new Error("Wallet disconnected");
      const masterSig = await getOrCreateMetadataMasterSig(
        wallet as any,
        granterWallet,
      );
      const origin =
        typeof window !== "undefined" ? window.location.origin : "";
      const auditUrl = buildAuditUrl({
        origin,
        granterWallet,
        masterSig,
      });

      setResult({
        receiverAddress: values.receiverAddress,
        nonce,
        signature,
        auditUrl,
      });
      await refreshGrants();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRevoke(grant: GrantWithStatus) {
    const key = `${grant.receiverX25519Base58}:${grant.nonce}`;
    setRevokingKey(key);
    setError(null);
    try {
      const client = await getOrCreateClient(wallet as any);
      await revokeComplianceGrant({ client, grant });
      await refreshGrants();
    } catch (err: any) {
      setError(`Revoke failed: ${err.message ?? String(err)}`);
    } finally {
      setRevokingKey(null);
    }
  }

  if (!wallet.connected) {
    return (
      <Shell>
        <div className="max-w-lg reveal">
          <span className="eyebrow">Auditor grants</span>
          <h1 className="mt-4 font-sans font-medium text-ink text-[36px] md:text-[44px] leading-[1.05] tracking-[-0.025em]">
            Connect to manage grants.
          </h1>
          <div className="mt-8">
            <ClientWalletMultiButton />
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="max-w-2xl reveal">
        <span className="eyebrow">Auditor grants</span>
        <h1 className="mt-3 font-sans font-medium text-ink text-[36px] md:text-[44px] leading-[1.05] tracking-[-0.025em]">
          Grant read-only access.
        </h1>
        <p className="mt-5 text-[15px] leading-[1.55] text-ink/70 max-w-xl">
          Give an auditor or accountant a scoped view of your encrypted transactions.
          You&apos;ll sign one transaction. You can revoke — but prior disclosures are
          permanent.
        </p>

        {error && (
          <div className="mt-8 flex items-start gap-4 border-l-2 border-brick pl-4 py-2 max-w-xl">
            <span className="mono-chip text-brick shrink-0 pt-0.5">Error</span>
            <span className="text-[13.5px] text-ink leading-relaxed flex-1">{error}</span>
          </div>
        )}

        {result && (
          <div className="mt-8 border border-sage/40 bg-sage/5 rounded-[3px] p-5 md:p-6 max-w-xl">
            <div className="flex items-baseline justify-between mb-4">
              <span className="eyebrow text-sage">Grant created</span>
            </div>
            <p className="text-[13.5px] text-ink/80 leading-relaxed">
              Share the following with your auditor so they can decrypt the scoped
              ciphertexts.
            </p>
            <dl className="mt-5 space-y-3 text-[12.5px] font-mono border-t border-line pt-4">
              <ResultRow label="Wallet" value={result.receiverAddress} />
              <ResultRow label="Nonce" value={result.nonce.toString()} />
              <ResultRow label="Signature" value={result.signature} />
            </dl>
          </div>
        )}

        <div className="mt-10 pt-8 border-t border-line">
          <ComplianceGrantForm
            onSubmit={handleGrant}
            submitting={submitting}
            auditUrl={result?.auditUrl ?? null}
          />
        </div>

        <div className="mt-12 pt-8 border-t border-line">
          {grantsLoading ? (
            <div className="text-[13px] text-dim">Loading grants…</div>
          ) : (
            <GrantList
              grants={grants}
              onRevoke={handleRevoke}
              revokingKey={revokingKey}
            />
          )}
        </div>
      </div>
    </Shell>
  );
}

function ResultRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-4">
      <dt className="text-dim uppercase tracking-[0.12em] text-[10.5px] w-20 shrink-0">
        {label}
      </dt>
      <dd className="text-ink break-all flex-1">{value}</dd>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen relative pb-32">
      <nav className="sticky top-0 z-10 backdrop-blur-sm bg-paper/80 border-b border-line">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between px-6 md:px-8 py-4">
          <VeilLogo />
          <div className="flex items-center gap-1 md:gap-2">
            <a
              href="/create"
              className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors"
            >
              Create
            </a>
            <a
              href="/dashboard"
              className="hidden sm:inline-block px-3 py-2 text-[13px] text-muted hover:text-ink transition-colors"
            >
              Dashboard
            </a>
            <div className="ml-2">
              <ClientWalletMultiButton />
            </div>
          </div>
        </div>
      </nav>

      <section className="max-w-[1400px] mx-auto px-6 md:px-8 pt-16 md:pt-20">{children}</section>
    </main>
  );
}
