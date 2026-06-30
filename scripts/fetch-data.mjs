// Build-time data refresh. Pulls fresh GNSS TLEs (and a current global IONEX)
// from the providers so every build/redeploy bundles current data; runtime stays
// zero-network. One provider fetch per build, shared by all visitors. If a fetch
// fails, the previously committed file is kept (the build never breaks on a
// transient provider outage), and the manifest records what was refreshed.
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const UA = "sidereon-demo build-time data refresh (one fetch per build)";

async function getText(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}
async function getGz(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return gunzipSync(Buffer.from(await r.arrayBuffer())).toString("utf8");
}

const manifest = { fetchedAt: new Date().toISOString(), refreshed: [], kept: [] };

// --- TLEs (CelesTrak) -----------------------------------------------------
const TLE = { "gps-ops": "gps-ops", galileo: "galileo", "glo-ops": "glo-ops", beidou: "beidou" };
for (const [file, group] of Object.entries(TLE)) {
  try {
    const txt = await getText(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`);
    if (txt.split("\n").filter((l) => l.startsWith("1 ")).length < 3) throw new Error("too few records");
    writeFileSync(join(DATA, `${file}.tle`), txt);
    manifest.refreshed.push(`${file}.tle`);
  } catch (e) {
    console.warn(`[fetch-data] kept existing ${file}.tle (${e.message})`);
    manifest.kept.push(`${file}.tle`);
  }
}

// TLE epoch from the first GPS record (YYDDD.dddddddd in cols 18-32).
try {
  const l1 = readFileSync(join(DATA, "gps-ops.tle"), "utf8").split("\n").find((l) => l.startsWith("1 "));
  const ep = l1.slice(18, 32).trim();
  const yy = parseInt(ep.slice(0, 2), 10);
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  const doy = parseFloat(ep.slice(2));
  const d = new Date(Date.UTC(year, 0, 1) + (doy - 1) * 86400000);
  manifest.tleEpoch = d.toISOString();
} catch (e) {
  console.warn(`[fetch-data] could not parse TLE epoch (${e.message})`);
}

// --- Global IONEX (AIUB/CODE), best-effort newest-first walk --------------
function ymd(off) {
  const d = new Date(Date.now() + off * 86400000);
  const y = d.getUTCFullYear();
  const doy = Math.floor((Date.UTC(y, d.getUTCMonth(), d.getUTCDate()) - Date.UTC(y, 0, 1)) / 86400000) + 1;
  return { y, doy: String(doy).padStart(3, "0") };
}
let ionexOk = false;
const cands = [];
for (const off of [1, 0, -1, -2, -3]) { const { y, doy } = ymd(off); cands.push(["COD0OPSPRD", y, doy]); }
for (const off of [-1, -2, -3, -4]) { const { y, doy } = ymd(off); cands.push(["COD0OPSRAP", y, doy]); }
for (const [prod, y, doy] of cands) {
  try {
    const txt = await getGz(`http://ftp.aiub.unibe.ch/CODE/${y}/${prod}_${y}${doy}0000_01D_01H_GIM.INX.gz`);
    if (!txt.includes("LAT/LON1/LON2")) throw new Error("not an IONEX grid");
    writeFileSync(join(DATA, "global.ionex"), txt);
    manifest.ionex = `${prod}_${y}${doy}`;
    manifest.refreshed.push("global.ionex");
    ionexOk = true;
    break;
  } catch { /* try next candidate */ }
}
if (!ionexOk) { console.warn("[fetch-data] kept existing global.ionex (no live GIM reachable)"); manifest.kept.push("global.ionex"); }

writeFileSync(join(DATA, "data-manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`[fetch-data] refreshed: ${manifest.refreshed.join(", ") || "none"}; kept: ${manifest.kept.join(", ") || "none"}; tleEpoch ${manifest.tleEpoch || "?"}`);
