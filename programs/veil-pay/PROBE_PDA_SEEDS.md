# Phase 0 Probe — Umbra create-buffer PDA seed reference

These constants are needed by the Task 3 TypeScript test to derive the
`publicStealthPoolDepositInputBuffer` PDA that we pass into VeilPay's
`probe_create_buffer` instruction (which forwards it via CPI to Umbra).

**Source**: `app/node_modules/@umbra-privacy/umbra-codama/dist/index.cjs`
around lines 24486–24528 (function
`getCreatePublicStealthPoolDepositInputBufferInstructionAsync`).

## Constants

### Umbra program ID (devnet)
```
DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ
```
(Mainnet would be `UMBRAD2ishebJTcgCLkTkNUx1v3GyoAgpTRPeWoLykh`, but the probe
targets devnet.)

### Anchor instruction discriminator
8 bytes for `CreatePublicStealthPoolDepositInputBuffer`:
```
[139, 135, 169, 216, 228, 15, 104, 98]
```
Hex: `8b 87 a9 d8 e4 0f 68 62`

Verified two ways:
1. From the codama bundle constant `CREATE_PUBLIC_STEALTH_POOL_DEPOSIT_INPUT_BUFFER_DISCRIMINATOR`.
2. From `sha256("global:create_public_stealth_pool_deposit_input_buffer")[0..8]`.

### Buffer PDA — 32-byte seed prefix (`SEED_CONST`)
```
[
  210, 117, 170, 207,  65,  10,  84,  93,
   32, 196, 228, 241,  64, 226, 130, 157,
    3,   5,  20, 123, 110, 142, 123, 197,
   60, 131, 205, 173, 255, 172, 168, 181,
]
```
Hex: `d275aacf410a545d20c4e4f140e2829d0305147b6e8e7bc53c83cdadffaca8b5`

### Buffer PDA — seed layout
The codama derivation calls
`getProgramDerivedAddress({ programAddress: UMBRA_PROGRAM_ID, seeds: [...] })`
with **three** seeds (NOT four — this instruction has no separate
`instructionSeed` between the prefix and depositor):

1. `SEED_CONST` (32 bytes — the array above)
2. `depositor.toBuffer()` (32-byte pubkey)
3. `offset` encoded as little-endian u128 (16 bytes)

The `offset` field is defined as `getStructEncoder([["first", getU128Encoder()]])`
i.e. a single u128 LE — so the on-wire seed bytes are `offset.to_le_bytes()`.

For the Phase 0 probe, **hardcode `offset = 0u128`** (16 zero bytes).

## TypeScript derivation pseudo-code (for Task 3)

```ts
import { PublicKey } from '@solana/web3.js';

const UMBRA_PROGRAM_ID = new PublicKey('DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ');

const BUFFER_SEED_PREFIX = Buffer.from([
  210, 117, 170, 207,  65,  10,  84,  93,
   32, 196, 228, 241,  64, 226, 130, 157,
    3,   5,  20, 123, 110, 142, 123, 197,
   60, 131, 205, 173, 255, 172, 168, 181,
]);

function deriveBufferPda(depositor: PublicKey, offset: bigint = 0n): [PublicKey, number] {
  // u128 little-endian = 16 bytes
  const offsetLe = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    offsetLe[i] = Number((offset >> BigInt(i * 8)) & 0xffn);
  }
  return PublicKey.findProgramAddressSync(
    [BUFFER_SEED_PREFIX, depositor.toBuffer(), offsetLe],
    UMBRA_PROGRAM_ID,
  );
}
```

## CPI account order (Umbra side, mirrored in `ProbeCreateBuffer`)

| # | Name                                  | Signer | Writable |
|---|---------------------------------------|--------|----------|
| 1 | depositor                             | yes    | no       |
| 2 | feePayer                              | yes    | yes      |
| 3 | publicStealthPoolDepositInputBuffer   | no     | yes      |
| 4 | systemProgram                         | no     | no       |

VeilPay's `probe_create_buffer` ALSO takes `umbra_program` as an
`UncheckedAccount` so the CPI loader can resolve the program — it is
not part of Umbra's own account list, only the Solana CPI plumbing.

## Probe instruction payload (Phase 0 only)

`probe_create_buffer` builds the inner Umbra instruction data as:
- 8 bytes discriminator (above)
- 256 bytes of `0x00` mock payload

This is intentionally invalid w.r.t. Umbra's deserializer / proof
verifier. A failure inside Umbra (deserialize / proof check) means
the CPI auth layer accepted us → Phase 0 GO. A failure at the Solana
runtime level (CPI denied, signer mismatch) → NO-GO.
