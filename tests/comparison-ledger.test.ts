import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

interface ValidationGate {
  status: string;
  reason?: string;
}

interface ExperimentValidation {
  status: string;
  truth: string;
  notes?: string[];
}

interface Experiment {
  id: string;
  status: string;
  claimLevel: string;
  publicClaim: boolean;
  validation: ExperimentValidation;
}

interface Ledger {
  schema: number;
  gates: Record<string, ValidationGate>;
  experiments: Experiment[];
}

function loadLedger(): Ledger {
  const raw = readFileSync(join(process.cwd(), "public/data/rtklibexplorer-comparison-ledger.json"), "utf8");
  return JSON.parse(raw) as Ledger;
}

test("comparison ledger keeps PPP SSR performance claims gated", () => {
  const ledger = loadLedger();
  assert.equal(ledger.schema, 1);
  assert.equal(ledger.gates.publishPppSsrPerformanceClaim.status, "closed");

  const ppp = ledger.experiments.find((experiment) => experiment.id === "ppp-ssr-revisited-rtklibexplorer-2026");
  assert.ok(ppp);
  assert.equal(ppp.publicClaim, false);
  assert.equal(ppp.validation.status, "pending");
});

test("comparison ledger separates full RTK oracle arc from browser quick replay", () => {
  const ledger = loadLedger();
  const full = ledger.experiments.find((experiment) => experiment.id === "wtzr-wtzz-static-rtk-120epoch");
  const quick = ledger.experiments.find((experiment) => experiment.id === "wtzr-wtzz-browser-quick-replay");

  assert.ok(full);
  assert.ok(quick);
  assert.equal(full.status, "ready_for_public_ledger");
  assert.equal(quick.status, "available_in_demo");
  assert.notEqual(full.validation.status, quick.validation.status);
});

test("public experiments must carry a validation status and truth source", () => {
  const ledger = loadLedger();
  for (const experiment of ledger.experiments.filter((entry) => entry.publicClaim)) {
    assert.notEqual(experiment.validation.status, "pending", experiment.id);
    assert.ok(experiment.validation.truth.length > 0, experiment.id);
  }
});
