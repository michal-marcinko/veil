"use client";

import { useEffect, useState } from "react";

export type RegistrationStep = "init" | "x25519" | "commitment";
export type StepStatus = "pending" | "in_progress" | "done";

interface Props {
  open: boolean;
  steps: Record<RegistrationStep, StepStatus>;
  onCancel?: () => void;
}

const STEP_LABELS: Record<RegistrationStep, string> = {
  init: "Creating your private account",
  x25519: "Registering your encryption key",
  commitment: "Enabling anonymous transfers",
};

export function RegistrationModal({ open, steps, onCancel }: Props) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-8 max-w-md w-full">
        <h2 className="text-2xl font-bold mb-2">Setting up your private account</h2>
        <p className="text-gray-400 mb-6 text-sm">
          One-time setup, about 10 seconds. You will be prompted to sign a message.
        </p>
        <ul className="space-y-3">
          {(["init", "x25519", "commitment"] as const).map((step) => (
            <li key={step} className="flex items-center gap-3">
              <StatusIcon status={steps[step]} />
              <span className={steps[step] === "done" ? "text-gray-500 line-through" : ""}>
                {STEP_LABELS[step]}
              </span>
            </li>
          ))}
        </ul>
        {onCancel && (
          <button
            onClick={onCancel}
            className="mt-6 text-sm text-gray-500 hover:text-gray-300"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: StepStatus }) {
  if (status === "done") return <span className="text-green-500">✓</span>;
  if (status === "in_progress") return <span className="animate-spin">○</span>;
  return <span className="text-gray-600">○</span>;
}
