export type RtkPanelPhase = "idle" | "loading" | "building" | "float" | "fixed" | "complete" | "error";

export interface RtkPanelState {
  phase: RtkPanelPhase;
  running: boolean;
  startedAtMs: number | null;
  wallMs: number | null;
  error: string | null;
}

export interface RtkConvergenceSample {
  epochIndex: number;
  baselineM: [number, number, number];
}

export interface RtkConvergencePoint extends RtkConvergenceSample {
  errorM: number;
}

const PHASE_ORDER: RtkPanelPhase[] = ["idle", "loading", "building", "float", "fixed", "complete"];

export function createRtkPanelState(): RtkPanelState {
  return { phase: "idle", running: false, startedAtMs: null, wallMs: null, error: null };
}

export function beginRtkPanelRun(state: RtkPanelState, nowMs: number): RtkPanelState {
  if (state.running) return state;
  return { phase: "loading", running: true, startedAtMs: nowMs, wallMs: null, error: null };
}

export function advanceRtkPanelPhase(state: RtkPanelState, phase: RtkPanelPhase): RtkPanelState {
  if (!state.running || phase === "idle" || phase === "error") return state;
  const current = PHASE_ORDER.indexOf(state.phase);
  const next = PHASE_ORDER.indexOf(phase);
  if (next < current) return state;
  return { ...state, phase };
}

export function completeRtkPanelRun(state: RtkPanelState, nowMs: number): RtkPanelState {
  const wallMs = state.startedAtMs === null ? null : Math.max(0, nowMs - state.startedAtMs);
  return { ...state, phase: "complete", running: false, wallMs, error: null };
}

export function failRtkPanelRun(state: RtkPanelState, error: string, nowMs: number): RtkPanelState {
  const wallMs = state.startedAtMs === null ? null : Math.max(0, nowMs - state.startedAtMs);
  return { ...state, phase: "error", running: false, wallMs, error };
}

export function buildRtkConvergencePoints(
  samples: RtkConvergenceSample[],
  truthBaselineM: [number, number, number],
): RtkConvergencePoint[] {
  return samples.map((sample) => ({
    ...sample,
    errorM: Math.hypot(
      sample.baselineM[0] - truthBaselineM[0],
      sample.baselineM[1] - truthBaselineM[1],
      sample.baselineM[2] - truthBaselineM[2],
    ),
  }));
}
