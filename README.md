# Veil

Private invoicing on Solana. Business-grade payment privacy via Umbra, with selective compliance access for auditors.

Built for the [Colosseum Frontier Hackathon](https://arena.colosseum.org/), April–May 2026.

## Status

🟡 Design complete, implementation not started.

- Design spec: [`docs/superpowers/specs/2026-04-15-veil-frontier-hackathon-design.md`](docs/superpowers/specs/2026-04-15-veil-frontier-hackathon-design.md)
- Implementation plan: to be generated via `superpowers:writing-plans`

## What it does

Veil is an invoicing and payment app where:

- **Amounts are hidden on-chain** via Umbra's encrypted token accounts (Arcium MPC)
- **Counterparty linkage is broken** via Umbra's UTXO mixer with ZK proofs
- **Invoice metadata is encrypted** client-side (AES-256-GCM) and stored on Arweave, hash-anchored to an on-chain Anchor registry
- **Compliance access is selective** — accountants and auditors get viewing keys for scoped access

## Target tracks (Frontier Hackathon)

| Track | Prize | Status |
|---|---|---|
| Umbra | $10k | Core target |
| 100xDevs open | $10k (10 winners) | Core target |
| SNS Identity | $5k | Stretch (pay-by-name) |
| Jupiter DX | $3k + bonuses | Stretch (swap-to-USDC) |
| Dune Analytics | $6k | Stretch (volume dashboard) |
| Main Frontier pool | $$$$ | Submitted automatically |

## Repo structure (planned)

```
veil/
├── README.md                  # this file
├── docs/
│   └── superpowers/
│       ├── specs/             # design specs
│       └── plans/             # implementation plans
├── programs/                  # Anchor programs (Rust)
│   └── invoice-registry/
├── app/                       # Next.js 14 frontend
│   ├── src/
│   ├── package.json
│   └── ...
└── scripts/                   # Dev scripts, sweeper worker
```

## License

TBD
