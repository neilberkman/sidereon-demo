// SIDEREON marketing site. The page is about the engine and its polyglot reach:
// one reference-validated Rust GNSS + astrodynamics core, reachable from Rust,
// Python, C, Elixir, and WebAssembly. The live globe is the featured spectacle
// that pulls a visitor in; the in-browser solver is one showcase section proving
// the WASM interface runs the whole engine client-side. Every number in the live
// section comes from the WASM engine running in the tab.

import "./style.css";
import * as Comlink from "comlink";
import {
  initEngine,
  parseTleFile,
  okFetch,
  nowMicros,
  primeGroundTrack,
  loadSppData,
  solveSpp,
  loadTecField,
  slantDelayM,
  subSolarLL,
  recoverOrbit,
  type Sat,
  type SppData,
  type DualSolve,
  type SppResult,
  type TecField,
  type VisibleSat,
  type OrbitRecovery,
  type OrbitElements,
} from "./engine";
import type {
  ObserveWorkerApi,
  ObserveResult,
  ObserveTrack,
  ObservePass,
  TleSource,
  CoverageResult,
  ConjunctionHit,
} from "./worker";
import { Globe } from "./globe";
import { Skyplot, type SkyPoint, type SkyArc } from "./skyplot";
import { CONSTELLATION, turbo, turboCss, type Constellation } from "./colors";
import {
  LANGUAGES,
  CAPABILITIES,
  highlight,
  splitFold,
  stripFold,
  type LangId,
  type CapId,
} from "./snippets";

const $ = (id: string) => document.getElementById(id)!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- network-call accounting -----------------------------------------------
// Wrap fetch so we can assert, on screen, that nothing talks to a server once
// the page has loaded: every solve afterwards must keep this at zero.
let netTotal = 0;
let netBaseline = 0;
let bootDone = false;
const realFetch = window.fetch.bind(window);
window.fetch = ((...args: Parameters<typeof fetch>) => {
  netTotal++;
  if (bootDone) updateNetPill();
  return realFetch(...args);
}) as typeof fetch;
const netCallsSinceLoad = () => netTotal - netBaseline;

// The SGP4 burst that fires on every observer click runs in a Web Worker so it
// never blocks paint. Vite bundles the worker (and its own copy of the wasm
// engine) from this URL form. The worker is wrapped with Comlink so the heavy
// ops read as plain awaited calls (`await observeApi.observe(...)`), each
// returning transferable plain arrays — no wasm objects cross the thread.
const observeWorker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
const observeApi = Comlink.wrap<ObserveWorkerApi>(observeWorker);

let sats: Sat[] = [];
const tleSources: TleSource[] = [];
let globe: Globe;
let sppData: SppData | null = null;
let tecField: TecField | null = null;
let observer: { lat: number; lon: number } | null = null;
let visible: VisibleSat[] = [];
let lastDual: DualSolve | null = null;
// Day-night terminator overlay state. When on, the render-loop tick refreshes the
// sub-solar point so the gold marker + terminator ring track the live UTC clock.
let terminatorOn = false;

// Elevation mask (degrees). Drives BOTH the skyplot (mask ring + "ABOVE MASK"
// count) and the SPP solve (drops below-mask satellites from the active fix).
// DEFAULT_MASK seeds the first render before the slider is read; the live value
// is the reactive `maskDeg`, set from the SOLVE-panel slider.
const DEFAULT_MASK = 10;
let maskDeg = DEFAULT_MASK;

// SOLVE-panel interactive state: which atmosphere corrections are engaged in the
// real WASM solve. Defaults to BOTH so the panel opens on the corrected fix.
type CorrKey = "none" | "iono" | "tropo" | "both";
let solveCorrKey: CorrKey = "both";
function corrFor(k: CorrKey): { ionosphere: boolean; troposphere: boolean } {
  return {
    ionosphere: k === "iono" || k === "both",
    troposphere: k === "tropo" || k === "both",
  };
}
// Label derived from the correction set actually present in the rendered solve,
// not the live toggle — so a stale or failed re-solve can never mislabel the data.
function corrLabelFor(c: { ionosphere: boolean; troposphere: boolean }): string {
  if (c.ionosphere && c.troposphere) return "+IONO+TROPO";
  if (c.ionosphere) return "+IONO";
  if (c.troposphere) return "+TROPO";
  return "RAW";
}
// The active column's full label: correction set plus the elevation mask actually
// applied to the rendered fix (not the live slider), so a stale re-solve can never
// mislabel the data. Mask is shown only when it pruned the sky (> 0).
function activeLabelFor(r: SppResult): string {
  const corr = corrLabelFor(r.corrections);
  return r.elevationMaskDeg > 0 ? `${corr} · MASK ${r.elevationMaskDeg}°` : corr;
}

// The featured skyplot (live panel) and an optional fullscreen twin. Both are
// fed the same real az/el points + computed pass arcs.
let skyPanel: Skyplot | null = null;
let ovSky: Skyplot | null = null;
let skyArcs: SkyArc[] = [];

function setCrumb(_s: string): void {
  /* status routing is silent on the marketing surface; kept for call sites */
}

// ---- error surfacing -------------------------------------------------------
function showError(context: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  const toast = $("err-toast");
  toast.hidden = false;
  toast.textContent = `⚠ ${context}: ${msg}`;
  console.error(`[sidereon] ${context}`, err);
}

// ---- boot ------------------------------------------------------------------
async function boot() {
  // Single-sourced from the actual installed @neilberkman/sidereon version.
  $("ver-badge").textContent = `v${__SIDEREON_VERSION__}`;
  const log = $("boot-log");
  const line = (html: string) => {
    log.innerHTML += html + "\n";
  };
  line('<span class="ok">›</span> initializing webassembly runtime');
  await sleep(110);

  const t0 = performance.now();
  await initEngine();
  const initMs = (performance.now() - t0).toFixed(1);
  $("wasm-badge").textContent = "WASM · HOT";
  $("wasm-badge").classList.add("hot");
  line(`  engine online · sidereon core · <span class="em">${initMs} ms</span>`);
  await sleep(80);

  line('<span class="ok">›</span> fetching real element sets · celestrak');
  const files: [string, Constellation][] = [
    ["gps-ops", "GPS"],
    ["galileo", "GAL"],
    ["glo-ops", "GLO"],
    ["beidou", "BDS"],
  ];
  for (const [f, c] of files) {
    const txt = await (await okFetch(`/data/${f}.tle`)).text();
    tleSources.push({ text: txt, constellation: c });
    const parsed = parseTleFile(txt, c);
    sats = sats.concat(parsed);
    line(`  ${c.padEnd(3)} · <span class="em">${parsed.length}</span> satellites · SGP4 initialized`);
    await sleep(55);
  }
  line(`  total tracked · <span class="ok">${sats.length}</span> objects`);
  // Hand the same raw element-set text to the worker so it parses its own Sat
  // array (wasm Tle handles can't be shared) and warms its wasm engine. Done once.
  const workerSats = await observeApi.init(tleSources);
  line(`  worker engine online · <span class="em">${workerSats}</span> satellites off-thread`);
  await sleep(70);

  line('<span class="ok">›</span> propagating constellation @ current UTC');
  globe = new Globe($("globe-host"));
  const land = await (await okFetch("/data/land110.json")).json();
  globe.addCoastlines(land);
  // Countries + states for offline reverse-geocode of clicked observers (non-blocking).
  okFetch("/data/countries110.json").then((r) => r.json()).then((c) => (countries = c)).catch(() => {});
  okFetch("/data/states50.json").then((r) => r.json()).then((s) => (states = s)).catch(() => {});
  const now = new Date();
  globe.setTime(now);
  globe.setSats(sats, nowMicros(now));
  // Seed the first constellation frame (dots + trails) from the worker so the
  // globe is populated before the loop starts — no SGP4 runs on the main thread.
  await animateConstellation(now, true);
  $("sat-count").textContent = String(sats.length);
  $("hero-foot-sats").textContent = `${sats.length} satellites tracked live`;
  skyPanel = new Skyplot($("skyplot") as HTMLCanvasElement, maskDeg);
  updateSkyLoopState();
  buildLegend();
  buildLabControls(); // populate the conjunction + IOD satellite pickers
  // Data freshness: TLEs are bundled at build time (npm prebuild -> fetch-data.mjs),
  // so show their epoch + age rather than implying a perpetually-live feed.
  try {
    const m = await (await okFetch("/data/data-manifest.json")).json();
    if (m.tleEpoch) {
      const ageDays = Math.max(0, Math.floor((Date.now() - Date.parse(m.tleEpoch)) / 86400000));
      $("legend-foot").textContent = `TLE · CELESTRAK · EPOCH ${m.tleEpoch.slice(0, 10)} · ${ageDays}d OLD`;
    }
  } catch {
    /* manifest is optional; keep the default footer */
  }
  await sleep(90);

  line('<span class="ok">›</span> staging IGS station ABMF RINEX obs + broadcast nav · hashing inputs');
  sppData = await loadSppData();
  line(
    `  OBS · <span class="em">${sppData.provenance.obsBytes.toLocaleString()}</span> B · sha256 <span class="em">${sppData.provenance.obsSha256.slice(0, 12)}</span>` +
      ` · NAV · <span class="em">${sppData.provenance.navBytes.toLocaleString()}</span> B · sha256 <span class="em">${sppData.provenance.navSha256.slice(0, 12)}</span>`,
  );
  line(`  ${sppData.provenance.obsCount} pseudoranges armed · ${sppData.provenance.constellations}`);
  await sleep(90);

  // Preload the IONEX product NOW, before the baseline is frozen, so the later
  // TEC toggle is a pure in-browser render with zero network calls.
  try {
    tecField = await loadTecField();
    drawTecMap(tecField, $("tec-map") as HTMLCanvasElement, $("tec-scale"));
    line(`  IONEX · global VTEC ${tecField.min.toFixed(1)}–${tecField.max.toFixed(1)} TECU · ready`);
  } catch (e) {
    showError("IONEX preload failed", e);
  }
  await sleep(70);
  line('<span class="ok">›</span> instrument ready · the engine is live in this tab');

  // From here on, no network traffic should occur. Snapshot the baseline so the
  // live section can show "network calls after load: 0".
  netBaseline = netTotal;
  bootDone = true;

  startLoop();
  runSolve(); // auto-run the first fix (also fills the hero readout)
  startHeroSolveLoop(); // keep the hero readout ticking
  setObserver(37.7749, -122.4194); // a default observer so the skyplot is alive

  // The hero is at the top on load: pull the globe into the right stage now, so
  // the split reads correctly before the user touches anything.
  setHeroGlobe(true);

  await sleep(380);
  $("boot").classList.add("done");
}

function buildLegend() {
  const body = $("legend-body");
  const counts: Record<string, number> = {};
  for (const s of sats) counts[s.constellation] = (counts[s.constellation] || 0) + 1;
  body.innerHTML = (Object.keys(CONSTELLATION) as Constellation[])
    .map(
      (c) => `<div class="legend-row">
        <span class="sw" style="background:${CONSTELLATION[c].css};box-shadow:0 0 8px ${CONSTELLATION[c].css}"></span>
        <span class="nm">${CONSTELLATION[c].full}</span>
        <span class="ct">${counts[c] || 0}</span></div>`,
    )
    .join("");
}

// ---- render loop + HUD clock ----------------------------------------------
let lastProp = 0;
let liveTickCount = 0;
let globeFramingDirty = true;
let skyPanelVisible = false;

function markGlobeFramingDirty(): void {
  globeFramingDirty = true;
}

function updateSkyLoopState(): void {
  const hidden = document.hidden;
  if (!hidden && !overlayPanel && skyPanelVisible) skyPanel?.start();
  else skyPanel?.stop();

  if (!hidden && overlayPanel === "sky") ovSky?.start();
  else ovSky?.stop();
}

// Continuous constellation animation, off the main thread. The worker propagates
// every satellite (dots) and, every 8th tick (~2 s), rebuilds the comet trails;
// the main thread only uploads the returned typed arrays to the GPU — zero SGP4
// here, so idle/scroll no longer hitch. An in-flight guard drops overlapping
// ticks (mirrors refreshObserverLive); `force` seeds the first frame, bypassing
// the guard and forcing a trail rebuild.
let animBusy = false;
let animTrailTick = 0;
async function animateConstellation(now: Date, force = false): Promise<void> {
  if (animBusy && !force) return;
  animBusy = true;
  try {
    const includeTrails = force || animTrailTick % 8 === 0;
    const data = await observeApi.animation(nowMicros(now), includeTrails);
    globe.setSatPositions(data.satPos);
    if (data.trails) globe.setTrailsFromBuffers(data.trails);
    animTrailTick++;
  } catch (e) {
    showError("constellation animation failed", e);
  } finally {
    animBusy = false;
  }
}

function startLoop() {
  let raf = 0;
  let globeOnscreen = true;
  const loop = () => {
    raf = 0;
    if (document.hidden || !globeOnscreen) return;
    const t = performance.now();
    const glLost = globe.isContextLost();
    if (!glLost) {
      if (globeFramingDirty) {
        globeFramingDirty = false;
        applyGlobeFraming();
      }
      globe.render();
    }
    if (t - lastProp >= 250) {
      const now = new Date();
      updateClock(now);
      if (!glLost) {
        globe.setTime(now);
        if (terminatorOn) updateTerminator(now);
        void animateConstellation(now); // off-thread dots + trails
        refreshObserverLive();
      }
      lastProp = t;
    }
    raf = requestAnimationFrame(loop);
  };
  const start = () => {
    if (!raf && !document.hidden && globeOnscreen) raf = requestAnimationFrame(loop);
  };
  const stop = () => {
    if (!raf) return;
    cancelAnimationFrame(raf);
    raf = 0;
  };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stop();
      updateSkyLoopState();
      return;
    }
    lastProp = 0;
    markGlobeFramingDirty();
    updateSkyLoopState();
    start();
  });
  const globeIo = new IntersectionObserver(
    (entries) => {
      globeOnscreen = entries.some((e) => e.isIntersecting);
      if (globeOnscreen) {
        markGlobeFramingDirty();
        start();
      } else {
        stop();
      }
    },
    { threshold: 0.01 },
  );
  globeIo.observe($("globe-host"));
  start();
}

function updateClock(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  $("utc-clock").textContent = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

// ---- observer + skyplot + passes ------------------------------------------
// Paint the visible-satellite set: skyplot points + the obs-stats counts. Shared
// by the click burst (applyObserve) and the recurring live tick.
function renderVisible(vis: VisibleSat[]) {
  visible = vis;
  const aboveMask = vis.filter((v) => v.el >= maskDeg);

  const top = aboveMask[0]?.prn;
  const pts: SkyPoint[] = vis.map((v) => ({
    prn: v.prn,
    az: v.az,
    el: v.el,
    constellation: v.constellation,
    highlight: v.prn === top,
  }));
  skyPanel?.setPoints(pts);
  ovSky?.setPoints(pts);

  const byC: Record<string, number> = {};
  for (const v of aboveMask) byC[v.constellation] = (byC[v.constellation] || 0) + 1;
  $("obs-stats").innerHTML = [
    ["ABOVE HORIZON", `${vis.length}`],
    ["ABOVE MASK", `${aboveMask.length} (≥${maskDeg}°)`],
    ["GPS / GAL", `${byC.GPS || 0} / ${byC.GAL || 0}`],
    ["GLO / BDS", `${byC.GLO || 0} / ${byC.BDS || 0}`],
  ]
    .map(([k, v]) => `<span class="k">${k}</span><span class="v">${v}</span>`)
    .join("");
}

// Draw the worker's precomputed ground tracks on the globe WITHOUT re-propagating
// on the main thread: prime each track's ECEF array against its Sat's wasm Tle
// handle, then let globe.setGroundTracks build the lines (groundTrackEcefUnits
// returns the primed array, so no SGP4/frame work runs here).
// `fadeIn` is true only on the observer CLICK path (crossfade the new set in over
// the still-visible old set); the periodic live refresh leaves it false so tracks
// swap at full opacity with no fade — no steady-state blink.
function applyGroundTracks(tracks: ObserveTrack[], fadeIn = false) {
  const byPrn = new Map(sats.map((s) => [s.prn, s]));
  const subset: Sat[] = [];
  for (const t of tracks) {
    const s = byPrn.get(t.prn);
    if (!s) continue;
    primeGroundTrack(s.tle, t.ecef);
    subset.push(s);
  }
  globe.setGroundTracks(subset, new Date(), fadeIn); // center unused: every track is primed
}

// Apply the full worker result of a click: visible points, sky-pass arcs, globe
// ground tracks, and the upcoming-passes list.
function applyObserve(data: ObserveResult) {
  renderVisible(data.visible);

  skyArcs = data.arcs.map((a) => ({
    prn: a.prn,
    constellation: a.constellation,
    pts: a.az.map((az, i) => ({ az, el: a.el[i] })),
    nowIdx: a.nowIdx,
  }));
  skyPanel?.setArcs(skyArcs);
  ovSky?.setArcs(skyArcs);

  applyGroundTracks(data.groundTracks, true); // crossfade in — never contract the globe
  // The click already drew ground tracks; nudge the live-tick counter off 0 so the
  // next tick doesn't immediately rebuild them (they refresh again on the 8th tick).
  liveTickCount = 1;

  refreshSlant();
  if (overlayPanel === "sky") renderSkyOverlayTable();
}

// The 6 h pass list, delivered separately (a beat after the fast results) so the
// slow scan never delays tracks/skyplot. Fills the passes panel when it arrives.
function applyPasses(passes: ObservePass[]) {
  if (!passes.length) {
    $("pass-list").innerHTML = '<div class="muted">no rising passes in next 6h (continuous view)</div>';
    return;
  }
  $("pass-list").innerHTML = passes
    .map((p) => {
      const t = new Date(p.aosISO);
      const hh = String(t.getUTCHours()).padStart(2, "0");
      const mm = String(t.getUTCMinutes()).padStart(2, "0");
      return `<div class="pass-row"><span class="prn" style="color:${CONSTELLATION[p.constellation].css}">${p.prn}</span><span class="t">AOS ${hh}:${mm}Z</span><span class="el">${p.maxEl.toFixed(0)}°</span></div>`;
    })
    .join("");
}

// Recurring live tick (driven by the render loop). Refresh the visible set every
// call and the globe ground tracks every 8th tick, all off-thread. An in-flight
// guard drops overlapping ticks so a slow burst never queues up behind itself.
let liveBusy = false;
function refreshObserverLive() {
  if (!observer || liveBusy) return;
  const { lat, lon } = observer;
  liveBusy = true;
  const includeTracks = liveTickCount % 8 === 0;
  observeApi
    .live(lat, lon, nowMicros(new Date()), includeTracks)
    .then((data) => {
      if (!observer || observer.lat !== lat || observer.lon !== lon) return;
      renderVisible(data.visible);
      if (data.groundTracks) applyGroundTracks(data.groundTracks);
      liveTickCount++;
      refreshSlant();
      if (overlayPanel === "sky") renderSkyOverlayTable();
    })
    .catch((e) => showError("observer refresh failed", e))
    .finally(() => {
      liveBusy = false;
    });
}

// ---- offline reverse geocode: which country contains the clicked point --------
// Point-in-polygon against bundled Natural Earth 110m countries (name + geometry,
// ~170 KB). Fully client-side: no key, no runtime network, no per-request cost.
// Returns the country name, or "open ocean" when the click misses all land.
// deno-lint-ignore no-explicit-any
let countries: any = null;
// deno-lint-ignore no-explicit-any
let states: any = null;
function pointInRing(ring: number[][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function ringsContain(rings: number[][][], x: number, y: number): boolean {
  if (!rings.length || !pointInRing(rings[0], x, y)) return false;
  for (let i = 1; i < rings.length; i++) if (pointInRing(rings[i], x, y)) return false; // hole
  return true;
}
// deno-lint-ignore no-explicit-any
function featureAt(fc: any, x: number, y: number): any {
  if (!fc) return null;
  for (const f of fc.features) {
    const g = f.geometry;
    if (g.type === "Polygon" && ringsContain(g.coordinates, x, y)) return f;
    if (g.type === "MultiPolygon" && g.coordinates.some((p: number[][][]) => ringsContain(p, x, y))) return f;
  }
  return null;
}
function geocode(lat: number, lon: number): string {
  // State/province first (covers US states + major countries), then country, then ocean.
  const st = featureAt(states, lon, lat);
  if (st) return `${st.properties.name}, ${st.properties.admin}`;
  const co = featureAt(countries, lon, lat);
  if (co) return co.properties.name;
  return countries || states ? "open ocean" : "";
}

// Dedup token: only the newest observer click's worker result is applied, so a
// rapid series of clicks never paints a stale (superseded) burst.
let observeSeq = 0;

function setObserver(lat: number, lon: number, recenter = false) {
  observer = { lat, lon };

  // Cheap, synchronous UI updates land immediately — no SGP4 here, so the click
  // never blocks paint: the observer marker, the coords, and the (fast, offline)
  // reverse geocode.
  globe.setObserver(lat, lon);
  // On a real click, smoothly bring the picked point to face the viewer (the
  // default load observer passes recenter=false, so the hero keeps idle-spinning).
  if (recenter) globe.faceObserver(lat, lon);
  // Leave the previous observer's tracks fully visible until the worker's new set
  // is ready (setGroundTracks crossfades them in) — the globe never contracts to
  // empty during the async compute. The observer ring pulses meanwhile.
  globe.setObserverPending(true);
  const hemiLat = lat >= 0 ? "N" : "S";
  const hemiLon = lon >= 0 ? "E" : "W";
  const place = geocode(lat, lon);
  const coords = `${Math.abs(lat).toFixed(3)}° ${hemiLat} &nbsp; ${Math.abs(lon).toFixed(3)}° ${hemiLon}${place ? ` <span class="obs-place">· ${place}</span>` : ""}`;
  $("obs-coords").innerHTML = coords;
  // mirror onto the paired globe stage so clicking the globe shows where, right
  // beside the skyplot it drives.
  const liveCoords = document.getElementById("live-obs-coords");
  if (liveCoords) liveCoords.innerHTML = coords;
  markGlobeFramingDirty();

  liveTickCount = 0;
  $("pass-list").innerHTML = '<div class="muted">scanning passes…</div>';

  // The heavy work — visible satellites, sky-pass arcs, globe ground tracks, and
  // the 6 h pass scan — runs in the worker. The page stays responsive while it
  // computes; the arrays are rendered when they arrive.
  const seq = ++observeSeq;
  const micros = nowMicros(new Date());
  observeApi
    .observe(lat, lon, micros)
    .then((data) => {
      if (seq !== observeSeq) return; // a newer click superseded this one
      if (!observer || observer.lat !== lat || observer.lon !== lon) return;
      applyObserve(data);
      globe.setObserverPending(false); // fast result in — stop the pulse
    })
    .catch((e) => {
      globe.setObserverPending(false);
      showError("observer update failed", e);
    });
  // The slow 6 h pass scan trails as its own worker call so it never delays the
  // fast results above; it fills the passes panel a beat later.
  observeApi
    .passes(lat, lon, micros)
    .then((passes) => {
      if (seq !== observeSeq) return;
      if (!observer || observer.lat !== lat || observer.lon !== lon) return;
      applyPasses(passes);
    })
    .catch((e) => showError("pass scan failed", e));
}

// ---- SPP solve -------------------------------------------------------------
// Re-run the real WASM solve with the panel's current correction set and
// elevation mask, against a fixed RAW baseline (no corrections, full sky), so
// every control change shows both the new fix and how it shifts from raw.
function runSolve() {
  if (!sppData) return;
  const btn = $("solve-btn") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "CONVERGING…";
  requestAnimationFrame(() => {
    try {
      const baseline = solveSpp(sppData!, { ionosphere: false, troposphere: false }, 0);
      const active = solveSpp(sppData!, corrFor(solveCorrKey), maskDeg);
      const dx = active.positionM[0] - baseline.positionM[0];
      const dy = active.positionM[1] - baseline.positionM[1];
      const dz = active.positionM[2] - baseline.positionM[2];
      const dual: DualSolve = {
        raw: baseline,
        corrected: active,
        deltaM: Math.hypot(dx, dy, dz),
        deltaHeightM: active.geodetic.heightM - baseline.geodetic.heightM,
      };
      lastDual = dual;
      renderSolve(dual);
      // Refresh only the overlay's results (not its relocated controls), so a
      // re-solve triggered by dragging the overlay's mask slider never rebuilds
      // and interrupts that very slider.
      if (overlayPanel === "solve") refreshSolveOverlay();
    } catch (e) {
      showError("SPP solve failed", e);
      $("solve-headline").innerHTML = '<span class="err">solve failed: see console</span>';
    } finally {
      btn.disabled = false;
      btn.textContent = "RUN SOLVE AGAIN";
    }
  });
}

function fmtLen(m: number): string {
  const a = Math.abs(m);
  if (a < 1e-6) return `${(m * 1e9).toFixed(2)} nm`;
  if (a < 1e-3) return `${(m * 1e6).toFixed(2)} µm`;
  if (a < 1) return `${(m * 1e3).toFixed(3)} mm`;
  return `${m.toFixed(3)} m`;
}

function renderSolve(dual: DualSolve) {
  const r = dual.raw; // RAW baseline: broadcast geometry + clock only
  const c = dual.corrected; // ACTIVE: panel correction set
  const p = sppData!.provenance;
  const g = c.geodetic; // the active fix is what the controls produced
  const cfg = activeLabelFor(c);

  $("solve-headline").innerHTML =
    `<span class="big">${c.usedSats.length} SATELLITES <span class="arrow">→</span> ${fmtLen(c.distanceToTruthM)} FROM TRUTH</span>` +
    `<span class="sub">${cfg} · SOLVE ${c.computeMs.toFixed(1)} ms · SERVER COMPUTE 0 · NETWORK CALLS AFTER LOAD ${netCallsSinceLoad()}</span>`;

  const hemiLat = g.latDeg >= 0 ? "N" : "S";
  const hemiLon = g.lonDeg >= 0 ? "E" : "W";
  $("solve-llh").innerHTML = [
    ["LAT", `${Math.abs(g.latDeg).toFixed(6)}° ${hemiLat}`],
    ["LON", `${Math.abs(g.lonDeg).toFixed(6)}° ${hemiLon}`],
    ["HEIGHT", `${g.heightM.toFixed(2)} m`],
  ]
    .map(([k, v]) => `<div class="llh-cell"><span class="k">${k}</span><span class="v">${v}</span></div>`)
    .join("");

  const used = $("solve-used");
  if (used) used.textContent = `satellites used: ${c.usedSats.length} of ${p.obsCount} observed`;

  const compRows: [string, string, string][] = [
    ["VS SURVEYED TRUTH", fmtLen(r.distanceToTruthM), fmtLen(c.distanceToTruthM)],
    ["SATS USED", `${r.usedSats.length}`, `${c.usedSats.length}`],
    ["HEIGHT", `${r.geodetic.heightM.toFixed(2)} m`, `${c.geodetic.heightM.toFixed(2)} m`],
    ["RESID RMS", fmtLen(r.residualRmsM), fmtLen(c.residualRmsM)],
    ["COMPUTE", `${r.computeMs.toFixed(2)} ms`, `${c.computeMs.toFixed(2)} ms`],
  ];
  $("solve-compare").innerHTML =
    `<div class="cmp-row cmp-head"><span class="k"></span><span class="v">RAW</span><span class="v amber">${cfg}</span></div>` +
    compRows
      .map(
        ([k, a, b]) =>
          `<div class="cmp-row"><span class="k">${k}</span><span class="v">${a}</span><span class="v">${b}</span></div>`,
      )
      .join("");

  $("compare-note").innerHTML = solveNote(dual);

  updateHeroReadout(dual.corrected);
  updateNetPill();
}

// Plain-language read of what the active config did relative to the RAW
// baseline: the broadcast atmosphere corrections move the real fix closer to
// ABMF's surveyed coordinate.
function solveNote(dual: DualSolve): string {
  const r = dual.raw;
  const c = dual.corrected;
  const corr = c.corrections;
  const anyCorr = corr.ionosphere || corr.troposphere;
  if (!anyCorr) {
    return (
      `RAW broadcast SPP — no atmosphere model — lands <b>${fmtLen(r.distanceToTruthM)}</b> from ABMF's ` +
      `surveyed coordinate; the uncorrected ionosphere is the dominant error. ` +
      `Engage IONO + TROPO to re-solve and watch the real fix tighten.`
    );
  }
  const which =
    corr.ionosphere && corr.troposphere
      ? "ionosphere (Klobuchar) + troposphere (Saastamoinen)"
      : corr.ionosphere
        ? "ionosphere (Klobuchar)"
        : "troposphere (Saastamoinen)";
  const vert = dual.deltaHeightM;
  return (
    `Modeling the L1 ${which} path delay shifts the real fix <b>${dual.deltaM.toFixed(2)} m</b> ` +
    `(vertical ${vert >= 0 ? "+" : "−"}${Math.abs(vert).toFixed(2)} m), pulling it from ` +
    `<b>${fmtLen(r.distanceToTruthM)}</b> to <b>${fmtLen(c.distanceToTruthM)}</b> of ABMF's surveyed truth.`
  );
}

function updateNetPill() {
  const n = netCallsSinceLoad();
  for (const id of [
    "net-pill",
    "hero-net-pill",
    "live-net-pill",
    "coverage-net-pill",
    "conj-net-pill",
    "iod-net-pill",
  ]) {
    const pill = document.getElementById(id);
    if (!pill) continue;
    pill.textContent = `NET ${n}`;
    pill.classList.toggle("warn", n !== 0);
  }
}

// ---- hero live readout -----------------------------------------------------
// The right-hand stage proves the engine is executing now: a real SPP fix of one
// recorded multi-GNSS epoch from IGS station ABMF (Guadeloupe), re-solved on an
// interval, with its compute time, server count, satellites used, and how far
// the fix lands from ABMF's surveyed coordinate. Same WASM core as the deeper
// live section below.
function updateHeroReadout(fix: SppResult) {
  const el = document.getElementById("hero-readout");
  if (!el) return;
  const g = fix.geodetic;
  const hemiLat = g.latDeg >= 0 ? "N" : "S";
  const hemiLon = g.lonDeg >= 0 ? "E" : "W";
  const ms = fix.computeMs.toFixed(1);
  el.innerHTML =
    `<div class="hr-label">LIVE SPP SOLVE · IGS STATION ABMF (GUADELOUPE) · IN-BROWSER</div>` +
    `<div class="hr-pos">` +
    `<span class="hr-coord">${Math.abs(g.latDeg).toFixed(6)}° ${hemiLat}</span>` +
    `<span class="hr-coord">${Math.abs(g.lonDeg).toFixed(6)}° ${hemiLon}</span>` +
    `</div>` +
    `<div class="hr-truth">fix vs surveyed truth · <b>${fmtLen(fix.distanceToTruthM)}</b></div>` +
    `<div class="hr-stats">` +
    `<span><i>compute</i><b>${ms} ms</b></span>` +
    `<span><i>servers</i><b>0</b></span>` +
    `<span><i>sats used</i><b>${fix.usedCount}</b></span>` +
    `<span><i>pseudoranges</i><b>${fix.obsCount}</b></span>` +
    `</div>` +
    `<div class="hr-sats">solving real recorded ${sppData?.provenance.constellations ?? ""} pseudoranges</div>` +
    `<div class="hr-hint">drag to orbit · click the globe to drop an observer</div>`;
}

// Keep the hero readout visibly alive: re-run the real corrected solve on an
// interval so the compute time ticks. Cheap and never touches the network. It
// stays independent of the SOLVE panel's controls, so the panel's chosen config
// (held in lastDual for the overlay) is not clobbered by this loop.
function startHeroSolveLoop() {
  let timer = 0;
  const tick = () => {
    if (document.hidden) return;
    if (!sppData) return;
    try {
      const fix = solveSpp(sppData, { ionosphere: true, troposphere: true });
      updateHeroReadout(fix);
      updateNetPill();
    } catch {
      /* keep the last good readout */
    }
  };
  const start = () => {
    if (timer || document.hidden) return;
    timer = window.setInterval(tick, 2300);
  };
  const stop = () => {
    if (!timer) return;
    window.clearInterval(timer);
    timer = 0;
  };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stop();
    } else {
      tick();
      start();
    }
  });
  start();
}

// ---- IONEX TEC -------------------------------------------------------------
let tecSeq = 0;
async function toggleTec(on: boolean) {
  const seq = ++tecSeq;
  try {
    if (!on) {
      if (tecField) globe.setTec(tecField, false);
      refreshSlant();
      return;
    }
    if (!tecField) {
      $("tec-stats").textContent = "sampling global VTEC…";
      const field = await loadTecField();
      if (seq !== tecSeq) return;
      tecField = field;
      drawTecMap(tecField, $("tec-map") as HTMLCanvasElement, $("tec-scale"));
    }
    if (seq !== tecSeq) return;
    globe.setTec(tecField, true);
    const ep = new Date((tecField.epochJ2000S + 946728000) * 1000);
    $("tec-stats").innerHTML = `<span>${tecField.min.toFixed(1)}–${tecField.max.toFixed(1)} TECU</span><span>${ep.toISOString().slice(0, 16).replace("T", " ")}Z</span>`;
    refreshSlant();
    updateNetPill();
  } catch (e) {
    showError("IONEX load failed", e);
    $("tec-stats").textContent = "IONEX load failed";
    ($("tec-toggle") as HTMLInputElement).checked = false;
  }
}

function drawTecMap(field: TecField, canvas: HTMLCanvasElement, scaleEl: HTMLElement) {
  const W = field.lon.length;
  const H = field.lat.length;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(W, H);
  const span = field.max - field.min || 1;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const v = field.vtec[j][i];
      const idx = (j * W + i) * 4;
      if (!Number.isFinite(v)) {
        img.data[idx + 3] = 0;
        continue;
      }
      const [r, g, b] = turbo((v - field.min) / span);
      img.data[idx] = r;
      img.data[idx + 1] = g;
      img.data[idx + 2] = b;
      img.data[idx + 3] = 235;
    }
  }
  ctx.putImageData(img, 0, 0);
  const stops: string[] = [];
  for (let i = 0; i <= 10; i++) stops.push(`${turboCss(i / 10)} ${i * 10}%`);
  scaleEl.style.background = `linear-gradient(90deg, ${stops.join(",")})`;
}

function refreshSlant() {
  const out = $("slant-out");
  const toggle = ($("tec-toggle") as HTMLInputElement).checked;
  if (!toggle || !tecField || !observer) {
    out.innerHTML = "";
    return;
  }
  const top = visible[0];
  if (!top) {
    out.innerHTML = '<div class="muted">no satellite above horizon</div>';
    return;
  }
  try {
    const d = slantDelayM(tecField, observer.lat, observer.lon, top.az, top.el);
    out.innerHTML = [
      ["PIERCE", `${observer.lat.toFixed(1)}°, ${observer.lon.toFixed(1)}°`],
      ["TARGET", `${top.prn} · el ${top.el.toFixed(1)}°`],
      ["SLANT IONO DELAY", `${d.toFixed(3)} m @ L1`],
    ]
      .map(
        ([k, v]) =>
          `<div class="so-row"><span class="k">${k}</span><span class="v ${k.includes("DELAY") ? "hi" : ""}">${v}</span></div>`,
      )
      .join("");
  } catch {
    out.innerHTML = '<div class="muted">observer outside IONEX coverage</div>';
  }
}

// ===========================================================================
// ASTRODYNAMICS LAB: terminator overlay, coverage map, conjunction, IOD
// ===========================================================================

// ---- day-night terminator --------------------------------------------------
// Refresh the globe's sub-solar marker + terminator ring from the engine's
// analytic Sun ephemeris at `now`, and update the panel's lat/lon readout.
function updateTerminator(now: Date): void {
  const ss = subSolarLL(now);
  globe.setSubSolar(ss.lat, ss.lon, true);
  const ns = ss.lat >= 0 ? "N" : "S";
  const ew = ss.lon >= 0 ? "E" : "W";
  const r = document.getElementById("term-readout");
  if (r) r.textContent = `sub-solar ${Math.abs(ss.lat).toFixed(1)}°${ns} ${Math.abs(ss.lon).toFixed(1)}°${ew}`;
}

function toggleTerminator(on: boolean): void {
  terminatorOn = on;
  if (on) {
    updateTerminator(new Date());
  } else {
    globe.setSubSolar(0, 0, false);
    const r = document.getElementById("term-readout");
    if (r) r.textContent = "sub-solar point off";
  }
}

// ---- shared: satellite <select> options ------------------------------------
// Build <option>s for every loaded satellite, value = index into `sats`.
function satOptions(selectedIdx: number): string {
  return sats
    .map(
      (s, i) =>
        `<option value="${i}"${i === selectedIdx ? " selected" : ""}>${s.prn} · ${s.constellation}</option>`,
    )
    .join("");
}

function buildLabControls(): void {
  const a = document.getElementById("conj-a") as HTMLSelectElement | null;
  const iod = document.getElementById("iod-sat") as HTMLSelectElement | null;
  if (a) a.innerHTML = satOptions(0);
  if (iod) iod.innerHTML = satOptions(0);
}

// ---- coverage heat map -----------------------------------------------------
let coverageBusy = false;
async function runCoverage(): Promise<void> {
  if (coverageBusy) return;
  coverageBusy = true;
  const btn = $("coverage-btn") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "COMPUTING…";
  $("coverage-stats").textContent = "rasterizing global look angles…";
  try {
    const mask = Number(($("coverage-mask") as HTMLInputElement).value) || 0;
    const t0 = performance.now();
    // 2 deg latitude x 2 deg longitude raster (one batched propagation, then
    // per-cell elevation arithmetic), fine enough to read the coverage banding.
    const res = await observeApi.coverage(nowMicros(new Date()), mask, 2, 2);
    const ms = performance.now() - t0;
    drawCoverageMap(res, $("coverage-map") as HTMLCanvasElement, $("coverage-scale"));
    $("coverage-stats").innerHTML =
      `<span>${res.satCount} satellites · ≥${res.minElevationDeg}° · ${res.maxCount} max in view</span>` +
      `<span>${res.meanCount.toFixed(1)} avg · ${ms.toFixed(0)} ms</span>`;
    updateNetPill();
  } catch (e) {
    showError("coverage compute failed", e);
    $("coverage-stats").textContent = "coverage compute failed";
  } finally {
    btn.disabled = false;
    btn.textContent = "COMPUTE COVERAGE";
    coverageBusy = false;
  }
}

function drawCoverageMap(res: CoverageResult, canvas: HTMLCanvasElement, scaleEl: HTMLElement): void {
  const W = res.width;
  const H = res.height;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(W, H);
  const span = res.maxCount || 1;
  for (let lat = 0; lat < H; lat++) {
    // counts are lat-ascending (south first); draw north-up by flipping the row.
    const y = H - 1 - lat;
    for (let lon = 0; lon < W; lon++) {
      const v = res.counts[lat * W + lon];
      const [r, g, b] = turbo(v / span);
      const idx = (y * W + lon) * 4;
      img.data[idx] = r;
      img.data[idx + 1] = g;
      img.data[idx + 2] = b;
      img.data[idx + 3] = 235;
    }
  }
  ctx.putImageData(img, 0, 0);
  const stops: string[] = [];
  for (let i = 0; i <= 10; i++) stops.push(`${turboCss(i / 10)} ${i * 10}%`);
  scaleEl.style.background = `linear-gradient(90deg, ${stops.join(",")})`;
}

// ---- conjunction / TCA catalog screen --------------------------------------
// One primary is screened against the entire loaded constellation in a single
// batched `screenTcaCandidates` call (the engine propagates the primary and
// every secondary across the window at once), then the nearest approaches are
// listed. Screening the whole fleet per click is the batch-API path, not a
// per-pair loop.
const CONJ_THRESHOLD_KM = 5000; // report local minima closer than this
const CONJ_TOP_N = 6;
let conjBusy = false;
async function runConjunction(): Promise<void> {
  if (conjBusy) return;
  const ai = Number(($("conj-a") as HTMLSelectElement).value);
  const primary = sats[ai];
  const out = $("conj-out");
  if (!primary) return;
  conjBusy = true;
  const btn = $("conj-btn") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "SCREENING…";
  out.classList.remove("is-hit");
  out.innerHTML = '<div class="muted">propagating the primary against the whole fleet…</div>';
  try {
    // Every other satellite is a secondary; keep a parallel label array so each
    // returned secondaryIndex maps straight back to its PRN.
    const secondaries: { line1: string; line2: string }[] = [];
    const secLabels: Sat[] = [];
    sats.forEach((s, i) => {
      if (i === ai) return;
      const [line1, line2] = s.tle.toLines();
      secondaries.push({ line1, line2 });
      secLabels.push(s);
    });
    const [pl1, pl2] = primary.tle.toLines();
    const hours = Number(($("conj-window") as HTMLSelectElement).value) || 24;
    const start = nowMicros(new Date());
    const end = start + BigInt(Math.round(hours * 3600)) * 1_000_000n;
    const t0 = performance.now();
    const res = await observeApi.screenConjunctions(
      pl1,
      pl2,
      secondaries,
      start,
      end,
      CONJ_THRESHOLD_KM,
      60,
      CONJ_TOP_N,
    );
    const ms = performance.now() - t0;
    if (res.hits.length === 0) {
      out.innerHTML = `<div class="muted">no approach within ${CONJ_THRESHOLD_KM} km of ${primary.prn} across ${secondaries.length} satellites in this window</div>`;
      updateNetPill();
      return;
    }
    const nearest = res.hits[0];
    const missLabel =
      nearest.missKm < 1 ? `${(nearest.missKm * 1000).toFixed(1)} m` : `${nearest.missKm.toFixed(0)} km`;
    const rows = res.hits
      .map((h: ConjunctionHit) => {
        const s = secLabels[h.secondaryIndex];
        const prn = s ? s.prn : `#${h.secondaryIndex}`;
        const t = new Date(h.tcaIso).toISOString().slice(5, 16).replace("T", " ");
        return (
          `<div class="so-row"><span class="k">${primary.prn} ↔ ${prn}</span>` +
          `<span class="v">${h.missKm.toFixed(0)} km · ${t}Z</span></div>`
        );
      })
      .join("");
    out.classList.add("is-hit");
    out.innerHTML =
      `<div class="lab-headline">${missLabel}</div>` +
      `<div class="so-row"><span class="k">CLOSEST ${primary.prn} ↔ ${secLabels[nearest.secondaryIndex]?.prn ?? ""}</span>` +
      `<span class="v hi">${nearest.relSpeedKmS.toFixed(2)} km/s</span></div>` +
      `<div class="subhead">${res.screened} SATELLITES SCREENED · ${res.totalHits} APPROACHES &lt; ${CONJ_THRESHOLD_KM} KM · ${ms.toFixed(0)} ms</div>` +
      rows;
    updateNetPill();
  } catch (e) {
    showError("conjunction screen failed", e);
    out.innerHTML = '<div class="muted">conjunction screen failed: see console</div>';
  } finally {
    btn.disabled = false;
    btn.textContent = "SCREEN CONSTELLATION";
    conjBusy = false;
  }
}

// ---- initial orbit determination -------------------------------------------
function fmtElementsRows(rec: OrbitRecovery): string {
  const fmt = (v: number, dp: number) => (Number.isFinite(v) ? v.toFixed(dp) : "—");
  const rows: [string, (e: OrbitElements) => string][] = [
    ["a (km)", (e) => fmt(e.aKm, 1)],
    ["e", (e) => fmt(e.ecc, 5)],
    ["i (°)", (e) => fmt(e.inclDeg, 3)],
    ["RAAN (°)", (e) => fmt(e.raanDeg, 3)],
    ["argp (°)", (e) => fmt(e.argpDeg, 3)],
    ["ν (°)", (e) => fmt(e.nuDeg, 3)],
  ];
  return rows
    .map(
      ([k, f]) =>
        `<tr><td>${k}</td><td class="coe-recovered">${f(rec.recovered)}</td><td class="coe-val">${f(rec.truth)}</td></tr>`,
    )
    .join("");
}

function runIod(): void {
  const idx = Number(($("iod-sat") as HTMLSelectElement).value);
  const s = sats[idx];
  const out = $("iod-out");
  if (!s) return;
  const btn = $("iod-btn") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "RECOVERING…";
  requestAnimationFrame(() => {
    try {
      const step = Number(($("iod-step") as HTMLInputElement).value) || 10;
      const rec = recoverOrbit(s.tle, step);
      out.classList.add("is-hit");
      out.innerHTML =
        `<div class="so-row"><span class="k">${s.prn} · ${s.constellation}</span>` +
        `<span class="v">3 positions · ${rec.stepMin} min apart</span></div>` +
        `<table class="coe-table"><thead><tr><th>ELEMENT</th><th>RECOVERED</th><th>TRUE</th></tr></thead>` +
        `<tbody>${fmtElementsRows(rec)}</tbody></table>` +
        [
          ["VELOCITY ERROR", `${rec.velErrorMs.toFixed(3)} m/s`],
          ["COPLANARITY", `${rec.coplanarityDeg.toFixed(4)}°`],
        ]
          .map(([k, v]) => `<div class="so-row"><span class="k">${k}</span><span class="v hi">${v}</span></div>`)
          .join("");
    } catch (e) {
      showError("orbit recovery failed", e);
      out.innerHTML = '<div class="muted">orbit recovery failed: see console</div>';
    } finally {
      btn.disabled = false;
      btn.textContent = "RECOVER ORBIT";
    }
  });
}

// ===========================================================================
// MARKETING SECTIONS: hero install switcher, language interfaces, grids, footer
// ===========================================================================

let heroLang: LangId = "rust";
function buildHeroSwitcher() {
  const tabs = $("hero-lang-tabs");
  tabs.innerHTML = LANGUAGES.map(
    (l) => `<button class="lang-pill${l.id === heroLang ? " active" : ""}" data-lang="${l.id}" role="tab">${l.name}</button>`,
  ).join("");
  tabs.querySelectorAll<HTMLButtonElement>(".lang-pill").forEach((b) => {
    b.addEventListener("click", () => setHeroLang(b.dataset.lang as LangId));
  });
  setHeroLang(heroLang);
}
function setHeroLang(id: LangId) {
  heroLang = id;
  const l = LANGUAGES.find((x) => x.id === id)!;
  $("hero-install-cmd").textContent = l.install;
  $("hero-install-from").textContent = l.installNote;
  $("hero-lang-tabs")
    .querySelectorAll<HTMLButtonElement>(".lang-pill")
    .forEach((b) => b.classList.toggle("active", b.dataset.lang === id));
}

let ifLang: LangId = "rust";
let ifCap: CapId = "propagate";
function buildInterfaces() {
  const langTabs = $("if-lang-tabs");
  langTabs.innerHTML = LANGUAGES.map(
    (l) => `<button class="lang-pill${l.id === ifLang ? " active" : ""}" data-lang="${l.id}" role="tab"><span class="lp-name">${l.name}</span><span class="lp-tag">.${l.tag}</span></button>`,
  ).join("");
  langTabs.querySelectorAll<HTMLButtonElement>(".lang-pill").forEach((b) => {
    b.addEventListener("click", () => {
      ifLang = b.dataset.lang as LangId;
      renderInterfaces();
    });
  });

  const capTabs = $("if-cap-tabs");
  capTabs.innerHTML = CAPABILITIES.map(
    (c) => `<button class="cap-pill${c.id === ifCap ? " active" : ""}" data-cap="${c.id}" role="tab">${c.label}</button>`,
  ).join("");
  capTabs.querySelectorAll<HTMLButtonElement>(".cap-pill").forEach((b) => {
    b.addEventListener("click", () => {
      ifCap = b.dataset.cap as CapId;
      renderInterfaces();
    });
  });

  const copyBtn = document.getElementById("if-copy");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      const l = LANGUAGES.find((x) => x.id === ifLang)!;
      try {
        await navigator.clipboard.writeText(stripFold(l.caps[ifCap]));
        copyBtn.textContent = "Copied ✓";
      } catch {
        copyBtn.textContent = "Copy failed";
      }
      setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
    });
  }

  renderInterfaces();
}
// Render a snippet to highlighted HTML. If it carries a foldable data literal
// (the SP3 ephemeris), the bulky block is highlighted and tucked into a
// default-collapsed <details>, leaving the surrounding code fully visible.
function codeHtml(code: string, lang: LangId): string {
  const parts = splitFold(code);
  if (!parts) return highlight(code, lang);
  const lineCount = parts.data.split("\n").length;
  return (
    highlight(parts.head, lang) +
    '<details class="code-fold">' +
    `<summary class="code-fold-summary">show SP3 data (${lineCount} lines)</summary>` +
    `<span class="code-fold-body">${highlight(parts.data, lang)}\n</span>` +
    "</details>" +
    highlight(parts.tail, lang)
  );
}
function renderInterfaces() {
  const l = LANGUAGES.find((x) => x.id === ifLang)!;
  const cap = CAPABILITIES.find((c) => c.id === ifCap)!;
  $("if-code").innerHTML = codeHtml(l.caps[ifCap], ifLang);
  $("if-filename").textContent = l.filename;
  $("if-cap-blurb").textContent = cap.blurb;
  $("if-install").textContent = l.install;
  const reg = $("if-registry") as HTMLAnchorElement;
  reg.href = l.registry;
  reg.textContent = l.registryLabel + " ↗";
  $("if-lang-tabs")
    .querySelectorAll<HTMLButtonElement>(".lang-pill")
    .forEach((b) => b.classList.toggle("active", b.dataset.lang === ifLang));
  $("if-cap-tabs")
    .querySelectorAll<HTMLButtonElement>(".cap-pill")
    .forEach((b) => b.classList.toggle("active", b.dataset.cap === ifCap));
}

const CAP_CARDS: [string, string][] = [
  ["SPP", "Single-point positioning from pseudoranges, with broadcast ionosphere and troposphere corrections and robust outlier handling."],
  ["RTK", "Carrier-phase real-time kinematic baselines (float and integer-fixed ambiguities), including moving-baseline between two moving platforms."],
  ["PPP", "Precise point positioning with a full correction stack: tides, phase wind-up, and satellite antenna offsets."],
  ["DGNSS", "Differential positioning from a reference station's pseudorange corrections."],
  ["INTEGRITY", "RAIM and fault detection-and-exclusion with chi-square testing across the measurement set."],
  ["SGP4", "Two-line element propagation in the TEME frame, batched and parallelized across epochs to sweep a whole constellation fast."],
  ["IOD", "Initial orbit determination from three position or angle-only observations (Gibbs, Herrick-Gibbs, Gauss)."],
  ["ELEMENTS", "State-vector to classical orbital-element conversion, plus reduced-orbit fitting and evaluation."],
  ["FRAMES + TIME", "TEME, GCRS, and ITRS transforms with IAU time scales and Earth orientation; geoid undulation and orthometric heights."],
  ["ATMOSPHERE", "Troposphere (Saastamoinen with Niell/VMF mapping) and ionosphere (Klobuchar, IONEX maps, and Galileo NeQuick-G) path delays."],
  ["RINEX", "Observation, navigation, and clock files parsed across RINEX 3 and 4."],
  ["RTCM", "Real-time RTCM 3.x correction streams: MSM observations, station coordinates, and broadcast ephemeris, decoded and re-encoded."],
  ["SPK", "JPL/NAIF SPK (.bsp) ephemeris kernels with precise state interpolation for planets and spacecraft."],
  ["CONJUNCTION", "Close-approach screening with collision probability, plus reading and writing CCSDS messages: CDM, OMM, OEM, and OPM."],
  ["ANTEX", "Antenna phase-center offsets and variation patterns from ANTEX."],
  ["DOP", "Geometric dilution of precision from receiver-satellite line-of-sight geometry."],
  ["PASSES", "Acquisition and loss-of-signal pass prediction with azimuth, elevation, and range, from TLEs or precise SP3 orbits."],
  ["ECLIPSE + EVENTS", "Umbra and penumbra crossings with shadow fraction, rise/set and event search, the day-night terminator, and sub-observer geometry."],
  ["RF LINK", "Link-budget analysis and Doppler for the satellite-to-ground path."],
];
function buildCapabilities() {
  $("cap-grid").innerHTML = CAP_CARDS.map(
    ([t, d]) => `<div class="cap-card"><h3>${t}</h3><p>${d}</p></div>`,
  ).join("");
}

const VALID_CARDS: [string, string][] = [
  ["SGP4", "Propagation matched against the Vallado and CelesTrak verification vectors."],
  ["FRAMES & TIME", "TEME / GCRS / ITRS transforms checked against Skyfield and the IAU conventions."],
  ["POSITIONING", "Solved against real IGS precise products and a committed parity trace to sub-micron agreement."],
  ["EARTH ORIENTATION", "IERS Earth-orientation parameters applied for a faithful ITRS realization."],
];
function buildValidation() {
  $("valid-grid").innerHTML = VALID_CARDS.map(
    ([t, d]) => `<div class="valid-card"><h3>${t}</h3><p>${d}</p></div>`,
  ).join("");
}

function buildFooterInstall() {
  $("foot-install").innerHTML = LANGUAGES.map(
    (l) =>
      `<a class="install" href="${l.registry}" target="_blank" rel="noopener"><span class="ip">${l.name}</span>${l.install}</a>`,
  ).join("");
}

// ===========================================================================
// FULLSCREEN OVERLAY: progressive depth per live panel
// ===========================================================================
let overlayPanel: string | null = null;

// Several inline panels carry live, already-wired controls: the solve
// correction set + elevation mask + run button, the day/night terminator
// toggle, and the TEC layer toggle. When a panel is maximized we MOVE those
// real DOM nodes into the overlay instead of cloning them, so every event
// handler and the shared solve/mask state stay attached and the expanded view
// has full parity with the inline panel (no duplicate ids, no re-wiring, no
// drift). An anchor comment marks each node's home so it returns to the exact
// spot when the overlay closes.
const relocations: { node: HTMLElement; anchor: Comment }[] = [];
function relocate(node: HTMLElement | null, dest: HTMLElement): void {
  if (!node) return;
  const anchor = document.createComment("relocated-control");
  node.parentNode?.insertBefore(anchor, node);
  dest.appendChild(node);
  relocations.push({ node, anchor });
}
function restoreRelocations(): void {
  for (const { node, anchor } of relocations.splice(0)) {
    anchor.parentNode?.replaceChild(node, anchor);
  }
}

function openOverlay(panel: string) {
  overlayPanel = panel;
  const ov = $("overlay");
  ov.hidden = false;
  document.body.classList.add("overlay-open");
  if (panel === "globe") document.body.classList.add("globe-focus");
  const titles: Record<string, string> = {
    solve: "SOLVE · RAW VS ACTIVE CONFIG · DOP · RESIDUALS",
    sky: "OBSERVER SKYPLOT · PER-SATELLITE AZ / EL / RANGE",
    globe: "LIVE CONSTELLATION · VALIDATED FRAME PIPELINE",
    tec: "IONEX · GLOBAL VERTICAL TEC · SLANT DELAY",
  };
  $("overlay-title").textContent = titles[panel] || "PANEL";
  if (panel === "solve") renderSolveOverlay();
  else if (panel === "sky") renderSkyOverlay();
  else if (panel === "globe") renderGlobeOverlay();
  else if (panel === "tec") renderTecOverlay();
  updateSkyLoopState();
}

function closeOverlay() {
  overlayPanel = null;
  $("overlay").hidden = true;
  document.body.classList.remove("overlay-open", "globe-focus");
  if (ovSky) {
    ovSky.dispose();
    ovSky = null;
  }
  // Return any live controls we moved into the overlay to their inline homes
  // BEFORE wiping the overlay body, or innerHTML = "" would destroy them.
  restoreRelocations();
  $("overlay-body").innerHTML = "";
  updateSkyLoopState();
}

// Shell builder, run once when the solve panel is maximized: lay out a controls
// slot + a results slot, then MOVE the live, already-wired solve controls
// (correction set, elevation mask, run button) into the overlay so the expanded
// view can reconfigure and re-run the real WASM fix exactly like the inline
// panel. The detailed tables refresh separately via refreshSolveOverlay so a
// re-solve never rebuilds (and so never interrupts a mask-slider drag) the
// relocated controls.
function renderSolveOverlay() {
  const body = $("overlay-body");
  body.innerHTML = `
    <div class="ov-sub">CONFIGURE THE SOLVE · each change re-runs the real WASM fix</div>
    <div class="ov-solve-controls" id="ov-solve-controls"></div>
    <div id="ov-solve-results"></div>`;
  const slot = $("ov-solve-controls");
  relocate(document.querySelector<HTMLElement>("#solve-panel .solve-controls"), slot);
  relocate(document.getElementById("solve-btn"), slot);
  refreshSolveOverlay();
}

function refreshSolveOverlay() {
  const body = document.getElementById("ov-solve-results");
  if (!body) return;
  if (!lastDual || !sppData) {
    body.innerHTML = '<div class="muted">no solve yet</div>';
    return;
  }
  const r = lastDual.raw;
  const c = lastDual.corrected;
  const p = sppData.provenance;
  const epoch = p.epochUtc.replace("T", " ").replace(".000Z", "Z");

  const cmp: [string, string, string][] = [
    ["VS SURVEYED TRUTH", fmtLen(r.distanceToTruthM), fmtLen(c.distanceToTruthM)],
    ["SATS USED", `${r.usedSats.length}`, `${c.usedSats.length}`],
    ["LAT", `${r.geodetic.latDeg.toFixed(6)}°`, `${c.geodetic.latDeg.toFixed(6)}°`],
    ["LON", `${r.geodetic.lonDeg.toFixed(6)}°`, `${c.geodetic.lonDeg.toFixed(6)}°`],
    ["HEIGHT", `${r.geodetic.heightM.toFixed(2)} m`, `${c.geodetic.heightM.toFixed(2)} m`],
    ["RX CLOCK", `${(r.rxClockS * 1e3).toFixed(5)} ms`, `${(c.rxClockS * 1e3).toFixed(5)} ms`],
    ["RESID RMS", fmtLen(r.residualRmsM), fmtLen(c.residualRmsM)],
    ["COMPUTE", `${r.computeMs.toFixed(3)} ms`, `${c.computeMs.toFixed(3)} ms`],
  ];

  const cfg = activeLabelFor(c);
  // Dilution of precision straight from each solve's converged geometry. "·"
  // only if the geometry was rank-deficient (no Dop returned).
  const fmtDop = (v: number | undefined) => (v === undefined ? "·" : v.toFixed(2));
  const dopRows: [string, string, string][] = [
    ["PDOP", fmtDop(r.dop?.pdop), fmtDop(c.dop?.pdop)],
    ["HDOP", fmtDop(r.dop?.hdop), fmtDop(c.dop?.hdop)],
    ["VDOP", fmtDop(r.dop?.vdop), fmtDop(c.dop?.vdop)],
    ["TDOP", fmtDop(r.dop?.tdop), fmtDop(c.dop?.tdop)],
    ["GDOP", fmtDop(r.dop?.gdop), fmtDop(c.dop?.gdop)],
  ];
  // Residuals are index-aligned to each solve's own usedSats, and the correction
  // set can change which satellites survive, so look each satellite up by PRN.
  const rawRes = new Map(r.usedSats.map((s, i) => [s, r.residualsM[i]]));
  const actRes = new Map(c.usedSats.map((s, i) => [s, c.residualsM[i]]));
  const cell = (v: number | undefined) => (v === undefined ? "·" : fmtLen(v));
  const allSats = Array.from(new Set([...r.usedSats, ...c.usedSats])).sort();
  const resid = allSats
    .map(
      (s) =>
        `<tr><td>${s}</td><td>${cell(rawRes.get(s))}</td><td>${cell(actRes.get(s))}</td></tr>`,
    )
    .join("");

  const deltaNote =
    lastDual.corrected.corrections.ionosphere || lastDual.corrected.corrections.troposphere
      ? `Δ <b>${lastDual.deltaM.toFixed(2)} m</b> position shift = modeled L1 ionosphere (Klobuchar) and/or troposphere (Saastamoinen) path delay. `
      : `No corrections engaged, so the fix is the raw broadcast SPP. `;

  body.innerHTML = `
    <div class="hero-headline solve-headline">
      <span class="big">${c.usedSats.length} SATELLITES <span class="arrow">→</span> ${fmtLen(c.distanceToTruthM)} FROM TRUTH</span>
      <span class="sub">${cfg} · SOLVE ${c.computeMs.toFixed(1)} ms · SERVER COMPUTE 0 · NETWORK CALLS AFTER LOAD ${netCallsSinceLoad()}</span>
    </div>
    <div class="trace">
      <span class="tr-node">RINEX OBS + BROADCAST NAV</span><span class="tr-arrow">→</span><span class="tr-node engine">solveBroadcast() · Rust→WASM</span><span class="tr-arrow">→</span><span class="tr-node">ECEF → LLH</span>
    </div>
    <div class="ov-cols">
      <div class="ov-col">
        <div class="ov-sub">RAW VS ${cfg} · same ${p.obsCount}-observation epoch</div>
        <table class="ov-table">
          <thead><tr><th></th><th>RAW</th><th class="amber">${cfg}</th></tr></thead>
          <tbody>${cmp.map(([k, a, b]) => `<tr><td>${k}</td><td>${a}</td><td>${b}</td></tr>`).join("")}</tbody>
        </table>
        <div class="ov-note">${deltaNote}The ${cfg} fix lands <b>${fmtLen(c.distanceToTruthM)}</b> from ABMF's surveyed coordinate.</div>
      </div>
      <div class="ov-col">
        <div class="ov-sub">DILUTION OF PRECISION</div>
        <table class="ov-table">
          <thead><tr><th></th><th>RAW</th><th class="amber">${cfg}</th></tr></thead>
          <tbody>${dopRows.map(([k, a, b]) => `<tr><td>${k}</td><td>${a}</td><td>${b}</td></tr>`).join("")}</tbody>
        </table>
        <div class="ov-sub">POST-FIT RESIDUALS</div>
        <table class="ov-table"><thead><tr><th>SAT</th><th>RAW</th><th>ACTIVE</th></tr></thead><tbody>${resid}</tbody></table>
      </div>
    </div>
    <div class="ov-prov">inputs: real IGS station ${p.station} (Guadeloupe) RINEX obs (${p.obsFile}) + broadcast nav (${p.navFile}) · reception epoch ${epoch} · station ${p.stationLatDeg.toFixed(3)}°, ${p.stationLonDeg.toFixed(3)}° · ${p.constellations} · ${c.usedSats.length}/${p.obsCount} satellites used (active)</div>
  `;
}

function renderSkyOverlay() {
  $("overlay-body").innerHTML = `
    <div class="ov-cols ov-sky">
      <div class="ov-col"><canvas id="ov-skyplot" class="skyplot"></canvas></div>
      <div class="ov-col">
        <div class="obs-coords" id="ov-obs-coords"></div>
        <div class="obs-stats" id="ov-obs-stats"></div>
        <div class="ov-sub">VISIBLE SATELLITES · topocentric look angles</div>
        <div class="ov-scroll"><table class="ov-table" id="ov-sky-table"></table></div>
        <div class="subhead">NEXT PASSES · 6H</div>
        <div class="pass-list" id="ov-pass-list"></div>
        <div class="ov-prov">SGP4 propagation to current UTC, then topocentric azimuth / elevation / range from the observer. Elevation mask ${maskDeg}°.</div>
      </div>
    </div>`;
  renderSkyOverlayTable();
  const top = visible.find((v) => v.el >= maskDeg)?.prn;
  const pts: SkyPoint[] = visible.map((v) => ({
    prn: v.prn,
    az: v.az,
    el: v.el,
    constellation: v.constellation,
    highlight: v.prn === top,
  }));
  ovSky = new Skyplot($("ov-skyplot") as HTMLCanvasElement, maskDeg);
  ovSky.setArcs(skyArcs);
  ovSky.setPoints(pts);
  updateSkyLoopState();
}

function renderSkyOverlayTable() {
  const tbl = document.getElementById("ov-sky-table");
  if (!tbl) return;
  const rows = visible
    .map(
      (v) =>
        `<tr><td style="color:${CONSTELLATION[v.constellation].css}">${v.prn}</td><td>${v.az.toFixed(2)}°</td><td>${v.el.toFixed(2)}°</td><td>${v.rangeKm.toFixed(1)} km</td></tr>`,
    )
    .join("");
  tbl.innerHTML = `<thead><tr><th>SAT</th><th>AZ</th><th>EL</th><th>RANGE</th></tr></thead><tbody>${rows}</tbody>`;
  // Mirror the inline observer readouts (coords incl. geocoded place, the
  // horizon/mask + per-constellation counts, and the upcoming passes) into the
  // fullscreen overlay so it carries everything the inline panel shows, plus the
  // full per-satellite table above.
  const mirror = (from: string, to: string) => {
    const f = document.getElementById(from);
    const t = document.getElementById(to);
    if (f && t) t.innerHTML = f.innerHTML;
  };
  mirror("obs-coords", "ov-obs-coords");
  mirror("obs-stats", "ov-obs-stats");
  mirror("pass-list", "ov-pass-list");
}

function renderGlobeOverlay() {
  // The featured globe is the page backdrop; in focus mode it is full-bleed and
  // interactive behind this near-transparent readout.
  const counts: Record<string, number> = {};
  for (const s of sats) counts[s.constellation] = (counts[s.constellation] || 0) + 1;
  const legend = (Object.keys(CONSTELLATION) as Constellation[])
    .map(
      (c) =>
        `<div class="legend-row"><span class="sw" style="background:${CONSTELLATION[c].css};box-shadow:0 0 8px ${CONSTELLATION[c].css}"></span><span class="nm">${CONSTELLATION[c].full}</span><span class="ct">${counts[c] || 0}</span></div>`,
    )
    .join("");
  $("overlay-body").innerHTML = `
    <div class="ov-globe">
      <div class="ov-readout">
        <div class="ov-sub">TRACKED · ${sats.length} OBJECTS</div>
        ${legend}
        <div id="ov-globe-controls"></div>
        <div class="ov-prov">Real CelesTrak element sets propagated by the engine's SGP4. Orbits are drawn in the inertial TEME scene; ground tracks pass through the validated TEME → GCRS → ITRS frame pipeline. Drag to orbit, zoom with the + and − controls, click to set an observer.</div>
      </div>
    </div>`;
  // Bring the live day/night terminator toggle into the focused globe view so
  // the expanded panel keeps the control the inline legend panel has.
  relocate(document.querySelector<HTMLElement>("#legend-panel .term-ctl"), $("ov-globe-controls"));
}

function renderTecOverlay() {
  $("overlay-body").innerHTML = `
    <div class="ov-tec">
      <canvas id="ov-tec-map" class="tec-map"></canvas>
      <div class="tec-scale" id="ov-tec-scale"></div>
      <div class="tec-stats" id="ov-tec-stats"></div>
      <div class="ov-toggle-row" id="ov-tec-controls"><span class="term-label">VERTICAL TEC LAYER ON GLOBE</span></div>
      <div class="ov-prov">Measured global vertical-TEC field from the IONEX product, rendered in-browser via <code>Ionex.slantDelay</code>. Standalone exhibit: the SPP corrected branch uses the broadcast Klobuchar model and does not consume this field.</div>
      <div class="slant-out" id="ov-slant-out"></div>
    </div>`;
  // Carry the live TEC-layer toggle into the overlay so the expanded panel keeps
  // the control the inline panel head has (drives the globe's VTEC overlay).
  relocate(document.querySelector<HTMLElement>("#tec-panel .panel-head label.toggle"), $("ov-tec-controls"));
  if (!tecField) {
    $("ov-tec-stats").textContent = "IONEX not loaded";
    return;
  }
  drawTecMap(tecField, $("ov-tec-map") as HTMLCanvasElement, $("ov-tec-scale"));
  const ep = new Date((tecField.epochJ2000S + 946728000) * 1000);
  $("ov-tec-stats").innerHTML = `<span>${tecField.min.toFixed(1)}–${tecField.max.toFixed(1)} TECU</span><span>${ep.toISOString().slice(0, 16).replace("T", " ")}Z</span>`;
  if (observer && visible[0]) {
    try {
      const top = visible[0];
      const d = slantDelayM(tecField, observer.lat, observer.lon, top.az, top.el);
      $("ov-slant-out").innerHTML = [
        ["PIERCE", `${observer.lat.toFixed(1)}°, ${observer.lon.toFixed(1)}°`],
        ["TARGET", `${top.prn} · el ${top.el.toFixed(1)}°`],
        ["SLANT IONO DELAY", `${d.toFixed(3)} m @ L1`],
      ]
        .map(([k, v]) => `<div class="so-row"><span class="k">${k}</span><span class="v ${k.includes("DELAY") ? "hi" : ""}">${v}</span></div>`)
        .join("");
    } catch {
      /* outside coverage */
    }
  }
}

// ---- shared globe placement: hero (right) and live (left) -------------------
// The globe is one shared fixed scene. While the hero is in view we frame it into
// the RIGHT stage box; while the live section is in view we frame it into the
// LEFT pane of the paired observer block. Each frame the globe is mapped (via the
// camera view offset) so it sits CENTERED in the active stage rect and fills it,
// matching how the skyplot fills its box. Both stages are interactive so they
// read as real instruments, not a backdrop. On narrow viewports the layout
// stacks, so we clear the offset and the globe is centered on the full canvas.
//
// The fill factors say how much of the stage box the globe fills relative to how
// it fills the full canvas (1 = same fraction). The live box is squarer and is
// the section's centerpiece, so it gets a stronger fill than the hero stage.
const HERO_FILL = 1.0;
const LIVE_FILL = 1.32;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpRect(a: DOMRect, b: DOMRect, t: number): DOMRect {
  return new DOMRect(
    lerp(a.left, b.left, t),
    lerp(a.top, b.top, t),
    lerp(a.width, b.width, t),
    lerp(a.height, b.height, t),
  );
}
// How docked the globe should be for a given STAGE rect: 1 when the stage box's
// center sits at the viewport's vertical center (with a plateau so it stays fully
// docked while the box is comfortably in view), easing to 0 as it scrolls away.
// Driven by the stage box itself, NOT the whole section: the live section is much
// taller than the viewport (paired block + the panels below), so keying off the
// section center left the globe undocked (stuck near full-canvas center = the
// right edge of the left pane, over the skyplot) exactly when the stage was
// centered in view — which also made the globe unclickable there.
function rectCenterProgress(r: DOMRect): number {
  const vh = window.innerHeight;
  const center = r.top + r.height / 2;
  const d = Math.abs(center - vh / 2);
  const plateau = vh * 0.18;
  const falloff = vh * 0.6;
  return clamp01(1 - Math.max(0, d - plateau) / falloff);
}

let heroFrameEl: HTMLElement | null = null;
let liveFrameEl: HTMLElement | null = null;
let heroSectionEl: HTMLElement | null = null;
let liveSectionEl: HTMLElement | null = null;
let skyplotEl: HTMLElement | null = null;
let liveReadoutEl: HTMLElement | null = null;
let lastLiveReadoutTop = Number.NaN;
let lastGlobeFrameKey = "";

function cachedEl(selector: string, current: HTMLElement | null): HTMLElement | null {
  return current ?? document.querySelector<HTMLElement>(selector);
}

function frameKey(rect: DOMRect | null, fill: number): string {
  if (!rect) return `full:${fill.toFixed(3)}`;
  const q = (v: number) => (Math.round(v * 2) / 2).toFixed(1);
  return `${q(rect.left)}:${q(rect.top)}:${q(rect.width)}:${q(rect.height)}:${fill.toFixed(3)}`;
}

function applyGlobeFrame(rect: DOMRect | null, fill = 1): void {
  const key = frameKey(rect, fill);
  if (key === lastGlobeFrameKey) return;
  lastGlobeFrameKey = key;
  globe.frameIntoRect(rect, fill);
}

// The ONE globe is a single fixed scene that stays visible the whole way down.
// It is framed into the hero's RIGHT stage while the hero is centered, eases back
// to the full-canvas CENTER through the middle marketing sections, then GLIDES
// into the LEFT pane of the skymap (live) block as that section comes up - so the
// same globe visibly travels into the frame instead of snapping or vanishing. Run
// every frame from the render loop so it tracks scroll + resize. A full-viewport
// rect maps to the centered, no-offset view, so we lerp between that and whichever
// stage is nearest. On narrow viewports the layout stacks and we just center it.
// Tuck the LEFT pane's OBSERVER readout just under the docked globe instead of
// pinning it to the bottom of the frame (which left a big dead gap below the
// sphere). `globeCenterY` is the docked globe's center in viewport px and
// `frameRect` is the live stage frame; we drop the block a small gap below the
// sphere's bottom edge, clamped inside the frame.
function positionLiveReadout(globeCenterY: number, frameRect: DOMRect): void {
  liveReadoutEl = cachedEl(".live-stage .stage-readout", liveReadoutEl);
  const readout = liveReadoutEl;
  if (!readout || !globe) return;
  const radiusPx = globe.globeRadiusForRect(frameRect, LIVE_FILL);
  const rh = readout.offsetHeight || 88;
  let top = globeCenterY - frameRect.top + radiusPx + 14;
  top = Math.min(top, frameRect.height - rh - 12);
  top = Math.max(top, 12);
  if (Math.abs(top - lastLiveReadoutTop) > 0.5) {
    lastLiveReadoutTop = top;
    readout.style.top = `${top}px`;
  }
}
let lastFramingScrollY = 0;
function applyGlobeFraming() {
  if (!globe) return;
  // While the page is scrolling, unwind any manual +/- zoom back to the default
  // framing distance, so a zoom done in one section doesn't dock "huge" in the next.
  const sy = window.scrollY;
  if (Math.abs(sy - lastFramingScrollY) > 0.5) globe.easeZoomToDefault(0.12);
  lastFramingScrollY = sy;
  if (window.innerWidth <= 900) {
    // Mobile/stacked: there is no side-by-side hero<->live travel. Keep the globe
    // as a backdrop behind the hero, but dock it INTO the live stage box when the
    // live section scrolls into view so the interactive demo actually renders in
    // its panel (instead of floating in screen-center over the skyplot/text).
    liveFrameEl = cachedEl(".live-stage-frame", liveFrameEl);
    const liveFrame = liveFrameEl;
    if (liveFrame) {
      const r = liveFrame.getBoundingClientRect();
      const lp = rectCenterProgress(r);
      if (lp > 0.01) {
        const e = lp * lp * (3 - 2 * lp);
        const centered = new DOMRect(0, 0, window.innerWidth, window.innerHeight);
        applyGlobeFrame(lerpRect(centered, r, e), lerp(1, LIVE_FILL, e));
        // stacked layout: globe docks centered in the frame, so its center is the frame center
        positionLiveReadout(r.top + r.height / 2, r);
        return;
      }
    }
    applyGlobeFrame(null);
    return;
  }
  heroFrameEl = cachedEl(".hero-stage-frame", heroFrameEl);
  liveFrameEl = cachedEl(".live-stage-frame", liveFrameEl);
  heroSectionEl = cachedEl("#hero", heroSectionEl);
  liveSectionEl = cachedEl("#live", liveSectionEl);
  const heroFrame = heroFrameEl;
  const liveFrame = liveFrameEl;
  const heroSec = heroSectionEl;
  const liveSec = liveSectionEl;
  if (!heroFrame || !liveFrame || !heroSec || !liveSec) {
    applyGlobeFrame(null);
    return;
  }
  const centered = new DOMRect(0, 0, window.innerWidth, window.innerHeight);
  const heroRect = heroFrame.getBoundingClientRect();
  const liveRect = liveFrame.getBoundingClientRect();
  // Align the docked globe with the skyplot circle so the two read as a matched
  // left/right pair. The live stage frame is full column height, so its center
  // sits ~140px below the skyplot; reuse the frame's horizontal center + size but
  // recenter vertically on the skyplot canvas. Horizontal already mirrors it.
  let liveTarget = liveRect;
  skyplotEl = cachedEl("#skyplot", skyplotEl);
  const skyEl = skyplotEl;
  if (skyEl) {
    const s = skyEl.getBoundingClientRect();
    const skyCy = s.top + s.height / 2;
    liveTarget = new DOMRect(liveRect.left, skyCy - liveRect.height / 2, liveRect.width, liveRect.height);
  }
  // Tuck the OBSERVER readout under the docked sphere. Driven by the intended
  // docked rect (liveTarget), not the eased frame, so it stays put as the page scrolls.
  positionLiveReadout(liveTarget.top + liveTarget.height / 2, liveRect);
  const hp = rectCenterProgress(heroRect);
  const lp = rectCenterProgress(liveTarget);
  // Hero and live stages are far apart on the page, so at most one is near center;
  // the larger progress wins and blends from the centered backdrop into its stage.
  if (lp >= hp) {
    const e = lp * lp * (3 - 2 * lp); // smoothstep ease
    applyGlobeFrame(lerpRect(centered, liveTarget, e), lerp(1, LIVE_FILL, e));
  } else {
    const e = hp * hp * (3 - 2 * hp);
    applyGlobeFrame(lerpRect(centered, heroRect, e), lerp(1, HERO_FILL, e));
  }
}
// The IO observers below only toggle the per-section body classes (which drive
// ancillary CSS: hero copy, zoom controls, hints); the globe rect itself is
// blended every frame by applyGlobeFraming().
function setHeroGlobe(active: boolean) {
  document.body.classList.toggle("globe-hero", active);
  markGlobeFramingDirty();
}
function setLiveGlobe(active: boolean) {
  document.body.classList.toggle("globe-live", active);
  markGlobeFramingDirty();
}

// ---- scroll reveal + globe interaction gating ------------------------------
function setupObservers() {
  // Smooth-scroll for in-page anchor clicks only (nav, scroll-cue, hero CTAs).
  // The global CSS `scroll-behavior: smooth` was removed because Chrome also
  // applies it to trackpad/wheel scrolling, making the page feel like it resists.
  document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((a) => {
    a.addEventListener("click", (e) => {
      const id = a.getAttribute("href");
      if (!id || id === "#") return;
      const t = document.querySelector(id);
      if (!t) return;
      e.preventDefault();
      t.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) e.target.classList.add("in");
    },
    { threshold: 0.12 },
  );
  document.querySelectorAll(".section, .footer").forEach((s) => io.observe(s));

  // Hero in view: globe lives in the right stage and is interactive.
  const heroIo = new IntersectionObserver(
    (entries) => {
      for (const e of entries) setHeroGlobe(e.isIntersecting);
    },
    { threshold: 0.4 },
  );
  const heroStage = document.querySelector(".hero-stage-frame");
  if (heroStage) heroIo.observe(heroStage);

  // Make the globe interactive while the live STAGE BOX is in view. Observe the
  // stage frame, NOT the whole #live section: that section is far taller than the
  // viewport, so on short windows its intersection ratio can never reach the
  // threshold and the globe would never become clickable/orbitable. The stage box
  // is viewport-comparable, so the threshold is always reachable.
  const liveStage = document.querySelector(".live-stage-frame");
  const liveIo = new IntersectionObserver(
    (entries) => {
      for (const e of entries) setLiveGlobe(e.isIntersecting);
    },
    { threshold: 0.3 },
  );
  if (liveStage) liveIo.observe(liveStage);

  const skyCanvas = document.querySelector("#skyplot");
  const skyIo = new IntersectionObserver(
    (entries) => {
      skyPanelVisible = entries.some((e) => e.isIntersecting);
      updateSkyLoopState();
    },
    { threshold: 0.01, rootMargin: "120px 0px" },
  );
  if (skyCanvas) skyIo.observe(skyCanvas);

  window.addEventListener("scroll", markGlobeFramingDirty, { passive: true });
  window.addEventListener("orientationchange", markGlobeFramingDirty, { passive: true });
  window.visualViewport?.addEventListener("resize", markGlobeFramingDirty, { passive: true });
  window.visualViewport?.addEventListener("scroll", markGlobeFramingDirty, { passive: true });

  // Re-frame on resize so the globe re-anchors when the split collapses/reopens
  // (also handled every frame by the render loop, but this keeps it instant).
  window.addEventListener(
    "resize",
    () => {
      markGlobeFramingDirty();
      applyGlobeFraming();
    },
    { passive: true },
  );
}

// ---- wiring ----------------------------------------------------------------
function wire() {
  $("solve-btn").addEventListener("click", runSolve);

  // CORRECTION segmented control: pick the atmosphere model set, then re-solve.
  document.querySelectorAll<HTMLButtonElement>("#solve-corr .seg-btn").forEach((b) => {
    b.addEventListener("click", () => {
      solveCorrKey = (b.dataset.corr as CorrKey) ?? "none";
      document
        .querySelectorAll<HTMLButtonElement>("#solve-corr .seg-btn")
        .forEach((o) => o.classList.toggle("is-on", o === b));
      runSolve();
    });
  });

  // ELEVATION MASK slider: drives the skyplot (mask ring + "ABOVE MASK" count)
  // and the SPP solve (drops below-mask satellites from the active fix). The
  // value label updates as you drag; the solve re-runs on release-grade input.
  const maskSlider = $("solve-mask") as HTMLInputElement;
  const maskVal = $("mask-val");
  maskDeg = Number(maskSlider.value) || DEFAULT_MASK;
  maskVal.textContent = `${maskDeg}°`;
  maskSlider.addEventListener("input", () => {
    maskDeg = Number(maskSlider.value);
    maskVal.textContent = `${maskDeg}°`;
    // Skyplot: move the amber mask ring now, and recompute the above-mask count
    // from the cached visible set (no re-propagation).
    skyPanel?.setMask(maskDeg);
    ovSky?.setMask(maskDeg);
    if (visible.length) renderVisible(visible);
    // Solve: re-run the real WASM fix at the new mask (mirrors the CORRECTION path).
    runSolve();
  });

  $("gz-in").addEventListener("click", () => globe?.dolly(0.82));
  $("gz-out").addEventListener("click", () => globe?.dolly(1.22));
  $("gz-reset").addEventListener("click", () => globe?.resetView());
  ($("tec-toggle") as HTMLInputElement).addEventListener("change", (e) =>
    toggleTec((e.target as HTMLInputElement).checked),
  );

  document.querySelectorAll<HTMLButtonElement>(".maximize").forEach((b) => {
    b.addEventListener("click", () => openOverlay(b.dataset.panel!));
  });
  $("overlay-close").addEventListener("click", closeOverlay);
  $("overlay").addEventListener("click", (e) => {
    if (e.target === $("overlay")) closeOverlay();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlayPanel) closeOverlay();
  });

  const cross = $("crosshair");
  const host = $("globe-host");
  // The crosshair (and the hidden cursor) is the globe-aiming indicator. It must
  // appear ONLY when the pointer is over a globe stage, not across the whole
  // page (the globe is a full-bleed fixed scene, so listening on it directly lit
  // the crosshair everywhere and hid the cursor over real UI). Gate on the stage
  // rectangles instead.
  const inAnyStage = (x: number, y: number): boolean => {
    const stages = document.querySelectorAll<HTMLElement>(".hero-stage-frame, .live-stage-frame");
    for (const s of stages) {
      const r = s.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
    }
    return false;
  };
  host.addEventListener("pointermove", (e) => {
    cross.style.left = e.clientX + "px";
    cross.style.top = e.clientY + "px";
    document.body.classList.toggle("over-globe", inAnyStage(e.clientX, e.clientY));
  });
  host.addEventListener("pointerleave", () => document.body.classList.remove("over-globe"));

  // Day-night terminator toggle (constellation panel).
  const termToggle = document.getElementById("term-toggle") as HTMLInputElement | null;
  termToggle?.addEventListener("change", (e) => toggleTerminator((e.target as HTMLInputElement).checked));

  // Coverage heat map.
  $("coverage-btn").addEventListener("click", () => void runCoverage());
  const covMask = $("coverage-mask") as HTMLInputElement;
  const covMaskVal = $("coverage-mask-val");
  covMask.addEventListener("input", () => {
    covMaskVal.textContent = `${covMask.value}°`;
  });

  // Conjunction screen.
  $("conj-btn").addEventListener("click", () => void runConjunction());

  // Initial orbit determination.
  $("iod-btn").addEventListener("click", runIod);
  const iodStep = $("iod-step") as HTMLInputElement;
  const iodStepVal = $("iod-step-val");
  iodStep.addEventListener("input", () => {
    iodStepVal.textContent = `${iodStep.value} min`;
  });

  buildHeroSwitcher();
  buildInterfaces();
  buildCapabilities();
  buildValidation();
  buildFooterInstall();
  setupObservers();
}

window.addEventListener("DOMContentLoaded", () => {
  wire();
  boot()
    .then(() => {
      globe.onPick = (lat, lon) => setObserver(lat, lon, true);
      (window as any).__SIDEREON_READY = true;
    })
    .catch((e) => {
      showError("boot failed", e);
      $("boot").classList.add("done");
    });
});
