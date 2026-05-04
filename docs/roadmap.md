# Roadmap — what's deferred and why

> Last updated: 2026-05-04 (Frontier Hackathon submission window)

This document is the deliberate inverse of the demo: it records features
we built or designed but cut from the v1 product surface, plus features
on the table for v2. The framing is intentional — discipline about what
*not* to ship is often a clearer signal of product judgment than the
ship list itself.

The v1 demo surface is three cohesive B2B primitives:

- **Invoice** — bill one client privately, anchor the hash on Solana
- **Payroll** — pay many recipients via Umbra, sign one auditor packet
- **Storefront** — publish a product, customers buy from one URL

Everything below was considered against that spine.

---

## Cut from v1 — preserved in code, deferred for re-evaluation

### Private transfer (peer-to-peer single-recipient send)

**What it would have been:** a fourth picker tile letting a user send
USDC/SOL to anyone with a wallet. Recipient claims from a one-shot URL,
no Veil account required.

**Status:** built (`/send` and `/gift/[token]` routes), unlinked from
the main flow on 2026-05-04. Code is alive in the repo for possible
re-surfacing.

**Why cut:**

1. **Strictly a subset of Payroll.** The claim-link path inside Payroll
   already handles "send to someone who isn't registered with Umbra" —
   and it does so for one recipient as readily as for fifty. Carrying
   both forced us to explain a distinction that doesn't exist at the
   protocol layer.
2. **Different audience, dilutes the B2B story.** Invoice / Payroll /
   Storefront all serve a business actor on at least one side of the
   transaction. Private transfer is consumer-to-consumer. Mixing the two
   audiences in the same picker hurts positioning more than it helps
   discoverability.
3. **Demo risk.** Each surface in a live demo is a place the demo can
   break. Cutting one is one less thing to babysit.

**What would change our mind:** evidence that consumer-grade P2P drives
top-of-funnel for the B2B product (e.g. recipients who claimed a private
transfer later converting into invoice payers). Until we have that data,
the feature is a distraction.

---

## Considered, deferred to v2 — not yet built

### x402 integration — programmatic API billing over HTTP

**What it would be:** Veil's invoice primitive expressed as an HTTP-402
payment-required handshake. An API server returns 402 with a Veil
invoice URL; the client (a human or, more interestingly, an AI agent)
pays through the standard private-invoice flow and re-requests with
proof. The server verifies the on-chain `mark_paid` status and serves
the response.

**Why it fits Veil:** x402 is *more* B2B than what we're shipping today,
not less. It's machine-to-machine payments — AI agents calling APIs,
SaaS metered billing per request, micropayments for compute. Every one
of those is a business workflow that benefits from privacy: nobody wants
their AI agent's API consumption pattern leaking on a public ledger.

**Why deferred:** the runtime story is non-trivial. It requires a
verifier middleware, idempotency keys for repeated 402 challenges, and a
sub-cent fee model (which Solana's compute-unit pricing makes viable but
needs careful tuning). Out of scope for the seven-day window; appropriate
for a post-hackathon build with proper integration partners.

**Reference:** [HTTP 402 spec](https://datatracker.ietf.org/doc/html/rfc9110#name-402-payment-required) ·
[Coinbase x402 announcement](https://www.coinbase.com/blog/x402-payment-protocol-internet)

---

### Streaming / pull-payments (Sablier-pattern)

**What it would be:** time-vested or milestone-vested payment streams.
Employer commits a total amount up front; recipient claims the unlocked
portion at any point. Useful for retainers (linear vesting) and
performance-based pay (cliff + step vesting).

**Why it fits Veil:** retainers and milestone pay are existing B2B
contracting patterns we don't currently support — a freelancer on a
6-month retainer doesn't want twelve separate invoices, and an employer
doesn't want twelve manual transfer popups.

**Why deferred:** stream contracts are non-trivial state machines on a
mixer-routed asset. Sablier did this for public ERC-20s; doing it for
Umbra UTXOs requires a custodial intermediary or a much more complex
on-chain program. Worth a dedicated design pass, not a hackathon hack.

---

### Multi-org accounting / accountant invitations

**What it would be:** an invoicing user invites their accountant by
email; the accountant gets a scoped read-only view of the user's full
invoice history without needing an x25519 keypair handshake per quarter.

**Why it fits Veil:** the existing compliance-grant flow works (we
demoed it), but the UX assumes the auditor is technical enough to manage
keys. Real accountants aren't. A Stripe-style "invite teammate by email"
flow with scoped permissions is the common-case bridge.

**Why deferred:** authentication. Adds a non-wallet identity layer
(email + magic link) that we deliberately don't have today. Defensible
but a different product surface.

---

### Recurring invoices / subscription billing

**What it would be:** "bill this client $X every month" — set once,
auto-issue. The recipient sees a single shareable link that always
points to the latest unpaid invoice in the series.

**Why it fits Veil:** subscriptions are the dominant B2B billing pattern
for SaaS, hosting, retainers. Shipping invoicing without subscriptions
is shipping the cold-start case only.

**Why deferred:** the timer / scheduler infrastructure is real work
(server-side cron, retries, dunning logic). Defaulting to client-side
"open the page on the 1st" is not a product. The right substrate is
probably an x402-shaped pull model (the client polls / re-requests on
their schedule), which is why we'd build it after x402 not before.

---

## Things explicitly NOT on the roadmap

For the same discipline reason: deciding what's out is often more
important than what's in.

- **General-purpose mixer / privacy coin behavior.** We are a
  *business workflow* layer on top of Umbra. We are not Umbra.
- **EVM / multi-chain.** Solana-native is the entire premise. Privacy
  story differs per chain; trying to abstract it generically loses
  sharpness without gaining users in the v1 cohort.
- **Mobile app.** PWA is fine; native iOS/Android is not the bottleneck.
- **Token / governance.** No.
