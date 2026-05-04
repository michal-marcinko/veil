# X402 + Umbra — Veil v0.2 Roadmap

**Researched:** 2026-05-04
**Status:** Reference document for v0.2 planning + hackathon submission narrative.
**Source documents:**
- Protocol deep-dive: [`2026-05-04-x402-protocol-research.md`](./2026-05-04-x402-protocol-research.md)
- Real-world use cases: [`2026-05-04-x402-use-cases.md`](./2026-05-04-x402-use-cases.md)

---

## TL;DR

X402 is the HTTP-native payment standard the AI agent economy is converging on. The Linux Foundation x402 Foundation (April 2026) includes Coinbase, Cloudflare, Stripe, Shopify, Solana, AWS, Google, Microsoft, Visa, Mastercard, Anthropic, Circle, and Vercel — institutional weight is real. **But** the on-chain privacy gap is officially acknowledged: AWS's own partner blog warns that "competitor intelligence about your agent's vendor relationships is publicly accessible." Three competing privacy-x402 projects already exist (PRXVT/px402 ZK, ZK-X402, Fhenix FHE). Veil's edge: **Umbra/Arcium MPC + Solana-native + USDC settlement, wired into our existing privacy primitives** (encrypted invoices + claim links + scoped viewing keys). The right v0.2 wedge is **B2B agent procurement**, not retail content paywalls — larger $/call makes the Umbra fee rational, and it maps directly to Veil's existing private-invoicing positioning.

---

## Part 1 — Protocol summary

### What it is

HTTP status code 402 ("Payment Required") was reserved in the original 1991 spec but sat unused for 30 years. **X402** is its 2024-2025 revival as a standard for HTTP-native crypto payments — request → 402 with payment instructions → client pays → retry with proof → server validates → 200 with content.

### Spec status

**Implementation-defined**, not an RFC yet. Canonical home is the `coinbase/x402` GitHub repo (transitioning to `x402-foundation/x402` under the Linux Foundation). Apache-2.0. Three reference SDKs (TypeScript, Python, Go) + community implementations in Rust, Java, .NET.

### Two finalized schemes

- **`exact`** — fixed price, single-shot. The most common pattern.
- **`upto`** — capped price, server can settle for less. Useful for streaming/metered usage.
- **`deferred`** — Cloudflare-led, in flight. Lets the server defer settlement until end of session.

### Wire protocol

Three base64-encoded HTTP headers carry the entire flow:
- `PAYMENT-REQUIRED` (server → client) — what to pay, where, on which chain
- `PAYMENT-SIGNATURE` (client → server) — signed payment authorization
- `PAYMENT-RESPONSE` (server → client) — settlement confirmation

First-request latency penalty: ~1-2 seconds (the 402 → pay → retry round-trip).

### How payments actually settle

- **EVM**: EIP-3009 `transferWithAuthorization` (USDC/EURC) — the primary path. Permit2 and ERC-7710 fallbacks. Random `bytes32` nonces stored on-chain in the token contract = bulletproof replay protection.
- **Solana**: SPL `TransferChecked` with partial signing — client signs the payer side, the **facilitator** co-signs and submits to the network.

### The facilitator model

A facilitator is a non-custodial third-party service that runs `/verify` and `/settle` endpoints. The server doesn't validate payments itself — it asks the facilitator. CDP (Coinbase Developer Platform) offers a free tier (1k tx/month) then $0.001/tx. ~40+ facilitators in the public registry.

Solana facilitator share is heavily concentrated: **Dexter and PayAI dominate ~99%** of the volume.

### Volume reality check

Cumulative numbers since summer 2025:
- **>35M transactions, >$10M settled** (protocol-research agent)
- **120M+ transactions, $41M+ volume** (use-cases agent — broader figure including Foundation members' totals)

But CoinDesk reports **~$28K/day in real volume** against a "$7B ecosystem valuation." Stepdata found **>78% of peak transactions were non-organic**. **Narrative is significantly ahead of demand.** This is normal for early-stage standards — x402 is real but small. Long-term thesis is solid; short-term volume is hype.

### Server integration cost

**~15 LOC** for an Express middleware. Client-side: a one-line `wrapFetchWithPayment(fetch, signer)` gives you a drop-in fetch replacement. Production-ready but young — Halborn published a 2026 security review flagging replay/MITM/facilitator concerns (all addressable but worth tracking). **Don't bake in schema stability >12 months without re-audit.**

### Competing standards

- **L402** — Bitcoin/Lightning, 2020. Niche, never crossed the chasm.
- **MPP (Multi-Payment Protocol)** — Stripe + Tempo, March 2026. Session-based, multi-rail. Positioned as backwards-compatible — *can use x402 as its underlying rail.*
- **Google AP2** — agent payment authorization, framed as complementary to x402 (authorization vs execution).
- **Visa TAP / Mastercard ACP** — incumbent payment networks staking claims.

For a Solana-native privacy dApp, **x402 is the right target**. MPP and AP2 may layer on top of it; the rail itself is x402.

---

## Part 2 — Real-world adoption

### Who's actually shipping

**Production deployments:**
- **Browserbase** — cloud browsers paying for compute via x402 (AI agents browsing the web)
- **Hyperbolic + GPU-Bridge** — per-inference GPU rental, x402-gated
- **OpenMind + Circle** — robots paying for their own electricity (Silicon Valley pilot)
- **Anthropic MCP** — tool-call gating with x402 authentication
- **Nansen / Messari** — data marketplaces with per-query payment
- **Apexti** — 1,500+ Web3 APIs wrapped with x402

**On Solana specifically:** Dexter and PayAI facilitators handle ~99% of volume. Direct integrations with Veil's stack are already feasible.

### Use case categories ranked by traction

1. **Agent-to-agent MCP flows** — Anthropic-blessed, high call volume, fastest-growing
2. **AI inference (LLM, GPU)** — concrete monetization, clear price-per-call
3. **Data marketplaces** — Nansen/Messari proven, low CAC for privacy add-on
4. **Cloud browsers / compute** — niche but high $/call (Browserbase)
5. **B2B microservices** — early but emerging (internal API monetization)
6. **Retail content paywalls** — slow, BAT/Brave history shows users don't want this
7. **IoT / sensors** — long-term thesis, near-term vapor (OpenMind robots are a one-off)

### Investor thesis

a16z crypto led the **$18M Catena Labs** round (Sean Neville — Circle co-founder). a16z's portfolio in adjacent space: **Paid.ai, Nekuda, Payman**. Public framing from Chris Dixon-adjacent voices: agent commerce may "spell the end of internet ads."

VCs see the AI-agent-economy thesis as one of the biggest crypto verticals over the next 5 years. This is real money chasing the space, not just narrative.

### The privacy gap — officially acknowledged

AWS's own partner blog warns:
> *"Competitor intelligence about your agent's vendor relationships is publicly accessible. Pricing, frequency, and supply chain leak to anyone watching the chain."*

This is the wedge for any privacy-x402 product.

### Existing privacy-x402 competitors

| Project | Approach | Status |
|---|---|---|
| **PRXVT / px402** | ZK proofs + burner wallets | Listed on x402.org, working code |
| **ZK-X402** | Zero-knowledge payment proofs | Active development |
| **Fhenix** | Fully homomorphic encryption (FHE) | Critique-style, less practical |

**Veil is competing, not creating.** Differentiation:
- **Umbra/Arcium MPC** vs pure ZK — different trust assumptions, faster settlement
- **Solana-native + USDC** — fastest finality, deepest stablecoin liquidity
- **Existing primitive stack** — encrypted invoices + claim links + scoped viewing keys = three orthogonal privacy tools that compose
- **Editorial brand** — most privacy-crypto products look like CLI tools or brutalist Telegram bots. Veil reads as a Mercury-tier product. Trust signal for B2B.

---

## Part 3 — Veil's three privacy injection points

From the protocol-research doc, three concrete places where Umbra-style privacy plugs into x402:

### A. Payer blinding (highest impact)

**Problem:** stock x402 reveals payer wallet on-chain in every settlement. Anyone watching the chain can build a profile of which APIs an agent calls.

**Veil solution:** the payer settles via Umbra's stealth pool. The on-chain settlement shows a deposit-from-mixer event, not a direct payer→recipient transfer. Server still verifies the payment landed (via signed receipt or scan), but can't link it back to the agent's identity.

**Implementation cost:** medium. Requires our `payInvoice` flow (already shipped via VeilPay) to be wrapped in an x402-compatible verification layer. Server-side facilitator needs to verify Umbra deposits rather than direct token transfers.

### B. Stealth recipients (medium impact)

**Problem:** stock x402 reveals server's recipient wallet. Competitors can identify your business model by watching which addresses you accept payments at.

**Veil solution:** server publishes a stealth address per request (or rotates), payer encrypts to that address. We already have this primitive — Umbra receiver-claimable UTXOs.

**Implementation cost:** low-medium. Reuses existing Umbra deposit primitive; the new bit is the x402 header carrying the stealth recipient instead of a static address.

### C. Facilitator-blind mode (highest sophistication)

**Problem:** the facilitator (Coinbase CDP, Dexter, PayAI) sees both the payer wallet AND the resource URL — strongest correlator in the entire stack. Even if the on-chain settlement is private, the facilitator has full visibility.

**Veil solution:** a Veil-operated facilitator that runs Umbra verification logic. Instead of seeing wallet+URL pairs, it sees Umbra commitment-hash + URL pairs. The actual wallet identity is decoupled from the verification step.

**Implementation cost:** high. Requires running Veil-operated facilitator infrastructure. Long-term play, not v0.2.

---

## Part 4 — Veil v0.2 integration plan

### Recommended wedge: **B2B agent procurement**

Why this wedge over retail content paywalls or AI inference:

1. **$/call is large enough to justify Umbra's ~35bps fee.** A $0.001 micropayment can't absorb 35bps gracefully. A $1-100 B2B procurement transaction can.
2. **Concrete competitive harm.** Stripe Atlas already shows companies paying for SaaS via crypto rails. Their vendor relationships ARE on-chain. This is a real, present problem with named victims.
3. **Maps to Veil's existing positioning.** We already pitched Veil as "private financial infrastructure for businesses" — agent-to-agent B2B procurement is the same buyer at a higher transaction frequency.
4. **AWS already validates the wedge.** Their partner blog explicitly warns about this exact harm.
5. **No retail UX battle.** Retail users (Brave/BAT history) don't want to pay per-page. B2B buyers don't have a choice — they'd rather pay than have their vendor list leaked.

Secondary wedges to keep in roadmap (post v0.2):
- **Agent-to-agent MCP flows** (Anthropic blessing, high volume)
- **AI inference reveal-blocking** — AI startups leak model + workload through public payment trails (= their AWS bill in real time)

### Architecture: what we'd build

**v0.2 — Functional MVP (~2-3 weeks of focused work)**

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  Veil x402 Server SDK                                           │
│  - x402-veil-express (Express middleware, ~100 LOC)             │
│  - x402-veil-fastify (Fastify plugin, ~80 LOC)                  │
│                                                                 │
│  Veil x402 Client SDK                                           │
│  - x402-veil-fetch (drop-in fetch wrapper, ~80 LOC)             │
│  - x402-veil-axios (axios interceptor, ~60 LOC)                 │
│                                                                 │
│  Veil Privacy Layer                                             │
│  - Reuses existing payInvoice / VeilPay CPI                     │
│  - Reuses existing claim-link primitive for unregistered        │
│    recipients (anyone with a wallet can receive)                │
│  - New: x402 payment header parser + Umbra deposit constructor  │
│                                                                 │
│  Verification Layer                                             │
│  - Server fetches the Umbra UTXO indexer for incoming UTXOs     │
│  - Validates the signed receipt matches the request hash        │
│  - Replay protection: nonce in the request hash                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**v0.3 — Facilitator-blind mode (~4-6 weeks)**

Run a Veil-operated facilitator that handles `/verify` and `/settle` for x402-compatible servers. This is the "decouple facilitator from wallet identity" play. Big infrastructure investment but moat-building.

### Effort estimates (v0.2)

| Component | Effort | Risk |
|---|---|---|
| Server middleware (Express + Fastify) | 1 week | Low |
| Client SDKs (fetch + axios) | 3 days | Low |
| Veil payment proof construction | 1 week | Medium (Umbra-side replay protection) |
| Verification: indexer scan + signed receipts | 1 week | Medium-high (subtle correctness bugs) |
| Demo paywall app + docs | 3 days | Low |
| Security review (Halborn-style) | 1-2 weeks | External dep |

**Total: ~3-4 weeks of focused engineering for a credible v0.2.** Add another 2-4 weeks for security review before any production launch.

### Demo strategy (v0.2 launch)

When v0.2 ships:
1. **Live demo at one major conference** (Solana Breakpoint or ETH Denver). On-stage: an AI agent makes 50 calls to a paid API in 60 seconds, all settled via x402 over Umbra. Show the on-chain trace: zero wallet linkage, zero amount visibility.
2. **Open-source SDKs from day 1.** Apache-2.0, on GitHub under `veil-app/` org. Lower adoption friction.
3. **Reference integrations** — port one real x402 server (probably Browserbase or a Hyperbolic clone) to use Veil rails. Show the privacy diff side-by-side.
4. **Get on x402.org's listed implementations.** PRXVT/px402 is listed; Veil should be too.

### What changes for the hackathon submission

**Minimal — just narrative.** Add to README + demo video:

> *"Veil's three privacy primitives — encrypted invoices, claim links, scoped viewing keys — extend naturally to x402 confidential micropayments. The AI agent economy is converging on x402 as the HTTP-native payment standard, and AWS itself has acknowledged the privacy gap: an agent's vendor relationships are visible to any chain observer. v0.2 ships Veil's x402 SDKs. We've documented the integration plan and have a credible 3-4 week engineering path to a live SDK."*

This costs zero engineering hours but signals to judges that you've thought through the post-hackathon roadmap concretely. Reference to the consolidated doc as evidence.

If you want to ship something X402-flavored DURING the hackathon to tick the 7th category:
- **Skip the full SDK.** Don't try to build x402 server middleware in remaining hours.
- **Ship a single paywall demo page** at `/x402-demo` showing the pattern: a paywalled article that requires a Veil payment to unlock, conceptually identical to what x402 servers do but using existing Veil rails directly. ~4-6h of work.
- **Honest framing in the demo:** *"This is the x402 pattern using Veil's existing primitives. The full SDK ships in v0.2 with proper x402 spec compliance."*

### What NOT to do (anti-patterns)

- **Don't claim full x402 spec compliance for a hackathon demo.** Half-baked claims here will get caught by judges who actually use x402.
- **Don't pivot the existing demo around x402.** Your B2B invoicing + payroll + gift cards + products + compliance story is already strong (6/7 categories). x402 is the natural extension, not a replacement.
- **Don't build it in the worktree right now.** Plan, document, ship the demo paywall if you want — but full x402 work is post-hackathon.

---

## Part 5 — Risks and tradeoffs

### Risks

1. **Standards war.** x402 might lose to MPP, AP2, or an incumbent (Visa TAP, Mastercard ACP). **Mitigation:** make Veil's privacy primitive chain-agnostic. The payment standard becomes a thin adapter layer.
2. **Volume is currently fake.** $28K/day organic vs $41M cumulative claimed. Coinbase/CDP have incentive to inflate. **Mitigation:** wait for real organic volume signal before infrastructure investment beyond v0.2.
3. **Facilitator centralization.** ~99% of Solana facilitator volume goes to 2 providers (Dexter + PayAI). Veil-operated facilitator (v0.3) is the right hedge but expensive to operate.
4. **Privacy competitors already exist.** PRXVT/px402, ZK-X402, Fhenix. **Mitigation:** ship on different trust model (MPC) + better DX (Solana-native) + better brand (Mercury-tier B2B).
5. **Spec instability.** Halborn flagged replay/MITM/facilitator concerns. Spec evolving rapidly. **Mitigation:** don't bake in schema stability >12 months without re-audit.

### Tradeoffs

- **Privacy adds latency.** Umbra deposits are slower than direct token transfers (~5-15s vs ~1s for plain x402). For B2B procurement (the wedge) that's fine. For agent-to-agent MCP at 1000 calls/sec, it's prohibitive without optimization.
- **Privacy adds cost.** ~35bps Umbra fee + Solana tx fee. Acceptable for $1-100 transactions, prohibitive for $0.001 micropayments. Reinforces the B2B wedge over retail.
- **Privacy reduces facilitator flexibility.** Veil-operated facilitator (v0.3) is required for facilitator-blind mode. Limits us to running infrastructure that x402's open-facilitator model doesn't require.

---

## Part 6 — Decision matrix

| Path | Effort | Hackathon Value | Long-term Value |
|---|---|---|---|
| **Document only** (this doc) | 0 (done) | High — adds 7th category as v0.2 roadmap | Medium — informs post-hackathon work |
| **Document + paywall demo** | +4-6h | High + actually-running surface | Medium |
| **Document + full v0.2 SDK** | +3-4 weeks | N/A (post-hackathon) | High — real moat |
| **Skip entirely** | 0 | Loses 7th category | Loses competitive position |

**Recommended: Document only for hackathon, plan v0.2 SDK for week 1 post-hackathon.** The doc itself + a strong README mention is enough to signal "we know about this and have a plan." Engineering time during the remaining hackathon hours is better spent on demo video + polish than on a half-baked x402 demo.

---

## Sources

- [`./2026-05-04-x402-protocol-research.md`](./2026-05-04-x402-protocol-research.md) — full technical deep-dive (~2,400 words)
- [`./2026-05-04-x402-use-cases.md`](./2026-05-04-x402-use-cases.md) — full real-world adoption (~2,400 words)
- All sources cited in those two source documents
