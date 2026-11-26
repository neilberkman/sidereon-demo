import {
  GnssAttitudeLaw,
  GnssBlock,
  OrbitAttitudeTrajectory,
  TimeScale,
  gnssAttitude,
  loadSp3,
  parseRinexNavRecords,
  tdbFromTtJ2000Seconds,
  timescaleOffsetAtS,
  type AttitudeMode,
  type BroadcastRecordJs,
} from "@neilberkman/sidereon";

export const ATTITUDE_DATE = "2026-06-24";

// GPS PRN-to-block assignments on 2026-06-24 from IGS20_2417 ANTEX.
// https://files.igs.org/pub/station/general/igs20.atx
export const ATTITUDE_SATELLITES: Readonly<Record<string, string>> = {
  G05: "BLOCK IIR-M",
  G06: "BLOCK IIF",
  G07: "BLOCK IIR-M",
  G09: "BLOCK IIF",
  G11: "BLOCK IIIA",
  G12: "BLOCK IIR-M",
  G15: "BLOCK IIR-M",
  G17: "BLOCK IIR-M",
  G19: "BLOCK IIR-B",
  G20: "BLOCK IIIA",
  G21: "BLOCK IIIA",
  G25: "BLOCK IIF",
  G29: "BLOCK IIR-M",
  G30: "BLOCK IIF",
};

const DAY_S = 86400;
const WEEK_S = 7 * DAY_S;
const ATTITUDE_STEP_S = 600;
const GPS_EPOCH_UNIX_S = Date.UTC(1980, 0, 6) / 1000;
const J2000_UNIX_S = Date.UTC(2000, 0, 1, 12) / 1000;
const START_UNIX_S = Date.parse(`${ATTITUDE_DATE}T00:00:00Z`) / 1000;

export interface AttitudePoint {
  elapsedS: number;
  tdbS: number;
  yawDeg: number;
  nominalDeg: number;
  betaDeg: number;
  mode: AttitudeMode;
}

const pad = (value: string | number, width: number) => String(value).padStart(width);

function sp3Date(seconds: number): string {
  const date = new Date(seconds * 1000);
  return `${date.getUTCFullYear()} ${pad(date.getUTCMonth() + 1, 2)} ${pad(date.getUTCDate(), 2)} ` +
    `${pad(date.getUTCHours(), 2)} ${pad(date.getUTCMinutes(), 2)}  0.00000000`;
}

function broadcastTrajectory(record: BroadcastRecordJs, satellite: string): OrbitAttitudeTrajectory {
  // One broadcast fit supplies a continuous orbit, including outside its fit interval.
  // The extra days let the yaw law evaluate neighbouring half orbits at the plot edges.
  const start = START_UNIX_S - DAY_S;
  const gpsStart = start - GPS_EPOCH_UNIX_S;
  const step = 300;
  const count = 3 * DAY_S / step + 1;
  const week = Math.floor(gpsStart / WEEK_S);
  const sow = gpsStart - week * WEEK_S;
  const mjd = start / DAY_S + 40587;
  const lines = [
    `#cP${sp3Date(start)} ${pad(count, 7)} ORBIT WGS84 EXT DEMO`,
    `## ${week} ${pad(sow.toFixed(8), 15)} ${pad(step.toFixed(8), 14)} ${mjd} 0.0000000000000`,
    `+    1   ${satellite}`,
    "%c G  cc GPS",
  ];
  const recordStart = gpsStart - record.week * WEEK_S;
  for (let i = 0; i < count; i++) {
    const state = record.evaluate(recordStart + i * step);
    try {
      const xyz = Array.from(state.positionM, (m) => pad((m / 1000).toFixed(6), 14));
      lines.push(`*  ${sp3Date(start + i * step)}`, `P${satellite}${xyz.join("")} 999999.999999`);
    } finally {
      state.free();
    }
  }
  lines.push("EOF", "");
  const product = loadSp3(new TextEncoder().encode(lines.join("\n")));
  try {
    // With no explicit EOP series, the trajectory uses the TDB orientation provider.
    return OrbitAttitudeTrajectory.fromSp3(product, satellite);
  } finally {
    product.free();
  }
}

export async function sampleAttitudeDay(
  navBytes: Uint8Array,
  satellite: string,
): Promise<AttitudePoint[]> {
  const records = parseRinexNavRecords(navBytes);
  let trajectory: OrbitAttitudeTrajectory;
  try {
    const matches = records.filter((record) => record.satellite === satellite && record.svHealth === 0);
    const record = matches[Math.floor(matches.length / 2)];
    if (!record) throw new Error("No healthy broadcast record for this satellite.");
    trajectory = broadcastTrajectory(record, satellite);
  } finally {
    for (const record of records) record.free();
  }
  let block: GnssBlock | undefined;
  let law: GnssAttitudeLaw | undefined;
  try {
    block = GnssBlock.fromIgsName(ATTITUDE_SATELLITES[satellite]);
    law = GnssAttitudeLaw.forBlock(block, Number(satellite.slice(1)));
    const ttOffset = timescaleOffsetAtS(TimeScale.Utc, TimeScale.Tt, START_UNIX_S / DAY_S + 2440587.5);
    const ttStart = START_UNIX_S - J2000_UNIX_S + ttOffset;
    const degrees = 180 / Math.PI;
    const points: AttitudePoint[] = [];
    for (let elapsedS = 0; elapsedS <= DAY_S; elapsedS += ATTITUDE_STEP_S) {
      const tdbS = tdbFromTtJ2000Seconds(ttStart + elapsedS);
      const attitude = gnssAttitude(law, trajectory, tdbS);
      try {
        points.push({
          elapsedS,
          tdbS,
          yawDeg: attitude.yawRad * degrees,
          nominalDeg: attitude.nominalYawRad * degrees,
          betaDeg: attitude.betaRad * degrees,
          mode: attitude.mode,
        });
      } finally {
        attitude.free();
      }
      if (points.length % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return points;
  } finally {
    law?.free();
    block?.free();
    trajectory.free();
  }
}
