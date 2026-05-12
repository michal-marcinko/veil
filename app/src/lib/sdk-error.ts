// ---------------------------------------------------------------------------
// Generic Solana / Umbra SDK error formatter.
//
// Both the sender (PayrollFlow) and recipient (claim page) have the
// same problem: the SDK throws a wrapper error like "Transaction
// simulation failed" while the actually-useful detail (program logs,
// inner cause messages, Umbra structured stage/code, anchor errors)
// lives nested in `error.cause.cause.simulationLogs` or worse. Walking
// the cause chain ONCE and harvesting everything we can gives both
// surfaces a chance to show actionable copy + a "Show details"
// disclosure.
//
// PayrollFlow originally inlined this helper next to its row state;
// extraction lets the claim page share the same logic without
// importing from a `"use client"` component into another `"use client"`
// page (which works but couples the two routes unnecessarily).
// ---------------------------------------------------------------------------

import { PAYMENT_SYMBOL } from "@/lib/constants";

/**
 * Structured payload for a failed operation. Carries the headline
 * summary, the program logs (when we can find them), and an optional
 * phase marker telling us WHICH step failed — useful because each
 * phase touches a different program and the right next step depends
 * on which one tripped.
 *
 * Phase values are open enums; callers pick whichever vocabulary
 * matches their flow ("fund/register/deposit" for claim-link, "scan/
 * claim/withdraw" for the recipient claim, etc.).
 */
export interface SdkErrorDetail {
  /** Single-line summary surfaced in the chip / banner. */
  summary: string;
  /** Sub-step that threw, when known. */
  phase?: string;
  /** Up to ~20 program logs from simulation, when present. */
  logs?: string[];
  /** Multi-line raw cause-chain for the disclosure pre-block. */
  rawMessage: string;
}

export interface FormatTxErrorOptions {
  /** Phase tag the caller knows because they wrapped a specific step. */
  phase?: string;
  /** Connection used to lazily fetch logs via SendTransactionError.getLogs(). */
  connection?: any;
  /** Optional log-prefix label for console.error so devtools shows where
   *  this throw came from when there are multiple contemporaneous failures. */
  consoleLabel?: string;
}

/**
 * Extract the most informative message we can from a Solana / Umbra SDK
 * thrown error. Walks `Error.cause` chains up to 8 levels deep,
 * harvesting program logs from any of: `simulationLogs` (Umbra
 * TransactionError), `logs` (web3.js anchor / RPC errors),
 * `transactionLogs` (some wallet-adapter shapes), `programLogs`. Falls
 * back to the lazy `error.getLogs(connection)` fetcher on newer
 * web3.js SendTransactionError instances when nothing inline.
 *
 * Side effect: `console.error` of the raw object so devtools shows the
 * full structure even if our shape-walk misses something.
 *
 * Heuristic hints appended at the end for two common failure shapes
 * (rent shortfall on a shadow account, public-ATA shortfall) — the
 * messages are written for the payroll context but harmless on the
 * recipient claim page (where neither hint fires).
 */
export async function formatTxError(
  err: any,
  opts?: FormatTxErrorOptions,
): Promise<SdkErrorDetail> {
  const baseMsg = err?.message ?? String(err);

  // Always log raw — first instinct on a failure is "open console",
  // and we shouldn't hide what we got.
  // eslint-disable-next-line no-console
  console.error(opts?.consoleLabel ?? "[sdk-error]", { phase: opts?.phase, err });

  // Aggressive diagnostic dump: walk the cause chain and print every
  // candidate field that might contain logs/codes/stages. We also
  // serialize each level via JSON.stringify so the browser's console
  // doesn't collapse important fields (`logs`, `simulationLogs`,
  // `context`) behind a `…`.
  //
  // `@solana/kit` SolanaError instances put RPC-side detail in
  // `.context` (an immutable object keyed by error code), not top-
  // level. Capturing both paths so we don't miss anything regardless
  // of whether the wrapping error is from the Umbra SDK, kit, or
  // bare web3.js.
  if (typeof window !== "undefined") {
    const safeStringify = (obj: any): string => {
      try {
        return JSON.stringify(
          obj,
          (_k, v) => {
            if (v instanceof Uint8Array) return `Uint8Array(len=${v.length})`;
            if (typeof v === "bigint") return v.toString();
            if (typeof v === "function") return `[Function ${v.name ?? ""}]`;
            return v;
          },
          2,
        );
      } catch (e) {
        return `[serialize-failed: ${e}]`;
      }
    };
    try {
      let cur: any = err;
      let depth = 0;
      while (cur && depth < 8) {
        const flat = {
          depth,
          name: cur?.name,
          message: cur?.message,
          code: cur?.code,
          stage: cur?.stage,
          phase: cur?.phase,
          customError: cur?.customError ?? cur?.errorCode,
          simulationLogs: cur?.simulationLogs,
          logs: cur?.logs,
          transactionLogs: cur?.transactionLogs,
          programLogs: cur?.programLogs,
          signature: cur?.signature ?? cur?.txSignature,
          signatureForLogs: cur?.signatureForLogs,
          context: cur?.context,
        };
        // eslint-disable-next-line no-console
        console.error(`  ↳ chain[${depth}] flat`, flat);
        // eslint-disable-next-line no-console
        console.error(
          `  ↳ chain[${depth}] serialized:\n${safeStringify(flat)}`,
        );
        // Also dump the raw error's own enumerable keys in case there
        // are fields we didn't think to ask for.
        const ownKeys = Object.getOwnPropertyNames(cur);
        if (ownKeys.length > 0) {
          // eslint-disable-next-line no-console
          console.error(`  ↳ chain[${depth}] ownKeys`, ownKeys);
        }
        cur = cur?.cause;
        depth++;
      }
    } catch {
      // best-effort — diagnostic only
    }
  }

  // Walk the cause chain so wrapper messages don't bury the inner detail.
  const chain: any[] = [];
  {
    let cur: any = err;
    let safety = 0;
    while (cur && safety++ < 8) {
      chain.push(cur);
      cur = cur.cause;
    }
  }

  const LOG_KEYS = [
    "simulationLogs", // Umbra TransactionError
    "logs", // web3.js anchor / RPC errors
    "transactionLogs", // some wallet-adapter shapes
    "programLogs",
  ];
  let logs: string[] | undefined;
  for (const lvl of chain) {
    for (const k of LOG_KEYS) {
      const v = lvl?.[k];
      if (Array.isArray(v) && v.length > 0) {
        logs = v as string[];
        break;
      }
    }
    if (logs) break;
  }

  if ((!logs || logs.length === 0) && opts?.connection) {
    for (const lvl of chain) {
      if (typeof lvl?.getLogs === "function") {
        try {
          const fetched = await lvl.getLogs(opts.connection);
          if (Array.isArray(fetched) && fetched.length > 0) {
            logs = fetched;
            break;
          }
        } catch {
          // getLogs can throw — best-effort.
        }
      }
    }
  }

  const umbraCode: string | undefined = chain
    .map((c) => c?.code)
    .find((c: any) => typeof c === "string");
  const umbraStage: string | undefined = chain
    .map((c) => c?.stage)
    .find((s: any) => typeof s === "string");

  const messageChain = chain
    .map((c) => c?.message)
    .filter((m: any, i, arr) => typeof m === "string" && m.length > 0 && arr.indexOf(m) === i);

  const anchorReason =
    err?.error?.errorMessage ||
    err?.errorLogs?.find?.((l: string) => /^Program log: AnchorError/.test(l));

  let summary = messageChain.length > 0 ? messageChain.join(" → ") : baseMsg;
  if (umbraStage) summary = `[${umbraStage}] ${summary}`;
  if (umbraCode && umbraCode !== `REGISTRATION_${umbraStage?.toUpperCase()}`) {
    summary = `${summary} (${umbraCode})`;
  }
  if (anchorReason) summary = `${summary} — ${anchorReason}`;
  if (logs && logs.length > 0) {
    const tail = logs.slice(-3).join(" · ");
    summary = `${summary} — ${tail}`;
  }

  if (/insufficient funds for rent/i.test(summary)) {
    summary = `${summary}\nHint: the shadow's SOL float was too low to cover Umbra registration rent. Increase SHADOW_FUNDING_LAMPORTS in payroll-claim-links.ts (current default is 0.02 SOL).`;
  } else if (
    /AccountNotFound|account does not exist|TokenAccountNotFound/i.test(summary) ||
    /0x1\b|0x1$|error: #1\b|error #1\b/i.test(summary)
  ) {
    // Error #1 from SPL Token = InsufficientFunds. On the SENDER side
    // it's typically the payer's PUBLIC wSOL ATA. On the RECIPIENT
    // (claim) side it's typically the shadow's PUBLIC wSOL ATA being
    // drained by the deposit, then the withdraw's queue ix trying to
    // debit a small fee from it. Hint covers both surfaces; the
    // sender path is the historical case we've documented.
    summary = `${summary}\nHint (SPL Token error #1 = InsufficientFunds): a public-balance debit failed. On the sender side this means your PUBLIC ${PAYMENT_SYMBOL} ATA needs more wSOL. On the claim side it likely means the shadow's wSOL ATA is empty post-deposit and the withdraw needs a small wSOL float left on it.`;
  } else if (/insufficient/i.test(summary)) {
    summary = `${summary}\nHint: a balance check failed. Check both your wallet's SOL and your wrapped-${PAYMENT_SYMBOL} ATA before re-running.`;
  }

  const rawMessageBlock =
    messageChain.length > 1
      ? messageChain.map((m, i) => `${i === 0 ? "" : "↳ caused by: "}${m}`).join("\n")
      : baseMsg;

  return {
    summary,
    phase: opts?.phase,
    logs,
    rawMessage: rawMessageBlock,
  };
}
