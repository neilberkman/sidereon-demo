import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const sidereon = require("@neilberkman/sidereon");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = "/private/tmp/fusion-trial/data/gsdc/2020-05-14-US-MTV-1";
const RINEX_PATH = join(DATA_DIR, "Pixel4_GnssLog.20o");
const TRUTH_PATH = join(DATA_DIR, "SPAN_Pixel4_10Hz.nmea");
const NAV_PATH = "/private/tmp/fusion-trial/data/BRDM00DLR_S_20201350000_01D_MN.rnx";
const OUT_PATH = join(ROOT, "public", "data", "track-cleanup-gsdc-mtv.json");
const DRIVE_DATE = [2020, 5, 14];
const GPS_MINUS_UTC_S = sidereon.leapSeconds(...DRIVE_DATE) - 19.0;

function parsePhoneRinex() {
  const text = readFileSync(RINEX_PATH, "utf8");
  try {
    return sidereon.parseRinexObs(Buffer.from(text));
  } catch (firstError) {
    const lines = text.split(/\r?\n/);
    const starts = lines.flatMap((line, i) => (line.startsWith(">") ? [i] : []));
    const start = starts.at(-1);
    if (start === undefined) throw firstError;
    return sidereon.parseRinexObs(Buffer.from(lines.slice(0, start).join("\n") + "\n"));
  }
}

function secOfDay(t) {
  return t.hour * 3600 + t.minute * 60 + t.second;
}

function dayOfYear(t) {
  return Math.floor((Date.UTC(t.year, t.month - 1, t.day) - Date.UTC(t.year, 0, 0)) / 86400000);
}

function geodeticToEcefM(latDeg, lonDeg, heightM) {
  const p = sidereon.geodeticToEcef(Float64Array.from([latDeg, lonDeg, heightM / 1000]));
  return [p[0] * 1000, p[1] * 1000, p[2] * 1000];
}

function ecefToGeodeticM(positionM) {
  const g = sidereon.ecefToGeodetic(Float64Array.from(positionM.map((v) => v / 1000)));
  return [g[0], g[1], g[2] * 1000];
}

function interpolate(queryS, timesS, values) {
  let j = 0;
  while (j < timesS.length - 2 && timesS[j + 1] < queryS) j++;
  const t0 = timesS[j];
  const t1 = timesS[j + 1];
  const f = (queryS - t0) / (t1 - t0);
  return [0, 1, 2].map((axis) => values[j][axis] + (values[j + 1][axis] - values[j][axis]) * f);
}

function enuTransform(originLlh) {
  const lat = (originLlh[0] * Math.PI) / 180;
  const lon = (originLlh[1] * Math.PI) / 180;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);
  const r = [
    [-sinLon, cosLon, 0],
    [-sinLat * cosLon, -sinLat * sinLon, cosLat],
    [cosLat * cosLon, cosLat * sinLon, sinLat],
  ];
  return {
    position(positionM, originM) {
      const d = [positionM[0] - originM[0], positionM[1] - originM[1], positionM[2] - originM[2]];
      return r.map((row) => row[0] * d[0] + row[1] * d[1] + row[2] * d[2]);
    },
    covariance(flatM2) {
      const out = Array.from({ length: 3 }, () => [0, 0, 0]);
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          for (let a = 0; a < 3; a++) {
            for (let b = 0; b < 3; b++) out[i][j] += r[i][a] * flatM2[a * 3 + b] * r[j][b];
          }
        }
      }
      return out;
    },
  };
}

function round(v, digits = 3) {
  return Number(v.toFixed(digits));
}

function errorSummary(points, truth) {
  let sum = 0;
  let max = 0;
  for (let i = 0; i < points.length; i++) {
    const err = Math.hypot(
      points[i][0] - truth[i][0],
      points[i][1] - truth[i][1],
      points[i][2] - truth[i][2],
    );
    sum += err * err;
    max = Math.max(max, err);
  }
  return { rmsM: Math.sqrt(sum / points.length), maxM: max };
}

function runTrack(samples) {
  const filter = sidereon.TrackFilter.fromPosition({
    frame: "enu",
    initialTS: samples[0].t,
    initialPositionM: samples[0].raw,
    positionCovarianceM2: samples[0].cov,
    initialVelocityVarianceM2S2: 1.0,
    accelerationVarianceSpectralDensityM2S3: 0.2,
  });
  const history = sidereon.TrackRtsHistoryBuilder.fromFilter(filter);
  const filtered = [samples[0].raw];
  for (const sample of samples.slice(1)) {
    filter.predictRecorded(sample.t - filter.state.tS, history);
    filtered.push(
      filter.updatePositionRecorded({ positionM: sample.raw, covarianceM2: sample.cov }, history).updated.positionM,
    );
  }
  const smoothed = sidereon.smoothTrackRts(history.finish()).epochs.map((epoch) => epoch.state.positionM);
  return { filtered, smoothed };
}

const rinexObs = parsePhoneRinex();
const broadcastNav = sidereon.loadRinexNav(readFileSync(NAV_PATH));
const truthEpochs = sidereon.parseNmea(readFileSync(TRUTH_PATH)).epochs.filter((epoch) => epoch.timeOfDay && epoch.position);
const truthTimes = truthEpochs.map(
  (epoch) =>
    epoch.timeOfDay.hour * 3600 +
    epoch.timeOfDay.minute * 60 +
    epoch.timeOfDay.second +
    epoch.timeOfDay.nanos * 1e-9,
);
const truthEcef = truthEpochs.map((epoch) =>
  geodeticToEcefM(epoch.position.latDeg, epoch.position.lonDeg, epoch.position.heightM),
);

const signalPolicy = new sidereon.SignalPolicy()
  .withSystem(sidereon.GnssSystem.Gps, ["C1C"])
  .withSystem(sidereon.GnssSystem.Galileo, ["C1C"]);

let lastPositionM = geodeticToEcefM(37.42, -122.09, 20.0);
const solved = [];
let skipped = 0;
for (let index = 0; index < rinexObs.epochCount; index++) {
  const epoch = rinexObs.epoch(index);
  const rows = rinexObs.pseudoranges(index, signalPolicy);
  const observations = [];
  for (let i = 0; i < rows.length; i++) {
    if (Number.isFinite(rows.rangesM[i]) && rows.rangesM[i] > 1e6) {
      observations.push({ satelliteId: rows.satellites[i], pseudorangeM: rows.rangesM[i] });
    }
  }
  if (observations.length < 6) {
    skipped++;
    continue;
  }

  const t = epoch.epoch;
  try {
    const solution = broadcastNav.solveBroadcast({
      observations,
      tRxJ2000S: sidereon.civilToJ2000Seconds(t.year, t.month, t.day, t.hour, t.minute, t.second),
      tRxSecondOfDayS: secOfDay(t),
      dayOfYear: dayOfYear(t),
      initialGuess: [lastPositionM[0], lastPositionM[1], lastPositionM[2], 0],
      corrections: { ionosphere: false, troposphere: true },
      withGeodetic: true,
    });
    const residuals = Array.from(solution.residualsM);
    const residualRmsM = Math.sqrt(residuals.reduce((a, b) => a + b * b, 0) / Math.max(1, residuals.length));
    const scale = Math.max(residualRmsM, 1.0);
    const covarianceEcefM2 = Array.from(solution.positionCovarianceEcefM2, (v) => v * scale * scale);
    const raw = Array.from(solution.positionM);
    solved.push({
      t: secOfDay(t),
      raw,
      truth: interpolate(secOfDay(t) - GPS_MINUS_UTC_S, truthTimes, truthEcef),
      covarianceEcefM2,
      used: solution.usedSats.length,
      residualRmsM,
    });
    lastPositionM = raw;
  } catch {
    skipped++;
  }
}

const originEcefM = solved[0].truth;
const originLlh = ecefToGeodeticM(originEcefM);
const enu = enuTransform(originLlh);
const samples = solved.map((row) => {
  const raw = enu.position(row.raw, originEcefM);
  const truth = enu.position(row.truth, originEcefM);
  const cov = enu.covariance(row.covarianceEcefM2);
  return {
    t: row.t - solved[0].t,
    raw,
    truth,
    cov,
    used: row.used,
    residualRmsM: row.residualRmsM,
  };
});

const replay = runTrack(samples);
const summaries = {
  raw: errorSummary(samples.map((s) => s.raw), samples.map((s) => s.truth)),
  filtered: errorSummary(replay.filtered, samples.map((s) => s.truth)),
  smoothed: errorSummary(replay.smoothed, samples.map((s) => s.truth)),
};

const payload = {
  schema: 1,
  meta: {
    dataset: "Google Smartphone Decimeter Challenge",
    drive: "2020-05-14-US-MTV-1",
    phone: "Pixel4",
    truth: "SPAN_Pixel4_10Hz.nmea",
    observationFile: "Pixel4_GnssLog.20o",
    navigationFile: "BRDM00DLR_S_20201350000_01D_MN.rnx",
    license: "CC BY 4.0",
    skippedEpochs: skipped,
    generatedBy: "scripts/build-track-cleanup-data.mjs",
    referenceRun: {
      rawRmsM: round(summaries.raw.rmsM, 4),
      rawMaxM: round(summaries.raw.maxM, 4),
      filteredRmsM: round(summaries.filtered.rmsM, 4),
      filteredMaxM: round(summaries.filtered.maxM, 4),
      smoothedRmsM: round(summaries.smoothed.rmsM, 4),
      smoothedMaxM: round(summaries.smoothed.maxM, 4),
    },
  },
  origin: {
    frame: "local ENU",
    latDeg: round(originLlh[0], 9),
    lonDeg: round(originLlh[1], 9),
    heightM: round(originLlh[2], 3),
  },
  samples: samples.map((sample) => ({
    t: round(sample.t, 3),
    r: sample.raw.map((v) => round(v, 3)),
    q: sample.truth.map((v) => round(v, 3)),
    c: [
      round(sample.cov[0][0], 3),
      round(sample.cov[0][1], 3),
      round(sample.cov[0][2], 3),
      round(sample.cov[1][1], 3),
      round(sample.cov[1][2], 3),
      round(sample.cov[2][2], 3),
    ],
    u: sample.used,
    e: round(sample.residualRmsM, 3),
  })),
};

writeFileSync(OUT_PATH, JSON.stringify(payload));
const bytes = Buffer.byteLength(JSON.stringify(payload));
console.log(
  `wrote ${OUT_PATH} · ${payload.samples.length} samples · ${bytes} bytes · ` +
    `raw ${summaries.raw.rmsM.toFixed(2)} / ${summaries.raw.maxM.toFixed(2)} m · ` +
    `smoothed ${summaries.smoothed.rmsM.toFixed(2)} / ${summaries.smoothed.maxM.toFixed(2)} m`,
);
