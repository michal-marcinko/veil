"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { ClientWalletMultiButton } from "@/components/ClientWalletMultiButton";
import bs58 from "bs58";
// NOTE: The caller prompt referenced `getMasterViewingKeyX25519KeypairGenerator`,
// but the actual SDK export (verified in node_modules/@umbra-privacy/sdk/dist/crypto/index.d.ts)
// is `getMasterViewingKeyX25519KeypairDeriver`. Same semantics: client-side derivation
// that returns a zero-arg function producing a Curve25519KeypairResult with
// { ed25519Keypair, x25519Keypair }.
import { getMasterViewingKeyX25519KeypairDeriver } from "@umbra-privacy/sdk";
import {
  ComplianceGrantForm,
  type ComplianceGrantFormValues,
} from "@/components/ComplianceGrantForm";
import {
  getOrCreateClient,
  ensureRegistered,
  issueComplianceGrant,
} from "@/lib/umbra";

interface GrantResult {
  receiverAddress: string;
  nonce: bigint;
  signature: string;
}

export default function CompliancePage() {
  const wallet = useWallet();
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<GrantResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleGrant(values: ComplianceGrantFormValues) {
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const client = await getOrCreateClient(wallet as any);
      await ensureRegistered(client);

      // Decode + validate the auditor's X25519 pubkey.
      const receiverBytes = bs58.decode(values.receiverX25519PubKey);
      if (receiverBytes.length !== 32) {
        throw new Error(
          `X25519 public key must be 32 bytes after base58 decode (got ${receiverBytes.length})`,
        );
      }

      // Derive the granter's own MVK X25519 pubkey client-side (cheap, no on-chain call).
      const deriveMvk = getMasterViewingKeyX25519KeypairDeriver({ client });
      const mvkResult = await deriveMvk();
      const granterX25519 = mvkResult.x25519Keypair.publicKey;

      // Generate a nonce we can display back to the user to share with the auditor.
      const nonce = BigInt(Date.now());

      const signature = await issueComplianceGrant({
        client,
        receiverAddress: values.receiverAddress,
        granterX25519PubKey: granterX25519,
        receiverX25519PubKey: new Uint8Array(receiverBytes),
        nonce,
      });

      setResult({
        receiverAddress: values.receiverAddress,
        nonce,
        signature,
      });
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (!wallet.connected) {
    return (
      <main className="min-h-screen p-8 max-w-2xl mx-auto">
        <h1 className="text-3xl font-bold mb-6">Compliance Grants</h1>
        <p className="mb-4">Connect wallet to manage grants.</p>
        <ClientWalletMultiButton />
      </main>
    );
  }

  return (
    <main className="min-h-screen p-8 max-w-2xl mx-auto">
      <h1 className="text-3xl font-bold mb-6">Compliance Grants</h1>
      <p className="text-gray-400 mb-6">
        Grant read-only access to your encrypted transactions to an auditor or
        accountant. You will be prompted to sign a transaction.
      </p>

      {error && (
        <div className="bg-red-900/30 border border-red-700 p-3 rounded mb-4 text-red-200">
          {error}
        </div>
      )}

      {result && (
        <div className="bg-green-900/30 border border-green-700 p-4 rounded mb-6 text-green-200 space-y-2">
          <p className="font-medium">Grant created successfully.</p>
          <p className="text-sm">
            Share the following details with your auditor so they can decrypt
            the scoped ciphertexts:
          </p>
          <dl className="text-xs font-mono bg-black/40 p-3 rounded space-y-1">
            <div>
              <dt className="inline text-gray-400">Auditor wallet: </dt>
              <dd className="inline break-all">{result.receiverAddress}</dd>
            </div>
            <div>
              <dt className="inline text-gray-400">Grant nonce: </dt>
              <dd className="inline break-all">{result.nonce.toString()}</dd>
            </div>
            <div>
              <dt className="inline text-gray-400">Transaction: </dt>
              <dd className="inline break-all">{result.signature}</dd>
            </div>
          </dl>
        </div>
      )}

      <ComplianceGrantForm onSubmit={handleGrant} submitting={submitting} />
    </main>
  );
}
