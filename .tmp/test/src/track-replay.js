export function createTrackReplayState(sampleCount, speed = 24) {
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
export function setTrackReplayPlaying(state, playing) {
    if (state.complete && playing)
        return restartTrackReplay(state, true);
    return { ...state, playing: playing && !state.complete };
}
export function setTrackReplaySpeed(state, speed) {
    return { ...state, speed: Math.max(1, speed) };
}
export function restartTrackReplay(state, playing = false) {
    return {
        ...state,
        cursor: state.sampleCount > 0 ? 1 : 0,
        playing: playing && state.sampleCount > 0,
        complete: state.sampleCount === 0,
        smoothed: false,
        accumulator: 0,
    };
}
export function advanceTrackReplay(state, deltaMs) {
    if (!state.playing || state.complete || state.sampleCount === 0 || deltaMs <= 0)
        return state;
    const accumulator = state.accumulator + (deltaMs / 1000) * state.speed;
    const steps = Math.floor(accumulator);
    if (steps <= 0)
        return { ...state, accumulator };
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
export function markTrackReplaySmoothed(state) {
    return { ...state, smoothed: true };
}
