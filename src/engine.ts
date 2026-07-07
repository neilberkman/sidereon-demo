// Thin typed layer over the sidereon WASM engine. Everything here runs the real
// Rust GNSS + astrodynamics core in the browser; no values are synthesized.

import init, {
  Tle,
  GroundStation,
  loadIonex,
  sunMoonEci,
  sunMoonEcef,
  subSolarPoint,
  iodGibbs,
  rv2coe,
  temeToGcrs,
  gcrsToItrs,
  parseRinexObs,
  parseRinexNav,
  ecefToGeodetic,
  GnssSystem,
  SignalPolicy,
  loadSp3,
  loadRinexObs,
  buildRinexRtkArc,
  buildDualFrequencyRinexRtkArc,
  solveRtkArc,
  solveStaticRinexRtkBaseline,
  solveWideLaneFixedRinexRtkBaseline,
  type Ionex,
  type BroadcastEphemeris,
  type RinexObs,
  type Sp3,
} from "@neilberkman/sidereon";
import type { Constellation } from "./colors";

// Fetch wrapper that fails loudly on a non-2xx response so a missing or
// truncated data file surfaces as a clear error instead of a parse crash.
export async function okFetch(url: string): Promise<Response> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} -> ${r.status} ${r.statusText}`);
  return r;
}

// SHA-256 of a byte buffer, lowercase hex, computed in-browser via WebCrypto.
export async function sha256Hex(buf: ArrayBuffer | Uint8Array): Promise<string> {
  const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const digest = await crypto.subtle.digest("SHA-256", data as unknown as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const EARTH_RADIUS_KM = 6371.0;
export const L1_HZ = 1575.42e6;
const DEG = Math.PI / 180;

export interface Sat {
  name: string;
  prn: string;
  constellation: Constellation;
  tle: Tle;
}

let ready = false;

export async function initEngine(): Promise<void> {
  if (ready) return;
  await init();
  ready = true;
}

// One TLE file is a sequence of (name, line1, line2) triples. A few CelesTrak
// entries occasionally carry a checksum advisory; the constructor still parses
// them, so a throw is a genuinely malformed set and is skipped.
export function parseTleFile(text: string, constellation: Constellation): Sat[] {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, ""));
  const sats: Sat[] = [];
  for (let i = 0; i + 2 < lines.length + 1; i++) {
    if (!lines[i] || !lines[i].startsWith("1 ")) continue;
    const l1 = lines[i];
    const l2 = lines[i + 1];
    if (!l2 || !l2.startsWith("2 ")) continue;
    const name = (lines[i - 1] || l1).trim();
    try {
      const tle = new Tle(l1, l2);
      const prn = prnFor(name, constellation, tle.catalogNumber);
      sats.push({ name, prn, constellation, tle });
    } catch {
      // malformed element set, skip
    }
    i++; // consumed l2
  }
  return sats;
}

function prnFor(name: string, c: Constellation, cat: string): string {
  const m = name.match(/PRN\s*(\d+)/i);
  if (m) {
    const n = m[1].padStart(2, "0");
    return { GPS: "G", GAL: "E", GLO: "R", BDS: "C" }[c] + n;
  }
  return cat;
}

export function nowMicros(date: Date): bigint {
  return BigInt(Math.round(date.getTime())) * 1000n;
}

// Propagate one satellite to a single epoch; returns TEME position in km.
export function propAt(tle: Tle, micros: bigint): [number, number, number] {
  const p = tle.propagate(new BigInt64Array([micros]));
  const a = p.positionKm;
  return [a[0], a[1], a[2]];
}

// One full inertial orbit sampled as a closed ring (TEME km), computed once.
// `periodMin` is derived from mean motion via the TLE-reported revs/day.
export function orbitRing(tle: Tle, micros: bigint, samples = 64): Float64Array {
  const revsPerDay = tle.meanMotionRevPerDay || 2.0;
  const periodMs = (86400_000 / revsPerDay) | 0;
  const out = new Float64Array(samples * 3);
  const epochs = new BigInt64Array(samples);
  for (let i = 0; i < samples; i++) {
    epochs[i] = micros + BigInt(Math.round((i / samples) * periodMs)) * 1000n;
  }
  const p = tle.propagate(epochs).positionKm;
  out.set(p.subarray(0, samples * 3));
  return out;
}

// A short trailing arc of TEME positions behind a satellite: `n` samples from
// (micros - n*stepMs) up to micros, the head. Used to draw a comet tail along
// the real orbit on the globe. Returns a flat Float64Array (n*3) in km.
export function orbitTrail(tle: Tle, micros: bigint, n = 12, stepMs = 90_000): Float64Array {
  const epochs = new BigInt64Array(n);
  for (let i = 0; i < n; i++) {
    epochs[i] = micros - BigInt((n - 1 - i) * stepMs) * 1000n;
  }
  const out = new Float64Array(n * 3);
  const p = tle.propagate(epochs).positionKm;
  out.set(p.subarray(0, n * 3));
  return out;
}

// APPROXIMATE GMST (radians), used ONLY to spin the Earth mesh under the
// inertial scene so the constellation reads correctly; it is a visual rotation,
// not a proof of the frame engine. The validated frame pipeline
// (temeToGcrs -> gcrsToItrs) is what places ground-track subpoints; see
// groundTrackEcefUnits. Coastlines and tracks share the Earth-fixed group, so
// their mutual registration does not depend on this polynomial.
export function gmstRad(date: Date): number {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const d = jd - 2451545.0;
  const t = d / 36525.0;
  let g =
    280.46061837 +
    360.98564736629 * d +
    0.000387933 * t * t -
    (t * t * t) / 38710000.0;
  g = ((g % 360) + 360) % 360;
  return g * DEG;
}

// Sun direction in the inertial scene frame (unit vector), from the engine's
// ephemeris. Used to light the globe and place the day/night terminator.
export function sunDirEci(date: Date): [number, number, number] {
  const sm = sunMoonEci(new BigInt64Array([nowMicros(date)]));
  const s = sm.sun;
  const n = Math.hypot(s[0], s[1], s[2]);
  return [s[0] / n, s[1] / n, s[2] / n];
}

// Sub-solar point: the geographic latitude/longitude where the Sun is at the
// zenith, from the engine's analytic Sun ephemeris in the Earth-fixed (ITRS)
// frame. `sunMoonEcef` gives the geocentric Sun position in ECEF metres;
// `subSolarPoint` reduces that direction to the geographic point beneath it. The
// antipode of this point is the centre of Earth's night side, and the great
// circle 90 deg away from it is the day-night terminator.
export function subSolarLL(date: Date): { lat: number; lon: number } {
  const sm = sunMoonEcef(new BigInt64Array([nowMicros(date)]));
  const p = subSolarPoint(sm.sun.subarray(0, 3)) as { latitudeDeg: number; longitudeDeg: number };
  return { lat: p.latitudeDeg, lon: p.longitudeDeg };
}

// ECEF unit vector for a geodetic latitude/longitude (spherical, render-only).
export function llToEcefUnit(latDeg: number, lonDeg: number): [number, number, number] {
  const la = latDeg * DEG;
  const lo = lonDeg * DEG;
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
}

export function ecefUnitToLL(x: number, y: number, z: number): { lat: number; lon: number } {
  const r = Math.hypot(x, y, z);
  return {
    lat: Math.asin(z / r) / DEG,
    lon: Math.atan2(y, x) / DEG,
  };
}

export interface VisibleSat {
  prn: string;
  constellation: Constellation;
  az: number;
  el: number;
  rangeKm: number;
}

// Azimuth/elevation of every satellite from an observer at one epoch (the real
// SGP4 + topocentric path), filtered to those above the horizon.
export function visibleSats(
  sats: Sat[],
  latDeg: number,
  lonDeg: number,
  micros: bigint,
  maskDeg = 0,
): VisibleSat[] {
  const station = new GroundStation(latDeg, lonDeg, 0);
  const epochs = new BigInt64Array([micros]);
  const out: VisibleSat[] = [];
  try {
    for (const s of sats) {
      try {
        const look = s.tle.lookAngles(station, epochs);
        const el = look.elevationDeg[0];
        if (el > maskDeg) {
          out.push({
            prn: s.prn,
            constellation: s.constellation,
            az: look.azimuthDeg[0],
            el,
            rangeKm: look.rangeKm[0],
          });
        }
      } catch {
        /* propagation gap, skip */
      }
    }
  } finally {
    station.free();
  }
  out.sort((a, b) => b.el - a.el);
  return out;
}

export interface SkyTrack {
  prn: string;
  constellation: Constellation;
  az: number[];
  el: number[];
}

// Real sky tracks for the skyplot: for every currently-visible satellite, sample
// its topocentric azimuth/elevation across a +/- time window via the engine's
// look-angle path. The returned arcs are the satellites' actual passes over the
// observer (the curve they trace across the local dome), not decoration. One
// GroundStation is reused for the whole sweep. `nowIdx` is the sample at center.
export function skyTracks(
  sats: Sat[],
  latDeg: number,
  lonDeg: number,
  centerMicros: bigint,
  backMin = 45,
  fwdMin = 45,
  stepMin = 3,
): { tracks: SkyTrack[]; nowIdx: number } {
  const epochList: bigint[] = [];
  for (let m = -backMin; m <= fwdMin + 1e-6; m += stepMin) {
    epochList.push(centerMicros + BigInt(Math.round(m * 60 * 1e6)));
  }
  const epochs = BigInt64Array.from(epochList);
  const nowIdx = Math.round(backMin / stepMin);
  const station = new GroundStation(latDeg, lonDeg, 0);
  const tracks: SkyTrack[] = [];
  try {
    for (const s of sats) {
      try {
        const look = s.tle.lookAngles(station, epochs);
        const el = Array.from(look.elevationDeg) as number[];
        if (!(el[nowIdx] > 0)) continue; // only sats above the horizon now
        tracks.push({
          prn: s.prn,
          constellation: s.constellation,
          az: Array.from(look.azimuthDeg) as number[],
          el,
        });
      } catch {
        /* propagation gap, skip */
      }
    }
  } finally {
    station.free();
  }
  return { tracks, nowIdx };
}

export interface UpcomingPass {
  prn: string;
  constellation: Constellation;
  aos: Date;
  culmination: Date;
  maxEl: number;
}

// Dense pass finder over the next `hours`, returning the soonest rising events.
export function upcomingPasses(
  sats: Sat[],
  latDeg: number,
  lonDeg: number,
  from: Date,
  maskDeg = 10,
  hours = 6,
): UpcomingPass[] {
  const station = new GroundStation(latDeg, lonDeg, 0);
  const start = nowMicros(from);
  const end = start + BigInt(Math.round(hours * 3600)) * 1_000_000n;
  const events: UpcomingPass[] = [];
  try {
    for (const s of sats) {
      try {
        const passes = s.tle.findPasses(station, start, end, maskDeg, 120, 1e-3);
        for (const p of passes) {
          const aos = new Date(Number(p.aosUnixUs / 1000n));
          if (aos.getTime() < from.getTime()) continue; // already in view
          events.push({
            prn: s.prn,
            constellation: s.constellation,
            aos,
            culmination: new Date(Number(p.culminationUnixUs / 1000n)),
            maxEl: p.maxElevationDeg,
          });
        }
      } catch {
        /* skip */
      }
    }
  } finally {
    station.free();
  }
  events.sort((a, b) => a.aos.getTime() - b.aos.getTime());
  return events.slice(0, 8);
}

// ---- SPP solve against bundled REAL RINEX data -----------------------------
// The demo solves one recorded multi-GNSS epoch from IGS reference station ABMF
// (Le Moule, Guadeloupe) entirely in the browser. It parses the bundled RINEX3
// observation epoch and broadcast navigation file with the WASM engine, pulls
// per-system single-frequency code pseudoranges (GPS/Galileo/QZSS C1C, GLONASS
// C1C, BeiDou C2I), and runs broadcast single-point positioning. Nothing is
// precomputed: the position is whatever the engine recovers from these
// pseudoranges, scored against ABMF's surveyed coordinate (the obs header's
// APPROX POSITION XYZ).

export interface SppResult {
  positionM: Float64Array;
  geodetic: { latDeg: number; lonDeg: number; heightM: number };
  rxClockS: number;
  usedSats: string[];
  residualsM: number[];
  residualRmsM: number;
  // Dilution of precision from the converged geometry, straight from the
  // engine's SppSolution. `null` only if the geometry was rank-deficient.
  dop: { gdop: number; pdop: number; hdop: number; vdop: number; tdop: number } | null;
  distanceToTruthM: number; // 3D distance from ABMF's surveyed coordinate
  computeMs: number;
  corrections: { ionosphere: boolean; troposphere: boolean };
  elevationMaskDeg: number; // mask actually applied to this fix (0 = full sky)
  obsCount: number; // pseudoranges presented to the solver
  usedCount: number; // satellites in the accepted solution
}

export interface DualSolve {
  raw: SppResult; // broadcast geometry + clock only, no atmosphere
  corrected: SppResult; // + Klobuchar ionosphere + Saastamoinen troposphere
  deltaM: number; // 3D position shift raw -> corrected
  deltaHeightM: number; // vertical component of that shift
}

// Provenance read straight from the bundled real RINEX inputs, for the proof
// panel. Hashes are SHA-256 of the exact bytes the engine consumed.
export interface SppProvenance {
  obsFile: string;
  obsBytes: number;
  obsSha256: string;
  navFile: string;
  navBytes: number;
  navSha256: string;
  obsCount: number; // pseudoranges in the epoch
  station: string; // marker name, e.g. "ABMF"
  stationLatDeg: number;
  stationLonDeg: number;
  stationHeightM: number;
  truthEcefM: [number, number, number];
  epochUtc: string; // reception epoch, ISO
  constellations: string; // e.g. "GPS · GLONASS · Galileo · BeiDou"
}

export interface SppData {
  nav: BroadcastEphemeris;
  observations: { satelliteId: string; pseudorangeM: number }[];
  glonassChannels: [number, number][];
  klobuchar: { alpha: number[]; beta: number[] };
  met: { pressureHpa: number; temperatureK: number; relativeHumidity: number };
  tRxJ2000S: number;
  tRxSecondOfDayS: number;
  dayOfYear: number;
  truthEcefM: [number, number, number];
  // Topocentric elevation (deg) of each observed satellite at the station truth,
  // from the engine's own broadcast-orbit evaluation. Keyed by satellite token;
  // a token is absent when no usable record let us resolve its geometry. The
  // elevation mask filters the solve's input observations against this.
  elevationByPrnDeg: Record<string, number>;
  provenance: SppProvenance;
}

const J2000_UNIX_S = 946728000; // 2000-01-01T12:00:00Z in unix seconds
const C_M_S = 299792458; // speed of light, m/s (clock bias -> metres)
const GPS_EPOCH_UNIX_S = 315964800; // 1980-01-06T00:00:00Z in unix seconds
const SECONDS_PER_WEEK = 604800;
const DEFAULT_LEAP_SECONDS = 18; // GPST - UTC, used only if the nav header omits it

// Standard tropical sea-level surface meteorology for the Saastamoinen
// troposphere model at coastal Guadeloupe. Engaged only when the troposphere
// correction is on; the headline RAW fix uses none of it.
const ABMF_MET = { pressureHpa: 1013.0, temperatureK: 299.0, relativeHumidity: 0.75 };

function doyFromUtc(year: number, month: number, day: number): number {
  return Math.floor((Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 0)) / 86400000);
}

const CONSTELLATION_NAME: Record<string, string> = {
  G: "GPS",
  R: "GLONASS",
  E: "Galileo",
  C: "BeiDou",
  J: "QZSS",
};

export async function loadSppData(): Promise<SppData> {
  const obsBuf = await (await okFetch("/data/abmf_obs.rnx")).arrayBuffer();
  const navBuf = await (await okFetch("/data/abmf_nav.rnx")).arrayBuffer();

  const obs = parseRinexObs(new Uint8Array(obsBuf as ArrayBuffer));
  const nav = parseRinexNav(new Uint8Array(navBuf as ArrayBuffer));

  const [obsSha256, navSha256] = await Promise.all([sha256Hex(obsBuf), sha256Hex(navBuf)]);

  // Per-system single-frequency code pseudoranges from the bundled epoch.
  const policy = new SignalPolicy()
    .withSystem(GnssSystem.Gps, ["C1C"])
    .withSystem(GnssSystem.Galileo, ["C1C"])
    .withSystem(GnssSystem.Qzss, ["C1C"])
    .withSystem(GnssSystem.Glonass, ["C1C"])
    .withSystem(GnssSystem.BeiDou, ["C2I"]);
  const pr = obs.pseudoranges(0, policy);
  const observations: SppData["observations"] = [];
  const constellationsPresent = new Set<string>();
  for (let i = 0; i < pr.length; i++) {
    observations.push({ satelliteId: pr.satellites[i], pseudorangeM: pr.rangesM[i] });
    constellationsPresent.add(pr.satellites[i][0]);
  }

  // GLONASS is FDMA: the engine needs each used slot's frequency channel `k` to
  // scale the L1 ionosphere delay. Read it straight from the broadcast records.
  const glonassChannels: [number, number][] = [];
  const seenSlot = new Set<number>();
  for (const g of nav.glonassRecords) {
    const slot = parseInt(g.satellite.slice(1), 10);
    if (seenSlot.has(slot)) continue;
    seenSlot.add(slot);
    glonassChannels.push([slot, g.freqChannel]);
  }

  const iono = nav.ionoCorrections;
  const klobuchar = iono.gps
    ? { alpha: Array.from(iono.gps.alpha) as number[], beta: Array.from(iono.gps.beta) as number[] }
    : { alpha: [0, 0, 0, 0], beta: [0, 0, 0, 0] };

  // Reception epoch, read from the bundled observation record (not hardcoded).
  const et = obs.epoch(0).epoch;
  const sec = Math.round(et.second);
  const epochUnixS = Date.UTC(et.year, et.month - 1, et.day, et.hour, et.minute, sec) / 1000;
  const tRxJ2000S = epochUnixS - J2000_UNIX_S;
  const tRxSecondOfDayS = et.hour * 3600 + et.minute * 60 + sec;
  const dayOfYear = doyFromUtc(et.year, et.month, et.day);
  const epochUtc = new Date(epochUnixS * 1000).toISOString();

  // ABMF's surveyed coordinate, read from the observation header (APPROX
  // POSITION XYZ) — the published station truth the fix is scored against.
  const ap = obs.header.approxPositionM!;
  const truthEcefM: [number, number, number] = [ap[0], ap[1], ap[2]];
  const llh = ecefToGeodetic(Float64Array.from([ap[0] / 1000, ap[1] / 1000, ap[2] / 1000]));

  const constellations = ["G", "R", "E", "C", "J"]
    .filter((c) => constellationsPresent.has(c))
    .map((c) => CONSTELLATION_NAME[c])
    .join(" · ");

  const provenance: SppProvenance = {
    obsFile: "abmf_obs.rnx",
    obsBytes: obsBuf.byteLength,
    obsSha256,
    navFile: "abmf_nav.rnx",
    navBytes: navBuf.byteLength,
    navSha256,
    obsCount: observations.length,
    station: obs.header.markerName || "ABMF",
    stationLatDeg: llh[0],
    stationLonDeg: llh[1],
    stationHeightM: llh[2] * 1000,
    truthEcefM,
    epochUtc,
    constellations,
  };

  // Topocentric elevations of every observed satellite at the station truth,
  // computed once for this fixed epoch. The elevation mask reuses these on every
  // slider change without re-running any geometry.
  const elevationByPrnDeg = computeObservedElevations(
    nav,
    observations,
    truthEcefM,
    llh[0],
    llh[1],
    epochUnixS,
    nav.leapSeconds ?? DEFAULT_LEAP_SECONDS,
  );

  return {
    nav,
    observations,
    glonassChannels,
    klobuchar,
    met: ABMF_MET,
    tRxJ2000S,
    tRxSecondOfDayS,
    dayOfYear,
    truthEcefM,
    elevationByPrnDeg,
    provenance,
  };
}

// Topocentric elevation (deg) of each observed satellite at the station, from the
// engine's own broadcast-orbit evaluation. The Keplerian systems (GPS, Galileo,
// BeiDou, QZSS) are propagated to the receive epoch via BroadcastRecordJs.evaluate;
// GLONASS is FDMA state-vector and falls back to its broadcast reference position.
// The look angle itself is a plain ENU rotation of the station->satellite vector,
// so no positioning model is re-implemented here. A satellite is omitted only when
// no usable record resolves its geometry; the mask never drops on missing data.
function computeObservedElevations(
  nav: BroadcastEphemeris,
  observations: { satelliteId: string; pseudorangeM: number }[],
  stationEcefM: [number, number, number],
  stationLatDeg: number,
  stationLonDeg: number,
  epochUnixS: number,
  leapSeconds: number,
): Record<string, number> {
  const sow =
    (((epochUnixS + leapSeconds - GPS_EPOCH_UNIX_S) % SECONDS_PER_WEEK) + SECONDS_PER_WEEK) %
    SECONDS_PER_WEEK;
  const lat = stationLatDeg * DEG;
  const lon = stationLonDeg * DEG;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);
  const elevationOf = (satEcefM: Float64Array): number => {
    const dx = satEcefM[0] - stationEcefM[0];
    const dy = satEcefM[1] - stationEcefM[1];
    const dz = satEcefM[2] - stationEcefM[2];
    const east = -sinLon * dx + cosLon * dy;
    const north = -sinLat * cosLon * dx - sinLat * sinLon * dy + cosLat * dz;
    const up = cosLat * cosLon * dx + cosLat * sinLon * dy + sinLat * dz;
    return Math.atan2(up, Math.hypot(east, north)) * RAD;
  };

  const keplerian = new Map(nav.records.map((r) => [r.satellite, r]));
  const glonass = new Map(nav.glonassRecords.map((g) => [g.satellite, g]));

  const out: Record<string, number> = {};
  for (const o of observations) {
    const id = o.satelliteId;
    if (id in out) continue;
    const rec = keplerian.get(id);
    if (rec) {
      try {
        out[id] = elevationOf(rec.evaluate(sow).positionM);
      } catch {
        /* orbit not evaluable at this epoch: leave unresolved */
      }
      continue;
    }
    const glo = glonass.get(id);
    if (glo) {
      try {
        out[id] = elevationOf(glo.positionM);
      } catch {
        /* leave unresolved */
      }
    }
  }
  return out;
}

const RAD = 180 / Math.PI;

function buildResult(
  data: SppData,
  sol: {
    positionM: Float64Array;
    geodetic?: Float64Array;
    rxClockS: number;
    usedSats: string[];
    residualsM: Float64Array;
    dop?: { gdop: number; pdop: number; hdop: number; vdop: number; tdop: number };
  },
  corrections: { ionosphere: boolean; troposphere: boolean },
  computeMs: number,
  elevationMaskDeg: number,
): SppResult {
  const got = sol.positionM;
  const t = data.truthEcefM;
  const distanceToTruthM = Math.hypot(got[0] - t[0], got[1] - t[1], got[2] - t[2]);
  const geo = sol.geodetic!;
  const residualsM = Array.from(sol.residualsM) as number[];
  const residualRmsM = Math.sqrt(
    residualsM.reduce((a, b) => a + b * b, 0) / Math.max(1, residualsM.length),
  );
  const d = sol.dop;
  const dop = d
    ? { gdop: d.gdop, pdop: d.pdop, hdop: d.hdop, vdop: d.vdop, tdop: d.tdop }
    : null;
  return {
    positionM: got,
    geodetic: { latDeg: geo[0] * RAD, lonDeg: geo[1] * RAD, heightM: geo[2] },
    rxClockS: sol.rxClockS,
    usedSats: sol.usedSats,
    residualsM,
    residualRmsM,
    dop,
    distanceToTruthM,
    computeMs,
    corrections,
    elevationMaskDeg,
    obsCount: data.observations.length,
    usedCount: sol.usedSats.length,
  };
}

// Solve the bundled epoch with a chosen correction configuration. Two-stage and
// fully data-derived: a coarse no-atmosphere fix from the geocentre provides the
// linearization seed, then the requested corrections are solved from that seed.
// `corrections.ionosphere` engages the broadcast Klobuchar model; `troposphere`
// engages Saastamoinen from the surface met. With no corrections the coarse fix
// IS the result. `elevationMaskDeg` drops every observation whose satellite sits
// below the mask before solving (0 = full sky), re-shaping the geometry the same
// way a real receiver's cutoff would; satellites whose elevation was never
// resolved are always kept so the mask never prunes on missing data.
export function solveSpp(
  data: SppData,
  corrections: { ionosphere: boolean; troposphere: boolean } = {
    ionosphere: false,
    troposphere: false,
  },
  elevationMaskDeg = 0,
): SppResult {
  const observations =
    elevationMaskDeg <= 0
      ? data.observations
      : data.observations.filter((o) => {
          const el = data.elevationByPrnDeg[o.satelliteId];
          return el === undefined || el >= elevationMaskDeg;
        });
  const base = {
    observations,
    tRxJ2000S: data.tRxJ2000S,
    tRxSecondOfDayS: data.tRxSecondOfDayS,
    dayOfYear: data.dayOfYear,
    glonassChannels: data.glonassChannels,
    met: data.met,
    withGeodetic: true,
  };

  // Stage 1: coarse no-atmosphere fix from [0, 0, 0] (the geocentre).
  const t0 = performance.now();
  const coarse = data.nav.solveBroadcast({
    ...base,
    corrections: { ionosphere: false, troposphere: false },
    initialGuess: [0, 0, 0, 0],
  });
  const coarseMs = performance.now() - t0;

  if (!corrections.ionosphere && !corrections.troposphere) {
    return buildResult(data, coarse, corrections, coarseMs, elevationMaskDeg);
  }

  // Stage 2: re-solve with corrections, seeded by the coarse fix.
  const seed: [number, number, number, number] = [
    coarse.positionM[0],
    coarse.positionM[1],
    coarse.positionM[2],
    coarse.rxClockS * C_M_S,
  ];
  const request: Record<string, unknown> = {
    ...base,
    corrections,
    initialGuess: seed,
  };
  if (corrections.ionosphere) request.klobuchar = data.klobuchar;

  const t1 = performance.now();
  const sol = data.nav.solveBroadcast(request);
  const fineMs = performance.now() - t1;
  return buildResult(data, sol, corrections, fineMs, elevationMaskDeg);
}

// ---- RTK browser demo against bundled WTZR/WTZZ RINEX + SP3 ---------------

export interface RtkAssetBundle {
  sp3Bytes: Uint8Array;
  baseObsBytes: Uint8Array;
  roverObsBytes: Uint8Array;
  provenance: {
    sp3File: string;
    baseObsFile: string;
    roverObsFile: string;
    sp3Bytes: number;
    baseObsBytes: number;
    roverObsBytes: number;
    totalBytes: number;
    sp3Sha256: string;
    baseObsSha256: string;
    roverObsSha256: string;
    source: string;
  };
}

export interface RtkConvergenceEpoch {
  epochIndex: number;
  baselineM: [number, number, number];
}

export interface RtkDemoResult {
  epochs: number;
  sp3Epochs: number;
  baseStation: string;
  roverStation: string;
  baseArpM: [number, number, number];
  roverArpM: [number, number, number];
  truthBaselineM: [number, number, number];
  truthLengthM: number;
  floatBaselineM: [number, number, number];
  floatErrorM: number;
  fixedBaselineM: [number, number, number];
  fixedErrorM: number;
  fixedStatus: string;
  fixedRatio: number | undefined;
  wideLaneCount: number;
  convergence: RtkConvergenceEpoch[];
  wallMs: number;
  buildMs: number;
  floatMs: number;
  fixedMs: number;
}

const RTK_ASSETS = {
  sp3: "/data/rtk/GBM0MGXRAP_20201770000_01D_05M_ORB_6epoch.sp3",
  baseObs: "/data/rtk/WTZR00DEU_R_20201770000_01D_30S_MO_40epoch.rnx",
  roverObs: "/data/rtk/WTZZ00DEU_R_20201770000_01D_30S_MO_40epoch.rnx",
};

// Published ITRF2020 marker coordinates from the WTZR/WTZZ fixture provenance.
// The app computes the antenna-reference-point truth from these markers plus
// the parsed RINEX ANTENNA: DELTA H/E/N heights, then compares the solved
// baseline against that computed vector.
const WTZR_MARKER_ECEF_M: [number, number, number] = [4075580.3111, 931854.0543, 4801568.2808];
const WTZZ_MARKER_ECEF_M: [number, number, number] = [4075579.1913, 931853.3696, 4801569.1897];

const RTK_ARC_OPTIONS = { maxEpochs: 40, includePredictionTime: false };
const RTK_MODEL = {
  codeSigmaM: 2.0,
  phaseSigmaM: 0.01,
  sagnac: true,
  stochastic: "simple",
  elevationWeighting: true,
};
const RTK_SOLVE_OPTIONS = {
  positionTolM: 1.0e-4,
  ambiguityTolM: 1.0e-4,
  maxIterations: 10,
};

async function loadBytes(url: string): Promise<Uint8Array> {
  return new Uint8Array(await (await okFetch(url)).arrayBuffer());
}

export async function loadRtkAssets(): Promise<RtkAssetBundle> {
  const [sp3Bytes, baseObsBytes, roverObsBytes] = await Promise.all([
    loadBytes(RTK_ASSETS.sp3),
    loadBytes(RTK_ASSETS.baseObs),
    loadBytes(RTK_ASSETS.roverObs),
  ]);
  const [sp3Sha256, baseObsSha256, roverObsSha256] = await Promise.all([
    sha256Hex(sp3Bytes),
    sha256Hex(baseObsBytes),
    sha256Hex(roverObsBytes),
  ]);
  return {
    sp3Bytes,
    baseObsBytes,
    roverObsBytes,
    provenance: {
      sp3File: RTK_ASSETS.sp3.split("/").pop()!,
      baseObsFile: RTK_ASSETS.baseObs.split("/").pop()!,
      roverObsFile: RTK_ASSETS.roverObs.split("/").pop()!,
      sp3Bytes: sp3Bytes.byteLength,
      baseObsBytes: baseObsBytes.byteLength,
      roverObsBytes: roverObsBytes.byteLength,
      totalBytes: sp3Bytes.byteLength + baseObsBytes.byteLength + roverObsBytes.byteLength,
      sp3Sha256,
      baseObsSha256,
      roverObsSha256,
      source: "IGS MGEX / EPN public WTZR-WTZZ 2020-06-25 trims",
    },
  };
}

function vec3From(values: ArrayLike<number>): [number, number, number] {
  return [values[0], values[1], values[2]];
}

function subVec3(a: ArrayLike<number>, b: ArrayLike<number>): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function vecNorm(v: ArrayLike<number>): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function antennaHeightM(obs: RinexObs): number {
  const hen = obs.header.antennaDeltaHenM;
  if (!hen) throw new Error("RTK RINEX missing antenna height");
  const [heightM, eastM, northM] = hen;
  if (eastM !== 0 || northM !== 0) throw new Error("RTK demo expects zero east/north antenna offsets");
  return heightM;
}

function arpPosition(markerM: [number, number, number], obs: RinexObs): [number, number, number] {
  const heightM = antennaHeightM(obs);
  const radiusM = vecNorm(markerM);
  return [
    markerM[0] + (markerM[0] / radiusM) * heightM,
    markerM[1] + (markerM[1] / radiusM) * heightM,
    markerM[2] + (markerM[2] / radiusM) * heightM,
  ];
}

function vectorErrorM(actual: ArrayLike<number>, expected: ArrayLike<number>): number {
  return vecNorm(subVec3(actual, expected));
}

function stationName(obs: RinexObs, fallback: string): string {
  return obs.header.markerName || fallback;
}

function solveSequentialArc(
  singleArc: {
    epochs: unknown[];
    wavelengthsM: Record<string, number>;
    offsetsM: Record<string, number>;
  },
  baseM: [number, number, number],
): RtkConvergenceEpoch[] {
  const seq = solveRtkArc(singleArc.epochs, {
    baseM,
    model: RTK_MODEL,
    baselinePriorSigmaM: 100.0,
    ambiguityPriorSigmaM: 1000.0,
    wavelengthsM: singleArc.wavelengthsM,
    offsetsM: singleArc.offsetsM,
  }) as { epochs: { reportedBaselineM: number[] }[] };
  return seq.epochs.map((epoch, epochIndex) => ({
    epochIndex,
    baselineM: vec3From(epoch.reportedBaselineM),
  }));
}

export function solveRtkDemo(assets: RtkAssetBundle): RtkDemoResult {
  const wallStart = performance.now();
  const sp3 = loadSp3(assets.sp3Bytes) as Sp3;
  const baseObs = loadRinexObs(assets.baseObsBytes);
  const roverObs = loadRinexObs(assets.roverObsBytes);
  const baseArpM = arpPosition(WTZR_MARKER_ECEF_M, baseObs);
  const roverArpM = arpPosition(WTZZ_MARKER_ECEF_M, roverObs);
  const truthBaselineM = subVec3(roverArpM, baseArpM);

  const buildStart = performance.now();
  const singleArc = buildRinexRtkArc(sp3, baseObs, roverObs, RTK_ARC_OPTIONS) as {
    epochs: unknown[];
    wavelengthsM: Record<string, number>;
    offsetsM: Record<string, number>;
  };
  buildDualFrequencyRinexRtkArc(sp3, baseObs, roverObs, RTK_ARC_OPTIONS);
  const convergence = solveSequentialArc(singleArc, baseArpM);
  const buildMs = performance.now() - buildStart;

  const floatStart = performance.now();
  const floatSolution = solveStaticRinexRtkBaseline(sp3, baseObs, roverObs, {
    baseM: baseArpM,
    model: RTK_MODEL,
    arcOptions: RTK_ARC_OPTIONS,
    preprocessing: { cycleSlip: "splitArc" },
    opts: { float: RTK_SOLVE_OPTIONS, fixed: RTK_SOLVE_OPTIONS },
  }) as { floatSolution: { baselineM: number[] } };
  const floatMs = performance.now() - floatStart;

  const fixedStart = performance.now();
  const fixedSolution = solveWideLaneFixedRinexRtkBaseline(sp3, baseObs, roverObs, {
    baseM: baseArpM,
    model: RTK_MODEL,
    arcOptions: RTK_ARC_OPTIONS,
    opts: { float: RTK_SOLVE_OPTIONS, fixed: RTK_SOLVE_OPTIONS },
  }) as {
    fixedBaselineM: number[];
    integerStatus: string;
    integerRatio?: number;
    wideLaneAmbiguitiesCycles?: Record<string, number>;
  };
  const fixedMs = performance.now() - fixedStart;

  const floatBaselineM = vec3From(floatSolution.floatSolution.baselineM);
  const fixedBaselineM = vec3From(fixedSolution.fixedBaselineM);
  return {
    epochs: singleArc.epochs.length,
    sp3Epochs: sp3.epochCount,
    baseStation: stationName(baseObs, "WTZR"),
    roverStation: stationName(roverObs, "WTZZ"),
    baseArpM,
    roverArpM,
    truthBaselineM,
    truthLengthM: vecNorm(truthBaselineM),
    floatBaselineM,
    floatErrorM: vectorErrorM(floatBaselineM, truthBaselineM),
    fixedBaselineM,
    fixedErrorM: vectorErrorM(fixedBaselineM, truthBaselineM),
    fixedStatus: fixedSolution.integerStatus,
    fixedRatio: fixedSolution.integerRatio,
    wideLaneCount: Object.keys(fixedSolution.wideLaneAmbiguitiesCycles ?? {}).length,
    convergence,
    wallMs: performance.now() - wallStart,
    buildMs,
    floatMs,
    fixedMs,
  };
}

// ---- IONEX global vertical-TEC field ---------------------------------------

export interface TecField {
  ionex: Ionex;
  epochJ2000S: number;
  lat: number[]; // descending node latitudes
  lon: number[]; // ascending node longitudes
  vtec: number[][]; // [latIdx][lonIdx] TECU, NaN where out of coverage
  min: number;
  max: number;
}

export async function loadTecField(): Promise<TecField> {
  const ionexBuf = await (await okFetch("/data/global.ionex")).arrayBuffer();
  const ionex = loadIonex(new Uint8Array(ionexBuf as ArrayBuffer));
  const epoch = ionex.mapEpochsJ2000S[0];

  // Recover vertical TEC by inverting the engine's zenith slant delay:
  // delay_m = 40.308 * STEC / f^2, and at the zenith pierce point STEC = VTEC.
  const latNodes = Array.from(ionex.latNodesDeg);
  const lonNodes = Array.from(ionex.lonNodesDeg);
  // Render grid: 2.5 deg in longitude, the native latitude nodes.
  const lonStep = 2.5;
  const lonMin = Math.ceil(lonNodes[0] / lonStep) * lonStep;
  const lonMax = Math.floor(lonNodes[lonNodes.length - 1] / lonStep) * lonStep;
  const lons: number[] = [];
  for (let lo = lonMin; lo <= lonMax + 1e-6; lo += lonStep) lons.push(lo);
  const lats = latNodes.slice();

  const k = (L1_HZ * L1_HZ) / 40.308 / 1e16; // delay_m -> TECU
  const vtec: number[][] = [];
  let min = Infinity;
  let max = -Infinity;
  for (const la of lats) {
    const row: number[] = [];
    for (const lo of lons) {
      let v = NaN;
      try {
        const d = ionex.slantDelay(la, lo, 0, 90, epoch, L1_HZ);
        v = d * k;
        if (v < min) min = v;
        if (v > max) max = v;
      } catch {
        v = NaN;
      }
      row.push(v);
    }
    vtec.push(row);
  }
  return { ionex, epochJ2000S: epoch, lat: lats, lon: lons, vtec, min, max };
}

// ---- validated ground track ------------------------------------------------

// Off-main-thread ground tracks: a Web Worker runs the SGP4 + frame pipeline and
// posts back the finished ECEF unit-vector array for each satellite (keyed by its
// wasm Tle handle on the main thread). Priming this cache lets the globe's
// renderer build the track line via groundTrackEcefUnits WITHOUT re-propagating on
// the main thread — the worker already did the heavy work. Entries are consumed on
// read (one prime per draw), so an un-primed call always falls back to a real,
// correct propagation here.
const groundTrackPrime = new Map<Tle, Float32Array>();
export function primeGroundTrack(tle: Tle, ecef: Float32Array): void {
  groundTrackPrime.set(tle, ecef);
}

// Earth-fixed (ITRS/ECEF) subpoint unit vectors for one satellite over a set of
// epochs, run through the engine's validated frame pipeline: SGP4 TEME state ->
// temeToGcrs -> gcrsToItrs. No GMST approximation. Returns a flat Float32Array
// of unit vectors (length 3 * n), with NaN triples where propagation failed.
export function groundTrackEcefUnits(tle: Tle, epochsMicros: bigint[]): Float32Array {
  const primed = groundTrackPrime.get(tle);
  if (primed) {
    groundTrackPrime.delete(tle);
    return primed;
  }
  const n = epochsMicros.length;
  const out = new Float32Array(n * 3).fill(NaN);
  if (n === 0) return out;
  const epochs = BigInt64Array.from(epochsMicros);
  let prop;
  try {
    prop = tle.propagate(epochs);
  } catch {
    return out;
  }
  const teme = prop.positionKm; // (n,3) km TEME
  const vel = prop.velocityKmS; // (n,3) km/s TEME
  let itrs: Float64Array;
  try {
    const gcrs = temeToGcrs(teme, vel, epochs); // FrameStates, GCRS km
    itrs = gcrsToItrs(gcrs.positionKm, epochs); // (n,3) ITRS km
  } catch {
    return out;
  }
  for (let i = 0; i < n; i++) {
    const x = itrs[i * 3];
    const y = itrs[i * 3 + 1];
    const z = itrs[i * 3 + 2];
    const r = Math.hypot(x, y, z);
    if (!Number.isFinite(r) || r === 0) continue;
    out[i * 3] = x / r;
    out[i * 3 + 1] = y / r;
    out[i * 3 + 2] = z / r;
  }
  return out;
}

// ---- initial orbit determination (Gibbs) -----------------------------------
// Standard-gravitational-parameter of the Earth, km^3/s^2 (the value the core's
// two-body conversions use). Both the recovered and the truth element sets are
// reduced with the same mu, so the comparison is self-consistent.
const GM_EARTH_KM3_S2 = 398600.4418;

// A minimal view of the engine's ClassicalElements (rv2coe returns it as a plain
// object). Angles are radians; `a` and `p` are km. We only read the six primaries.
interface ClassicalElementsLite {
  a?: number;
  ecc: number;
  incl: number;
  raan: number;
  argp: number;
  nu: number;
}

export interface OrbitElements {
  aKm: number;
  ecc: number;
  inclDeg: number;
  raanDeg: number;
  argpDeg: number;
  nuDeg: number;
}

export interface OrbitRecovery {
  recovered: OrbitElements; // elements from the Gibbs-recovered velocity
  truth: OrbitElements; // elements from the satellite's own SGP4 velocity
  velRecoveredKmS: [number, number, number];
  velTruthKmS: [number, number, number];
  velErrorMs: number; // |recovered - truth| velocity magnitude, m/s
  coplanarityDeg: number; // how nearly the three sightings share a plane
  posKm: { r1: number[]; r2: number[]; r3: number[] };
  stepMin: number;
  epochIso: string;
}

function elementsFrom(c: ClassicalElementsLite): OrbitElements {
  return {
    aKm: c.a ?? NaN,
    ecc: c.ecc,
    inclDeg: c.incl * RAD,
    raanDeg: ((c.raan * RAD) % 360 + 360) % 360,
    argpDeg: ((c.argp * RAD) % 360 + 360) % 360,
    nuDeg: ((c.nu * RAD) % 360 + 360) % 360,
  };
}

// Initial orbit determination from three real position sightings. The chosen
// satellite is propagated (real SGP4, TEME) to three epochs spaced `stepMin`
// apart; the three positions alone are handed to the engine's Gibbs solver,
// which recovers the velocity at the middle position. That position + recovered
// velocity is reduced to classical elements with `rv2coe`. The satellite's own
// propagated velocity at the same instant reduces to the truth element set, so
// the panel can show how well three positions reconstruct the full orbit. All
// vectors stay in the single TEME inertial frame, so no frame conversion enters.
export function recoverOrbit(tle: Tle, stepMin = 10, center?: Date): OrbitRecovery {
  const c = center ?? new Date();
  const cm = nowMicros(c);
  const dtUs = BigInt(Math.round(stepMin * 60 * 1e6));
  const epochs = BigInt64Array.from([cm - dtUs, cm, cm + dtUs]);
  const prop = tle.propagate(epochs);
  const p = prop.positionKm; // (3,3) TEME km
  const v = prop.velocityKmS; // (3,3) TEME km/s
  const r1 = p.slice(0, 3);
  const r2 = p.slice(3, 6);
  const r3 = p.slice(6, 9);
  const gib = iodGibbs(r1, r2, r3);
  const vrec = gib.velocityKmS; // velocity at r2, km/s
  const vtruth = v.slice(3, 6); // SGP4 velocity at the middle epoch

  const recovered = elementsFrom(rv2coe(r2, vrec, GM_EARTH_KM3_S2) as ClassicalElementsLite);
  const truth = elementsFrom(rv2coe(r2, vtruth, GM_EARTH_KM3_S2) as ClassicalElementsLite);
  const velErrorMs =
    Math.hypot(vrec[0] - vtruth[0], vrec[1] - vtruth[1], vrec[2] - vtruth[2]) * 1000;

  return {
    recovered,
    truth,
    velRecoveredKmS: [vrec[0], vrec[1], vrec[2]],
    velTruthKmS: [vtruth[0], vtruth[1], vtruth[2]],
    velErrorMs,
    coplanarityDeg: gib.coplanarityRad * RAD,
    posKm: { r1: Array.from(r1), r2: Array.from(r2), r3: Array.from(r3) },
    stepMin,
    epochIso: c.toISOString(),
  };
}

// Slant ionospheric delay (metres) for an observer/satellite at the data epoch.
export function slantDelayM(
  field: TecField,
  latDeg: number,
  lonDeg: number,
  azDeg: number,
  elDeg: number,
): number {
  return field.ionex.slantDelay(latDeg, lonDeg, azDeg, elDeg, field.epochJ2000S, L1_HZ);
}
