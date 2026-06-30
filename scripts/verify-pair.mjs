// Verify the paired Live observer block: globe (left) + skyplot (right).
// Asserts, against a real preview build:
//   (a) screenshots the paired block at 1600 and 760
//   (b) zero console errors
//   (c) NET pill reads 0 after load (zero network)
//   (d) REGRESSION: wheel over the globe scrolls the PAGE (never zooms)
//   (e) #globe-zoom is visible while #live is in view
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE || "http://localhost:4173";
const OUT = "screenshots";
mkdirSync(OUT, { recursive: true });

const fail = [];
const errors = [];
const browser = await chromium.launch();

async function ready(page) {
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForFunction(() => window.__SIDEREON_READY === true, { timeout: 30000 });
  await page.waitForTimeout(1800); // let skyplot arcs + sweep frames render
}

// ---- desktop 1600: paired block, NET, zoom visibility, scroll regression ----
// reducedMotion disables the page's smooth scroll-behavior so scroll math is
// deterministic (not racing an in-flight smooth-scroll animation).
const wide = await browser.newPage({ viewport: { width: 1600, height: 1000 }, reducedMotion: "reduce" });
wide.on("console", (m) => m.type() === "error" && errors.push("[1600] " + m.text()));
wide.on("pageerror", (e) => errors.push("[1600] pageerror: " + e.message));
await ready(wide);

// bring the paired block to the middle of the viewport so the globe (panned
// left, fixed scene) lines up behind the left pane.
await wide.locator("#observer-pair").scrollIntoViewIfNeeded();
await wide.evaluate(() => {
  const el = document.getElementById("observer-pair");
  const r = el.getBoundingClientRect();
  window.scrollBy(0, r.top - (window.innerHeight - r.height) / 2);
});
await wide.waitForTimeout(1200);

// (e) globe zoom control visible while live is in view
const zoomVisible = await wide.locator("#globe-zoom").isVisible();
if (!zoomVisible) fail.push("#globe-zoom is NOT visible while #live is in view");
const liveClass = await wide.evaluate(() => document.body.classList.contains("globe-live"));
if (!liveClass) fail.push("body.globe-live is NOT set while observer-pair is centered");

// (a) screenshot the paired block at 1600
await wide.locator("#observer-pair").screenshot({ path: `${OUT}/pair-live-1600.png` });
await wide.screenshot({ path: `${OUT}/pair-live-1600-full.png` });
console.log("shot pair-live-1600");

// (c) NET pills read 0
const netLive = (await wide.locator("#live-net-pill").textContent())?.trim();
const netSolve = (await wide.locator("#net-pill").textContent())?.trim();
if (netLive !== "NET 0") fail.push(`live-net-pill = ${JSON.stringify(netLive)} (expected "NET 0")`);
if (netSolve !== "NET 0") fail.push(`net-pill = ${JSON.stringify(netSolve)} (expected "NET 0")`);

// fullscreen-expand affordance on the skyplot still works
await wide.locator('.maximize[data-panel="sky"]').click();
await wide.waitForTimeout(900);
const overlayOpen = await wide.locator("#overlay").isVisible();
if (!overlayOpen) fail.push("skyplot maximize did not open the overlay");
await wide.screenshot({ path: `${OUT}/pair-skyplot-fullscreen.png` });
await wide.keyboard.press("Escape");
await wide.waitForTimeout(400);

// (d) REGRESSION: wheel over the globe scrolls the page, never zooms.
// In the hero (top, plenty of room below), over the interactive globe stage,
// wheel DOWN must scroll the page down.
await wide.evaluate(() => window.scrollTo(0, 0));
await wide.waitForTimeout(400); // back in the hero; globe interactive there too
const before = await wide.evaluate(() => window.scrollY);
const stage = await wide.locator(".hero-stage-frame").boundingBox();
await wide.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
await wide.mouse.wheel(0, 800);
await wide.waitForTimeout(500);
const after = await wide.evaluate(() => window.scrollY);
if (!(after > before)) fail.push(`wheel over hero globe did not scroll page: scrollY ${before} -> ${after}`);
console.log(`hero-stage scroll regression: scrollY ${before} -> ${after}`);

// Same over the LEFT pane in the live section (the new paired globe stage). The
// block is deep in the page, so wheel UP must scroll the page up.
await wide.locator("#observer-pair").scrollIntoViewIfNeeded();
await wide.waitForTimeout(400);
const before2 = await wide.evaluate(() => window.scrollY);
const lstage = await wide.locator("#live-stage .live-stage-frame").boundingBox();
await wide.mouse.move(lstage.x + lstage.width / 2, lstage.y + lstage.height / 2);
await wide.mouse.wheel(0, -400);
await wide.waitForTimeout(500);
const after2 = await wide.evaluate(() => window.scrollY);
if (!(after2 < before2)) fail.push(`wheel over live globe stage did not scroll page: scrollY ${before2} -> ${after2}`);
console.log(`live-stage scroll regression: scrollY ${before2} -> ${after2}`);

// ---- narrow 760: paired block stacks ----
const narrow = await browser.newPage({ viewport: { width: 760, height: 1000 } });
narrow.on("console", (m) => m.type() === "error" && errors.push("[760] " + m.text()));
narrow.on("pageerror", (e) => errors.push("[760] pageerror: " + e.message));
await ready(narrow);
await narrow.locator("#observer-pair").scrollIntoViewIfNeeded();
await narrow.waitForTimeout(900);
await narrow.locator("#observer-pair").screenshot({ path: `${OUT}/pair-live-760.png` });
console.log("shot pair-live-760");

await browser.close();

if (errors.length) fail.push(`${errors.length} console error(s)`);

console.log("\n=== NET (live / solve):", JSON.stringify(netLive), "/", JSON.stringify(netSolve));
console.log("=== #globe-zoom visible in live:", zoomVisible);
console.log("=== console errors:", errors.length);
for (const e of errors) console.log("   !", e);
console.log("=== FAILURES:", fail.length);
for (const f of fail) console.log("   ✗", f);
process.exit(fail.length ? 1 : 0);
