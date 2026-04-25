# Veil — 75-second Demo Video Script

Target: 75 seconds total. Recorded at 1080p, two Phantom wallets (Alice + Bob) preloaded on devnet, a third wallet (Carol) for the auditor cameo. Screen recording at 30fps. Voiceover recorded separately, aligned on edit.

## Shot list

| # | Time | Screen | Voiceover | Cursor / action |
|---|------|--------|-----------|-----------------|
| 1 | 0:00–0:05 | Black title card → Veil landing page | "Every crypto payroll is public. Here's what Veil does." | Static title for 2s, then hard cut to landing page |
| 2 | 0:05–0:10 | Alice dashboard, click "New invoice" | "Alice needs to invoice a contractor. She clicks new invoice." | Click "New invoice" button |
| 3 | 0:10–0:18 | New-invoice form, fill amount + memo | "She enters the amount and a memo. Metadata is encrypted client-side and uploaded to Arweave before it touches the chain." | Type `1500` in amount, `March retainer` in memo, click "Create" |
| 4 | 0:18–0:20 | Phantom approval popup | *(no narration; natural Phantom SFX)* | Click "Approve" |
| 5 | 0:20–0:25 | Invoice detail page, copy pay URL | "She copies the shareable pay link." | Click "Copy pay URL", toast flashes |
| 6 | 0:25–0:28 | Switch to Bob's browser (second profile, visible Phantom icon change) | "Bob opens the link in his browser." | Paste URL, hit enter |
| 7 | 0:28–0:35 | Pay page, shielded toggle visible and ON | "Because Bob already has Umbra balance, Veil defaults to shielded payment — the whole payment stays inside the mixer." | Point cursor at the "Pay from shielded balance (recommended)" toggle |
| 8 | 0:35–0:40 | Phantom approval + success state | "One approval. Payment lands." | Click "Pay", approve, success confetti |
| 9 | 0:40–0:48 | Back to Alice dashboard, invoice row flips to Paid | "Alice's dashboard auto-claims the UTXO. The invoice is marked paid. Amount: never visible on-chain to anyone else." | Click dashboard link, invoice row animates green |
| 10 | 0:48–0:55 | Open compliance page, enter auditor wallet + scope, click Issue | "Her accountant needs to see Q1 invoices for tax. Alice issues a viewing grant — scoped to one mint, one month." | Paste Carol's pubkey, select "March 2026", click "Issue grant" |
| 11 | 0:55–1:05 | Switch to Carol's browser, `/audit/<alice-pubkey>`, invoice list with decrypted amounts | "Carol opens the audit view. She sees exactly what Alice granted — March invoices, amounts decrypted, nothing else." | Page loads, invoice rows render with dollar amounts |
| 12 | 1:05–1:10 | Back to Veil landing page | "Private by default. Transparent on demand. Built on Umbra, Anchor, and Arweave." | Static shot on hero section |
| 13 | 1:10–1:15 | Title card with URL | "Veil. veil.vercel.app." | Static title card, fade out |

## Narration (full text, 75s)

> Every crypto payroll is public. Here's what Veil does.
>
> Alice needs to invoice a contractor. She clicks new invoice. She enters the amount and a memo. Metadata is encrypted client-side and uploaded to Arweave before it touches the chain. She copies the shareable pay link.
>
> Bob opens the link in his browser. Because Bob already has Umbra balance, Veil defaults to shielded payment — the whole payment stays inside the mixer. One approval. Payment lands.
>
> Alice's dashboard auto-claims the UTXO. The invoice is marked paid. Amount: never visible on-chain to anyone else.
>
> Her accountant needs to see Q1 invoices for tax. Alice issues a viewing grant — scoped to one mint, one month. Carol opens the audit view. She sees exactly what Alice granted — March invoices, amounts decrypted, nothing else.
>
> Private by default. Transparent on demand. Built on Umbra, Anchor, and Arweave.
>
> Veil. veil.vercel.app.

Word count: ~150 words. Natural pace ~2 words/sec → 75s target.

## Production notes

- **Browser profiles.** Use two Chrome profiles with different avatars so the switch between Alice's and Bob's browser is visually obvious. Carol is a third profile, or use a different browser (Firefox) so the context switch reads instantly.
- **Phantom theming.** Alice on light mode, Bob on dark mode — the theme change doubles as a "we're somewhere else" cue.
- **Airdrops pre-recorded.** Do not record the devnet airdrop or the wrap-sol step. Both wallets are already funded before the video starts.
- **Pre-warm the prover.** Open Bob's browser tab and let the ZK prover fully load before starting the recording — cold-start is ~5s and will kill the pacing.
- **Cursor.** Use a cursor-highlight tool (e.g. Keynote's laser pointer, or an OBS overlay) so viewers track where we click.
- **Music.** Optional low-volume instrumental bed (no vocals). The narration is the primary track.
- **Captions.** Burn in captions for the narration — accessibility and muted-playback viewers.

## Edit pass checklist

- [ ] Total runtime 70–80 seconds
- [ ] No dead air longer than 2 seconds
- [ ] All Phantom popups are clearly visible (zoom in if needed)
- [ ] Dashboard transitions don't cut mid-animation
- [ ] Final URL clearly visible for 3+ seconds at the end
