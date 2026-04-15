import { describe, expect, it } from "vitest";
import {
  getUmbraClient,
  getUserRegistrationFunction,
  getUserAccountQuerierFunction,
  getPublicBalanceToReceiverClaimableUtxoCreatorFunction,
  getClaimableUtxoScannerFunction,
  getReceiverClaimableUtxoToEncryptedBalanceClaimerFunction,
  getUmbraRelayer,
  getComplianceGrantIssuerFunction,
  getEncryptedBalanceQuerierFunction,
} from "@umbra-privacy/sdk";
import {
  getCreateReceiverClaimableUtxoFromPublicBalanceProver,
  getClaimReceiverClaimableUtxoIntoEncryptedBalanceProver,
} from "@umbra-privacy/web-zk-prover";

describe("Umbra SDK imports", () => {
  it("exports all functions we depend on", () => {
    expect(getUmbraClient).toBeTypeOf("function");
    expect(getUserRegistrationFunction).toBeTypeOf("function");
    expect(getUserAccountQuerierFunction).toBeTypeOf("function");
    expect(getPublicBalanceToReceiverClaimableUtxoCreatorFunction).toBeTypeOf("function");
    expect(getClaimableUtxoScannerFunction).toBeTypeOf("function");
    expect(getReceiverClaimableUtxoToEncryptedBalanceClaimerFunction).toBeTypeOf("function");
    expect(getUmbraRelayer).toBeTypeOf("function");
    expect(getComplianceGrantIssuerFunction).toBeTypeOf("function");
    expect(getEncryptedBalanceQuerierFunction).toBeTypeOf("function");
  });

  it("exports ZK provers we depend on", () => {
    expect(getCreateReceiverClaimableUtxoFromPublicBalanceProver).toBeTypeOf("function");
    expect(getClaimReceiverClaimableUtxoIntoEncryptedBalanceProver).toBeTypeOf("function");
  });
});
