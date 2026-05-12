#!/usr/bin/env node
/**
 * VeilPay anchor-test harness.
 *
 * Why a custom runner?
 *   - Anchor 1.0 ships with surfpool as the default test validator. Surfpool
 *     does not natively support `--bpf-program <ADDRESS> <SO>` to mount a
 *     pre-built .so at an arbitrary address (the canonical
 *     `solana-test-validator` does, but it cannot be used on this Windows
 *     environment because it requires symlink privileges via WSL).
 *   - The veil-pay tests need TWO programs co-deployed at hard-coded ids:
 *       * veil_pay   at E2G6dN7yY8VQ2dFRgkvqskdAnPhJXkdorYP6BhKvfa8m
 *       * mock_umbra at DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ (Umbra's
 *         id; we cannot generate this keypair, so we install the bytecode via
 *         surfpool's `surfnet_setAccount` cheatcode RPC).
 *
 *   This script:
 *     1. Boots `surfpool` against in-memory SVM.
 *     2. POSTs `surfnet_setAccount` for each program — installing the .so as an
 *        executable account owned by BPFLoader2.
 *     3. Spawns ts-mocha pointed at tests/veil-pay.ts.
 *     4. Tears the validator down on exit.
 *
 * Usage: `npm test` from programs/veil-pay/
 */

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");

const REPO_ROOT = path.resolve(__dirname, "..");
const TARGET_DEPLOY = path.join(REPO_ROOT, "target", "deploy");
// invoice-registry's build artifacts live in a SIBLING workspace
// (programs/invoice-registry/), not under our `target/deploy/`. We
// resolve via REPO_ROOT/../invoice-registry/target/deploy.
const INVOICE_REGISTRY_TARGET_DEPLOY = path.resolve(
  REPO_ROOT,
  "..",
  "invoice-registry",
  "target",
  "deploy",
);

const VEILPAY_PROGRAM_ID = "E2G6dN7yY8VQ2dFRgkvqskdAnPhJXkdorYP6BhKvfa8m";
const UMBRA_PROGRAM_ID = "DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ";
const INVOICE_REGISTRY_PROGRAM_ID = "54ryi8hcihut8fDSVFSbN5NbArQ5GAd1xgmGCA3hqWoo";
const BPF_LOADER_2 = "BPFLoader2111111111111111111111111111111111";

const VEILPAY_SO = path.join(TARGET_DEPLOY, "veil_pay.so");
const MOCK_UMBRA_SO = path.join(TARGET_DEPLOY, "mock_umbra.so");
const INVOICE_REGISTRY_SO = path.join(
  INVOICE_REGISTRY_TARGET_DEPLOY,
  "invoice_registry.so",
);

const RPC_PORT = 8899;
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;

function ensureBuilt() {
  // veil_pay.so is produced by `anchor build`; we expect the caller to have
  // already run that. mock_umbra.so lives outside programs/* (so anchor build
  // does not try to generate an IDL for it) and is built here on demand via
  // `cargo build-sbf`. This keeps the test runner self-contained.
  if (!fs.existsSync(VEILPAY_SO)) {
    console.error(
      `Missing build artifact: ${VEILPAY_SO}\n` +
        `Run \`anchor build\` from programs/veil-pay/ first.`
    );
    process.exit(1);
  }

  if (!fs.existsSync(MOCK_UMBRA_SO)) {
    console.log("Building mock-umbra (one-time)...");
    const buildResult = spawnSync(
      "cargo",
      [
        "build-sbf",
        "--manifest-path",
        path.join(REPO_ROOT, "tests-rust", "mock-umbra", "Cargo.toml"),
      ],
      { stdio: "inherit", cwd: REPO_ROOT }
    );
    if (buildResult.status !== 0) {
      console.error("cargo build-sbf for mock-umbra failed");
      process.exit(buildResult.status ?? 1);
    }
  }

  // invoice_registry.so is produced by the SIBLING program's anchor build.
  // Fail loudly if it's missing — Fix 2 tests need a real invoice-registry
  // deployed at its hardcoded program id (54ryi8h...).
  if (!fs.existsSync(INVOICE_REGISTRY_SO)) {
    console.error(
      `Missing build artifact: ${INVOICE_REGISTRY_SO}\n` +
        `Run \`anchor build\` from programs/invoice-registry/ first ` +
        `(Fix 2 tests CPI into this program).`,
    );
    process.exit(1);
  }
}

function rpcCall(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    const req = http.request(
      {
        host: "127.0.0.1",
        port: RPC_PORT,
        method: "POST",
        path: "/",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(buf));
          } catch (e) {
            reject(new Error(`Bad JSON from ${method}: ${buf.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function rpcReady() {
  try {
    const r = await rpcCall("getHealth", []);
    return r.result === "ok";
  } catch {
    return false;
  }
}

async function waitForRpc(timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await rpcReady()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`RPC at ${RPC_URL} did not become ready in ${timeoutMs}ms`);
}

async function installProgram(label, pubkey, soPath) {
  const hex = fs.readFileSync(soPath).toString("hex");
  const res = await rpcCall("surfnet_setAccount", [
    pubkey,
    {
      data: hex,
      owner: BPF_LOADER_2,
      lamports: 100_000_000,
      executable: true,
      rentEpoch: 0,
    },
  ]);
  if (res.error) {
    throw new Error(
      `surfnet_setAccount failed for ${label}: ${JSON.stringify(res.error)}`
    );
  }
  // Confirm the account is now executable.
  const acc = await rpcCall("getAccountInfo", [pubkey, { encoding: "base64" }]);
  const v = acc?.result?.value;
  if (!v || !v.executable || v.owner !== BPF_LOADER_2) {
    throw new Error(
      `${label} did not deploy correctly: ${JSON.stringify(v).slice(0, 200)}`
    );
  }
  console.log(
    `  installed ${label.padEnd(11)} → ${pubkey} (${v.space} bytes, executable=${v.executable})`
  );
}

async function main() {
  ensureBuilt();

  console.log("Starting surfpool...");
  const validator = spawn(
    "surfpool",
    [
      "start",
      "--no-tui",
      "--port",
      String(RPC_PORT),
      "--ci",
      "--skip-signature-verification",
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  let validatorStderr = "";
  let validatorStdout = "";
  validator.stderr.on("data", (c) => (validatorStderr += c.toString()));
  validator.stdout.on("data", (c) => (validatorStdout += c.toString()));
  validator.on("exit", (code, sig) => {
    if (code !== 0 && code !== null) {
      console.error(`surfpool exited early (code ${code}, sig ${sig})`);
      console.error("STDERR:", validatorStderr.slice(-2000));
      console.error("STDOUT:", validatorStdout.slice(-2000));
    }
  });

  let exitCode = 1;
  try {
    await waitForRpc();
    console.log("surfpool ready. Installing programs...");
    await installProgram("veil_pay", VEILPAY_PROGRAM_ID, VEILPAY_SO);
    await installProgram("mock_umbra", UMBRA_PROGRAM_ID, MOCK_UMBRA_SO);
    await installProgram(
      "invoice_registry",
      INVOICE_REGISTRY_PROGRAM_ID,
      INVOICE_REGISTRY_SO,
    );
    console.log("Programs installed. Running mocha...\n");

    // Invoke the ts-mocha JS entrypoint directly with `node` to avoid the
    // Windows .cmd shim, which has caused stdio capture issues in this env.
    const tsMochaJs = path.join(
      REPO_ROOT,
      "node_modules",
      "ts-mocha",
      "bin",
      "ts-mocha"
    );

    const result = spawnSync(
      process.execPath,
      [
        tsMochaJs,
        "-p",
        path.join(REPO_ROOT, "tsconfig.json"),
        "-t",
        "120000",
        path.join(REPO_ROOT, "tests", "veil-pay.ts"),
      ],
      {
        // Capture buffer; pipe through manually. `inherit` was eaten by some
        // surfpool/Windows console interaction in this env.
        stdio: ["ignore", "pipe", "pipe"],
        // anchor.workspace reads ./Anchor.toml from cwd, so we must run mocha
        // from the program root.
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          ANCHOR_PROVIDER_URL: RPC_URL,
          ANCHOR_WALLET:
            process.env.ANCHOR_WALLET ||
            path.join(os.homedir(), ".config", "solana", "id.json"),
        },
      }
    );

    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);

    exitCode = result.status ?? 1;
  } catch (err) {
    console.error("Test runner failed:", err);
    console.error("Validator stderr tail:", validatorStderr.slice(-2000));
    exitCode = 1;
  } finally {
    console.log("\nShutting down surfpool...");
    try {
      validator.kill("SIGTERM");
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 2000));
    if (!validator.killed) {
      try {
        validator.kill("SIGKILL");
      } catch (_) {}
    }
  }

  process.exit(exitCode);
}

main();
