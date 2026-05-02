# SDK pay function recon — for `payInvoiceCpi.ts`

**Date:** 2026-05-02
**SDK version:** `@umbra-privacy/sdk@2.1.1`
**SDK source:** `app/node_modules/@umbra-privacy/sdk/dist/index.cjs`
**Function under analysis:** `getPublicBalanceToReceiverClaimableUtxoCreatorFunction` (lines 8842-9347)

---

## TL;DR — chosen approach: **direct codama**

Both the capture-forwarder and direct-codama strategies were considered. Direct codama wins because:

1. The capture-forwarder requires neutering `client.signer.signTransaction` AND swapping `transactionForwarder` simultaneously — the SDK calls `client.signer.signTransaction(transaction)` (sdk index.cjs:9222) which would still trigger a Phantom popup unless we replace the signer. Replacing only the forwarder doesn't suppress popups.
2. Every SDK helper we need IS exported (verified — see below). The cryptography (~80 LOC) ports cleanly with named imports, no closure-capture surgery.
3. Codama instructions expose `.data` and `.accounts` directly — perfect for forwarding to our `pay_invoice` wrapper.
4. The original plan in `2026-05-02-veilpay-cpi-single-popup.md` (Tasks 9-11) specified this approach; the user prompt's capture-forwarder suggestion was explicitly marked "subject to recon findings" and acknowledged as a recommendation.

---

## Reusable as-is via SDK exports

All available from `@umbra-privacy/sdk`:

### Key derivers (re-exported from `./crypto/index.js`)

- `getMasterViewingKeyDeriver({ client })`
- `getMasterViewingKeyBlindingFactorDeriver({ client })`
- `getPoseidonPrivateKeyDeriver({ client })`
- `getPoseidonBlindingFactorDeriver({ client })`
- `getUserAccountX25519KeypairDeriver({ client })`
- `getSecondViewingKeyDeriver({ client })`
- `getPoseidonKeystreamBlindingFactorDeriver({ client })`

### Encryption / hashing primitives

- `getPoseidonEncryptor()`
- `getPoseidonKeystreamGenerator()`
- `getKeystreamCommitmentGenerator()`
- `getUtxoCommitmentHashGenerator()` → returns `{ generateH2(...) }`
- `getUserCommitmentGeneratorFunction()`
- `getPoseidonAggregator()`
- `getAesEncryptor()`

### Modular-inverse / field math

- `computeBn254ModularInverse` (re-exported from `./math/index.js`)

### Modified-generation-index helpers

- `deriveProofAccountOffsetFromModifiedGenerationIndex`
- `deriveRandomSecretFromModifiedGenerationIndex`
- `deriveNullifierFromModifiedGenerationIndex`

### Top-level orchestration helpers (exported via `exports.X = X`)

- `getPublicBalanceToReceiverClaimableUtxoCreatorFunction` — DON'T call (does the 2-popup orchestration we're replacing)
- `getHardcodedCreateUtxoProtocolFeeProvider` — yes, exported, gives us fee slab
- `getWebsocketTransactionForwarder` — already used by `umbra.ts:makeTolerantForwarder`
- `getUserAccountQuerierFunction` — already used by us

### Prover

- `getCreateReceiverClaimableUtxoFromPublicBalanceProver` from `@umbra-privacy/web-zk-prover`

### Codama instruction builders

From `@umbra-privacy/umbra-codama`:
- `getCreatePublicStealthPoolDepositInputBufferInstructionAsync`
- `getDepositIntoStealthPoolFromPublicBalanceInstructionAsync`

Both return `{ programAddress, accounts: AccountMeta[], data: Uint8Array }`. The `accounts` array has `{ address, role }` where `role` is the `AccountRole` enum: `READONLY=0, WRITABLE=1, READONLY_SIGNER=2, WRITABLE_SIGNER=3`.

### PDA finders

From `@umbra-privacy/sdk/pda`:
- `findEncryptedUserAccountPda(address, programId)`
- `findStealthPoolPda(index, programId)`
- `findPublicUtxoInputBufferPda(address, offset, programId)`

### Other helpers found in SDK

- `feeSlabResultToInstructionFields` — top-level export, converts protocol fee result into ix-shape fields
- `extractClusterOffsetFromMxeAccount` — accessible via chunkZY3TSHMJ_cjs (NOT a top-level SDK export — see "Inline" section)
- `extractTransferFeeConfig`, `calculateTransferFee` — chunkZY3TSHMJ_cjs (not exported)
- `splitAddressToLowHigh` — chunkZY3TSHMJ_cjs (not exported)
- `encodeU64ToU64LeBytes`, `encodeU256ToU256LeBytes`, `decodeU256LeBytesToU256` — chunk5GUSMQ74_cjs (not exported)
- `assertU64`, `assertU256`, etc. — chunkLTCKPTZC_cjs (not exported)
- `generateRandomU256` — chunkZY3TSHMJ_cjs (not exported)

---

## Need to inline (not exported, must port)

The chunk-internal helpers that the pay function uses but the SDK doesn't expose:

| Function | Original chunk | LOC to port |
|---|---|---|
| `splitAddressToLowHigh(address)` | chunkZY3TSHMJ | ~10 (decode base58 → split 16/16 bytes → bigints) |
| `encodeU64ToU64LeBytes(n)` | chunk5GUSMQ74 | ~6 |
| `encodeU256ToU256LeBytes(n)` | chunk5GUSMQ74 | ~10 |
| `extractClusterOffsetFromMxeAccount(account)` | chunkZY3TSHMJ | ~5 (read offset 8 bytes from account data) |
| `extractTransferFeeConfig(mintData)` | chunkZY3TSHMJ | ~20 (Token-2022 extension parsing) |
| `calculateTransferFee(config, epoch, amount)` | chunkZY3TSHMJ | ~10 |
| Modified-generation-index kmac256 derivation | inline in pay fn | ~5 (use `kmac256` from `@noble/hashes/sha3-addons`) |
| `generateRandomU256()` | chunkZY3TSHMJ | ~5 (`crypto.getRandomValues(new Uint8Array(32))` → bigint) |
| `toBn254FieldElement` (named `toBn254FieldElement4` in SDK) | inline | trivial bigint mod |

**For our payment surface** (USDC on devnet, no transfer fee — it's a vanilla SPL token, NOT Token-2022 with TransferFee extension), we can simplify drastically:
- Skip the transfer-fee branch entirely. Detect mint owner = SPL_TOKEN_PROGRAM_ID, set `actualReceived = amount`, hardcode `mintTokenProgram = TOKEN_PROGRAM_ID`.
- We CAN restrict ourselves to vanilla SPL Token; Veil is shipping a USDC pay flow on devnet which uses devnet USDC mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, which is owned by SPL Token program.
- The wSOL fallback (per `app/.env.example`) is also SPL, not Token-2022.

This collapses the inline-port list to: split-address, u64-LE encode, u256-LE encode, mxe cluster offset, modified generation index, randomU256, field-mod. ~50 LOC total of bog-standard byte twiddling.

---

## Critical: what to AVOID

1. **No direct `@solana/kit` imports.** App has no top-level kit dep. Both `@umbra-privacy/sdk` and `@umbra-privacy/umbra-codama` ship nested `@solana/kit@6.8.0`, which produces types our app can't satisfy without `as any`. Use `@solana/web3.js` for all tx construction.

2. **No direct `@umbra-privacy/umbra-codama` imports for types.** The codama runtime is fine to call (the JS shape — `.data`, `.accounts` — is stable), but importing TypeScript types from codama drags kit-6.8 into our type graph. Use `as any` at the codama boundary, or import via `@umbra-privacy/sdk` re-exports if available.

3. **Don't try to suppress the SDK's signer + forwarder.** A capture-forwarder pattern still requires neutering `client.signer.signTransaction` (sdk:9222), which means swapping the entire signer for a noop. That's MORE invasive than just rebuilding the orchestration ourselves with codama. Stick with direct codama.

4. **Don't fork the whole 330-LOC pay function verbatim.** Many branches are dead code for our path (encrypted mint paths, Token-2022 transfer fee, optional MXE features). Inline-port only what the USDC public-balance happy path needs.

---

## The orchestration map (SDK pay function step-by-step)

| Step | SDK lines | Our action |
|---|---|---|
| 1. `assertU64(amount)` | 8870 | Inline trivial check |
| 2. Generate `effectiveGenerationIndex` (random U256) | 8874 | Inline `generateRandomU256` (4 lines) |
| 3. Get masterSeed from client | 8875-8878 | Direct: `await client.masterSeed.getMasterSeed()` |
| 4. `kmac256` → modifiedGenerationIndex (16 bytes) | 8879-8884 | Direct: `kmac256` from `@noble/hashes/sha3-addons` |
| 5. `deriveProofAccountOffsetFromModifiedGenerationIndex` | 8885 | SDK export — call directly |
| 6. Convert offset bytes → bigint (u128) | 8886-8889 | Inline (3 lines) |
| 7. Find receiver `EncryptedUserAccountPda` | 8890-8893 | SDK export `findEncryptedUserAccountPda` |
| 8. Fetch receiver account + mxe | 8894-8906 | Use `client.accountInfoProvider([...])` |
| 9. Decode receiver data → x25519 pub, userCommitment | 8907-8920 | Use `decodeEncryptedUserAccount` from codama (already imported in umbra.ts) |
| 10. Resolve mint program (SPL vs Token-2022 fee config) | 8921-8952 | **Simplify**: assume SPL; fail loudly if not. `actualReceived = amount`, `tokenProgram = TOKEN_PROGRAM_ID`. |
| 11. Compute protocol fee | 8953-8966 | Use `getHardcodedCreateUtxoProtocolFeeProvider()` (SDK export) |
| 12. Get current timestamp + components | 8967-8987 | Inline (UTC date split) |
| 13. `secondViewingKeyGenerator(mint, year, month, ...)` | 8989 | SDK export `getSecondViewingKeyDeriver` |
| 14. Split destination address low/high | 8999 | Inline `splitAddressToLowHigh` (~10 LOC) |
| 15. Sender keys: mvk, mvk-blinding, poseidon-priv, poseidon-blinding | 9000-9013 | SDK exports |
| 16. `userCommitmentGenerator(...)` | 9008 | SDK export |
| 17. `randomSecret`, `nullifier` from modifiedGenIdx | 9015-9018 | SDK exports |
| 18. `h2Generator.generateH2({...})` | 9019-9026 | SDK export `getUtxoCommitmentHashGenerator` |
| 19. Poseidon-encrypt destination address (low+high) | 9028-9042 | SDK export `getPoseidonEncryptor` |
| 20. Poseidon-keystream → first/second commitment | 9043-9070 | SDK exports `getPoseidonKeystreamGenerator`, `getPoseidonKeystreamBlindingFactorGenerator`, `getKeystreamCommitmentGenerator` |
| 21. ECDH(client_priv, receiver_pub) → AES key | 9071-9079 | `x25519.getSharedSecret` from `@noble/curves/ed25519` (already used in umbra.ts), `keccak_256` from `@noble/hashes/sha3` (already used) |
| 22. Build AES plaintext (68 bytes) + encrypt | 9080-9089 | SDK export `getAesEncryptor`, plus 6-line inline buffer assembly |
| 23. Compute modular inverses (8 of them) | 9119-9133 | SDK export `computeBn254ModularInverse` |
| 24. Build `aggregatedHashInputs` array, hash it | 9092-9118 | SDK export `getPoseidonAggregator` |
| 25. Build `zkCircuitInputs` (the proof witness) | 9134-9175 | Plain object literal — paste verbatim |
| 26. **`zkProver.prove(zkCircuitInputs)` → proofA/B/C** | 9176 | Use `getCreateReceiverClaimableUtxoFromPublicBalanceProver` from `@umbra-privacy/web-zk-prover` (already in our umbra.ts) |
| 27. Compute stealth pool PDA | 9180-9184 | SDK export `findStealthPoolPda` |
| 28. Encode bytes for h2hash, linkerEnc, keystreamCommit | 9185-9195 | Inline `encodeU256ToU256LeBytes` (~6 LOC) |
| 29. Build `getCreatePublicStealthPoolDepositInputBufferInstructionAsync` ix | 9268-9286 | Direct codama call |
| 30. Build `getDepositIntoStealthPoolFromPublicBalanceInstructionAsync` ix | 9291-9304 | Direct codama call |
| 31. Submit two txs sequentially | 9287, 9309 | **REPLACE**: combine both ix into a single `pay_invoice` ix on VeilPay, submit via `@solana/web3.js` |

---

## Suggested approach for Tasks 9-11

### Architecture summary

```
payInvoiceCpi(args)
  ├── crypto-orchestration block (~150 LOC)
  │   ├── Step 1-25 above: derive everything, run prover
  │   └── Returns: { proofA, proofB, proofC, aesData, h2Hash,
  │                  linkerEnc[2], keystreamCommit[2],
  │                  optionalData, currentTimestamp, proofAccountOffset,
  │                  protocolFeeConfig, mintTokenProgram, stealthPool,
  │                  receiverAccountAddresses... }
  │
  ├── codama-instruction-build block (~30 LOC)
  │   ├── createBufferIx = await getCreatePublicStealthPoolDepositInputBufferInstructionAsync({...})
  │   └── depositIx = await getDepositIntoStealthPoolFromPublicBalanceInstructionAsync({...})
  │
  ├── compose-veilpay-tx block (~50 LOC)
  │   ├── data = pay_invoice_discriminator || borsh(...args)
  │   ├── keys = [depositor signer, umbra program, ...createBufferIx.accounts, ...depositIx.accounts]
  │   ├── new TransactionInstruction({ programId: VEIL_PAY_PROGRAM_ID, keys, data })
  │   └── Build VersionedTransaction via @solana/web3.js
  │
  └── sign-and-submit block (~15 LOC)
      ├── Use existing wallet adapter (NOT client.signer — we already have one popup that way)
      └── Submit via @solana/web3.js Connection
```

### Critical scope note

The on-chain `pay_invoice` Anchor program (Phase 1 in flight) determines the EXACT shape of `data` we serialize. The spec's design.md sketches:

```rust
pub fn pay_invoice(
    ctx: Context<PayInvoice>,
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    h2_hash: [u8; 32],
    linker_enc: [[u8; 64]; 2],
    keystream_commit: [[u8; 32]; 2],
    aes_data: Vec<u8>,
    optional_data: Vec<u8>,
    proof_account_offset: u128,
    transfer_amount: u64,
    fee_args: FeeSlabFields,
)
```

The plan's Task 11 sketch suggests an alternative shape passing two `Vec<u8>` blobs (the raw codama data) plus an account count. **The actual on-chain shape is set by Phase 1 — until that lands, we work with the design.md shape and adjust if Phase 1 diverges.**

### Phase-1 dependency: discriminator

The `pay_invoice` instruction discriminator is `sha256("global:pay_invoice")[0..8]`. We can compute this client-side without waiting for Phase 1's IDL fetch — Anchor's discriminator scheme is deterministic. This gives us `[91, 70, 51, 33, 197, 53, 230, 47]` (will verify post-deploy via `anchor idl fetch`).

### Risk: argument-shape drift

If Phase 1 ships a different arg shape (e.g., uses Borsh-encoded raw codama blobs instead of expanded fields), we need a small adjustment in our serialization. Mitigation: keep the serialization as a single helper function, easy to swap.

### Risk: account-list ordering

Anchor's `Context<PayInvoice>` defines named accounts; our `keys` array MUST match that order. Phase 1's `lib.rs` is the source of truth. We'll need to read it once it lands and confirm our `keys` ordering aligns. **For now we use `remaining_accounts` for the union of buffer + deposit ix accounts and let the Anchor program fish them out by index.**

---

## Implementation pacing for Tasks 9-11

- **Task 9 (proof generation block):** ~150 LOC, 2 sub-commits — first the crypto utility imports + types, then the deriver chain.
- **Task 10 (codama ix build):** ~30 LOC, 1 commit. Trivial after Task 9 (just feed the derived blobs into codama call).
- **Task 11 (VeilPay tx compose + submit):** ~80 LOC, 2 sub-commits — first the ix builder, then the tx submit.

Type-check after each substantial change. Expect 1-2 `as any` casts at the codama boundary because of kit-6.8 type isolation. Keep them documented inline.
