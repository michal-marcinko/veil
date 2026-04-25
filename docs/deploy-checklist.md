# Vercel Deploy Checklist

Veil's frontend is a Next.js 14 app in `app/`. This doc walks through deploying it to Vercel, configuring env vars, and running a post-deploy smoke test.

## Pre-deploy

- [ ] Confirm `app/package.json` has a `build` script — it does: `"build": "next build"`.
- [ ] Confirm `next.config.mjs` (if present) is committed. The Umbra SDK uses a CDN rewrite (`/umbra-cdn/*` → CloudFront) for its prover WASM assets — this rewrite **must** survive the deploy or the ZK prover will 404 at runtime.
- [ ] Confirm the Anchor program is deployed to devnet at the program ID referenced by `NEXT_PUBLIC_INVOICE_REGISTRY_PROGRAM_ID` (`54ryi8hcihut8fDSVFSbN5NbArQ5GAd1xgmGCA3hqWoo` by default).
- [ ] `npm run build` locally inside `app/` — it must pass without errors before you push.
- [ ] `.env.local` is gitignored (`.gitignore` already covers `.env*.local`).

## Vercel project setup

1. Log in at https://vercel.com.
2. **Import Git Repository** → select the `veil` repo.
3. **Configure Project**:
   - Framework preset: **Next.js** (auto-detected).
   - Root directory: **`app`** (not the repo root — the frontend lives in the `app/` workspace).
   - Build command: leave default (`next build`).
   - Install command: `npm install` (or `npm install --workspaces` if the monorepo install from root is preferred).
   - Output directory: leave default.
4. Do NOT click Deploy yet — set env vars first.

## Environment variables

Add all of the following in Vercel → Project Settings → Environment Variables. Set **all three environments** (Production / Preview / Development) unless noted.

### Public (browser-visible)

| Key | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_SOLANA_NETWORK` | `devnet` | For hackathon demo |
| `NEXT_PUBLIC_RPC_URL` | `https://api.devnet.solana.com` (or Helius/QuickNode devnet URL) | Use a paid RPC for the demo to avoid rate limits |
| `NEXT_PUBLIC_RPC_WSS_URL` | `wss://api.devnet.solana.com` (or paid equivalent) | Must match RPC provider |
| `NEXT_PUBLIC_INVOICE_REGISTRY_PROGRAM_ID` | `54ryi8hcihut8fDSVFSbN5NbArQ5GAd1xgmGCA3hqWoo` | From `app/src/lib/constants.ts` |
| `NEXT_PUBLIC_PAYMENT_MINT` | Devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (fallback: wSOL `So11111111111111111111111111111111111111112`) | Depends on Day 1 finding §1 |

### Server-side (NOT prefixed `NEXT_PUBLIC_`)

| Key | Value | Notes |
|---|---|---|
| `BUNDLR_PRIVATE_KEY` | Base58 or JSON-array private key for the Bundlr/Arweave upload wallet | Used by `/api/arweave-upload` route; must be funded with Bundlr credit |
| `BUNDLR_NODE_URL` | `https://node1.bundlr.network` | Default Bundlr mainnet node (Arweave is permaweb — no testnet) |

**Gotcha:** `app/src/lib/arweave.ts` POSTs raw bytes to `/api/arweave-upload`. That route must read `BUNDLR_PRIVATE_KEY` on the server and sign the Bundlr upload. If the key is exposed as `NEXT_PUBLIC_`, it will leak to the browser — double-check the prefix before saving.

### Optional

| Key | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_UMBRA_INDEXER_API` | `https://utxo-indexer.api.umbraprivacy.com` | Defaults to this in code; override only if Umbra gives us a dedicated endpoint |
| `NEXT_PUBLIC_UMBRA_RELAYER_API` | `https://relayer.api.umbraprivacy.com` | Same |

## Deploy

1. Click **Deploy**.
2. Wait for the first build. Typical build time: 2–4 minutes.
3. If the build fails, check the log for:
   - Missing env vars (Next.js will warn on `process.env.X` references during static analysis).
   - WASM loading errors from `@umbra-privacy/web-zk-prover` — these need a `next.config.mjs` tweak (see Day 1 findings §9).
   - Workspace resolution errors — if `npm install` from `app/` can't find monorepo deps, set Vercel's install command to run from repo root: `npm install --workspaces`.

## Domain

- [ ] Default domain: `veil-<hash>.vercel.app` — not pretty, rename before submitting.
- [ ] Rename Vercel project slug to `veil` → URL becomes `veil.vercel.app`.
- [ ] (Optional) Attach a custom domain in Project Settings → Domains if one is available.

## Post-deploy smoke test

- [ ] Open the deploy URL in a **fresh-profile browser** (no prior Phantom session).
- [ ] Install Phantom, create a brand-new devnet wallet, airdrop 2 SOL.
- [ ] Connect wallet on Veil.
- [ ] Follow `docs/smoke-test.md` end-to-end.
- [ ] Verify the ZK prover loads (watch Network tab — `/umbra-cdn/*` requests should 200, not 404).
- [ ] Verify `/api/arweave-upload` returns a valid Arweave URI on invoice creation.
- [ ] Verify dashboard auto-claims UTXO within 60s of Bob's payment.

If any of the above fails, revert to the previous deploy via Vercel → Deployments → Promote Previous.

## Rollback plan

Vercel retains every deploy. If a bad push breaks prod during the hackathon window, go to the Deployments tab and click "Promote to Production" on the last known good deploy. No CLI, no git revert required.
