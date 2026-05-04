# X402 Protocol — Technical Deep Dive
**Researched:** 2026-05-04 for Veil's v0.2 roadmap

## TL;DR

x402 is an HTTP-native stablecoin payment protocol that revives the long-dormant `402 Payment Required` status code. A client hits a paywalled endpoint, gets back `402` with a `PAYMENT-REQUIRED` header describing accepted schemes, signs an EIP-3009 (EVM) or partial Solana transaction (SVM) authorization, retries with a `PAYMENT-SIGNATURE` header, and the server (via a third-party "facilitator") verifies and settles on-chain before returning `200`. Coinbase shipped the v1 spec in May 2025; the **x402 Foundation** (Coinbase + Cloudflare) was launched September 23, 2025 and now stewards the standard. As of mid-2026 it is production but young — Solana has processed >35M txs and >$10M volume, and there are >40 facilitators — though every transaction is fully transparent on-chain, which is the central privacy gap Veil could fill.

## History

### HTTP 402: 30 years of "reserved for future use"

The `402 Payment Required` status code has been in the HTTP spec since [RFC 2068 (1997)](https://www.rfc-editor.org/rfc/rfc2068) — not 1991 — and has remained "reserved for future use" through every revision (RFC 2616, RFC 7231, RFC 9110). The web's authors anticipated a native machine-payments layer; the economics never showed up. Credit-card minimums priced out per-request flows, subscription billing won the human market, and human-in-the-loop UX made per-page payment dialogs intolerable. (See [MDN: 402](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/402), [Wikipedia: HTTP 402](https://en.wikipedia.org/wiki/HTTP_402).)

### Prior attempts that didn't take

- **BIP70 (2013)** — Bitcoin's Payment Protocol; designed for human-checkout, deprecated by most wallets by 2021.
- **GNU Taler (2014–)** — privacy-preserving micropayment system using blind signatures; never crossed adoption threshold despite strong privacy properties.
- **W3C Web Monetization / Coil / Interledger (2018–)** — proposed continuous streaming using a `monetization` `<meta>` tag and ILP. Required browser extension; never standardized.
- **L402 / LSAT (Lightning Labs, 2020)** — Lightning Network + macaroons, used `402` plus a `WWW-Authenticate: LSAT` header. Bitcoin-native, BTC-denominated; production but small ecosystem ([L402 spec](https://github.com/lightninglabs/L402)).

### x402 revival timeline

- **May 2025** — Coinbase Developer Platform publishes x402 v1 spec and `coinbase/x402` reference SDKs (TypeScript + Python). USDC on Base is the launch target.
- **Summer 2025** — Solana support added via `@x402/svm` and PayAI/Corbits facilitators.
- **September 9, 2025** — **Bazaar** launches: a machine-readable catalog of x402-paywalled endpoints for agent discovery.
- **September 23, 2025** — **x402 Foundation** announced jointly by Coinbase and Cloudflare ([Cloudflare blog](https://blog.cloudflare.com/x402/)). Cloudflare ships x402 in its Agents SDK and proposes a "deferred payment" scheme using HTTP Message Signatures. The repo `coinbase/x402` becomes a development fork; canonical work moves to `x402-foundation/x402`.
- **Q4 2025 – Q1 2026** — transports-v2 spec lands; Stellar support; >40 facilitators in the registry.
- **March 18, 2026** — Stripe + Tempo launch **MPP (Machine Payments Protocol)** as a session-based competitor. Stripe positions x402 and MPP as complementary; MPP can use x402 as its underlying rail.

## The Specification

x402 is **implementation-defined**, not an RFC. The canonical document is [`coinbase/x402/specs/transports-v2/http.md`](https://github.com/coinbase/x402/blob/main/specs/transports-v2/http.md). Schemes (the actual on-chain mechanics) are defined per-network under `specs/schemes/`.

### Headers

| Header | Direction | Contents |
|---|---|---|
| `PAYMENT-REQUIRED` | Server → Client (with 402) | Base64-encoded `PaymentRequired` object listing accepted schemes |
| `PAYMENT-SIGNATURE` | Client → Server | Base64-encoded `PaymentPayload` with signed authorization |
| `PAYMENT-RESPONSE` | Server → Client (with 200) | Base64-encoded `SettlementResponse` (tx hash, network, payer) |

Older docs and the `@x402/express` middleware also reference `X-PAYMENT` / `X-PAYMENT-RESPONSE`; transports-v2 standardizes the new names. Both forms are seen in production code.

### Status codes

| Code | Meaning |
|---|---|
| `402` | Payment required, or payment failed verification |
| `400` | Malformed payment payload |
| `500` | Facilitator/server internal error |
| `200` | Payment settled, resource returned |

### Wire-level message flow (EVM, EIP-3009 "exact" scheme)

1. **`GET /weather`** → server returns `402` with `PAYMENT-REQUIRED` header listing `accepts: [{scheme:"exact", network:"eip155:8453", maxAmountRequired, asset, payTo, ...}]`.
2. Client builds an `authorization` object — `{from, to, value, validAfter, validBefore, nonce}` where `nonce` is random 32 bytes — and signs the EIP-712 typed data with their wallet key.
3. Client retries `GET /weather` with `PAYMENT-SIGNATURE: <base64({x402Version:1, scheme:"exact", network, payload:{signature, authorization}})>`.
4. Server forwards payload to the facilitator's `/verify` endpoint (signature recovery + balance + time window + simulation).
5. Server runs business logic, then calls facilitator `/settle`, which broadcasts `transferWithAuthorization()` against the EIP-3009 token contract (USDC/EURC).
6. On confirmation, server returns `200` plus `PAYMENT-RESPONSE` with the transaction hash.

### Example payload (pre-base64)

```json
{
  "x402Version": 1,
  "scheme": "exact",
  "network": "eip155:8453",
  "payload": {
    "signature": "0x1234...",
    "authorization": {
      "from": "0x...",
      "to": "0x...",
      "value": "10000",
      "validAfter": "1740672089",
      "validBefore": "1740672154",
      "nonce": "0x3456..."
    }
  }
}
```

`value` is in atomic units (10000 = 0.01 USDC at 6 decimals). Network IDs use **CAIP-2**: `eip155:8453` for Base, `eip155:84532` for Base Sepolia, `eip155:137` for Polygon, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp...` for Solana mainnet.

### Schemes

- **`exact`** — fixed price; the most common scheme. EVM uses EIP-3009 `transferWithAuthorization` first, then Permit2's `permitWitnessTransferFrom`, then ERC-7710 delegations as fallback. SVM uses an SPL Token `TransferChecked` instruction signed by the payer with the facilitator co-signing/submitting.
- **`upto`** — usage-based: client signs an authorization for a *maximum* amount; server overrides at settlement with actual usage. Each authorization is single-use ("MUST be settled at most once"). Useful for LLM token billing and per-byte bandwidth.
- **deferred** (Cloudflare proposal) — establishes cryptographic trust immediately, settles in batches. Uses HTTP Message Signatures; supports stablecoins or traditional rails. Not yet final.

## Coinbase's Reference Implementation

**Repo:** [`github.com/coinbase/x402`](https://github.com/coinbase/x402) (Apache-2.0). Languages: TypeScript ~50%, Python ~30%, Go ~20%, plus Solidity for proxy contracts.

### Package layout

```
typescript/
  packages/
    @x402/core         core types, facilitator client, resource server
    @x402/evm          ExactEvmScheme, EIP-712 helpers, Permit2 proxy
    @x402/svm          ExactSvmScheme — Solana SPL token signing
    @x402/stellar      Stellar implementation
    @x402/express      Express middleware
    @x402/fastify      Fastify middleware
    @x402/next         Next.js middleware
    @x402/hono         Hono middleware
    @x402/fetch        wrapFetchWithPayment client
    @x402/axios        Axios interceptor client
    @x402/paywall      browser paywall UI
    @x402/extensions   Bazaar discovery, gasless approvals, Sign-in-with-x
python/                pip install x402  /  x402[fastapi]  /  x402[svm]
go/                    github.com/x402-foundation/x402/go
contracts/evm/         x402ExactPermit2Proxy and friends
specs/                 transports/, schemes/{exact,upto}/
```

### Server-side (Express, lifted from CDP quickstart)

```ts
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

const app = express();
const facilitatorClient = new HTTPFacilitatorClient({
  url: "https://api.cdp.coinbase.com/platform/v2/x402"
});
const server = new x402ResourceServer(facilitatorClient)
  .register("eip155:8453", new ExactEvmScheme());

app.use(paymentMiddleware({
  "GET /weather": {
    accepts: [{ scheme: "exact", price: "$0.001",
                network: "eip155:8453", payTo: "0xYourAddr" }],
    description: "Current weather",
    mimeType: "application/json",
  },
}, server));

app.get("/weather", (_req, res) => res.json({ weather: "sunny" }));
```

### Facilitator service

The facilitator is a stateless HTTP service exposing `/verify` and `/settle`. It holds the operational hot key that broadcasts `transferWithAuthorization` (or submits the SVM transaction) and pays gas. The CDP-hosted facilitator processes Base, Polygon, Arbitrum, World, and Solana with **1,000 free txs/month** then **$0.001 per verification** (no protocol fee on the settlement itself). It is non-custodial — the EIP-3009 signature binds the recipient address, so the facilitator cannot redirect funds.

### Replay protection

- **EIP-3009**: random `bytes32` nonce permanently recorded on-chain in the token contract's nonce mapping. `validAfter`/`validBefore` enforce a time window. Chain ID is part of the EIP-712 domain — no cross-chain replay.
- **Permit2**: incrementing per-user counter in the Permit2 singleton. Witness binds the recipient.
- **Solana**: relies on Solana's native duplicate-signature detection plus blockhash expiry (~150 slots). Partial signing — client signs the payer side; facilitator completes and submits.

## Other Implementations

### Reference / official

- **`coinbase/x402`** (TS, Python, Go) — canonical
- **`x402-foundation/x402/go`** — Go SDK
- **Mogami** (Java)

### Independent / community

- **x402.rs** (Rust) — full facilitator + SDK
- **x402-dotnet** (.NET)
- **x402-rails / x402-payments** (QuickNode, Ruby/Rails)
- **OrbytLabz/x402python** — Solana-native Python lib
- **PlaiPin/solana-esp32-x402** — embedded device demo
- **thirdweb/x402, Faremeter, Corbits** — alternative SDKs/facilitators
- **OpenFacilitator, x402.rs, Mogami, OpenZeppelin** — open-source facilitators

### Competitors / adjacent standards

- **L402** (Lightning Labs, 2020) — same `402` semantics, BTC over Lightning, macaroons. Sub-second settlement, but Bitcoin-only and small ecosystem. Six years of production history.
- **MPP / Machine Payments Protocol** (Stripe + Tempo, March 2026) — session-based; agent authorizes a spend cap once and streams micropayments against it. Multi-rail: stablecoins (Tempo), cards (Stripe/Visa), Lightning, custom. **Backwards compatible with x402** as an underlying mechanism.
- **AP2 (Agent Payments Protocol)** — Google + Coinbase positioning paper; treats x402 as the canonical agent rail.
- **Tollbooth, BTCPay-based 402 servers** — alternative MCP monetization paths.

## Technical Mechanics

### What the server needs to verify

1. Decode `PAYMENT-SIGNATURE` (base64 → JSON).
2. Confirm `scheme` and `network` are in its `accepts` list and the `value` ≥ price.
3. Forward to facilitator `/verify`, which:
   - recovers EIP-712 signature → matches `authorization.from`,
   - checks token-contract nonce is unused,
   - verifies time window via `block.timestamp`,
   - checks payer balance and (for Permit2) allowance,
   - simulates the settlement call via `eth_call` / Solana `simulateTransaction`.
4. On success, run business logic, then call facilitator `/settle` to broadcast.

### How the server detects the payment landed

It doesn't watch the chain. The facilitator is the indexer of record — it submits the tx and returns `{success, txHash}` to the server, which then writes `PAYMENT-RESPONSE` and returns 200. The server never has to run an RPC endpoint or mempool watcher itself, which is x402's headline DX win.

### Latency

- **Solana**: 400 ms slot time, ~$0.00025 fees. End-to-end 402-pay-retry round trip ~600 ms – 1.5 s.
- **Base**: 200 ms block, sub-cent gas. Settlement typically 1–3 s.
- **Stellar**: ~5 s ledger close.
- **Without optimization**, the full handshake adds ~2 s overhead per protected request. v2 reduces this with wallet-based identity (authenticate once, skip handshake on subsequent calls).

### Micropayments

Solana and Base both make sub-cent payments economical — fees are 1–3 orders of magnitude below the typical price floor ($0.001 is common). USDC's 6-decimal precision allows down to $0.000001. Below that, **`upto`** scheme batching or session abstractions (MPP-style) are needed.

### Streaming / subscriptions

Vanilla x402 is **request-response only**. Streaming requires either:
- Repeated `exact` payments per chunk (works but chatty).
- The `upto` scheme with a final settlement on connection close (LLM streaming pattern).
- Cloudflare's deferred-settlement scheme for batched-trust flows.
- An MPP session layered on top of x402.

## Privacy Properties (Vanilla x402)

### Exposed on-chain by default

Every settled payment writes a public token-contract `Transfer` event:
- payer address (`from`)
- recipient address (`to` — typically the resource server's wallet)
- amount
- block timestamp
- token (USDC, EURC, SPL token mint)
- transaction hash

There is **no on-chain memo binding the payment to a specific HTTP request**, but timing-correlation across the facilitator's settlement stream is trivial. Anyone watching a server's recipient address sees exactly which clients pay how much and how often.

### Exposed in HTTP traffic

- `PAYMENT-SIGNATURE` reveals the payer wallet (`from`) to the resource server and to any TLS-terminating intermediary (CDN, reverse proxy).
- The facilitator sees both the wallet and the resource URL — it is the strongest correlator in the stack.
- TLS protects the wire, but Halborn's audit highlights MITM risk against payload integrity if HTTPS is not strictly enforced + HSTS pinned.

### What can't be hidden with the current spec

- Sender-recipient linkability (it's a public token transfer).
- Amount (visible in the EIP-3009 `value`).
- Request-payment correlation against the facilitator (it sees the URL on `/verify`).
- Aggregate spending profile of any wallet across all x402 services.

The Halborn write-up's recommended mitigation is "use single-use addresses to break the chain" — which works but pushes wallet-management complexity onto the client and doesn't help against the facilitator.

### Where Umbra-style ZK privacy fits

This is the integration thesis for Veil v0.2. Three injection points:

1. **Payer-side blinding**: replace the public `from` with a Umbra encrypted-balance debit; the facilitator gets a ZK proof of "balance ≥ value, nonce unused" instead of a plaintext signature. The on-chain settlement is a single Arcium MPC instruction rather than a token Transfer.
2. **Recipient-side blinding**: pay-to a stealth address derived per request (similar to single-use addresses but with no key-management burden).
3. **Facilitator-blind mode**: split verify and settle so the facilitator never sees the resource URL — the server provides only the payment commitment, and a separate channel reveals the URL only to the resource server.

USDC is supported natively by Umbra (per project memory), so the token side is clean. The hard part is the EIP-3009 `transferWithAuthorization` semantics — Umbra would need to expose either a wrapped EIP-3009 endpoint or a custom x402 scheme (`scheme: "veil"`) that the facilitator can opt into.

## Implementation Cost

### Server adoption (current spec, vanilla)

- **Lines of code**: ~10–20 lines for an Express app to protect a route. The CDP quickstart is ~15 LoC including imports.
- **Operational cost**: $0 if you use the CDP free tier (1k tx/mo) or a community facilitator. Self-host facilitator = run a hot wallet + RPC. Per-tx cost on Base ≈ $0.0001 gas; Solana ≈ $0.00025.
- **Latency penalty**: ~1–2 s per protected request without v2 session reuse. Acceptable for agentic API calls, painful for human page loads.
- **Auditing surface**: small — no smart-contract deployment needed (you reuse the EIP-3009 token contract). Smart-contract risk is delegated to USDC/EURC/Permit2.

### Client adoption

- **JS**: `wrapFetchWithPayment(fetch, signer)` — drop-in replacement for `fetch`. ~5 LoC plus a wallet object.
- **Solana**: `createKeyPairSignerFromBytes(base58.decode(privateKey))` then the same wrapper.
- **UX cost for humans**: the `@x402/paywall` package ships a browser-extension-style UI; works but is rough. Most x402 traffic is agents, not humans.

### Production-readiness (May 2026)

- Solana has handled >35M tx and >$10M volume — production by any reasonable bar.
- 40+ facilitators in the ecosystem registry; CDP, PayAI, Corbits, thirdweb are the most established.
- Halborn published a security review in 2026 flagging replay/MITM/centralization concerns; all are addressable at the integration layer.
- Spec is still moving — transports-v2 is recent, deferred-settlement and session schemes are in flux. Don't depend on schema stability for >12 months without re-audit.

## Tradeoffs

### Strengths

- **Drop-in HTTP**: works with any web framework; no custom client beyond `wrapFetchWithPayment`.
- **No accounts**: no API keys, no OAuth, no rotating secrets — wallet signature is the auth.
- **Per-request granularity**: micropayments below 1 cent are economical on Solana/Base.
- **Open and multi-chain**: Foundation governance, EVM + SVM + Stellar, agnostic to specific tokens.
- **Replay protection is robust** (random nonces on-chain, time windows, chain-ID binding).
- **Agent-native**: ergonomically right for LLM tool-call patterns; Bazaar gives discoverability.

### Weaknesses

- **Zero privacy by default**: every payment is on a public ledger linked to the request via the facilitator. This is the gap Veil targets.
- **Facilitator is a centralization point**: censors, fails, or surveils. Multiple competing facilitators help but don't solve at protocol level.
- **Latency penalty** on first request to a new resource (~1–2 s).
- **Streaming is awkward** — vanilla spec is request-response; needs `upto` or MPP overlay for streaming workloads.
- **Spec instability** — transports-v2, deferred, session schemes still landing in 2026.
- **Wallet-management UX** falls on the client — secure key storage for agents is non-trivial.

### Realistic adoption curve

Two production rails coexisting in 2026:
- **x402** — open/permissionless long tail (independent dev APIs, MCP servers, indie agent tooling). Cloudflare and Vercel CDN-edge support gives huge reach.
- **MPP** — enterprise high-frequency, sessions, multi-rail (cards + stablecoins + Lightning). Stripe owns the merchant-dashboard layer.

Both will likely persist; MPP is positioned as a session-layer that *uses* x402 underneath, not a replacement. For a Solana-native privacy dApp, x402 is the obvious integration target — MPP doesn't currently route through Solana the same way.

## Sources

- [coinbase/x402 GitHub](https://github.com/coinbase/x402) — canonical repo; package layout, supported networks, license
- [x402 transports-v2 HTTP spec](https://github.com/coinbase/x402/blob/main/specs/transports-v2/http.md) — header definitions, status code mapping
- [x402 exact scheme on EVM](https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md) — EIP-3009/Permit2/ERC-7710 mechanics, replay protection
- [x402 upto scheme](https://github.com/coinbase/x402/blob/main/specs/schemes/upto/scheme_upto.md) — usage-based settlement model
- [x402.org](https://www.x402.org/) — protocol overview, Foundation framing
- [x402.org/ecosystem](https://www.x402.org/ecosystem) — full ecosystem registry (facilitators, SDKs, integrations)
- [CDP x402 docs — Welcome](https://docs.cdp.coinbase.com/x402/welcome) — facilitator pricing, supported networks, free-tier limits
- [CDP x402 Quickstart for Sellers](https://docs.cdp.coinbase.com/x402/quickstart-for-sellers) — concrete TypeScript code for Express middleware
- [Cloudflare blog: launching x402 Foundation](https://blog.cloudflare.com/x402/) — September 2025 Foundation launch, Cloudflare's deferred scheme proposal
- [Coinbase: Introducing x402](https://www.coinbase.com/developer-platform/discover/launches/x402) — original launch announcement (403 on direct fetch but referenced widely)
- [Solana docs: intro to x402](https://solana.com/developers/guides/getstarted/intro-to-x402) — SPL TransferChecked flow, partial signing
- [solana.com/x402/what-is-x402](https://solana.com/x402/what-is-x402) — Solana volume stats: 35M+ tx, $10M+ volume
- [Chainstack: x402 on Solana](https://chainstack.com/x402-on-solana-developer-guide-micro-payments/) — facilitator config, ExactSvmScheme
- [Avalanche Builder Hub: X-PAYMENT header](https://build.avax.network/academy/blockchain/x402-payment-infrastructure/03-technical-architecture/03-x-payment-header) — full header payload example with field-level definitions
- [QuickNode: x402 explained](https://blog.quicknode.com/x402-protocol-explained-inside-the-https-native-payment-layer/) — phase-by-phase HTTP flow
- [PayIn blog: ERC-3009 powers x402](https://blog.payin.com/posts/erc-3009-x402/) — EIP-3009 deep dive
- [Halborn: x402 security risks](https://www.halborn.com/blog/post/x402-explained-security-risks-and-controls-for-http-402-micropayments) — replay, MITM, facilitator centralization, privacy
- [agentpaytrend: 3 security mechanisms](https://agentpaytrend.com/x402-protocol-security-3-mechanisms/) — random-nonce vs sequential nonce
- [ln.bot: x402 vs L402](https://ln.bot/learn/x402-vs-l402) — head-to-head comparison
- [L402 spec on GitHub](https://github.com/lightninglabs/L402) — prior art (Lightning Labs, 2020)
- [WorkOS: x402 vs Stripe MPP (2026)](https://workos.com/blog/x402-vs-stripe-mpp-how-to-choose-payment-infrastructure-for-ai-agents-and-mcp-tools-in-2026) — competitive analysis
- [Stripe: introducing MPP](https://stripe.com/blog/machine-payments-protocol) — March 18, 2026 launch
- [Merit-Systems/awesome-x402](https://github.com/Merit-Systems/awesome-x402) — community-curated implementation list
- [@x402/express on npm](https://www.npmjs.com/package/@x402/express) — middleware package
- [Stellar blog: x402 on Stellar](https://stellar.org/blog/foundation-news/x402-on-stellar) — non-EVM/SVM implementation
- [Pantera: HTTP 402's modern makeover](https://panteracapital.com/http-402s-modern-makeover/) — historical context
- [AEI: 402 — the code that waited 30 years](https://ctse.aei.org/402-payment-required-the-http-code-that-waited-30-years-and-why-it-matters-today/) — RFC 2068 origin, why it sat unused
- [MDN: HTTP 402](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/402) — official status-code reference
- [Wikipedia: HTTP 402](https://en.wikipedia.org/wiki/HTTP_402) — broad timeline
