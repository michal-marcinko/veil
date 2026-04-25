# Feature C SDK primitive check (2026-04-21)

getEncryptedBalanceToReceiverClaimableUtxoCreatorFunction — confirmed exported, CreateUtxoArgs shape matches public-balance variant.
getCreateReceiverClaimableUtxoFromEncryptedBalanceProver — confirmed exported from @umbra-privacy/web-zk-prover@2.0.1.

## Return-shape note (deviation from plan)

The plan's Task 3 anticipated that `EncryptedBalanceToReceiverClaimableUtxoCreatorFunction` returns `Promise<TransactionSignature[]>` (array). Inspection of `node_modules/@umbra-privacy/sdk/dist/index-Cd76ZBHA.d.ts` shows BOTH creators return objects:

- `CreateUtxoFromPublicBalanceResult` — `{ createProofAccountSignature, createUtxoSignature, closeProofAccountSignature? }`
- `CreateUtxoFromEncryptedBalanceResult` — `{ createProofAccountSignature, queueSignature, closeProofAccountSignature?, callbackSignature?, callbackElapsedMs?, rentClaimSignature?, rentClaimError? }`

Both are objects, NOT arrays. The encrypted variant uses `queueSignature` instead of `createUtxoSignature` (queue-based MPC flow). Task 3 normalisation will map `queueSignature` → `PayInvoiceResult.createUtxoSignature` to preserve a single result shape across both pay paths. The public-balance `payInvoice` does not need to change because both shapes are object-based — they only diverge on the inner field names.

## Runtime smoke test 2026-04-21

- Bob's encrypted balance before: DEFERRED (devnet runtime verification not run in agent session)
- Bob's encrypted balance after: DEFERRED
- Number of Phantom prompts: DEFERRED
- Solana Explorer txs visible: DEFERRED
- Observed leak (if any): DEFERRED

Manual devnet smoke must be performed by a human operator before merging — agent sessions cannot drive Phantom UI / wallet signatures. All static checks (TypeScript compile, full vitest suite) are green.
