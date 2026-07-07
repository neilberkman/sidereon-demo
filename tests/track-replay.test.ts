import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceTrackReplay,
  createTrackReplayState,
  markTrackReplaySmoothed,
  restartTrackReplay,
  setTrackReplayPlaying,
  setTrackReplaySpeed,
} from "../src/track-replay.js";

test("paused replay does not advance", () => {
  const state = createTrackReplayState(10, 5);
  assert.equal(advanceTrackReplay(state, 1000).cursor, 1);
});

test("playing replay advances by speed and carries fractional time", () => {
  let state = setTrackReplayPlaying(createTrackReplayState(10, 2), true);
  state = advanceTrackReplay(state, 750);
  assert.equal(state.cursor, 2);
  assert.equal(state.accumulator, 0.5);
  state = advanceTrackReplay(state, 250);
  assert.equal(state.cursor, 3);
  assert.equal(state.accumulator, 0);
});

test("replay stops at the final sample", () => {
  let state = setTrackReplaySpeed(createTrackReplayState(4), 10);
  state = setTrackReplayPlaying(state, true);
  state = advanceTrackReplay(state, 1000);
  assert.equal(state.cursor, 4);
  assert.equal(state.complete, true);
  assert.equal(state.playing, false);
});

test("play on a complete replay starts from the beginning", () => {
  let state = setTrackReplayPlaying(createTrackReplayState(3, 4), true);
  state = advanceTrackReplay(state, 1000);
  assert.equal(state.complete, true);
  state = setTrackReplayPlaying(state, true);
  assert.equal(state.cursor, 1);
  assert.equal(state.playing, true);
  assert.equal(state.complete, false);
});

test("restart clears smoothed state", () => {
  let state = markTrackReplaySmoothed(createTrackReplayState(3));
  state = restartTrackReplay(state);
  assert.equal(state.cursor, 1);
  assert.equal(state.smoothed, false);
});
