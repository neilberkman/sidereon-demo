import assert from "node:assert/strict";
import test from "node:test";
import { passTimingLabel } from "../src/pass-labels.js";

test("future passes render real AOS", () => {
  assert.equal(
    passTimingLabel(
      { aosISO: "2026-07-07T04:52:00.000Z", losISO: "2026-07-07T05:08:00.000Z", upNow: false },
      Date.parse("2026-07-07T04:40:00.000Z"),
    ),
    "AOS 04:52Z",
  );
});

test("in-progress passes render LOS instead of current-time AOS", () => {
  assert.equal(
    passTimingLabel(
      { aosISO: "2026-07-07T04:20:00.000Z", losISO: "2026-07-07T04:58:00.000Z", upNow: true },
      Date.parse("2026-07-07T04:52:00.000Z"),
    ),
    "UP · LOS 04:58Z",
  );
});

test("a pass at the AOS boundary counts as up", () => {
  assert.equal(
    passTimingLabel(
      { aosISO: "2026-07-07T04:52:00.000Z", losISO: "2026-07-07T05:10:00.000Z" },
      Date.parse("2026-07-07T04:52:00.000Z"),
    ),
    "UP · LOS 05:10Z",
  );
});
