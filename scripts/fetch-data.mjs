// Manual data refresh (`npm run fetch-data`). Pulls GNSS TLEs and a current
// global IONEX into public/data for local work. It is deliberately not part of
// the build: the scheduled refresh-tle workflow owns freshness for the site, and
// a fetch per build meant a provider fetch per deploy and per local build.
//
// CelesTrak etiquette (their GP FAQ): they refresh GP data every 2 hours, so a
// file fetched less than 2 hours ago is used as is; a 403/404 is reported and
// stops further CelesTrak queries instead of being retried.
import { writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const UA = "sidereon.dev manual data refresh (2-hour guard; https://github.com/neilberkman/sidereon-demo)";
const MIN_AGE_MS = 2 * 3600 * 1000;
const CELESTRAK = process.env.CELESTRAK_BASE ?? "https://celestrak.org"; // overridable for tests

function fetchError(error, url) {
  const reason = error.cause?.code ? `${error.message}: ${error.cause.code}` : error.message;
  return new Error(`${reason} (${url})`);
}

async function getText(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    if (!r.ok) {
      const body = (await r.text()).replace(/\s+/g, " ").slice(0, 300);
      throw new Error(`${r.status} ${r.statusText}${body ? `: ${body}` : ""}`);
    }
    return r.text();
  } catch (e) {
    throw fetchError(e, url);
  }
}
async function getGz(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return gunzipSync(Buffer.from(await r.arrayBuffer())).toString("utf8");
  } catch (e) {
    throw fetchError(e, url);
  }
}

const manifestPath = join(DATA, "data-manifest.json");
let previous = {};
try {
  previous = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch { /* first run */ }
const manifest = { fetchedAt: new Date().toISOString(), refreshed: [], kept: [], fetched: { ...(previous.fetched ?? {}) } };

// A file counts as current if it was fetched (per the manifest) or written
// (per its mtime) less than 2 hours ago.
function fetchedRecently(name) {
  const stamp = manifest.fetched[name] ? Date.parse(manifest.fetched[name]) : 0;
  const path = join(DATA, name);
  const mtime = existsSync(path) ? statSync(path).mtimeMs : 0;
  return Date.now() - Math.max(stamp || 0, mtime) < MIN_AGE_MS;
}

// --- TLEs (CelesTrak) -----------------------------------------------------
const TLE = { "gps-ops": "gps-ops", galileo: "galileo", "glo-ops": "glo-ops", beidou: "beidou" };
let celestrakStopped = false;
for (const [file, group] of Object.entries(TLE)) {
  const name = `${file}.tle`;
  if (fetchedRecently(name)) {
    console.log(`[fetch-data] ${name} is less than 2 hours old; using it as is (CelesTrak updates every 2 hours)`);
    manifest.kept.push(name);
    continue;
  }
  if (celestrakStopped) {
    console.warn(`[fetch-data] kept existing ${name} (not querying CelesTrak again after a 403/404)`);
    manifest.kept.push(name);
    continue;
  }
  try {
    const txt = await getText(`${CELESTRAK}/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`);
    if (txt.split("\n").filter((l) => l.startsWith("1 ")).length < 3) throw new Error("too few records");
    writeFileSync(join(DATA, name), txt);
    manifest.fetched[name] = new Date().toISOString();
    manifest.refreshed.push(name);
  } catch (e) {
    console.warn(`[fetch-data] kept existing ${name} (${e.message})`);
    manifest.kept.push(name);
    if (/^(403|404) /.test(e.message)) {
      console.error("[fetch-data] CelesTrak answered 403/404: repeating will not change it and risks a longer block; stopping CelesTrak queries for this run");
      celestrakStopped = true;
    }
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

// --- Global IONEX (AIUB/CODE), newest listed CODE GIM --------------------
let ionexOk = false;
const years = [new Date().getUTCFullYear(), new Date().getUTCFullYear() - 1];
for (const y of years) {
  if (ionexOk) break;

  try {
    const index = await getText(`https://ftp.aiub.unibe.ch/CODE/${y}/`);
    const names = Array.from(index.matchAll(/href="(COD0OPS[A-Z]+_\d{11}_01D_01H_GIM\.INX\.gz)"/g), (m) => m[1])
      .sort()
      .reverse();

    for (const name of names) {
      try {
        const txt = await getGz(`https://ftp.aiub.unibe.ch/CODE/${y}/${name}`);
        if (!txt.includes("LAT/LON1/LON2")) throw new Error("not an IONEX grid");
        writeFileSync(join(DATA, "global.ionex"), txt);
        manifest.ionex = name.replace(/\.INX\.gz$/, "");
        manifest.refreshed.push("global.ionex");
        ionexOk = true;
        break;
      } catch { /* try next listed product */ }
    }
  } catch { /* try previous year */ }
}
if (!ionexOk) { console.warn("[fetch-data] kept existing global.ionex (no live GIM reachable)"); manifest.kept.push("global.ionex"); }

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`[fetch-data] refreshed: ${manifest.refreshed.join(", ") || "none"}; kept: ${manifest.kept.join(", ") || "none"}; tleEpoch ${manifest.tleEpoch || "?"}`);
