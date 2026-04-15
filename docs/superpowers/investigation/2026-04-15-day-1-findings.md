# Day 1 Investigation Findings

Date: 2026-04-15

## 1. Devnet USDC support

Attempted: `getUmbraClient({ network: "devnet", ... })` with USDC mint.
Result: UNRESOLVED — requires runtime test in Task 15 (Umbra client helper) and Task 25 (devnet E2E smoke test).

Docs evidence:
- The Supported Tokens page (https://sdk.umbraprivacy.com/supported-tokens) lists **only a "Mainnet" section** with USDC, USDT, wSOL, and UMBRA. There is **no "Devnet" section** enumerating tokens with live shielded pools.
- The Quickstart (https://sdk.umbraprivacy.com/quickstart) confirms `network: "devnet"` is a valid value and says "The Umbra program address differs between devnet and mainnet. The SDK resolves the correct address automatically based on the `network` parameter."
- So the SDK supports the `"devnet"` network string, but **which mints actually have live shielded pools on devnet is not documented** and must be verified by calling `getUserAccountQuerierFunction` / attempting a deposit against the USDC mint on devnet.

Fallback token if needed: wSOL (`So11111111111111111111111111111111111111112`) — SPL standard, most likely to be live on devnet since wSOL is the reference token. Second fallback: UMBRA (`PRVT6TB7uss3FrUd2D9xs2zqDBsa3GbMJMwCQsgmeta`). Mainnet USDC (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) is obviously not the devnet mint — if the plan proceeds on devnet, Task 14 `USDC_MINT` constant must point at the devnet USDC faucet mint or the chosen fallback.

Action for Task 15: before committing to a mint, call `getUmbraClient({ network: "devnet" })` and probe account state for each candidate mint; update this finding with the result.

## 2. optionalData on PublicBalanceToReceiverClaimable

Checked docs page: https://sdk.umbraprivacy.com/sdk/mixer/creating-utxos

**Finding: NOT EXPOSED. This breaks the UTXO-to-invoice linkage plan as originally conceived and must be flagged urgently before Task 16.**

The documented `CreateUtxoArgs` parameter list on `getPublicBalanceToReceiverClaimableUtxoCreatorFunction` is exactly:

- `args.destinationAddress: Address` (required) — recipient wallet
- `args.mint: Address` (required) — SPL or Token-2022 mint
- `args.amount: bigint` (required) — native-unit amount
- `options.priorityFees: bigint` (default `0n`) — microlamports
- `deps.zkProver: ZkProver` (required) — Groth16 prover from `@umbra-privacy/web-zk-prover`

That is the complete list. There is **no `optionalData`, `memo`, `payload`, `invoiceId`, `extraData`, or any user-controlled field** on any of the four UTXO-creator factories (`EncryptedBalance[Self/Receiver]Claimable` or `PublicBalance[Self/Receiver]Claimable`). I grepped the full extracted page text for these keywords and confirmed absence.

The docs explicitly describe the ciphertext the SDK publishes on-chain as an internal discovery mechanism, not a user payload:

> "The SDK also publishes an encrypted ciphertext on-chain so the recipient can discover the UTXO using their X25519 key."

That ciphertext encodes the UTXO's secret inputs (for the recipient to reconstruct and claim), not arbitrary metadata from the caller.

**Implication for the plan:** we cannot bind an invoice-ID to a UTXO at creation time via an SDK-native field. Two workable alternatives:

1. **On-chain Anchor binding (preferred):** have the payer call `createUtxo({ destinationAddress: <merchant>, mint, amount })` first, then in the same client-side transaction (or a following `mark_paid` CPI) record `(invoice_pda, umbra_tx_sig)` in the Veil program so the merchant can reconcile by looking up the Veil account rather than by scanning UTXO payloads. This is closer to the existing Task 16 sketch and does not depend on Umbra internals.
2. **Encrypted off-chain reference (fallback):** the payer publishes the invoice_id alongside the UTXO tx signature to an off-chain index (the encrypted Arweave metadata already exists in Task 13/14) and the merchant's Task 17 scanner looks up by tx sig. Weaker linkage because it requires two independent writes.

Neither alternative requires `optionalData`, so the plan can still land — but **Task 16 ("Pay invoice — UTXO creation + mark_paid Anchor call") must be rewritten** to not pass an `optionalData` field to `createUtxo`. The Anchor `mark_paid` instruction should take the UTXO tx signature as an argument and persist it in the invoice PDA, which makes the linkage deterministic without touching Umbra payload fields.

Urgent flag for plan owner: update Task 16 step 2/3 and the invoice state struct in Task 5 if it currently reserves space for an `optionalData` byte slice.

## 3. ZK prover cold-start time (ms)

Ran: getPublicBalanceToReceiverClaimableUtxoCreatorProver() + first proof generation
Cold-start: UNRESOLVED — requires runtime test in Task 16 (pay flow) or a dedicated micro-bench; docs only give a hand-wavy range.
Warm: UNRESOLVED — same.

Docs evidence: the Creating UTXOs page states "The prover is a CPU-intensive operation - generating a proof can take 1–5 seconds on a modern device. For browser applications, consider running the prover in a Web Worker to avoid blocking the main thread." That is the only quantitative statement in the public docs.

Pre-warm strategy needed: YES, pre-initialize. Docs say the `zkProver` dependency is constructed at factory time ("The zkProver dependency is required and cannot be omitted. Attempting to create a UTXO without it will throw at factory construction time"), which means we can (and should) construct the prover once at app boot or on the pay page mount, well before the user clicks "Pay", so the first click only pays the 1–5 s proof generation cost and not any WASM loading cost on top. Actual cold vs warm numbers must be measured on a real device during Task 16.

## 4. Wallet adapter compatibility

Tested: @solana/wallet-adapter-react signer with getUmbraClient({ signer })
Works out of box: NO — the SDK does not accept `@solana/wallet-adapter-react`'s `WalletContextState` object directly.
Wrapper needed: YES, but trivial if we use Wallet Standard accounts (which Phantom/Backpack/Solflare all register as).

Docs evidence (https://sdk.umbraprivacy.com/sdk/wallet-adapters):

- The SDK defines an `IUmbraSigner` interface:
  ```
  interface IUmbraSigner {
    readonly address: Address;
    signTransaction(tx: SignableTransaction): Promise<SignedTransaction>;
    signTransactions(txs: readonly SignableTransaction[]): Promise<SignedTransaction[]>;
    signMessage(message: Uint8Array): Promise<SignedMessage>;
  }
  ```
- The SDK ships ready-made helpers so users "do not need to implement IUmbraSigner yourself":
  - `createInMemorySigner()` — test keypair
  - `createSignerFromPrivateKeyBytes(bytes)` — load from file
  - `createSignerFromKeyPair(kps)` — adapt a `@solana/kit` KeyPairSigner
  - `createSignerFromWalletAccount(wallet, account)` — **adapts a Wallet Standard account** (the primary browser path)
- Example usage uses `@wallet-standard/react`'s `useWallets` / `useConnect`, **not** `@solana/wallet-adapter-react`'s `useWallet`.
- Hard requirement on the wallet: "The wallet must support both `solana:signTransaction` and `solana:signMessage` features — an error is thrown immediately if either is missing."

**Implication for Task 10 (wallet adapter integration):**

Option A (clean, recommended): swap `@solana/wallet-adapter-react` for `@wallet-standard/react` in the Veil app. Phantom, Backpack, and Solflare all implement Wallet Standard, so the user-facing UX is identical. We avoid writing any bridge code and use `createSignerFromWalletAccount` directly as shown in the docs example.

Option B (sticky with `@solana/wallet-adapter-react`): write a thin adapter that wraps a `WalletContextState` into an `IUmbraSigner`:
- `address`: `wallet.publicKey.toBase58()` (branded to `Address`)
- `signTransaction` / `signTransactions`: forward to `wallet.signTransaction` / `wallet.signAllTransactions`
- `signMessage`: forward to `wallet.signMessage`
- Must ensure the underlying wallet actually supports `signMessage` (not all `wallet-adapter-react` wallets do). Throw at construction time if not.
The wrapper is maybe 40 lines of TypeScript; the bigger risk is signature type mismatch between Umbra's `SignableTransaction` (`@solana/kit`) and wallet-adapter's `Transaction` (`@solana/web3.js`). If the types don't line up, Option A is strictly simpler.

Task 10 should default to Option A. Document this as a plan decision.

## 5. Indexer API rate limits

Indexer: https://utxo-indexer.api.umbraprivacy.com
Documented limits: not documented — assume generous, but verify empirically. Neither the Supported Tokens page, the Quickstart, nor any SDK reference page I fetched mentions rate limits, 429s, or per-client quotas.
Testing approach: 30 s polling for Alice's dashboard (per plan Task 17/23). At 30 s per call per tab, even a hundred concurrent merchant tabs hit the indexer at ~3 RPS aggregate, well within any reasonable limit. The risk is during demo when multiple wallets and a test loop may all scan at once — back off exponentially on first 429 and surface a toast.
Action for Task 17: wrap the scanner call in a rate-limited + retry-with-backoff helper; if we see sustained 429s in dev, reach out to Umbra via X/GitHub.

## 6. Relayer rate limits

Relayer: https://relayer.api.umbraprivacy.com
Documented limits: not documented (same search as item 5, no `rate.?limit|throttle|429` matches across the fetched SDK pages). The relayer is introduced in the Quickstart as `getUmbraRelayer({ apiEndpoint: "https://relayer.api.umbraprivacy.com" })` and used to submit claim callbacks — the plan's Task 17 auto-claim path relies on it.
Assume generous; treat as item 5: catch 429 and back off. Relayer fees are documented as **currently 0** for claims, which is a strong hint usage is low.

## 7. UTXO tree fill behavior

Tree capacity: 1,048,576 leaves (depth-20 Indexed Merkle Tree), confirmed on https://sdk.umbraprivacy.com/concepts/utxos-and-mixer.

What happens when full: the "Trees Fill Up" section of the concepts page states verbatim:

> "Each Merkle tree has a maximum of 1,048,576 leaves. When a tree is full, the write service starts a new tree at the next sequential index. UTXOs from different trees have separate anonymity sets. You specify the tree index when fetching and claiming UTXOs."

Implications:
- No hard failure when a tree fills — the protocol transparently allocates a new tree, so our create flow never blocks.
- Anonymity sets do NOT merge across trees. A merchant whose UTXOs span tree N and tree N+1 has two independent anonymity sets; a compromise or timing correlation on one tree doesn't automatically leak the other.
- Scanner and claim calls take a `treeIndex` parameter, so Task 17 needs to handle "scan all trees that contain my commitments" rather than assume a single tree. The plan should note this as a scanner requirement.
- At 1M+ UTXOs per tree on mainnet, for MVP we will almost certainly be in tree 0. Document the multi-tree case in the scanner for later-stage scale, but don't block MVP on it.

## 8. Umbra team support channel

Public channels confirmed (links found in footer/header of https://sdk.umbraprivacy.com and related pages):

- X (primary, announcements + DMs): https://x.com/UmbraPrivacy
- GitHub (code, issues): https://github.com/umbra-defi
- Telegram: UNRESOLVED — no public link found in any fetched page. If one exists it is not linked from the SDK docs site. Ask in an X DM for an invite if we need real-time support.
- Discord: UNRESOLVED — same, no public link in fetched docs. Treat as likely-not-exists or invite-only.

Action: open a GitHub discussion or file an issue against `umbra-defi` if we hit an SDK bug; for async questions reach out via X DM.

## 9. Next.js bundler compatibility

Tested: `next build` with `@umbra-privacy/sdk` + `@umbra-privacy/web-zk-prover` imports
WASM loading: UNRESOLVED — requires runtime test in Task 3 (install + smoke test) and Task 9 (Next.js init with the real bundler).
next.config.mjs additions: UNRESOLVED — same. Task 3 should attempt a Vitest import-only test first; if that passes, Task 9 should run `next build` and capture any webpack-side errors (especially around `fs`/`crypto`/`WebAssembly` shims).

Docs evidence: the SDK is declared Node 18+ or "modern browser (Vite, webpack, Next.js all fine, no special config)" per the reference notes and confirmed by the quickstart using vanilla imports. This suggests minimal config but leaves room for bundler-specific surprises. Known hazards:
- `@umbra-privacy/web-zk-prover` is advertised as browser-based and uses WASM for the Groth16 prover — Next.js 14 supports WASM via `config.experiments.asyncWebAssembly`, but the prover may also use `importScripts` for Web Worker mode which needs the app router's `dynamic = 'force-dynamic'` or a client-only import.
- Next.js 14 is strict about `node:` scheme imports on the server side — anything the SDK pulls transitively from Node built-ins (`buffer`, `crypto`) may need fallbacks in `webpack.config` or an `app/` layout-level `'use client'`.

Pre-warm for Task 3/9: default stance is "no config needed", but be ready to add one or more of:
```js
// next.config.mjs
export default {
  webpack: (config) => {
    config.experiments = { ...config.experiments, asyncWebAssembly: true, topLevelAwait: true };
    return config;
  },
};
```
Only add what is empirically necessary; resist speculative config.

## 10. Compliance grant scope format

Page: https://sdk.umbraprivacy.com/sdk/compliance-x25519-grants
Scope params: compliance grants do NOT take a free-form JSON scope object. The grant is scoped by four concrete inputs passed positionally to `getComplianceGrantIssuerFunction({ client })`:

```typescript
const createGrant = getComplianceGrantIssuerFunction({ client });

const signature = await createGrant(
  receiver,          // Address            — grantee's wallet address
  granterX25519,     // X25519PublicKey    — your MVK X25519 public key
  receiverX25519,    // X25519PublicKey    — grantee's X25519 public key
  nonce,             // RcEncryptionNonce  — 16-byte u128 nonce (generateRandomNonce())
);
```

Parameter semantics:

- `receiver` (`Address`): the wallet address that will be authorized to decrypt. The grant PDA is derived per-receiver so one granter can hold independent grants to different auditors.
- `granterX25519` (`X25519PublicKey`): the granter's MVK-derived Curve25519 public key. Obtain via `getMasterViewingKeyX25519KeypairGenerator({ client })()` then `.x25519Keypair.publicKey`. **Distinct from the user-account X25519 key used for balance encryption.**
- `receiverX25519` (`X25519PublicKey`): the grantee's X25519 public key. Look it up on-chain with `getUserAccountQuerierFunction` — `receiverAccount.data.x25519PublicKey` — the grantee must already be registered with an X25519 key.
- `nonce` (`RcEncryptionNonce`, 128-bit bigint): random u128 from `generateRandomNonce()`. The nonce is part of the PDA seed and scopes the grant. Multiple simultaneous grants to the same grantee under different nonces are legal and independent.

**What the grant covers (scope in the semantic sense):**

A compliance grant authorizes Arcium MPC to re-encrypt ciphertexts scoped to a specific `(X25519 public key, nonce)` pair. Only ciphertexts originally encrypted under that exact granter pubkey + nonce are re-encryptable. Ciphertexts under a different nonce are outside the grant, period.

**Two sharp edges that the grant UI (Task 24) must surface:**

1. **Rescue is a stream cipher, so scope == full disclosure for that nonce.** Once the grantee has any single re-encrypted ciphertext for a given nonce, they can derive the full keystream for that nonce and decrypt every past and future ciphertext produced under the same nonce — not just the one that was re-encrypted. Revocation stops *future* MPC re-encryptions but cannot retroactively reseal anything the grantee already holds. This is a one-way disclosure.
2. **Use one nonce per disclosure scope.** "Revoke grant" is a forward-only control. If the merchant wants to disclose Q1 only, generate a new nonce for Q1 and never re-use it for Q2. Reusing a nonce across grants silently expands the disclosure scope.

**Hierarchical mixer viewing keys are a separate mechanism.** For finer-grained scoped disclosure over **mixer UTXOs only** (e.g., "Feb 2026 USDC"), the plan has the orthogonal hierarchical MVK path documented in the reference memo (`Master Viewing Key → Mint → Year → Month → Day → Hour → Minute → Second`). X25519 compliance grants apply to **encrypted balances**, not mixer UTXOs. The plan's Task 18/24 should pick the right primitive per use case:
- "Show my auditor all encrypted balance ciphertexts tied to this nonce" → X25519 grant (this doc)
- "Show my auditor all mixer UTXOs received in Feb 2026" → hierarchical viewing key (separate SDK flow)

Revocation: `getComplianceGrantRevokerFunction({ client })(receiver, granterX25519, receiverX25519, nonce)` — exact same 4 inputs. Deletes the PDA, returns rent. Nothing already received by the grantee is clawed back.
