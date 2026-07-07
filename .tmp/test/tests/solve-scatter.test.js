import assert from "node:assert/strict";
import test from "node:test";
import { beginSolveScatterTransition, buildSolveScatterPoints, ecefDeltaToEnuM, interpolateSolveScatterTransition, } from "../src/solve-scatter.js";
test("ECEF delta projects to local ENU axes", () => {
    assert.deepEqual(ecefDeltaToEnuM(0, 0, [0, 1, 0]).map((v) => Math.round(v)), [1, 0, 0]);
    assert.deepEqual(ecefDeltaToEnuM(0, 0, [0, 0, 1]).map((v) => Math.round(v)), [0, 1, 0]);
    assert.deepEqual(ecefDeltaToEnuM(0, 0, [1, 0, 0]).map((v) => Math.round(v)), [0, 0, 1]);
});
test("scatter points are keyed, active, and error-scored from real fix positions", () => {
    const points = buildSolveScatterPoints([
        { key: "none", label: "RAW", positionM: [10, 0, 0] },
        { key: "both", label: "+IONO+TROPO", positionM: [1, 0, 0] },
    ], "both", [0, 0, 0], 0, 0);
    assert.equal(points[0].active, false);
    assert.equal(points[1].active, true);
    assert.equal(points[0].errorM, 10);
    assert.equal(points[1].errorM, 1);
});
test("scatter transition interpolates by key and lands on target", () => {
    const start = buildSolveScatterPoints([{ key: "none", label: "RAW", positionM: [10, 0, 0] }], "none", [0, 0, 0], 0, 0);
    const end = buildSolveScatterPoints([{ key: "none", label: "RAW", positionM: [2, 0, 0] }], "none", [0, 0, 0], 0, 0);
    const transition = beginSolveScatterTransition(start, end, 100, 200);
    const mid = interpolateSolveScatterTransition(transition, 200)[0];
    const done = interpolateSolveScatterTransition(transition, 300)[0];
    assert.ok(mid.upM < 10 && mid.upM > 2);
    assert.equal(done.upM, 2);
});
