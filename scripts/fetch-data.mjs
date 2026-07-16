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

function fetchError(error, url) {
  const reason = error.cause?.code ? `${error.message}: ${error.cause.code}` : error.message;
  return new Error(`${reason} (${url})`);
}

async function getText(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
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

writeFileSync(join(DATA, "data-manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`[fetch-data] refreshed: ${manifest.refreshed.join(", ") || "none"}; kept: ${manifest.kept.join(", ") || "none"}; tleEpoch ${manifest.tleEpoch || "?"}`);
