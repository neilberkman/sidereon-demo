export interface TrackReplayState {
  sampleCount: number;
  cursor: number;
  speed: number;
  playing: boolean;
  complete: boolean;
  smoothed: boolean;
  accumulator: number;
}

export function createTrackReplayState(sampleCount: number, speed = 24): TrackReplayState {
  const n = Math.max(0, Math.floor(sampleCount));
  return {
    sampleCount: n,
    cursor: n > 0 ? 1 : 0,
    speed: Math.max(1, speed),
    playing: false,
    complete: n === 0,
    smoothed: false,
    accumulator: 0,
  };
}

export function setTrackReplayPlaying(state: TrackReplayState, playing: boolean): TrackReplayState {
  if (state.complete && playing) return restartTrackReplay(state, true);
  return { ...state, playing: playing && !state.complete };
}

export function setTrackReplaySpeed(state: TrackReplayState, speed: number): TrackReplayState {
  return { ...state, speed: Math.max(1, speed) };
}

export function restartTrackReplay(state: TrackReplayState, playing = false): TrackReplayState {
  return {
    ...state,
    cursor: state.sampleCount > 0 ? 1 : 0,
    playing: playing && state.sampleCount > 0,
    complete: state.sampleCount === 0,
    smoothed: false,
    accumulator: 0,
  };
}

export function advanceTrackReplay(state: TrackReplayState, deltaMs: number): TrackReplayState {
  if (!state.playing || state.complete || state.sampleCount === 0 || deltaMs <= 0) return state;

  const accumulator = state.accumulator + (deltaMs / 1000) * state.speed;
  const steps = Math.floor(accumulator);
  if (steps <= 0) return { ...state, accumulator };

  const cursor = Math.min(state.sampleCount, state.cursor + steps);
  const complete = cursor >= state.sampleCount;
  return {
    ...state,
    cursor,
    complete,
    playing: !complete,
    accumulator: complete ? 0 : accumulator - steps,
  };
}

export function markTrackReplaySmoothed(state: TrackReplayState): TrackReplayState {
  return { ...state, smoothed: true };
}
