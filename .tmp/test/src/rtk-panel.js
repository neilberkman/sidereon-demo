const PHASE_ORDER = ["idle", "loading", "building", "float", "fixed", "complete"];
export function createRtkPanelState() {
    return { phase: "idle", running: false, startedAtMs: null, wallMs: null, error: null };
}
export function beginRtkPanelRun(state, nowMs) {
    if (state.running)
        return state;
    return { phase: "loading", running: true, startedAtMs: nowMs, wallMs: null, error: null };
}
export function advanceRtkPanelPhase(state, phase) {
    if (!state.running || phase === "idle" || phase === "error")
        return state;
    const current = PHASE_ORDER.indexOf(state.phase);
    const next = PHASE_ORDER.indexOf(phase);
    if (next < current)
        return state;
    return { ...state, phase };
}
export function completeRtkPanelRun(state, nowMs) {
    const wallMs = state.startedAtMs === null ? null : Math.max(0, nowMs - state.startedAtMs);
    return { ...state, phase: "complete", running: false, wallMs, error: null };
}
export function failRtkPanelRun(state, error, nowMs) {
    const wallMs = state.startedAtMs === null ? null : Math.max(0, nowMs - state.startedAtMs);
    return { ...state, phase: "error", running: false, wallMs, error };
}
export function buildRtkConvergencePoints(samples, truthBaselineM) {
    return samples.map((sample) => ({
        ...sample,
        errorM: Math.hypot(sample.baselineM[0] - truthBaselineM[0], sample.baselineM[1] - truthBaselineM[1], sample.baselineM[2] - truthBaselineM[2]),
    }));
}
