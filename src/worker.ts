// Off-main-thread SGP4 burst. Clicking an observer fires a few thousand
// look-angle + frame-pipeline evaluations across the whole constellation; running
// them on the main thread froze paint for ~250 ms. This worker holds its OWN copy
// of the engine (the same wasm core, initialised inside the worker) and its OWN
// Constellation, so the heavy propagation runs here and the page stays responsive.
//
// wasm handles cannot cross a thread boundary, so the worker never receives engine
// objects: the main thread posts the raw TLE text once at boot and the worker
// parses its own satellites and builds its own Constellation. Every result posted
// back is plain data (numbers + typed arrays), never a wasm object.
//
// The worker holds a long-lived all-catalog `Constellation` for all-catalog jobs.
// Observer-only work builds short-lived visible-subset constellations, so the demo
// still dogfoods the engine's batched APIs without propagating satellites the UI
// will immediately discard. Plain index-aligned `meta` carries the demo's
// prn/constellation labels alongside the fleet.

import * as Comlink from "comlink";
import {
  Constellation as Fleet,
  GroundStation,
  Tle,
  temeToGcrs,
  gcrsToItrs,
  screenTcaCandidates,
} from "@neilberkman/sidereon";
import { initEngine, parseTleFile, llToEcefUnit, EARTH_RADIUS_KM, type VisibleSat } from "./engine";
import type { Constellation } from "./colors";

// km -> scene units, IDENTICAL to globe.ts (Earth radius = 1). The constellation
// dot positions and comet trails this worker computes are uploaded straight into
// the globe's GPU buffers, so they must already be in scene units.
const SCALE = 1 / EARTH_RADIUS_KM;

export interface TleSource {
  text: string;
  constellation: Constellation;
}

// Plain, structured-cloneable shapes mirroring what setObserver used to compute.
export interface ObserveArc {
  prn: string;
  constellation: Constellation;
  az: number[];
  el: number[];
  nowIdx: number;
}
export interface ObserveTrack {
  prn: string;
  constellation: Constellation;
  ecef: Float32Array; // flat ITRS unit vectors (3*n), transferred to the main thread
}
export interface ObservePass {
  prn: string;
  constellation: Constellation;
  aosISO: string;
  maxEl: number;
}
export interface ObserveResult {
  visible: VisibleSat[];
  arcs: ObserveArc[];
  groundTracks: ObserveTrack[];
}
export interface LiveResult {
  visible: VisibleSat[];
  groundTracks: ObserveTrack[] | null;
}

// One comet-trail constellation group: a flat (3*v) position buffer and a
// matching per-vertex alpha buffer, both already in scene units, ready to feed
// straight into globe.setTrailsFromBuffers (same line-segment layout as today).
export interface TrailBuffers {
  pos: Float32Array;
  alpha: Float32Array;
}
// The continuous constellation animation for one epoch: every satellite's
// scene-space position (n*3) plus, when requested, the rebuilt comet trails.
export interface AnimationResult {
  satPos: Float32Array;
  trails: Record<Constellation, TrailBuffers> | null;
}

// A global coverage grid: for each cell of a lat/lon raster, the number of
// constellation satellites visible above the elevation mask at one epoch. The
// `counts` buffer is row-major [latIndex][lonIndex], lat ascending from latMin.
export interface CoverageResult {
  counts: Float32Array;
  width: number; // lon samples
  height: number; // lat samples
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
  minElevationDeg: number;
  satCount: number;
  maxCount: number;
  meanCount: number;
}

// One close-approach hit from screening a primary against the catalog.
export interface ConjunctionHit {
  secondaryIndex: number; // index into the screened secondaries array
  missKm: number;
  relSpeedKmS: number;
  tcaIso: string; // ISO string of the refined TCA
}

// The result of screening one primary against a whole satellite catalog.
export interface ScreenResult {
  hits: ConjunctionHit[]; // nearest approaches, ascending miss distance
  screened: number; // secondaries screened in the one batched call
  totalHits: number; // total local minima below the threshold (pre-truncation)
}

// Plain mirrors of the engine shapes (the screen function returns `any`).
interface TcaCandidateRaw {
  missDistanceKm: number;
  tcaSecondsSinceWindowStart: number;
  relativeVelocityKmS: [number, number, number];
}
interface TcaScreeningHitRaw {
  secondaryIndex: number;
  candidate: TcaCandidateRaw;
}

// Comet-trail geometry, matching globe.buildTrails EXACTLY: 18 samples per sat at
// a 120 s step, drawn as adjacent line segments with per-vertex alpha a*a*0.95,
// grouped by constellation.
const TRAIL_N = 18;
const TRAIL_STEP_MS = 120_000;

// Ground-track window + pass-search params, matching the previous main-thread
// behaviour (globe.setGroundTracks used +/-50 min at a 2 min step; the passes
// panel scanned the next 6 h above a 10 deg mask).
const TRACK_HALF_MS = 50 * 60 * 1000;
const TRACK_STEP_MS = 2 * 60 * 1000;
const PASS_MASK_DEG = 10;
const PASS_HOURS = 6;

// Sky-arc window, matching the previous skyTracks defaults (+/-45 min, 3 min step).
const SKY_BACK_MIN = 45;
const SKY_FWD_MIN = 45;
const SKY_STEP_MIN = 3;

// Per-satellite demo labels, index-aligned to the Constellation's fleet order.
interface SatMeta {
  prn: string;
  constellation: Constellation;
}

let fleet: Fleet | null = null;
let tleLinesByIndex: [string, string][] = [];
let meta: SatMeta[] = [];
// Catalog number -> fleet index, so `Constellation.visible` results (keyed by the
// satellite's own catalog number) map back to the demo's prn/constellation labels.
let indexByCatalog = new Map<string, number>();
let indexByPrn = new Map<string, number>();

interface VisibleFleet {
  fleet: Fleet;
  indexes: number[];
}

function trackEpochs(centerMicros: bigint): BigInt64Array {
  const epochs: bigint[] = [];
  for (let dt = -TRACK_HALF_MS; dt <= TRACK_HALF_MS; dt += TRACK_STEP_MS) {
    epochs.push(centerMicros + BigInt(dt) * 1000n);
  }
  return BigInt64Array.from(epochs);
}

function visibleIndexes(visible: VisibleSat[]): number[] {
  const seen = new Set<number>();
  const indexes: number[] = [];
  for (const v of visible) {
    const i = indexByPrn.get(v.prn);
    if (i === undefined || seen.has(i)) continue;
    seen.add(i);
    indexes.push(i);
  }
  return indexes;
}

function buildVisibleFleet(visible: VisibleSat[]): VisibleFleet | null {
  const indexes = visibleIndexes(visible);
  if (indexes.length === 0 || tleLinesByIndex.length === 0) return null;
  const handles = indexes.map((i) => {
    const [line1, line2] = tleLinesByIndex[i];
    return new Tle(line1, line2);
  });
  return { fleet: new Fleet(handles), indexes };
}

// Ground tracks for the currently-visible satellites: one batched
// Constellation.groundTracks call over a visible-subset fleet. This keeps the
// demonstrated library path batched while avoiding all-catalog work for a
// visible-only overlay.
function groundTracksFor(visibleFleet: VisibleFleet | null, centerMicros: bigint): ObserveTrack[] {
  if (!visibleFleet || meta.length === 0) return [];
  const epochs = trackEpochs(centerMicros);
  const tracks = visibleFleet.fleet.groundTracks(epochs);
  const out: ObserveTrack[] = [];
  for (let localIdx = 0; localIdx < visibleFleet.indexes.length; localIdx++) {
    const i = visibleFleet.indexes[localIdx];
    const m = meta[i];
    const gt = tracks[localIdx];
    let lat: Float64Array = new Float64Array();
    let lon: Float64Array = new Float64Array();
    try {
      lat = gt.latDeg;
      lon = gt.lonDeg;
    } catch {
      continue;
    } finally {
      gt?.free?.();
    }
    const ecef = new Float32Array(lat.length * 3).fill(NaN);
    for (let j = 0; j < lat.length; j++) {
      if (!Number.isFinite(lat[j]) || !Number.isFinite(lon[j])) continue;
      const u = llToEcefUnit(lat[j], lon[j]);
      ecef[j * 3] = u[0];
      ecef[j * 3 + 1] = u[1];
      ecef[j * 3 + 2] = u[2];
    }
    out.push({ prn: m.prn, constellation: m.constellation, ecef });
  }
  return out;
}

// Rebuild every satellite's comet trail and group it by constellation, byte-for-
// byte what globe.buildTrails produced on the main thread (same N, step, scene
// SCALE, and per-vertex alpha). One batched Constellation.propagate over the
// shared trailing-epoch grid replaces the per-satellite propagation loop.
function constellationTrails(micros: bigint): Record<Constellation, TrailBuffers> {
  const byC: Record<Constellation, { pos: number[]; alpha: number[] }> = {
    GPS: { pos: [], alpha: [] },
    GAL: { pos: [], alpha: [] },
    GLO: { pos: [], alpha: [] },
    BDS: { pos: [], alpha: [] },
  };
  if (fleet && meta.length > 0) {
    const epochs = new BigInt64Array(TRAIL_N);
    for (let i = 0; i < TRAIL_N; i++) {
      epochs[i] = micros - BigInt((TRAIL_N - 1 - i) * TRAIL_STEP_MS) * 1000n;
    }
    const pos = fleet.propagate(epochs).positionKm; // (n, TRAIL_N, 3) TEME km
    for (let s = 0; s < meta.length; s++) {
      const base = s * TRAIL_N * 3;
      const b = byC[meta[s].constellation];
      for (let i = 0; i < TRAIL_N - 1; i++) {
        const i0 = base + i * 3;
        const i1 = base + (i + 1) * 3;
        // A failed satellite is NaN-filled; skip degenerate segments (a fully
        // failed sat contributes nothing, matching the old per-sat skip).
        if (!Number.isFinite(pos[i0]) || !Number.isFinite(pos[i1])) continue;
        const a0 = i / (TRAIL_N - 1);
        const a1 = (i + 1) / (TRAIL_N - 1);
        b.pos.push(pos[i0] * SCALE, pos[i0 + 1] * SCALE, pos[i0 + 2] * SCALE);
        b.pos.push(pos[i1] * SCALE, pos[i1 + 1] * SCALE, pos[i1 + 2] * SCALE);
        b.alpha.push(a0 * a0 * 0.95, a1 * a1 * 0.95);
      }
    }
  }
  const out = {} as Record<Constellation, TrailBuffers>;
  (Object.keys(byC) as Constellation[]).forEach((cn) => {
    out[cn] = { pos: Float32Array.from(byC[cn].pos), alpha: Float32Array.from(byC[cn].alpha) };
  });
  return out;
}

// Visible satellites from an observer at one epoch: a single Constellation.visible
// call (the engine's SGP4 + topocentric path, filtered above the horizon and
// sorted by elevation), relabelled from catalog number to the demo's prn.
function computeVisible(lat: number, lon: number, micros: bigint): VisibleSat[] {
  if (!fleet) return [];
  const station = new GroundStation(lat, lon, 0);
  try {
    return fleet.visible(station, micros, 0).map((v) => {
      const idx = indexByCatalog.get(v.catalogNumber);
      const m = idx !== undefined ? meta[idx] : undefined;
      return {
        prn: m ? m.prn : v.catalogNumber,
        constellation: m ? m.constellation : "GPS",
        az: v.azimuthDeg,
        el: v.elevationDeg,
        rangeKm: v.rangeKm,
      };
    });
  } finally {
    station.free();
  }
}

// Sky-plot arcs: one batched Constellation.lookAngleArcs over the visible-subset
// fleet gives each currently visible satellite's az/el arc across the +/- window.
// `nowIdx` is the centre sample index.
function skyArcs(
  lat: number,
  lon: number,
  centerMicros: bigint,
  visibleFleet: VisibleFleet | null,
): { arcs: ObserveArc[]; nowIdx: number } {
  if (!visibleFleet || meta.length === 0) return { arcs: [], nowIdx: 0 };
  const epochList: bigint[] = [];
  for (let m = -SKY_BACK_MIN; m <= SKY_FWD_MIN + 1e-6; m += SKY_STEP_MIN) {
    epochList.push(centerMicros + BigInt(Math.round(m * 60 * 1e6)));
  }
  const epochs = BigInt64Array.from(epochList);
  const nowIdx = Math.round(SKY_BACK_MIN / SKY_STEP_MIN);
  const station = new GroundStation(lat, lon, 0);
  let arcsRaw;
  try {
    arcsRaw = visibleFleet.fleet.lookAngleArcs(station, epochs);
  } finally {
    station.free();
  }
  const arcs: ObserveArc[] = [];
  for (let localIdx = 0; localIdx < visibleFleet.indexes.length; localIdx++) {
    const i = visibleFleet.indexes[localIdx];
    const m = meta[i];
    const la = arcsRaw[localIdx];
    try {
      const el = Array.from(la.elevationDeg) as number[];
      if (el.length === 0 || !(el[nowIdx] > 0)) continue; // only sats above the horizon now
      arcs.push({
        prn: m.prn,
        constellation: m.constellation,
        az: Array.from(la.azimuthDeg) as number[],
        el,
        nowIdx,
      });
    } finally {
      la?.free?.();
    }
  }
  return { arcs, nowIdx };
}

const api = {
  // Initialise the wasm engine inside the worker, parse its own satellites from the
  // raw TLE text the main thread fetched once, and build the single Constellation
  // every operation runs on. The parsed Tle handles are consumed by the
  // Constellation; the plain prn/constellation labels are kept in `meta`, in fleet
  // order (which matches the main thread's Sat[] because both parse the identical
  // sources, in order, with the same parseTleFile). Returns the satellite count.
  async init(sources: TleSource[]): Promise<number> {
    await initEngine();
    const parsed = sources.flatMap((src) => parseTleFile(src.text, src.constellation));
    meta = parsed.map((s) => ({ prn: s.prn, constellation: s.constellation }));
    indexByCatalog = new Map(parsed.map((s, i) => [s.tle.catalogNumber, i]));
    indexByPrn = new Map(parsed.map((s, i) => [s.prn, i]));
    tleLinesByIndex = parsed.map((s) => s.tle.toLines() as [string, string]);
    fleet = new Fleet(parsed.map((s) => s.tle)); // consumes the Tle handles
    return fleet.satelliteCount;
  },

  // A global coverage raster at one epoch: how many constellation satellites are
  // visible above the elevation mask from each lat/lon cell. The orbital work
  // stays in the engine — every satellite is propagated once and run through the
  // validated TEME -> GCRS -> ITRS frame pipeline to an Earth-fixed position —
  // and the per-cell elevation is then a plain ENU rotation of the
  // station -> satellite vector (the same geometry `engine.ts` uses for observed
  // elevations; no positioning model is re-implemented). This is O(cells x
  // satellites) of pure arithmetic on top of one batched propagation, so a fine
  // grid resolves in well under a second.
  coverage(micros: bigint, minElevationDeg: number, latStepDeg: number, lonStepDeg: number): CoverageResult {
    const lats: number[] = [];
    for (let la = -85; la <= 85 + 1e-9; la += latStepDeg) lats.push(la);
    const lons: number[] = [];
    for (let lo = -180; lo <= 180 - lonStepDeg + 1e-9; lo += lonStepDeg) lons.push(lo);
    const width = lons.length;
    const height = lats.length;
    const counts = new Float32Array(width * height);
    let maxCount = 0;
    let total = 0;
    const satCount = fleet ? fleet.satelliteCount : 0;

    if (fleet && satCount > 0) {
      // One batched propagation to the epoch, then the validated frame pipeline to
      // Earth-fixed (ITRS) kilometres — identical to the ground-track path.
      const epochs = new BigInt64Array(satCount).fill(micros);
      const single = new BigInt64Array([micros]);
      const prop = fleet.propagate(single); // (n, 1, 3) TEME km + km/s
      const gcrs = temeToGcrs(prop.positionKm, prop.velocityKmS, epochs);
      const itrs = gcrsToItrs(gcrs.positionKm, epochs); // (n, 3) ITRS km
      const Re = EARTH_RADIUS_KM;
      const maskRad = (minElevationDeg * Math.PI) / 180;

      for (let li = 0; li < height; li++) {
        const la = (lats[li] * Math.PI) / 180;
        const sinLat = Math.sin(la);
        const cosLat = Math.cos(la);
        for (let oi = 0; oi < width; oi++) {
          const lo = (lons[oi] * Math.PI) / 180;
          const cosLon = Math.cos(lo);
          const sinLon = Math.sin(lo);
          // Observer up vector (geocentric) and surface position, kilometres.
          const ux = cosLat * cosLon;
          const uy = cosLat * sinLon;
          const uz = sinLat;
          const ox = ux * Re;
          const oy = uy * Re;
          const oz = uz * Re;
          let n = 0;
          for (let s = 0; s < satCount; s++) {
            const sx = itrs[s * 3];
            if (!Number.isFinite(sx)) continue;
            const dx = sx - ox;
            const dy = itrs[s * 3 + 1] - oy;
            const dz = itrs[s * 3 + 2] - oz;
            const rng = Math.hypot(dx, dy, dz);
            if (rng === 0) continue;
            // Elevation = asin(up · lineOfSight / range); compare in sine space.
            const sinEl = (ux * dx + uy * dy + uz * dz) / rng;
            if (sinEl >= Math.sin(maskRad)) n++;
          }
          counts[li * width + oi] = n;
          total += n;
          if (n > maxCount) maxCount = n;
        }
      }
    }
    const meanCount = counts.length ? total / counts.length : 0;
    return Comlink.transfer(
      {
        counts,
        width,
        height,
        latMin: lats[0],
        latMax: lats[height - 1],
        lonMin: lons[0],
        lonMax: lons[width - 1],
        minElevationDeg,
        satCount,
        maxCount,
        meanCount,
      },
      [counts.buffer],
    );
  },

  // Closest-approach screen of one primary against a whole satellite catalog, in
  // a single batched `screenTcaCandidates` call: the engine propagates the
  // primary and every secondary across the window and returns each local
  // time-of-closest-approach below the miss-distance threshold. We sort by miss
  // distance and return the nearest few with their TCA epoch and relative speed.
  // The secondary element sets are passed in (the caller holds them); the index
  // each hit carries maps straight back to that array.
  screenConjunctions(
    primaryL1: string,
    primaryL2: string,
    secondaries: { line1: string; line2: string }[],
    startMicros: bigint,
    endMicros: bigint,
    thresholdKm: number,
    coarseStepSeconds: number,
    topN: number,
  ): ScreenResult {
    const hits = screenTcaCandidates(
      primaryL1,
      primaryL2,
      secondaries,
      startMicros,
      endMicros,
      thresholdKm,
      { coarseStepSeconds },
    ) as TcaScreeningHitRaw[];
    const startMs = Number(startMicros / 1000n);
    const mapped: ConjunctionHit[] = (hits ?? []).map((h) => {
      const c = h.candidate;
      const rv = c.relativeVelocityKmS;
      return {
        secondaryIndex: h.secondaryIndex,
        missKm: c.missDistanceKm,
        relSpeedKmS: Math.hypot(rv[0], rv[1], rv[2]),
        tcaIso: new Date(startMs + c.tcaSecondsSinceWindowStart * 1000).toISOString(),
      };
    });
    mapped.sort((a, b) => a.missKm - b.missKm);
    return { hits: mapped.slice(0, topN), screened: secondaries.length, totalHits: mapped.length };
  },

  // The FAST half of a click: visible satellites, sky-pass arcs, and globe ground
  // tracks for one epoch, returned as transferable plain data. The slow 6 h pass
  // scan is split into passes() below so it never delays these.
  observe(lat: number, lon: number, micros: bigint): ObserveResult {
    const visible = computeVisible(lat, lon, micros);
    const visibleFleet = buildVisibleFleet(visible);
    let arcs: ObserveArc[] = [];
    let groundTracks: ObserveTrack[] = [];
    try {
      arcs = skyArcs(lat, lon, micros, visibleFleet).arcs;
      groundTracks = groundTracksFor(visibleFleet, micros);
    } finally {
      visibleFleet?.fleet.free();
    }

    return Comlink.transfer(
      { visible, arcs, groundTracks },
      groundTracks.map((t) => t.ecef.buffer),
    );
  },

  // The SLOW tail of a click, split off so it never delays the fast results: the
  // 6 h pass scan above the mask, in one batched Constellation.passes call. Fired
  // right after observe() for the same epoch.
  passes(lat: number, lon: number, micros: bigint): ObservePass[] {
    if (!fleet) return [];
    const from = new Date(Number(micros / 1000n));
    const start = micros;
    const end = start + BigInt(Math.round(PASS_HOURS * 3600)) * 1_000_000n;
    const station = new GroundStation(lat, lon, 0);
    let found;
    try {
      found = fleet.passes(station, start, end, PASS_MASK_DEG, 120, 1e-3);
    } finally {
      station.free();
    }
    const events: ObservePass[] = [];
    for (const p of found) {
      const aos = new Date(Number(p.aosUnixUs / 1000n));
      if (aos.getTime() < from.getTime()) continue; // already in view
      const m = meta[p.satelliteIndex];
      if (!m) continue;
      events.push({
        prn: m.prn,
        constellation: m.constellation,
        aosISO: aos.toISOString(),
        maxEl: p.maxElevationDeg,
      });
    }
    events.sort((a, b) => Date.parse(a.aosISO) - Date.parse(b.aosISO));
    return events;
  },

  // The continuous constellation animation, off the main thread: one batched
  // Constellation.propagate to `micros` gives every satellite's scene-space dot,
  // and (when `includeTrails`) the comet trails are rebuilt from a second batched
  // propagate over the trailing grid. Returns plain transferable typed arrays the
  // globe uploads straight to the GPU; no SGP4 ever runs on the main thread here.
  // The satPos index order matches the main thread's Sat[] (identical parse).
  animation(micros: bigint, includeTrails: boolean): AnimationResult {
    const n = fleet ? fleet.satelliteCount : 0;
    const satPos = new Float32Array(n * 3);
    if (fleet && n > 0) {
      const pos = fleet.propagate(new BigInt64Array([micros])).positionKm; // (n, 1, 3)
      for (let i = 0; i < n; i++) {
        const x = pos[i * 3];
        const y = pos[i * 3 + 1];
        const z = pos[i * 3 + 2];
        // A failed satellite is NaN-filled; leave its dot at the origin, the same
        // as the old per-sat propagation-gap behaviour.
        if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
          satPos[i * 3] = x * SCALE;
          satPos[i * 3 + 1] = y * SCALE;
          satPos[i * 3 + 2] = z * SCALE;
        }
      }
    }
    const trails = includeTrails ? constellationTrails(micros) : null;
    const transfers: Transferable[] = [satPos.buffer as ArrayBuffer];
    if (trails) {
      for (const cn of Object.keys(trails) as Constellation[]) {
        transfers.push(trails[cn].pos.buffer as ArrayBuffer, trails[cn].alpha.buffer as ArrayBuffer);
      }
    }
    return Comlink.transfer({ satPos, trails }, transfers);
  },

  // The recurring live tick: refresh visible satellites every call, and the globe
  // ground tracks only when asked (the loop did this every 8th tick).
  live(lat: number, lon: number, micros: bigint, includeTracks: boolean): LiveResult {
    const visible = computeVisible(lat, lon, micros);
    let groundTracks: ObserveTrack[] | null = null;
    if (includeTracks) {
      const visibleFleet = buildVisibleFleet(visible);
      try {
        groundTracks = groundTracksFor(visibleFleet, micros);
      } finally {
        visibleFleet?.fleet.free();
      }
    }
    return Comlink.transfer(
      { visible, groundTracks },
      groundTracks ? groundTracks.map((t) => t.ecef.buffer) : [],
    );
  },
};

export type ObserveWorkerApi = typeof api;

Comlink.expose(api);
