# Blowfish trust-and-safety review request — email draft

**To:** `review@blowfish.xyz`

**Subject:** Domain & program review request — Veil (private invoicing on Solana)

---

Hi Blowfish team,

Reaching out to request review and allowlist queueing for our project ahead of mainnet launch.

**Project:** Veil — private invoicing on Solana
**Built for:** Colosseum Frontier Hackathon, May 2026
**Repo:** https://github.com/michal-marcinko/veil
**Devnet site:** https://veil-app-205.netlify.app
**Mainnet domain:** TBD (will follow up when registered)

**Programs:**

- VeilPay (Anchor wrapper, our program): `E2G6dN7yY8VQ2dFRgkvqskdAnPhJXkdorYP6BhKvfa8m` (devnet)
- Umbra Privacy (dependency): `DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ` (devnet)

**What it does:**

VeilPay is a stateless Anchor program that performs CPI into Umbra Privacy's deposit primitives within a single atomic Solana transaction. This collapses the standard 2-transaction private-payment flow into one signature, enabling single-popup UX for users paying private invoices.

**Why we're emailing:**

On Phantom, our transactions trigger "Failed to simulate the results of this request" plus the "Confirm (unsafe)" gate. We've verified the cause is Blowfish's simulation pipeline not handling our unverified-on-devnet program with bn254 pairing checks (Groth16 proof verification). Solflare simulates the same transactions cleanly via raw RPC `simulateTransaction`, displaying the actual SOL outflow with a USD valuation. We've confirmed via Phantom's GitHub discussions (#264, #209) that there's no dApp-side fix and that the path forward is direct outreach to your trust-and-safety team.

**Asks:**

1. Could you queue VeilPay for review at our mainnet launch, so Phantom users get clean simulation UX from day one?
2. Any guidance on documentation, audits, or other materials we should prepare to expedite review?

Happy to share the Anchor IDL, source code, design spec, and answer any technical questions about the CPI pattern or the underlying Umbra integration.

Thanks,
Michal Marcinko
michalmarcinko@gmail.com
