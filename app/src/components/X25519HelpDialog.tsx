"use client";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function X25519HelpDialog({ open, onClose }: Props) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      data-testid="help-dialog-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="x25519-help-title"
        className="bg-paper border border-line rounded-[4px] max-w-lg w-full p-6 md:p-8 shadow-[0_30px_80px_-40px_rgba(26,24,20,0.4)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="x25519-help-title"
          className="font-sans font-medium text-ink text-[22px] leading-[1.15] tracking-[-0.02em]"
        >
          How the auditor obtains their X25519 key
        </h2>
        <div className="mt-4 space-y-3 text-[13.5px] text-ink/80 leading-relaxed">
          <p>
            Your auditor generates this via{" "}
            <code className="font-mono text-[12.5px] bg-paper-2 px-1.5 py-0.5 rounded-[2px]">
              getMasterViewingKeyX25519KeypairDeriver
            </code>{" "}
            after their Umbra registration.
          </p>
          <p>
            Ask them to share the{" "}
            <strong className="text-ink">32-byte base58 public key</strong> —
            <strong className="text-brick"> not the secret</strong>.
          </p>
          <p className="text-[12.5px] text-dim">
            Auditor-side snippet:
          </p>
          <pre className="font-mono text-[11.5px] bg-paper-2 border border-line rounded-[2px] p-3 overflow-x-auto">{`import { getMasterViewingKeyX25519KeypairDeriver } from "@umbra-privacy/sdk";
import bs58 from "bs58";

const derive = getMasterViewingKeyX25519KeypairDeriver({ client });
const { x25519Keypair } = await derive();
console.log("Share this:", bs58.encode(x25519Keypair.publicKey));`}</pre>
          <p className="text-[12.5px] text-dim">
            If the auditor hasn&apos;t registered with Umbra yet, they must connect
            their wallet to Veil (or any Umbra-enabled app) and complete the
            three-step registration first.
          </p>
        </div>
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="btn-primary text-[13px]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
