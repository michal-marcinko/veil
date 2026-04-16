# Demo Recording Checklist

## Before recording

- [ ] All 25 previous tasks committed and pushed
- [ ] E2E devnet test (Task 25) passes cleanly
- [ ] Fresh Alice wallet with 2 SOL on mainnet
- [ ] Fresh Bob wallet with 2 SOL and 2 USDC on mainnet
- [ ] Switch `.env.local` `NEXT_PUBLIC_SOLANA_NETWORK` from `devnet` to `mainnet` (temporarily, for recording only — spec §7.6 requires mainnet demo for credibility)
- [ ] Ensure recording wallet has ~$10 USDC + ~0.1 SOL on mainnet (for real invoice payment + fees)
- [ ] `.env.local` NEXT_PUBLIC_SOLANA_NETWORK=mainnet confirmed
- [ ] Dev server running on http://localhost:3000
- [ ] Two browser profiles open, one for Alice, one for Bob
- [ ] Screen recorder ready (OBS, Loom, or similar)
- [ ] Audio check: mic recording clearly, no background noise
- [ ] Rehearsed the script at least 3 times

## Recording flow (5 minutes)

Follow spec §8 exactly:

- 0:00–0:30 — Problem hook: show a public USDC salary on explorer, narrate why it's a problem
- 0:30–0:45 — "Meet Veil" intro
- 0:45–1:45 — Alice creates an invoice (Flow 1)
- 1:45–2:00 — Alice copies link, pastes into email (share step)
- 2:00–3:30 — Bob pays as first-time user, including registration (Flow 2)
- 3:30–4:00 — Switch to Alice's dashboard, show auto-claim + balance update (Flow 3)
- 4:00–4:30 — Alice creates a compliance grant (Flow 4)
- 4:30–5:00 — Explorer side-by-side comparison (public USDC vs Veil encrypted), fin

## After recording

- [ ] Review video once end-to-end
- [ ] Check audio levels don't clip
- [ ] Upload to YouTube (unlisted) or Twitter
- [ ] Embed URL in the Superteam Earn submission form
- [ ] Also embed in the Colosseum Frontier submission
- [ ] Revert `.env.local` back to `devnet` (`NEXT_PUBLIC_SOLANA_NETWORK=devnet`)
- [ ] Commit any last doc changes
- [ ] Push repo to GitHub (public) for judge access

## Submission links

Submit to BOTH targets. Side track submissions on Superteam Earn do NOT count unless the main Colosseum portal submission is also completed.

- **Main Colosseum portal (REQUIRED):** https://arena.colosseum.org/
- **Superteam Earn side tracks (per-track submissions):** https://superteam.fun/earn/

## Submission checklist

- [ ] Colosseum main portal submission at https://arena.colosseum.org/ (REQUIRED — side tracks don't count without this)
- [ ] Superteam Earn side track: **Umbra** — paste demo URL + repo link
- [ ] Superteam Earn side track: **100xDevs** — same
- [ ] Superteam Earn side track: **SNS** — same
- [ ] Superteam Earn side track: **Jupiter DX** (if COULD-HAVE swap-to-USDC shipped) — same
- [ ] Superteam Earn side track: **Dune** (if COULD-HAVE analytics shipped) — same
- [ ] Git repo pushed to GitHub (public) for judge access
- [ ] README updated with live demo link + submission info

## Submission metadata

Include the following in every submission form for reference and verification:

- **Deployed devnet program ID (invoice-registry):** `54ryi8hcihut8fDSVFSbN5NbArQ5GAd1xgmGCA3hqWoo`
- **Demo network (recording):** Solana mainnet-beta
- **Dev/test network (E2E, reproducible by judges):** Solana devnet
- **Repo:** GitHub URL (public)
- **Live demo:** Vercel/host URL
- **Video:** YouTube (unlisted) or Twitter URL
