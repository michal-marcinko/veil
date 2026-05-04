# Codex Review Fixes — Parallel Implementation Plan

**Date:** 2026-05-04
**Context:** Codex review identified 4 critical issues. User confirmed all 4 fixes. Parallelizing across 4 sub-agents.
**Hackathon deadline:** May 11 (7 days remaining)

---

## Overview

Four parallel work streams. Each agent works in an **isolated git worktree** so file conflicts are impossible. After all 4 complete, integrator (me) merges branches, resolves any rare conflicts, verifies type-check + tests, then pushes the combined result to GitHub.

| Stream | Owner | Goal | Effort | Files OWNED (only this agent touches) |
|---|---|---|---|---|
| **A** | Foundation | README polish, env alignment, debug log gating | 2h | `README.md`, `app/.env.example`, `app/src/lib/constants.ts` (defaults only), `app/src/lib/payInvoiceCpi.ts` (debug log only) |
| **B** | Settlement integrity | Remove manual paid + receipt-based invoice binding | 4h | `app/src/app/dashboard/page.tsx`, `app/src/lib/receipt.ts`, `app/src/lib/anchor.ts` (mark_paid call site only) |
| **C** | Auditor links | Compliance grant URL + payroll auditor link (no auditor pubkey needed) | 6h | `app/src/app/dashboard/compliance/page.tsx`, `app/src/app/audit/[granter]/page.tsx`, `app/src/lib/umbra-auditor.ts`, NEW `app/src/lib/auditor-links.ts`, `app/src/app/payroll/[batchId]/page.tsx` |
| **D** | Claim links | Payroll claim links for unregistered recipients (ephemeral keypair pattern) | 6-8h | `app/src/components/PayrollFlow.tsx`, NEW `app/src/lib/payroll-claim-links.ts`, NEW `app/src/app/claim/[batchId]/[row]/page.tsx`, `app/src/app/payroll/new/page.tsx` |

**Files explicitly NOT TOUCHED by any of these agents** (would cause merge conflicts): `app/src/lib/umbra.ts` (only B may add a helper if absolutely required), `app/src/lib/private-payroll.ts` (read-only for all), `programs/veil-pay/` (Phase 2 work, frozen), `programs/invoice-registry/programs/invoice-registry/src/lib.rs` (B may NOT change registry program).

## Integration plan

1. Dispatch all 4 agents in parallel, each in own worktree
2. Wait for completion notifications
3. For each completed agent, fetch their branch, cherry-pick or merge into integration branch
4. Resolve any conflicts (should be minimal — partitioned by file ownership)
5. Run `npx tsc --noEmit` + `npm test` on integrated tree
6. Manual smoke test: load dashboard, verify no regressions
7. Push to GitHub via orphan-snapshot pattern
8. Watch Netlify rebuild
9. Final live smoke test

## Cross-stream interfaces

- Stream B emits new function: `markPaidWithReceiptBinding(receipt, claimSig)` — replaces manual mark calls
- Stream C exports `generateScopedGrantUrl({ scope, master_sig })` and `decryptScopedGrant({ url })` from new `auditor-links.ts`
- Stream D exports `generateClaimLink({ row, amount, mint })` and `claimFromLink({ url, recipientWallet })` from new `payroll-claim-links.ts`
- Stream A's debug log gating uses existing `isVeilDebugEnabled()` helper from `umbra.ts`

No agent depends on another's output — all 4 can ship independently.

## Bail-out criteria (per agent)

- Type errors needing files outside owned set → BLOCKED, report
- Total elapsed > 6h (B/C/D) or 2h (A) → STOP and report progress
- Any change requiring registry-program-source modification → BLOCKED (registry is frozen)
