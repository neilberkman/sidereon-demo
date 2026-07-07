import assert from "node:assert/strict";
import test from "node:test";
import { advanceRtkPanelPhase, beginRtkPanelRun, buildRtkConvergencePoints, completeRtkPanelRun, createRtkPanelState, failRtkPanelRun, } from "../src/rtk-panel.js";
test("RTK panel run advances forward and ignores backward transitions", () => {
    let state = createRtkPanelState();
    state = beginRtkPanelRun(state, 10);
    assert.equal(state.phase, "loading");
    assert.equal(state.running, true);
    state = advanceRtkPanelPhase(state, "building");
    state = advanceRtkPanelPhase(state, "float");
    state = advanceRtkPanelPhase(state, "loading");
    assert.equal(state.phase, "float");
});
test("RTK panel completion records wall clock", () => {
    let state = beginRtkPanelRun(createRtkPanelState(), 25);
    state = advanceRtkPanelPhase(state, "fixed");
    state = completeRtkPanelRun(state, 125);
    assert.equal(state.phase, "complete");
    assert.equal(state.running, false);
    assert.equal(state.wallMs, 100);
});
test("RTK panel failure records error and stops running", () => {
    const state = failRtkPanelRun(beginRtkPanelRun(createRtkPanelState(), 0), "bad arc", 5);
    assert.equal(state.phase, "error");
    assert.equal(state.running, false);
    assert.equal(state.error, "bad arc");
    assert.equal(state.wallMs, 5);
});
test("RTK convergence points compute 3D truth error", () => {
    const points = buildRtkConvergencePoints([
        { epochIndex: 0, baselineM: [3, 4, 0] },
        { epochIndex: 1, baselineM: [1, 1, 1] },
    ], [0, 0, 0]);
    assert.equal(points[0].errorM, 5);
    assert.equal(points[1].errorM, Math.sqrt(3));
});
